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
        // Real-time price cache fed by KalshiWS tick events
        // Keys: marketTicker → { yesBid, yesAsk, lastPrice, volume, ts, source }
        this.bracketCache = new Map();
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

    // =========================================================================
    // Cross-Platform Fair Value: Kalshi brackets → synthetic "above" contracts
    // =========================================================================

    /** Series tickers for crypto assets */
    static SERIES_TICKERS = { BTC: 'KXBTC', ETH: 'KXETH', SOL: 'KXSOL' };

    /**
     * Parse a Kalshi market into a structured bracket for analysis
     */
    parseBracket(market) {
        const yesBid = ((market.yes_bid || 0) / 100);
        const yesAsk = ((market.yes_ask || 0) / 100);
        const lastPrice = ((market.last_price || 0) / 100);
        const mid = (yesBid > 0 && yesAsk > 0)
            ? (yesBid + yesAsk) / 2
            : (lastPrice > 0 ? lastPrice : 0);

        // Parse settlement hour from event_ticker: KXBTC-26FEB1712 → 12
        let settlementHour = null;
        const tm = (market.event_ticker || '').match(/\d{2}[A-Z]{3}\d{2}(\d{2})$/);
        if (tm) settlementHour = parseInt(tm[1]);

        return {
            ticker: market.ticker || '',
            eventTicker: market.event_ticker || '',
            strikeType: market.strike_type || '',
            floorStrike: market.floor_strike || 0,
            capStrike: market.cap_strike || null,
            yesBid, yesAsk, mid, lastPrice,
            volume: market.volume || 0,
            openInterest: market.open_interest || 0,
            settlementHour,
            spread: (yesAsk > 0 && yesBid > 0) ? yesAsk - yesBid : null,
            hasLiquidity: (market.volume || 0) > 0 || yesBid > 0 || yesAsk > 0
        };
    }

    /**
     * Get all crypto brackets grouped by event (settlement time)
     */
    async getBracketsByEvent(asset) {
        const seriesTicker = KalshiClient.SERIES_TICKERS[asset];
        if (!seriesTicker) return {};

        const markets = await this.getMarkets({ series_ticker: seriesTicker, limit: 200 });
        const events = {};

        for (const m of markets) {
            const b = this.parseBracket(m);
            if (b.strikeType !== 'between' && b.strikeType !== 'greater') continue;
            if (!events[b.eventTicker]) {
                events[b.eventTicker] = {
                    eventTicker: b.eventTicker,
                    settlementHour: b.settlementHour,
                    brackets: []
                };
            }
            events[b.eventTicker].brackets.push(b);
        }

        for (const e of Object.values(events)) {
            e.brackets.sort((a, b) => a.floorStrike - b.floorStrike);
        }
        return events;
    }

    /**
     * Convert Kalshi brackets into synthetic "above" probabilities
     *
     * P(BTC > X) = sum of all bracket probabilities from X upward
     */
    computeSyntheticAbove(brackets) {
        const between = brackets
            .filter(b => b.strikeType === 'between')
            .sort((a, b) => a.floorStrike - b.floorStrike);
        if (between.length === 0) return {};

        const result = {};
        for (let i = 0; i < between.length; i++) {
            const remaining = between.slice(i);
            result[between[i].floorStrike] = {
                mid: remaining.reduce((s, b) => s + b.mid, 0),
                bidSum: remaining.reduce((s, b) => s + b.yesBid, 0),
                askSum: remaining.reduce((s, b) => s + b.yesAsk, 0),
                bracketCount: remaining.length,
                liquidBrackets: remaining.filter(b => b.hasLiquidity).length,
                totalVolume: remaining.reduce((s, b) => s + b.volume, 0)
            };
        }
        return result;
    }

    /**
     * Find synthetic "above" price closest to a Gemini strike
     */
    findSyntheticPrice(aboveProbs, geminiStrike) {
        const strikes = Object.keys(aboveProbs).map(Number).sort((a, b) => a - b);
        if (strikes.length === 0) return null;

        let best = null, bestDist = Infinity;
        for (const s of strikes) {
            const d = Math.abs(s - geminiStrike);
            if (d < bestDist) { bestDist = d; best = s; }
        }
        if (bestDist > 500) return null;

        const p = aboveProbs[best];
        return {
            kalshiStrike: best,
            strikeDiff: geminiStrike - best,
            fairValueMid: p.mid,
            fairValueBid: p.bidSum,
            fairValueAsk: p.askSum,
            confidence: p.liquidBrackets / p.bracketCount,
            totalVolume: p.totalVolume,
            bracketCount: p.bracketCount
        };
    }

    /**
     * Full cross-platform analysis for a single Gemini contract
     *
     * Returns { matched, edge, signal, kalshiFairValue, ... }
     */
    async analyzeGeminiContract(asset, geminiStrike, geminiBid, geminiAsk, eventTimeHint = null) {
        const events = await this.getBracketsByEvent(asset);

        let bestEvent = null;
        for (const e of Object.values(events)) {
            if (eventTimeHint && e.settlementHour !== eventTimeHint) continue;
            if (!bestEvent || e.brackets.length > bestEvent.brackets.length) bestEvent = e;
        }
        if (!bestEvent) return { matched: false, reason: 'No matching Kalshi event' };

        const aboveProbs = this.computeSyntheticAbove(bestEvent.brackets);
        const synthetic = this.findSyntheticPrice(aboveProbs, geminiStrike);
        if (!synthetic) return { matched: false, reason: 'No matching Kalshi strike' };

        const geminiMid = (geminiBid != null && geminiAsk != null)
            ? (geminiBid + geminiAsk) / 2
            : (geminiBid ?? geminiAsk ?? null);

        let signal = null, edge = 0;
        if (geminiAsk != null && synthetic.fairValueMid > geminiAsk) {
            edge = synthetic.fairValueMid - geminiAsk;
            signal = 'BUY_YES';
        } else if (geminiBid != null && synthetic.fairValueMid < geminiBid) {
            edge = geminiBid - synthetic.fairValueMid;
            signal = 'BUY_NO';
        }

        return {
            matched: true,
            kalshiEvent: bestEvent.eventTicker,
            kalshiStrike: synthetic.kalshiStrike,
            strikeDiff: synthetic.strikeDiff,
            kalshiFairValue: +synthetic.fairValueMid.toFixed(4),
            kalshiBidSum: +synthetic.fairValueBid.toFixed(4),
            kalshiAskSum: +synthetic.fairValueAsk.toFixed(4),
            geminiBid, geminiAsk, geminiMid,
            edge: +edge.toFixed(4),
            signal,
            confidence: +synthetic.confidence.toFixed(2),
            kalshiVolume: synthetic.totalVolume,
            bracketCount: synthetic.bracketCount,
            // Include raw brackets for IV extraction in FairValueEngine
            brackets: bestEvent.brackets,
            computeSyntheticAbove: this.computeSyntheticAbove.bind(this)
        };
    }

    /**
     * Scan an array of Gemini contracts and return all opportunities sorted by edge
     *
     * Each contract: { asset, strike, bid, ask, eventTitle, marketId, settlementHour }
     */
    async scanOpportunities(geminiContracts) {
        const opps = [];
        for (const c of geminiContracts) {
            if (!c.asset || !c.strike || (c.bid == null && c.ask == null)) continue;
            try {
                const a = await this.analyzeGeminiContract(c.asset, c.strike, c.bid, c.ask, c.settlementHour);
                if (a.matched && a.edge > 0) {
                    opps.push({ marketId: c.marketId, eventTitle: c.eventTitle, asset: c.asset, strike: c.strike, ...a });
                }
            } catch (e) {
                this.logger.debug(`Error analyzing ${c.asset} $${c.strike}: ${e.message}`);
            }
        }
        opps.sort((a, b) => b.edge - a.edge);
        return opps;
    }
}

module.exports = KalshiClient;
