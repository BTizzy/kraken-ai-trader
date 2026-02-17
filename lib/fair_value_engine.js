/**
 * Fair Value Pricing Engine for Prediction Markets
 * 
 * Three pricing models for computing fair value of binary crypto contracts:
 * 
 * 1. BLACK_SCHOLES — Standard binary option pricing using spot price + vol
 *    P(S > K at T) = Φ(d2)  where d2 = [ln(S/K) - σ²T/2] / (σ√T)
 * 
 * 2. KALSHI_SYNTHETIC — Cross-platform fair value from Kalshi bracket sum
 *    P(BTC > K) = Σ P(BTC in bracket_i) for all brackets_i with floor ≥ K
 * 
 * 3. ENSEMBLE — Weighted combination of both models
 * 
 * Fee model: Gemini 0.05% flat + 0.01% maker = ~0.06% per side
 */

const { Logger } = require('./logger');

/**
 * Standard normal CDF (Abramowitz & Stegun approximation, accurate to 1e-7)
 */
function normalCDF(x) {
    if (x < -8) return 0;
    if (x > 8) return 1;
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1.0 / (1.0 + p * Math.abs(x));
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
    return 0.5 * (1.0 + sign * y);
}

/**
 * Standard normal PDF
 */
function normalPDF(x) {
    return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}

class FairValueEngine {
    constructor(options = {}) {
        this.logger = new Logger({ component: 'FAIRVAL', level: options.logLevel || 'INFO' });

        // Fee model: Gemini Predictions
        this.feePerSide = options.feePerSide || 0.0006; // 0.06%

        // Volatility estimation
        this.priceHistory = new Map();  // asset -> [{price, timestamp}]
        this.maxPriceHistory = options.maxPriceHistory || 1000;
        this.defaultVolatility = options.defaultVolatility || 0.50; // 50% annualized
        this.volPremium = options.volPremium || 1.15; // 15% vol premium for fat tails

        // Edge thresholds
        this.minEdge = options.minEdge || 0.03;  // 3¢ minimum edge to trade
        this.highConfidenceEdge = options.highConfidenceEdge || 0.08; // 8¢ = high confidence

        // Model weights for ensemble
        this.modelWeights = options.modelWeights || {
            blackScholes: 0.35,
            kalshiSynthetic: 0.65  // Prefer market-consensus
        };
    }

    // =========================================================================
    // Price History & Volatility
    // =========================================================================

    /**
     * Record a spot price observation for an asset
     */
    recordSpotPrice(asset, price, timestamp = Date.now()) {
        if (!price || price <= 0) return;
        if (!this.priceHistory.has(asset)) {
            this.priceHistory.set(asset, []);
        }
        const history = this.priceHistory.get(asset);
        history.push({ price, timestamp });
        while (history.length > this.maxPriceHistory) {
            history.shift();
        }
    }

    /**
     * Get current spot price for an asset (most recent observation)
     */
    getSpotPrice(asset) {
        const history = this.priceHistory.get(asset);
        if (!history || history.length === 0) return null;
        return history[history.length - 1].price;
    }

    /**
     * Calculate realized volatility from price history
     * 
     * Uses log returns, annualized
     * windowMs: lookback window (default 24h)
     */
    calculateVolatility(asset, windowMs = 24 * 60 * 60 * 1000) {
        const history = this.priceHistory.get(asset);
        if (!history || history.length < 10) return this.defaultVolatility;

        const cutoff = Date.now() - windowMs;
        const recent = history.filter(h => h.timestamp >= cutoff);
        if (recent.length < 10) return this.defaultVolatility;

        // Compute log returns
        const returns = [];
        for (let i = 1; i < recent.length; i++) {
            if (recent[i].price > 0 && recent[i - 1].price > 0) {
                returns.push(Math.log(recent[i].price / recent[i - 1].price));
            }
        }
        if (returns.length < 5) return this.defaultVolatility;

        // Standard deviation of returns
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
        const stdDev = Math.sqrt(variance);

        // Annualize: multiply by √(observations_per_year)
        // Average time between observations
        const avgInterval = (recent[recent.length - 1].timestamp - recent[0].timestamp) / (recent.length - 1);
        const observationsPerYear = (365.25 * 24 * 60 * 60 * 1000) / avgInterval;
        const annualizedVol = stdDev * Math.sqrt(observationsPerYear);

        // Apply premium for fat tails
        return annualizedVol * this.volPremium;
    }

    // =========================================================================
    // Model 1: Black-Scholes Binary Option Pricing
    // =========================================================================

    /**
     * Price a binary option: P(S > K at time T)
     * 
     * @param {number} spot - Current spot price
     * @param {number} strike - Strike price
     * @param {number} timeToExpiry - Time to expiry in HOURS
     * @param {number} volatility - Annualized volatility (e.g., 0.50 = 50%)
     * @returns {Object} { probability, d2, delta }
     */
    priceBinaryOption(spot, strike, timeToExpiry, volatility) {
        if (spot <= 0 || strike <= 0 || timeToExpiry <= 0 || volatility <= 0) {
            // Edge cases
            if (timeToExpiry <= 0) {
                return { probability: spot > strike ? 1.0 : 0.0, d2: 0, delta: 0 };
            }
            return { probability: 0.5, d2: 0, delta: 0 };
        }

        // Convert hours to years
        const T = timeToExpiry / (365.25 * 24);
        const sqrtT = Math.sqrt(T);

        // d2 = [ln(S/K) + (r - σ²/2) × T] / (σ × √T)
        // With r = 0 (no risk-free rate for short-term crypto)
        const d2 = (Math.log(spot / strike) - (volatility * volatility / 2) * T) / (volatility * sqrtT);

        const probability = normalCDF(d2);

        // Delta: sensitivity of probability to spot price changes
        // delta = φ(d2) / (S × σ × √T)
        const delta = normalPDF(d2) / (spot * volatility * sqrtT);

        return {
            probability: +probability.toFixed(6),
            d2: +d2.toFixed(4),
            delta: +delta.toFixed(8)
        };
    }

    /**
     * Full Black-Scholes fair value for a Gemini contract
     */
    blackScholesFairValue(asset, strike, expiryDate) {
        const spot = this.getSpotPrice(asset);
        if (!spot) return null;

        const now = Date.now();
        const expiry = expiryDate instanceof Date ? expiryDate.getTime() : expiryDate;
        const timeToExpiryHours = Math.max(0.01, (expiry - now) / (1000 * 60 * 60));

        const vol = this.calculateVolatility(asset);

        const result = this.priceBinaryOption(spot, strike, timeToExpiryHours, vol);

        return {
            model: 'BLACK_SCHOLES',
            fairValue: result.probability,
            spot,
            strike,
            timeToExpiryHours: +timeToExpiryHours.toFixed(2),
            volatility: +vol.toFixed(4),
            delta: result.delta,
            d2: result.d2
        };
    }

    // =========================================================================
    // Model 2: Kalshi Synthetic Fair Value
    // =========================================================================

    /**
     * Kalshi synthetic fair value (computed by KalshiClient)
     * This is a pass-through that wraps the result in our format
     */
    kalshiSyntheticFairValue(kalshiAnalysis) {
        if (!kalshiAnalysis || !kalshiAnalysis.matched) return null;

        return {
            model: 'KALSHI_SYNTHETIC',
            fairValue: kalshiAnalysis.kalshiFairValue,
            kalshiBidSum: kalshiAnalysis.kalshiBidSum,
            kalshiAskSum: kalshiAnalysis.kalshiAskSum,
            kalshiStrike: kalshiAnalysis.kalshiStrike,
            strikeDiff: kalshiAnalysis.strikeDiff,
            confidence: kalshiAnalysis.confidence,
            kalshiVolume: kalshiAnalysis.kalshiVolume,
            bracketCount: kalshiAnalysis.bracketCount
        };
    }

    // =========================================================================
    // Model 3: Ensemble
    // =========================================================================

    /**
     * Compute ensemble fair value from multiple models
     */
    ensembleFairValue(bsFairValue, kalshiFairValue) {
        const models = [];
        if (bsFairValue) models.push({ value: bsFairValue.fairValue, weight: this.modelWeights.blackScholes, model: bsFairValue });
        if (kalshiFairValue) models.push({ value: kalshiFairValue.fairValue, weight: this.modelWeights.kalshiSynthetic, model: kalshiFairValue });

        if (models.length === 0) return null;

        // Normalize weights
        const totalWeight = models.reduce((s, m) => s + m.weight, 0);
        const ensembleValue = models.reduce((s, m) => s + m.value * (m.weight / totalWeight), 0);

        return {
            model: 'ENSEMBLE',
            fairValue: +ensembleValue.toFixed(4),
            components: models.map(m => ({
                model: m.model.model,
                fairValue: m.model.fairValue,
                weight: +(m.weight / totalWeight).toFixed(2)
            })),
            modelCount: models.length
        };
    }

    // =========================================================================
    // Signal Generation
    // =========================================================================

    /**
     * Generate a trading signal for a Gemini contract
     * 
     * @param {Object} contract - { asset, strike, bid, ask, expiryDate, marketId, eventTitle }
     * @param {Object} kalshiAnalysis - Result from KalshiClient.analyzeGeminiContract() (optional)
     * @returns {Object} signal with direction, edge, confidence, fair values
     */
    generateSignal(contract, kalshiAnalysis = null) {
        const { asset, strike, bid, ask, expiryDate, marketId, eventTitle } = contract;

        // Compute fair values from each model
        const bsFV = expiryDate ? this.blackScholesFairValue(asset, strike, expiryDate) : null;
        const kalshiFV = this.kalshiSyntheticFairValue(kalshiAnalysis);
        const ensembleFV = this.ensembleFairValue(bsFV, kalshiFV);

        // Use ensemble if available, otherwise best single model
        const fairValue = ensembleFV || kalshiFV || bsFV;
        if (!fairValue) {
            return { actionable: false, reason: 'No fair value available' };
        }

        const fv = fairValue.fairValue;

        // Calculate edge vs executable prices
        let signal = null;
        let edge = 0;
        let entryPrice = null;

        if (ask !== null && ask !== undefined && fv > ask) {
            // Fair value says contract is worth MORE than ask → BUY YES
            signal = 'YES';
            edge = fv - ask;
            entryPrice = ask;
        } else if (bid !== null && bid !== undefined && fv < bid) {
            // Fair value says contract is worth LESS than bid → BUY NO (sell YES)
            signal = 'NO';
            edge = bid - fv;
            entryPrice = 1 - bid; // Cost of NO contract
        }

        // Calculate fees and net edge
        const feePerSide = this.feePerSide;
        const roundTripFees = entryPrice ? entryPrice * feePerSide * 2 : 0;
        const netEdge = edge - roundTripFees;

        // Determine confidence level
        let confidence = 'low';
        if (netEdge >= this.highConfidenceEdge) confidence = 'high';
        else if (netEdge >= this.minEdge) confidence = 'medium';

        const actionable = netEdge >= this.minEdge && signal !== null;

        // Calculate target price: where we expect the contract to converge
        let targetPrice = null;
        if (signal === 'YES') {
            targetPrice = Math.min(fv, 0.99); // Don't target above 0.99
        } else if (signal === 'NO') {
            targetPrice = Math.max(fv, 0.01); // Don't target below 0.01
        }

        // Calculate Kelly-optimal fraction
        const kellyFraction = actionable ? this.kellySize(edge, fv, signal) : 0;

        return {
            actionable,
            marketId,
            eventTitle,
            asset,
            strike,
            direction: signal,
            entryPrice,
            edge: +edge.toFixed(4),
            netEdge: +netEdge.toFixed(4),
            roundTripFees: +roundTripFees.toFixed(6),
            confidence,
            targetPrice: targetPrice ? +targetPrice.toFixed(4) : null,
            kellyFraction: +kellyFraction.toFixed(4),
            fairValue: fv,
            geminiBid: bid,
            geminiAsk: ask,
            models: {
                blackScholes: bsFV,
                kalshiSynthetic: kalshiFV,
                ensemble: ensembleFV
            },
            timestamp: Date.now()
        };
    }

    /**
     * Kelly criterion for binary prediction markets
     * 
     * f* = (p × b - q) / b
     * where p = estimated probability of winning
     *       q = 1 - p
     *       b = payout ratio = (1 - entryPrice) / entryPrice for YES
     * 
     * Apply fractional Kelly (0.25) for safety
     */
    kellySize(edge, fairValue, direction) {
        // Win probability estimated from fair value
        const p = direction === 'YES' ? fairValue : (1 - fairValue);
        const q = 1 - p;

        if (p <= 0 || edge <= 0) return 0;

        // Entry price = fairValue - edge (we buy below fair value)
        // For YES: entry = ask, and edge = fairValue - ask → ask = fairValue - edge
        // For NO:  entry = 1 - bid, and edge = bid - fairValue → bid = fairValue + edge
        const entryPrice = Math.max(0.01, direction === 'YES'
            ? fairValue - edge
            : (1 - fairValue) - edge);

        // Payout ratio: win $(1 - entry) for each $entry risked
        const b = (1 - entryPrice) / entryPrice;

        // Kelly: f* = (p * b - q) / b
        const kelly = b > 0 ? (p * b - q) / b : 0;

        // Fractional Kelly (25%) for safety
        return Math.max(0, Math.min(0.25, kelly * 0.25));
    }

    // =========================================================================
    // Batch Analysis
    // =========================================================================

    /**
     * Analyze all Gemini contracts and return sorted opportunities
     * 
     * @param {Array} contracts - Array of { asset, strike, bid, ask, expiryDate, marketId, eventTitle }
     * @param {Object} kalshiClient - KalshiClient instance (optional)
     * @returns {Array} Sorted signals (best edge first)
     */
    async analyzeAll(contracts, kalshiClient = null) {
        const signals = [];

        for (const contract of contracts) {
            try {
                // Get Kalshi analysis if client available
                let kalshiAnalysis = null;
                if (kalshiClient && contract.asset && contract.strike) {
                    kalshiAnalysis = await kalshiClient.analyzeGeminiContract(
                        contract.asset,
                        contract.strike,
                        contract.bid,
                        contract.ask,
                        contract.settlementHour
                    );
                }

                const signal = this.generateSignal(contract, kalshiAnalysis);
                signals.push(signal);
            } catch (e) {
                this.logger.debug(`Error analyzing ${contract.asset} ${contract.strike}: ${e.message}`);
            }
        }

        // Sort by net edge descending
        signals.sort((a, b) => (b.netEdge || 0) - (a.netEdge || 0));
        return signals;
    }

    /**
     * Get actionable signals only (filtered by minimum edge)
     */
    async getActionableSignals(contracts, kalshiClient = null) {
        const all = await this.analyzeAll(contracts, kalshiClient);
        return all.filter(s => s.actionable);
    }

    // =========================================================================
    // Utilities
    // =========================================================================

    /**
     * Parse Gemini contract label into structured data
     * "BTC > $67,500" → { asset: 'BTC', strike: 67500, direction: 'above' }
     */
    static parseContractLabel(label) {
        const match = label.match(/^(BTC|ETH|SOL)\s*>\s*\$?([\d,]+)/i);
        if (!match) return null;
        return {
            asset: match[1].toUpperCase(),
            strike: parseFloat(match[2].replace(/,/g, '')),
            direction: 'above'
        };
    }

    /**
     * Parse Gemini event title for settlement time
     * "BTC price today at 12pm EST" → 12
     * "BTC Price on February 18" → null (unknown time)
     */
    static parseSettlementHour(title) {
        const match = title.match(/(\d{1,2})\s*(am|pm)\s*EST/i);
        if (!match) return null;
        let hour = parseInt(match[1]);
        if (match[2].toLowerCase() === 'pm' && hour < 12) hour += 12;
        if (match[2].toLowerCase() === 'am' && hour === 12) hour = 0;
        return hour;
    }

    getStats() {
        return {
            trackedAssets: this.priceHistory.size,
            feePerSide: this.feePerSide,
            minEdge: this.minEdge,
            modelWeights: this.modelWeights,
            volatilities: Object.fromEntries(
                [...this.priceHistory.keys()].map(a => [a, +this.calculateVolatility(a).toFixed(4)])
            )
        };
    }
}

module.exports = FairValueEngine;
