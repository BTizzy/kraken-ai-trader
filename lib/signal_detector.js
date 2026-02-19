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
const FairValueEngine = require('./fair_value_engine');

class SignalDetector {
    constructor(db, options = {}) {
        this.db = db;
        this.logger = new Logger({ component: 'SIGNALS', level: options.logLevel || 'INFO' });

        // Price history buffer: market_id -> array of { price, timestamp, platform }
        this.priceHistory = new Map();
        this.maxHistoryLength = options.maxHistoryLength || 300; // 5 min at 1/sec
        
        // Fair value engine for model-based pricing
        this.fairValueEngine = new FairValueEngine({
            logLevel: options.logLevel,
            feePerSide: options.feePerSide || 0.0001,
            minEdge: options.minEdge || 0.03,
            highConfidenceEdge: options.highConfidenceEdge || 0.08
        });
        
        // Kalshi client reference (set externally if available)
        this.kalshiClient = options.kalshiClient || null;
        
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
     *   - Price velocity magnitude: 15 points
     *   - Spread differential: 15 points
     *   - Cross-platform consensus: 25 points
     *   - Gemini staleness: 15 points
     *   - Historical category win rate: 15 points
     *   - Liquidity quality: 15 points
     */
    scoreOpportunity(marketId, category, geminiState, polyState, kalshiState) {
        // Component 1: Price velocity (15 points)
        const polyVelocity = this.calculatePriceVelocity(marketId, 'polymarket');
        const kalshiVelocity = this.calculatePriceVelocity(marketId, 'kalshi');
        const maxVelocity = Math.max(polyVelocity.magnitude, kalshiVelocity.magnitude);
        const velocityScore = this.scoreComponent(maxVelocity, this.config.priceVelocityThreshold, 15);

        // Component 2: Spread differential (15 points)
        const spreadDiff = this.calculateSpreadDifferential(geminiState, polyState, kalshiState);
        const spreadScore = this.scoreComponent(spreadDiff, this.config.spreadDiffThreshold, 15);

        // Component 3: Cross-platform consensus (25 points)
        const consensus = this.calculateConsensus(marketId, polyState, kalshiState);
        const consensusScore = consensus * 25;

        // Component 4: Gemini staleness (15 points)
        const staleness = this.calculateStaleness(geminiState);
        const stalenessScore = this.scoreComponent(
            staleness, this.config.stalenessThreshold, 15
        );

        // Component 5: Category win rate (15 points)
        const catWinRate = this.categoryWinRates[category] || 0.5;
        const winRateScore = catWinRate * 15;

        // Component 6: Liquidity quality (15 points)
        // Two-sided book: 5pts, tight spread (<5c): 5pts, adequate depth (>$100): 5pts
        let liquidityScore = 0;
        const hasTwoSided = geminiState?.bid != null && geminiState?.ask != null;
        if (hasTwoSided) {
            liquidityScore += 5;
            const gSpread = (geminiState.ask || 0) - (geminiState.bid || 0);
            if (gSpread > 0 && gSpread < 0.05) liquidityScore += 5;
            else if (gSpread > 0 && gSpread < 0.10) liquidityScore += 2;
        }
        const depth = geminiState?.ask_depth || geminiState?.bid_depth || 0;
        if (depth >= 100) liquidityScore += 5;
        else if (depth >= 50) liquidityScore += 2;

        // Total
        const totalScore = Math.min(100, velocityScore + spreadScore + consensusScore + stalenessScore + winRateScore + liquidityScore);

        return {
            total: parseFloat(totalScore.toFixed(1)),
            components: {
                velocity: parseFloat(velocityScore.toFixed(1)),
                spread: parseFloat(spreadScore.toFixed(1)),
                consensus: parseFloat(consensusScore.toFixed(1)),
                staleness: parseFloat(stalenessScore.toFixed(1)),
                win_rate: parseFloat(winRateScore.toFixed(1)),
                liquidity: parseFloat(liquidityScore.toFixed(1))
            },
            details: {
                max_velocity: maxVelocity,
                poly_velocity: polyVelocity.velocity,
                kalshi_velocity: kalshiVelocity.velocity,
                spread_differential: spreadDiff,
                consensus_score: consensus,
                staleness_seconds: staleness,
                category_win_rate: catWinRate,
                has_two_sided_book: hasTwoSided,
                gemini_spread: hasTwoSided ? (geminiState.ask - geminiState.bid) : null
            }
        };
    }

    /**
     * Determine trade direction based on cross-platform price discrepancy.
     * PRIMARY: Gemini vs reference (Poly/Kalshi + additional sources) spread — arb direction.
     * SECONDARY: Price velocity on reference platforms.
     * The old price-level fallback (< 0.45 → NO) is removed: it caused the
     * bot to blindly short every low-probability market regardless of whether
     * Gemini was actually overpriced, producing consistent losses.
     */
    determineDirection(marketId, polyState, kalshiState, geminiState, additionalRefs = {}) {
        const baseRefPrice = this.calculateReferencePrice(polyState, kalshiState);

        // Enhance reference with additional sources (Metaculus, Odds API)
        const extraPrices = Object.values(additionalRefs).filter(v => v != null && !isNaN(v));
        let refPrice = baseRefPrice;
        if (extraPrices.length > 0) {
            const allPrices = refPrice != null ? [refPrice, ...extraPrices] : extraPrices;
            refPrice = allPrices.reduce((a, b) => a + b, 0) / allPrices.length;
        }

        // PRIMARY: Gemini vs reference — true arbitrage signal
        const geminiMid = geminiState?.last ?? geminiState?.bid ?? null;
        if (geminiMid !== null && refPrice !== null) {
            const edge = geminiMid - refPrice;
            if (edge > 0.015) return 'NO';   // Gemini overpriced vs poly/kalshi → sell Gemini (NO)
            if (edge < -0.015) return 'YES'; // Gemini underpriced vs poly/kalshi → buy Gemini (YES)
        }

        // SECONDARY: velocity on reference platforms
        const polyVelocity = this.calculatePriceVelocity(marketId, 'polymarket');
        const kalshiVelocity = this.calculatePriceVelocity(marketId, 'kalshi');
        const polyWeight = polyVelocity.dataPoints >= 3 ? 0.6 : 0.3;
        const kalshiWeight = kalshiVelocity.dataPoints >= 3 ? 0.4 : 0.2;
        const weightedVelocity = polyVelocity.velocity * polyWeight + kalshiVelocity.velocity * kalshiWeight;

        if (weightedVelocity > 0.002) return 'YES';
        if (weightedVelocity < -0.002) return 'NO';

        return null; // No clear direction — don't trade
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

            // Build additional reference sources from state
            const additionalRefs = {};
            if (state.metaculus?.probability != null) additionalRefs.metaculus = state.metaculus.probability;
            if (state.oddsApi?.probability != null) additionalRefs.oddsApi = state.oddsApi.probability;

            // Check if actionable
            const direction = this.determineDirection(marketId, polymarket, kalshi, gemini, additionalRefs);
            const baseRefPrice = this.calculateReferencePrice(polymarket, kalshi);

            // Enhance reference price with additional sources for signal output
            const extraPrices = Object.values(additionalRefs).filter(v => v != null && !isNaN(v));
            let referencePrice = baseRefPrice;
            if (extraPrices.length > 0) {
                const allPrices = referencePrice != null ? [referencePrice, ...extraPrices] : extraPrices;
                referencePrice = allPrices.reduce((a, b) => a + b, 0) / allPrices.length;
            }

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
            momentum_alerts: this.momentumAlerts?.length || 0,
            config: { ...this.config },
            fairValueEngine: this.fairValueEngine.getStats()
        };
    }

    // =========================================================================
    // Event-Driven Momentum Detection
    // =========================================================================

    /**
     * Detect spot-price momentum events and check if prediction contracts
     * have repriced accordingly. Generates urgency signals when contracts
     * lag behind sharp spot moves.
     * 
     * @param {string} asset - e.g., 'BTC'
     * @param {number} spotPrice - Current spot price from Kraken
     * @param {Object} contractState - { bid, ask, last, marketId, delta }
     * @param {Object} [options]
     * @param {number} [options.spotThreshold=100] - Min $ move to trigger (BTC default $100)
     * @param {number} [options.windowMs=300000] - Lookback window (5 min default)
     * @param {number} [options.minContractLag=0.02] - Min ¢ the contract must lag to signal
     * @returns {Object|null} Momentum signal or null
     */
    detectMomentum(asset, spotPrice, contractState, options = {}) {
        const {
            spotThreshold = asset === 'ETH' ? 50 : asset === 'SOL' ? 5 : 100,
            windowMs = 300000,        // 5 min
            minContractLag = 0.02     // 2¢ lag
        } = options;

        // Get spot price history from fair value engine
        const spotHistory = this.fairValueEngine.priceHistory.get(asset);
        if (!spotHistory || spotHistory.length < 3) return null;

        const now = Date.now();
        const cutoff = now - windowMs;
        const recentSpot = spotHistory.filter(h => h.timestamp >= cutoff);
        if (recentSpot.length < 2) return null;

        const oldestSpot = recentSpot[0].price;
        const newestSpot = recentSpot[recentSpot.length - 1].price;
        const spotDelta = newestSpot - oldestSpot;
        const spotDeltaPct = spotDelta / oldestSpot;

        // Check if spot move exceeds threshold
        if (Math.abs(spotDelta) < spotThreshold) return null;

        // Determine expected contract repricing using delta from FairValueEngine
        // delta ≈ ∂P/∂S from Black-Scholes
        const delta = contractState.delta || 0;
        const expectedContractMove = Math.abs(spotDelta * delta);

        // Get contract mid-price change over same window
        const contractKey = `${contractState.marketId}_gemini`;
        const contractHistory = this.priceHistory.get(contractKey);
        let actualContractMove = 0;

        if (contractHistory && contractHistory.length >= 2) {
            const recentContract = contractHistory.filter(h => h.timestamp >= cutoff);
            if (recentContract.length >= 2) {
                const oldContract = recentContract[0].price;
                const newContract = recentContract[recentContract.length - 1].price;
                actualContractMove = Math.abs(newContract - oldContract);
            }
        }

        // Calculate lag: how much the contract has under-repriced
        const contractLag = expectedContractMove - actualContractMove;

        if (contractLag < minContractLag) return null;

        const direction = spotDelta > 0 ? 'YES' : 'NO';
        const urgency = Math.min(1.0, contractLag / 0.05); // Normalize to 0-1, capped at 5¢ lag

        const momentum = {
            type: 'MOMENTUM',
            asset,
            marketId: contractState.marketId,
            direction,
            spotDelta: +spotDelta.toFixed(2),
            spotDeltaPct: +(spotDeltaPct * 100).toFixed(3),
            expectedContractMove: +expectedContractMove.toFixed(4),
            actualContractMove: +actualContractMove.toFixed(4),
            contractLag: +contractLag.toFixed(4),
            urgency: +urgency.toFixed(2),
            windowMs,
            contractBid: contractState.bid,
            contractAsk: contractState.ask,
            timestamp: now
        };

        this.logger.info(
            `MOMENTUM: ${asset} ${spotDelta > 0 ? '+' : ''}$${spotDelta.toFixed(0)} in ${(windowMs/1000).toFixed(0)}s → ` +
            `expected Δcontract=${expectedContractMove.toFixed(3)}, actual=${actualContractMove.toFixed(3)}, ` +
            `lag=${contractLag.toFixed(3)} → ${direction} urgency=${urgency.toFixed(2)}`
        );

        // Store alert
        if (!this.momentumAlerts) this.momentumAlerts = [];
        this.momentumAlerts.push(momentum);
        while (this.momentumAlerts.length > 50) this.momentumAlerts.shift();

        return momentum;
    }

    /**
     * Boost an existing opportunity score with momentum urgency
     * @param {Object} signal - Existing signal from processMarkets or generateFairValueSignals
     * @param {Object} momentum - Result from detectMomentum
     * @returns {Object} Boosted signal
     */
    applyMomentumBoost(signal, momentum) {
        if (!momentum || !signal) return signal;

        // Momentum can boost score by up to 15 points
        const boost = momentum.urgency * 15;
        const boostedScore = Math.min(100, (signal.score || 0) + boost);

        return {
            ...signal,
            score: +boostedScore.toFixed(1),
            momentum: {
                boost: +boost.toFixed(1),
                urgency: momentum.urgency,
                spotDelta: momentum.spotDelta,
                contractLag: momentum.contractLag
            }
        };
    }

    // =========================================================================
    // Multi-Leg Synthetic Arbitrage Detection
    // =========================================================================

    /**
     * Detect within-platform arb: YES + NO < $1.00 on Gemini
     * This is pure profit if both sides can be bought for under $1 combined.
     * 
     * @param {Object} yesState - { bid, ask, marketId } for YES contract
     * @param {Object} noState - { bid, ask, marketId } for NO contract (or derived from YES)
     * @returns {Object|null} Arb opportunity or null
     */
    detectIntraPlatformArb(yesState, noState) {
        if (!yesState?.ask || !noState?.ask) return null;

        const totalCost = yesState.ask + noState.ask;
        const profit = 1.0 - totalCost;

        // Account for round-trip fees (buy both sides)
        const fees = (yesState.ask + noState.ask) * this.fairValueEngine.feePerSide;
        const netProfit = profit - fees;

        if (netProfit <= 0) return null;

        return {
            type: 'INTRA_PLATFORM_ARB',
            yesMarketId: yesState.marketId,
            noMarketId: noState.marketId,
            yesAsk: yesState.ask,
            noAsk: noState.ask,
            totalCost: +totalCost.toFixed(4),
            grossProfit: +profit.toFixed(4),
            fees: +fees.toFixed(4),
            netProfit: +netProfit.toFixed(4),
            returnPct: +((netProfit / totalCost) * 100).toFixed(2),
            timestamp: Date.now()
        };
    }

    /**
     * Detect cross-platform arb: Gemini YES + Kalshi synthetic NO < $1.00
     * Buy YES on Gemini when Kalshi implies the event is less likely than Gemini's ask.
     * 
     * @param {Object} geminiState - { bid, ask, marketId }
     * @param {Object} kalshiAnalysis - From KalshiClient.analyzeGeminiContract()
     * @returns {Object|null} Cross-platform arb opportunity or null
     */
    detectCrossPlatformArb(geminiState, kalshiAnalysis) {
        if (!geminiState?.ask || !kalshiAnalysis?.matched) return null;

        const geminiYesAsk = geminiState.ask;
        const kalshiSyntheticYes = kalshiAnalysis.kalshiFairValue;

        if (kalshiSyntheticYes === null || kalshiSyntheticYes === undefined) return null;

        // Arb 1: Gemini YES is cheap relative to Kalshi fair value
        // Buy Gemini YES at ask, Kalshi implies it should be worth more
        const yesEdge = kalshiSyntheticYes - geminiYesAsk;

        // Arb 2: Gemini NO is cheap (i.e., Gemini YES bid is high)
        // Sell Gemini YES at bid if Kalshi implies contract is worth less
        const geminiBid = geminiState.bid;
        const noEdge = geminiBid ? geminiBid - kalshiSyntheticYes : 0;

        // Synthetic arb: can we buy YES on one side and NO on the other for < $1?
        const kalshiSyntheticNo = 1 - kalshiSyntheticYes;
        const syntheticCost = geminiYesAsk + kalshiSyntheticNo;
        const syntheticArb = 1.0 - syntheticCost;

        const fees = geminiYesAsk * this.fairValueEngine.feePerSide * 2; // Gemini fees only
        const bestEdge = Math.max(yesEdge, noEdge, syntheticArb) - fees;

        if (bestEdge <= 0.005) return null; // Need >0.5¢ net edge

        let direction, edge;
        if (yesEdge >= noEdge && yesEdge >= syntheticArb) {
            direction = 'BUY_GEMINI_YES';
            edge = yesEdge;
        } else if (noEdge >= syntheticArb) {
            direction = 'SELL_GEMINI_YES';
            edge = noEdge;
        } else {
            direction = 'SYNTHETIC_ARB';
            edge = syntheticArb;
        }

        return {
            type: 'CROSS_PLATFORM_ARB',
            direction,
            geminiMarketId: geminiState.marketId,
            geminiYesAsk,
            geminiBid,
            kalshiFairValue: kalshiSyntheticYes,
            kalshiEvent: kalshiAnalysis.kalshiEvent,
            edge: +edge.toFixed(4),
            fees: +fees.toFixed(4),
            netEdge: +(edge - fees).toFixed(4),
            confidence: kalshiAnalysis.confidence,
            kalshiVolume: kalshiAnalysis.kalshiVolume,
            timestamp: Date.now()
        };
    }

    /**
     * Scan all matched contracts for arb opportunities
     * @param {Array} matchedStates - Array of { gemini, kalshiAnalysis, marketId }
     * @returns {Array} Arb opportunities sorted by net edge
     */
    scanArbitrage(matchedStates) {
        const arbs = [];
        for (const state of matchedStates) {
            // Cross-platform arb
            if (state.gemini && state.kalshiAnalysis) {
                const arb = this.detectCrossPlatformArb(state.gemini, state.kalshiAnalysis);
                if (arb) arbs.push(arb);
            }
            // Intra-platform: check if YES+NO < $1 on Gemini
            if (state.geminiYes && state.geminiNo) {
                const arb = this.detectIntraPlatformArb(state.geminiYes, state.geminiNo);
                if (arb) arbs.push(arb);
            }
        }
        arbs.sort((a, b) => (b.netEdge || b.netProfit || 0) - (a.netEdge || a.netProfit || 0));
        return arbs;
    }

    // =========================================================================
    // Fair-Value Based Signal Generation (new strategy layer)
    // =========================================================================

    /**
     * Record a spot price for fair-value calculations
     */
    recordSpotPrice(asset, price, timestamp) {
        this.fairValueEngine.recordSpotPrice(asset, price, timestamp);
    }

    /**
     * Set the Kalshi client for cross-platform analysis
     */
    setKalshiClient(client) {
        this.kalshiClient = client;
    }

    /**
     * Generate fair-value based signals for Gemini contracts
     * 
     * This is the NEW strategy layer that uses:
     *   - Black-Scholes binary option pricing from spot prices
     *   - Kalshi synthetic "above" fair values from bracket sums
     *   - Ensemble weighting of both models
     * 
     * @param {Array} geminiContracts - Parsed Gemini contracts
     *   Each: { asset, strike, bid, ask, expiryDate, marketId, eventTitle, settlementHour }
     * @returns {Array} Actionable signals sorted by edge
     */
    async generateFairValueSignals(geminiContracts, extrasLookup = null) {
        const signals = await this.fairValueEngine.analyzeAll(
            geminiContracts,
            this.kalshiClient,
            extrasLookup
        );

        // Filter to actionable, apply cooldown
        const now = Date.now();
        const actionable = [];
        
        for (const signal of signals) {
            if (!signal.actionable) continue;

            // Check cooldown
            const lastSignalTime = this.activeSignals.get(signal.marketId) || 0;
            if ((now - lastSignalTime) < this.signalCooldownMs) continue;

            // Log signal to database
            try {
                this.db.insertSignal({
                    timestamp: Math.floor(now / 1000),
                    gemini_market_id: signal.marketId,
                    signal_type: 'fair_value',
                    opportunity_score: Math.min(100, Math.round(signal.netEdge * 1000)),
                    price_velocity: 0,
                    spread_differential: signal.edge,
                    cross_platform_consensus: signal.confidence === 'high' ? 1.0 : signal.confidence === 'medium' ? 0.7 : 0.3,
                    gemini_staleness: 0,
                    category_win_rate: 0.5,
                    polymarket_price: signal.fairValue,
                    kalshi_price: signal.models?.kalshiSynthetic?.fairValue || null,
                    gemini_price: signal.entryPrice,
                    triggered_trade: true
                });
            } catch (e) {
                // Don't fail on logging errors
            }

            this.activeSignals.set(signal.marketId, now);
            this.logger.info(
                `FAIR_VALUE_SIGNAL: ${signal.direction} "${signal.eventTitle}" ` +
                `${signal.asset} $${signal.strike} edge=${signal.netEdge.toFixed(3)} ` +
                `FV=${signal.fairValue.toFixed(3)} entry=${signal.entryPrice?.toFixed(3)} ` +
                `confidence=${signal.confidence}`
            );

            // Convert to format expected by paper_trading_engine
            actionable.push({
                marketId: signal.marketId,
                title: signal.eventTitle || `${signal.asset} > $${signal.strike}`,
                category: 'crypto',
                score: Math.min(100, Math.round(signal.netEdge * 1000)),
                direction: signal.direction,
                referencePrice: signal.fairValue,
                targetPrice: signal.targetPrice,
                gemini_bid: signal.geminiBid,
                gemini_ask: signal.geminiAsk,
                gemini_last: null,
                edge: signal.edge,
                netEdge: signal.netEdge,
                confidence: signal.confidence,
                kellyFraction: signal.kellyFraction,
                models: signal.models,
                actionable: true,
                timestamp: now
            });
        }

        return actionable;
    }
}

module.exports = SignalDetector;
