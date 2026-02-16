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

const { Logger } = require('../lib/logger');

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
            entry_threshold: 60,
            price_velocity_threshold: 0.03,
            take_profit_buffer: 0.01,
            stop_loss_width: 0.03,
            max_hold_time: 600,
            kelly_multiplier: 0.25,
            max_concurrent_positions: 5,
            max_position_size: 100,
            max_capital_at_risk_pct: 50,
            slippage_penalty: 0.005,
            daily_loss_limit: -50
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

        if (!entryPrice || !targetPrice || !wallet) {
            return this.params.max_position_size * 0.1; // Minimum size
        }

        // Expected edge
        let expectedMove;
        if (signal.direction === 'YES') {
            expectedMove = targetPrice - entryPrice;
        } else {
            expectedMove = entryPrice - targetPrice;
        }

        // Must have positive edge
        if (expectedMove <= 0) return 0;

        // Kelly calculation
        const winProb = Math.min(0.8, 0.5 + signal.score / 200); // Score-based win probability
        const payout = expectedMove / entryPrice; // Return per unit risked
        const edgeRatio = (winProb * payout - (1 - winProb) * this.params.stop_loss_width) / payout;
        const kelly = Math.max(0, edgeRatio) * this.params.kelly_multiplier;

        // Position size
        let positionSize = wallet.balance * kelly;

        // Apply limits
        positionSize = Math.min(positionSize, this.params.max_position_size);
        positionSize = Math.min(positionSize, wallet.balance * this.params.max_capital_at_risk_pct / 100);
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
        const takeProfitPrice = signal.targetPrice || (
            signal.direction === 'YES'
                ? order.fill_price + 0.03
                : order.fill_price - 0.03
        );
        const stopLossPrice = signal.direction === 'YES'
            ? order.fill_price - this.params.stop_loss_width
            : order.fill_price + this.params.stop_loss_width;

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
     */
    monitorPositions() {
        const openTrades = this.db.getOpenTrades();
        if (openTrades.length === 0) return [];

        const exits = [];
        const now = Math.floor(Date.now() / 1000);

        for (const trade of openTrades) {
            // Get current market price
            const exitPrice = this.gemini.getPaperExitPrice(trade.gemini_market_id, trade.direction);
            if (exitPrice === null) continue;

            let exitReason = null;
            const holdTime = now - trade.timestamp;
            let pnl = 0;

            // Calculate PnL
            if (trade.direction === 'YES') {
                pnl = (exitPrice - trade.entry_price) * trade.position_size / trade.entry_price;
            } else {
                pnl = (trade.entry_price - exitPrice) * trade.position_size / (1 - trade.entry_price);
            }

            // Check exit conditions
            if (trade.direction === 'YES') {
                if (exitPrice >= trade.take_profit_price) exitReason = 'take_profit';
                else if (exitPrice <= trade.stop_loss_price) exitReason = 'stop_loss';
            } else {
                if (exitPrice <= trade.take_profit_price) exitReason = 'take_profit';
                else if (exitPrice >= trade.stop_loss_price) exitReason = 'stop_loss';
            }

            // Time-based exit
            if (!exitReason && holdTime >= this.params.max_hold_time) {
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
