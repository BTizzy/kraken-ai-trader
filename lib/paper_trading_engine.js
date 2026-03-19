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
        this.tradingProfile = this.normalizeTradingProfile(
            options.tradingProfile || process.env.TRADING_PROFILE || 'standard'
        );
        this.profileOverrides = this.getTradingProfileOverrides(this.tradingProfile);

        // Load parameters from DB
        this.params = this.loadParams();

        // Runtime state
        this.isRunning = false;
        this.lastLearningCycle = 0;
        this.learningInterval = options.learningInterval || 30000; // 30 seconds
        this.tradeCount = 0;
        this.liveOrdersThisCycle = 0; // Rate-limit live orders per cycle
        this.maxLiveOrdersPerCycle = options.maxLiveOrdersPerCycle || 3;
        this.liveCanaryMode = options.liveCanaryMode === true || String(process.env.LIVE_CANARY_MODE || '').toLowerCase() === 'true';
        this.liveCanaryMaxPositionSizeUsd = Math.max(
            0.01,
            Number(options.liveCanaryMaxPositionSizeUsd ?? process.env.LIVE_CANARY_MAX_POSITION_SIZE_USD ?? 0.10)
        );
        this.liveCanaryMaxOrdersPerSession = Math.max(
            1,
            Number(options.liveCanaryMaxOrdersPerSession ?? process.env.LIVE_CANARY_MAX_ORDERS_PER_SESSION ?? 3)
        );
        this.liveCanaryStopOnExitFailure = options.liveCanaryStopOnExitFailure !== false
            && String(process.env.LIVE_CANARY_STOP_ON_EXIT_FAILURE || 'true').toLowerCase() !== 'false';
        this.liveCanaryOrdersPlaced = 0;
        this.liveCanaryStopReason = null;
        this.liveExitRetries = new Map(); // tradeId → { count, firstAttempt }
        this.maxExitRetries = 10; // Give up after 10 failed exit attempts
        this._balanceRejectLogged = false; // Log balance rejection once per cycle
        this._recentlyClosed = new Map(); // marketId → closeTimestamp (prevents churn re-entry)
        this._exchangePositions = []; // Cached Gemini positions
        this._exchangePositionsFetchTime = 0;
        this._phantomPollCounts = new Map(); // tradeId → consecutive "not found" count
        // Pending-exit guard: prevents double-exit races when two cycles overlap.
        // A trade ID is added here the moment an exit order is placed, and only
        // removed once the order is confirmed filled, abandoned, or the DB is closed.
        this._pendingExits = new Set(); // tradeId → exit order in-flight

        // Session-mode controls for autonomous 15m trading.
        this.autonomous15mSession = options.autonomous15mSession === true || process.env.AUTONOMOUS_15M_SESSION === 'true';
        this.sessionLossLimitUsd = Math.abs(Number(options.sessionLossLimitUsd ?? process.env.SESSION_DAILY_LOSS_LIMIT_USD ?? 3));
        this.sessionProfitTargetUsd = Math.abs(Number(options.sessionProfitTargetUsd ?? process.env.SESSION_PROFIT_TARGET_USD ?? 10));
        this.sessionTimeoutMs = Math.max(60000, Number(options.sessionTimeoutMs ?? process.env.SESSION_TIMEOUT_MS ?? (this.autonomous15mSession ? 900000 : 1800000)));
        this.sessionMinTtxSeconds = Math.max(60, Number(options.sessionMinTtxSeconds ?? process.env.SESSION_MIN_TTX_SECONDS ?? 600));
        this.sessionMaxTtxSeconds = Math.max(this.sessionMinTtxSeconds, Number(options.sessionMaxTtxSeconds ?? process.env.SESSION_MAX_TTX_SECONDS ?? 3600));
        this.allowLongTtxIn15mSession = options.allowLongTtxIn15mSession === true ||
            String(process.env.ALLOW_LONG_TTX_IN_15M_SESSION || '').toLowerCase() === 'true';
        this.sessionEntryBufferSeconds = Math.max(30, Number(options.sessionEntryBufferSeconds ?? process.env.SESSION_ENTRY_BUFFER_SECONDS ?? (this.autonomous15mSession ? 120 : 300)));
        this.sessionForceExitBufferSeconds = Math.max(15, Number(options.sessionForceExitBufferSeconds ?? process.env.SESSION_FORCE_EXIT_BUFFER_SECONDS ?? (this.autonomous15mSession ? 60 : 180)));
        this.sessionRequiredRemainingFloorSeconds = Math.max(30, Number(
            options.sessionRequiredRemainingFloorSeconds
            ?? process.env.SESSION_REQUIRED_REMAINING_FLOOR_SECONDS
            ?? 90
        ));
        this.sessionRequiredRemainingCapSeconds = Math.max(this.sessionRequiredRemainingFloorSeconds, Number(
            options.sessionRequiredRemainingCapSeconds
            ?? process.env.SESSION_REQUIRED_REMAINING_CAP_SECONDS
            ?? (this.autonomous15mSession ? 240 : 300)
        ));
        this.sessionMaxConcurrentLive = Math.max(1, Number(options.sessionMaxConcurrentLive ?? process.env.SESSION_MAX_CONCURRENT_LIVE ?? 1));
        this.liveUsdReserve = Math.max(0, Number(options.liveUsdReserve ?? process.env.LIVE_USD_RESERVE ?? 5));
        this.liveMinTradableBalance = Math.max(0.01, Number(options.liveMinTradableBalance ?? process.env.LIVE_MIN_TRADABLE_BALANCE ?? 2));
        this.liveReserveFractionCap = Math.min(1, Math.max(0, Number(
            options.liveReserveFractionCap
            ?? process.env.LIVE_USD_RESERVE_FRACTION_CAP
            ?? 0.15
        )));
        this.liveMinTradableFraction = Math.min(1, Math.max(0, Number(
            options.liveMinTradableFraction
            ?? process.env.LIVE_MIN_TRADABLE_BALANCE_FRACTION
            ?? 0.10
        )));
        this.liveMinTradableAbsFloor = Math.max(0.01, Number(
            options.liveMinTradableAbsFloor
            ?? process.env.LIVE_MIN_TRADABLE_BALANCE_ABS_FLOOR
            ?? 0.10
        ));
        this.liveLowBalanceSizingThresholdUsd = Math.max(0.01, Number(
            options.liveLowBalanceSizingThresholdUsd
            ?? process.env.LIVE_LOW_BALANCE_SIZING_THRESHOLD_USD
            ?? 5
        ));
        this.liveLowBalanceSizingPct = Math.min(1, Math.max(0.10, Number(
            options.liveLowBalanceSizingPct
            ?? process.env.LIVE_LOW_BALANCE_SIZING_PCT
            ?? 0.50
        )));
        this.preTradeGateCacheMs = Math.max(1000, Number(options.preTradeGateCacheMs ?? process.env.PRE_TRADE_GATE_CACHE_MS ?? 3000));
        this.phantomGraceSeconds = Math.max(0, Number(options.phantomGraceSeconds ?? process.env.PHANTOM_GRACE_SECONDS ?? 30));
        this.shortTtxMaxSeconds = Math.max(300, Number(options.shortTtxMaxSeconds ?? process.env.SHORT_TTX_MAX_SECONDS ?? 3600));
        this.mediumTtxMaxSeconds = Math.max(this.shortTtxMaxSeconds, Number(options.mediumTtxMaxSeconds ?? process.env.MEDIUM_TTX_MAX_SECONDS ?? 14400));
        this.shortTtxEntryThreshold = this._parseOptionalNumber(options.shortTtxEntryThreshold ?? process.env.SHORT_TTX_ENTRY_THRESHOLD);
        this.mediumTtxEntryThreshold = this._parseOptionalNumber(options.mediumTtxEntryThreshold ?? process.env.MEDIUM_TTX_ENTRY_THRESHOLD);
        this.longTtxEntryThreshold = this._parseOptionalNumber(options.longTtxEntryThreshold ?? process.env.LONG_TTX_ENTRY_THRESHOLD);
        this.shortTtxMinEdgeLive = this._parseOptionalNumber(options.shortTtxMinEdgeLive ?? process.env.SHORT_TTX_MIN_EDGE_LIVE) ?? 0.03;
        this.mediumTtxMinEdgeLive = this._parseOptionalNumber(options.mediumTtxMinEdgeLive ?? process.env.MEDIUM_TTX_MIN_EDGE_LIVE);
        this.longTtxMinEdgeLive = this._parseOptionalNumber(options.longTtxMinEdgeLive ?? process.env.LONG_TTX_MIN_EDGE_LIVE);
        this.sessionStartLiveDailyPnl = null;
        this.sessionStartTimeMs = null; // set in markSessionStart
        this.sessionStartBalance = null; // Gemini USD balance at session start
        this._liveTradableBalance = null;
        this._lastPreTradeGate = {
            ts: 0,
            allowed: true,
            reason: this.autonomous15mSession ? 'not_evaluated' : 'session_mode_disabled',
            details: {}
        };
    }

    _parseOptionalNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    getEffectiveLiveReserve(balance) {
        const numericBalance = Number(balance);
        if (!Number.isFinite(numericBalance)) return this.liveUsdReserve;
        const adaptiveReserveCap = Math.max(0, numericBalance * this.liveReserveFractionCap);
        return Math.max(0, Math.min(this.liveUsdReserve, adaptiveReserveCap));
    }

    getEffectiveLiveMinTradableBalance(balance) {
        const numericBalance = Number(balance);
        if (!Number.isFinite(numericBalance)) {
            return Math.max(this.liveMinTradableAbsFloor, this.liveMinTradableBalance);
        }
        const adaptiveMin = Math.max(this.liveMinTradableAbsFloor, numericBalance * this.liveMinTradableFraction);
        return Math.max(
            this.liveMinTradableAbsFloor,
            Math.min(this.liveMinTradableBalance, adaptiveMin)
        );
    }

    getLiveBalancePolicy(balance) {
        const numericBalance = Number(balance);
        const effectiveReserve = this.getEffectiveLiveReserve(numericBalance);
        const effectiveMinTradable = this.getEffectiveLiveMinTradableBalance(numericBalance);
        const tradableBalance = Number.isFinite(numericBalance)
            ? Math.max(0, numericBalance - effectiveReserve)
            : null;

        return {
            configured: {
                reserve_usd: this.liveUsdReserve,
                min_tradable_balance: this.liveMinTradableBalance,
                reserve_fraction_cap: this.liveReserveFractionCap,
                min_tradable_fraction: this.liveMinTradableFraction,
                min_tradable_abs_floor: this.liveMinTradableAbsFloor
            },
            effective: {
                reserve_usd: effectiveReserve,
                min_tradable_balance: effectiveMinTradable
            },
            tradable_balance: Number.isFinite(tradableBalance) ? tradableBalance : null
        };
    }

    getTradableLiveBalance(balance) {
        const numericBalance = Number(balance);
        if (!Number.isFinite(numericBalance)) return null;
        const reserve = this.getEffectiveLiveReserve(numericBalance);
        return Math.max(0, numericBalance - reserve);
    }

    hasTradableLiveBalance(balance) {
        const numericBalance = Number(balance);
        const tradable = this.getTradableLiveBalance(balance);
        const minTradable = this.getEffectiveLiveMinTradableBalance(numericBalance);
        return Number.isFinite(tradable) && tradable >= minTradable;
    }

    markSessionStart(liveDailyPnl = null, startBalance = null) {
        const parsed = Number(liveDailyPnl);
        this.sessionStartLiveDailyPnl = Number.isFinite(parsed) ? parsed : 0;
        const parsedBalance = Number(startBalance);
        this.sessionStartBalance = Number.isFinite(parsedBalance) ? parsedBalance : null;
        this.sessionStartTimeMs = Date.now();
        this._lastPreTradeGate = {
            ts: 0,
            allowed: true,
            reason: this.autonomous15mSession ? 'not_evaluated' : 'session_mode_disabled',
            details: {}
        };
    }

    resetSessionState(reason = 'session_reset') {
        this.sessionStartLiveDailyPnl = null;
        this.sessionStartBalance = null;
        this.sessionStartTimeMs = null;
        this.liveCanaryOrdersPlaced = 0;
        this.liveCanaryStopReason = null;
        this._lastPreTradeGate = {
            ts: Date.now(),
            allowed: true,
            reason,
            details: {
                session_reset: true
            }
        };
    }

    getSessionPolicy() {
        const elapsedMs = this.sessionStartTimeMs ? Date.now() - this.sessionStartTimeMs : null;
        return {
            enabled: this.autonomous15mSession,
            loss_limit_usd: this.sessionLossLimitUsd,
            profit_target_usd: this.sessionProfitTargetUsd,
            timeout_ms: this.sessionTimeoutMs,
            elapsed_ms: elapsedMs,
            min_ttx_seconds: this.sessionMinTtxSeconds,
            max_ttx_seconds: this.sessionMaxTtxSeconds,
            allow_long_ttx_in_15m_session: this.allowLongTtxIn15mSession,
            entry_buffer_seconds: this.sessionEntryBufferSeconds,
            force_exit_buffer_seconds: this.sessionForceExitBufferSeconds,
            min_entry_ttx_seconds: this.getMinEntryTtxSeconds(),
            required_session_remaining_seconds: this.getRequiredSessionRemainingSeconds(),
            required_remaining_floor_seconds: this.sessionRequiredRemainingFloorSeconds,
            required_remaining_cap_seconds: this.sessionRequiredRemainingCapSeconds,
            max_concurrent_live: this.sessionMaxConcurrentLive,
            live_usd_reserve: this.liveUsdReserve,
            live_min_tradable_balance: this.liveMinTradableBalance,
            live_usd_reserve_fraction_cap: this.liveReserveFractionCap,
            live_min_tradable_balance_fraction: this.liveMinTradableFraction,
            live_min_tradable_balance_abs_floor: this.liveMinTradableAbsFloor,
            live_low_balance_sizing_threshold_usd: this.liveLowBalanceSizingThresholdUsd,
            live_low_balance_sizing_pct: this.liveLowBalanceSizingPct,
            live_canary_mode: this.liveCanaryMode,
            live_canary_max_position_size_usd: this.liveCanaryMaxPositionSizeUsd,
            live_canary_max_orders_per_session: this.liveCanaryMaxOrdersPerSession,
            live_canary_stop_on_exit_failure: this.liveCanaryStopOnExitFailure,
            live_canary_orders_placed: this.liveCanaryOrdersPlaced,
            live_canary_stop_reason: this.liveCanaryStopReason,
            gate_cache_ms: this.preTradeGateCacheMs,
            session_start_live_daily_pnl: this.sessionStartLiveDailyPnl,
            session_start_time_ms: this.sessionStartTimeMs,
            session_start_balance: this.sessionStartBalance
        };
    }

    _triggerCanaryStop(reason, details = {}) {
        if (!this.liveCanaryMode || !this.liveCanaryStopOnExitFailure) return;
        this.liveCanaryStopReason = reason;
        this.isRunning = false;
        this.logger.error(`LIVE CANARY HALT: ${reason} ${JSON.stringify(details)}`);
    }

    getSessionSanityChecks() {
        const checks = [];
        if (!this.autonomous15mSession) {
            return {
                ok: true,
                checks: [{ key: 'session_mode', ok: true, severity: 'info', detail: 'autonomous_session_disabled' }]
            };
        }

        const preExpiryExitSeconds = Number(this.params.pre_expiry_exit_seconds || 300);
        const entryBufferSeconds = this.sessionEntryBufferSeconds;
        const minEntryTtxSeconds = this.getMinEntryTtxSeconds();
        const ttxConflict = minEntryTtxSeconds > this.sessionMaxTtxSeconds;

        checks.push({
            key: 'ttx_policy_conflict',
            ok: !ttxConflict,
            severity: ttxConflict ? 'error' : 'info',
            detail: ttxConflict
                ? `min_entry_ttx_${minEntryTtxSeconds}s_gt_session_max_ttx_${this.sessionMaxTtxSeconds}s`
                : `min_entry_ttx_${minEntryTtxSeconds}s_within_session_window`,
            values: {
                pre_expiry_exit_seconds: preExpiryExitSeconds,
                entry_buffer_seconds: entryBufferSeconds,
                min_entry_ttx_seconds: minEntryTtxSeconds,
                session_min_ttx_seconds: this.sessionMinTtxSeconds,
                session_max_ttx_seconds: this.sessionMaxTtxSeconds
            }
        });

        const edgeFloor = Number(this.params.min_edge_live || 0.05);
        const edgeOutOfBand = edgeFloor < 0.02 || edgeFloor > 0.15;
        checks.push({
            key: 'min_edge_live_band',
            ok: !edgeOutOfBand,
            severity: edgeOutOfBand ? 'warn' : 'info',
            detail: edgeOutOfBand
                ? `min_edge_live_${edgeFloor}_outside_recommended_band_0.02_to_0.15`
                : `min_edge_live_${edgeFloor}_within_recommended_band`,
            values: { min_edge_live: edgeFloor }
        });

        return {
            ok: checks.every(c => c.ok || c.severity !== 'error'),
            checks
        };
    }

    getReadinessBlockers() {
        const blockers = [];
        const sanity = this.getSessionSanityChecks();
        const errorSanityChecks = (sanity.checks || []).filter(check => !check.ok && check.severity === 'error');
        for (const check of errorSanityChecks) {
            blockers.push(`sanity:${check.key}:${check.detail}`);
        }

        if (this.autonomous15mSession) {
            if (this._lastPreTradeGate && this._lastPreTradeGate.allowed === false) {
                blockers.push(`pre_trade_gate:${this._lastPreTradeGate.reason || 'blocked'}`);
            }

            const isLiveMode = this.gemini && (this.gemini.mode === 'live' || this.gemini.mode === 'sandbox');
            if (isLiveMode && !Number.isFinite(Number(this._liveBalance))) {
                blockers.push('live_balance:unavailable');
            }
            if (isLiveMode && Number.isFinite(Number(this._liveBalance))) {
                const tradable = Number.isFinite(Number(this._liveTradableBalance))
                    ? Number(this._liveTradableBalance)
                    : this.getTradableLiveBalance(this._liveBalance);
                const minTradable = this.getEffectiveLiveMinTradableBalance(this._liveBalance);
                if (!Number.isFinite(tradable) || tradable < minTradable) {
                    blockers.push(`live_balance:below_reserve_floor_${minTradable.toFixed(2)}`);
                }
            }
        }

        return blockers;
    }

    _isEligible15mSessionMarket(marketId) {
        if (!marketId || !marketId.startsWith('GEMI-')) return false;
        const ttx = this._getTTXSeconds(marketId);
        if (ttx === null || ttx <= 0) return false;
        if (ttx < this.sessionMinTtxSeconds) return false;
        if (!this.allowLongTtxIn15mSession && ttx > this.sessionMaxTtxSeconds) return false;
        return true;
    }

    async evaluatePreTradeSafetyGate(force = false) {
        if (!this.autonomous15mSession) {
            this._lastPreTradeGate = {
                ts: Date.now(),
                allowed: true,
                reason: 'session_mode_disabled',
                details: {}
            };
            return this._lastPreTradeGate;
        }

        const now = Date.now();
        if (!force && this._lastPreTradeGate.ts && (now - this._lastPreTradeGate.ts) < this.preTradeGateCacheMs) {
            return this._lastPreTradeGate;
        }

        try {
            const isLiveMode = this.gemini.mode === 'live' || this.gemini.mode === 'sandbox';
            const sessionMode = isLiveMode ? 'live' : 'paper';
            const paperWallet = !isLiveMode ? this.db.getWallet() : null;

            const [recon, openOrders, sessionDaily, currentBalanceRaw] = await Promise.all([
                isLiveMode
                    ? this.reconcilePositions()
                    : Promise.resolve({ skipped: true, orphaned: [], phantom: [], quantityMismatch: [] }),
                isLiveMode ? this.gemini.getOpenOrders() : Promise.resolve([]),
                Promise.resolve(this.db.getDailyPnL(sessionMode)),
                isLiveMode
                    ? this.gemini.getAvailableBalance().catch(() => null)
                    : Promise.resolve(paperWallet?.balance ?? null)
            ]);

            const nonPendingPhantom = (recon.phantom || []).filter(p => !p.pendingExit && !p.transientGrace);
            const unresolved = {
                orphaned: (recon.orphaned || []).length,
                phantom: nonPendingPhantom.length,
                qtyMismatch: (recon.quantityMismatch || []).length,
                openOrders: (openOrders || []).length
            };

            if (unresolved.orphaned > 0 || unresolved.phantom > 0 || unresolved.qtyMismatch > 0 || unresolved.openOrders > 0) {
                this._lastPreTradeGate = {
                    ts: now,
                    allowed: false,
                    reason: 'reconcile_not_clean',
                    details: unresolved
                };
                return this._lastPreTradeGate;
            }

            const sessionDailyPnl = Number(sessionDaily?.daily_pnl || 0);
            const baseline = Number.isFinite(this.sessionStartLiveDailyPnl)
                ? this.sessionStartLiveDailyPnl
                : sessionDailyPnl;
            const dbDelta = sessionDailyPnl - baseline;
            const hasFiniteBalanceRaw =
                currentBalanceRaw !== null &&
                currentBalanceRaw !== undefined &&
                Number.isFinite(Number(currentBalanceRaw));
            const currentBalance = hasFiniteBalanceRaw ? Number(currentBalanceRaw) : null;
            const tradableBalance = Number.isFinite(currentBalance)
                ? this.getTradableLiveBalance(currentBalance)
                : null;
            const effectiveReserveUsd = Number.isFinite(currentBalance)
                ? this.getEffectiveLiveReserve(currentBalance)
                : this.liveUsdReserve;
            const effectiveMinTradableUsd = Number.isFinite(currentBalance)
                ? this.getEffectiveLiveMinTradableBalance(currentBalance)
                : this.liveMinTradableBalance;
            const hasBalanceDelta = Number.isFinite(this.sessionStartBalance) && Number.isFinite(currentBalance);
            const sessionPnl = hasBalanceDelta ? (currentBalance - this.sessionStartBalance) : dbDelta;
            const sessionPnlSource = hasBalanceDelta ? 'balance_delta' : 'db_daily_delta';

            if (isLiveMode && (!Number.isFinite(tradableBalance) || tradableBalance < effectiveMinTradableUsd)) {
                this._lastPreTradeGate = {
                    ts: now,
                    allowed: false,
                    reason: 'live_balance_below_reserve_floor',
                    details: {
                        session_mode: sessionMode,
                        balance: Number.isFinite(currentBalance) ? currentBalance : null,
                        tradable_balance: Number.isFinite(tradableBalance) ? tradableBalance : null,
                        live_usd_reserve: this.liveUsdReserve,
                        live_min_tradable_balance: this.liveMinTradableBalance,
                        live_usd_reserve_effective: effectiveReserveUsd,
                        live_min_tradable_balance_effective: effectiveMinTradableUsd
                    }
                };
                return this._lastPreTradeGate;
            }

            // Check: session timeout
            if (this.sessionStartTimeMs && (now - this.sessionStartTimeMs) >= this.sessionTimeoutMs) {
                const elapsedMs = now - this.sessionStartTimeMs;
                this._lastPreTradeGate = {
                    ts: now,
                    allowed: false,
                    reason: 'session_timeout',
                    details: {
                        elapsed_ms: elapsedMs,
                        timeout_ms: this.sessionTimeoutMs,
                        elapsed_minutes: (elapsedMs / 60000).toFixed(1),
                        session_mode: sessionMode,
                        session_daily_pnl: sessionDailyPnl,
                        session_pnl: sessionPnl,
                        session_pnl_source: sessionPnlSource,
                        session_start_balance: this.sessionStartBalance,
                        current_balance: Number.isFinite(currentBalance) ? currentBalance : null,
                        tradable_balance: Number.isFinite(tradableBalance) ? tradableBalance : null,
                        live_usd_reserve: this.liveUsdReserve,
                        live_usd_reserve_effective: effectiveReserveUsd,
                        live_min_tradable_balance_effective: effectiveMinTradableUsd
                    }
                };
                return this._lastPreTradeGate;
            }

            // Check: session profit target hit
            if (sessionPnl >= this.sessionProfitTargetUsd) {
                this._lastPreTradeGate = {
                    ts: now,
                    allowed: false,
                    reason: 'session_profit_target_hit',
                    details: {
                        session_mode: sessionMode,
                        session_daily_pnl: sessionDailyPnl,
                        session_start_live_daily_pnl: baseline,
                        session_pnl: sessionPnl,
                        profit_target_usd: this.sessionProfitTargetUsd,
                        session_pnl_source: sessionPnlSource,
                        session_start_balance: this.sessionStartBalance,
                        current_balance: Number.isFinite(currentBalance) ? currentBalance : null,
                        tradable_balance: Number.isFinite(tradableBalance) ? tradableBalance : null,
                        live_usd_reserve: this.liveUsdReserve,
                        live_usd_reserve_effective: effectiveReserveUsd,
                        live_min_tradable_balance_effective: effectiveMinTradableUsd
                    }
                };
                return this._lastPreTradeGate;
            }

            // Check: session loss limit hit
            if (sessionPnl <= -this.sessionLossLimitUsd) {
                this._lastPreTradeGate = {
                    ts: now,
                    allowed: false,
                    reason: 'session_loss_limit_hit',
                    details: {
                        session_mode: sessionMode,
                        session_daily_pnl: sessionDailyPnl,
                        session_start_live_daily_pnl: baseline,
                        session_pnl: sessionPnl,
                        loss_limit_usd: this.sessionLossLimitUsd,
                        session_pnl_source: sessionPnlSource,
                        session_start_balance: this.sessionStartBalance,
                        current_balance: Number.isFinite(currentBalance) ? currentBalance : null,
                        tradable_balance: Number.isFinite(tradableBalance) ? tradableBalance : null,
                        live_usd_reserve: this.liveUsdReserve,
                        live_usd_reserve_effective: effectiveReserveUsd,
                        live_min_tradable_balance_effective: effectiveMinTradableUsd
                    }
                };
                return this._lastPreTradeGate;
            }

            this._lastPreTradeGate = {
                ts: now,
                allowed: true,
                reason: 'ok',
                details: {
                    unresolved,
                    session_mode: sessionMode,
                    session_daily_pnl: sessionDailyPnl,
                    session_start_live_daily_pnl: baseline,
                    session_pnl: sessionPnl,
                    session_pnl_source: sessionPnlSource,
                    session_start_balance: this.sessionStartBalance,
                    current_balance: Number.isFinite(currentBalance) ? currentBalance : null,
                    tradable_balance: Number.isFinite(tradableBalance) ? tradableBalance : null,
                    live_usd_reserve: this.liveUsdReserve,
                    live_min_tradable_balance: this.liveMinTradableBalance,
                    live_usd_reserve_effective: effectiveReserveUsd,
                    live_min_tradable_balance_effective: effectiveMinTradableUsd,
                    loss_limit_usd: this.sessionLossLimitUsd,
                    profit_target_usd: this.sessionProfitTargetUsd,
                    elapsed_ms: this.sessionStartTimeMs ? now - this.sessionStartTimeMs : null,
                    timeout_ms: this.sessionTimeoutMs
                }
            };
            return this._lastPreTradeGate;
        } catch (e) {
            // Fail closed: if gate checks cannot run, do not allow new entries.
            this._lastPreTradeGate = {
                ts: now,
                allowed: false,
                reason: 'gate_check_error',
                details: { error: e.message }
            };
            return this._lastPreTradeGate;
        }
    }

    getMinEntryTtxSeconds() {
        const preExpiryExitSeconds = Number(this.params.pre_expiry_exit_seconds || 300);
        return preExpiryExitSeconds + this.sessionEntryBufferSeconds;
    }

    getSessionTimeRemainingSeconds(nowMs = Date.now()) {
        if (!this.sessionStartTimeMs) return null;
        return Math.max(0, (this.sessionTimeoutMs - (nowMs - this.sessionStartTimeMs)) / 1000);
    }

    getRequiredSessionRemainingSeconds() {
        return Math.max(
            this.sessionRequiredRemainingFloorSeconds,
            Math.min(this.getMinEntryTtxSeconds(), this.sessionRequiredRemainingCapSeconds)
        );
    }

    getPreExpiryExitSeconds(timeToExpiry) {
        const base = Number(this.params.pre_expiry_exit_seconds || 300);
        if (!this.autonomous15mSession || !Number.isFinite(timeToExpiry) || timeToExpiry <= 0) {
            return base;
        }

        return Math.max(60, Math.min(base, Math.floor(timeToExpiry * 0.25)));
    }

    normalizeTradingProfile(profile) {
        const normalized = String(profile || 'standard').trim().toLowerCase();
        if (['short', 'short-run', 'session', 'session-run', '15m', '15m-session', 'short-horizon'].includes(normalized)) {
            return 'short-run';
        }
        return 'standard';
    }

    getTradingProfileOverrides(profile) {
        if (profile === 'short-run') {
            return {
                hold_to_settlement: 0,
                max_hold_time: 480,
                high_score_min_hold_time: 600,
                pre_expiry_exit_seconds: 180,
                time_decay_start_fraction: 0.55
            };
        }

        return {};
    }

    /**
     * Check if a market ID is a short-TTX contract (< 2h to expiry).
     * 15-min, hourly, and near-expiry contracts return true.
     */
    _isShortTTX(marketId) {
        const ttx = this._getTTXSeconds(marketId);
        return ttx !== null && ttx > 0 && ttx < 7200; // < 2 hours
    }

    /**
     * Get time-to-expiry in seconds for a GEMI market ID. Returns null if unparseable.
     */
    _getTTXSeconds(marketId) {
        if (!marketId) return null;
        const m = marketId.match(/GEMI-\w+?(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
        if (!m) return null;
        const [, yy, mm, dd, hh, mn] = m;
        const expiry = new Date(`20${yy}-${mm}-${dd}T${hh}:${mn}:00Z`);
        return (expiry.getTime() - Date.now()) / 1000;
    }

    _getTTXBucket(ttxSeconds) {
        if (!Number.isFinite(ttxSeconds) || ttxSeconds <= 0) return 'unknown';
        if (ttxSeconds <= this.shortTtxMaxSeconds) return 'short';
        if (ttxSeconds <= this.mediumTtxMaxSeconds) return 'medium';
        return 'long';
    }

    getSignalEntryPolicy(signal = {}) {
        const ttxSeconds = this._getTTXSeconds(signal.marketId);
        const bucket = this._getTTXBucket(ttxSeconds);
        const baseEntryThreshold = Math.max(Number(this.params.entry_threshold || 45), 40);
        const baseMinEdgeLive = Math.max(Number(this.params.min_edge_live || 0.05), 0.02);

        let entryThreshold = baseEntryThreshold;
        let minEdgeLive = baseMinEdgeLive;

        if (bucket === 'short') {
            entryThreshold = Math.max(this.shortTtxEntryThreshold ?? baseEntryThreshold, 40);
            minEdgeLive = Math.max(this.shortTtxMinEdgeLive ?? baseMinEdgeLive, 0.02);
        } else if (bucket === 'medium') {
            entryThreshold = Math.max(this.mediumTtxEntryThreshold ?? baseEntryThreshold, 40);
            minEdgeLive = Math.max(this.mediumTtxMinEdgeLive ?? baseMinEdgeLive, 0.02);
        } else if (bucket === 'long') {
            entryThreshold = Math.max(this.longTtxEntryThreshold ?? baseEntryThreshold, 40);
            minEdgeLive = Math.max(this.longTtxMinEdgeLive ?? baseMinEdgeLive, 0.02);
        }

        return {
            ttxSeconds,
            bucket,
            entryThreshold,
            minEdgeLive
        };
    }

    async _getLiveContractsAvailable(symbol, direction) {
        try {
            const positions = await this.gemini.getPositions();
            const desiredOutcome = String(direction || '').toLowerCase();

            // Prefer exact symbol+outcome match
            let pos = (positions || []).find(p =>
                p.symbol === symbol && String(p.outcome || '').toLowerCase() === desiredOutcome
            );

            // Fallback: symbol-only (some API payloads can be inconsistent during transitions)
            if (!pos) {
                pos = (positions || []).find(p => p.symbol === symbol);
            }

            if (!pos) return 0;

            const total = Number(pos.totalQuantity || 0);
            const onHold = Number(pos.quantityOnHold || 0);
            return Math.max(0, Math.floor(total - onHold));
        } catch (err) {
            this.logger.debug(`Live contracts lookup failed for ${symbol}: ${err.message}`);
            return 0;
        }
    }

    async _hasExchangePosition(symbol) {
        try {
            const positions = await this.gemini.getPositions();
            return (positions || []).some(p => {
                if (p.symbol !== symbol) return false;
                const total = Number(p.totalQuantity || 0);
                return total > 0;
            });
        } catch (err) {
            this.logger.debug(`Exchange position check failed for ${symbol}: ${err.message}`);
            return true; // fail-safe: assume position may exist; do not close DB
        }
    }

    /**
     * Log an entry rejection to the database for data analysis.
     * Called whenever enterPosition() rejects a signal.
     */
    logEntryRejection(signal, stage, reason, extras = {}) {
        try {
            const isRealInstrument = signal.marketId && signal.marketId.startsWith('GEMI-');
            const isLive = (this.gemini.mode === 'live' || this.gemini.mode === 'sandbox') && isRealInstrument;
            const details = extras && Object.keys(extras).length > 0 ? extras : null;
            this.db.insertEntryRejection({
                timestamp: Math.floor(Date.now() / 1000),
                gemini_market_id: signal.marketId || 'unknown',
                signal_score: signal.score || null,
                direction: signal.direction || null,
                rejection_stage: stage,
                rejection_reason: reason,
                entry_price_est: extras.entryPrice || null,
                edge_est: extras.edge || null,
                rejection_details: details,
                mode: isLive ? 'live' : 'paper'
            });
        } catch (e) {
            // Don't crash on rejection logging failures
        }
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
            hold_to_settlement: 1,
            pre_expiry_exit_seconds: 300,
            high_score_min_hold_time: 14400,
            time_decay_start_fraction: 0.80,
            kelly_multiplier: 0.15,
            max_concurrent_positions: 5,
            max_position_size: 100,
            max_capital_at_risk_pct: 50,
            slippage_penalty: 0.005,
            daily_loss_limit: -50,
            // V19: Live-specific parameters for parallel paper+live operation
            live_max_position_size: 1,
            live_daily_loss_limit: -5,
            live_max_concurrent: 3,
            paper_max_concurrent: 5,
            min_edge_live: 0.05,
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
            return { ...params, ...this.profileOverrides };
        } catch (e) {
            return { ...defaults, ...this.profileOverrides };
        }
    }

    getTradeTimingConfig(trade, currentMid, nowMs = Date.now()) {
        let maxHold = this.params.max_hold_time;
        let timeToExpiry = null;

        const expiryMatch = trade.gemini_market_id.match(/GEMI-\w+?(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
        if (expiryMatch) {
            const [, yy, mm, dd, hh, mn] = expiryMatch;
            const expiry = new Date(`20${yy}-${mm}-${dd}T${hh}:${mn}:00Z`);
            timeToExpiry = (expiry.getTime() - nowMs) / 1000;
            if (this.params.hold_to_settlement && timeToExpiry > 0) {
                maxHold = Math.max(maxHold, timeToExpiry * 0.80);
            }
            // For short-lived contracts (< max_hold_time), cap maxHold so time_exit
            // works as a backstop — don't let a 15M contract occupy a slot for 2h
            if (timeToExpiry > 0 && timeToExpiry < maxHold) {
                maxHold = timeToExpiry * 0.95;
            }
        }

        const highScoreMinHold = this.params.high_score_min_hold_time || 0;
        if (trade.opportunity_score >= 70 && highScoreMinHold > 0) {
            maxHold = Math.max(maxHold, highScoreMinHold);
        }

        const sessionTimeRemaining = this.getSessionTimeRemainingSeconds(nowMs);
        if (this.autonomous15mSession && sessionTimeRemaining !== null) {
            const sessionHoldCap = Math.max(60, sessionTimeRemaining - this.sessionForceExitBufferSeconds);
            maxHold = Math.min(maxHold, sessionHoldCap);
        }

        const holdTime = Math.floor(nowMs / 1000) - trade.timestamp;
        const decayStartFraction = Math.max(
            0.50,
            Math.min(0.95, this.params.time_decay_start_fraction || 0.80)
        );
        const decayFraction = holdTime / Math.max(1, maxHold);

        // SL is exit-price-based (entry_price - slDistance), direction-agnostic.
        // Time-decay tightens by reducing allowed loss distance from entry.
        let effectiveStopLoss = trade.stop_loss_price;
        if (decayFraction >= decayStartFraction) {
            const decayRange = Math.max(0.01, 1 - decayStartFraction);
            const tightenProgress = Math.min(1, (decayFraction - decayStartFraction) / decayRange);
            const slDistance = trade.entry_price - trade.stop_loss_price;
            if (slDistance > 0) {
                const tightenedDistance = slDistance * (1 - tightenProgress * 0.50);
                effectiveStopLoss = trade.entry_price - tightenedDistance;
            }
        }

        return {
            holdTime,
            maxHold,
            timeToExpiry,
            sessionTimeRemaining,
            decayFraction,
            effectiveStopLoss,
            preExpiryExitSeconds: this.getPreExpiryExitSeconds(timeToExpiry)
        };
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
        if (isLive && this._liveBalance == null && this._liveTradableBalance == null) {
            return 0;
        }
        const effectiveBalance = isLive
            ? (
                this._liveTradableBalance != null
                    ? this._liveTradableBalance
                    : this.getTradableLiveBalance(this._liveBalance)
            )
            : wallet.balance;
        if (!Number.isFinite(Number(effectiveBalance)) || Number(effectiveBalance) <= 0) {
            return 0;
        }
        const liveMaxPos = this.params.live_max_position_size || 2;
        const liveSizingPct = isLive && effectiveBalance <= this.liveLowBalanceSizingThresholdUsd
            ? this.liveLowBalanceSizingPct
            : 0.10;
        const maxPerTrade = isLive
            ? Math.min(liveMaxPos, effectiveBalance * liveSizingPct)
            : this.params.max_position_size;
        const canaryMaxPerTrade = (isLive && this.liveCanaryMode)
            ? Math.min(maxPerTrade, this.liveCanaryMaxPositionSizeUsd)
            : maxPerTrade;

        // If signal has pre-computed Kelly fraction (from FairValueEngine), use it directly
        if (signal.kellyFraction && signal.kellyFraction > 0) {
            let positionSize = effectiveBalance * signal.kellyFraction;
            positionSize = Math.min(positionSize, canaryMaxPerTrade);
            positionSize = Math.min(positionSize, effectiveBalance * this.params.max_capital_at_risk_pct / 100);
            // Depth cap: max 10% of real ask depth
            const askDepth0 = signal.gemini_ask_depth || signal.ask_depth || null;
            if (askDepth0 && askDepth0 > 0) {
                positionSize = Math.min(positionSize, askDepth0 * 0.10);
            }
            positionSize = Math.max(positionSize, this.liveCanaryMode && isLive ? 0.01 : 1); // Minimum size
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
            const minSize = this.liveCanaryMode && isLive ? 0.01 : 1;
            return Math.max(minSize, Math.min(baseSize, canaryMaxPerTrade));
        }

        // Kelly calculation with edge
        const winProb = Math.min(0.8, 0.5 + signal.score / 200);
        const payout = edge / Math.max(0.01, entryPrice);
        const edgeRatio = (winProb * payout - (1 - winProb) * this.params.stop_loss_width) / Math.max(0.01, payout);
        const kelly = Math.max(0, edgeRatio) * this.params.kelly_multiplier;

        let positionSize = effectiveBalance * kelly;

        // Apply limits
        positionSize = Math.min(positionSize, canaryMaxPerTrade);
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

        positionSize = Math.max(positionSize, this.liveCanaryMode && isLive ? 0.01 : 1); // Minimum size

        return parseFloat(positionSize.toFixed(2));
    }

    /**
     * Check if we can enter a new position
     */
    canEnterPosition(signal) {
        // Determine if this signal would route to live or paper
        const isLiveSignal = (this.gemini.mode === 'live' || this.gemini.mode === 'sandbox')
            && signal.marketId && signal.marketId.startsWith('GEMI-');

        if (this.autonomous15mSession && isLiveSignal) {
            const ttx = this._getTTXSeconds(signal.marketId);
            if (ttx === null) {
                return {
                    allowed: false,
                    reason: `15m_session_ttx_unparseable (${signal.marketId})`
                };
            }
            if (ttx <= 0) {
                return {
                    allowed: false,
                    reason: `15m_session_ttx_expired (${Math.round(ttx)}s)`
                };
            }
            if (ttx < this.sessionMinTtxSeconds || (!this.allowLongTtxIn15mSession && ttx > this.sessionMaxTtxSeconds)) {
                return {
                    allowed: false,
                    reason: `15m_session_ttx_filter (ttx=${Math.round(ttx)}s, allowed ${this.sessionMinTtxSeconds}-${this.sessionMaxTtxSeconds}s)`
                };
            }

            const sessionTimeRemaining = this.getSessionTimeRemainingSeconds();
            const minSessionRemaining = this.getRequiredSessionRemainingSeconds();
            if (sessionTimeRemaining !== null && sessionTimeRemaining < minSessionRemaining) {
                return {
                    allowed: false,
                    reason: `session_time_remaining_too_short (${Math.round(sessionTimeRemaining)}s < ${minSessionRemaining}s)`
                };
            }
        }

        // Check open positions with mode-aware concurrent limits
        const openTrades = this.db.getOpenTrades();
        if (isLiveSignal) {
            const liveOpen = openTrades.filter(t => t.mode === 'live');
            const liveMax = this.autonomous15mSession
                ? this.sessionMaxConcurrentLive
                : (this.params.live_max_concurrent || 3);
            if (liveOpen.length >= liveMax) {
                return { allowed: false, reason: `Max ${liveMax} concurrent live positions reached` };
            }
            if (this.liveCanaryMode && this.liveCanaryOrdersPlaced >= this.liveCanaryMaxOrdersPerSession) {
                return {
                    allowed: false,
                    reason: `Live canary order cap reached (${this.liveCanaryOrdersPlaced}/${this.liveCanaryMaxOrdersPerSession})`
                };
            }
        } else {
            const paperOpen = openTrades.filter(t => t.mode === 'paper');
            const paperMax = this.params.paper_max_concurrent || 5;
            if (paperOpen.length >= paperMax) {
                return { allowed: false, reason: `Max ${paperMax} concurrent paper positions reached` };
            }
        }

        // Check category concentration (max positions per category = live_max_concurrent)
        const maxPerCategory = isLiveSignal ? (this.params.live_max_concurrent || 4) : 3;
        const categoryCount = openTrades.filter(t => t.category === signal.category).length;
        if (categoryCount >= maxPerCategory) {
            return { allowed: false, reason: `Max ${maxPerCategory} positions in ${signal.category} reached` };
        }

        // Check directional concentration within same asset/category
        // Allow up to half of max concurrent per direction
        // Exempt short-TTX contracts (< 2h to expiry) — they settle fast
        const isShortTTX = this._isShortTTX(signal.marketId);
        if (!isShortTTX) {
            const maxPerDirection = Math.ceil((this.params.live_max_concurrent || 15) / 2);
            if (signal.direction) {
                const sameDirCount = openTrades.filter(
                    t => t.category === signal.category && t.direction === signal.direction
                ).length;
                if (sameDirCount >= maxPerDirection) {
                    return { allowed: false, reason: `Max ${maxPerDirection} ${signal.direction} positions in ${signal.category}` };
                }
            }
        }

        // Check daily loss limit (mode-aware: live and paper tracked separately)
        if (isLiveSignal) {
            const liveDailyPnL = this.db.getDailyPnL('live');
            const liveLossLimit = this.params.live_daily_loss_limit || -5;
            if (liveDailyPnL && liveDailyPnL.daily_pnl < liveLossLimit) {
                return { allowed: false, reason: `Live daily loss limit hit: $${liveDailyPnL.daily_pnl.toFixed(2)}` };
            }
        } else {
            const dailyPnL = this.db.getDailyPnL();
            if (dailyPnL && dailyPnL.daily_pnl < this.params.daily_loss_limit) {
                return { allowed: false, reason: `Daily loss limit hit: $${dailyPnL.daily_pnl.toFixed(2)}` };
            }
        }

        // Check capital at risk and drawdown — paper wallet only applies to paper trades
        // Live trades are gated by real Gemini balance check in enterPosition()
        if (!isLiveSignal) {
            const wallet = this.db.getWallet();
            const totalAtRisk = openTrades.filter(t => t.mode === 'paper').reduce((sum, t) => sum + t.position_size, 0);
            if (totalAtRisk / wallet.balance > this.params.max_capital_at_risk_pct / 100) {
                return { allowed: false, reason: 'Max capital at risk exceeded' };
            }

            // Check drawdown kill switch (paper wallet below 80% of initial)
            if (wallet.balance < wallet.initial_balance * 0.8) {
                return { allowed: false, reason: 'Drawdown kill switch: balance below 80% of initial' };
            }
        }

        // Per-settlement-date concentration limit: max 8 positions per expiry
        // Prevents piling into one date while neglecting shorter-term contracts
        if (signal.marketId && signal.marketId.startsWith('GEMI-')) {
            const dateMatch = signal.marketId.match(/GEMI-\w+?(\d{10})-/);
            if (dateMatch) {
                const signalDate = dateMatch[1]; // e.g. "2603132100"
                const sameDateCount = openTrades.filter(t => {
                    const m = t.gemini_market_id && t.gemini_market_id.match(/GEMI-\w+?(\d{10})-/);
                    return m && m[1] === signalDate;
                }).length;
                if (sameDateCount >= 8) {
                    return { allowed: false, reason: `Max 8 positions for settlement date ${signalDate}` };
                }
            }
        }

        // Check for duplicate market
        const alreadyInMarket = openTrades.find(t => t.gemini_market_id === signal.marketId);
        if (alreadyInMarket) {
            return { allowed: false, reason: 'Already have position in this market' };
        }

        // Anti-churn: block re-entry to recently closed contracts (prevents enter→exit→re-enter loops)
        const lastClose = this._recentlyClosed.get(signal.marketId);
        if (lastClose && (Date.now() - lastClose) < 600000) { // 10-minute cooldown
            return { allowed: false, reason: 'Recently closed — 10min cooldown' };
        }

        // Minimum TTX guard: don't enter contracts too close to expiry
        // Prevents entering just to immediately trigger pre_expiry_exit
        const ttxSeconds = this._getTTXSeconds(signal.marketId);
        const minEntryTTX = this.getMinEntryTtxSeconds();
        if (ttxSeconds !== null && ttxSeconds > 0 && ttxSeconds < minEntryTTX) {
            return { allowed: false, reason: `TTX ${Math.round(ttxSeconds)}s < min ${minEntryTTX}s` };
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
            this.logEntryRejection(signal, 'canEnterPosition', canEnter.reason);
            return null;
        }

        // Block simulated markets: V18 backtest proved zero cross-platform edge.
        // Sim wins are noise from synthetic price oscillation, not real arbitrage.
        if (signal.marketId && !signal.marketId.startsWith('GEMI-')) {
            this.logEntryRejection(signal, 'sim_market_block', 'simulated_markets_disabled');
            return null;
        }

        // GEMI-* crypto: require Fair Value signal (netEdge or kellyFraction).
        // Composite-only signals use Poly reference which doesn't have matching
        // short-term binary contracts — produces 30c+ phantom edges.
        if (signal.marketId && signal.marketId.startsWith('GEMI-')) {
            const hasFVSignal = (signal.netEdge && signal.netEdge > 0) ||
                                (signal.kellyFraction && signal.kellyFraction > 0) ||
                                (signal.models && signal.models.blackScholes);
            if (!hasFVSignal) {
                this.logEntryRejection(signal, 'no_fv_signal', 'GEMI_requires_fair_value_confirmation');
                return null;
            }
        }

        // Autonomous 15m session narrowing: high-conviction trades only.
        if (this.autonomous15mSession && signal.marketId && signal.marketId.startsWith('GEMI-')) {
            const entryPolicy = this.getSignalEntryPolicy(signal);
            if (!this._isEligible15mSessionMarket(signal.marketId)) {
                this.logEntryRejection(signal, 'session_15m_filter', 'market_not_in_session_ttx_window', {
                    ttxSeconds: this._getTTXSeconds(signal.marketId),
                    sessionMinTtxSeconds: this.sessionMinTtxSeconds,
                    sessionMaxTtxSeconds: this.sessionMaxTtxSeconds
                });
                return null;
            }

            // Only fair_value signals are accepted in autonomous session mode.
            // Composite signals rely on Poly reference prices which don't have
            // matching short-term binary contracts — produces phantom 30c+ edges.
            if (signal.signalType !== 'fair_value') {
                this.logEntryRejection(signal, 'session_15m_filter', 'requires_fair_value_signal_type', {
                    signalType: signal.signalType || null
                });
                return null;
            }

            const scoreFloor = entryPolicy.entryThreshold;
            if ((signal.score || 0) < scoreFloor) {
                this.logEntryRejection(signal, 'session_15m_filter', `score_${signal.score || 0}_lt_${scoreFloor}`, {
                    scoreActual: signal.score || 0,
                    scoreFloor,
                    ttxBucket: entryPolicy.bucket
                });
                return null;
            }

            const netEdge = Number(signal.netEdge || signal.edge || 0);
            const edgeFloor = entryPolicy.minEdgeLive;
            if (netEdge < edgeFloor) {
                this.logEntryRejection(signal, 'session_15m_filter', `edge_${netEdge.toFixed(3)}_lt_${edgeFloor}`, {
                    edgeActual: netEdge,
                    edgeFloor,
                    ttxBucket: entryPolicy.bucket
                });
                return null;
            }

            const hasBlackScholes = !!(signal.models && signal.models.blackScholes);
            if (!hasBlackScholes) {
                this.logEntryRejection(signal, 'session_15m_filter', 'requires_black_scholes_confirmation', {
                    hasBlackScholes
                });
                return null;
            }
        }

        const wallet = this.db.getWallet();

        // Cache real Gemini balance for position sizing (used by calculatePositionSize)
        const isLive = this.gemini.mode === 'live' || this.gemini.mode === 'sandbox';
        if (isLive) {
            const realBal = await this.gemini.getAvailableBalance();
            if (!Number.isFinite(Number(realBal)) || Number(realBal) <= 0) {
                this.logEntryRejection(signal, 'live_balance', 'live_balance_unavailable_or_zero');
                return null;
            }
            this._liveBalance = Number(realBal);
            this._liveTradableBalance = this.getTradableLiveBalance(this._liveBalance);
            const effectiveReserveUsd = this.getEffectiveLiveReserve(this._liveBalance);
            const effectiveMinTradableUsd = this.getEffectiveLiveMinTradableBalance(this._liveBalance);
            if (!this.hasTradableLiveBalance(this._liveBalance)) {
                this.logEntryRejection(
                    signal,
                    'live_balance',
                    `tradable_${Number(this._liveTradableBalance || 0).toFixed(2)}_lt_${effectiveMinTradableUsd.toFixed(2)}`,
                    {
                        totalBalance: this._liveBalance,
                        tradableBalance: this._liveTradableBalance,
                        reserveUsd: effectiveReserveUsd,
                        reserveUsdConfigured: this.liveUsdReserve,
                        minTradableUsdConfigured: this.liveMinTradableBalance,
                        minTradableUsdEffective: effectiveMinTradableUsd
                    }
                );
                return null;
            }
        }

        const positionSize = this.calculatePositionSize(signal, wallet);
        const minPositionSize = (isLive && this.liveCanaryMode) ? 0.01 : 1;

        if (positionSize < minPositionSize) {
            this.logger.debug('Position size too small, skipping');
            this.logEntryRejection(signal, 'position_sizing', 'position_size_too_small');
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
                    : (1 - refPrice) - entryPriceEst;
                // For near-settlement contracts (< 2h), settlement exit = no exit spread,
                // so use 1× spread. For longer holds, use 2× (round-trip orderbook exit).
                let spreadMult = 2;
                if (signal.marketId) {
                    const ttxMatch = signal.marketId.match(/GEMI-\w+?(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
                    if (ttxMatch) {
                        const [, yy, mm, dd, hh, mn] = ttxMatch;
                        const expiry = new Date(`20${yy}-${mm}-${dd}T${hh}:${mn}:00Z`);
                        const ttx = (expiry.getTime() - Date.now()) / 1000;
                        if (ttx > 0 && ttx < 7200) spreadMult = 1; // Settlement exit, not orderbook
                    }
                }
                const roundTripSpreadCost = geminiSpread * spreadMult + 0.01;
                // For near-settlement (< 2h), stop loss is disabled, so don't require
                // edge > stop_loss_width. Just need to cover the entry spread cost.
                const slFloor = (spreadMult === 1) ? 0 : (this.params.stop_loss_width || 0.03);
                const minRequiredEdge = Math.max(slFloor, roundTripSpreadCost);
                if (edgeEst < minRequiredEdge) {
                    this.logger.debug(
                        `Spread-aware reject: ${signal.marketId} edge=${edgeEst.toFixed(3)} < ` +
                        `minRequired=${minRequiredEdge.toFixed(3)} (spread=${geminiSpread.toFixed(3)}, roundTrip=${roundTripSpreadCost.toFixed(3)})`
                    );
                    this.logEntryRejection(signal, 'spread_filter', `edge_${edgeEst.toFixed(3)}_lt_${minRequiredEdge.toFixed(3)}`, { entryPrice: entryPriceEst, edge: edgeEst });
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
            this.logEntryRejection(signal, 'no_leverage_guard', `cost_${entryPrice.toFixed(3)}_lt_0.05`, { entryPrice });
            return null;
        }

        // Min price guard: reject entries below $0.10 (for either direction).
        // Cheap contracts create extreme leverage (10:1+) and lottery-ticket risk.
        // A $0.04 entry turns $1 into 25 contracts — a 1¢ drop loses $0.25 (25%).
        if (entryPrice < 0.10) {
            this.logger.warn(
                `Min price guard: ${signal.direction} ${signal.marketId} ` +
                `entry=$${entryPrice.toFixed(3)} < $0.10 — too leveraged, rejected`
            );
            this.logEntryRejection(signal, 'min_price_guard', `entry_${entryPrice.toFixed(3)}_lt_0.10`, { entryPrice });
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
                    this.logEntryRejection(signal, 'deep_itm_guard', `NO_moneyness_${moneyness.toFixed(2)}`, { entryPrice });
                    return null;
                }
                if (moneyness < 0.80 && signal.direction === 'YES') {
                    this.logger.warn(
                        `Deep-OTM guard: BLOCKED YES on ${signal.marketId} — ` +
                        `spot=$${signal._spotPrice.toLocaleString()} is ${((1 - moneyness) * 100).toFixed(0)}% below ` +
                        `strike=$${strike.toLocaleString()}. This contract is near-certain NO.`
                    );
                    this.logEntryRejection(signal, 'deep_otm_guard', `YES_moneyness_${moneyness.toFixed(2)}`, { entryPrice });
                    return null;
                }
            }
        }

        // Contract count validation: need at least 1 contract
        const contractCount = Math.floor(positionSize / entryPrice);
        if (contractCount < 1) {
            this.logger.debug(`Position too small for 1 contract: $${positionSize.toFixed(2)} / $${entryPrice.toFixed(2)}`);
            this.logEntryRejection(signal, 'contract_count', 'less_than_1_contract', { entryPrice });
            return null;
        }

        let order;
        const isRealInstrument = signal.marketId && signal.marketId.startsWith('GEMI-');
        if ((this.gemini.mode === 'live' || this.gemini.mode === 'sandbox') && isRealInstrument) {
            // Hard liquidity gate: require two-sided book and reasonable spread.
            // EXCEPTION: For short-TTX contracts (<=3600s), Deribit options market IS the liquidity,
            // so we don't require Gemini Predictions two-sided book
            if (this.gemini.realClient) {
                const realPrices = this.gemini.realClient.getBestPrices(signal.marketId);
                const maxLiveSpread = this.autonomous15mSession ? 0.12 : 0.08;
                const ttx = this._getTTXSeconds(signal.marketId);
                const isShortTTX = ttx !== null && ttx > 0 && ttx <= 3600;
                
                if (!isShortTTX && (!realPrices || !realPrices.hasTwoSidedBook)) {
                    this.logger.debug(`Liquidity gate: ${signal.marketId} — no two-sided book, can't exit`);
                    this.logEntryRejection(signal, 'liquidity_gate', 'no_two_sided_book', { entryPrice });
                    return null;
                }
                if (realPrices.spread > maxLiveSpread) {
                    this.logger.debug(
                        `Liquidity gate: ${signal.marketId} — spread=$${realPrices.spread.toFixed(3)} > $${maxLiveSpread.toFixed(2)}`
                    );
                    this.logEntryRejection(signal, 'liquidity_gate', `spread_${realPrices.spread.toFixed(3)}_gt_${maxLiveSpread.toFixed(2)}`, { entryPrice });
                    return null;
                }
            }

            // Minimum edge for live trades (lower bar for short-TTX contracts)
            const entryPolicy = this.getSignalEntryPolicy(signal);
            const minEdgeLive = entryPolicy.minEdgeLive;
            const signalEdge = signal.netEdge || signal.edge || 0;
            if (signalEdge < minEdgeLive) {
                this.logger.debug(
                    `Live edge too low: ${signal.marketId} edge=${signalEdge.toFixed(3)} < ${minEdgeLive}`
                );
                this.logEntryRejection(signal, 'live_min_edge', `edge_${signalEdge.toFixed(3)}_lt_${minEdgeLive}`, {
                    entryPrice,
                    edge: signalEdge,
                    ttxBucket: entryPolicy.bucket
                });
                return null;
            }

            // Exchange-level position guard: check Gemini for existing position
            // Prevents accumulation across multiple DB trades on the same instrument
            try {
                if (Date.now() - this._exchangePositionsFetchTime > 10000) {
                    this._exchangePositions = await this.gemini.getPositions();
                    this._exchangePositionsFetchTime = Date.now();
                }
                const existingPos = this._exchangePositions.find(p => p.symbol === signal.marketId);
                if (existingPos && Number(existingPos.totalQuantity) > 0) {
                    this.logEntryRejection(signal, 'exchange_position', `already_${existingPos.totalQuantity}x_on_exchange`, { entryPrice });
                    return null;
                }
            } catch (err) {
                this.logger.debug(`Exchange position check failed: ${err.message}`);
            }

            // Rate-limit live orders: max 3 per cycle to prevent InsufficientFunds spam
            if (this.liveOrdersThisCycle >= this.maxLiveOrdersPerCycle) {
                this.logger.debug(
                    `Live order rate-limited: ${this.liveOrdersThisCycle}/${this.maxLiveOrdersPerCycle} this cycle`
                );
                this.logEntryRejection(signal, 'rate_limit', 'max_live_orders_per_cycle', { entryPrice });
                return null;
            }

            // Minimum balance check: query real Gemini balance for live trades
            const realBalance = await this.gemini.getAvailableBalance();
            const totalBalance = realBalance != null ? Number(realBalance) : Number(wallet.balance || 0);
            const tradableBalance = this.getTradableLiveBalance(totalBalance);
            const defaultMinTradableUsd = this.getEffectiveLiveMinTradableBalance(totalBalance);
            const effectiveMinTradableUsd = this.liveCanaryMode
                ? Math.min(defaultMinTradableUsd, this.liveCanaryMaxPositionSizeUsd)
                : defaultMinTradableUsd;
            this._liveBalance = Number.isFinite(totalBalance) ? totalBalance : this._liveBalance;
            this._liveTradableBalance = Number.isFinite(tradableBalance) ? tradableBalance : this._liveTradableBalance;
            if (!Number.isFinite(tradableBalance) || tradableBalance < effectiveMinTradableUsd) {
                if (!this._balanceRejectLogged) {
                    this.logger.warn(
                        `Live orders paused: tradable balance $${Number(tradableBalance || 0).toFixed(2)} ` +
                        `(total=$${Number(totalBalance || 0).toFixed(2)}, reserve=$${this.liveUsdReserve.toFixed(2)}, ` +
                        `need >= $${effectiveMinTradableUsd.toFixed(2)})` +
                        (realBalance != null ? ' [real Gemini balance]' : ' [paper wallet — Gemini API unavailable]')
                    );
                    this._balanceRejectLogged = true;
                }
                this.logEntryRejection(
                    signal,
                    'insufficient_balance',
                    `tradable_balance_${Number(tradableBalance || 0).toFixed(2)}_lt_${effectiveMinTradableUsd.toFixed(2)}`,
                    {
                        entryPrice,
                        totalBalance,
                        tradableBalance,
                        effectiveMinTradableUsd,
                        reserveUsd: this.liveUsdReserve
                    }
                );
                return null;
            }

            // Minimum score for live crypto trades (paper trades can use lower threshold)
            if (signal.score < 45) {
                this.logger.debug(
                    `Live crypto rejected: ${signal.marketId} score=${signal.score} (< 45)`
                );
                this.logEntryRejection(signal, 'live_min_score', `score_${signal.score}_lt_45`, { entryPrice });
                return null;
            }

            // Reject if Gemini bid/ask are undefined (no real orderbook data)
            if (signal.gemini_bid == null && signal.gemini_ask == null) {
                this.logger.debug(
                    `Live crypto rejected: ${signal.marketId} — no Gemini bid/ask data`
                );
                this.logEntryRejection(signal, 'live_no_orderbook', 'no_gemini_bid_ask', { entryPrice });
                return null;
            }

            // Live execution safeguard: reject trades where entry price > reference price
            // (means the arb edge is illusory or the Kalshi synthetic is stale)
            const refPrice = signal.referencePrice || signal.targetPrice;
            if (refPrice) {
                const edgeVsRef = signal.direction === 'YES'
                    ? refPrice - entryPrice
                    : (1 - refPrice) - entryPrice;
                if (edgeVsRef < 0.01) {
                    this.logger.warn(
                        `Live order rejected: ${signal.direction} ${signal.marketId} ` +
                        `entry=${entryPrice.toFixed(3)} ref=${refPrice.toFixed(3)} edge=${edgeVsRef.toFixed(3)} (< 1¢)`
                    );
                    this.logEntryRejection(signal, 'live_edge_vs_ref', `edge_${edgeVsRef.toFixed(3)}_lt_0.01`, { entryPrice, edge: edgeVsRef });
                    return null;
                }
            }

            // Reject NO orders where the cost per contract is unreasonable (> 85¢)
            // At $0.85+, risk/reward is terrible: pay $0.85 to maybe win $0.15
            if (signal.direction === 'NO' && entryPrice > 0.85) {
                this.logger.warn(
                    `Live NO order rejected: ${signal.marketId} entry=$${entryPrice.toFixed(3)} too expensive (> $0.85)`
                );
                this.logEntryRejection(signal, 'live_no_too_expensive', `entry_${entryPrice.toFixed(3)}_gt_0.85`, { entryPrice });
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
                if (this.liveCanaryMode) {
                    this.liveCanaryOrdersPlaced += 1;
                }

                // Verify the order was actually filled, not just accepted
                if (!order || !order.success) {
                    this.logger.error(
                        `Live order rejected by Gemini: ${signal.marketId} ` +
                        `status=${order?.orderStatus} — NO fallback, skipping trade`
                    );
                    this.logEntryRejection(signal, 'gemini_rejected', `status_${order?.orderStatus || 'null'}`, { entryPrice });
                    return null;
                }
                if (order.orderStatus !== 'filled' && !(Number(order.filledQuantity) > 0)) {
                    // Order returned as 'open' — Gemini may fill it moments later.
                    // Wait 3s and re-check via order history before cancelling.
                    this.logger.warn(
                        `Live order pending: ${signal.marketId} ` +
                        `orderId=${order.orderId} status=${order.orderStatus} ` +
                        `filled=${order.filledQuantity} — waiting 3s to re-check`
                    );
                    await new Promise(resolve => setTimeout(resolve, 3000));

                    // Re-check: look in order history for this orderId
                    let actuallyFilled = false;
                    try {
                        const history = await this.gemini.getOrderHistory();
                        const match = history.find(o => String(o.orderId) === String(order.orderId));
                        if (match && (match.status === 'filled' || Number(match.filledQuantity) > 0)) {
                            actuallyFilled = true;
                            order.orderStatus = 'filled';
                            order.filledQuantity = match.filledQuantity || order.filledQuantity;
                            if (match.avgExecutionPrice) {
                                order.fill_price = parseFloat(match.avgExecutionPrice);
                            }
                            this.logger.info(
                                `Live order CONFIRMED filled after re-check: ${signal.marketId} ` +
                                `orderId=${order.orderId} filled=${order.filledQuantity}`
                            );
                        }
                    } catch (histErr) {
                        this.logger.error(`Failed to re-check order status: ${histErr.message}`);
                    }

                    // Also check active orders — if still open, cancel it
                    if (!actuallyFilled) {
                        try {
                            const activeOrders = await this.gemini.getOpenOrders();
                            const stillOpen = activeOrders.find(o => String(o.orderId) === String(order.orderId));
                            if (stillOpen && Number(stillOpen.filledQuantity) > 0) {
                                actuallyFilled = true;
                                order.orderStatus = 'filled';
                                order.filledQuantity = stillOpen.filledQuantity;
                                this.logger.info(
                                    `Live order partially filled (active): ${signal.marketId} ` +
                                    `orderId=${order.orderId} filled=${order.filledQuantity}`
                                );
                            } else if (stillOpen) {
                                // Still open and unfilled — cancel it
                                await this.gemini.cancelOrder(order.orderId);
                                this.logger.warn(
                                    `Cancelled unfilled order: ${signal.marketId} orderId=${order.orderId}`
                                );
                            }
                        } catch (cancelErr) {
                            this.logger.error(`Failed to cancel/check unfilled order ${order.orderId}: ${cancelErr.message}`);
                        }
                    }

                    if (!actuallyFilled) {
                        this.logEntryRejection(signal, 'gemini_unfilled', `orderId_${order.orderId}`, { entryPrice });
                        return null;
                    }
                }
            } catch (err) {
                this.logger.error(
                    `LIVE ORDER FAILED — NOT falling back to paper: ${signal.marketId} ${err.message}`
                );
                this.logEntryRejection(signal, 'gemini_api_error', err.message.substring(0, 100), { entryPrice });
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
            this.logEntryRejection(signal, 'trade_execution', 'order_failed', { entryPrice });
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
        const targetOutcomePrice = signal.targetPrice != null
            ? (signal.direction === 'NO' ? (1 - signal.targetPrice) : signal.targetPrice)
            : null;

        // For settlement convergence trades (GEMI-* with hold_to_settlement),
        // set TP near settlement value ($1.00) instead of entry+3¢.
        // The pre_expiry_exit handles the actual exit timing.
        const isSettlementTrade = isRealInstrument && this.params.hold_to_settlement;
        const settlementTP = 0.95; // near-settlement target
        const entryTTX = this._getTTXSeconds(signal.marketId);
        const isShortDatedContract = entryTTX !== null && entryTTX > 0 && entryTTX < 3600; // < 1h
        let takeProfitPrice;
        if (isShortDatedContract) {
            // Short-dated contracts (15M, hourly): realistic TP, not $0.95
            takeProfitPrice = order.fill_price + 0.08; // 8¢ profit target
        } else if (isSettlementTrade) {
            // Settlement convergence: aim for near-$1 but always at least entry + 5¢
            takeProfitPrice = Math.max(settlementTP, order.fill_price + 0.05);
        } else if (signal.direction === 'YES') {
            const minTP = order.fill_price + minProfit;
            takeProfitPrice = targetOutcomePrice != null
                ? Math.max(targetOutcomePrice, minTP)
                : order.fill_price + 0.03;
        } else {
            // NO contracts profit when NO price rises.
            const minTP = order.fill_price + minProfit;
            takeProfitPrice = targetOutcomePrice != null
                ? Math.max(targetOutcomePrice, minTP)
                : order.fill_price + 0.03;
        }
        // Stop loss: symmetric with TP, based on entry fill price (not mid).
        // SL distance = TP distance, capped at 10¢. This ensures ~1:1 risk/reward.
        // exitPrice (bid for YES, 1-ask for NO) is checked against SL in monitorPositions.
        const tpDistance = takeProfitPrice - order.fill_price;
        const slDistance = Math.min(Math.max(tpDistance, 0.05), 0.10); // 5¢ floor, 10¢ cap
        const stopLossPrice = Math.max(0.01, order.fill_price - slDistance);

        // For live orders, compute actual cost from filled contracts × fill price.
        // positionSize is the budget ($2), but we buy whole contracts:
        //   Math.floor($2 / $0.77) = 2 contracts, actual cost = 2 × $0.77 = $1.54
        const filledQty = order.filledQuantity ? Number(order.filledQuantity) : 0;
        const actualPositionSize = (order.live && filledQty > 0)
            ? filledQty * order.fill_price
            : positionSize;

        // Record trade in DB
        const tradeId = this.db.insertTrade({
            timestamp: Math.floor(Date.now() / 1000),
            gemini_market_id: signal.marketId,
            market_title: signal.title,
            category: signal.category,
            trade_state: 'ENTERED',
            direction: signal.direction,
            entry_price: order.fill_price,
            position_size: actualPositionSize,
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
        const contracts = filledQty > 0 ? filledQty : Math.floor(positionSize / order.fill_price);
        this.logger.info(
            `ENTRY: ${signal.direction} on "${signal.title}" ` +
            `@ ${order.fill_price.toFixed(3)} (${contracts}x = $${actualPositionSize.toFixed(2)}) ` +
            `Score=${signal.score} TP=${takeProfitPrice.toFixed(3)} SL=${stopLossPrice.toFixed(3)}`
        );

        return { tradeId, order, positionSize: actualPositionSize, takeProfitPrice, stopLossPrice };
    }

    /**
     * Calculate trade PnL from executable exit price.
     *
     * exitPrice is always in executable outcome-space:
     * - YES trades: bid/filled YES sell price
     * - NO trades: 1-ask (paper) or filled NO sell price (live)
     */
    _calculateTradePnl(trade, exitPrice) {
        const entryFee = trade.position_size * this.params.fee_per_side;
        let exitValue = (exitPrice - trade.entry_price) * trade.position_size / trade.entry_price;

        // Clamp to prevent runaway PnL from near-zero denominators
        exitValue = Math.max(-trade.position_size, Math.min(exitValue, trade.position_size * 10));

        const exitFee = Math.abs(exitValue + trade.position_size) * this.params.fee_per_side;
        return exitValue - entryFee - exitFee;
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

            // Check for expired contracts FIRST, before price data.
            // After settlement, Gemini removes the market so getBestPrices() returns null.
            // Without this early check, expired trades become zombies forever.
            const expiryCheck = this.getTradeTimingConfig(trade, null, Date.now());
            if (expiryCheck.timeToExpiry !== null && expiryCheck.timeToExpiry <= 0) {
                const holdTime = expiryCheck.holdTime;
                // Determine settlement value: worst-case assumption (full loss) for both directions.
                // exitPrice is in "exit-price space": bid for YES, (1 - ask) for NO.
                // In this space, 0.0 always means "position expired worthless" regardless of direction.
                // YES worst case: settled OTM → holder gets $0.
                // NO worst case: YES settled ITM → NO holder gets $0 (1 - 1.0 = 0.0 in exit-price space).
                const exitPrice = 0.0; // worst case: full loss for both YES and NO
                const pnl = parseFloat(
                    ((exitPrice - trade.entry_price) * trade.position_size / trade.entry_price).toFixed(4)
                );
                this.logger.info(
                    `EXPIRED SETTLEMENT: ${trade.gemini_market_id} — ` +
                    `${Math.round(-expiryCheck.timeToExpiry)}s past settlement, force-closing (assumed worst-case LOSS; real settlement via Gemini)`
                );

                // For live trades, the position auto-settles on Gemini — just close in DB
                this.db.closeTrade(trade.id, exitPrice, pnl, holdTime, 'expired_settlement');
                this._recentlyClosed.set(trade.gemini_market_id, Date.now());
                // Only update paper wallet for paper trades (live trades use real Gemini balance)
                if (!isLive) {
                    const wallet = this.db.getWallet();
                    this.db.updateWallet(wallet.balance + pnl, pnl);
                }
                exits.push({ tradeId: trade.id, reason: 'expired_settlement', pnl, holdTime });
                continue;
            }

            // For live trades, get current market data from real API
            // For paper trades, use paper simulation
            let currentMid, exitPrice;
            let wideSpread = false; // track if mid is unreliable due to wide spread

            if (isLive) {
                // Live trade: use real Gemini prices for exit decisions
                const realPrices = this.gemini.realClient
                    ? this.gemini.realClient.getBestPrices(trade.gemini_market_id)
                    : null;
                let positionExitPrice = null;

                if (!realPrices) {
                    try {
                        const desiredOutcome = String(trade.direction || '').toLowerCase() === 'no' ? 'no' : 'yes';
                        const positions = await this.gemini.getPositions();
                        const exchangePos = (positions || []).find(p =>
                            p.symbol === trade.gemini_market_id &&
                            String(p.outcome || '').toLowerCase() === desiredOutcome
                        ) || (positions || []).find(p => p.symbol === trade.gemini_market_id);

                        const sellYes = Number(exchangePos?.prices?.sell?.yes);
                        const sellNo = Number(exchangePos?.prices?.sell?.no);
                        const buyYes = Number(exchangePos?.prices?.buy?.yes);
                        const buyNo = Number(exchangePos?.prices?.buy?.no);

                        positionExitPrice = trade.direction === 'YES'
                            ? (Number.isFinite(sellYes) && sellYes > 0 ? sellYes : (Number.isFinite(buyYes) && buyYes > 0 ? buyYes : null))
                            : (Number.isFinite(sellNo) && sellNo > 0 ? sellNo : (Number.isFinite(buyNo) && buyNo > 0 ? buyNo : null));
                    } catch (priceErr) {
                        this.logger.debug(`Live trade ${trade.id}: fallback position price lookup failed (${priceErr.message})`);
                    }
                }

                const ttx = this._getTTXSeconds(trade.gemini_market_id);
                const isShortTTX = ttx !== null && ttx > 0 && ttx <= 3600;

                if (!isShortTTX && (!realPrices || !realPrices.hasTwoSidedBook) && !Number.isFinite(positionExitPrice)) {
                    this.logger.debug(`Live trade ${trade.id}: no two-sided book, skipping exit check`);
                    continue;
                }

                currentMid = realPrices
                    ? (realPrices.bid + realPrices.ask) / 2
                    : (trade.direction === 'YES' && Number.isFinite(positionExitPrice)
                        ? positionExitPrice
                        : (trade.direction === 'NO' && Number.isFinite(positionExitPrice)
                            ? (1 - positionExitPrice)
                            : (trade.entry_price + 0.01)));
                const spread = realPrices ? (realPrices.ask - realPrices.bid) : 0.02;
                if (spread > 0.20) wideSpread = true; // mid is unreliable on 20¢+ spreads
                // For live exits: YES sells at bid, NO buys at ask (to close)
                exitPrice = realPrices && trade.direction === 'YES'
                    ? realPrices.bid
                    : (realPrices && trade.direction === 'NO'
                        ? (1 - realPrices.ask)
                        : positionExitPrice);

                if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
                    this.logger.debug(`Live trade ${trade.id}: no executable exit quote, skipping exit check`);
                    continue;
                }
            } else {
                // Paper trade: use paper simulation
                currentMid = this.gemini.getPaperMidPrice(trade.gemini_market_id);
                if (currentMid === null) continue;
                exitPrice = this.gemini.getPaperExitPrice(trade.gemini_market_id, trade.direction);
                if (exitPrice === null) continue;
            }

            let exitReason = null;
            const timing = this.getTradeTimingConfig(trade, currentMid, Date.now());
            const holdTime = timing.holdTime;
            let pnl = 0;
            const maxHold = timing.maxHold;
            const timeToExpiry = timing.timeToExpiry;
            const decayFraction = timing.decayFraction;
            let effectiveStopLoss = timing.effectiveStopLoss;

            // Legacy SL conversion: old trades used mid-based SL which for NO trades
            // stored as entryMid + width (values ABOVE entry). New code expects all SL
            // below entry since we compare against exitPrice which always drops on loss.
            if (effectiveStopLoss > trade.entry_price) {
                effectiveStopLoss = trade.entry_price - 0.08;
            }
            // Also fix old NO trades where SL is in YES-mid space (far below NO entry).
            // e.g., NO entry=$0.93 but SL=$0.17 (YES mid+width). New check would only
            // trigger when exitPrice <= $0.17 = nearly worthless. Reset to entry-based.
            if (trade.direction === 'NO' && trade.entry_price - effectiveStopLoss > 0.15) {
                effectiveStopLoss = trade.entry_price - 0.08;
            }

            // Calculate PnL from executable exit price estimate.
            // For live trades this is recalculated again after actual fill.
            pnl = this._calculateTradePnl(trade, exitPrice);

            // Exit conditions: SL and TP both use executable exit price (not mid).
            // exitPrice = bid (YES) or 1-ask (NO) — the actual price we'd receive.
            // Both go DOWN when we're losing, so unified comparison works.
            const skipStopLoss = wideSpread;
            if (exitPrice >= trade.take_profit_price) {
                exitReason = 'take_profit';
            } else if (!skipStopLoss && exitPrice <= effectiveStopLoss) {
                exitReason = decayFraction >= 0.80 ? 'time_decay_stop' : 'stop_loss';
            }

            // Max dollar loss cap: hard backstop prevents catastrophic gap-through losses
            const maxLossPerTrade = 0.30;
            if (!exitReason && pnl < -maxLossPerTrade) {
                exitReason = 'max_loss_cap';
            }

            // Time-based exit
            if (!exitReason && holdTime >= maxHold) {
                exitReason = 'time_exit';
            }

            // Expired contract: if past settlement, force-close to free slot
            if (!exitReason && timeToExpiry !== null && timeToExpiry <= 0) {
                exitReason = 'expired_settlement';
                this.logger.info(
                    `EXPIRED SETTLEMENT: ${trade.gemini_market_id} — ` +
                    `${Math.round(-timeToExpiry)}s past settlement, force-closing`
                );
            }

            // Pre-expiry forced exit: sell before final 5% of time-to-expiry
            // to avoid binary settlement risk on thin books where exit may be impossible
            const preExpiryExitSeconds = timing.preExpiryExitSeconds;
            if (!exitReason && timeToExpiry !== null && timeToExpiry > 0 && timeToExpiry < preExpiryExitSeconds) {
                // Less than the configured pre-expiry window to settlement — force exit
                exitReason = 'pre_expiry_exit';
                this.logger.info(
                    `PRE-EXPIRY EXIT: ${trade.gemini_market_id} — ${Math.round(timeToExpiry)}s to settlement ` +
                    `(threshold=${preExpiryExitSeconds}s, profile=${this.tradingProfile})`
                );
            }

            if (exitReason) {
                // For live trades, submit a real sell order via Gemini API
                if (isLive) {
                    // Race-condition guard: if a previous cycle already placed an exit
                    // order that hasn't confirmed yet, skip this cycle. This prevents
                    // two exit orders being submitted for the same trade when cycles
                    // overlap or the fill confirmation is delayed.
                    if (this._pendingExits.has(trade.id)) {
                        this.logger.debug(
                            `LIVE EXIT SKIP (pending): trade ${trade.id} ${trade.gemini_market_id} ` +
                            `— exit order already in-flight, waiting for fill confirmation`
                        );
                        continue;
                    }

                    let liveExitReadyToClose = false;
                    this.db.updateTradeState(trade.id, 'PENDING_EXIT');
                    // Track retry attempts — give up after maxExitRetries
                    const retryInfo = this.liveExitRetries.get(trade.id) || { count: 0, firstAttempt: now };
                    retryInfo.count++;
                    this.liveExitRetries.set(trade.id, retryInfo);

                    if (retryInfo.count > this.maxExitRetries) {
                        this.logger.error(
                            `LIVE EXIT ABANDONED after ${retryInfo.count} retries: ${trade.gemini_market_id} ` +
                            `— keeping trade OPEN in DB for manual intervention/reconciliation.`
                        );
                        this._pendingExits.delete(trade.id);
                        this.db.updateTradeState(trade.id, 'ENTERED');
                        continue;
                    } else {
                        try {
                            // Clamp exit price to Gemini's valid range [$0.01, $0.99]
                            const clampedExitPrice = Math.max(0.01, Math.min(0.99, exitPrice));

                            // Always use exchange-reported contracts to avoid stale DB quantity mismatches.
                            const contracts = await this._getLiveContractsAvailable(
                                trade.gemini_market_id,
                                trade.direction
                            );
                            if (contracts <= 0) {
                                const stillOnExchange = await this._hasExchangePosition(trade.gemini_market_id);
                                if (!stillOnExchange) {
                                    this.logger.warn(
                                        `LIVE EXIT RECONCILE: ${trade.gemini_market_id} has no exchange position; ` +
                                        `closing DB trade as reconcile_no_exchange`
                                    );
                                    exitReason = 'reconcile_no_exchange';
                                    exitPrice = trade.entry_price;
                                    pnl = 0;
                                    this.liveExitRetries.delete(trade.id);
                                    liveExitReadyToClose = true;
                                } else {
                                    this.logger.warn(
                                        `Live exit skipped for ${trade.gemini_market_id}: ` +
                                        `no available contracts (held or mismatch), retry ${retryInfo.count}/${this.maxExitRetries}`
                                    );
                                }
                            }

                            if (!liveExitReadyToClose) {
                            // Mark in-flight BEFORE async placeOrder so concurrent cycles skip this trade
                            this._pendingExits.add(trade.id);
                            const exitOrder = await this.gemini.placeOrder({
                                symbol: trade.gemini_market_id,
                                side: 'sell',
                                amount: contracts,
                                price: clampedExitPrice.toFixed(2),
                                direction: trade.direction
                            });
                            if (!exitOrder || !exitOrder.success) {
                                this.logger.warn(
                                    `Live exit order failed for ${trade.gemini_market_id}, ` +
                                    `retry ${retryInfo.count}/${this.maxExitRetries} (reason=${exitReason})`
                                );
                                this._triggerCanaryStop('live_exit_order_failed', {
                                    tradeId: trade.id,
                                    marketId: trade.gemini_market_id,
                                    reason: exitReason,
                                    retryCount: retryInfo.count
                                });
                                this._pendingExits.delete(trade.id);
                                this.db.updateTradeState(trade.id, 'ENTERED');
                                continue; // Skip closing in DB — retry next cycle
                            }
                            // CRITICAL: Verify the sell order actually filled.
                            // Gemini returns success=true even for unfilled limit orders.
                            // If filledQuantity=0, the order was accepted but didn't execute —
                            // do NOT close in DB or we create orphaned exchange positions.
                            const exitFilled = Number(exitOrder.filledQuantity || 0);
                            if (exitFilled === 0) {
                                // Order didn't fill — try to cancel it and retry next cycle
                                try {
                                    if (exitOrder.orderId) {
                                        await this.gemini.cancelOrder(exitOrder.orderId);
                                    }
                                } catch (cancelErr) {
                                    this.logger.debug(`Cancel unfilled exit order: ${cancelErr.message}`);
                                }
                                this.logger.warn(
                                    `Live exit UNFILLED: ${trade.gemini_market_id} orderId=${exitOrder.orderId} ` +
                                    `price=${clampedExitPrice.toFixed(2)} — will retry next cycle ` +
                                    `(${retryInfo.count}/${this.maxExitRetries})`
                                );
                                this._triggerCanaryStop('live_exit_unfilled', {
                                    tradeId: trade.id,
                                    marketId: trade.gemini_market_id,
                                    orderId: exitOrder.orderId,
                                    retryCount: retryInfo.count
                                });
                                this._pendingExits.delete(trade.id);
                                this.db.updateTradeState(trade.id, 'ENTERED');
                                continue; // Do NOT close in DB
                            }
                            // Use actual fill price from exchange if available.
                            // Recompute PnL from the real execution price so DB PnL
                            // cannot drift from exchange-confirmed fills.
                            exitPrice = exitOrder.fill_price || exitPrice;
                            pnl = this._calculateTradePnl(trade, exitPrice);
                            this.liveExitRetries.delete(trade.id);
                            liveExitReadyToClose = true;
                            this.logger.info(
                                `LIVE EXIT (${exitReason}): ${trade.gemini_market_id} ` +
                                `orderId=${exitOrder.orderId} filled=${exitOrder.filledQuantity}`
                            );
                            }
                        } catch (err) {
                            if (err.message && err.message.includes('No') && err.message.includes('position found')) {
                                const stillOnExchange = await this._hasExchangePosition(trade.gemini_market_id);
                                if (!stillOnExchange) {
                                    this.logger.warn(
                                        `PHANTOM POSITION: ${trade.gemini_market_id} confirmed absent on exchange — ` +
                                        `closing in DB as reconcile_no_exchange`
                                    );
                                    exitReason = 'reconcile_no_exchange';
                                    exitPrice = trade.entry_price;
                                    pnl = 0;
                                    this.liveExitRetries.delete(trade.id);
                                    liveExitReadyToClose = true;
                                } else {
                                    this.logger.warn(
                                        `Live exit mismatch for ${trade.gemini_market_id}: exchange still shows position; ` +
                                        `retry ${retryInfo.count}/${this.maxExitRetries}`
                                    );
                                }
                            } else {
                                this.logger.error(
                                    `Live exit error for ${trade.gemini_market_id}: ${err.message} ` +
                                    `retry ${retryInfo.count}/${this.maxExitRetries}`
                                );
                            }
                        }
                    }

                    if (!liveExitReadyToClose) {
                        this._pendingExits.delete(trade.id);
                        this.db.updateTradeState(trade.id, 'ENTERED');
                        continue; // Never close DB unless we have exchange-confirmed fill or confirmed no position
                    }
                }

                // Close the trade — always clear pending exit guard before writing DB
                this._pendingExits.delete(trade.id);
                pnl = parseFloat(pnl.toFixed(4));
                this.db.closeTrade(trade.id, exitPrice, pnl, holdTime, exitReason);
                this._recentlyClosed.set(trade.gemini_market_id, Date.now());

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
                            : (realisticExit - trade.realistic_entry_price) * trade.position_size / trade.realistic_entry_price;
                        const rExitFee = Math.abs(rExitValue + trade.position_size) * this.params.fee_per_side;
                        realisticPnl = parseFloat((rExitValue - rEntryFee - rExitFee).toFixed(4));
                        this.db.updateTradeRealisticExit(trade.id, realisticExit, realisticPnl);
                    }
                }

                // Update wallet — only paper trades update paper_wallet
                // Live trades use real Gemini balance (no phantom wallet contamination)
                let newBalance;
                if (!isLive) {
                    const wallet = this.db.getWallet();
                    newBalance = wallet.balance + pnl;
                    this.db.updateWallet(newBalance, pnl);
                } else {
                    newBalance = this._liveBalance || 0;
                }

                const realisticSuffix = realisticPnl !== null
                    ? ` | Realistic=$${realisticPnl.toFixed(2)}`
                    : '';
                const modeTag = isLive ? '[LIVE] ' : '';
                this.logger.info(
                    `${modeTag}EXIT (${exitReason}): "${trade.market_title}" ` +
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
        // DISABLED: Learning cycle is poisoned by 82 legacy trades with bugged NO PnL.
        // Re-enable once 50+ clean trades exist (all from post-bugfix sessions).
        return;

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
                const posCeiling = isLiveMode ? 15 : this.params.max_position_size;

                this.db.setParameter('entry_threshold', newThreshold);
                this.db.setParameter('kelly_multiplier', newKelly);
                this.params.entry_threshold = newThreshold;
                this.params.kelly_multiplier = newKelly;
                if (this.params.max_position_size > posCeiling) {
                    this.db.setParameter('max_position_size', posCeiling);
                    this.params.max_position_size = posCeiling;
                }

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
                    0.05,
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
        // Reload params from DB each cycle so manual DB changes take effect
        this.params = this.loadParams();

        // Reset per-cycle counters
        this.liveOrdersThisCycle = 0;
        this._balanceRejectLogged = false;

        // 1. Monitor and exit existing positions
        const exits = await this.monitorPositions();

        // 1.5 In autonomous 15m session mode, fail-closed pre-trade safety gate.
        const preTradeGate = await this.evaluatePreTradeSafetyGate();

        // 2. Enter new positions from signals
        const entries = [];
        if (!preTradeGate.allowed) {
            for (const signal of actionableSignals) {
                if (signal.marketId && signal.marketId.startsWith('GEMI-')) {
                    this.logEntryRejection(signal, 'pre_trade_safety_gate', preTradeGate.reason, preTradeGate.details || {});
                }
            }
        } else {
            for (const signal of actionableSignals) {
                const entry = await this.enterPosition(signal);
                if (entry) entries.push(entry);
            }
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
    /**
     * Reconcile DB positions with actual Gemini exchange positions.
     *
     * Classifies four states:
     *   matched           — DB and exchange agree (qty within ±1 contract)
     *   quantity_mismatch — same symbol but qty diverges by >1 contract
     *   phantom           — DB trade has no exchange position
     *   orphaned          — exchange position has no DB trade
     *
     * Every item carries a `reason` code for audit logs. Safe to call
     * repeatedly (idempotent) — acts only on current state.
     */
    async reconcilePositions() {
        if (this.gemini.mode !== 'live' && this.gemini.mode !== 'sandbox') {
            return { orphaned: [], phantom: [], quantityMismatch: [], matched: [], skipped: true };
        }

        try {
            const [exchangePositions, dbOpenTrades] = await Promise.all([
                this.gemini.getPositions(),
                Promise.resolve(this.db.getOpenTrades('live'))
            ]);

            const matched = [];
            const phantom = [];
            const orphaned = [];
            const quantityMismatch = [];

            const normalizeDirection = (value) => {
                const upper = String(value || '').toUpperCase();
                return upper === 'YES' || upper === 'NO' ? upper : null;
            };

            const buildPositionKey = (symbol, direction) => {
                if (!symbol) return null;
                const normalizedDirection = normalizeDirection(direction);
                return normalizedDirection ? `${symbol}::${normalizedDirection}` : symbol;
            };

            // Build lookup of exchange positions by symbol+outcome.
            const exchangeByKey = new Map();
            for (const pos of exchangePositions) {
                const symbol = pos.symbol || pos.instrumentSymbol;
                const key = buildPositionKey(symbol, pos.outcome);
                if (key) exchangeByKey.set(key, pos);
            }

            const dbGroups = new Map();
            for (const trade of dbOpenTrades) {
                const key = buildPositionKey(trade.gemini_market_id, trade.direction);
                if (!key) continue;
                if (!dbGroups.has(key)) dbGroups.set(key, []);
                dbGroups.get(key).push(trade);
            }

            // Check each DB symbol/direction group against exchange.
            for (const [groupKey, trades] of dbGroups.entries()) {
                const sampleTrade = trades[0];
                const exchangePos = exchangeByKey.get(groupKey);
                if (exchangePos) {
                    const exchangeQty = Number(exchangePos.totalQuantity || 0);
                    const exchangeHeldQty = Number(exchangePos.quantityOnHold || 0);
                    const exchangeAvailable = Math.max(0, exchangeQty - exchangeHeldQty);
                    const dbContracts = trades.reduce((sum, trade) => {
                        const contracts = trade.entry_price > 0
                            ? Math.max(0, Math.round(trade.position_size / trade.entry_price))
                            : 0;
                        return sum + contracts;
                    }, 0);
                    const qtyDiff = Math.abs(exchangeQty - dbContracts);
                    const hasMismatch = dbContracts > 0 && qtyDiff > 1;

                    if (hasMismatch) {
                        const reason = exchangeQty > dbContracts
                            ? 'exchange_exceeds_db'
                            : 'db_exceeds_exchange';
                        quantityMismatch.push({
                            tradeIds: trades.map(trade => trade.id),
                            tradeId: sampleTrade.id,
                            symbol: sampleTrade.gemini_market_id,
                            dbDirection: sampleTrade.direction,
                            dbContracts,
                            exchangeQty,
                            exchangeHeldQty,
                            exchangeAvailable,
                            qtyDiff,
                            reason,
                            entryPrice: sampleTrade.entry_price,
                            age: Math.floor(Date.now() / 1000) - Math.min(...trades.map(trade => trade.timestamp || 0))
                        });
                        this.logger.warn(
                            `QTY MISMATCH: trades ${trades.map(trade => trade.id).join(',')} ` +
                            `${sampleTrade.direction} ${sampleTrade.gemini_market_id} ` +
                            `DB=${dbContracts} vs exchange=${exchangeQty} (diff=${qtyDiff}) reason=${reason}`
                        );
                    } else {
                        for (const trade of trades) {
                            const tradeContracts = trade.entry_price > 0
                                ? Math.max(0, Math.round(trade.position_size / trade.entry_price))
                                : 0;
                            matched.push({
                                tradeId: trade.id,
                                symbol: trade.gemini_market_id,
                                dbDirection: trade.direction,
                                dbContracts: tradeContracts,
                                groupedDbContracts: dbContracts,
                                exchangeQty,
                                exchangeHeldQty,
                                exchangeAvailable
                            });
                        }
                    }
                    exchangeByKey.delete(groupKey);
                } else {
                    for (const trade of trades) {
                        const ageSeconds = Math.floor(Date.now() / 1000) - trade.timestamp;
                        const hasPendingExit = this._pendingExits.has(trade.id);
                        const transientGrace = !hasPendingExit && ageSeconds <= this.phantomGraceSeconds;
                        phantom.push({
                            tradeId: trade.id,
                            symbol: trade.gemini_market_id,
                            direction: trade.direction,
                            size: trade.position_size,
                            entryPrice: trade.entry_price,
                            age: ageSeconds,
                            pendingExit: hasPendingExit,
                            transientGrace,
                            reason: hasPendingExit
                                ? 'phantom_exit_in_flight'
                                : (transientGrace ? 'phantom_recent_entry_grace' : 'phantom_no_exchange_position')
                        });
                        this.logger.warn(
                            `PHANTOM POSITION: trade ${trade.id} ${trade.direction} ${trade.gemini_market_id} ` +
                            `exists in DB but NOT on Gemini exchange` +
                            (hasPendingExit
                                ? ' (exit in-flight, may resolve next cycle)'
                                : (transientGrace ? ` (recent entry grace ${ageSeconds}s<=${this.phantomGraceSeconds}s)` : ''))
                        );
                    }
                }
            }

            // Remaining exchange positions not in DB = orphaned
            for (const [key, pos] of exchangeByKey) {
                const symbol = pos.symbol || pos.instrumentSymbol || key;
                orphaned.push({
                    symbol,
                    quantity: Number(pos.totalQuantity || 0),
                    quantityOnHold: Number(pos.quantityOnHold || 0),
                    outcome: pos.outcome,
                    avgPrice: pos.avgExecutionPrice || pos.price,
                    reason: 'orphaned_no_db_trade'
                });
                this.logger.error(
                    `ORPHANED POSITION: ${symbol} qty=${pos.totalQuantity || 0} hold=${pos.quantityOnHold || 0} ` +
                    `exists on Gemini but NOT in DB — manual close required`
                );
            }

            if (phantom.length > 0 || orphaned.length > 0) {
                this.logger.warn(
                    `RECONCILIATION: ${matched.length} matched, ` +
                    `${phantom.length} phantom (DB only), ${orphaned.length} orphaned (exchange only), ` +
                    `${quantityMismatch.length} qty_mismatch`
                );
            }

            return { orphaned, phantom, quantityMismatch, matched, skipped: false };
        } catch (e) {
            this.logger.warn('Position reconciliation failed: ' + e.message);
            return { orphaned: [], phantom: [], quantityMismatch: [], matched: [], skipped: true, error: e.message };
        }
    }

    /**
     * Poll live order status on Gemini exchange.
     * Detects orders that were filled or cancelled between trading cycles.
     * Called every 30s in live/sandbox mode.
     */
    async pollLiveOrderStatus() {
        if (this.gemini.mode !== 'live' && this.gemini.mode !== 'sandbox') return;

        try {
            const openTrades = this.db.getOpenTrades('live');
            if (openTrades.length === 0) return;

            // Check active orders on exchange
            const activeOrders = await this.gemini.getOpenOrders();
            const activeOrderIds = new Set(
                (activeOrders || []).map(o => o.orderId || o.order_id).filter(Boolean)
            );

            // Check positions on exchange
            const positions = await this.gemini.getPositions();
            const positionSymbols = new Set(
                (positions || []).map(p => p.symbol || p.instrumentSymbol).filter(Boolean)
            );

            for (const trade of openTrades) {
                // If there's neither an active order nor a position for this trade's symbol,
                // the order was likely cancelled or expired
                if (!positionSymbols.has(trade.gemini_market_id)) {
                    // Check order history for fill info
                    let filled = null;
                    try {
                        const history = await this.gemini.getOrderHistory();
                        filled = (history || []).find(
                            o => o.symbol === trade.gemini_market_id &&
                                 (o.status === 'filled' || o.orderStatus === 'filled') &&
                                 o.side === 'buy'
                        );
                    } catch (histErr) {
                        this.logger.debug('Order history check failed: ' + histErr.message);
                    }

                    if (!filled) {
                        // Track consecutive "not found" polls
                        const count = (this._phantomPollCounts.get(trade.id) || 0) + 1;
                        this._phantomPollCounts.set(trade.id, count);

                        if (count >= 3) {
                            // Auto-close phantom trade — position doesn't exist on exchange
                            this.logger.warn(
                                `PHANTOM CLOSE: Trade ${trade.id} (${trade.gemini_market_id}) — ` +
                                `not found on exchange after ${count} polls. Closing in DB.`
                            );
                            const holdTime = Math.floor(Date.now() / 1000) - (trade.timestamp || 0);
                            this.db.closeTrade(trade.id, trade.entry_price, 0, holdTime, 'exchange_cancelled');
                            this._recentlyClosed.set(trade.gemini_market_id, Date.now());
                            this._phantomPollCounts.delete(trade.id);
                        } else {
                            this.logger.warn(
                                `POLL: Live trade ${trade.id} (${trade.gemini_market_id}) — ` +
                                `no position or active order found on exchange (poll ${count}/3).`
                            );
                        }
                    } else {
                        // Found in history — reset counter
                        this._phantomPollCounts.delete(trade.id);
                    }
                } else {
                    // Position exists — reset counter
                    this._phantomPollCounts.delete(trade.id);
                }
            }
        } catch (e) {
            this.logger.debug('Live order poll failed: ' + e.message);
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
        const dbParamMap = params.reduce((acc, p) => {
            acc[p.key] = p.value;
            return acc;
        }, {});

        // In live mode, override wallet with real Gemini balance
        let displayWallet = wallet;
        const isLive = this.gemini && (this.gemini.mode === 'live' || this.gemini.mode === 'sandbox');
        if (isLive && this._liveBalance != null) {
            const initialBalance = wallet ? wallet.initial_balance : 140;
            displayWallet = {
                balance: this._liveBalance,
                initial_balance: initialBalance,
                total_pnl: this._liveBalance - initialBalance
            };
        }

        const sessionSanity = this.getSessionSanityChecks();
        const readinessBlockers = this.getReadinessBlockers();

        return {
            running: this.isRunning,
            wallet: displayWallet,
            live_balance: isLive ? this._liveBalance : null,
            live_tradable_balance: isLive
                ? (
                    Number.isFinite(Number(this._liveTradableBalance))
                        ? Number(this._liveTradableBalance)
                        : this.getTradableLiveBalance(this._liveBalance)
                )
                : null,
            open_positions: openTrades.length,
            open_trades: openTrades,
            daily_pnl: dailyPnL,
            session_live_pnl: (
                Number((this.db.getDailyPnL('live') || {}).daily_pnl || 0) -
                Number(this.sessionStartLiveDailyPnl || 0)
            ),
            total_trades: this.tradeCount,
            trading_profile: this.tradingProfile,
            profile_overrides: this.profileOverrides,
            session_policy: this.getSessionPolicy(),
            ttx_policy: {
                short_max_seconds: this.shortTtxMaxSeconds,
                medium_max_seconds: this.mediumTtxMaxSeconds,
                thresholds: {
                    short: {
                        entry_threshold: this.shortTtxEntryThreshold,
                        min_edge_live: this.shortTtxMinEdgeLive
                    },
                    medium: {
                        entry_threshold: this.mediumTtxEntryThreshold,
                        min_edge_live: this.mediumTtxMinEdgeLive
                    },
                    long: {
                        entry_threshold: this.longTtxEntryThreshold,
                        min_edge_live: this.longTtxMinEdgeLive
                    },
                    fallback: {
                        entry_threshold: this.params.entry_threshold,
                        min_edge_live: this.params.min_edge_live
                    }
                }
            },
            session_sanity: sessionSanity,
            can_enter_now: readinessBlockers.length === 0,
            readiness_blockers: readinessBlockers,
            pre_trade_gate: this._lastPreTradeGate,
            db_parameters: dbParamMap,
            parameters: { ...this.params },
            last_learning_cycle: this.lastLearningCycle
        };
    }
}

module.exports = PaperTradingEngine;
