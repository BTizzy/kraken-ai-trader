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
        this.liveOrdersThisCycle = 0; // Rate-limit live orders per cycle
        this.maxLiveOrdersPerCycle = options.maxLiveOrdersPerCycle || 3;
        this.liveExitRetries = new Map(); // tradeId → { count, firstAttempt }
        this.maxExitRetries = 10; // Give up after 10 failed exit attempts
        this._balanceRejectLogged = false; // Log balance rejection once per cycle
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
            // Fee model: Gemini Predictions maker-or-cancel fee structure
            // Maker fill (order posts): 0.01% = 0.0001
            // Taker fill (crosses book): 0.05% = 0.0005 — but maker-or-cancel cancels instead of crossing
            // Conservative estimate uses maker rate as our default; we always use maker-or-cancel
            fee_per_side: 0.0001
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

        // For live mode, use real Gemini balance instead of paper wallet
        const isLive = this.gemini.mode === 'live' || this.gemini.mode === 'sandbox';
        const effectiveBalance = (isLive && this._liveBalance != null) ? this._liveBalance : wallet.balance;
        const maxPerTrade = isLive
            ? Math.min(this.params.max_position_size, effectiveBalance * 0.10)
            : this.params.max_position_size;

        // If signal has pre-computed Kelly fraction (from FairValueEngine), use it directly
        if (signal.kellyFraction && signal.kellyFraction > 0) {
            let positionSize = effectiveBalance * signal.kellyFraction;
            positionSize = Math.min(positionSize, maxPerTrade);
            positionSize = Math.min(positionSize, effectiveBalance * this.params.max_capital_at_risk_pct / 100);
            // Depth cap: max 10% of real ask depth
            const askDepth0 = signal.gemini_ask_depth || signal.ask_depth || null;
            if (askDepth0 && askDepth0 > 0) {
                positionSize = Math.min(positionSize, askDepth0 * 0.10);
            }
            positionSize = Math.max(positionSize, 1); // Minimum $1
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
            const baseSize = effectiveBalance * 0.02 * scoreFraction * this.params.kelly_multiplier;
            return Math.max(1, Math.min(baseSize, maxPerTrade));
        }

        // Kelly calculation with edge
        const winProb = Math.min(0.8, 0.5 + signal.score / 200);
        const payout = edge / Math.max(0.01, entryPrice);
        const edgeRatio = (winProb * payout - (1 - winProb) * this.params.stop_loss_width) / Math.max(0.01, payout);
        const kelly = Math.max(0, edgeRatio) * this.params.kelly_multiplier;

        let positionSize = effectiveBalance * kelly;

        // Apply limits
        positionSize = Math.min(positionSize, maxPerTrade);
        positionSize = Math.min(positionSize, effectiveBalance * this.params.max_capital_at_risk_pct / 100);

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

        positionSize = Math.max(positionSize, 1); // Minimum $1

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

        // Check category concentration (max 3 per category)
        const categoryCount = openTrades.filter(t => t.category === signal.category).length;
        if (categoryCount >= 3) {
            return { allowed: false, reason: `Max 3 positions in ${signal.category} reached` };
        }

        // Check directional concentration within same asset/category
        // Max 2 positions in the same direction per category to prevent correlation risk
        if (signal.direction) {
            const sameDirCount = openTrades.filter(
                t => t.category === signal.category && t.direction === signal.direction
            ).length;
            if (sameDirCount >= 2) {
                return { allowed: false, reason: `Max 2 ${signal.direction} positions in ${signal.category}` };
            }
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
    async enterPosition(signal) {
        const canEnter = this.canEnterPosition(signal);
        if (!canEnter.allowed) {
            this.logger.debug(`Skipping entry ${signal.marketId}: ${canEnter.reason}`);
            return null;
        }

        const wallet = this.db.getWallet();

        // Cache real Gemini balance for position sizing (used by calculatePositionSize)
        const isLive = this.gemini.mode === 'live' || this.gemini.mode === 'sandbox';
        if (isLive) {
            const realBal = await this.gemini.getAvailableBalance();
            this._liveBalance = realBal;
        }

        const positionSize = this.calculatePositionSize(signal, wallet);

        if (positionSize < 1) {
            this.logger.debug('Position size too small, skipping');
            return null;
        }

        // Spread-aware entry: edge must exceed ROUND-TRIP spread cost
        // Entry crosses ask, exit crosses bid → pay full spread twice
        const market = this.gemini.paperMarkets.get(signal.marketId) || {};
        const geminiSpread = market.spread || (signal.gemini_ask && signal.gemini_bid ? signal.gemini_ask - signal.gemini_bid : null);
        if (geminiSpread && geminiSpread > 0) {
            const refPrice = signal.referencePrice || signal.targetPrice;
            if (refPrice) {
                const entryPriceEst = signal.direction === 'YES'
                    ? (market.ask || signal.gemini_ask || 0.50)
                    : 1 - (market.bid || signal.gemini_bid || 0.50);
                const edgeEst = signal.direction === 'YES'
                    ? refPrice - entryPriceEst
                    : entryPriceEst - refPrice;
                const roundTripSpreadCost = geminiSpread * 2 + 0.01; // 2x spread + 1¢ profit margin
                const minRequiredEdge = Math.max(this.params.stop_loss_width || 0.03, roundTripSpreadCost);
                if (edgeEst < minRequiredEdge) {
                    this.logger.debug(
                        `Spread-aware reject: ${signal.marketId} edge=${edgeEst.toFixed(3)} < ` +
                        `minRequired=${minRequiredEdge.toFixed(3)} (spread=${geminiSpread.toFixed(3)}, roundTrip=${roundTripSpreadCost.toFixed(3)})`
                    );
                    return null;
                }
            }
        }

        // Execute trade: routes through placeOrder which handles paper/live/sandbox
        let entryPrice;
        if (signal.direction === 'YES') {
            entryPrice = market.ask || signal.gemini_ask || 0.50;
        } else {
            // NO direction: for paper markets use complement of bid.
            // For real GEMI instruments, use the sell.yes price (= NO buy price)
            // from the real API prices to avoid paying near $1 for deep-ITM NO.
            entryPrice = 1 - (market.bid || signal.gemini_bid || 0.50);
        }

        // NO trade leverage guard: reject if effective NO cost < $0.05 per contract
        // This prevents 20x+ leverage that creates Trade 93-style $489 PnL on $5 positions
        if (signal.direction === 'NO' && entryPrice < 0.05) {
            this.logger.debug(
                `NO leverage guard: ${signal.marketId} cost=$${entryPrice.toFixed(3)} ` +
                `creates ${Math.round(1/entryPrice)}x leverage — rejected`
            );
            return null;
        }

        // Deep-ITM/OTM guard for crypto: reject trades against overwhelming spot evidence
        // If BTC=$96K and strike=$67.5K, buying NO on "BTC > $67.5K" is near-certain loss
        if (signal._spotPrice && signal.marketId && signal.marketId.startsWith('GEMI-')) {
            const strikeMatch = signal.marketId.match(/HI(\d+D?\d*)$/);
            if (strikeMatch) {
                const strike = parseFloat(strikeMatch[1].replace('D', '.'));
                const moneyness = signal._spotPrice / strike;
                if (moneyness > 1.20 && signal.direction === 'NO') {
                    this.logger.warn(
                        `Deep-ITM guard: BLOCKED NO on ${signal.marketId} — ` +
                        `spot=$${signal._spotPrice.toLocaleString()} is ${((moneyness - 1) * 100).toFixed(0)}% above ` +
                        `strike=$${strike.toLocaleString()}. This contract is near-certain YES.`
                    );
                    return null;
                }
                if (moneyness < 0.80 && signal.direction === 'YES') {
                    this.logger.warn(
                        `Deep-OTM guard: BLOCKED YES on ${signal.marketId} — ` +
                        `spot=$${signal._spotPrice.toLocaleString()} is ${((1 - moneyness) * 100).toFixed(0)}% below ` +
                        `strike=$${strike.toLocaleString()}. This contract is near-certain NO.`
                    );
                    return null;
                }
            }
        }

        // Contract count validation: need at least 1 contract
        const contractCount = Math.floor(positionSize / entryPrice);
        if (contractCount < 1) {
            this.logger.debug(`Position too small for 1 contract: $${positionSize.toFixed(2)} / $${entryPrice.toFixed(2)}`);
            return null;
        }

        let order;
        const isRealInstrument = signal.marketId && signal.marketId.startsWith('GEMI-');
        if ((this.gemini.mode === 'live' || this.gemini.mode === 'sandbox') && isRealInstrument) {
            // Hard liquidity gate: require two-sided book and reasonable spread
            if (this.gemini.realClient) {
                const realPrices = this.gemini.realClient.getBestPrices(signal.marketId);
                if (!realPrices || !realPrices.hasTwoSidedBook) {
                    this.logger.debug(`Liquidity gate: ${signal.marketId} — no two-sided book, can't exit`);
                    return null;
                }
                if (realPrices.spread > 0.15) {
                    this.logger.debug(
                        `Liquidity gate: ${signal.marketId} — spread=$${realPrices.spread.toFixed(3)} > $0.15`
                    );
                    return null;
                }
            }

            // Minimum edge for live trades (higher bar than paper)
            const minEdgeLive = this.params.min_edge_live || 0.08;
            const signalEdge = signal.netEdge || signal.edge || 0;
            if (signalEdge < minEdgeLive) {
                this.logger.debug(
                    `Live edge too low: ${signal.marketId} edge=${signalEdge.toFixed(3)} < ${minEdgeLive}`
                );
                return null;
            }

            // Rate-limit live orders: max 3 per cycle to prevent InsufficientFunds spam
            if (this.liveOrdersThisCycle >= this.maxLiveOrdersPerCycle) {
                this.logger.debug(
                    `Live order rate-limited: ${this.liveOrdersThisCycle}/${this.maxLiveOrdersPerCycle} this cycle`
                );
                return null;
            }

            // Minimum balance check: query real Gemini balance for live trades
            const realBalance = await this.gemini.getAvailableBalance();
            const effectiveBalance = realBalance != null ? realBalance : wallet.balance;
            if (effectiveBalance < (this.params.min_position_size || 5) + 2) {
                if (!this._balanceRejectLogged) {
                    this.logger.warn(
                        `Live orders paused: insufficient balance $${effectiveBalance.toFixed(2)} ` +
                        `(need >= $${((this.params.min_position_size || 5) + 2).toFixed(2)})` +
                        (realBalance != null ? ' [real Gemini balance]' : ' [paper wallet — Gemini API unavailable]')
                    );
                    this._balanceRejectLogged = true;
                }
                return null;
            }

            // Minimum score for live crypto trades (paper trades can use lower threshold)
            if (signal.score < 45) {
                this.logger.debug(
                    `Live crypto rejected: ${signal.marketId} score=${signal.score} (< 45)`
                );
                return null;
            }

            // Reject if Gemini bid/ask are undefined (no real orderbook data)
            if (signal.gemini_bid == null && signal.gemini_ask == null) {
                this.logger.debug(
                    `Live crypto rejected: ${signal.marketId} — no Gemini bid/ask data`
                );
                return null;
            }

            // Live execution safeguard: reject trades where entry price > reference price
            // (means the arb edge is illusory or the Kalshi synthetic is stale)
            const refPrice = signal.referencePrice || signal.targetPrice;
            if (refPrice) {
                const edgeVsRef = signal.direction === 'YES'
                    ? refPrice - entryPrice
                    : entryPrice - refPrice;
                if (edgeVsRef < 0.01) {
                    this.logger.warn(
                        `Live order rejected: ${signal.direction} ${signal.marketId} ` +
                        `entry=${entryPrice.toFixed(3)} ref=${refPrice.toFixed(3)} edge=${edgeVsRef.toFixed(3)} (< 1¢)`
                    );
                    return null;
                }
            }

            // Reject NO orders where the cost per contract is unreasonable (> 85¢)
            if (signal.direction === 'NO' && entryPrice > 0.85) {
                this.logger.warn(
                    `Live NO order rejected: ${signal.marketId} entry=$${entryPrice.toFixed(3)} too expensive (> $0.85)`
                );
                return null;
            }

            // Live execution via prediction markets API (only for real GEMI-* instruments)
            try {
                order = await this.gemini.placeOrder({
                    symbol: signal.marketId,
                    side: 'buy',
                    amount: Math.floor(positionSize / entryPrice),  // contracts = dollars / price
                    price: entryPrice.toFixed(2),
                    direction: signal.direction
                });
                this.liveOrdersThisCycle++;

                // Verify the order was actually filled, not just accepted
                if (!order || !order.success) {
                    this.logger.error(
                        `Live order rejected by Gemini: ${signal.marketId} ` +
                        `status=${order?.orderStatus} — NO fallback, skipping trade`
                    );
                    return null;
                }
                if (order.filledQuantity === 0 && order.orderStatus !== 'filled') {
                    this.logger.warn(
                        `Live order pending (not filled): ${signal.marketId} ` +
                        `orderId=${order.orderId} status=${order.orderStatus} — cancelling`
                    );
                    // Cancel unfilled order to avoid orphaned limit orders
                    try {
                        await this.gemini.cancelOrder(order.orderId);
                    } catch (cancelErr) {
                        this.logger.error(`Failed to cancel unfilled order ${order.orderId}: ${cancelErr.message}`);
                    }
                    return null;
                }
            } catch (err) {
                this.logger.error(
                    `LIVE ORDER FAILED — NOT falling back to paper: ${signal.marketId} ${err.message}`
                );
                return null;
            }
        } else {
            // Paper execution (for simulated markets or paper mode)
            order = this.gemini.executePaperTrade(
                signal.marketId, signal.direction, positionSize,
                { slippage: this.params.slippage_penalty }
            );
        }

        if (!order || !order.success) {
            this.logger.warn(`Trade failed for ${signal.marketId}`);
            return null;
        }

        // Compute realistic shadow entry price (using actual bid/ask, not synthetic mid)
        let realisticOrder = null;
        if (this.gemini.realisticPaper) {
            realisticOrder = this.gemini.executeRealisticPaperTrade(
                signal.marketId, signal.direction, positionSize
            );
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
            mode: (this.gemini.mode === 'live' && isRealInstrument) ? 'live' : 'paper'
        });

        // Store realistic shadow entry data
        if (realisticOrder && realisticOrder.success) {
            const market = this.gemini.paperMarkets.get(signal.marketId) || {};
            this.db.updateTradeRealisticEntry(
                tradeId,
                realisticOrder.fill_price,
                market.bid || null,
                market.ask || null,
                market.spread || null
            );
        }

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
    async monitorPositions() {
        const openTrades = this.db.getOpenTrades();
        if (openTrades.length === 0) return [];

        const exits = [];
        const now = Math.floor(Date.now() / 1000);

        for (const trade of openTrades) {
            const isLive = trade.mode === 'live';

            // For live trades, get current market data from real API
            // For paper trades, use paper simulation
            let currentMid, exitPrice;

            if (isLive) {
                // Live trade: use real Gemini prices for exit decisions
                const realPrices = this.gemini.realClient
                    ? this.gemini.realClient.getBestPrices(trade.gemini_market_id)
                    : null;
                if (!realPrices || !realPrices.hasTwoSidedBook) {
                    this.logger.debug(`Live trade ${trade.id}: no two-sided book, skipping exit check`);
                    continue;
                }
                currentMid = (realPrices.bid + realPrices.ask) / 2;
                // For live exits: YES sells at bid, NO buys at ask (to close)
                exitPrice = trade.direction === 'YES' ? realPrices.bid : (1 - realPrices.ask);
            } else {
                // Paper trade: use paper simulation
                currentMid = this.gemini.getPaperMidPrice(trade.gemini_market_id);
                if (currentMid === null) continue;
                exitPrice = this.gemini.getPaperExitPrice(trade.gemini_market_id, trade.direction);
                if (exitPrice === null) continue;
            }

            let exitReason = null;
            const holdTime = now - trade.timestamp;
            let pnl = 0;

            // ── Time-Decay Exit Acceleration ────────────────────────────────────
            // When a contract is within the final 20% of its max hold window,
            // tighten the effective stop-loss by 50% to cut losses faster.
            // This mirrors the accelerating time-decay of near-expiry contracts:
            // an unresolved position with 2 min remaining is worth almost nothing.
            let maxHold = this.params.max_hold_time;

            // Expiry-aware hold time: parse settlement from GEMI-BTC2602240800-HI67500
            const expiryMatch = trade.gemini_market_id.match(/GEMI-\w+?(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
            if (expiryMatch) {
                const [, yy, mm, dd, hh, mn] = expiryMatch;
                const expiry = new Date(`20${yy}-${mm}-${dd}T${hh}:${mn}:00Z`);
                const timeToExpiry = (expiry.getTime() - Date.now()) / 1000;
                if (timeToExpiry > 0) {
                    maxHold = Math.max(maxHold, timeToExpiry * 0.80);
                }
            }

            // High-edge FV trades get at least 4h hold time
            if (trade.opportunity_score >= 70) {
                maxHold = Math.max(maxHold, 14400);
            }

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
            let exitValue = trade.direction === 'YES'
                ? (exitPrice - trade.entry_price) * trade.position_size / trade.entry_price
                : (trade.entry_price - exitPrice) * trade.position_size / (1 - trade.entry_price);
            // Clamp to prevent runaway PnL from near-zero denominators
            exitValue = Math.max(-trade.position_size, Math.min(exitValue, trade.position_size * 10));
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
                // For live trades, submit a real sell order via Gemini API
                if (isLive) {
                    // Track retry attempts — give up after maxExitRetries
                    const retryInfo = this.liveExitRetries.get(trade.id) || { count: 0, firstAttempt: now };
                    retryInfo.count++;
                    this.liveExitRetries.set(trade.id, retryInfo);

                    if (retryInfo.count > this.maxExitRetries) {
                        this.logger.error(
                            `LIVE EXIT ABANDONED after ${retryInfo.count} retries: ${trade.gemini_market_id} ` +
                            `— closing in DB only. CHECK GEMINI FOR ORPHANED POSITION.`
                        );
                        this.liveExitRetries.delete(trade.id);
                        // Fall through to close in DB so we don't keep retrying forever
                    } else {
                        try {
                            const contracts = Math.floor(trade.position_size / trade.entry_price);
                            const exitOrder = await this.gemini.placeOrder({
                                symbol: trade.gemini_market_id,
                                side: 'sell',
                                amount: contracts,
                                price: exitPrice.toFixed(2),
                                direction: trade.direction
                            });
                            if (!exitOrder || !exitOrder.success) {
                                this.logger.warn(
                                    `Live exit order failed for ${trade.gemini_market_id}, ` +
                                    `retry ${retryInfo.count}/${this.maxExitRetries} (reason=${exitReason})`
                                );
                                continue; // Skip closing in DB — retry next cycle
                            }
                            // Use actual fill price from exchange if available
                            exitPrice = exitOrder.fill_price || exitPrice;
                            this.liveExitRetries.delete(trade.id);
                            this.logger.info(
                                `LIVE EXIT (${exitReason}): ${trade.gemini_market_id} ` +
                                `orderId=${exitOrder.orderId} filled=${exitOrder.filledQuantity}`
                            );
                        } catch (err) {
                            this.logger.error(
                                `Live exit error for ${trade.gemini_market_id}: ${err.message} ` +
                                `retry ${retryInfo.count}/${this.maxExitRetries}`
                            );
                            continue; // Don't close in DB if API call failed
                        }
                    }
                }

                // Close the trade
                pnl = parseFloat(pnl.toFixed(4));
                this.db.closeTrade(trade.id, exitPrice, pnl, holdTime, exitReason);

                // Compute and store realistic exit PnL (uses actual bid/ask)
                let realisticPnl = null;
                if (this.gemini.realisticPaper && trade.realistic_entry_price) {
                    const realisticExit = this.gemini.getRealisticExitPrice(
                        trade.gemini_market_id, trade.direction
                    );
                    if (realisticExit !== null) {
                        const rEntryFee = trade.position_size * this.params.fee_per_side;
                        const rExitValue = trade.direction === 'YES'
                            ? (realisticExit - trade.realistic_entry_price) * trade.position_size / trade.realistic_entry_price
                            : (trade.realistic_entry_price - realisticExit) * trade.position_size / (1 - trade.realistic_entry_price);
                        const rExitFee = Math.abs(rExitValue + trade.position_size) * this.params.fee_per_side;
                        realisticPnl = parseFloat((rExitValue - rEntryFee - rExitFee).toFixed(4));
                        this.db.updateTradeRealisticExit(trade.id, realisticExit, realisticPnl);
                    }
                }

                // Update wallet
                const wallet = this.db.getWallet();
                const newBalance = wallet.balance + pnl;
                this.db.updateWallet(newBalance, pnl);

                const realisticSuffix = realisticPnl !== null
                    ? ` | Realistic=$${realisticPnl.toFixed(2)}`
                    : '';
                this.logger.info(
                    `EXIT (${exitReason}): "${trade.market_title}" ` +
                    `@ ${exitPrice.toFixed(3)} PnL=$${pnl.toFixed(2)} Hold=${holdTime}s ` +
                    `Balance=$${newBalance.toFixed(2)}${realisticSuffix}`
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
            // Use last 50 closed trades as the learning window.
            // Larger window = more stable parameter estimates, less noise.
            const dailyPnL = this.db.getRecentTradeStats(50);
            if (!dailyPnL || dailyPnL.trade_count < 10) return; // Need minimum 10 trades

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
            // In live mode, clamp parameters to safe bounds to prevent reckless drift
            const isLiveMode = this.gemini.mode === 'live' || this.gemini.mode === 'sandbox';
            const thresholdFloor = isLiveMode ? 45 : 30;
            const kellyCeiling = isLiveMode ? 0.20 : 0.50;

            if (winRate > 0.65 && avgPnl > 2.0) {
                const newThreshold = Math.max(
                    thresholdFloor,
                    this.params.entry_threshold * 0.95
                );
                const newKelly = Math.min(kellyCeiling, this.params.kelly_multiplier * 1.1);

                this.db.setParameter('entry_threshold', newThreshold);
                this.db.setParameter('kelly_multiplier', newKelly);
                this.params.entry_threshold = newThreshold;
                this.params.kelly_multiplier = newKelly;

                this.logger.info(`Loosening: threshold=${newThreshold.toFixed(1)}, kelly=${newKelly.toFixed(3)}`);
            }

            // If performing poorly, be more conservative
            if (winRate < 0.50) {
                // Starvation detection: if we've been tightening but no new trades are entering,
                // don't tighten further — it creates a deadlock where threshold blocks all entries
                // and the window never refreshes.
                if (!this._lastLearningTradeCount) this._lastLearningTradeCount = 0;
                if (!this._tighteningStreak) this._tighteningStreak = 0;

                if (this.tradeCount === this._lastLearningTradeCount) {
                    this._tighteningStreak++;
                } else {
                    this._tighteningStreak = 0;
                    this._lastLearningTradeCount = this.tradeCount;
                }

                // If 5+ tightenings with no new trades, loosen instead to break deadlock
                if (this._tighteningStreak >= 5 && this.params.entry_threshold >= 55) {
                    const newThreshold = Math.max(thresholdFloor, this.params.entry_threshold * 0.9);
                    this.db.setParameter('entry_threshold', newThreshold);
                    this.params.entry_threshold = newThreshold;
                    this._tighteningStreak = 0;
                    this.logger.info(`Starvation relief: threshold=${newThreshold.toFixed(1)} (no new trades, loosening)`);
                    return;
                }

                const newThreshold = Math.min(
                    65,
                    this.params.entry_threshold * 1.05
                );
                const newStopLoss = Math.max(
                    0.01,
                    this.params.stop_loss_width * 0.95
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
     * Main trading tick - called every cycle
     */
    async tick(actionableSignals) {
        // Reset per-cycle counters
        this.liveOrdersThisCycle = 0;
        this._balanceRejectLogged = false;

        // 1. Monitor and exit existing positions
        const exits = await this.monitorPositions();

        // 2. Enter new positions from signals
        const entries = [];
        for (const signal of actionableSignals) {
            const entry = await this.enterPosition(signal);
            if (entry) entries.push(entry);
        }

        // 3. Run learning cycle
        this.runLearningCycle();

        return { entries, exits };
    }

    /**
     * Reconcile DB positions with actual Gemini exchange positions.
     * Detects orphaned positions (on exchange but not in DB) and
     * phantom positions (in DB but not on exchange).
     */
    async reconcilePositions() {
        if (this.gemini.mode !== 'live' && this.gemini.mode !== 'sandbox') {
            return { orphaned: [], phantom: [], matched: [], skipped: true };
        }

        try {
            const [exchangePositions, dbOpenTrades] = await Promise.all([
                this.gemini.getPositions(),
                Promise.resolve(this.db.getOpenTrades('live'))
            ]);

            const matched = [];
            const phantom = [];
            const orphaned = [];

            // Build lookup of exchange positions by symbol
            const exchangeBySymbol = new Map();
            for (const pos of exchangePositions) {
                const symbol = pos.symbol || pos.instrumentSymbol;
                if (symbol) exchangeBySymbol.set(symbol, pos);
            }

            // Check each DB trade against exchange
            for (const trade of dbOpenTrades) {
                const exchangePos = exchangeBySymbol.get(trade.gemini_market_id);
                if (exchangePos) {
                    matched.push({
                        tradeId: trade.id,
                        symbol: trade.gemini_market_id,
                        dbDirection: trade.direction,
                        dbSize: trade.position_size,
                        exchangeQty: exchangePos.quantity || exchangePos.amount
                    });
                    exchangeBySymbol.delete(trade.gemini_market_id);
                } else {
                    phantom.push({
                        tradeId: trade.id,
                        symbol: trade.gemini_market_id,
                        direction: trade.direction,
                        size: trade.position_size,
                        entryPrice: trade.entry_price,
                        age: Math.floor(Date.now() / 1000) - trade.timestamp
                    });
                    this.logger.warn(
                        `PHANTOM POSITION: trade ${trade.id} ${trade.direction} ${trade.gemini_market_id} ` +
                        `exists in DB but NOT on Gemini exchange`
                    );
                }
            }

            // Remaining exchange positions not in DB = orphaned
            for (const [symbol, pos] of exchangeBySymbol) {
                orphaned.push({
                    symbol,
                    quantity: pos.quantity || pos.amount,
                    outcome: pos.outcome,
                    avgPrice: pos.avgExecutionPrice || pos.price
                });
                this.logger.error(
                    `ORPHANED POSITION: ${symbol} qty=${pos.quantity || pos.amount} ` +
                    `exists on Gemini but NOT in DB — manual intervention required`
                );
            }

            if (phantom.length > 0 || orphaned.length > 0) {
                this.logger.warn(
                    `RECONCILIATION: ${matched.length} matched, ` +
                    `${phantom.length} phantom (DB only), ${orphaned.length} orphaned (exchange only)`
                );
            }

            return { orphaned, phantom, matched, skipped: false };
        } catch (e) {
            this.logger.warn('Position reconciliation failed: ' + e.message);
            return { orphaned: [], phantom: [], matched: [], skipped: true, error: e.message };
        }
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
