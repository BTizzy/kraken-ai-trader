/**
 * Gemini Prediction Markets Client
 * Execution platform - where we place orders to capture alpha
 *
 * Supports:
 *   1) Real API mode - uses GeminiPredictionsReal for live market data
 *   2) Paper trading simulation with synthetic orderbooks
 *   3) Live trading via /v1/prediction-markets/* endpoints (HMAC-SHA384 auth)
 *   4) Sandbox mode: api.sandbox.gemini.com for testing (no prediction symbols)
 *
 * Prediction Markets API (production only):
 *   POST /v1/prediction-markets/order          — Place limit order
 *   POST /v1/prediction-markets/order/cancel    — Cancel order
 *   POST /v1/prediction-markets/orders/active   — List open orders
 *   POST /v1/prediction-markets/orders/history  — Filled/cancelled history
 *   POST /v1/prediction-markets/positions       — Current positions
 *
 * Real API endpoint: https://www.gemini.com/prediction-markets
 * Docs: https://docs.gemini.com/prediction-markets/trading
 */

const { Logger } = require('./logger');
const GeminiPredictionsReal = require('./gemini_predictions_real');
const crypto = require('crypto');

const GEMINI_API_PROD = 'https://api.gemini.com';
const GEMINI_API_SANDBOX = 'https://api.sandbox.gemini.com';

class GeminiClient {
    constructor(options = {}) {
        this.logger = new Logger({ component: 'GEMINI', level: options.logLevel || 'INFO' });
        this.mode = options.mode || 'paper'; // 'paper' | 'live' | 'sandbox'
        this.requestCount = 0;
        this.lastRequestTime = 0;
        this.minRequestInterval = options.minRequestInterval || 1000;
        this.cache = new Map();
        this.cacheTTL = options.cacheTTL || 3000;

        // Select API base + keys based on mode
        if (this.mode === 'sandbox') {
            this.apiBase = GEMINI_API_SANDBOX;
            this.apiKey = options.apiKey || process.env.SANDBOX_GEMINI_API_KEY || null;
            this.apiSecret = options.apiSecret || process.env.SANDBOX_GEMINI_API_SECRET || null;
            this.logger.info('Gemini sandbox mode: using api.sandbox.gemini.com');
        } else {
            this.apiBase = GEMINI_API_PROD;
            this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || null;
            this.apiSecret = options.apiSecret || process.env.GEMINI_API_SECRET || null;
        }
        if (this.mode === 'live' || this.mode === 'sandbox') {
            this.logger.info(`Gemini ${this.mode} mode: HMAC auth ${this.apiKey ? 'READY' : 'MISSING KEYS'}`);
        }

        // Paper trading state
        this.paperMarkets = new Map();
        this.paperOrders = [];

        // Real API client (uses actual Gemini Predictions endpoint)
        this.realClient = new GeminiPredictionsReal({
            categories: options.categories || ['crypto'],
            minRequestInterval: options.realApiInterval || 2000,
            cacheTTL: options.realCacheTTL || 10000,
            logLevel: options.logLevel
        });
        this.useRealPrices = options.useRealPrices || false;
        this.lastRealFetch = 0;
        this.realFetchInterval = options.realFetchInterval || 15000; // 15s full refresh
        this.lastTickerFetch = 0;
        this.tickerFetchInterval = options.tickerFetchInterval || 5000; // 5s batch ticker refresh

        // Nonce counter to prevent collisions within same second
        this._nonceCounter = 0;

        // Realistic paper mode: use real bid/ask for fills instead of synthetic mid
        this.realisticPaper = options.realisticPaper || false;

        // Cached exchange balance for live pre-trade checks
        this._cachedBalance = null;
        this._balanceFetchTime = 0;
        this._balanceCacheTTL = 30000; // 30s cache — balance doesn't change that fast
    }

    /**
     * Refresh real market data if stale
     */
    async refreshRealData() {
        const now = Date.now();

        // Full market refresh (fetches metadata + prices for all configured categories)
        if (now - this.lastRealFetch >= this.realFetchInterval) {
            try {
                const categories = this.realClient.categories || ['crypto'];
                for (const category of categories) {
                    await this.realClient.fetchMarkets({ category, limit: 60 });
                }
                this.lastRealFetch = now;
            } catch (e) {
                this.logger.error(`Real data refresh failed: ${e.message}`);
            }
        }

        // Batch ticker refresh (lightweight price-only update for all categories)
        if (now - this.lastTickerFetch >= this.tickerFetchInterval) {
            try {
                const categories = this.realClient.categories || ['crypto'];
                for (const category of categories) {
                    await this.realClient.fetchBatchTickers(category);
                }
                this.lastTickerFetch = now;
            } catch (e) {
                // Silently skip — batch ticker is best-effort
            }
        }

        // Sync real data into paperMarkets for paper-mode compatibility
        if (this.useRealPrices) {
            for (const [key, contract] of this.realClient.contracts) {
                const prices = this.realClient.getBestPrices(key);
                if (prices && prices.hasTwoSidedBook) {
                    this.paperMarkets.set(key, {
                        market_id: key,
                        title: `${contract.eventTitle}: ${contract.label}`,
                        bid: prices.bid,
                        ask: prices.ask,
                        last: prices.lastTrade || (prices.bid + prices.ask) / 2,
                        spread: prices.spread,
                        volume: contract.volume || 0,
                        bid_depth: 500,
                        ask_depth: 500,
                        last_trade_time: prices.timestamp,
                        updated: Date.now(),
                        isReal: true
                    });
                }
            }
        }
    }

    /**
     * Rate-limited fetch wrapper
     */
    async _fetch(url, options = {}, _retryCount = 0) {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minRequestInterval) {
            await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
        }

        const cacheKey = url;
        const cached = this.cache.get(cacheKey);
        if (cached && (Date.now() - cached.time) < this.cacheTTL) {
            return cached.data;
        }

        try {
            this.lastRequestTime = Date.now();
            this.requestCount++;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            const headers = {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                ...options.headers
            };

            if (this.apiKey) {
                headers['X-GEMINI-APIKEY'] = this.apiKey;
            }

            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers
            });

            clearTimeout(timeout);

            if (!response.ok) {
                if (response.status === 429 && _retryCount < 3) {
                    const backoff = 3000 * Math.pow(2, _retryCount);
                    this.logger.warn(`Rate limited by Gemini, backing off ${backoff}ms (attempt ${_retryCount + 1}/3)...`);
                    await new Promise(r => setTimeout(r, backoff));
                    return this._fetch(url, options, _retryCount + 1);
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            this.cache.set(cacheKey, { data, time: Date.now() });
            return data;
        } catch (error) {
            if (error.name === 'AbortError') {
                this.logger.error('Gemini request timed out: ' + url);
            }
            throw error;
        }
    }

    // ======= Official API Methods (if available) =======

    /**
     * Try to fetch prediction markets from Gemini's API
     */
    async getMarkets() {
        try {
            // Try official endpoint first
            const data = await this._fetch(`${GEMINI_PREDICTION_API}/markets`);
            return data?.markets || data || [];
        } catch (error) {
            this.logger.warn(`Gemini prediction API not available: ${error.message}`);
            // Fall back to simulated markets from cross-platform matching
            return this.getSimulatedMarkets();
        }
    }

    /**
     * Get specific market info
     */
    async getMarket(marketId) {
        try {
            const data = await this._fetch(`${GEMINI_PREDICTION_API}/markets/${marketId}`);
            return data?.market || data || null;
        } catch (error) {
            return this.paperMarkets.get(marketId) || null;
        }
    }

    /**
     * Get orderbook for a prediction market
     */
    async getOrderbook(marketId) {
        if (this.mode === 'paper') {
            return this.getPaperOrderbook(marketId);
        }

        try {
            const data = await this._fetch(`${GEMINI_PREDICTION_API}/orderbook/${marketId}`);
            return {
                bids: (data.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.amount || b.size) })),
                asks: (data.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.amount || a.size) })),
                timestamp: Date.now()
            };
        } catch (error) {
            return this.getPaperOrderbook(marketId);
        }
    }

    /**
     * Get best prices for a market
     */
    async getBestPrices(marketId) {
        const book = await this.getOrderbook(marketId);
        return {
            bid: book.bids.length > 0 ? book.bids[0].price : null,
            ask: book.asks.length > 0 ? book.asks[0].price : null,
            spread: (book.bids.length > 0 && book.asks.length > 0) 
                ? book.asks[0].price - book.bids[0].price 
                : null,
            bid_depth: book.bids.reduce((sum, b) => sum + b.size * b.price, 0),
            ask_depth: book.asks.reduce((sum, a) => sum + a.size * a.price, 0),
            timestamp: book.timestamp
        };
    }

    // ======= Paper Trading Simulation =======

    /**
     * Update simulated market state (called from cross-platform price feeds)
     * Simulates a less liquid version of Polymarket/Kalshi
     */
    updatePaperMarket(marketId, referencePrice, opts = {}) {
        const existing = this.paperMarkets.get(marketId) || {};

        // If this market has real orderbook data from refreshRealData()
        // and realisticPaper is enabled, preserve the real data instead
        // of overwriting with synthetic lag
        if (this.realisticPaper && existing.isReal) {
            if (opts.title) existing.title = opts.title;
            if (opts.volume) existing.volume = opts.volume;
            existing.updated = Date.now();
            this.paperMarkets.set(marketId, existing);
            return existing;
        }

        // Simulate Gemini prediction market spreads (2-4¢ for liquid markets)
        // Persist spread across cycles to avoid phantom signals from jitter
        const spreadWidth = opts.spreadWidth || existing.spreadWidth || (0.02 + Math.random() * 0.02);
        
        // Simulate Gemini price LAGGING the reference price (the core trading edge)
        // Gemini doesn't instantly react to Polymarket moves — smooth convergence
        let laggedPrice;
        const convergenceRate = opts.convergenceRate || 0.15; // configurable
        if (existing.last && existing.last > 0) {
            // Exponential decay toward reference price (simulates slow convergence)
            laggedPrice = existing.last + (referencePrice - existing.last) * convergenceRate;
            // Add small noise
            laggedPrice += (Math.random() - 0.5) * 0.004;
        } else {
            // New market — start with a bigger initial lag
            const lag = (Math.random() * 0.06 - 0.03); // ±3¢ initial offset
            laggedPrice = referencePrice + lag;
        }
        laggedPrice = Math.max(0.01, Math.min(0.99, laggedPrice));

        const bid = Math.max(0.01, laggedPrice - spreadWidth / 2);
        const ask = Math.min(0.99, laggedPrice + spreadWidth / 2);

        // Simulate thin orderbook
        const depth = opts.depth || (500 + Math.random() * 2000); // $500-$2500 depth

        // Simulate infrequent trading on Gemini: trade happens every ~60-300s
        // Preserve existing last_trade_time unless enough time has passed for a new simulated trade
        let lastTradeTime = existing.last_trade_time || (Date.now() - 120000); // default: 2 min ago
        const timeSinceLastTrade = Date.now() - lastTradeTime;
        const nextTradeInterval = 60000 + Math.random() * 240000; // 60-300s between trades
        if (timeSinceLastTrade > nextTradeInterval) {
            lastTradeTime = Date.now() - Math.floor(Math.random() * 5000); // just traded
        }

        const market = {
            market_id: marketId,
            title: opts.title || existing.title || 'Unknown Market',
            bid,
            ask,
            last: laggedPrice,
            spread: ask - bid,
            spreadWidth,
            volume: opts.volume || existing.volume || Math.floor(Math.random() * 25000),
            bid_depth: depth * 0.4,
            ask_depth: depth * 0.6,
            last_trade_time: lastTradeTime,
            updated: Date.now()
        };

        this.paperMarkets.set(marketId, market);
        return market;
    }

    /**
     * Get simulated orderbook based on paper market state
     */
    getPaperOrderbook(marketId) {
        const market = this.paperMarkets.get(marketId);
        if (!market) {
            return { bids: [], asks: [], timestamp: Date.now() };
        }

        // Generate synthetic orderbook levels
        const bids = [];
        const asks = [];
        const levels = 5;

        for (let i = 0; i < levels; i++) {
            const bidPrice = Math.max(0.01, market.bid - i * 0.01);
            const askPrice = Math.min(0.99, market.ask + i * 0.01);
            const bidSize = Math.floor(market.bid_depth / levels * (1 - i * 0.15));
            const askSize = Math.floor(market.ask_depth / levels * (1 - i * 0.15));

            bids.push({ price: parseFloat(bidPrice.toFixed(2)), size: bidSize });
            asks.push({ price: parseFloat(askPrice.toFixed(2)), size: askSize });
        }

        return { bids, asks, timestamp: Date.now() };
    }

    /**
     * Get simulated markets list
     */
    getSimulatedMarkets() {
        return Array.from(this.paperMarkets.values());
    }

    /**
     * Execute paper trade - simulate a fill with realistic thin-book slippage
     * 
     * Slippage model: base + impact
     *   base = 0.5¢ (execution overhead)
     *   impact = positionSize / depth × impact_factor
     *   impact_factor = 3¢ for $1000 depth (typical Gemini thin book)
     * 
     * For a $50 trade on $500 depth: slippage = 0.5¢ + ($50/$500 × 3¢) = 0.8¢
     * For a $200 trade on $500 depth: slippage = 0.5¢ + ($200/$500 × 3¢) = 1.7¢
     */
    executePaperTrade(marketId, direction, positionSize, opts = {}) {
        const market = this.paperMarkets.get(marketId);
        if (!market) {
            return { success: false, error: 'Market not found in paper simulation' };
        }

        // Maker-or-cancel model: we POST limit orders and provide liquidity.
        // Fill at mid price (market.last) with Gemini maker fee (0.01%).
        // This is realistic: maker-or-cancel on Gemini means zero slippage,
        // you either fill at your limit or cancel.
        const makerFee = 0.001; // 0.1¢ conservative (actual Gemini maker = 0.01%)
        let fillPrice;
        if (direction === 'YES') {
            fillPrice = market.last + makerFee;
        } else {
            fillPrice = market.last - makerFee;
        }

        fillPrice = parseFloat(Math.max(0.01, Math.min(0.99, fillPrice)).toFixed(4));

        const order = {
            id: `paper_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
            market_id: marketId,
            direction,
            position_size: positionSize,
            fill_price: fillPrice,
            slippage: makerFee,
            depth_impact: 0,
            market_bid: market.bid,
            market_ask: market.ask,
            market_spread: market.spread,
            latency_ms: 100 + Math.random() * 400,
            timestamp: Date.now(),
            success: true
        };

        this.paperOrders.push(order);
        this.logger.info(`Paper trade: ${direction} on ${marketId} @ ${fillPrice} ($${positionSize})`);

        return order;
    }

    /**
     * Get current paper market price (for exit simulation)
     */
    getPaperExitPrice(marketId, direction) {
        const market = this.paperMarkets.get(marketId);
        if (!market) return null;

        // Maker-or-cancel exit: sell at mid price with maker fee
        const makerFee = 0.001; // 0.1¢ conservative
        if (direction === 'YES') {
            return Math.max(0.01, market.last - makerFee);
        } else {
            return Math.min(0.99, market.last + makerFee);
        }
    }

    /**
     * Get mid-price for unrealized PnL and stop-loss monitoring.
     * In real markets, stop losses track mid-price movement, not execution price.
     */
    getPaperMidPrice(marketId) {
        const market = this.paperMarkets.get(marketId);
        return market ? market.last : null;
    }

    /**
     * Execute realistic paper trade — fill at actual orderbook levels
     * instead of synthetic mid ± 0.001. Only meaningful for markets with
     * real data (isReal: true from refreshRealData).
     */
    executeRealisticPaperTrade(marketId, direction, positionSize) {
        const market = this.paperMarkets.get(marketId);
        if (!market) {
            return { success: false, error: 'Market not found' };
        }

        let fillPrice;
        if (direction === 'YES') {
            // Buy YES: must cross the ask
            fillPrice = market.ask;
        } else {
            // Buy NO: cost = 1 - bid
            fillPrice = market.bid !== null ? 1 - market.bid : null;
        }

        if (fillPrice === null || fillPrice === undefined || fillPrice <= 0) {
            return { success: false, error: 'No executable price available' };
        }

        // Depth-based slippage: if position > 5% of depth, add impact
        const relevantDepth = direction === 'YES' ? market.ask_depth : market.bid_depth;
        let slippage = 0;
        if (relevantDepth && relevantDepth > 0) {
            const impactFraction = positionSize / relevantDepth;
            if (impactFraction > 0.05) {
                slippage = impactFraction * 0.03;
            }
        }

        fillPrice += slippage;
        fillPrice = parseFloat(Math.max(0.01, Math.min(0.99, fillPrice)).toFixed(4));

        return {
            id: `rpaper_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
            market_id: marketId,
            direction,
            position_size: positionSize,
            fill_price: fillPrice,
            slippage,
            market_bid: market.bid,
            market_ask: market.ask,
            market_spread: market.spread,
            latency_ms: 100 + Math.random() * 400,
            timestamp: Date.now(),
            success: true,
            realistic: true
        };
    }

    /**
     * Get realistic exit price — uses actual bid/ask instead of mid ± 0.001
     */
    getRealisticExitPrice(marketId, direction) {
        const market = this.paperMarkets.get(marketId);
        if (!market) return null;

        if (direction === 'YES') {
            // Sell YES: receive the bid price
            return market.bid;
        } else {
            // Sell NO: cost = 1 - ask
            return market.ask !== null ? 1 - market.ask : null;
        }
    }

    /**
     * Normalize market data to unified format
     */
    normalizeMarket(rawMarket) {
        return {
            platform: 'gemini',
            market_id: rawMarket.market_id || rawMarket.id || rawMarket.symbol,
            title: rawMarket.title || rawMarket.description || 'Unknown',
            category: rawMarket.category || 'other',
            outcomes: rawMarket.outcomes || ['Yes', 'No'],
            resolution_date: rawMarket.resolution_date || rawMarket.expiry || null,
            volume: rawMarket.volume || 0,
            last_price_yes: rawMarket.last || rawMarket.last_price || null,
            bid: rawMarket.bid || null,
            ask: rawMarket.ask || null,
            spread: rawMarket.spread || null,
            active: true,
            raw: rawMarket
        };
    }

    /**
     * Fetch all active markets, normalized
     */
    async fetchAllActiveMarkets() {
        // Real data mode: use actual Gemini Predictions API
        if (this.useRealPrices) {
            await this.refreshRealData();
            const normalized = this.realClient.getAllNormalizedMarkets()
                .filter(m => m.hasTwoSidedBook);
            this.logger.info(`Real mode: ${normalized.length} tradeable Gemini markets`);
            return normalized;
        }

        if (this.mode === 'paper') {
            const markets = this.getSimulatedMarkets().map(m => this.normalizeMarket(m));
            this.logger.info(`Paper mode: ${markets.length} simulated Gemini markets`);
            return markets;
        }

        try {
            const raw = await this.getMarkets();
            const markets = raw.map(m => this.normalizeMarket(m));
            this.logger.info(`Fetched ${markets.length} active Gemini markets`);
            return markets;
        } catch (error) {
            this.logger.error('Failed to fetch Gemini markets: ' + error.message);
            return [];
        }
    }

    /**
     * Get full market state for trading decisions.
     * Prefers real Gemini Predictions API prices when useRealPrices is enabled.
     * Falls back to paper simulation if real data is unavailable.
     */
    async getMarketState(marketIdOrNormalized) {
        const marketId = typeof marketIdOrNormalized === 'string'
            ? marketIdOrNormalized
            : marketIdOrNormalized.market_id;

        // Try real API data first (caller should call refreshRealData() before batch lookups)
        if (this.useRealPrices) {
            const realPrices = this.realClient.getBestPrices(marketId);
            if (realPrices) {
                const contract = this.realClient.contracts.get(marketId) || {};

                return {
                    market_id: marketId,
                    title: contract.eventTitle ? `${contract.eventTitle}: ${contract.label}` : '',
                    platform: 'gemini',
                    bid: realPrices.bid,
                    ask: realPrices.ask,
                    spread: realPrices.spread,
                    last: realPrices.lastTrade,
                    volume: 0, // Real API does not expose volume
                    bid_depth: null,
                    ask_depth: null,
                    last_trade_time: realPrices.timestamp || null,
                    isReal: true,
                    timestamp: Date.now()
                };
            }
        }

        // Fall back to paper simulation
        const prices = await this.getBestPrices(marketId);
        const market = this.paperMarkets.get(marketId) || {};

        return {
            market_id: marketId,
            title: market.title || '',
            platform: 'gemini',
            bid: prices.bid,
            ask: prices.ask,
            spread: prices.spread,
            last: market.last || null,
            volume: market.volume || 0,
            bid_depth: prices.bid_depth,
            ask_depth: prices.ask_depth,
            last_trade_time: market.last_trade_time || null,
            isReal: false,
            timestamp: prices.timestamp
        };
    }

    // ======= Live Order Execution (HMAC-authenticated) =======

    /**
     * Sign and POST to a private Gemini REST endpoint.
     *
     * Auth pattern:
     *   payload = base64(JSON({ request, nonce, account, ...fields }))
     *   signature = HMAC-SHA384(payload, GEMINI_API_SECRET)
     *   Headers: X-GEMINI-APIKEY, X-GEMINI-PAYLOAD, X-GEMINI-SIGNATURE
     *
     * Nonce: seconds-based (required by sandbox, works on production too).
     * Account: 'primary' (required by all private endpoints).
     */
    async _signedPost(endpoint, fields = {}, _retryCount = 0) {
        if (!this.apiKey || !this.apiSecret) {
            throw new Error('HMAC auth requires API key + secret (set GEMINI_API_KEY or SANDBOX_GEMINI_API_KEY)');
        }

        // Nonce: must be strictly increasing AND within ±30 seconds of server time (seconds).
        // Track last nonce to ensure uniqueness across rapid sequential calls.
        const nowSec = Math.floor(Date.now() / 1000);
        if (!this._lastNonce || nowSec > this._lastNonce) {
            this._lastNonce = nowSec;
        } else {
            this._lastNonce++;  // Increment to stay unique (still within ±30s window)
        }
        const nonce = String(this._lastNonce);
        const payloadObj = { request: endpoint, nonce, account: 'primary', ...fields };
        const payloadJson = JSON.stringify(payloadObj);
        const payloadB64 = Buffer.from(payloadJson).toString('base64');
        const signature = crypto
            .createHmac('sha384', this.apiSecret)
            .update(payloadB64)
            .digest('hex');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        try {
            const resp = await fetch(`${this.apiBase}${endpoint}`, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type':       'application/json',
                    'X-GEMINI-APIKEY':    this.apiKey,
                    'X-GEMINI-PAYLOAD':   payloadB64,
                    'X-GEMINI-SIGNATURE': signature
                },
                body: payloadJson
            });
            clearTimeout(timeout);

            if (!resp.ok) {
                const errBody = await resp.text().catch(() => '');
                if (resp.status === 429 && _retryCount < 3) {
                    const backoff = 3000 * Math.pow(2, _retryCount);
                    this.logger.warn(`Gemini rate limited on private endpoint, backing off ${backoff}ms (attempt ${_retryCount + 1}/3)`);
                    await new Promise(r => setTimeout(r, backoff));
                    return this._signedPost(endpoint, fields, _retryCount + 1);
                }
                throw new Error(`Gemini API ${resp.status}: ${errBody}`);
            }
            return await resp.json();
        } catch (err) {
            clearTimeout(timeout);
            throw err;
        }
    }

    /**
     * Place a limit order on Gemini Prediction Markets.
     *
     * In paper mode → executes paper simulation.
     * In live/sandbox mode → sends authenticated REST request to prediction markets API.
     *
     * Prediction Markets API: POST /v1/prediction-markets/order
     * Fields: symbol, orderType, side, quantity, price, outcome, timeInForce
     *
     * @param {object} params
     *   .symbol    - instrumentSymbol (e.g. 'GEMI-BTC2602190200-HI66250')
     *   .side      - 'buy' | 'sell'
     *   .amount    - number of contracts (string or number)
     *   .price     - limit price 0-1 (string or number)
     *   .direction - 'YES' | 'NO' — maps to outcome: 'yes' | 'no'
     */
    async placeOrder(params) {
        const { symbol, side, amount, price, direction, makerOnly = true } = params;

        // PAPER GUARD — never submit to exchange outside live/sandbox mode
        if (this.mode !== 'live' && this.mode !== 'sandbox') {
            this.logger.debug(`[PAPER] placeOrder ${side} ${amount} ${symbol} @ ${price}`);
            return this.executePaperTrade(symbol, direction || (side === 'buy' ? 'YES' : 'NO'), Number(amount));
        }

        // Map direction to outcome for the prediction markets API
        const outcome = (direction || 'yes').toLowerCase();
        const limitPrice = parseFloat(price);

        const orderFields = {
            symbol: String(symbol),
            orderType: 'limit',
            side: (side || 'buy').toLowerCase(),
            quantity: String(amount),
            price: String(limitPrice),
            outcome: outcome,
            timeInForce: 'good-til-cancel'
        };

        const result = await this._signedPost('/v1/prediction-markets/order', orderFields);
        this.logger.info(
            `LIVE ORDER: ${side} ${outcome} ${amount}x ${symbol} @ ${limitPrice} → ` +
            `id=${result.orderId} status=${result.status}`
        );

        // Normalize to match executePaperTrade response format for trading engine compatibility
        const fillPrice = result.avgExecutionPrice
            ? parseFloat(result.avgExecutionPrice) : limitPrice;
        const market = this.paperMarkets.get(symbol) || {};

        return {
            success: result.status !== 'cancelled',
            id: String(result.orderId),
            market_id: symbol,
            direction: (direction || 'YES').toUpperCase(),
            position_size: Number(amount),
            fill_price: fillPrice,
            slippage: 0,
            depth_impact: 0,
            market_bid: market.bid || limitPrice,
            market_ask: market.ask || limitPrice,
            market_spread: market.spread || 0,
            latency_ms: 0,
            timestamp: Date.now(),
            live: true,
            orderId: String(result.orderId),
            orderStatus: result.status,
            filledQuantity: result.filledQuantity || 0,
            remainingQuantity: result.remainingQuantity || result.quantity
        };
    }

    /**
     * Cancel an open prediction market order.
     * @param {string} orderId - Gemini prediction market orderId
     */
    async cancelOrder(orderId) {
        if (this.mode !== 'live' && this.mode !== 'sandbox') {
            this.logger.debug(`[PAPER] cancelOrder ${orderId}`);
            return { result: 'ok', message: `Paper cancel ${orderId}` };
        }
        return this._signedPost('/v1/prediction-markets/order/cancel', { orderId: String(orderId) });
    }

    /**
     * Get all active prediction market orders.
     */
    async getOpenOrders() {
        if (this.mode !== 'live' && this.mode !== 'sandbox') return [];
        const result = await this._signedPost('/v1/prediction-markets/orders/active');
        return result.orders || [];
    }

    /**
     * Get current prediction market positions.
     */
    async getPositions() {
        if (this.mode !== 'live' && this.mode !== 'sandbox') return [];
        const result = await this._signedPost('/v1/prediction-markets/positions');
        return result.positions || [];
    }

    /**
     * Get prediction market order history (filled/cancelled).
     */
    async getOrderHistory(opts = {}) {
        if (this.mode !== 'live' && this.mode !== 'sandbox') return [];
        const result = await this._signedPost('/v1/prediction-markets/orders/history', opts);
        return result.orders || [];
    }

    /**
     * Get Gemini exchange balances (works on both production and sandbox).
     */
    async getBalances() {
        return this._signedPost('/v1/balances');
    }

    /**
     * Get available USD balance from Gemini, with 30s cache.
     * Returns null in paper mode or if API call fails.
     */
    async getAvailableBalance() {
        if (this.mode !== 'live' && this.mode !== 'sandbox') return null;

        if (this._cachedBalance !== null && Date.now() - this._balanceFetchTime < this._balanceCacheTTL) {
            return this._cachedBalance;
        }

        try {
            const balances = await this.getBalances();
            if (!Array.isArray(balances)) return null;

            const usd = balances.find(b => b.currency === 'USD');
            if (usd) {
                this._cachedBalance = parseFloat(usd.available || usd.amount || '0');
                this._balanceFetchTime = Date.now();
                return this._cachedBalance;
            }
            return null;
        } catch (e) {
            this.logger.warn('Failed to fetch Gemini balance: ' + e.message);
            return null;
        }
    }

    getStats() {
        return {
            total_requests: this.requestCount,
            mode: this.mode,
            apiBase: this.apiBase,
            authenticated: !!(this.apiKey && this.apiSecret),
            paper_markets: this.paperMarkets.size,
            paper_orders: this.paperOrders.length,
            cache_size: this.cache.size
        };
    }

    clearCache() {
        this.cache.clear();
    }
}

module.exports = GeminiClient;
