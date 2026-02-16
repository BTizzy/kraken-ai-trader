/**
 * Kalshi API Client
 * Secondary signal source - monitors price movements on Kalshi
 * 
 * API Docs: https://trading-api.kalshi.com/trade-api/v2/
 * WebSocket: wss://trading-api.kalshi.com/trade-api/ws/v2/
 */

const { Logger } = require('./logger');

const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_DEMO_API = 'https://demo-api.kalshi.co/trade-api/v2';

class KalshiClient {
    constructor(options = {}) {
        this.logger = new Logger({ component: 'KALSHI', level: options.logLevel || 'INFO' });
        this.apiBase = options.demo ? KALSHI_DEMO_API : KALSHI_API;
        this.apiKey = options.apiKey || process.env.KALSHI_API_KEY || null;
        this.requestCount = 0;
        this.lastRequestTime = 0;
        this.minRequestInterval = options.minRequestInterval || 1000; // 1 req/sec (60/min limit)
        this.cache = new Map();
        this.cacheTTL = options.cacheTTL || 5000;
        this.maxRetries = 3;
    }

    /**
     * Rate-limited fetch wrapper with auth
     */
    async _fetch(endpoint, options = {}) {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minRequestInterval) {
            await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
        }

        const url = `${this.apiBase}${endpoint}`;

        // Check cache
        const cacheKey = url;
        const cached = this.cache.get(cacheKey);
        if (cached && (Date.now() - cached.time) < this.cacheTTL) {
            return cached.data;
        }

        let retries = 0;
        while (retries < this.maxRetries) {
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
                    headers['Authorization'] = `Bearer ${this.apiKey}`;
                }

                const response = await fetch(url, {
                    ...options,
                    signal: controller.signal,
                    headers
                });

                clearTimeout(timeout);

                if (!response.ok) {
                    if (response.status === 429) {
                        const backoff = Math.pow(2, retries) * 2000;
                        this.logger.warn(`Rate limited by Kalshi, backing off ${backoff}ms...`);
                        await new Promise(r => setTimeout(r, backoff));
                        retries++;
                        continue;
                    }
                    if (response.status === 401) {
                        this.logger.warn('Kalshi auth failed - using public endpoints only');
                        throw new Error('Authentication required');
                    }
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const data = await response.json();
                this.cache.set(cacheKey, { data, time: Date.now() });
                return data;
            } catch (error) {
                if (error.name === 'AbortError') {
                    this.logger.error('Kalshi request timed out: ' + endpoint);
                }
                if (retries >= this.maxRetries - 1) throw error;
                retries++;
                await new Promise(r => setTimeout(r, 1000 * retries));
            }
        }
    }

    /**
     * Get active events (groups of markets)
     */
    async getEvents(params = {}) {
        const queryParams = new URLSearchParams({
            limit: params.limit || 100,
            status: 'open',
            ...(params.cursor && { cursor: params.cursor }),
            ...(params.series_ticker && { series_ticker: params.series_ticker }),
            ...(params.with_nested_markets && { with_nested_markets: 'true' }),
        });

        const data = await this._fetch(`/events?${queryParams}`);
        return data?.events || [];
    }

    /**
     * Get active markets
     */
    async getMarkets(params = {}) {
        const queryParams = new URLSearchParams({
            limit: params.limit || 200,
            status: 'open',
            ...(params.cursor && { cursor: params.cursor }),
            ...(params.event_ticker && { event_ticker: params.event_ticker }),
            ...(params.series_ticker && { series_ticker: params.series_ticker }),
            ...(params.tickers && { tickers: params.tickers }),
        });

        const data = await this._fetch(`/markets?${queryParams}`);
        return data?.markets || [];
    }

    /**
     * Get a specific market by ticker
     */
    async getMarket(ticker) {
        const data = await this._fetch(`/markets/${ticker}`);
        return data?.market || null;
    }

    /**
     * Get orderbook for a market
     */
    async getOrderbook(ticker, depth = 10) {
        try {
            const data = await this._fetch(`/orderbook/${ticker}?depth=${depth}`);
            const book = data?.orderbook || {};
            return {
                yes: {
                    bids: (book.yes || []).filter(l => l[0] !== undefined).map(l => ({
                        price: l[0] / 100, // Kalshi uses cents
                        size: l[1]
                    })),
                    asks: [] // Derived from No side
                },
                no: {
                    bids: (book.no || []).filter(l => l[0] !== undefined).map(l => ({
                        price: l[0] / 100,
                        size: l[1]
                    })),
                    asks: []
                },
                timestamp: Date.now()
            };
        } catch (error) {
            this.logger.warn(`Failed to get orderbook for ${ticker}: ${error.message}`);
            return { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] }, timestamp: Date.now() };
        }
    }

    /**
     * Get best bid/ask prices for a market
     * Kalshi: YES price + NO price = $1.00 (100 cents)
     */
    async getBestPrices(ticker) {
        const book = await this.getOrderbook(ticker);

        // Best YES bid is strongest YES buyer
        const yesBid = book.yes.bids.length > 0 ? book.yes.bids[0].price : null;
        // Best YES ask = 1 - best NO bid
        const noBid = book.no.bids.length > 0 ? book.no.bids[0].price : null;
        const yesAsk = noBid !== null ? (1.0 - noBid) : null;

        return {
            bid: yesBid,
            ask: yesAsk,
            spread: (yesBid !== null && yesAsk !== null) ? yesAsk - yesBid : null,
            timestamp: book.timestamp
        };
    }

    /**
     * Get recent trades for a market
     */
    async getRecentTrades(ticker, limit = 50) {
        try {
            const data = await this._fetch(`/markets/trades?ticker=${ticker}&limit=${limit}`);
            return (data?.trades || []).map(t => ({
                price: (t.yes_price || t.no_price || 0) / 100,
                size: t.count || 1,
                side: t.taker_side || 'unknown',
                timestamp: new Date(t.created_time).getTime()
            }));
        } catch (error) {
            this.logger.warn(`Failed to get trades for ${ticker}: ${error.message}`);
            return [];
        }
    }

    /**
     * Get market history (candlestick data)
     */
    async getMarketHistory(ticker, params = {}) {
        const queryParams = new URLSearchParams({
            ticker,
            ...(params.period_interval && { period_interval: params.period_interval }),
            ...(params.start_ts && { start_ts: params.start_ts }),
            ...(params.end_ts && { end_ts: params.end_ts }),
        });

        try {
            const data = await this._fetch(`/series/${ticker}/markets?${queryParams}`);
            return data?.markets || [];
        } catch (error) {
            this.logger.warn(`Failed to get history for ${ticker}: ${error.message}`);
            return [];
        }
    }

    /**
     * Normalize Kalshi market to unified format
     */
    normalizeMarket(rawMarket) {
        // Determine category from series/event info
        let category = 'other';
        const title = (rawMarket.title || rawMarket.subtitle || '').toLowerCase();
        const seriesTicker = (rawMarket.series_ticker || '').toLowerCase();

        if (title.includes('election') || title.includes('president') || title.includes('congress') || 
            seriesTicker.includes('pres') || seriesTicker.includes('elect')) {
            category = 'politics';
        } else if (title.includes('bitcoin') || title.includes('btc') || title.includes('ethereum') || 
                   title.includes('crypto') || seriesTicker.includes('btc') || seriesTicker.includes('eth')) {
            category = 'crypto';
        } else if (title.includes('super bowl') || title.includes('nfl') || title.includes('nba') ||
                   title.includes('mlb') || title.includes('sports')) {
            category = 'sports';
        } else if (title.includes('fed') || title.includes('gdp') || title.includes('inflation') ||
                   title.includes('cpi') || title.includes('rate')) {
            category = 'economics';
        }

        return {
            platform: 'kalshi',
            market_id: rawMarket.ticker,
            title: rawMarket.title || rawMarket.subtitle || 'Unknown',
            category,
            outcomes: ['Yes', 'No'],
            resolution_date: rawMarket.close_time || rawMarket.expiration_time || null,
            volume: rawMarket.volume || 0,
            volume_24h: rawMarket.volume_24h || 0,
            open_interest: rawMarket.open_interest || 0,
            last_price_yes: rawMarket.last_price ? rawMarket.last_price / 100 : null,
            yes_bid: rawMarket.yes_bid ? rawMarket.yes_bid / 100 : null,
            yes_ask: rawMarket.yes_ask ? rawMarket.yes_ask / 100 : null,
            active: rawMarket.status === 'open' || rawMarket.status === 'active',
            event_ticker: rawMarket.event_ticker || null,
            series_ticker: rawMarket.series_ticker || null,
            raw: rawMarket
        };
    }

    /**
     * Fetch all active markets, normalized
     */
    async fetchAllActiveMarkets() {
        const markets = [];
        let cursor = null;
        let pages = 0;

        while (pages < 5) { // Cap at 5 pages
            try {
                const params = { limit: 200 };
                if (cursor) params.cursor = cursor;

                const batch = await this.getMarkets(params);
                if (batch.length === 0) break;

                markets.push(...batch.map(m => this.normalizeMarket(m)));

                // Check for pagination cursor
                cursor = batch.length === 200 ? batch[batch.length - 1]?.ticker : null;
                pages++;
                if (!cursor) break;
            } catch (error) {
                this.logger.error(`Error fetching Kalshi markets page ${pages}: ${error.message}`);
                break;
            }
        }

        this.logger.info(`Fetched ${markets.length} active Kalshi markets`);
        return markets;
    }

    /**
     * Get full market state for trading decisions
     */
    async getMarketState(normalizedMarket) {
        const prices = await this.getBestPrices(normalizedMarket.market_id);
        return {
            market_id: normalizedMarket.market_id,
            title: normalizedMarket.title,
            platform: 'kalshi',
            bid: prices.bid,
            ask: prices.ask,
            spread: prices.spread,
            last: normalizedMarket.last_price_yes,
            timestamp: prices.timestamp
        };
    }

    getStats() {
        return {
            total_requests: this.requestCount,
            cache_size: this.cache.size,
            api_base: this.apiBase,
            authenticated: !!this.apiKey
        };
    }

    clearCache() {
        this.cache.clear();
    }
}

module.exports = KalshiClient;
