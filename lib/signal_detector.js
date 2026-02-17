/**
 * Signal Detector for Prediction Market Trading
 * 
 * Detects trading opportunities by monitoring:
 *   1. Price velocity on Polymarket/Kalshi (leading indicators)
 *   2. Spread differential between platforms
 *   3. Cross-platform consensus  
 *   4. Gemini market staleness
 *   5. Historical category win rates
 * 
 * Outputs opportunity scores (0-100) for each matched market
 */

const { Logger } = require('./logger');

class SignalDetector {
    constructor(db, options = {}) {
        this.db = db;
        this.logger = new Logger({ component: 'SIGNALS', level: options.logLevel || 'INFO' });

        // Price history buffer: market_id -> array of { price, timestamp, platform }
        this.priceHistory = new Map();
        this.maxHistoryLength = options.maxHistoryLength || 300; // 5 min at 1/sec
        
        // Signal config (from DB parameters, with defaults)
        this.config = {
            priceVelocityThreshold: 0.01,  // 1¢ move (more sensitive for paper trading)
            velocityWindowMs: 10000,        // in 10 seconds
            spreadDiffThreshold: 0.05,      // 5¢ spread difference
            minScore: 45,                   // Lower threshold for paper trading (will be tuned by adaptive learning)
            maxGeminiVolume: 30000,         // Volume filter
            stalenessThreshold: 120,        // 2 min = stale (Gemini trades infrequently)
            takeProfitBuffer: 0.01,
            ...options.config
        };

        // Active signals (for deduplication)
        this.activeSignals = new Map();
        this.signalCooldownMs = options.signalCooldownMs || 30000; // 30s between signals for same market

        // Category win rates (updated periodically)
        this.categoryWinRates = {};
    }

    /**
     * Load adaptive parameters from database
     */
    loadParameters() {
        try {
            const params = this.db.getAllParameters();
            for (const p of params) {
                switch (p.key) {
                    case 'price_velocity_threshold':
                        this.config.priceVelocityThreshold = p.value;
                        break;
                    case 'entry_threshold':
                        this.config.minScore = p.value;
                        break;
                    case 'min_gemini_volume':
                        this.config.maxGeminiVolume = p.value;
                        break;
                }
            }
        } catch (e) {
            this.logger.warn('Failed to load parameters: ' + e.message);
        }
    }

    /**
     * Update category win rates from historical data
     */
    updateCategoryWinRates() {
        try {
            const rates = this.db.getWinRateByCategory(7); // Last 7 days
            this.categoryWinRates = {};
            for (const r of rates) {
                this.categoryWinRates[r.category] = r.win_rate;
            }
        } catch (e) {
            this.logger.debug('No category win rates yet');
        }
    }

    /**
     * Record a price update for a market/platform
     */
    recordPrice(marketId, platform, price, timestamp = Date.now()) {
        if (price === null || price === undefined || isNaN(price)) return;

        const key = `${marketId}_${platform}`;
        if (!this.priceHistory.has(key)) {
            this.priceHistory.set(key, []);
        }

        const history = this.priceHistory.get(key);
        history.push({ price, timestamp });

        // Trim old entries
        while (history.length > this.maxHistoryLength) {
            history.shift();
        }
    }

    /**
     * Calculate price velocity for a market/platform
     * Returns: price change over the time window (positive = price going up)
     */
    calculatePriceVelocity(marketId, platform, windowMs = null) {
        windowMs = windowMs || this.config.velocityWindowMs;
        const key = `${marketId}_${platform}`;
        const history = this.priceHistory.get(key);

        if (!history || history.length < 2) return { velocity: 0, magnitude: 0, dataPoints: 0 };

        const now = Date.now();
        const cutoff = now - windowMs;
        const recentPrices = history.filter(h => h.timestamp >= cutoff);

        if (recentPrices.length < 2) return { velocity: 0, magnitude: 0, dataPoints: recentPrices.length };

        const oldest = recentPrices[0];
        const newest = recentPrices[recentPrices.length - 1];
        const priceChange = newest.price - oldest.price;
        const timeSpanMs = newest.timestamp - oldest.timestamp;

        return {
            velocity: priceChange,
            magnitude: Math.abs(priceChange),
            direction: priceChange > 0 ? 'up' : priceChange < 0 ? 'down' : 'flat',
            per_second: timeSpanMs > 0 ? (priceChange / (timeSpanMs / 1000)) : 0,
            dataPoints: recentPrices.length,
            timeSpanMs
        };
    }

    /**
     * Calculate spread differential between Gemini and reference platforms
     */
    calculateSpreadDifferential(geminiState, polyState, kalshiState) {
        // Calculate Gemini spread
        const geminiSpread = (geminiState?.ask && geminiState?.bid)
            ? geminiState.ask - geminiState.bid
            : null;

        // Calculate reference spread (average of Poly/Kalshi)
        const refSpreads = [];
        if (polyState?.ask && polyState?.bid) {
            refSpreads.push(polyState.ask - polyState.bid);
        }
        if (kalshiState?.ask && kalshiState?.bid) {
            refSpreads.push(kalshiState.ask - kalshiState.bid);
        }

        const refSpread = refSpreads.length > 0
            ? refSpreads.reduce((a, b) => a + b, 0) / refSpreads.length
            : null;

        if (geminiSpread === null || refSpread === null) return 0;

        return geminiSpread - refSpread;
    }

    /**
     * Calculate reference price (average mid-price from Poly/Kalshi)
     */
    calculateReferencePrice(polyState, kalshiState) {
        const prices = [];

        if (polyState?.bid && polyState?.ask) {
            prices.push((polyState.bid + polyState.ask) / 2);
        } else if (polyState?.last) {
            prices.push(polyState.last);
        }

        if (kalshiState?.bid && kalshiState?.ask) {
            prices.push((kalshiState.bid + kalshiState.ask) / 2);
        } else if (kalshiState?.last) {
            prices.push(kalshiState.last);
        }

        if (prices.length === 0) return null;
        return prices.reduce((a, b) => a + b, 0) / prices.length;
    }

    /**
     * Calculate cross-platform consensus
     * Returns 0-1 score: 1.0 = both platforms agree on direction, 0 = disagreement
     */
    calculateConsensus(marketId, polyState, kalshiState) {
        const polyVelocity = this.calculatePriceVelocity(marketId, 'polymarket');
        const kalshiVelocity = this.calculatePriceVelocity(marketId, 'kalshi');

        if (polyVelocity.dataPoints < 2 || kalshiVelocity.dataPoints < 2) {
            // Not enough data - return moderate consensus
            return 0.5;
        }

        // Check if both platforms agree on direction
        const polyDir = polyVelocity.velocity > 0.005 ? 1 : polyVelocity.velocity < -0.005 ? -1 : 0;
        const kalshiDir = kalshiVelocity.velocity > 0.005 ? 1 : kalshiVelocity.velocity < -0.005 ? -1 : 0;

        if (polyDir === 0 && kalshiDir === 0) return 0.5; // Both flat
        if (polyDir === kalshiDir) return 1.0; // Agreement
        if (polyDir === 0 || kalshiDir === 0) return 0.7; // One moving, one flat
        return 0.0; // Disagreement
    }

    /**
     * Calculate Gemini market staleness
     * Returns seconds since last trade on Gemini
     */
    calculateStaleness(geminiState) {
        if (!geminiState?.last_trade_time) return 300; // Default to 5 min if unknown
        return Math.floor((Date.now() - geminiState.last_trade_time) / 1000);
    }

    /**
     * Score a single component (0-max_points)
     */
    scoreComponent(value, threshold, maxPoints, invert = false) {
        if (value === null || value === undefined) return 0;
        const normalized = invert
            ? Math.max(0, 1 - value / threshold)
            : Math.min(1, value / threshold);
        return Math.max(0, normalized * maxPoints);
    }

    /**
     * Generate opportunity score for a market (0-100)
     * 
     * Components:
     *   - Price velocity magnitude: 20 points
     *   - Spread differential: 20 points  
     *   - Cross-platform consensus: 25 points
     *   - Gemini staleness: 15 points
     *   - Historical category win rate: 20 points
     */
    scoreOpportunity(marketId, category, geminiState, polyState, kalshiState) {
        // Component 1: Price velocity (20 points)
        const polyVelocity = this.calculatePriceVelocity(marketId, 'polymarket');
        const kalshiVelocity = this.calculatePriceVelocity(marketId, 'kalshi');
        const maxVelocity = Math.max(polyVelocity.magnitude, kalshiVelocity.magnitude);
        const velocityScore = this.scoreComponent(maxVelocity, this.config.priceVelocityThreshold, 20);

        // Component 2: Spread differential (20 points)
        const spreadDiff = this.calculateSpreadDifferential(geminiState, polyState, kalshiState);
        const spreadScore = this.scoreComponent(spreadDiff, this.config.spreadDiffThreshold, 20);

        // Component 3: Cross-platform consensus (25 points)
        const consensus = this.calculateConsensus(marketId, polyState, kalshiState);
        const consensusScore = consensus * 25;

        // Component 4: Gemini staleness (15 points)
        const staleness = this.calculateStaleness(geminiState);
        const stalenessScore = this.scoreComponent(
            staleness, this.config.stalenessThreshold, 15
        );

        // Component 5: Category win rate (20 points)
        const catWinRate = this.categoryWinRates[category] || 0.5;
        const winRateScore = catWinRate * 20;

        // Total
        const totalScore = Math.min(100, velocityScore + spreadScore + consensusScore + stalenessScore + winRateScore);

        return {
            total: parseFloat(totalScore.toFixed(1)),
            components: {
                velocity: parseFloat(velocityScore.toFixed(1)),
                spread: parseFloat(spreadScore.toFixed(1)),
                consensus: parseFloat(consensusScore.toFixed(1)),
                staleness: parseFloat(stalenessScore.toFixed(1)),
                win_rate: parseFloat(winRateScore.toFixed(1))
            },
            details: {
                max_velocity: maxVelocity,
                poly_velocity: polyVelocity.velocity,
                kalshi_velocity: kalshiVelocity.velocity,
                spread_differential: spreadDiff,
                consensus_score: consensus,
                staleness_seconds: staleness,
                category_win_rate: catWinRate
            }
        };
    }

    /**
     * Determine trade direction based on leading indicators
     */
    determineDirection(marketId, polyState, kalshiState) {
        const polyVelocity = this.calculatePriceVelocity(marketId, 'polymarket');
        const kalshiVelocity = this.calculatePriceVelocity(marketId, 'kalshi');

        // Weight by data quality
        const polyWeight = polyVelocity.dataPoints >= 3 ? 0.6 : 0.3;
        const kalshiWeight = kalshiVelocity.dataPoints >= 3 ? 0.4 : 0.2;

        const weightedVelocity = polyVelocity.velocity * polyWeight + kalshiVelocity.velocity * kalshiWeight;

        if (weightedVelocity > 0.002) return 'YES';  // Price going up → buy YES
        if (weightedVelocity < -0.002) return 'NO';   // Price going down → buy NO

        // Fallback: if reference price exists but no clear velocity, use price level
        const refPrice = this.calculateReferencePrice(polyState, kalshiState);
        if (refPrice !== null) {
            if (refPrice > 0.55) return 'YES';  // Leaning YES → ride momentum
            if (refPrice < 0.45) return 'NO';   // Leaning NO → ride momentum
        }

        return null; // No clear direction
    }

    /**
     * Calculate target price (where we expect Gemini to converge)
     */
    calculateTargetPrice(polyState, kalshiState, direction, config = {}) {
        const referencePrice = this.calculateReferencePrice(polyState, kalshiState);
        if (referencePrice === null) return null;

        const buffer = config.take_profit_buffer || this.config.takeProfitBuffer || 0.01;

        if (direction === 'YES') {
            return referencePrice - buffer; // Exit just below reference
        } else {
            return referencePrice + buffer; // Exit just above reference
        }
    }

    /**
     * Process all matched markets and generate signals
     * Returns array of actionable signals sorted by score
     */
    processMarkets(marketStates) {
        const signals = [];
        const now = Date.now();

        for (const state of marketStates) {
            const { marketId, category, gemini, polymarket, kalshi, matchedMarket } = state;

            // Volume filter
            if (gemini?.volume && gemini.volume > this.config.maxGeminiVolume) {
                continue;
            }

            // Record price updates
            if (polymarket?.last) this.recordPrice(marketId, 'polymarket', polymarket.last);
            if (polymarket?.bid) this.recordPrice(marketId, 'polymarket_bid', polymarket.bid);
            if (kalshi?.last) this.recordPrice(marketId, 'kalshi', kalshi.last);
            if (kalshi?.bid) this.recordPrice(marketId, 'kalshi_bid', kalshi.bid);
            if (gemini?.last) this.recordPrice(marketId, 'gemini', gemini.last);

            // Score opportunity
            const score = this.scoreOpportunity(marketId, category, gemini, polymarket, kalshi);

            // Check cooldown
            const lastSignalTime = this.activeSignals.get(marketId) || 0;
            const onCooldown = (now - lastSignalTime) < this.signalCooldownMs;

            // Check if actionable
            const direction = this.determineDirection(marketId, polymarket, kalshi);
            const referencePrice = this.calculateReferencePrice(polymarket, kalshi);

            const signal = {
                marketId,
                title: matchedMarket?.event_title || gemini?.title || 'Unknown',
                category,
                score: score.total,
                components: score.components,
                details: score.details,
                direction,
                referencePrice,
                gemini_bid: gemini?.bid,
                gemini_ask: gemini?.ask,
                gemini_last: gemini?.last,
                gemini_volume: gemini?.volume,
                polymarket_bid: polymarket?.bid,
                polymarket_ask: polymarket?.ask,
                kalshi_bid: kalshi?.bid,
                kalshi_ask: kalshi?.ask,
                actionable: score.total >= this.config.minScore && direction !== null && !onCooldown,
                on_cooldown: onCooldown,
                timestamp: now
            };

            // Calculate target price if actionable
            if (signal.actionable) {
                signal.targetPrice = this.calculateTargetPrice(polymarket, kalshi, direction);
            }

            signals.push(signal);

            // Log signal to database
            try {
                this.db.insertSignal({
                    timestamp: Math.floor(now / 1000),
                    gemini_market_id: marketId,
                    signal_type: 'composite',
                    opportunity_score: score.total,
                    price_velocity: score.details.max_velocity,
                    spread_differential: score.details.spread_differential,
                    cross_platform_consensus: score.details.consensus_score,
                    gemini_staleness: score.details.staleness_seconds,
                    category_win_rate: score.details.category_win_rate,
                    polymarket_price: referencePrice,
                    kalshi_price: kalshi?.last,
                    gemini_price: gemini?.last,
                    triggered_trade: signal.actionable
                });
            } catch (e) {
                // Don't fail on logging errors
            }

            if (signal.actionable) {
                this.activeSignals.set(marketId, now);
                this.logger.info(
                    `SIGNAL: ${signal.direction} on "${signal.title}" ` +
                    `Score=${signal.score} Ref=${referencePrice?.toFixed(2)} ` +
                    `Gemini=${gemini?.last?.toFixed(2)} Target=${signal.targetPrice?.toFixed(2)}`
                );
            }
        }

        // Sort by score descending
        signals.sort((a, b) => b.score - a.score);

        return signals;
    }

    /**
     * Get only actionable signals
     */
    getActionableSignals(marketStates) {
        return this.processMarkets(marketStates).filter(s => s.actionable);
    }

    /**
     * Get top N signals (for dashboard)
     */
    getTopSignals(marketStates, n = 20) {
        return this.processMarkets(marketStates).slice(0, n);
    }

    /**
     * Cleanup old price history entries
     */
    cleanup(maxAgeMs = 600000) { // 10 min default
        const cutoff = Date.now() - maxAgeMs;
        for (const [key, history] of this.priceHistory.entries()) {
            const filtered = history.filter(h => h.timestamp >= cutoff);
            if (filtered.length === 0) {
                this.priceHistory.delete(key);
            } else {
                this.priceHistory.set(key, filtered);
            }
        }
    }

    getStats() {
        return {
            tracked_markets: this.priceHistory.size,
            active_signals: this.activeSignals.size,
            config: { ...this.config }
        };
    }
}

module.exports = SignalDetector;
