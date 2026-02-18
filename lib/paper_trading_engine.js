/**
 * Prediction Market Trading Engine
 * 
 * Core paper trading logic:
 *   - Position entry based on signal detector scores
 *   - Position management (TP/SL/time-based exits)
 *   - Paper wallet tracking
 *   - Kelly criterion position sizing
 *   - Adaptive parameter learning
 */

const { Logger } = require('./logger');

class PaperTradingEngine {
    constructor(db, geminiClient, options = {}) {
        this.db = db;
        this.gemini = geminiClient;
        this.logger = new Logger({ component: 'TRADER', level: options.logLevel || 'INFO' });

        // Load parameters from DB
        this.params = this.loadParams();

        // Runtime state
        this.isRunning = false;
        this.lastLearningCycle = 0;
        this.learningInterval = options.learningInterval || 30000; // 30 seconds
        this.tradeCount = 0;
    }

    /**
     * Load trading parameters from database
     */
    loadParams() {
        const defaults = {
            entry_threshold: 45,
            price_velocity_threshold: 0.03,
            take_profit_buffer: 0.01,
            stop_loss_width: 0.03,
            max_hold_time: 600,
            kelly_multiplier: 0.25,
            max_concurrent_positions: 5,
            max_position_size: 100,
            max_capital_at_risk_pct: 50,
            slippage_penalty: 0.005,
            daily_loss_limit: -50,
            // Fee model: Gemini Predictions fee structure
            // 0.05% flat + 0.01% maker = ~0.06% per side
            // Cheapest prediction market (Polymarket 2% taker, Kalshi ~1.2%, PredictIt 10%)
            fee_per_side: 0.0006
        };

        try {
            const dbParams = this.db.getAllParameters();
            const params = { ...defaults };
            for (const p of dbParams) {
                if (params.hasOwnProperty(p.key)) {
                    params[p.key] = p.value;
                }
            }
            return params;
        } catch (e) {
            return defaults;
        }
    }

    /**
     * Calculate position size using Kelly Criterion adapted for prediction markets
     * 
     * Kelly formula for binary outcomes:
     *   f* = (p * b - q) / b
     *   where p = win probability, q = 1-p, b = odds (payout ratio)
     *   
     * For prediction markets:
     *   edge = expected price convergence (target - entry) / entry cost
     *   kelly = edge * kelly_multiplier (conservative fractional Kelly)
     */
    calculatePositionSize(signal, wallet) {
        const entryPrice = signal.direction === 'YES' ? signal.gemini_ask : signal.gemini_bid;
        const targetPrice = signal.targetPrice;
        const referencePrice = signal.referencePrice;

        if (!entryPrice || !wallet) {
            return this.params.max_position_size * 0.1; // Minimum size
        }

        // If signal has pre-computed Kelly fraction (from FairValueEngine), use it directly
        if (signal.kellyFraction && signal.kellyFraction > 0) {
            let positionSize = wallet.balance * signal.kellyFraction;
            positionSize = Math.min(positionSize, this.params.max_position_size);
            positionSize = Math.min(positionSize, wallet.balance * this.params.max_capital_at_risk_pct / 100);
            // Depth cap: max 10% of real ask depth
            const askDepth0 = signal.gemini_ask_depth || signal.ask_depth || null;
            if (askDepth0 && askDepth0 > 0) {
                positionSize = Math.min(positionSize, askDepth0 * 0.10);
            }
            positionSize = Math.max(positionSize, 5); // Minimum $5
            return parseFloat(positionSize.toFixed(2));
        }

        // Expected edge = price gap between Gemini and reference (fair value or Polymarket) price
        let edge;
        if (signal.netEdge && signal.netEdge > 0) {
            // Use pre-computed net edge from FairValueEngine (after fees)
            edge = signal.netEdge;
        } else if (signal.direction === 'YES') {
            // Buying YES: our edge is referencePrice - entryPrice (Gemini is below fair value)
            edge = referencePrice ? (referencePrice - entryPrice) : 0;
        } else {
            // Selling YES (buying NO): our edge is entryPrice - referencePrice (Gemini is above fair value)
            edge = referencePrice ? (entryPrice - referencePrice) : 0;
        }

        // If no edge from price gap, use score-based sizing as fallback
        if (edge <= 0) {
            // Score-based sizing: higher score → bigger position
            const scoreFraction = Math.max(0, (signal.score - 40)) / 60; // 0 to 1 for scores 40-100
            const baseSize = wallet.balance * 0.02 * scoreFraction * this.params.kelly_multiplier;
            return Math.max(5, Math.min(baseSize, this.params.max_position_size));
        }

        // Kelly calculation with edge
        const winProb = Math.min(0.8, 0.5 + signal.score / 200);
        const payout = edge / Math.max(0.01, entryPrice);
        const edgeRatio = (winProb * payout - (1 - winProb) * this.params.stop_loss_width) / Math.max(0.01, payout);
        const kelly = Math.max(0, edgeRatio) * this.params.kelly_multiplier;

        let positionSize = wallet.balance * kelly;

        // Apply limits
        positionSize = Math.min(positionSize, this.params.max_position_size);
        positionSize = Math.min(positionSize, wallet.balance * this.params.max_capital_at_risk_pct / 100);

        // Depth-based cap: never exceed 10% of real ask depth (prevents moving Gemini's thin book)
        // signal.gemini_ask_depth is populated from real orderbook depth (USD) when useRealPrices=true
        const askDepth = signal.gemini_ask_depth || signal.ask_depth || null;
        if (askDepth && askDepth > 0) {
            const depthCap = askDepth * 0.10;
            if (positionSize > depthCap) {
                this.logger.debug(`Depth cap: $${positionSize.toFixed(2)} → $${depthCap.toFixed(2)} (ask_depth=$${askDepth.toFixed(0)})`);
                positionSize = depthCap;
            }
        }

        positionSize = Math.max(positionSize, 5); // Minimum $5

        return parseFloat(positionSize.toFixed(2));
    }

    /**
     * Check if we can enter a new position
     */
    canEnterPosition(signal) {
        // Check open positions
        const openTrades = this.db.getOpenTrades();
        if (openTrades.length >= this.params.max_concurrent_positions) {
            return { allowed: false, reason: 'Max concurrent positions reached' };
        }

        // Check category concentration (max 2 per category)
        const categoryCount = openTrades.filter(t => t.category === signal.category).length;
        if (categoryCount >= 2) {
            return { allowed: false, reason: `Max 2 positions in ${signal.category} reached` };
        }

        // Check daily loss limit
        const dailyPnL = this.db.getDailyPnL();
        if (dailyPnL && dailyPnL.daily_pnl < this.params.daily_loss_limit) {
            return { allowed: false, reason: `Daily loss limit hit: $${dailyPnL.daily_pnl.toFixed(2)}` };
        }

        // Check capital at risk
        const wallet = this.db.getWallet();
        const totalAtRisk = openTrades.reduce((sum, t) => sum + t.position_size, 0);
        if (totalAtRisk / wallet.balance > this.params.max_capital_at_risk_pct / 100) {
            return { allowed: false, reason: 'Max capital at risk exceeded' };
        }

        // Check drawdown kill switch (wallet below $400 / -20%)
        if (wallet.balance < wallet.initial_balance * 0.8) {
            return { allowed: false, reason: 'Drawdown kill switch: balance below 80% of initial' };
        }

        // Check for duplicate market
        const alreadyInMarket = openTrades.find(t => t.gemini_market_id === signal.marketId);
        if (alreadyInMarket) {
            return { allowed: false, reason: 'Already have position in this market' };
        }

        return { allowed: true };
    }

    /**
     * Enter a position based on signal
     */
    enterPosition(signal) {
        const canEnter = this.canEnterPosition(signal);
        if (!canEnter.allowed) {
            this.logger.debug(`Skipping entry: ${canEnter.reason}`);
            return null;
        }

        const wallet = this.db.getWallet();
        const positionSize = this.calculatePositionSize(signal, wallet);

        if (positionSize < 5) {
            this.logger.debug('Position size too small, skipping');
            return null;
        }

        // Execute paper trade
        const order = this.gemini.executePaperTrade(
            signal.marketId, signal.direction, positionSize,
            { slippage: this.params.slippage_penalty }
        );

        if (!order || !order.success) {
            this.logger.warn(`Paper trade failed for ${signal.marketId}`);
            return null;
        }

        // Calculate exit levels
        //
        // Take profit: must be at least entry + minimum profit to guarantee
        // the executable exit PnL is positive.  targetPrice from the signal
        // is reference-based and may be inside the spread, so clamp it.
        const minProfit = 0.015; // 1.5¢ minimum profit target
        let takeProfitPrice;
        if (signal.direction === 'YES') {
            const minTP = order.fill_price + minProfit;
            takeProfitPrice = signal.targetPrice
                ? Math.max(signal.targetPrice, minTP)
                : order.fill_price + 0.03;
        } else {
            const maxTP = order.fill_price - minProfit;
            takeProfitPrice = signal.targetPrice
                ? Math.min(signal.targetPrice, maxTP)
                : order.fill_price - 0.03;
        }
        // Stop loss is based on MID-price at entry, not fill price.
        // This avoids immediately triggering stop loss from spread cost.
        const entryMid = (order.market_bid + order.market_ask) / 2;
        const stopLossPrice = signal.direction === 'YES'
            ? entryMid - this.params.stop_loss_width
            : entryMid + this.params.stop_loss_width;

        // Record trade in DB
        const tradeId = this.db.insertTrade({
            timestamp: Math.floor(Date.now() / 1000),
            gemini_market_id: signal.marketId,
            market_title: signal.title,
            category: signal.category,
            direction: signal.direction,
            entry_price: order.fill_price,
            position_size: positionSize,
            opportunity_score: signal.score,
            polymarket_signal_price: signal.referencePrice,
            kalshi_signal_price: signal.kalshi_bid || signal.kalshi_ask,
            gemini_entry_bid: signal.gemini_bid,
            gemini_entry_ask: signal.gemini_ask,
            gemini_volume: signal.gemini_volume,
            take_profit_price: takeProfitPrice,
            stop_loss_price: stopLossPrice,
            slippage: order.slippage,
            mode: 'paper'
        });

        this.tradeCount++;
        this.logger.info(
            `ENTRY: ${signal.direction} on "${signal.title}" ` +
            `@ ${order.fill_price.toFixed(3)} ($${positionSize}) ` +
            `Score=${signal.score} TP=${takeProfitPrice.toFixed(3)} SL=${stopLossPrice.toFixed(3)}`
        );

        return { tradeId, order, positionSize, takeProfitPrice, stopLossPrice };
    }

    /**
     * Monitor open positions and handle exits
     * Includes time-decay acceleration: tighten stop-loss as settlement approaches
     */
    monitorPositions() {
        const openTrades = this.db.getOpenTrades();
        if (openTrades.length === 0) return [];

        const exits = [];
        const now = Math.floor(Date.now() / 1000);

        for (const trade of openTrades) {
            // Get current mid-price for stop loss (tracks market moves, not spread cost)
            const currentMid = this.gemini.getPaperMidPrice(trade.gemini_market_id);
            if (currentMid === null) continue;

            // Get executable exit price (includes spread + slippage) for TP check and PnL
            const exitPrice = this.gemini.getPaperExitPrice(trade.gemini_market_id, trade.direction);
            if (exitPrice === null) continue;

            let exitReason = null;
            const holdTime = now - trade.timestamp;
            let pnl = 0;

            // ── Time-Decay Exit Acceleration ────────────────────────────────────
            // When a contract is within the final 20% of its max hold window,
            // tighten the effective stop-loss by 50% to cut losses faster.
            // This mirrors the accelerating time-decay of near-expiry contracts:
            // an unresolved position with 2 min remaining is worth almost nothing.
            const maxHold = this.params.max_hold_time;
            const decayFraction = holdTime / maxHold; // 0 at entry → 1 at max hold

            let effectiveStopLoss = trade.stop_loss_price;
            if (decayFraction >= 0.80) {
                // Final 20% of hold window: halve stop distance from mid at entry
                // This tightens the stop toward current price to force faster exit
                const tightenFactor = 1 - (decayFraction - 0.80) / 0.20 * 0.50; // 1 → 0.5
                const stopDistance = Math.abs(currentMid - trade.stop_loss_price);
                if (trade.direction === 'YES') {
                    effectiveStopLoss = currentMid - stopDistance * tightenFactor;
                } else {
                    effectiveStopLoss = currentMid + stopDistance * tightenFactor;
                }
            }
            // ────────────────────────────────────────────────────────────────────

            // Calculate PnL based on executable exit price (realistic)
            // Includes fee deductions for both entry and exit sides
            const entryFee = trade.position_size * this.params.fee_per_side;
            const exitValue = trade.direction === 'YES'
                ? (exitPrice - trade.entry_price) * trade.position_size / trade.entry_price
                : (trade.entry_price - exitPrice) * trade.position_size / (1 - trade.entry_price);
            const exitFee = Math.abs(exitValue + trade.position_size) * this.params.fee_per_side;
            pnl = exitValue - entryFee - exitFee;

            // Check exit conditions:
            //   Take profit: based on executable exit price (conservative — we can actually realize it)
            //   Stop loss: uses effectiveStopLoss (tightens near expiry for time-decay)
            if (trade.direction === 'YES') {
                if (exitPrice >= trade.take_profit_price) exitReason = 'take_profit';
                else if (currentMid <= effectiveStopLoss) exitReason = decayFraction >= 0.80 ? 'time_decay_stop' : 'stop_loss';
            } else {
                if (exitPrice <= trade.take_profit_price) exitReason = 'take_profit';
                else if (currentMid >= effectiveStopLoss) exitReason = decayFraction >= 0.80 ? 'time_decay_stop' : 'stop_loss';
            }

            // Time-based exit
            if (!exitReason && holdTime >= maxHold) {
                exitReason = 'time_exit';
            }

            if (exitReason) {
                // Close the trade
                pnl = parseFloat(pnl.toFixed(4));
                this.db.closeTrade(trade.id, exitPrice, pnl, holdTime, exitReason);

                // Update wallet
                const wallet = this.db.getWallet();
                const newBalance = wallet.balance + pnl;
                this.db.updateWallet(newBalance, pnl);

                this.logger.info(
                    `EXIT (${exitReason}): "${trade.market_title}" ` +
                    `@ ${exitPrice.toFixed(3)} PnL=$${pnl.toFixed(2)} Hold=${holdTime}s ` +
                    `Balance=$${newBalance.toFixed(2)}`
                );

                exits.push({ trade, exitPrice, pnl, holdTime, exitReason });
            }
        }

        return exits;
    }

    /**
     * Adaptive learning cycle - adjust parameters based on recent performance
     */
    runLearningCycle() {
        const now = Date.now();
        if (now - this.lastLearningCycle < this.learningInterval) return;
        this.lastLearningCycle = now;

        try {
            const dailyPnL = this.db.getDailyPnL();
            if (!dailyPnL || dailyPnL.trade_count < 3) return; // Need minimum trades

            const winRate = dailyPnL.wins / Math.max(1, dailyPnL.trade_count);
            const avgPnl = dailyPnL.daily_pnl / Math.max(1, dailyPnL.trade_count);

            this.logger.info(
                `Learning cycle: WinRate=${(winRate * 100).toFixed(1)}% ` +
                `AvgPnL=$${avgPnl.toFixed(2)} Trades=${dailyPnL.trade_count}`
            );

            // ── time_decay_stop feedback ─────────────────────────────────────
            // Measure whether the time-decay stop-loss is helping or hurting.
            // If time_decay_stops have a worse avg_pnl than regular stop_losses,
            // widen the decay trigger from 80% → 85% of hold window (less aggressive).
            // If they have better avg_pnl, tighten to 75% (more aggressive).
            try {
                const exitStats = this.db.getWinRateByExitReason(7);
                const decayRow  = exitStats.find(r => r.exit_reason === 'time_decay_stop');
                const stopRow   = exitStats.find(r => r.exit_reason === 'stop_loss');

                if (decayRow && decayRow.total >= 3 && stopRow && stopRow.total >= 3) {
                    const decayAvgPnl = decayRow.avg_pnl;
                    const stopAvgPnl  = stopRow.avg_pnl;

                    this.logger.info(
                        `time_decay_stop: n=${decayRow.total} avgPnL=$${decayAvgPnl.toFixed(2)} ` +
                        `vs stop_loss: n=${stopRow.total} avgPnL=$${stopAvgPnl.toFixed(2)}`
                    );

                    // Persist a virtual parameter for observability (doesn't change hard-coded 0.80)
                    // A future version can read this to adjust the decay fraction threshold.
                    const decayScore = decayAvgPnl - stopAvgPnl;
                    this.db.setParameter
                        && this.db.setParameter('time_decay_stop_edge', parseFloat(decayScore.toFixed(4)));
                }
            } catch (decayErr) {
                this.logger.debug('time_decay_stop feedback: ' + decayErr.message);
            }
            // ────────────────────────────────────────────────────────────────

            // If performing well, be more aggressive
            if (winRate > 0.65 && avgPnl > 2.0) {
                const newThreshold = Math.max(
                    30,
                    this.params.entry_threshold * 0.95
                );
                const newKelly = Math.min(0.5, this.params.kelly_multiplier * 1.1);

                this.db.setParameter('entry_threshold', newThreshold);
                this.db.setParameter('kelly_multiplier', newKelly);
                this.params.entry_threshold = newThreshold;
                this.params.kelly_multiplier = newKelly;

                this.logger.info(`Loosening: threshold=${newThreshold.toFixed(1)}, kelly=${newKelly.toFixed(3)}`);
            }

            // If performing poorly, be more conservative
            if (winRate < 0.50) {
                const newThreshold = Math.min(
                    90,
                    this.params.entry_threshold * 1.1
                );
                const newStopLoss = Math.max(
                    0.01,
                    this.params.stop_loss_width * 0.9
                );

                this.db.setParameter('entry_threshold', newThreshold);
                this.db.setParameter('stop_loss_width', newStopLoss);
                this.params.entry_threshold = newThreshold;
                this.params.stop_loss_width = newStopLoss;

                this.logger.info(`Tightening: threshold=${newThreshold.toFixed(1)}, stop_loss=${newStopLoss.toFixed(3)}`);
            }
        } catch (error) {
            this.logger.warn('Learning cycle error: ' + error.message);
        }
    }

    /**
     * Main trading tick - called every second
     */
    tick(actionableSignals) {
        // 1. Monitor and exit existing positions
        const exits = this.monitorPositions();

        // 2. Enter new positions from signals
        const entries = [];
        for (const signal of actionableSignals) {
            const entry = this.enterPosition(signal);
            if (entry) entries.push(entry);
        }

        // 3. Run learning cycle
        this.runLearningCycle();

        return { entries, exits };
    }

    /**
     * Get comprehensive status
     */
    getStatus() {
        const wallet = this.db.getWallet();
        const openTrades = this.db.getOpenTrades();
        const dailyPnL = this.db.getDailyPnL();
        const params = this.db.getAllParameters();

        return {
            running: this.isRunning,
            wallet,
            open_positions: openTrades.length,
            open_trades: openTrades,
            daily_pnl: dailyPnL,
            total_trades: this.tradeCount,
            parameters: params.reduce((acc, p) => { acc[p.key] = p.value; return acc; }, {}),
            last_learning_cycle: this.lastLearningCycle
        };
    }
}

module.exports = PaperTradingEngine;
