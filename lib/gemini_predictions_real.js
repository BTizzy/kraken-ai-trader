/**
 * Real Gemini Predictions Client
 * 
 * Connects to the ACTUAL Gemini Predictions API at:
 *   https://www.gemini.com/prediction-markets
 * 
 * Discovered via reverse-engineering the Gemini Predictions frontend JS bundle.
 * This replaces the simulated updatePaperMarket() approach with real market data.
 * 
 * API Endpoints (public, no auth needed for reading):
 *   GET /prediction-markets?status=active&category=crypto&limit=20
 *   GET /prediction-markets?status=active&limit=60
 *   
 * Query params:
 *   status: active | settled | under_review
 *   category: crypto | sports | politics | elections | culture | tech | finance | other
 *   limit: number (max results)
 *   offset: number (pagination)
 *   search: string (search query)
 *   marketType: string
 * 
 * Response format:
 *   { data: [Event], pagination: { limit, offset, total } }
 * 
 * Event has:
 *   - id, title, slug, ticker, type, category, status
 *   - contracts: [{ id, label, ticker, instrumentSymbol, prices: { buy: {yes, no}, sell: {yes, no}, bestBid, bestAsk, lastTradePrice }, expiryDate, marketState }]
 */

const { Logger } = require('./logger');

const GEMINI_PREDICTIONS_BASE = 'https://www.gemini.com';
const MARKETS_ENDPOINT = '/prediction-markets';
const GEMINI_REST_BASE = 'https://api.gemini.com';

// Orderbook cache: instrumentSymbol -> { bids, asks, timestamp }
const orderbookCache = new Map();

class GeminiPredictionsReal {
    constructor(options = {}) {
        this.logger = new Logger({ component: 'GEMINI-REAL', level: options.logLevel || 'INFO' });
        this.requestCount = 0;
        this.lastRequestTime = 0;
        this.minRequestInterval = options.minRequestInterval || 2000; // 2s between requests
        this.cache = new Map();
        this.cacheTTL = options.cacheTTL || 5000; // 5s cache
        
        // Market state tracking
        this.markets = new Map();        // eventTicker -> event data
        this.contracts = new Map();      // instrumentSymbol -> contract data with prices
        this.lastFetchTime = 0;
        this.fetchInterval = options.fetchInterval || 15000; // 15s between full refreshes
        
        // Categories to track (crypto is our primary focus)
        this.categories = options.categories || ['crypto'];
        
        // Stats
        this.totalFetches = 0;
        this.errors = 0;
        this.lastError = null;
    }

    /**
     * Rate-limited fetch wrapper for Gemini web server
     */
    async _fetch(url) {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minRequestInterval) {
            await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
        }

        const cached = this.cache.get(url);
        if (cached && (Date.now() - cached.time) < this.cacheTTL) {
            return cached.data;
        }

        try {
            this.lastRequestTime = Date.now();
            this.requestCount++;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json'
                }
            });

            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            this.cache.set(url, { data, time: Date.now() });
            return data;
        } catch (error) {
            this.errors++;
            this.lastError = { message: error.message, time: Date.now() };
            throw error;
        }
    }

    /**
     * Fetch all active prediction markets for configured categories
     */
    async fetchMarkets(options = {}) {
        const category = options.category || this.categories[0];
        const limit = options.limit || 60;
        const status = options.status || 'active';

        const params = new URLSearchParams({ status, limit: limit.toString() });
        if (category && category !== 'all') {
            params.set('category', category);
        }

        const url = `${GEMINI_PREDICTIONS_BASE}${MARKETS_ENDPOINT}?${params.toString()}`;
        
        try {
            const response = await this._fetch(url);
            const events = response?.data || [];
            const pagination = response?.pagination || {};

            this.totalFetches++;
            this.lastFetchTime = Date.now();

            // Update internal market state
            for (const event of events) {
                this.markets.set(event.ticker, event);
                
                for (const contract of (event.contracts || [])) {
                    const key = contract.instrumentSymbol || `${event.ticker}-${contract.ticker}`;
                    this.contracts.set(key, {
                        ...contract,
                        eventTicker: event.ticker,
                        eventTitle: event.title,
                        eventCategory: event.category,
                        eventType: event.type,
                        lastUpdated: Date.now()
                    });
                }
            }

            this.logger.info(
                `Fetched ${events.length} events (${this.contracts.size} contracts) | ` +
                `Category: ${category} | Total available: ${pagination.total || '?'}`
            );

            return events;
        } catch (error) {
            this.logger.error(`Failed to fetch markets: ${error.message}`);
            return [];
        }
    }

    /**
     * Fetch all categories
     */
    async fetchAllCategories() {
        const allEvents = [];
        for (const cat of this.categories) {
            const events = await this.fetchMarkets({ category: cat });
            allEvents.push(...events);
        }
        return allEvents;
    }

    /**
     * Get best prices for a specific contract (by instrumentSymbol or market ID)
     * 
     * IMPORTANT: bestBid/bestAsk are REAL orderbook levels.
     * buy.yes/sell.yes are indicative prices (often = lastTradePrice, NOT real bids/asks).
     * Only bestBid+bestAsk should be used for trading decisions.
     */
    getBestPrices(contractKey) {
        const contract = this.contracts.get(contractKey);
        if (!contract) return null;

        const prices = contract.prices || {};
        const buy = prices.buy || {};
        const sell = prices.sell || {};

        // REAL orderbook levels only — never fall back to sell.yes/buy.yes for trading
        const bid = prices.bestBid !== null && prices.bestBid !== undefined 
            ? parseFloat(prices.bestBid) : null;
        const ask = prices.bestAsk !== null && prices.bestAsk !== undefined 
            ? parseFloat(prices.bestAsk) : null;
        const lastTrade = prices.lastTradePrice ? parseFloat(prices.lastTradePrice) : null;

        // Indicative prices (for mid-price estimation only, NOT for trading)
        const indicativeBid = sell.yes ? parseFloat(sell.yes) : null;
        const indicativeAsk = buy.yes ? parseFloat(buy.yes) : null;

        return {
            bid,               // Real orderbook bid (null if no live bids)
            ask,               // Real orderbook ask (null if no live asks)
            spread: (bid !== null && ask !== null) ? ask - bid : null,
            lastTrade,
            indicativeBid,     // sell.yes — NOT a real bid, for estimation only
            indicativeAsk,     // buy.yes — NOT a real ask, for estimation only
            buyYes: buy.yes ? parseFloat(buy.yes) : null,
            buyNo: buy.no ? parseFloat(buy.no) : null,
            sellYes: sell.yes ? parseFloat(sell.yes) : null,
            sellNo: sell.no ? parseFloat(sell.no) : null,
            hasTwoSidedBook: bid !== null && ask !== null,
            timestamp: contract.lastUpdated
        };
    }

    /**
     * Get mid-price for a contract
     * Uses real orderbook if available, falls back to indicative prices
     */
    getMidPrice(contractKey) {
        const prices = this.getBestPrices(contractKey);
        if (!prices) return null;
        
        // Best: real two-sided book
        if (prices.bid !== null && prices.ask !== null) {
            return (prices.bid + prices.ask) / 2;
        }
        // Fallback: last trade
        if (prices.lastTrade !== null) return prices.lastTrade;
        // Fallback: indicative prices (not reliable for trading)
        if (prices.indicativeBid !== null && prices.indicativeAsk !== null) {
            return (prices.indicativeBid + prices.indicativeAsk) / 2;
        }
        if (prices.indicativeAsk !== null) return prices.indicativeAsk;
        return null;
    }

    /**
     * Find crypto prediction markets that match a specific asset
     * e.g., findCryptoMarkets('BTC') returns all BTC price prediction events
     */
    findCryptoMarkets(asset) {
        const results = [];
        for (const [ticker, event] of this.markets) {
            if (ticker.toUpperCase().startsWith(asset.toUpperCase()) && 
                event.category?.toLowerCase() === 'crypto') {
                results.push(event);
            }
        }
        return results.sort((a, b) => {
            // Sort by expiry date (soonest first)
            const aExpiry = a.contracts?.[0]?.expiryDate || '';
            const bExpiry = b.contracts?.[0]?.expiryDate || '';
            return aExpiry.localeCompare(bExpiry);
        });
    }

    /**
     * Get all contracts with REAL two-sided orderbook (both bestBid AND bestAsk)
     * These are the only contracts safe to trade on.
     */
    getTradeableContracts() {
        const tradeable = [];
        for (const [key, contract] of this.contracts) {
            const prices = this.getBestPrices(key);
            if (prices && prices.hasTwoSidedBook && prices.spread >= 0) {
                tradeable.push({
                    instrumentSymbol: key,
                    label: contract.label,
                    eventTitle: contract.eventTitle,
                    eventTicker: contract.eventTicker,
                    category: contract.eventCategory,
                    expiryDate: contract.expiryDate,
                    ...prices
                });
            }
        }
        return tradeable.sort((a, b) => a.spread - b.spread); // Tightest spread first
    }

    /**
     * Analyze market liquidity across all tracked contracts
     */
    analyzeLiquidity() {
        const total = this.contracts.size;
        let withBid = 0, withAsk = 0, withBoth = 0, withTrade = 0;
        const spreads = [];

        for (const [key] of this.contracts) {
            const p = this.getBestPrices(key);
            if (!p) continue;
            if (p.bid !== null) withBid++;
            if (p.ask !== null) withAsk++;
            if (p.bid !== null && p.ask !== null) {
                withBoth++;
                spreads.push(p.spread);
            }
            if (p.lastTrade !== null) withTrade++;
        }

        spreads.sort((a, b) => a - b);
        const medianSpread = spreads.length > 0 ? spreads[Math.floor(spreads.length / 2)] : null;
        const avgSpread = spreads.length > 0 ? spreads.reduce((s, v) => s + v, 0) / spreads.length : null;

        return {
            totalContracts: total,
            withBid,
            withAsk,
            withBothSides: withBoth,
            withLastTrade: withTrade,
            tradeablePercent: total > 0 ? ((withBoth / total) * 100).toFixed(1) : '0',
            medianSpread: medianSpread !== null ? medianSpread.toFixed(3) : null,
            avgSpread: avgSpread !== null ? avgSpread.toFixed(3) : null,
            minSpread: spreads.length > 0 ? spreads[0].toFixed(3) : null,
            maxSpread: spreads.length > 0 ? spreads[spreads.length - 1].toFixed(3) : null
        };
    }

    /**
     * Normalize a Gemini event to unified format compatible with signal detector
     */
    normalizeEvent(event) {
        const contracts = event.contracts || [];
        return contracts.map(contract => {
            const key = contract.instrumentSymbol || `${event.ticker}-${contract.ticker}`;
            const prices = this.getBestPrices(key) || {};

            return {
                platform: 'gemini',
                market_id: contract.instrumentSymbol,
                title: `${event.title}: ${contract.label}`,
                category: (event.category || 'other').toLowerCase(),
                outcomes: ['Yes', 'No'],
                resolution_date: contract.expiryDate,
                volume: null, // Volume not available from this endpoint
                last_price_yes: prices.lastTrade,
                bid: prices.bid,        // Real orderbook bid
                ask: prices.ask,        // Real orderbook ask
                spread: prices.spread,
                hasTwoSidedBook: prices.hasTwoSidedBook || false,
                active: contract.marketState === 'open',
                eventTicker: event.ticker,
                contractTicker: contract.ticker,
                raw: contract
            };
        });
    }

    /**
     * Get all active normalized markets
     */
    getAllNormalizedMarkets() {
        const normalized = [];
        for (const [, event] of this.markets) {
            normalized.push(...this.normalizeEvent(event));
        }
        return normalized;
    }

    /**
     * Fetch real order book depth from Gemini REST API
     * Uses GET /v1/book/{symbol}?limit_bids=5&limit_asks=5
     *
     * Prediction market instrument symbols are valid REST symbols (e.g. "BTCUSD-PRED-2026-01").
     * Returns { bids, asks, bidDepthUSD, askDepthUSD } or null on failure.
     * Results are cached for ORDERBOOK_CACHE_TTL_MS.
     */
    async getOrderbookDepth(instrumentSymbol, opts = {}) {
        const ORDERBOOK_CACHE_TTL_MS = opts.cacheTtl || 5000;
        const cached = orderbookCache.get(instrumentSymbol);
        if (cached && Date.now() - cached.timestamp < ORDERBOOK_CACHE_TTL_MS) {
            return cached;
        }

        const symbol = instrumentSymbol.toLowerCase();
        const url = `${GEMINI_REST_BASE}/v1/book/${encodeURIComponent(symbol)}?limit_bids=5&limit_asks=5`;

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            const resp = await fetch(url, {
                signal: controller.signal,
                headers: { 'Accept': 'application/json' }
            });
            clearTimeout(timeout);

            if (!resp.ok) {
                // Prediction market books are not on the spot REST endpoint; fall back silently
                this.logger.debug(`Orderbook not available for ${instrumentSymbol}: HTTP ${resp.status}`);
                return null;
            }

            const data = await resp.json();
            const bids = (data.bids || []).map(b => ({
                price: parseFloat(b.price),
                size: parseFloat(b.amount)
            })).filter(b => b.price > 0);
            const asks = (data.asks || []).map(a => ({
                price: parseFloat(a.price),
                size: parseFloat(a.amount)
            })).filter(a => a.price > 0);

            const bidDepthUSD = bids.reduce((s, b) => s + b.price * b.size, 0);
            const askDepthUSD = asks.reduce((s, a) => s + a.price * a.size, 0);

            const result = { bids, asks, bidDepthUSD, askDepthUSD, timestamp: Date.now(), source: 'rest' };
            orderbookCache.set(instrumentSymbol, result);
            return result;
        } catch (e) {
            this.logger.debug(`Orderbook fetch failed for ${instrumentSymbol}: ${e.message}`);
            return null;
        }
    }

    /**
     * Fetch batch tickers for a category — lightweight price refresh.
     *
     * Endpoint: GET https://www.gemini.com/prediction-markets/tickers/{category}
     * Returns: [{ instrumentSymbol, bestBid, bestAsk, lastTradePrice, volume, openInterest }]
     *
     * Call this every 5-10s as a fast price update between full fetchMarkets() calls
     * (which are heavier and rate-limited to every 15s).
     *
     * Returns the number of contracts updated.
     */
    async fetchBatchTickers(category = 'crypto') {
        const url = `${GEMINI_PREDICTIONS_BASE}/prediction-markets/tickers/${category}`;
        try {
            const data = await this._fetch(url);
            const tickers = Array.isArray(data) ? data : (data?.data || data?.tickers || []);
            let updated = 0;

            for (const t of tickers) {
                const sym = t.instrumentSymbol || t.instrument_symbol;
                if (!sym) continue;

                const contract = this.contracts.get(sym);
                if (!contract) continue; // Only update known contracts (fetched by fetchMarkets)

                const bid  = t.bestBid  != null ? parseFloat(t.bestBid)  : null;
                const ask  = t.bestAsk  != null ? parseFloat(t.bestAsk)  : null;
                const last = t.lastTradePrice != null ? parseFloat(t.lastTradePrice) : null;

                // Patch prices in-place — preserves all other contract metadata
                if (!contract.prices) contract.prices = {};
                if (bid  !== null) contract.prices.bestBid       = String(bid);
                if (ask  !== null) contract.prices.bestAsk       = String(ask);
                if (last !== null) contract.prices.lastTradePrice = String(last);
                if (t.volume        != null) contract.volume       = t.volume;
                if (t.openInterest  != null) contract.openInterest = t.openInterest;
                contract.lastUpdated = Date.now();

                this.contracts.set(sym, contract);
                updated++;
            }

            if (updated > 0) {
                this.logger.debug(`Batch tickers: updated ${updated} contracts (${category})`);
            }
            return updated;
        } catch (e) {
            this.logger.debug(`Batch tickers failed (${category}): ${e.message}`);
            return 0;
        }
    }

    /**
     * Get stats
     */
    getStats() {
        return {
            events: this.markets.size,
            contracts: this.contracts.size,
            totalFetches: this.totalFetches,
            errors: this.errors,
            lastFetchTime: this.lastFetchTime,
            lastError: this.lastError,
            requestCount: this.requestCount,
            categories: this.categories
        };
    }

    /**
     * Clear all cached data
     */
    clearCache() {
        this.cache.clear();
        this.markets.clear();
        this.contracts.clear();
    }
}

module.exports = GeminiPredictionsReal;
