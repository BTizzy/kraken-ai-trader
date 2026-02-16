/**
 * Polymarket API Client
 * Primary signal source - monitors price movements on Polymarket
 * 
 * API Docs: https://docs.polymarket.com/
 * Gamma API: https://gamma-api.polymarket.com/
 * CLOB API: https://clob.polymarket.com/
 */

const { Logger } = require('./logger');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

class PolymarketClient {
    constructor(options = {}) {
        this.logger = new Logger({ component: 'POLYMARKET', level: options.logLevel || 'INFO' });
        this.rateLimiter = options.rateLimiter || null;
        this.requestCount = 0;
        this.lastRequestTime = 0;
        this.minRequestInterval = options.minRequestInterval || 2000; // 2s between requests
        this.cache = new Map();
        this.cacheTTL = options.cacheTTL || 5000; // 5s cache
    }

    /**
     * Rate-limited fetch wrapper
     */
    async _fetch(url, options = {}) {
        // Simple rate limiting
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minRequestInterval) {
            await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
        }

        // Check cache
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

            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'PredictionBot/1.0',
                    ...options.headers
                }
            });

            clearTimeout(timeout);

            if (!response.ok) {
                if (response.status === 429) {
                    this.logger.warn('Rate limited by Polymarket, backing off...');
                    await new Promise(r => setTimeout(r, 5000));
                    return this._fetch(url, options); // Retry
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            // Cache result
            this.cache.set(cacheKey, { data, time: Date.now() });

            return data;
        } catch (error) {
            if (error.name === 'AbortError') {
                this.logger.error('Request timed out: ' + url);
            } else {
                this.logger.error('Fetch error: ' + error.message);
            }
            throw error;
        }
    }

    /**
     * Get active prediction markets from Gamma API
     * Supports filtering by category, status, etc.
     */
    async getMarkets(params = {}) {
        const queryParams = new URLSearchParams({
            active: 'true',
            closed: 'false',
            limit: params.limit || 100,
            offset: params.offset || 0,
            ...(params.tag && { tag: params.tag }),
            ...(params.order && { order: params.order }),
        });

        const url = `${GAMMA_API}/markets?${queryParams}`;
        const data = await this._fetch(url);
        return Array.isArray(data) ? data : [];
    }

    /**
     * Get a specific market by condition ID or slug
     */
    async getMarket(marketId) {
        const url = `${GAMMA_API}/markets/${marketId}`;
        return this._fetch(url);
    }

    /**
     * Get events (groups of related markets)
     */
    async getEvents(params = {}) {
        const queryParams = new URLSearchParams({
            active: 'true',
            closed: 'false',
            limit: params.limit || 50,
            offset: params.offset || 0,
            ...(params.tag && { tag: params.tag }),
        });

        const url = `${GAMMA_API}/events?${queryParams}`;
        const data = await this._fetch(url);
        return Array.isArray(data) ? data : [];
    }

    /**
     * Get CLOB orderbook for a specific token (YES/NO outcome)
     * Returns bids and asks with price levels and sizes
     */
    async getOrderbook(tokenId) {
        const url = `${CLOB_API}/book?token_id=${tokenId}`;
        try {
            const data = await this._fetch(url);
            return {
                bids: (data.bids || []).map(b => ({
                    price: parseFloat(b.price),
                    size: parseFloat(b.size)
                })),
                asks: (data.asks || []).map(a => ({
                    price: parseFloat(a.price),
                    size: parseFloat(a.size)
                })),
                timestamp: Date.now()
            };
        } catch (error) {
            this.logger.warn(`Failed to get orderbook for token ${tokenId}: ${error.message}`);
            return { bids: [], asks: [], timestamp: Date.now() };
        }
    }

    /**
     * Get best bid/ask for a market
     */
    async getBestPrices(tokenId) {
        const book = await this.getOrderbook(tokenId);
        return {
            bid: book.bids.length > 0 ? book.bids[0].price : null,
            ask: book.asks.length > 0 ? book.asks[0].price : null,
            spread: (book.asks.length > 0 && book.bids.length > 0)
                ? book.asks[0].price - book.bids[0].price
                : null,
            bid_depth: book.bids.reduce((sum, b) => sum + b.size * b.price, 0),
            ask_depth: book.asks.reduce((sum, a) => sum + a.size * a.price, 0),
            timestamp: book.timestamp
        };
    }

    /**
     * Get recent trades for a market token
     */
    async getRecentTrades(tokenId, limit = 50) {
        const url = `${CLOB_API}/trades?token_id=${tokenId}&limit=${limit}`;
        try {
            const data = await this._fetch(url);
            return (data || []).map(t => ({
                price: parseFloat(t.price),
                size: parseFloat(t.size),
                side: t.side,
                timestamp: new Date(t.match_time || t.created_at).getTime()
            }));
        } catch (error) {
            this.logger.warn(`Failed to get trades for token ${tokenId}: ${error.message}`);
            return [];
        }
    }

    /**
     * Get mid-market price from best bid/ask
     */
    async getMidPrice(tokenId) {
        const prices = await this.getBestPrices(tokenId);
        if (prices.bid !== null && prices.ask !== null) {
            return (prices.bid + prices.ask) / 2;
        }
        return null;
    }

    /**
     * Search markets by keyword
     */
    async searchMarkets(query) {
        const url = `${GAMMA_API}/markets?_q=${encodeURIComponent(query)}&active=true&closed=false&limit=50`;
        const data = await this._fetch(url);
        return Array.isArray(data) ? data : [];
    }

    /**
     * Get markets by category tag
     */
    async getMarketsByCategory(category) {
        const tagMap = {
            'politics': 'politics',
            'sports': 'sports',
            'crypto': 'crypto',
            'economics': 'economics',
            'science': 'science',
            'pop-culture': 'pop-culture'
        };
        const tag = tagMap[category] || category;
        return this.getMarkets({ tag });
    }

    /**
     * Normalize market data to unified format
     */
    normalizeMarket(rawMarket) {
        // Extract YES token ID from outcomes/tokens
        let yesTokenId = null;
        let noTokenId = null;

        if (rawMarket.clobTokenIds) {
            // Format: [yesTokenId, noTokenId]
            const ids = typeof rawMarket.clobTokenIds === 'string'
                ? JSON.parse(rawMarket.clobTokenIds)
                : rawMarket.clobTokenIds;
            if (ids.length >= 2) {
                yesTokenId = ids[0];
                noTokenId = ids[1];
            }
        }

        // Determine category from tags
        let category = 'other';
        const tags = rawMarket.tags || [];
        if (typeof tags === 'string') {
            try { 
                const parsed = JSON.parse(tags);
                if (parsed.includes('politics') || parsed.includes('elections')) category = 'politics';
                else if (parsed.includes('sports')) category = 'sports';
                else if (parsed.includes('crypto') || parsed.includes('bitcoin')) category = 'crypto';
                else if (parsed.includes('economics') || parsed.includes('finance')) category = 'economics';
            } catch (e) { /* ignore */ }
        } else if (Array.isArray(tags)) {
            if (tags.includes('politics') || tags.includes('elections')) category = 'politics';
            else if (tags.includes('sports')) category = 'sports';
            else if (tags.includes('crypto') || tags.includes('bitcoin')) category = 'crypto';
            else if (tags.includes('economics') || tags.includes('finance')) category = 'economics';
        }

        return {
            platform: 'polymarket',
            market_id: rawMarket.id || rawMarket.condition_id,
            slug: rawMarket.slug || null,
            title: rawMarket.question || rawMarket.title || 'Unknown',
            category,
            outcomes: rawMarket.outcomes ? 
                (typeof rawMarket.outcomes === 'string' ? JSON.parse(rawMarket.outcomes) : rawMarket.outcomes)
                : ['Yes', 'No'],
            yes_token_id: yesTokenId,
            no_token_id: noTokenId,
            resolution_date: rawMarket.end_date_iso || rawMarket.endDate || null,
            volume: parseFloat(rawMarket.volume || rawMarket.volumeNum || 0),
            volume_24h: parseFloat(rawMarket.volume24hr || 0),
            liquidity: parseFloat(rawMarket.liquidity || rawMarket.liquidityNum || 0),
            last_price_yes: parseFloat(rawMarket.outcomePrices ?
                (typeof rawMarket.outcomePrices === 'string' ? JSON.parse(rawMarket.outcomePrices)[0] : rawMarket.outcomePrices[0])
                : rawMarket.lastTradePrice || 0),
            active: rawMarket.active !== false && !rawMarket.closed,
            raw: rawMarket
        };
    }

    /**
     * Fetch all active markets, normalized
     */
    async fetchAllActiveMarkets() {
        const markets = [];
        let offset = 0;
        const limit = 100;
        let hasMore = true;

        while (hasMore && offset < 500) { // Cap at 500 markets
            try {
                const batch = await this.getMarkets({ limit, offset });
                if (batch.length === 0) {
                    hasMore = false;
                } else {
                    markets.push(...batch.map(m => this.normalizeMarket(m)));
                    offset += limit;
                    if (batch.length < limit) hasMore = false;
                }
            } catch (error) {
                this.logger.error(`Error fetching markets at offset ${offset}: ${error.message}`);
                hasMore = false;
            }
        }

        this.logger.info(`Fetched ${markets.length} active Polymarket markets`);
        return markets;
    }

    /**
     * Get full market state (prices + orderbook) for trading decisions
     */
    async getMarketState(normalizedMarket) {
        const state = {
            market_id: normalizedMarket.market_id,
            title: normalizedMarket.title,
            platform: 'polymarket',
            timestamp: Date.now()
        };

        if (normalizedMarket.yes_token_id) {
            const prices = await this.getBestPrices(normalizedMarket.yes_token_id);
            state.bid = prices.bid;
            state.ask = prices.ask;
            state.spread = prices.spread;
            state.bid_depth = prices.bid_depth;
            state.ask_depth = prices.ask_depth;
            state.last = normalizedMarket.last_price_yes;
        }

        return state;
    }

    getStats() {
        return {
            total_requests: this.requestCount,
            cache_size: this.cache.size
        };
    }

    clearCache() {
        this.cache.clear();
    }
}

module.exports = PolymarketClient;
