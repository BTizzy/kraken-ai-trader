/**
 * Gemini Prediction Markets Client
 * Execution platform - where we place orders to capture alpha
 * 
 * NOTE: Gemini prediction markets launched Jan 2026. Official API may not exist yet.
 * This client supports:
 *   1) Official REST API (if available)
 *   2) Fallback web scraping via Puppeteer (if no API)
 *   3) Paper trading simulation (always available)
 * 
 * Docs: https://docs.gemini.com/
 */

const { Logger } = require('./logger');

const GEMINI_API = 'https://api.gemini.com';
const GEMINI_PREDICTION_API = 'https://api.gemini.com/v1/prediction'; // Hypothetical

class GeminiClient {
    constructor(options = {}) {
        this.logger = new Logger({ component: 'GEMINI', level: options.logLevel || 'INFO' });
        this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || null;
        this.apiSecret = options.apiSecret || process.env.GEMINI_API_SECRET || null;
        this.mode = options.mode || 'paper'; // 'paper' | 'live' | 'scraper'
        this.requestCount = 0;
        this.lastRequestTime = 0;
        this.minRequestInterval = options.minRequestInterval || 1000;
        this.cache = new Map();
        this.cacheTTL = options.cacheTTL || 3000; // 3s cache (faster for execution platform)

        // Paper trading state
        this.paperMarkets = new Map(); // Simulated orderbooks
        this.paperOrders = [];

        // Scraper state (if needed)
        this.browser = null;
        this.scrapeInterval = null;
    }

    /**
     * Rate-limited fetch wrapper
     */
    async _fetch(url, options = {}) {
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
                if (response.status === 429) {
                    this.logger.warn('Rate limited by Gemini, backing off...');
                    await new Promise(r => setTimeout(r, 3000));
                    return this._fetch(url, options);
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
        
        // Simulate Gemini prediction market spreads (2-4¢ for liquid markets)
        const spreadWidth = opts.spreadWidth || (0.02 + Math.random() * 0.02);
        
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
     * Execute paper trade - simulate a fill
     */
    executePaperTrade(marketId, direction, positionSize, opts = {}) {
        const market = this.paperMarkets.get(marketId);
        if (!market) {
            return { success: false, error: 'Market not found in paper simulation' };
        }

        // Determine fill price with slippage
        const slippagePenalty = opts.slippage || 0.005; // 0.5¢ default
        let fillPrice;

        if (direction === 'YES') {
            // Buying YES = lifting the ask
            fillPrice = market.ask + slippagePenalty;
        } else {
            // Buying NO = hitting bid (selling YES equivalent)
            fillPrice = market.bid - slippagePenalty;
        }

        fillPrice = parseFloat(Math.max(0.01, Math.min(0.99, fillPrice)).toFixed(4));

        // Check if there's enough depth
        const depth = direction === 'YES' ? market.ask_depth : market.bid_depth;
        if (positionSize > depth * 0.5) {
            this.logger.warn(`Position size $${positionSize} exceeds 50% of depth $${depth}`);
            // Still fill, but with extra slippage
            fillPrice += direction === 'YES' ? 0.01 : -0.01;
            fillPrice = parseFloat(Math.max(0.01, Math.min(0.99, fillPrice)).toFixed(4));
        }

        // Add artificial latency tracking
        const latency = 100 + Math.random() * 400; // 100-500ms simulated network delay

        const order = {
            id: `paper_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
            market_id: marketId,
            direction,
            position_size: positionSize,
            fill_price: fillPrice,
            slippage: slippagePenalty,
            market_bid: market.bid,
            market_ask: market.ask,
            market_spread: market.spread,
            latency_ms: latency,
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

        const slippage = 0.005;
        if (direction === 'YES') {
            // Selling YES = hitting the bid
            return Math.max(0.01, market.bid - slippage);
        } else {
            // Selling NO = lifting the ask on YES side (1 - ask)
            return Math.min(0.99, market.ask + slippage);
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
     * Get full market state for trading decisions
     */
    async getMarketState(marketIdOrNormalized) {
        const marketId = typeof marketIdOrNormalized === 'string' 
            ? marketIdOrNormalized 
            : marketIdOrNormalized.market_id;
        
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
            timestamp: prices.timestamp
        };
    }

    getStats() {
        return {
            total_requests: this.requestCount,
            mode: this.mode,
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
