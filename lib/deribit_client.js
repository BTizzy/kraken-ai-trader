/**
 * Deribit Client — fetch options prices + implied vol for short-TTX fair value
 * Used to provide liquidity reference for sub-hour Gemini Prediction contracts
 */
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const logger = require('./logger.js');

const DERIBIT_API = 'https://www.deribit.com/api/v2/public';
const CACHE_TTL_MS = 5000; // 5s cache
const DERIBIT_REQUEST_TIMEOUT_MS = Math.max(500, Number(process.env.DERIBIT_REQUEST_TIMEOUT_MS || 1800));

class DeribitClient {
    constructor() {
        this.cache = new Map();
    }

    /**
     * Get options spread for a given asset and TTX.
     * Returns {bid, ask, mid, spread, iv_implied} for typical contract.
     * Approximates: uses spot ± spread from closest 1SD straddle.
     */
    async getOptionsSpread(asset = 'BTC', ttxMs) {
        const ttxSec = Math.round(ttxMs / 1000);
        const cacheKey = `${asset}-${ttxSec}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            return cached.data;
        }

        try {
            // Fetch spot to determine strike range
            const spotUrl = `${DERIBIT_API}/get_last_trades_by_instrument?instrument_name=${asset}USD&count=1`;
            const spotResp = await fetch(spotUrl, { signal: AbortSignal.timeout(DERIBIT_REQUEST_TIMEOUT_MS) });
            if (!spotResp.ok) {
                logger.warn(`[DERIBIT] Spot fetch failed: ${spotResp.status}`);
                return this._fallback(asset);
            }
            const spotData = await spotResp.json();
            const trades = spotData?.result?.trades || [];
            const spot = trades.length > 0 ? trades[0].price : null;
            if (!spot) {
                logger.warn(`[DERIBIT] No spot price for ${asset}`);
                return this._fallback(asset);
            }

            // Estimate expiry date from TTX
            const expiryDate = new Date(Date.now() + ttxMs);
            const daysToExp = ttxSec / 86400;
            const year = expiryDate.getUTCFullYear();
            const month = String(expiryDate.getUTCMonth() + 1).padStart(2, '0');
            const day = String(expiryDate.getUTCDate()).padStart(2, '0');
            const expiryStr = `${year}-${month}-${day}`;

            // Fetch ATM call (for IV proxy)
            const atmStrike = Math.round(spot / 1000) * 1000;
            const callSymbol = `${asset}-${expiryStr}-${atmStrike}-C`;
            const callUrl = `${DERIBIT_API}/get_order_book?instrument_name=${encodeURIComponent(callSymbol)}&depth=1`;
            const callResp = await fetch(callUrl, { signal: AbortSignal.timeout(DERIBIT_REQUEST_TIMEOUT_MS) });
            if (!callResp.ok) {
                logger.warn(`[DERIBIT] Call fetch failed: ${callUrl}`);
                return this._fallback(asset);
            }
            const callData = await callResp.json();
            const asks = callData?.result?.asks || [];
            const bids = callData?.result?.bids || [];
            
            if (asks.length === 0 || bids.length === 0) {
                logger.warn(`[DERIBIT] No book for ${callSymbol}`);
                return this._fallback(asset);
            }

            const bidPrice = bids.length > 0 ? bids[0][0] : 0.001;
            const askPrice = asks.length > 0 ? asks[0][0] : bidPrice + 0.002;
            const mid = (bidPrice + askPrice) / 2;
            const spread = askPrice - bidPrice;

            // Simple IV proxy: options price as pct of spot
            const ivImplied = (mid / spot) * 100 * Math.sqrt(365 / Math.max(daysToExp, 0.1));

            const result = {
                bid: bidPrice,
                ask: askPrice,
                mid,
                spread,
                iv_implied: Math.min(ivImplied, 200) // cap IV at 200%
            };

            this.cache.set(cacheKey, { data: result, timestamp: Date.now() });
            logger.debug(`[DERIBIT] ${callSymbol}: bid=${bidPrice}, ask=${askPrice}, iv=${ivImplied.toFixed(1)}%`);
            return result;
        } catch (err) {
            logger.warn(`[DERIBIT] Error fetching spreads: ${err.message}`);
            return this._fallback(asset);
        }
    }

    _fallback(asset) {
        // Fallback: assume 2% spread, 40% IV
        return { bid: 0.01, ask: 0.015, mid: 0.0125, spread: 0.005, iv_implied: 40 };
    }

    /**
     * Estimate fair value from Deribit options spreads.
     * For contracts with < 1h to expiry, use mid-price as FV.
     */
    async estimateFairValue(asset = 'BTC', currentSpot, ttxMs) {
        const opts = await this.getOptionsSpread(asset, ttxMs);
        // For predictions, mid of options book is fair reference
        return opts.mid;
    }
}

module.exports = DeribitClient;
