/**
 * Prediction Market Proxy Server
 *
 * Express.js server that:
 *   1. Aggregates price data from Polymarket, Kalshi, and Gemini
 *   2. Runs signal detection and opportunity scoring
 *   3. Executes paper trades via PaperTradingEngine
 *   4. Provides REST API + WebSocket for dashboard
 *   5. Manages the main trading loop
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const PredictionDatabase = require('../lib/prediction_db');
const PolymarketClient = require('../lib/polymarket_client');
const KalshiClient = require('../lib/kalshi_client');
const GeminiClient = require('../lib/gemini_client');
const MarketMatcher = require('../lib/market_matcher');
const SignalDetector = require('../lib/signal_detector');
const PaperTradingEngine = require('../lib/paper_trading_engine');
const FairValueEngine = require('../lib/fair_value_engine');
const DeribitClient = require('../lib/deribit_client');
const OddsApiClient = require('../lib/odds_api_client');
const MetaculusClient = require('../lib/metaculus_client');
const RateLimiter = require('./rate-limiter');
const Alerts = require('../lib/alerts');
const KalshiWS = require('../lib/kalshi_ws');
const SpotWebSocket = require('../lib/spot_ws');
const { Logger } = require('../lib/logger');

const logger = new Logger({ component: 'SERVER', level: 'INFO' });

// ===== Circuit Breaker + Health Monitor =====

const health = {
    consecutiveErrors: 0,
    totalErrors: 0,
    lastError: null,
    circuitOpen: false,
    circuitOpenedAt: null,
    circuitCooldownMs: 30000,  // 30s cooldown after 5 consecutive errors
    maxConsecutiveErrors: 5,
    apiHealth: {
        polymarket: { ok: 0, fail: 0, lastFail: null },
        kalshi:     { ok: 0, fail: 0, lastFail: null },
        kraken:     { ok: 0, fail: 0, lastFail: null },
        gemini:     { ok: 0, fail: 0, lastFail: null }
    }
};

function recordApiResult(source, success, error) {
    const h = health.apiHealth[source];
    if (!h) return;
    if (success) {
        h.ok++;
    } else {
        h.fail++;
        h.lastFail = Date.now();
    }
}

function isCircuitOpen() {
    if (!health.circuitOpen) return false;
    // Auto-close after cooldown
    if (Date.now() - health.circuitOpenedAt > health.circuitCooldownMs) {
        health.circuitOpen = false;
        health.consecutiveErrors = 0;
        logger.info('Circuit breaker CLOSED — resuming trading');
        return false;
    }
    return true;
}

function recordCycleResult(success, error) {
    if (success) {
        health.consecutiveErrors = 0;
    } else {
        health.consecutiveErrors++;
        health.totalErrors++;
        health.lastError = { message: error?.message, time: Date.now() };

        if (health.consecutiveErrors >= health.maxConsecutiveErrors && !health.circuitOpen) {
            health.circuitOpen = true;
            health.circuitOpenedAt = Date.now();
            logger.error(`Circuit breaker OPEN — ${health.consecutiveErrors} consecutive errors. Cooldown ${health.circuitCooldownMs / 1000}s`);
        }
    }
}

// ===== Drawdown Kill-Switch =====

const DRAWDOWN_LIMIT = 0.20;  // 20% max drawdown → auto-stop
let peakBalance = null;

function checkDrawdownKillSwitch() {
    try {
        let balance;
        if (geminiMode === 'live') {
            // Always use real Gemini balance — paper wallet is irrelevant for live risk
            balance = (tradingEngine && tradingEngine._liveBalance)
                || (geminiClient && geminiClient._cachedBalance)
                || null;
            if (balance === null) return false; // not fetched yet, skip check
        } else {
            const wallet = db.getWallet();
            if (!wallet) return false;
            balance = wallet.balance || wallet.total || 500;
        }

        if (peakBalance === null) peakBalance = balance;
        if (balance > peakBalance) peakBalance = balance;

        const drawdown = (peakBalance - balance) / peakBalance;
        if (drawdown > DRAWDOWN_LIMIT) {
            logger.error(`DRAWDOWN KILL-SWITCH: ${(drawdown * 100).toFixed(1)}% drawdown (peak $${peakBalance.toFixed(2)}, current $${balance.toFixed(2)}). Stopping bot.`);
            stopBot();
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

// ===== Live Wallet Helper =====
async function getDisplayWallet() {
    if (geminiMode === 'live') {
        let balance = (tradingEngine && tradingEngine._liveBalance)
            || (geminiClient && geminiClient._cachedBalance)
            || null;
        // If no cached balance yet, fetch it now
        if (balance === null && geminiClient) {
            balance = await geminiClient.getAvailableBalance();
        }
        if (balance !== null) {
            const paperWallet = db.getWallet();
            const initialBalance = paperWallet ? paperWallet.initial_balance : 140;
            return {
                balance,
                initial_balance: initialBalance,
                total_pnl: balance - initialBalance
            };
        }
    }
    return db.getWallet();
}

// ===== Emergency Exit All Positions =====

async function emergencyExitAll(options = {}) {
    const { liveOnly = false, closeReason = 'emergency_stop' } = options;

    // ── Mutex: prevent concurrent cleanup races ───────────────────────────────
    // A second caller (e.g. harness retrying after autonomous session stop) gets
    // a fast no-op instead of double-processing the same trades.
    if (botState.cleanupStatus === 'in_progress') {
        logger.warn('emergencyExitAll already in progress — skipping duplicate call');
        return { closed: 0, totalPnl: 0, exits: [], unresolved: 0, is_flat: false, skipped_duplicate: true };
    }
    botState.cleanupStatus = 'in_progress';
    botState.cleanupTs = Date.now();
    botState.cleanupResult = null;

    const openTrades = db.getOpenTrades().filter(t => !liveOnly || t.mode === 'live');
    if (openTrades.length === 0) {
        botState.cleanupStatus = 'complete';
        botState.cleanupResult = { closed: 0, totalPnl: 0, exits: [], unresolved: 0, is_flat: true };
        return botState.cleanupResult;
    }

    const exits = [];
    const unresolvedExits = [];  // sell submitted but not confirmed, or sell failed
    let totalPnl = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const trade of openTrades) {
        try {
            const isLive = trade.mode === 'live';
            let exitPrice;
            let forcedReconcileClose = false;
            let forceCloseReason = closeReason;
            let exitStatus = 'unknown';

            if (isLive) {
                const exchangePositions = await geminiClient.getPositions().catch(() => []);
                const desiredOutcome = String(trade.direction || '').toLowerCase();
                const exchangePos = (exchangePositions || []).find(pos =>
                    pos.symbol === trade.gemini_market_id && String(pos.outcome || '').toLowerCase() === desiredOutcome
                );

                if (!exchangePos || Number(exchangePos.totalQuantity || 0) <= 0) {
                    // Exchange confirms no open position — safe to close DB record.
                    forcedReconcileClose = true;
                    forceCloseReason = 'manual_reconcile_no_exchange';
                    exitPrice = Number(trade.entry_price || 0);
                    exitStatus = 'no_exchange_position';
                }

                if (!forcedReconcileClose) {
                    // Live trade: get real price and place actual sell order on Gemini
                    const realPrices = geminiClient.realClient
                        ? geminiClient.realClient.getBestPrices(trade.gemini_market_id)
                        : null;
                    exitPrice = realPrices?.bid != null
                        ? (trade.direction === 'YES' ? realPrices.bid : (1 - realPrices.ask))
                        : null;

                    if (exitPrice != null) {
                        try {
                            const contracts = Math.max(1, Math.floor(trade.position_size / trade.entry_price));
                            const exitOrder = await geminiClient.placeOrder({
                                symbol: trade.gemini_market_id,
                                side: 'sell',
                                amount: contracts,
                                price: exitPrice.toFixed(2),
                                direction: trade.direction
                            });
                            if (exitOrder && exitOrder.fill_price) {
                                exitPrice = exitOrder.fill_price;
                            }

                            // Only consider the DB record closeable when the sell is confirmed filled.
                            const isFilled = String(exitOrder?.orderStatus || '').toLowerCase() === 'filled'
                                || Number(exitOrder?.filledQuantity || 0) >= contracts;

                            if (isFilled) {
                                exitStatus = 'exit_filled';
                                logger.warn(
                                    `EMERGENCY LIVE SELL FILLED: ${trade.gemini_market_id} ` +
                                    `orderId=${exitOrder?.orderId} status=${exitOrder?.orderStatus}`
                                );
                            } else {
                                // Sell submitted but Gemini has not confirmed a fill.
                                // Leave DB trade open so the next reconcile finds it correctly
                                // instead of treating the exchange position as an orphan.
                                exitStatus = 'exit_submitted_unresolved';
                                logger.error(
                                    `EMERGENCY LIVE SELL UNRESOLVED: ${trade.gemini_market_id} ` +
                                    `orderId=${exitOrder?.orderId} status=${exitOrder?.orderStatus} ` +
                                    `filledQty=${exitOrder?.filledQuantity}/${contracts} ` +
                                    `— keeping DB trade open. CHECK GEMINI.`
                                );
                                unresolvedExits.push({
                                    tradeId: trade.id,
                                    market: trade.gemini_market_id,
                                    exitStatus,
                                    orderId: exitOrder?.orderId
                                });
                                continue; // Do NOT close DB trade
                            }
                        } catch (sellErr) {
                            if (/No\s+NO\s+position\s+found|No\s+YES\s+position\s+found/i.test(String(sellErr.message || ''))) {
                                // Exchange says no position — safe to close DB record.
                                forcedReconcileClose = true;
                                forceCloseReason = 'manual_reconcile_no_exchange';
                                exitPrice = Number(trade.entry_price || 0);
                                exitStatus = 'no_exchange_position';
                            } else {
                                // Unknown error — keep DB open to avoid false orphan creation.
                                exitStatus = 'exit_failed';
                                logger.error(
                                    `EMERGENCY SELL FAILED for ${trade.gemini_market_id}: ${sellErr.message} ` +
                                    `— keeping DB trade open. CHECK GEMINI FOR ORPHANED POSITION.`
                                );
                                unresolvedExits.push({
                                    tradeId: trade.id,
                                    market: trade.gemini_market_id,
                                    exitStatus,
                                    error: sellErr.message
                                });
                                continue; // Do NOT close DB trade
                            }
                        }
                    } else {
                        // No real price — fall back to paper price for record closure.
                        exitPrice = geminiClient.getPaperExitPrice(trade.gemini_market_id, trade.direction);
                        exitStatus = 'exit_price_fallback';
                        logger.warn(
                            `EMERGENCY EXIT (no real price): ${trade.gemini_market_id} using paper price.`
                        );
                    }
                }
            } else {
                exitPrice = geminiClient.getPaperExitPrice(trade.gemini_market_id, trade.direction);
                exitStatus = 'paper_exit';
            }

            if (exitPrice === null) continue;

            const pnl = forcedReconcileClose
                ? 0
                : (() => {
                    const entryFee = trade.position_size * (tradingEngine.params?.fee_per_side || 0.0001);
                    const exitValue = (exitPrice - trade.entry_price) * trade.position_size / trade.entry_price;
                    const exitFee = Math.abs(exitValue + trade.position_size) * (tradingEngine.params?.fee_per_side || 0.0001);
                    return exitValue - entryFee - exitFee;
                })();

            db.closeTrade(trade.id, exitPrice, pnl, now - trade.timestamp, forceCloseReason);

            totalPnl += pnl;
            exits.push({
                tradeId: trade.id,
                market: trade.market_title || trade.gemini_market_id,
                direction: trade.direction,
                exitPrice,
                pnl,
                holdTime: now - trade.timestamp,
                exit_status: exitStatus,
                reconciled_no_exchange: forcedReconcileClose
            });

            logger.warn(`EMERGENCY EXIT: ${trade.direction} "${trade.market_title}" @ ${exitPrice.toFixed(3)} P&L: $${pnl.toFixed(2)} [${exitStatus}]`);
        } catch (e) {
            logger.error(`Failed to emergency exit trade ${trade.id}: ${e.message}`);
        }
    }

    // Update paper wallet only for mixed/paper emergency stops.
    if (totalPnl !== 0 && !liveOnly) {
        try {
            const wallet = db.getWallet();
            if (wallet) {
                db.updateWallet(wallet.balance + totalPnl);
            }
        } catch (e) {
            logger.error(`Failed to update wallet after emergency exit: ${e.message}`);
        }
    }

    // ── Post-exit reconcile — authoritative flatness check ───────────────────
    // Runs after the exit loop so the result reflects what's actually on the
    // exchange, not just what we attempted to close.
    let postReconcile = null;
    let isFlat = unresolvedExits.length === 0;
    try {
        postReconcile = await tradingEngine.reconcilePositions();
        const orphaned = (postReconcile.orphaned || []).length;
        const phantom = (postReconcile.phantom || []).filter(p => !p.pendingExit && !p.transientGrace).length;
        const qtyMismatch = (postReconcile.quantityMismatch || []).length;
        isFlat = unresolvedExits.length === 0 && orphaned === 0 && phantom === 0 && qtyMismatch === 0;
    } catch (reconErr) {
        logger.error(`Post-emergency reconcile failed: ${reconErr.message}`);
        isFlat = false;
    }

    logger.warn(
        `EMERGENCY EXIT COMPLETE${liveOnly ? ' (live only)' : ''}: ` +
        `${exits.length} closed, ${unresolvedExits.length} unresolved, ` +
        `total P&L: $${totalPnl.toFixed(2)}, is_flat=${isFlat}`
    );

    const result = {
        closed: exits.length,
        totalPnl,
        exits,
        unresolved: unresolvedExits.length,
        unresolved_exits: unresolvedExits,
        post_reconcile: postReconcile
            ? {
                orphaned: (postReconcile.orphaned || []).length,
                phantom: (postReconcile.phantom || []).filter(p => !p.pendingExit && !p.transientGrace).length,
                qtyMismatch: (postReconcile.quantityMismatch || []).length
            }
            : null,
        is_flat: isFlat
    };
    botState.cleanupStatus = isFlat ? 'complete' : 'complete_non_flat';
    botState.cleanupResult = result;
    return result;
}

// ===== Initialize Components =====

const db = new PredictionDatabase();
const rateLimiter = new RateLimiter();

const polyClient = new PolymarketClient({ rateLimiter });
const kalshiClient = new KalshiClient({ rateLimiter });
const geminiMode = process.env.GEMINI_MODE || 'paper'; // 'paper' | 'live' | 'sandbox'
const tradingProfile = process.env.TRADING_PROFILE || 'standard';
const dataOnlyMode = process.env.DATA_ONLY === 'true'; // Collect price data without trading
const autonomous15mSession = process.env.AUTONOMOUS_15M_SESSION === 'true';
const DEFAULT_AUTONOMOUS_ALLOWED_SIGNAL_TYPES = autonomous15mSession
    ? 'fair_value'
    : 'fair_value,composite';
const autonomousAllowedSignalTypes = new Set(
    (process.env.AUTONOMOUS_ALLOWED_SIGNAL_TYPES || DEFAULT_AUTONOMOUS_ALLOWED_SIGNAL_TYPES)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
);
const sessionLossLimitUsd = Math.abs(Number(process.env.SESSION_DAILY_LOSS_LIMIT_USD || 3));
const sessionMinTtxSeconds = Math.max(60, Number(process.env.SESSION_MIN_TTX_SECONDS || 600));
const sessionMaxTtxSeconds = Math.max(sessionMinTtxSeconds, Number(process.env.SESSION_MAX_TTX_SECONDS || 3600));
const allowLongTtxIn15mSession = String(process.env.ALLOW_LONG_TTX_IN_15M_SESSION || '').toLowerCase() === 'true';
const SPOT_STALE_THRESHOLD_MS = Math.max(1000, Number(process.env.SPOT_STALE_THRESHOLD_MS || 30000));
const sessionMaxConcurrentLive = Math.max(1, Number(process.env.SESSION_MAX_CONCURRENT_LIVE || 1));
const LIVE_PREFLIGHT_TTL_MS = Math.max(1000, Number(process.env.LIVE_PREFLIGHT_TTL_MS || 300000));
const AUTONOMOUS_SOURCE_TTX_FILTER = autonomous15mSession && process.env.AUTONOMOUS_SOURCE_TTX_FILTER !== 'false';
const GEMINI_REAL_FETCH_INTERVAL_MS = Math.max(
    5000,
    Number(process.env.GEMINI_REAL_FETCH_INTERVAL_MS || (autonomous15mSession ? 10000 : 30000))
);
const GEMINI_TICKER_FETCH_INTERVAL_MS = Math.max(
    1000,
    Number(process.env.GEMINI_TICKER_FETCH_INTERVAL_MS || (autonomous15mSession ? 1000 : 3000))
);
const REF_BULK_REFRESH_INTERVAL_MS = Math.max(
    3000,
    Number(process.env.REF_BULK_REFRESH_INTERVAL_MS || (autonomous15mSession ? 5000 : 30000))
);
const PRICE_UPDATE_INTERVAL_MS = Math.max(
    1000,
    Number(process.env.PRICE_UPDATE_INTERVAL_MS || (autonomous15mSession ? 1000 : 5000))
);
const MATCH_INTERVAL_MS = Math.max(
    5000,
    Number(process.env.MATCH_INTERVAL_MS || (autonomous15mSession ? 10000 : 60000))
);
const CLEANUP_INTERVAL_MS = Math.max(
    10000,
    Number(process.env.CLEANUP_INTERVAL_MS || (autonomous15mSession ? 60000 : 3600000))
);
const geminiClient = new GeminiClient({
    mode: geminiMode,
    rateLimiter,
    categories: ['crypto', 'politics', 'sports', 'other'],
    useRealPrices: true,        // Use real Gemini Predictions API prices instead of simulation
    realisticPaper: true,       // Use actual bid/ask for paper fills (not synthetic mid)
    realFetchInterval: GEMINI_REAL_FETCH_INTERVAL_MS,
    tickerFetchInterval: GEMINI_TICKER_FETCH_INTERVAL_MS,
    sessionMinTtxSeconds: autonomous15mSession ? sessionMinTtxSeconds : null,
    sessionMaxTtxSeconds: autonomous15mSession ? sessionMaxTtxSeconds : null,
    sourceSessionTtxFilterEnabled: AUTONOMOUS_SOURCE_TTX_FILTER,
    cacheTTL: 2000,             // 2s cache TTL
    realCacheTTL: 5000,         // 5s real client cache TTL
    realApiInterval: 1000       // 1s min between Gemini requests
});

const matcher = new MarketMatcher(db);
const oddsClient = new OddsApiClient({ apiKey: process.env.ODDS_API_KEY });
const metaculusClient = new MetaculusClient();
const deribitClient = new DeribitClient();
const signalDetector = new SignalDetector(db, {
    feePerSide: 0.0001,
    minEdge: 0.03,
    highConfidenceEdge: 0.08,
    kalshiClient: kalshiClient
});
const tradingEngine = new PaperTradingEngine(db, geminiClient, {
    tradingProfile,
    autonomous15mSession,
    sessionLossLimitUsd,
    sessionMinTtxSeconds,
    sessionMaxTtxSeconds,
    sessionMaxConcurrentLive
});
const alerts = new Alerts({ webhookUrl: process.env.DISCORD_WEBHOOK_URL });
const kalshiWS = new KalshiWS({ apiKey: process.env.KALSHI_API_KEY });
const spotWS = new SpotWebSocket(logger);

const livePreflightState = {
    checked_at: null,
    expires_at: null,
    valid: false,
    reason: 'not_run',
    token: null,
    details: {}
};

// Wire Kalshi WS tick data into kalshiClient bracket cache
kalshiWS.on('tick', (tick) => {
    // Update kalshiClient's internal price cache so analyzeGeminiContract() gets fresh data
    if (kalshiClient.bracketCache) {
        kalshiClient.bracketCache.set(tick.marketTicker, {
            yesBid: tick.yesBid,
            yesAsk: tick.yesAsk,
            lastPrice: tick.lastPrice,
            volume: tick.volume,
            ts: tick.ts,
            source: 'ws'
        });
    }
});

// Wire Spot WS real-time price updates into spotPriceCache
spotWS.on('tick', (tick) => {
    const { asset, price } = tick;
    if (Number.isFinite(price) && price > 0) {
        updateSpotObservation(asset, price, {
            fetchedAt: new Date(tick.timestamp).toISOString(),
            source: 'realtime-ws',
            selectedFrom: 'kraken-ws',
            sourceCount: 1,
            sources: { 'kraken-ws': price }
        });
        // Record when this websocket tick arrived
        lastWebsocketTickTime = Date.now();
    }
});


// Spot price state — fed to FairValueEngine for Black-Scholes pricing
let spotPriceCache = {};
let spotPriceMeta = {};
let lastSpotFetch = 0;
let lastWebsocketTickTime = 0;  // Track when websocket last provided a tick
const SPOT_REFRESH_INTERVAL = 2000; // 2s between spot requests

function median(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function updateSpotObservation(asset, price, meta = {}) {
    if (!Number.isFinite(price) || price <= 0) return;
    spotPriceCache[asset] = price;
    spotPriceMeta[asset] = {
        asset,
        price,
        fetchedAt: meta.fetchedAt || new Date().toISOString(),
        source: meta.source || null,
        selectedFrom: meta.selectedFrom || null,
        sourceCount: Number(meta.sourceCount || 0),
        sources: meta.sources || {}
    };
    signalDetector.recordSpotPrice(asset, price);
}

async function fetchJson(url, timeoutMs = 4000) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
    }
    return resp.json();
}

/**
 * Fetch live crypto spot prices.
 * Primary: Kraken WebSocket real-time ticks (if available)
 * Fallback: Multi-source REST aggregation (Kraken + Coinbase + Binance median)
 * Used by FairValueEngine for Black-Scholes binary option pricing
 */
async function fetchSpotPrices() {
    // Skip REST fetch if we have recent websocket data
    // WebSocket emits continuously, so if we have websocket data, use it and don't re-fetch
    const timeSinceLastWebsocketTick = Date.now() - lastWebsocketTickTime;
    const hasRecentWebsocketData = timeSinceLastWebsocketTick < 10000; // Within last 10s
    
    if (hasRecentWebsocketData) {
        // WebSocket data is available and relatively recent, no need to fetch via REST
        lastSpotFetch = Date.now();
        return spotPriceCache;
    }

    // Fall through to REST fetch if websocket stale or not yet connected
    if (Date.now() - lastSpotFetch < SPOT_REFRESH_INTERVAL) return spotPriceCache;

    const fetchedAt = new Date().toISOString();
    try {
        const [krakenResult, coinbaseResult, binanceResult] = await Promise.allSettled([
            fetchJson('https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD,XETHZUSD,SOLUSD,XXRPZUSD,XZECZUSD', 4000),
            fetchJson('https://api.coinbase.com/v2/prices/BTC-USD/spot', 3000),
            fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', 3000)
        ]);

        let krakenBtc = null;
        if (krakenResult.status === 'fulfilled' && krakenResult.value?.result) {
            for (const [key, val] of Object.entries(krakenResult.value.result)) {
                const price = parseFloat(val.c?.[0]);
                if (!Number.isFinite(price) || price <= 0) continue;

                if (key.includes('XBT') || key.includes('BTC')) {
                    krakenBtc = price;
                } else if (key.includes('ETH')) {
                    updateSpotObservation('ETH', price, {
                        fetchedAt,
                        source: 'kraken',
                        selectedFrom: 'kraken',
                        sourceCount: 1,
                        sources: { kraken: price }
                    });
                } else if (key.includes('SOL')) {
                    updateSpotObservation('SOL', price, {
                        fetchedAt,
                        source: 'kraken',
                        selectedFrom: 'kraken',
                        sourceCount: 1,
                        sources: { kraken: price }
                    });
                } else if (key.includes('XRP')) {
                    updateSpotObservation('XRP', price, {
                        fetchedAt,
                        source: 'kraken',
                        selectedFrom: 'kraken',
                        sourceCount: 1,
                        sources: { kraken: price }
                    });
                } else if (key.includes('ZEC')) {
                    updateSpotObservation('ZEC', price, {
                        fetchedAt,
                        source: 'kraken',
                        selectedFrom: 'kraken',
                        sourceCount: 1,
                        sources: { kraken: price }
                    });
                }
            }
            recordApiResult('kraken', true);
        } else {
            const krakenError = krakenResult.status === 'rejected'
                ? krakenResult.reason
                : new Error('Kraken returned no result');
            recordApiResult('kraken', false, krakenError);
        }

        const btcSources = {};
        if (Number.isFinite(krakenBtc)) btcSources.kraken = krakenBtc;

        if (coinbaseResult.status === 'fulfilled') {
            const coinbasePrice = Number(coinbaseResult.value?.data?.amount);
            if (Number.isFinite(coinbasePrice) && coinbasePrice > 0) {
                btcSources.coinbase = coinbasePrice;
            }
        }

        if (binanceResult.status === 'fulfilled') {
            const binancePrice = Number(binanceResult.value?.price);
            if (Number.isFinite(binancePrice) && binancePrice > 0) {
                btcSources.binance = binancePrice;
            }
        }

        const btcValues = Object.values(btcSources).filter(v => Number.isFinite(v) && v > 0);
        if (btcValues.length > 0) {
            updateSpotObservation('BTC', median(btcValues), {
                fetchedAt,
                source: btcValues.length > 1 ? 'aggregated-median' : Object.keys(btcSources)[0],
                selectedFrom: btcValues.length > 1 ? 'median' : Object.keys(btcSources)[0],
                sourceCount: btcValues.length,
                sources: btcSources
            });
        }

        if (Object.keys(spotPriceCache).length > 0) {
            lastSpotFetch = Date.now();
        }
    } catch (e) {
        logger.debug('Spot price fetch: ' + e.message);
    }
    return spotPriceCache;
}

/**
 * Build Gemini contracts for fair-value analysis from matched markets
 * Parses contract labels like "BTC > $67,500" into structured data
 */
function buildGeminiContracts(matchedMarkets, marketStates) {
    const contracts = [];
    for (const state of marketStates) {
        const title = state.matchedMarket?.event_title || '';
        const parsed = FairValueEngine.parseContractLabel(title);
        if (!parsed) continue;

        // Determine settlement time
        const settlementHour = FairValueEngine.parseSettlementHour(title);

        // Build expiry date: today or tomorrow at settlement hour EST
        let expiryDate = null;
        if (settlementHour !== null) {
            const now = new Date();
            expiryDate = new Date(now);
            expiryDate.setUTCHours(settlementHour + 5, 0, 0, 0); // EST → UTC
            if (expiryDate <= now) {
                expiryDate.setDate(expiryDate.getDate() + 1);
            }
        } else {
            // Default: 12 hours from now
            expiryDate = new Date(Date.now() + 12 * 3600 * 1000);
        }

        contracts.push({
            asset: parsed.asset,
            strike: parsed.strike,
            bid: state.gemini?.bid || null,
            ask: state.gemini?.ask || null,
            expiryDate,
            marketId: state.marketId,
            eventTitle: title,
            settlementHour
        });
    }
    return contracts;
}

function parseGemiExpirySeconds(instrumentSymbol) {
    if (!instrumentSymbol) return null;
    const m = instrumentSymbol.match(/GEMI-\w+?(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
    if (!m) return null;
    const [, yy, mm, dd, hh, mn] = m;
    const expiry = Date.parse(`20${yy}-${mm}-${dd}T${hh}:${mn}:00Z`);
    if (!Number.isFinite(expiry)) return null;
    return (expiry - Date.now()) / 1000;
}

function getSpotAgeMs(asset) {
    if (!asset) return null;
    const meta = spotPriceMeta[asset];
    if (!meta || !meta.fetchedAt) return null;
    const ts = Date.parse(meta.fetchedAt);
    if (!Number.isFinite(ts)) return null;
    return Date.now() - ts;
}

function isLiveOrSandboxMode() {
    return geminiMode === 'live' || geminiMode === 'sandbox';
}

function hasValidLivePreflightToken(token) {
    if (!isLiveOrSandboxMode()) return true;
    if (!token || !livePreflightState.token) return false;
    if (token !== livePreflightState.token) return false;
    if (!livePreflightState.valid) return false;
    if (!livePreflightState.expires_at) return false;
    return Date.now() < Date.parse(livePreflightState.expires_at);
}

async function runLivePreflightCheck(options = {}) {
    const { forceGate = true } = options;
    const now = Date.now();

    if (!isLiveOrSandboxMode()) {
        livePreflightState.checked_at = new Date(now).toISOString();
        livePreflightState.expires_at = null;
        livePreflightState.valid = true;
        livePreflightState.reason = 'non_live_mode';
        livePreflightState.token = null;
        livePreflightState.details = { mode: geminiMode };
        return { ...livePreflightState };
    }

    const details = {
        mode: geminiMode,
        balance: null,
        positions: 0,
        open_orders: 0,
        reconciliation: null,
        gate: null
    };

    try {
        const [balance, positions, openOrders, reconciliation, gate] = await Promise.all([
            geminiClient.getAvailableBalance(),
            geminiClient.getPositions(),
            geminiClient.getOpenOrders(),
            tradingEngine.reconcilePositions(),
            forceGate ? tradingEngine.evaluatePreTradeSafetyGate(true) : Promise.resolve(tradingEngine.getStatus().pre_trade_gate)
        ]);

        const nonPendingPhantom = (reconciliation?.phantom || []).filter(p => !p.pendingExit && !p.transientGrace);
        details.balance = Number.isFinite(Number(balance)) ? Number(balance) : null;
        details.positions = Array.isArray(positions) ? positions.length : 0;
        details.open_orders = Array.isArray(openOrders) ? openOrders.length : 0;
        details.reconciliation = {
            orphaned: (reconciliation?.orphaned || []).length,
            phantom: nonPendingPhantom.length,
            quantityMismatch: (reconciliation?.quantityMismatch || []).length
        };
        details.gate = gate || null;

        const cleanReconcile =
            details.reconciliation.orphaned === 0 &&
            details.reconciliation.phantom === 0 &&
            details.reconciliation.quantityMismatch === 0;
        const cleanOrders = details.open_orders === 0;
        const hasBalance = details.balance != null && details.balance > 0;
        const gateAllowed = gate ? !!gate.allowed : false;

        const valid = hasBalance && cleanReconcile && cleanOrders && gateAllowed;
        const reason = !hasBalance
            ? 'balance_unavailable'
            : !cleanReconcile
                ? 'reconciliation_not_clean'
                : !cleanOrders
                    ? 'open_orders_present'
                    : !gateAllowed
                        ? `pre_trade_gate_blocked:${gate?.reason || 'unknown'}`
                        : 'ok';

        livePreflightState.checked_at = new Date(now).toISOString();
        livePreflightState.expires_at = valid ? new Date(now + LIVE_PREFLIGHT_TTL_MS).toISOString() : null;
        livePreflightState.valid = valid;
        livePreflightState.reason = reason;
        livePreflightState.token = valid ? `${now}-${Math.random().toString(36).slice(2, 10)}` : null;
        livePreflightState.details = details;

        if (valid) {
            tradingEngine._liveBalance = details.balance;
        }

        return { ...livePreflightState };
    } catch (error) {
        livePreflightState.checked_at = new Date(now).toISOString();
        livePreflightState.expires_at = null;
        livePreflightState.valid = false;
        livePreflightState.reason = 'preflight_error';
        livePreflightState.token = null;
        livePreflightState.details = { ...details, error: error.message };
        return { ...livePreflightState };
    }
}

function getSignalContext(marketId) {
    if (!marketId) return null;
    return (latestActionable || []).find(signal => signal.marketId === marketId)
        || (latestSignals || []).find(signal => signal.marketId === marketId)
        || null;
}

function buildRuntimeFairValueCandidates(options = {}) {
    const minNetEdge = Math.max(0, Number(options.minNetEdge ?? 0.01));
    const minTtxSeconds = Math.max(0, Number(options.minTtxSeconds ?? 600));
    const maxTtxSeconds = Math.max(minTtxSeconds, Number(options.maxTtxSeconds ?? 3600));
    const includeSignalTypes = new Set(['fair_value', 'multi_source_fv']);

    return (latestActionable || [])
        .filter(sig => sig && includeSignalTypes.has(sig.signalType))
        .filter(sig => sig.marketId && String(sig.marketId).startsWith('GEMI-'))
        .filter(sig => sig.direction === 'YES' || sig.direction === 'NO')
        .filter(sig => Number(sig.netEdge || 0) >= minNetEdge)
        .filter(sig => {
            const ttx = parseGemiExpirySeconds(sig.marketId);
            if (ttx == null) return true;
            return ttx >= minTtxSeconds && ttx <= maxTtxSeconds;
        })
        .map(sig => ({
            deribit_component: (sig.models?.ensemble?.components || []).find(c => c.model === 'DERIBIT') || null,
            marketId: sig.marketId,
            title: sig.title,
            category: sig.category || 'other',
            signalType: sig.signalType,
            pricingModel: sig.pricingModel || (sig.signalType === 'multi_source_fv' ? 'MULTI_SOURCE_ENSEMBLE' : null),
            direction: sig.direction,
            netEdge: Number(sig.netEdge || 0),
            edge: Number(sig.edge || sig.netEdge || 0),
            confidence: sig.confidence,
            score: Number(sig.score || 0),
            gemini_bid: sig.gemini_bid,
            gemini_ask: sig.gemini_ask,
            fairValue: sig.referencePrice ?? sig.fairValue ?? null,
            deribit_fair_value: sig.models?.deribit?.fairValue ?? null,
            deribit_weight: (sig.models?.ensemble?.components || []).find(c => c.model === 'DERIBIT')?.weight ?? null,
            model_components: sig.models?.ensemble?.components || [],
            ttx_seconds: parseGemiExpirySeconds(sig.marketId),
            source: 'runtime_actionable'
        }));
}

function buildDeepFairValueContracts(options = {}) {
    if (!geminiClient?.paperMarkets) return [];
    const minTtxSeconds = Math.max(0, Number(options.minTtxSeconds ?? 600));
    const maxTtxSeconds = Math.max(minTtxSeconds, Number(options.maxTtxSeconds ?? 3600));
    const contracts = [];
    const marketEntries = Array.from(geminiClient.paperMarkets.entries());

    for (const [instrumentSymbol, market] of marketEntries) {
        if (!instrumentSymbol || !instrumentSymbol.startsWith('GEMI-')) continue;
        if (market?.bid == null || market?.ask == null) continue;

        const ttx = parseGemiExpirySeconds(instrumentSymbol);
        if (ttx == null || ttx < minTtxSeconds || ttx > maxTtxSeconds) continue;

        const eventTitle = market.title || '';
        const label = market.title || '';
        const fullTitle = `${eventTitle}: ${label}`;

        // First try canonical parser (expects e.g. "BTC > $70,000")
        let parsed = FairValueEngine.parseContractLabel(fullTitle) || FairValueEngine.parseContractLabel(eventTitle);

        // Fallback for alternative Gemini label formats
        // Examples: "BTC price today at 2pm EDT: $70,000 or above"
        if (!parsed) {
            const assetMatch = fullTitle.match(/\b(BTC|ETH|SOL|XRP|ZEC)\b/i);
            const strikeMatch = fullTitle.match(/\$\s*([\d,]+(?:\.\d+)?)/);
            if (assetMatch && strikeMatch) {
                parsed = {
                    asset: assetMatch[1].toUpperCase(),
                    strike: parseFloat(String(strikeMatch[1]).replace(/,/g, ''))
                };
            }
        }
        if (!parsed) continue;

        const expiryDate = new Date(Date.now() + ttx * 1000);
        contracts.push({
            asset: parsed.asset,
            strike: parsed.strike,
            bid: Number(market.bid),
            ask: Number(market.ask),
            expiryDate,
            marketId: instrumentSymbol,
            eventTitle: fullTitle.trim(),
            settlementHour: null
        });
    }

    return contracts.filter(c => Number.isFinite(c.bid) && Number.isFinite(c.ask) && c.ask > c.bid);
}

function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function createCorrelationId(prefix = 'op') {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${Date.now()}-${rand}`;
}

function logLifecycle(component, correlationId, stage, fields = {}) {
    const payload = {
        correlationId,
        stage,
        ...fields
    };
    logger.info(`[${component}] ${JSON.stringify(payload)}`);
}

async function buildSessionCheckpointSummary(options = {}) {
    const decisionMs = Math.max(60000, Number(options.decisionMs ?? 300000));
    const minActionable = Math.max(0, Number(options.minActionable ?? 3));
    const minRuntimeFairValue = Math.max(0, Number(options.minRuntimeFairValue ?? 1));
    const minNetEdge = Math.max(0, Number(options.minNetEdge ?? 0.04));
    const forceGate = !!options.forceGate;

    const status = tradingEngine.getStatus();
    const sessionPolicy = status.session_policy || {};
    const preTradeGate = forceGate
        ? await tradingEngine.evaluatePreTradeSafetyGate(true)
        : (status.pre_trade_gate || null);
    const elapsedMs = Number(sessionPolicy.elapsed_ms || 0);
    const hasSessionStart = Number.isFinite(elapsedMs) && elapsedMs > 0;
    const sessionRunning = botState.running && hasSessionStart;

    const minTtxSeconds = Number.isFinite(Number(sessionPolicy.min_ttx_seconds))
        ? Number(sessionPolicy.min_ttx_seconds)
        : 900;
    const maxTtxSeconds = Number.isFinite(Number(sessionPolicy.max_ttx_seconds))
        ? Number(sessionPolicy.max_ttx_seconds)
        : 3600;

    const actionableSignals = latestActionable || [];
    const shortTtxActionable = actionableSignals.filter(sig => {
        if (!sig || !sig.marketId || !String(sig.marketId).startsWith('GEMI-')) return false;
        const ttx = parseGemiExpirySeconds(sig.marketId);
        if (ttx == null) return false;
        return ttx >= minTtxSeconds && ttx <= maxTtxSeconds;
    });
    const runtimeFairValueCandidates = buildRuntimeFairValueCandidates({
        minNetEdge,
        minTtxSeconds,
        maxTtxSeconds
    });
    const sessionUniverse = geminiClient.getSessionUniverseStats();

    const sessionStartSec = sessionPolicy.session_start_time_ms
        ? Math.floor(Number(sessionPolicy.session_start_time_ms) / 1000)
        : null;
    const recentClosed = db.getRecentTrades(500, geminiMode === 'live' ? 'live' : undefined) || [];
    const closedSinceStart = sessionStartSec
        ? recentClosed.filter(t => Number(t.timestamp || 0) >= sessionStartSec)
        : [];
    const openByMode = geminiMode === 'live' ? db.getOpenTrades('live') : db.getOpenTrades();
    const openSinceStart = sessionStartSec
        ? (openByMode || []).filter(t => Number(t.timestamp || 0) >= sessionStartSec)
        : (openByMode || []);
    const tradesOpenedSinceStart = closedSinceStart.length + openSinceStart.length;

    const liveWalletBalance = Number(status?.wallet?.balance);
    const hasLiveBalance = !isLiveOrSandboxMode() || Number.isFinite(liveWalletBalance);
    const deepSignalFlowOk = runtimeFairValueCandidates.length >= minRuntimeFairValue;
    const broadSignalFlowOk = actionableSignals.length >= minActionable || shortTtxActionable.length >= minActionable;
    const gateAllowed = preTradeGate ? !!preTradeGate.allowed : false;

    const decision = {
        value: 'continue',
        reason: 'ok',
        recommended_actions: []
    };

    if (!botState.running) {
        decision.value = 'idle';
        decision.reason = 'bot_not_running';
        decision.recommended_actions.push('Start bot session before using checkpoint decisions.');
    } else if (health.circuitOpen) {
        decision.value = 'abort';
        decision.reason = 'circuit_breaker_open';
        decision.recommended_actions.push('Wait for breaker cooldown or restart the server after API stabilization.');
    } else if (!hasLiveBalance) {
        decision.value = 'abort';
        decision.reason = 'live_balance_unavailable';
        decision.recommended_actions.push('Run POST /api/bot/preflight and verify Gemini balance connectivity.');
    } else if (!gateAllowed && preTradeGate?.reason !== 'session_profit_target_hit') {
        decision.value = 'abort';
        decision.reason = `pre_trade_gate_blocked:${preTradeGate?.reason || 'unknown'}`;
        decision.recommended_actions.push('Run POST /api/reconcile/fix then POST /api/bot/preflight before restarting.');
    } else if (!sessionRunning || elapsedMs < decisionMs) {
        decision.value = 'warmup';
        decision.reason = 'checkpoint_window_not_reached';
        decision.recommended_actions.push('Keep collecting data until checkpoint window is reached.');
    } else if (!broadSignalFlowOk && !deepSignalFlowOk) {
        decision.value = 'abort';
        decision.reason = 'signal_starvation';
        decision.recommended_actions.push('Relax min edge slightly or wait for stronger market activity.');
    } else if (tradesOpenedSinceStart === 0 && (broadSignalFlowOk || deepSignalFlowOk)) {
        decision.value = 'abort';
        decision.reason = 'no_entries_despite_signals';
        decision.recommended_actions.push('Inspect rejection reasons and adjust spread/edge gate before retry.');
    } else if (preTradeGate?.reason === 'session_profit_target_hit') {
        decision.value = 'complete';
        decision.reason = 'session_profit_target_hit';
        decision.recommended_actions.push('Stop session and reconcile for next attempt.');
    }

    return {
        generated_at: new Date().toISOString(),
        decision,
        checkpoint: {
            elapsed_ms: elapsedMs,
            decision_ms: decisionMs,
            remaining_ms: Math.max(0, decisionMs - elapsedMs),
            session_running: sessionRunning,
            bot_running: botState.running,
            mode: geminiMode
        },
        thresholds: {
            min_actionable: minActionable,
            min_runtime_fair_value: minRuntimeFairValue,
            min_net_edge: minNetEdge,
            min_ttx_seconds: minTtxSeconds,
            max_ttx_seconds: maxTtxSeconds
        },
        session_universe: sessionUniverse,
        metrics: {
            actionable_count: actionableSignals.length,
            short_ttx_actionable_count: shortTtxActionable.length,
            runtime_fair_value_count: runtimeFairValueCandidates.length,
            trades_opened_since_start: tradesOpenedSinceStart,
            open_positions: (openByMode || []).length,
            circuit_open: health.circuitOpen,
            has_live_balance: hasLiveBalance,
            wallet_balance: Number.isFinite(liveWalletBalance) ? liveWalletBalance : null,
            gate_allowed: gateAllowed,
            gate_reason: preTradeGate?.reason || null,
            gate_details: preTradeGate?.details || null
        }
    };
}

async function buildSessionReadinessSummary(options = {}) {
    const minActionable = Math.max(0, Number(options.minActionable ?? 2));
    const minRuntimeFairValue = Math.max(0, Number(options.minRuntimeFairValue ?? 1));
    const minNetEdge = Math.max(0, Number(options.minNetEdge ?? 0.04));
    const forcePreflight = !!options.forcePreflight;
    const forceGate = !!options.forceGate;

    const status = tradingEngine.getStatus();
    const sessionPolicy = status.session_policy || {};
    const minTtxSeconds = Number.isFinite(Number(sessionPolicy.min_ttx_seconds))
        ? Number(sessionPolicy.min_ttx_seconds)
        : 900;
    const maxTtxSeconds = Number.isFinite(Number(sessionPolicy.max_ttx_seconds))
        ? Number(sessionPolicy.max_ttx_seconds)
        : 3600;

    const preflight = forcePreflight
        ? await runLivePreflightCheck({ forceGate })
        : { ...livePreflightState };

    const gateFromStatus = status.pre_trade_gate || null;
    const gate = (preflight?.details && preflight.details.gate)
        ? preflight.details.gate
        : (forceGate ? await tradingEngine.evaluatePreTradeSafetyGate(true) : gateFromStatus);

    const actionableSignals = latestActionable || [];
    const shortTtxActionable = actionableSignals.filter(sig => {
        if (!sig || !sig.marketId || !String(sig.marketId).startsWith('GEMI-')) return false;
        const ttx = parseGemiExpirySeconds(sig.marketId);
        if (ttx == null) return false;
        return ttx >= minTtxSeconds && ttx <= maxTtxSeconds;
    });

    const runtimeFairValueCandidates = buildRuntimeFairValueCandidates({
        minNetEdge,
        minTtxSeconds,
        maxTtxSeconds
    });
    const sessionUniverse = geminiClient.getSessionUniverseStats();

    const liveWalletBalance = Number(status?.wallet?.balance);
    const hasLiveBalance = !isLiveOrSandboxMode() || (Number.isFinite(liveWalletBalance) && liveWalletBalance > 0);
    const signalFlowOk = actionableSignals.length >= minActionable || runtimeFairValueCandidates.length >= minRuntimeFairValue;
    const gateAllowed = gate ? !!gate.allowed : !isLiveOrSandboxMode();
    const preflightValid = !isLiveOrSandboxMode() || !!preflight?.valid;

    const checks = [
        {
            key: 'circuit_breaker_closed',
            pass: !health.circuitOpen,
            required: true,
            value: !health.circuitOpen,
            detail: health.circuitOpen ? 'Circuit breaker is open.' : 'Circuit breaker is closed.'
        },
        {
            key: 'live_preflight_valid',
            pass: preflightValid,
            required: true,
            value: preflight?.valid ?? !isLiveOrSandboxMode(),
            detail: preflight?.reason || (isLiveOrSandboxMode() ? 'unknown' : 'non_live_mode')
        },
        {
            key: 'pre_trade_gate_allowed',
            pass: gateAllowed,
            required: true,
            value: gateAllowed,
            detail: gate?.reason || 'unknown'
        },
        {
            key: 'wallet_available',
            pass: hasLiveBalance,
            required: true,
            value: Number.isFinite(liveWalletBalance) ? liveWalletBalance : null,
            detail: hasLiveBalance ? 'Wallet balance is available.' : 'Wallet balance missing or zero.'
        },
        {
            key: 'signal_flow_ready',
            pass: signalFlowOk,
            required: true,
            value: {
                actionable_count: actionableSignals.length,
                runtime_fair_value_count: runtimeFairValueCandidates.length,
                short_ttx_actionable_count: shortTtxActionable.length
            },
            detail: signalFlowOk ? 'Signal flow is sufficient.' : 'Not enough actionable signal flow yet.'
        },
        {
            key: 'bot_not_running',
            pass: !botState.running,
            required: false,
            value: !botState.running,
            detail: botState.running ? 'Bot is already running.' : 'Bot is currently stopped.'
        }
    ];

    const requiredFailed = checks.filter(check => check.required && !check.pass);
    const readyToStart = requiredFailed.length === 0;

    const summaryText = readyToStart
        ? 'Ready to start a session.'
        : `Not ready: ${requiredFailed.map(check => check.key).join(', ')}`;

    return {
        generated_at: new Date().toISOString(),
        ready_to_start: readyToStart,
        summary: summaryText,
        mode: geminiMode,
        checks,
        thresholds: {
            min_actionable: minActionable,
            min_runtime_fair_value: minRuntimeFairValue,
            min_net_edge: minNetEdge,
            min_ttx_seconds: minTtxSeconds,
            max_ttx_seconds: maxTtxSeconds
        },
        session_universe: sessionUniverse,
        context: {
            bot_running: botState.running,
            circuit_open: health.circuitOpen,
            preflight: {
                valid: preflight?.valid ?? false,
                reason: preflight?.reason || null,
                checked_at: preflight?.checked_at || null,
                expires_at: preflight?.expires_at || null
            },
            gate: {
                allowed: gateAllowed,
                reason: gate?.reason || null,
                details: gate?.details || null
            },
            signals: {
                actionable_count: actionableSignals.length,
                short_ttx_actionable_count: shortTtxActionable.length,
                runtime_fair_value_count: runtimeFairValueCandidates.length
            },
            wallet_balance: Number.isFinite(liveWalletBalance) ? liveWalletBalance : null
        }
    };
}

// ===== Express App =====

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../dashboard')));

// CORS for development
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    next();
});

// ===== REST API Endpoints =====

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: health.circuitOpen ? 'degraded' : 'ok',
        uptime: process.uptime(),
        bot_running: botState.running,
        timestamp: Date.now(),
        circuit_breaker: {
            open: health.circuitOpen,
            consecutive_errors: health.consecutiveErrors,
            total_errors: health.totalErrors,
            last_error: health.lastError
        },
        api_health: health.apiHealth,
        ws_clients: wss.clients.size,
        drawdown_limit: `${DRAWDOWN_LIMIT * 100}%`,
        peak_balance: peakBalance,
        live_preflight: {
            valid: livePreflightState.valid,
            reason: livePreflightState.reason,
            checked_at: livePreflightState.checked_at,
            expires_at: livePreflightState.expires_at
        }
    });
});

app.get('/api/bot/preflight', (req, res) => {
    res.json({
        mode: geminiMode,
        required: isLiveOrSandboxMode(),
        ...livePreflightState
    });
});

app.get('/api/session/checkpoint', async (req, res) => {
    try {
        const summary = await buildSessionCheckpointSummary({
            decisionMs: req.query.decision_ms,
            minActionable: req.query.min_actionable,
            minRuntimeFairValue: req.query.min_runtime_fair_value,
            minNetEdge: req.query.min_net_edge,
            forceGate: toBoolean(req.query.force_gate)
        });
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/session/readiness', async (req, res) => {
    try {
        const summary = await buildSessionReadinessSummary({
            minActionable: req.query.min_actionable,
            minRuntimeFairValue: req.query.min_runtime_fair_value,
            minNetEdge: req.query.min_net_edge,
            forcePreflight: toBoolean(req.query.force_preflight),
            forceGate: toBoolean(req.query.force_gate)
        });
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/bot/preflight', async (req, res) => {
    try {
        const preflight = await runLivePreflightCheck({ forceGate: true });
        res.status(preflight.valid ? 200 : 409).json({
            mode: geminiMode,
            required: isLiveOrSandboxMode(),
            ...preflight
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all matched markets with current prices
app.get('/api/markets', (req, res) => {
    try {
        const markets = db.getActiveMarkets();
        const prices = db.getLatestPrices();

        // Merge prices into markets
        const priceMap = {};
        for (const p of prices) {
            priceMap[p.gemini_market_id] = p;
        }

        const result = markets.map(m => ({
            ...m,
            prices: priceMap[m.gemini_market_id] || null
        }));

        res.json({ markets: result, count: result.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get matched markets
app.get('/api/matched-markets', (req, res) => {
    try {
        const minConfidence = parseFloat(req.query.min_confidence || 0.5);
        const matches = db.getMatchedMarkets(minConfidence);
        res.json({ matches, count: matches.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get current signals (opportunities) + arb/momentum events
app.get('/api/signals', (req, res) => {
    try {
        const minScore = parseFloat(req.query.min_score || 0);
        const signals = latestSignals.filter(s => s.score >= minScore);
        const actionableSignals = (latestActionable || []).filter(s => (s.score || 0) >= minScore);

        // Extract arb and momentum events from the latest actionable signals
        const allActionable = latestActionable || [];
        const arbEvents = allActionable
            .filter(s => s.arb && (s.netEdge || 0) >= 0.03)
            .map(s => ({
                marketId:    s.marketId,
                title:       s.title,
                direction:   s.direction,
                netEdge:     s.netEdge,
                geminiBid:   s.gemini_bid,
                geminiAsk:   s.gemini_ask,
                kalshiFV:    s.arb?.kalshiFairValue || s.referencePrice,
                score:       s.score,
                timestamp:   s.timestamp
            }));

        const momentumAlerts = allActionable
            .filter(s => s.momentum)
            .map(s => ({
                marketId:    s.marketId,
                title:       s.title,
                direction:   s.direction,
                contractLag: s.momentum?.contractLag,
                urgency:     s.momentum?.urgency,
                asset:       s.momentum?.asset,
                score:       s.score,
                timestamp:   s.timestamp
            }));

        res.json({
            signals,
            actionableSignals,
            count: signals.length,
            actionableCount: actionableSignals.length,
            arbEvents,
            momentumAlerts
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Diagnostic: signal type mix and non-actionable reason breakdown for latest cycle
app.get('/api/signals/types', (req, res) => {
    try {
        const scoredSignals = latestSignals || [];
        const actionableSignals = latestActionable || [];

        const scoredByType = {};
        const actionableByType = {};
        const nonActionableReasons = {};

        for (const signal of scoredSignals) {
            const signalType = signal.signalType || signal.signal_type || 'unknown';
            scoredByType[signalType] = (scoredByType[signalType] || 0) + 1;

            if (!signal.actionable) {
                const reason = signal.rejection_reason || 'unknown';
                nonActionableReasons[reason] = (nonActionableReasons[reason] || 0) + 1;
            }
        }

        for (const signal of actionableSignals) {
            const signalType = signal.signalType || signal.signal_type || 'unknown';
            actionableByType[signalType] = (actionableByType[signalType] || 0) + 1;
        }

        res.json({
            snapshot_at: new Date().toISOString(),
            total_scored: scoredSignals.length,
            total_actionable: actionableSignals.length,
            scored_by_type: scoredByType,
            actionable_by_type: actionableByType,
            non_actionable_reasons: nonActionableReasons,
            funnel: latestSignalFunnel
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/signals/funnel', (req, res) => {
    try {
        res.json({
            snapshot_at: new Date().toISOString(),
            autonomous_allowed_signal_types: Array.from(autonomousAllowedSignalTypes),
            session_universe: geminiClient.getSessionUniverseStats(),
            funnel: latestSignalFunnel,
            counters: {
                cumulative: cumulativeSignalFunnel,
                current_session: sessionSignalFunnel
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/signals/filters', (req, res) => {
    try {
        res.json({
            snapshot_at: new Date().toISOString(),
            autonomous_allowed_signal_types: Array.from(autonomousAllowedSignalTypes),
            cycle_count: latestSignalFunnel?.cycle_count || 0,
            dropped: latestSignalFunnel?.dropped || {},
            stages: latestSignalFunnel?.stages || {},
            counters: {
                cumulative: cumulativeSignalFunnel,
                current_session: sessionSignalFunnel
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/spot/status', (req, res) => {
    try {
        const assets = Object.keys(spotPriceMeta || {});
        const perAsset = {};
        let staleCount = 0;
        let maxAgeMs = 0;
        const staleAssets = [];
        const staleThresholdMs = SPOT_STALE_THRESHOLD_MS;
        for (const asset of assets) {
            const ageMs = getSpotAgeMs(asset);
            if (typeof ageMs === 'number') {
                maxAgeMs = Math.max(maxAgeMs, ageMs);
                if (ageMs > staleThresholdMs) {
                    staleCount += 1;
                    staleAssets.push(asset);
                }
            }
            perAsset[asset] = {
                age_ms: ageMs,
                source: spotPriceMeta[asset]?.source || null,
                fetched_at: spotPriceMeta[asset]?.fetchedAt || null,
                price: Number.isFinite(Number(spotPriceCache[asset])) ? Number(spotPriceCache[asset]) : null
            };
        }

        res.json({
            snapshot_at: new Date().toISOString(),
            websocket_connected: spotWS.isReady(),
            last_websocket_tick_ms: lastWebsocketTickTime || null,
            summary: {
                stale_threshold_ms: staleThresholdMs,
                stale_count: staleCount,
                stale_assets: staleAssets,
                max_age_ms: maxAgeMs
            },
            assets: perAsset
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Diagnostic: entry-rejection summary grouped by stage + reason
app.get('/api/rejections/summary', (req, res) => {
    try {
        const sinceMs = req.query.since_ms ? Number(req.query.since_ms) : (Date.now() - 15 * 60 * 1000);
        const stage = req.query.stage ? String(req.query.stage) : null;
        const mode = req.query.mode ? String(req.query.mode) : null;
        const limit = req.query.limit ? Number(req.query.limit) : 50;

        const grouped = db.getEntryRejectionSummary({ sinceMs, stage, mode });
        const recentRaw = db.getRecentEntryRejections({ sinceMs, limit, stage, mode });
        const recent = (recentRaw || []).map(row => {
            let details = null;
            if (row.rejection_details) {
                try {
                    details = JSON.parse(row.rejection_details);
                } catch (e) {
                    details = null;
                }
            }
            return {
                ...row,
                rejection_details: details
            };
        });

        const byReason = {};
        const byStage = {};
        for (const row of grouped) {
            byReason[row.rejection_reason] = (byReason[row.rejection_reason] || 0) + row.count;
            byStage[row.rejection_stage] = (byStage[row.rejection_stage] || 0) + row.count;
        }

        res.json({
            snapshot_at: new Date().toISOString(),
            since_ms: sinceMs,
            filters: { stage, mode },
            total_rejections: grouped.reduce((sum, r) => sum + (r.count || 0), 0),
            grouped,
            by_reason: byReason,
            by_stage: byStage,
            recent
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Deep fair-value scanner: searches ALL tradeable Gemini crypto contracts
// in the short-TTX window (15m/1h), not just matched-market subset.
app.get('/api/signals/deep-fv', async (req, res) => {
    try {
        const minNetEdge = Math.max(0, parseFloat(req.query.min_net_edge || 0.01));
        const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || 10, 10)));
        const minTtxRaw = req.query.min_ttx_seconds ?? req.query.min_ttx ?? '600';
        const maxTtxRaw = req.query.max_ttx_seconds ?? req.query.max_ttx ?? '3600';
        const minTtxSeconds = Math.max(0, parseInt(String(minTtxRaw), 10));
        const maxTtxSeconds = Math.max(minTtxSeconds, parseInt(String(maxTtxRaw), 10));

        await fetchSpotPrices();
        if (geminiClient.useRealPrices) {
            await geminiClient.refreshRealData();
        }

        const runtimeCandidates = buildRuntimeFairValueCandidates({
            minNetEdge,
            minTtxSeconds,
            maxTtxSeconds
        });
        const contracts = buildDeepFairValueContracts({ minTtxSeconds, maxTtxSeconds });
        const deribitByMarketId = new Map();
        for (const contract of contracts) {
            try {
                const ttx = parseGemiExpirySeconds(contract.marketId);
                if (ttx != null && ttx > 0 && ttx <= 3600 && contract.asset) {
                    const spread = await deribitClient.getOptionsSpread(contract.asset, ttx * 1000);
                    if (spread && Number.isFinite(spread.mid)) {
                        deribitByMarketId.set(contract.marketId, spread.mid);
                    }
                }
            } catch (e) {
                // Optional source: continue without Deribit enrichment
            }
        }

        const analyzed = await signalDetector.fairValueEngine.analyzeAll(
            contracts,
            kalshiClient,
            (contract) => ({
                category: 'crypto',
                deribit: deribitByMarketId.get(contract.marketId) ?? null
            })
        );
        const deepCandidates = analyzed
            .filter(sig => sig && sig.direction && (sig.netEdge || 0) >= minNetEdge)
            .map(sig => ({
                marketId: sig.marketId,
                title: sig.eventTitle,
                category: 'crypto',
                signalType: 'deep_fair_value',
                pricingModel: sig.pricingModel,
                direction: sig.direction,
                netEdge: sig.netEdge,
                edge: sig.edge,
                confidence: sig.confidence,
                score: Math.min(100, Math.round((sig.netEdge || 0) * 1000)),
                gemini_bid: sig.geminiBid,
                gemini_ask: sig.geminiAsk,
                fairValue: sig.fairValue,
                deribit_fair_value: sig.models?.deribit?.fairValue ?? null,
                deribit_weight: (sig.models?.ensemble?.components || []).find(c => c.model === 'DERIBIT')?.weight ?? null,
                model_components: sig.models?.ensemble?.components || [],
                ttx_seconds: parseGemiExpirySeconds(sig.marketId),
                source: 'deep_scan'
            }));

        const candidateMap = new Map();
        for (const candidate of [...runtimeCandidates, ...deepCandidates]) {
            const existing = candidateMap.get(candidate.marketId);
            if (!existing || Number(candidate.netEdge || 0) > Number(existing.netEdge || 0)) {
                candidateMap.set(candidate.marketId, candidate);
            }
        }

        const candidates = Array.from(candidateMap.values());
        candidates.sort((a, b) => (b.netEdge || 0) - (a.netEdge || 0));
        const top = candidates.slice(0, limit);
        const deribitEnrichedCount = top.filter(c => c.deribit_fair_value !== null && c.deribit_fair_value !== undefined).length;
        const deribitCoverageRatio = top.length > 0 ? Number((deribitEnrichedCount / top.length).toFixed(4)) : 0;

        res.json({
            minNetEdge,
            minTtxSeconds,
            maxTtxSeconds,
            scanned: contracts.length,
            runtimeCount: runtimeCandidates.length,
            deepScanCount: deepCandidates.length,
            count: top.length,
            deribitEnrichedCount,
            deribitCoverageRatio,
            candidates: top
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get open trades
app.get('/api/trades/open', (req, res) => {
    try {
        const mode = req.query.mode || null;
        const trades = db.getOpenTrades(mode);
        res.json({ trades, count: trades.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get recent closed trades
app.get('/api/trades/recent', (req, res) => {
    try {
        const limit = parseInt(req.query.limit || 50);
        const mode = req.query.mode || null;
        const trades = db.getRecentTrades(limit, mode);
        res.json({ trades, count: trades.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get wallet status (real Gemini balance in live mode)
app.get('/api/wallet', async (req, res) => {
    try {
        res.json(await getDisplayWallet());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get spot prices + fair value engine stats
app.get('/api/fair-value', async (req, res) => {
    try {
        const spots = await fetchSpotPrices();
        const fvStats = signalDetector.fairValueEngine.getStats();
        res.json({
            spot_prices: spots,
            spot_meta: spotPriceMeta,
            spot_refresh_interval_ms: SPOT_REFRESH_INTERVAL,
            fair_value_engine: fvStats,
            last_spot_fetch: lastSpotFetch ? new Date(lastSpotFetch).toISOString() : null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get performance summary
app.get('/api/performance', (req, res) => {
    try {
        const summary = db.getPerformanceSummary();
        const categoryRates = db.getWinRateByCategory(7);
        res.json({ ...summary, category_win_rates: categoryRates });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get daily P&L
app.get('/api/daily-pnl', (req, res) => {
    try {
        const pnl = db.getDailyPnL();
        res.json(pnl);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get daily P&L split by mode (paper vs live)
app.get('/api/pnl/split', (req, res) => {
    try {
        const paperPnl = db.getDailyPnL('paper');
        const livePnl = db.getDailyPnL('live');
        const totalPnl = db.getDailyPnL();
        res.json({ paper: paperPnl, live: livePnl, total: totalPnl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get bot parameters
app.get('/api/parameters', (req, res) => {
    try {
        const params = db.getAllParameters();
        res.json({ parameters: params });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update a bot parameter
app.post('/api/parameters/:key', (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;
        db.setParameter(key, parseFloat(value));
        tradingEngine.params[key] = parseFloat(value);
        res.json({ success: true, key, value: parseFloat(value) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get price history for a market
app.get('/api/market/:id/prices', (req, res) => {
    try {
        const since = parseInt(req.query.since || (Math.floor(Date.now() / 1000) - 3600));
        const prices = db.getPriceHistory(req.params.id, since);
        res.json({ prices, count: prices.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Execute manual paper trade
app.post('/api/trade/paper', (req, res) => {
    try {
        const { market_id, direction, position_size } = req.body;
        const order = geminiClient.executePaperTrade(market_id, direction, position_size);
        if (order.success) {
            const tradeId = db.insertTrade({
                timestamp: Math.floor(Date.now() / 1000),
                gemini_market_id: market_id,
                direction,
                entry_price: order.fill_price,
                position_size,
                mode: 'paper'
            });
            res.json({ success: true, trade_id: tradeId, order });
        } else {
            res.status(400).json({ success: false, error: order.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Execute manual live trade (constrained single-entry path)
app.post('/api/trade/live', async (req, res) => {
    try {
        const correlationId = String(req.headers['x-correlation-id'] || req.body?.correlation_id || createCorrelationId('mlive'));
        const rejectLive = (statusCode, error, reasonTag, extra = {}) => {
            logLifecycle('MANUAL_LIVE_ENTRY', correlationId, 'reject', { error, reasonTag, ...extra });
            return res.status(statusCode).json({ success: false, error, reason_tag: reasonTag, correlation_id: correlationId, ...extra });
        };
        const okLive = (payload = {}) => res.json({ correlation_id: correlationId, ...payload });

        if (geminiMode !== 'live' && geminiMode !== 'sandbox') {
            return rejectLive(400, 'Live trade endpoint requires GEMINI_MODE=live|sandbox', 'manual_live_mode_invalid');
        }

        const { market_id, direction, contracts, allow_open_orders, limit_price, keep_open, guard_profile } = req.body;
        const dir = String(direction || '').toUpperCase();
        const qty = Math.max(1, Math.floor(Number(contracts || 1)));
        const allowOpenOrders = Boolean(allow_open_orders);
        const requestedLimitPrice = limit_price == null ? null : Number(limit_price);
        const keepOpen = Boolean(keep_open);
        const isPassiveBidRequest = Number.isFinite(requestedLimitPrice);
        const requestedGuardProfile = String(guard_profile || '').toLowerCase();

        const envGuardProfile = String(process.env.MANUAL_LIVE_GUARD_PROFILE || '').toLowerCase();
        const sessionRelaxedGuard =
            requestedGuardProfile === 'session_relaxed' ||
            requestedGuardProfile === 'relaxed' ||
            envGuardProfile === 'session_relaxed' ||
            envGuardProfile === 'relaxed' ||
            toBoolean(process.env.MANUAL_LIVE_GUARD_RELAXED);

        logLifecycle('MANUAL_LIVE_ENTRY', correlationId, 'received', {
            marketId: market_id,
            direction: dir,
            contracts: qty,
            allowOpenOrders,
            passive: isPassiveBidRequest,
            guardProfile: sessionRelaxedGuard ? 'session_relaxed' : 'strict'
        });

        if (!market_id || !String(market_id).startsWith('GEMI-')) {
            return rejectLive(400, 'market_id must be a GEMI-* instrument', 'manual_live_market_invalid');
        }
        if (dir !== 'YES' && dir !== 'NO') {
            return rejectLive(400, 'direction must be YES or NO', 'manual_live_direction_invalid');
        }

        const candidateOrderIds = (o) => {
            const ids = [];
            if (o?.hashOrderId != null) ids.push(String(o.hashOrderId));
            if (o?.globalOrderId != null) ids.push(String(o.globalOrderId));
            if (o?.orderId != null) ids.push(String(o.orderId));
            if (o?.order_id != null) ids.push(String(o.order_id));
            if (o?.id != null) ids.push(String(o.id));
            return [...new Set(ids.filter(Boolean))];
        };

        // Clean up stale same-symbol manual entry orders left by earlier retries.
        let postPreCleanOrders = null;
        try {
            const openOrders = await geminiClient.getOpenOrders();
            const staleOrders = (openOrders || []).filter(o =>
                o.symbol === market_id &&
                String(o.side || '').toLowerCase() === 'buy' &&
                String(o.outcome || '').toUpperCase() === dir
            );

            for (const staleOrder of staleOrders) {
                for (const cancelId of candidateOrderIds(staleOrder)) {
                    try {
                        await geminiClient.cancelOrder(cancelId);
                        break;
                    } catch (cancelErr) {
                        logger.debug(`Manual live pre-clean cancel failed (${cancelId}): ${cancelErr.message}`);
                    }
                }
            }

            postPreCleanOrders = await geminiClient.getOpenOrders();
        } catch (cleanupErr) {
            logger.debug(`Manual live pre-clean lookup failed: ${cleanupErr.message}`);
        }

        // Keep manual live entries behind the same safety gate used by autonomous mode.
        const gate = await tradingEngine.evaluatePreTradeSafetyGate(true);
        if (!gate.allowed) {
            const canBypassOpenOrderOnlyGate =
                allowOpenOrders &&
                gate.reason === 'reconcile_not_clean' &&
                Number(gate?.details?.orphaned || 0) === 0 &&
                Number(gate?.details?.phantom || 0) === 0 &&
                Number(gate?.details?.qtyMismatch || 0) === 0 &&
                Number(gate?.details?.openOrders || 0) > 0;

            if (!canBypassOpenOrderOnlyGate) {
                const reasonTag = gate.reason === 'reconcile_not_clean'
                    ? 'manual_live_pre_trade_gate_blocked_reconcile_not_clean'
                    : 'manual_live_pre_trade_gate_blocked';
                return rejectLive(409, `pre_trade_gate_blocked:${gate.reason}`, reasonTag, { gate });
            }

            const openOrders = postPreCleanOrders || await geminiClient.getOpenOrders();
            const nonSellOpenOrders = (openOrders || []).filter(order => String(order?.side || '').toLowerCase() !== 'sell');
            if (nonSellOpenOrders.length > 0) {
                return rejectLive(409, 'gate_bypass_incoherent:open_orders_include_non_sell', 'manual_live_gate_bypass_incoherent', {
                    gate,
                    residual_non_sell_open_orders: nonSellOpenOrders.length
                });
            }

            logLifecycle('MANUAL_LIVE_ENTRY', correlationId, 'gate_bypass_allow_open_orders', {
                gateReason: gate.reason,
                residualOpenOrders: (openOrders || []).length
            });
        }

        const market = await geminiClient.getMarketState(market_id);
        if (!market || market.bid == null || market.ask == null) {
            return rejectLive(400, 'No two-sided book available for this market', 'manual_live_two_sided_book_missing');
        }

        const signalContext = getSignalContext(market_id);
        const marketCategory = signalContext?.category || market.category || 'other';
        const marketTitle = signalContext?.title || market.title || market_id;
        const opportunityScore = Number(signalContext?.score || 0);

        const ttxSeconds = parseGemiExpirySeconds(market_id);
        const minManualTtxSeconds = allowOpenOrders ? 300 : 1800;
        if (Number.isFinite(ttxSeconds) && ttxSeconds < minManualTtxSeconds) {
            return rejectLive(400, `manual_live_guard_ttx_too_short:${Math.round(ttxSeconds)}`, 'manual_live_guard_ttx_too_short');
        }

        const spread = Number(market.ask) - Number(market.bid);
        const maxAllowedSpread = sessionRelaxedGuard
            ? 0.20
            : (allowOpenOrders ? 0.10 : 0.06);
        if (!Number.isFinite(spread) || spread > maxAllowedSpread) {
            return rejectLive(400, `manual_live_guard_spread_too_wide:${Number.isFinite(spread) ? spread.toFixed(3) : 'nan'}`, 'manual_live_guard_spread_too_wide');
        }

        const executableEntryPrice = dir === 'YES'
            ? Number(market.ask)
            : Number(1 - market.bid);
        if (!Number.isFinite(executableEntryPrice) || executableEntryPrice <= 0 || executableEntryPrice >= 1) {
            return rejectLive(400, 'Could not compute executable entry price', 'manual_live_executable_price_invalid');
        }

        const entryPrice = isPassiveBidRequest ? requestedLimitPrice : executableEntryPrice;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
            return rejectLive(400, 'limit_price must be between 0 and 1', 'manual_live_limit_price_invalid');
        }

        // Entry-quality guard: avoid repeatedly taking the same losing NO setup.
        const signalNetEdge = Number(signalContext?.netEdge ?? signalContext?.edge ?? 0);
        const noBandGuardEnabled = process.env.MANUAL_NO_BAND_GUARD_ENABLED !== 'false';
        const noBandMinPrice = Number(process.env.MANUAL_NO_BAND_MIN_PRICE ?? 0.55);
        const noBandMaxPrice = Number(process.env.MANUAL_NO_BAND_MAX_PRICE ?? 0.65);
        const noBandMinEdge = Number(process.env.MANUAL_NO_BAND_MIN_EDGE ?? 0.08);
        if (
            dir === 'NO' &&
            noBandGuardEnabled &&
            Number.isFinite(noBandMinPrice) &&
            Number.isFinite(noBandMaxPrice) &&
            entryPrice >= noBandMinPrice &&
            entryPrice <= noBandMaxPrice &&
            signalNetEdge < noBandMinEdge
        ) {
            return rejectLive(400, `manual_live_guard_no_band_low_edge:${entryPrice.toFixed(3)}_edge_${signalNetEdge.toFixed(3)}_lt_${noBandMinEdge.toFixed(3)}`, 'manual_live_guard_no_band_low_edge');
        }

        const repeatCooldownSeconds = Math.max(0, Number(process.env.MANUAL_REPEAT_COOLDOWN_SECONDS ?? 900));
        const recentLiveTrades = db.getRecentTrades(100, 'live') || [];
        const nowSeconds = Math.floor(Date.now() / 1000);
        const recentLosingRepeat = recentLiveTrades.find(t => {
            if (t.gemini_market_id !== market_id) return false;
            if (String(t.direction || '').toUpperCase() !== dir) return false;
            if (Number(t.pnl ?? 0) > 0) return false;
            const closedAt = Number(t.timestamp || 0) + Number(t.hold_time || 0);
            if (!Number.isFinite(closedAt) || closedAt <= 0) return false;
            return (nowSeconds - closedAt) <= repeatCooldownSeconds;
        });

        if (recentLosingRepeat) {
            const closedAt = Number(recentLosingRepeat.timestamp || 0) + Number(recentLosingRepeat.hold_time || 0);
            const ageSeconds = Math.max(0, nowSeconds - closedAt);
            return rejectLive(400, `manual_live_guard_repeat_cooldown:${ageSeconds}s_lt_${repeatCooldownSeconds}s`, 'manual_live_guard_repeat_cooldown');
        }

        const minEntryBand = sessionRelaxedGuard
            ? 0.02
            : (allowOpenOrders ? 0.05 : 0.25);
        const maxEntryBand = sessionRelaxedGuard
            ? 0.90
            : (allowOpenOrders ? 0.85 : 0.75);
        if (entryPrice < minEntryBand || entryPrice > maxEntryBand) {
            return rejectLive(400, `manual_live_guard_entry_band:${entryPrice.toFixed(3)}`, 'manual_live_guard_entry_band');
        }

        if (isPassiveBidRequest && entryPrice >= executableEntryPrice) {
            return rejectLive(400, `manual_live_guard_limit_not_passive:${entryPrice.toFixed(3)}>=${executableEntryPrice.toFixed(3)}`, 'manual_live_guard_limit_not_passive');
        }

        logLifecycle('MANUAL_LIVE_ENTRY', correlationId, 'submit_order', {
            marketId: market_id,
            direction: dir,
            entryPrice: Number(entryPrice.toFixed(3)),
            executableEntryPrice: Number(executableEntryPrice.toFixed(3)),
            spread: Number.isFinite(spread) ? Number(spread.toFixed(3)) : null,
            signalNetEdge: Number.isFinite(signalNetEdge) ? Number(signalNetEdge.toFixed(3)) : null
        });

        const order = await geminiClient.placeOrder({
            symbol: market_id,
            side: 'buy',
            amount: qty,
            price: entryPrice.toFixed(2),
            direction: dir
        });

        const filledContracts = Number(order?.filledQuantity || 0);
        if (!order?.success || filledContracts <= 0) {
            if (keepOpen || isPassiveBidRequest) {
                return okLive({
                    success: true,
                    resting_order: true,
                    mode: 'live',
                    market_id,
                    direction: dir,
                    contracts: qty,
                    limit_price: entryPrice,
                    executable_entry_price: executableEntryPrice,
                    order
                });
            }

            // Accepted but unfilled orders should be cancelled immediately so retries are deterministic.
            let cancelled = false;

            for (const cancelId of candidateOrderIds(order)) {
                try {
                    await geminiClient.cancelOrder(cancelId);
                    cancelled = true;
                    break;
                } catch (cancelErr) {
                    logger.debug(`Manual live entry direct cancel failed (${cancelId}): ${cancelErr.message}`);
                }
            }

            if (!cancelled) {
                try {
                    const openOrders = await geminiClient.getOpenOrders();
                    const matching = (openOrders || [])
                        .filter(o =>
                            o.symbol === market_id &&
                            String(o.side || '').toLowerCase() === 'buy' &&
                            String(o.outcome || '').toUpperCase() === dir
                        )
                        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

                    if (matching.length > 0) {
                        for (const cancelId of candidateOrderIds(matching[0])) {
                            try {
                                await geminiClient.cancelOrder(cancelId);
                                cancelled = true;
                                break;
                            } catch (cancelErr) {
                                logger.debug(`Manual live entry fallback cancel failed (${cancelId}): ${cancelErr.message}`);
                            }
                        }
                    }
                } catch (lookupErr) {
                    logger.debug(`Manual live entry open-order lookup failed: ${lookupErr.message}`);
                }
            }

            // Fast loops can race: order response says unfilled while exchange position appears moments later.
            // If a matching live position exists, recover it into DB instead of returning an error.
            try {
                const positions = await geminiClient.getPositions();
                const exchangePos = (positions || []).find(p =>
                    p.symbol === market_id &&
                    String(p.outcome || '').toUpperCase() === dir &&
                    Number(p.totalQuantity || 0) > 0
                );

                if (exchangePos) {
                    const existingOpenLive = (db.getOpenTrades('live') || []).find(t =>
                        t.gemini_market_id === market_id &&
                        String(t.direction || '').toUpperCase() === dir
                    );

                    if (existingOpenLive) {
                        return okLive({
                            success: true,
                            recovered_fill: true,
                            trade_id: existingOpenLive.id,
                            mode: 'live',
                            contracts: Math.max(1, Math.floor(Number(exchangePos.totalQuantity || 1))),
                            order
                        });
                    }

                    const recoveredContracts = Math.max(1, Math.floor(Number(exchangePos.totalQuantity || qty)));
                    const recoveredEntryPrice = Number(exchangePos.avgPrice || executableEntryPrice);
                    const recoveredPositionSize = parseFloat((recoveredContracts * recoveredEntryPrice).toFixed(6));

                    const recoveredTradeId = db.insertTrade({
                        timestamp: Math.floor(Date.now() / 1000),
                        gemini_market_id: market_id,
                        market_title: marketTitle,
                        category: marketCategory,
                        trade_state: 'ENTERED',
                        direction: dir,
                        entry_price: recoveredEntryPrice,
                        position_size: recoveredPositionSize,
                        opportunity_score: opportunityScore,
                        gemini_entry_bid: market.bid,
                        gemini_entry_ask: market.ask,
                        gemini_volume: market.volume || 0,
                        slippage: 0,
                        mode: 'live'
                    });

                    logger.warn(
                        `MANUAL LIVE RECOVERED FILL: ${dir} ${market_id} contracts=${recoveredContracts} ` +
                        `entry=${recoveredEntryPrice.toFixed(3)} tradeId=${recoveredTradeId}`
                    );

                    return res.json({
                        correlation_id: correlationId,
                        success: true,
                        recovered_fill: true,
                        trade_id: recoveredTradeId,
                        mode: 'live',
                        contracts: recoveredContracts,
                        order
                    });
                }
            } catch (recoverErr) {
                logger.debug(`Manual live entry recovery check failed: ${recoverErr.message}`);
            }

            return rejectLive(409, 'manual_live_entry_unfilled', 'manual_live_entry_unfilled', {
                orderId: order?.orderId || null,
                requestedContracts: qty,
                filledContracts
            });
        }

        const positionSize = parseFloat((filledContracts * order.fill_price).toFixed(6));
        const tradeId = db.insertTrade({
            timestamp: Math.floor(Date.now() / 1000),
            gemini_market_id: market_id,
            market_title: marketTitle,
            category: marketCategory,
            trade_state: 'ENTERED',
            direction: dir,
            entry_price: Number(order.fill_price),
            position_size: positionSize,
            opportunity_score: opportunityScore,
            gemini_entry_bid: market.bid,
            gemini_entry_ask: market.ask,
            gemini_volume: market.volume || 0,
            slippage: 0,
            mode: 'live'
        });

        logger.info(
            `MANUAL LIVE ENTRY: ${dir} ${market_id} contracts=${filledContracts} ` +
            `entry=${Number(order.fill_price).toFixed(3)} orderId=${order.orderId}`
        );

        logLifecycle('MANUAL_LIVE_ENTRY', correlationId, 'db_inserted', {
            tradeId,
            marketId: market_id,
            direction: dir,
            filledContracts,
            entryPrice: Number(order.fill_price)
        });

        okLive({
            success: true,
            trade_id: tradeId,
            mode: 'live',
            contracts: filledContracts,
            order
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/trade/live/reprice-exit', async (req, res) => {
    try {
        if (geminiMode !== 'live' && geminiMode !== 'sandbox') {
            return res.status(400).json({ success: false, error: 'Live exit repricing requires GEMINI_MODE=live|sandbox' });
        }

        const { market_id, direction, price, contracts } = req.body;
        const dir = String(direction || '').toUpperCase();
        const limitPrice = Number(price);

        if (!market_id || !String(market_id).startsWith('GEMI-')) {
            return res.status(400).json({ success: false, error: 'market_id must be a GEMI-* instrument' });
        }
        if (dir !== 'YES' && dir !== 'NO') {
            return res.status(400).json({ success: false, error: 'direction must be YES or NO' });
        }
        if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1) {
            return res.status(400).json({ success: false, error: 'price must be a number between 0 and 1' });
        }

        const candidateOrderIds = (o) => {
            const ids = [];
            if (o?.hashOrderId != null) ids.push(String(o.hashOrderId));
            if (o?.globalOrderId != null) ids.push(String(o.globalOrderId));
            if (o?.orderId != null) ids.push(String(o.orderId));
            if (o?.order_id != null) ids.push(String(o.order_id));
            if (o?.id != null) ids.push(String(o.id));
            return [...new Set(ids.filter(Boolean))];
        };

        const cancelledOrders = [];
        const openOrders = await geminiClient.getOpenOrders();
        const existingExitOrders = (openOrders || []).filter(o =>
            o.symbol === market_id &&
            String(o.side || '').toLowerCase() === 'sell' &&
            String(o.outcome || '').toUpperCase() === dir
        );

        for (const order of existingExitOrders) {
            let cancelled = false;
            for (const cancelId of candidateOrderIds(order)) {
                try {
                    await geminiClient.cancelOrder(cancelId);
                    cancelledOrders.push({ orderId: cancelId, price: order.price, quantity: order.quantity });
                    cancelled = true;
                    break;
                } catch (cancelErr) {
                    logger.debug(`Live exit reprice cancel failed (${cancelId}): ${cancelErr.message}`);
                }
            }

            if (!cancelled) {
                return res.status(409).json({
                    success: false,
                    error: `failed_to_cancel_existing_exit:${order.orderId || order.globalOrderId || order.hashOrderId || 'unknown'}`,
                    cancelledOrders
                });
            }
        }

        const positions = await geminiClient.getPositions();
        const exchangePos = (positions || []).find(p =>
            p.symbol === market_id &&
            String(p.outcome || '').toUpperCase() === dir &&
            Number(p.totalQuantity || 0) > 0
        );
        if (!exchangePos) {
            return res.status(404).json({ success: false, error: 'live_position_not_found', cancelledOrders });
        }

        const totalQty = Math.max(0, Math.floor(Number(exchangePos.totalQuantity || 0)));
        const heldQty = Math.max(0, Math.floor(Number(exchangePos.quantityOnHold || 0)));
        const requestedQty = Number.isFinite(Number(contracts)) ? Math.max(1, Math.floor(Number(contracts))) : null;
        const availableQty = Math.max(0, totalQty - heldQty);
        const qty = requestedQty || availableQty || totalQty;

        if (qty <= 0) {
            return res.status(409).json({
                success: false,
                error: 'no_available_quantity_to_reprice',
                cancelledOrders,
                totalQty,
                heldQty
            });
        }

        const exitOrder = await geminiClient.placeOrder({
            symbol: market_id,
            side: 'sell',
            amount: qty,
            price: limitPrice.toFixed(2),
            direction: dir
        });

        logger.info(
            `MANUAL LIVE EXIT REPRICE: ${dir} ${market_id} qty=${qty} ` +
            `limit=${limitPrice.toFixed(2)} orderId=${exitOrder?.orderId} status=${exitOrder?.orderStatus}`
        );

        res.json({
            success: true,
            market_id,
            direction: dir,
            quantity: qty,
            price: limitPrice,
            cancelledOrders,
            order: exitOrder
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start/stop bot
app.post('/api/bot/start', async (req, res) => {
    if (!botState.running) {
        try {
            if (isLiveOrSandboxMode()) {
                const token = req.body?.preflight_token || req.headers['x-preflight-token'];
                if (!hasValidLivePreflightToken(token)) {
                    return res.status(409).json({
                        status: 'blocked',
                        error: 'valid_live_preflight_required',
                        preflight: livePreflightState,
                        hint: 'Run POST /api/bot/preflight and pass returned token in preflight_token or x-preflight-token'
                    });
                }
            }

            await startBot();
            res.json({ status: 'started' });
        } catch (error) {
            res.status(409).json({ status: 'blocked', error: error.message });
        }
    } else {
        res.json({ status: 'already_running' });
    }
});

app.post('/api/bot/stop', (req, res) => {
    stopBot();
    res.json({ status: 'stopped' });
});

// Emergency stop: stops bot AND closes all positions
app.post('/api/bot/emergency-stop', async (req, res) => {
    try {
        stopBot();
        const result = await emergencyExitAll();

        // If cleanup left unresolved state, do a best-effort sweep: cancel open orders
        // then re-attempt reconcile.  This handles the quantityOnHold / GTC-unfilled case
        // so the harness doesn't need a separate manual reconcile/fix call.
        if (!result.is_flat && !result.skipped_duplicate) {
            try {
                const openOrders = await geminiClient.getOpenOrders().catch(() => []);
                for (const order of openOrders) {
                    const orderId =
                        order.hashOrderId ||
                        order.globalOrderId ||
                        order.orderId ||
                        order.order_id;
                    if (orderId) {
                        await geminiClient.cancelOrder(String(orderId)).catch(() => null);
                    }
                }
                if (openOrders.length > 0) {
                    logger.warn(
                        `EMERGENCY STOP: cancelled ${openOrders.length} outstanding order(s) ` +
                        `after non-flat cleanup`
                    );
                }
            } catch (sweepErr) {
                logger.error(`EMERGENCY STOP post-cancel sweep failed: ${sweepErr.message}`);
            }
        }

        // Broadcast to dashboard WS clients
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: 'emergency_stop',
                    data: result
                }));
            }
        });

        res.json({ status: 'emergency_stopped', ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Close a single position manually
app.post('/api/bot/close-position/:tradeId', async (req, res) => {
    try {
        const correlationId = String(req.headers['x-correlation-id'] || req.body?.correlation_id || createCorrelationId('mclose'));
        const rejectClose = (statusCode, error, reasonTag, extra = {}) => {
            logLifecycle('MANUAL_LIVE_CLOSE', correlationId, 'reject', { error, reasonTag, tradeId: req.params.tradeId, ...extra });
            return res.status(statusCode).json({ error, reason_tag: reasonTag, correlation_id: correlationId, ...extra });
        };
        const candidateOrderIds = (o) => {
            const ids = [];
            if (o?.hashOrderId != null) ids.push(String(o.hashOrderId));
            if (o?.globalOrderId != null) ids.push(String(o.globalOrderId));
            if (o?.orderId != null) ids.push(String(o.orderId));
            if (o?.order_id != null) ids.push(String(o.order_id));
            if (o?.id != null) ids.push(String(o.id));
            return [...new Set(ids.filter(Boolean))];
        };
        const tradeId = parseInt(req.params.tradeId);
        let openTrades = db.getOpenTrades();
        let trade = openTrades.find(t => t.id === tradeId);

        const findExchangePosition = async (marketId, direction) => {
            const positions = await geminiClient.getPositions();
            const desiredOutcome = String(direction || '').toLowerCase();
            const matching = (positions || []).find(p =>
                p.symbol === marketId && String(p.outcome || '').toLowerCase() === desiredOutcome
            );
            return matching || (positions || []).find(p => p.symbol === marketId) || null;
        };

        const recoverTradeFromExchangePosition = (seedTrade, exchangePos) => {
            const recoveredContracts = Math.max(1, Math.floor(Number(exchangePos?.totalQuantity || 1)));
            const recoveredEntryPrice = Number(exchangePos?.avgPrice || seedTrade?.entry_price || 0);
            if (!Number.isFinite(recoveredEntryPrice) || recoveredEntryPrice <= 0) {
                return null;
            }

            const recoveredPositionSize = parseFloat((recoveredContracts * recoveredEntryPrice).toFixed(6));
            const recoveredTradeId = db.insertTrade({
                timestamp: Math.floor(Date.now() / 1000),
                gemini_market_id: seedTrade.gemini_market_id,
                market_title: seedTrade.market_title || `${exchangePos?.contractMetadata?.eventName || seedTrade.gemini_market_id}: ${exchangePos?.contractMetadata?.contractName || seedTrade.gemini_market_id}`,
                category: seedTrade.category || exchangePos?.contractMetadata?.category || 'other',
                trade_state: 'ENTERED',
                direction: seedTrade.direction,
                entry_price: recoveredEntryPrice,
                position_size: recoveredPositionSize,
                opportunity_score: seedTrade.opportunity_score || 0,
                gemini_entry_bid: exchangePos?.prices?.bestBid ? Number(exchangePos.prices.bestBid) : (seedTrade.gemini_entry_bid || null),
                gemini_entry_ask: exchangePos?.prices?.bestAsk ? Number(exchangePos.prices.bestAsk) : (seedTrade.gemini_entry_ask || null),
                gemini_volume: seedTrade.gemini_volume || 0,
                slippage: 0,
                mode: 'live'
            });

            logLifecycle('MANUAL_LIVE_CLOSE', correlationId, 'recovered_missing_db_trade', {
                tradeId: recoveredTradeId,
                sourceTradeId: seedTrade.id,
                marketId: seedTrade.gemini_market_id,
                direction: seedTrade.direction,
                recoveredContracts,
                recoveredEntryPrice
            });

            return recoveredTradeId;
        };

        logLifecycle('MANUAL_LIVE_CLOSE', correlationId, 'received', {
            tradeId,
            tradeFound: !!trade
        });

        if (!trade) {
            const recentTrades = db.getRecentTrades(2000) || [];
            const existingTrade = recentTrades.find(t => t.id === tradeId);

            if (existingTrade && existingTrade.mode === 'live') {
                const exchangePos = await findExchangePosition(existingTrade.gemini_market_id, existingTrade.direction);
                if (exchangePos && Number(exchangePos.totalQuantity || 0) > 0) {
                    const recoveredTradeId = recoverTradeFromExchangePosition(existingTrade, exchangePos);
                    if (recoveredTradeId) {
                        openTrades = db.getOpenTrades();
                        trade = openTrades.find(t => t.id === recoveredTradeId);
                    }
                }
            }

            if (trade) {
                logLifecycle('MANUAL_LIVE_CLOSE', correlationId, 'recovered_trade_for_close', {
                    tradeId: trade.id,
                    originalRequestedTradeId: tradeId,
                    marketId: trade.gemini_market_id,
                    direction: trade.direction
                });
            }

            if (!trade && existingTrade && Number(existingTrade.is_open) === 0) {
                return res.json({
                    success: true,
                    correlation_id: correlationId,
                    reason_tag: 'manual_close_already_reconciled',
                    tradeId,
                    market: existingTrade.market_title,
                    direction: existingTrade.direction,
                    exitPrice: Number(existingTrade.exit_price || existingTrade.entry_price || 0),
                    pnl: Number(existingTrade.pnl || 0),
                    holdTime: Number(existingTrade.hold_time || 0),
                    live: existingTrade.mode === 'live',
                    reconciled: true
                });
            }

            if (!trade) {
                return rejectClose(404, 'Trade not found or already closed', 'manual_close_trade_not_found');
            }
        }

        const isLive = trade.mode === 'live';
        let exitPrice;

        if (isLive) {
            try {
                // Use exchange-reported contracts (minus held quantity), never DB-derived quantity.
                const positions = await geminiClient.getPositions();
                const desiredOutcome = String(trade.direction || '').toLowerCase();

                let exchangePos = (positions || []).find(p =>
                    p.symbol === trade.gemini_market_id && String(p.outcome || '').toLowerCase() === desiredOutcome
                );
                if (!exchangePos) {
                    exchangePos = (positions || []).find(p => p.symbol === trade.gemini_market_id);
                }

                if (!exchangePos) {
                    const now = Math.floor(Date.now() / 1000);
                    db.closeTrade(tradeId, trade.entry_price, 0, now - trade.timestamp, 'manual_reconcile_no_exchange');
                    return res.json({
                        success: true,
                        correlation_id: correlationId,
                        reason_tag: 'manual_close_reconciled_no_exchange',
                        tradeId,
                        market: trade.market_title,
                        direction: trade.direction,
                        exitPrice: trade.entry_price,
                        pnl: 0,
                        holdTime: now - trade.timestamp,
                        live: true,
                        reconciled: true
                    });
                }

                const closeRetryMaxAttempts = 3;
                const closeRetryBackoffMs = 500;
                let totalQty = Number(exchangePos.totalQuantity || 0);
                let heldQty = Number(exchangePos.quantityOnHold || 0);
                let contracts = Math.max(0, Math.floor(totalQty - heldQty));

                if (contracts <= 0) {
                    for (let attempt = 1; attempt <= closeRetryMaxAttempts; attempt++) {
                        try {
                            const openOrders = await geminiClient.getOpenOrders();
                            const exitOrders = (openOrders || []).filter(order =>
                                order.symbol === trade.gemini_market_id &&
                                String(order.side || '').toLowerCase() === 'sell' &&
                                String(order.outcome || '').toLowerCase() === desiredOutcome
                            );

                            for (const exitOrder of exitOrders) {
                                for (const cancelId of candidateOrderIds(exitOrder)) {
                                    try {
                                        await geminiClient.cancelOrder(cancelId);
                                        break;
                                    } catch (cancelErr) {
                                        logger.debug(`Manual close retry cancel failed (${cancelId}): ${cancelErr.message}`);
                                    }
                                }
                            }
                        } catch (orderErr) {
                            logger.debug(`Manual close retry open-order fetch failed: ${orderErr.message}`);
                        }

                        await new Promise(resolve => setTimeout(resolve, closeRetryBackoffMs * attempt));

                        const refreshedPositions = await geminiClient.getPositions();
                        exchangePos = (refreshedPositions || []).find(p =>
                            p.symbol === trade.gemini_market_id && String(p.outcome || '').toLowerCase() === desiredOutcome
                        ) || (refreshedPositions || []).find(p => p.symbol === trade.gemini_market_id);

                        if (!exchangePos) break;

                        totalQty = Number(exchangePos.totalQuantity || 0);
                        heldQty = Number(exchangePos.quantityOnHold || 0);
                        contracts = Math.max(0, Math.floor(totalQty - heldQty));

                        if (contracts > 0) break;
                    }
                }

                if (!exchangePos) {
                    const now = Math.floor(Date.now() / 1000);
                    db.closeTrade(tradeId, trade.entry_price, 0, now - trade.timestamp, 'manual_reconcile_no_exchange_after_retry');
                    return res.json({
                        success: true,
                        correlation_id: correlationId,
                        reason_tag: 'manual_close_reconciled_no_exchange',
                        tradeId,
                        market: trade.market_title,
                        direction: trade.direction,
                        exitPrice: trade.entry_price,
                        pnl: 0,
                        holdTime: now - trade.timestamp,
                        live: true,
                        reconciled: true
                    });
                }

                if (contracts <= 0) {
                    return rejectClose(409, 'No available contracts to close (position quantity remains on hold after retry).', 'manual_close_quantity_still_held_after_retry', {
                        quantity_on_hold: heldQty,
                        total_quantity: totalQty,
                        retry_attempts: closeRetryMaxAttempts
                    });
                }

                // For live exits, use outcome-specific executable price from exchange position payload.
                const priceFromBook = trade.direction === 'YES'
                    ? Number(exchangePos?.prices?.sell?.yes)
                    : Number(exchangePos?.prices?.sell?.no);
                if (!Number.isFinite(priceFromBook) || priceFromBook <= 0) {
                    return rejectClose(400, 'Could not determine executable exit price for live trade', 'manual_close_exit_price_unavailable');
                }
                exitPrice = Math.max(0.01, Math.min(0.99, priceFromBook));

                const exitOrder = await geminiClient.placeOrder({
                    symbol: trade.gemini_market_id,
                    side: 'sell',
                    amount: contracts,
                    price: exitPrice.toFixed(2),
                    direction: trade.direction
                });

                const filled = Number(exitOrder?.filledQuantity || 0);
                if (!exitOrder || !exitOrder.success || filled <= 0) {
                    try {
                        for (const cancelId of candidateOrderIds(exitOrder)) {
                            try {
                                await geminiClient.cancelOrder(cancelId);
                                break;
                            } catch (cancelErr) {
                                logger.debug(`Manual close cancel failed (${cancelId}): ${cancelErr.message}`);
                            }
                        }
                    } catch (cancelErr) {
                        logger.debug(`Manual close cancel failed: ${cancelErr.message}`);
                    }
                    return rejectClose(409, `Live exit order not filled (status=${exitOrder?.orderStatus || 'unknown'}, filled=${filled}). Position NOT closed.`, 'manual_close_unfilled', {
                        order_status: exitOrder?.orderStatus || 'unknown',
                        filled_quantity: filled
                    });
                }

                if (exitOrder.fill_price) {
                    exitPrice = exitOrder.fill_price;
                }

                logger.info(
                    `MANUAL LIVE SELL: ${trade.gemini_market_id} ` +
                    `orderId=${exitOrder?.orderId} status=${exitOrder?.orderStatus} filled=${exitOrder?.filledQuantity}`
                );
            } catch (sellErr) {
                return rejectClose(500, `Live sell order failed: ${sellErr.message}. Position NOT closed. Check Gemini directly.`, 'manual_close_sell_failed');
            }
        } else {
            exitPrice = geminiClient.getPaperExitPrice(trade.gemini_market_id, trade.direction);
            if (exitPrice === null) {
                return rejectClose(400, 'Could not determine exit price', 'manual_close_paper_exit_price_unavailable');
            }
        }

        const now = Math.floor(Date.now() / 1000);
        const feeSide = tradingEngine.params?.fee_per_side || 0.0001;
        const entryFee = trade.position_size * feeSide;
        const exitValue = trade.direction === 'YES'
            ? (exitPrice - trade.entry_price) * trade.position_size / trade.entry_price
            : (exitPrice - trade.entry_price) * trade.position_size / trade.entry_price;
        const exitFee = Math.abs(exitValue + trade.position_size) * feeSide;
        const pnl = exitValue - entryFee - exitFee;

        db.closeTrade(tradeId, exitPrice, pnl, now - trade.timestamp, 'manual_close');

        // Update wallet only for paper trades. Live balance comes from Gemini.
        if (!isLive) {
            const wallet = db.getWallet();
            if (wallet) {
                db.updateWallet(wallet.balance + pnl);
            }
        }

        logger.info(`MANUAL CLOSE: ${trade.direction} "${trade.market_title}" @ ${exitPrice.toFixed(3)} P&L: $${pnl.toFixed(2)}`);
        logLifecycle('MANUAL_LIVE_CLOSE', correlationId, 'closed', {
            tradeId,
            marketId: trade.gemini_market_id,
            direction: trade.direction,
            exitPrice,
            pnl,
            holdTime: now - trade.timestamp
        });
        res.json({
            success: true,
            correlation_id: correlationId,
            reason_tag: 'manual_close_success',
            tradeId,
            market: trade.market_title,
            direction: trade.direction,
            exitPrice,
            pnl,
            holdTime: now - trade.timestamp,
            live: isLive
        });
    } catch (error) {
        res.status(500).json({ error: error.message, reason_tag: 'manual_close_internal_error' });
    }
});

// Bot status
app.get('/api/bot/status', async (req, res) => {
    // Calculate Sharpe ratio from trade history
    let sharpe = null;
    try {
        const recentTrades = db.getRecentTrades(200);
        if (recentTrades && recentTrades.length >= 5) {
            const pnls = recentTrades.map(t => t.pnl || 0);
            const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
            const variance = pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / pnls.length;
            const stddev = Math.sqrt(variance);
            if (stddev > 0) {
                // Annualize: assume ~50 trades/day based on 2s cycles
                const tradesPerDay = Math.min(pnls.length, 50);
                sharpe = (mean / stddev) * Math.sqrt(tradesPerDay * 252);
            }
        }
    } catch (e) { /* sharpe stays null */ }

    // Realistic PnL stats (paper-vs-live fill gap)
    let realisticStats = null;
    try {
        realisticStats = db.getRealisticTradeStats(50);
    } catch (e) { /* stays null */ }

    // Signal frequency stats (last 24h)
    let signalStats = null;
    try {
        signalStats = db.getSignalFrequencyStats(1);
    } catch (e) { /* stays null */ }

    // Paper vs Live split stats
    let paperLiveSplit = null;
    try {
        const paperPnl = db.getDailyPnL('paper');
        const livePnl = db.getDailyPnL('live');
        const paperOpen = db.getOpenTrades('paper');
        const liveOpen = db.getOpenTrades('live');
        const paperRecent = db.getRecentTrades(50, 'paper');
        const liveRecent = db.getRecentTrades(50, 'live');
        const liveWins = liveRecent ? liveRecent.filter(t => t.pnl > 0).length : 0;
        const liveLosses = liveRecent ? liveRecent.filter(t => t.pnl < 0).length : 0;
        paperLiveSplit = {
            paper: {
                open_positions: paperOpen ? paperOpen.length : 0,
                today: paperPnl || { daily_pnl: 0, trade_count: 0 },
                recent_count: paperRecent ? paperRecent.length : 0
            },
            live: {
                open_positions: liveOpen ? liveOpen.length : 0,
                today: livePnl || { daily_pnl: 0, trade_count: 0 },
                recent_count: liveRecent ? liveRecent.length : 0,
                recent_wins: liveWins,
                recent_losses: liveLosses,
                win_rate: (liveWins + liveLosses) > 0
                    ? (liveWins / (liveWins + liveLosses) * 100).toFixed(1) + '%'
                    : 'N/A'
            }
        };
    } catch (e) { /* stays null */ }

    const engineStatus = tradingEngine.getStatus();
    const preTradeGate = engineStatus.pre_trade_gate || null;
    const preTradeGateSummary = preTradeGate
        ? {
            allowed: !!preTradeGate.allowed,
            reason: preTradeGate.reason || null,
            ts: preTradeGate.ts || null,
            unresolved: preTradeGate.details?.unresolved || null
        }
        : null;

    res.json({
        running: botState.running,
        stop_reason: botState.stopReason || null,
        mode: geminiClient.mode,
        uptime: botState.startTime ? Date.now() - botState.startTime : 0,
        cycle_count: botState.cycleCount,
        last_cycle_time: botState.lastCycleTime,
        last_match_time: botState.lastMatchTime,
        warmup_remaining: warmupCyclesRemaining,
        sharpe,
        realistic_stats: realisticStats,
        signal_frequency: signalStats,
        paper_live_split: paperLiveSplit,
        live_preflight: {
            valid: livePreflightState.valid,
            reason: livePreflightState.reason,
            checked_at: livePreflightState.checked_at,
            expires_at: livePreflightState.expires_at
        },
        circuit_breaker: {
            open: health.circuitOpen,
            consecutive_errors: health.consecutiveErrors,
            total_errors: health.totalErrors
        },
        pre_trade_gate_allowed: preTradeGateSummary ? preTradeGateSummary.allowed : null,
        pre_trade_gate_reason: preTradeGateSummary ? preTradeGateSummary.reason : null,
        pre_trade_gate_summary: preTradeGateSummary,
        ...engineStatus,
        wallet: await getDisplayWallet(),
        cleanup: {
            status: botState.cleanupStatus,
            ts: botState.cleanupTs,
            result_summary: botState.cleanupResult ? {
                closed: botState.cleanupResult.closed,
                unresolved: botState.cleanupResult.unresolved,
                is_flat: botState.cleanupResult.is_flat
            } : null
        },
        rate_limiter: rateLimiter.getStats(),
        signal_detector: signalDetector.getStats(),
        runtime_cadence: {
            price_update_interval_ms: PRICE_UPDATE_INTERVAL_MS,
            match_interval_ms: MATCH_INTERVAL_MS,
            ref_bulk_refresh_interval_ms: REF_BULK_REFRESH_INTERVAL_MS,
            gemini_real_fetch_interval_ms: GEMINI_REAL_FETCH_INTERVAL_MS,
            gemini_ticker_fetch_interval_ms: GEMINI_TICKER_FETCH_INTERVAL_MS,
            cleanup_interval_ms: CLEANUP_INTERVAL_MS
        },
        gemini: geminiClient.getStats(),
        polymarket: polyClient.getStats(),
        kalshi: kalshiClient.getStats(),
        kalshi_ws: kalshiWS.getStats(),
        odds_api: oddsClient.getStats(),
        metaculus: metaculusClient.getStats()
    });
});

// Force market match cycle
app.post('/api/markets/rematch', async (req, res) => {
    try {
        const result = await matcher.runMatchCycle(polyClient, kalshiClient, geminiClient);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rate limiter stats
app.get('/api/rate-limits', (req, res) => {
    res.json(rateLimiter.getStats());
});

// Position reconciliation: compare DB vs Gemini exchange
app.get('/api/reconcile', async (req, res) => {
    try {
        const result = await tradingEngine.reconcilePositions();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Ground-truth snapshot (Phase 1): returns a single consistent view of
 *   exchange positions, open orders, DB open trades, and wallet balance.
 * Use this as the baseline before any reconciliation work.
 * Bot MUST be stopped before calling this to avoid concurrent mutations.
 */
app.get('/api/bot/ground-truth', async (req, res) => {
    try {
        const ts = new Date().toISOString();
        const isLive = geminiMode === 'live' || geminiMode === 'sandbox';

        const dbOpenTrades = db.getOpenTrades();
        const dbLiveOpen = db.getOpenTrades('live');
        const dbPaperOpen = db.getOpenTrades('paper');
        const wallet = await getDisplayWallet();

        let exchangePositions = [];
        let exchangeOpenOrders = [];
        let exchangeError = null;

        if (isLive) {
            try {
                [exchangePositions, exchangeOpenOrders] = await Promise.all([
                    geminiClient.getPositions(),
                    geminiClient.getOpenOrders()
                ]);
            } catch (e) {
                exchangeError = e.message;
                logger.warn('Ground-truth: exchange fetch error: ' + e.message);
            }
        }

        // Summary flags for fast inspection
        const isFlat =
            exchangePositions.length === 0 &&
            exchangeOpenOrders.length === 0 &&
            dbLiveOpen.length === 0;

        res.json({
            snapshot_at: ts,
            mode: geminiMode,
            bot_running: botState.running,
            is_flat: isFlat,
            exchange: {
                positions: exchangePositions,
                open_orders: exchangeOpenOrders,
                error: exchangeError
            },
            db: {
                open_total: dbOpenTrades.length,
                open_live: dbLiveOpen.length,
                open_paper: dbPaperOpen.length,
                live_trades: dbLiveOpen,
                paper_trades: dbPaperOpen
            },
            wallet
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Reconcile/fix endpoint (Phase 2): deterministic cleanup of orphaned and phantom positions.
 * Processes in this order:
 *   1. Cancel all open exchange orders (cleanup stale limit orders)
 *   2. For each orphaned exchange position: place sell order at best bid
 *   3. For each phantom DB trade: close in DB (entry_price, pnl=0)
 * Returns a full audit trail of every action taken.
 * Safe to call when bot is stopped. Bot must remain stopped during fix.
 */
app.post('/api/reconcile/fix', async (req, res) => {
    const isLive = geminiMode === 'live' || geminiMode === 'sandbox';
    const recoverOrphans = Boolean(req.body?.recover_orphans);
    if (!isLive) {
        return res.json({ skipped: true, reason: 'paper_mode_no_exchange' });
    }
    if (botState.running) {
        return res.status(409).json({ error: 'Stop the bot before running reconcile/fix' });
    }

    const actions = [];
    const errors = [];
    const now = Math.floor(Date.now() / 1000);

    const candidateOrderIds = (order) => {
        const ids = [];
        if (order?.hashOrderId != null) ids.push(String(order.hashOrderId));
        if (order?.globalOrderId != null) ids.push(String(order.globalOrderId));
        if (order?.orderId != null) ids.push(String(order.orderId));
        if (order?.order_id != null) ids.push(String(order.order_id));
        return [...new Set(ids.filter(Boolean))];
    };

    try {
        // Step 1: cancel all open exchange orders
        let activeOrders = [];
        try {
            activeOrders = await geminiClient.getOpenOrders();
        } catch (e) {
            errors.push({ step: 'fetch_open_orders', error: e.message });
        }
        for (const order of activeOrders) {
            const cancelIds = candidateOrderIds(order);
            let cancelled = false;
            let lastError = null;

            for (const orderId of cancelIds) {
                try {
                    await geminiClient.cancelOrder(orderId);
                    actions.push({ step: 'cancel_order', orderId, symbol: order.symbol, status: 'ok' });
                    logger.info(`RECONCILE FIX: cancelled open order ${orderId} (${order.symbol})`);
                    cancelled = true;
                    break;
                } catch (e) {
                    lastError = e;
                }
            }

            if (!cancelled) {
                errors.push({
                    step: 'cancel_order',
                    orderIds: cancelIds,
                    symbol: order.symbol,
                    error: lastError ? lastError.message : 'no_order_id_candidates'
                });
            }
        }

        // Step 2: get current state post-cancel
        const reconcile = await tradingEngine.reconcilePositions();
        let exchangePositionsForPricing = [];
        try {
            exchangePositionsForPricing = await geminiClient.getPositions();
        } catch (e) {
            errors.push({ step: 'fetch_positions_for_pricing', error: e.message });
        }

        // Step 3: close orphaned exchange positions (exchange-only)
        for (const orphan of reconcile.orphaned) {
            try {
                const outcome = String(orphan.outcome || 'yes').toLowerCase();
                const position = (exchangePositionsForPricing || []).find(p =>
                    p.symbol === orphan.symbol && String(p.outcome || '').toLowerCase() === outcome
                );

                if (recoverOrphans && position) {
                    const orphanQty = Math.max(0, Math.floor(Number(orphan.quantity || 0)));
                    const recoveredEntryPrice = Number(position.avgPrice || 0);
                    if (orphanQty > 0 && Number.isFinite(recoveredEntryPrice) && recoveredEntryPrice > 0) {
                        const recoveredPositionSize = parseFloat((orphanQty * recoveredEntryPrice).toFixed(6));
                        const recoveredTitle = `${position.contractMetadata?.eventName || orphan.symbol}: ${position.contractMetadata?.contractName || orphan.symbol}`;
                        const recoveredCategory = position.contractMetadata?.category || 'other';

                        const recoveredTradeId = db.insertTrade({
                            timestamp: now,
                            gemini_market_id: orphan.symbol,
                            market_title: recoveredTitle,
                            category: recoveredCategory,
                            trade_state: 'ENTERED',
                            direction: String(outcome || '').toUpperCase(),
                            entry_price: recoveredEntryPrice,
                            position_size: recoveredPositionSize,
                            opportunity_score: 0,
                            gemini_entry_bid: position.prices?.bestBid ? Number(position.prices.bestBid) : null,
                            gemini_entry_ask: position.prices?.bestAsk ? Number(position.prices.bestAsk) : null,
                            gemini_volume: 0,
                            slippage: 0,
                            mode: 'live'
                        });

                        actions.push({
                            step: 'recover_orphan_db',
                            tradeId: recoveredTradeId,
                            symbol: orphan.symbol,
                            qty: orphanQty,
                            entryPrice: recoveredEntryPrice,
                            recoveredPositionSize,
                            reason: orphan.reason
                        });
                        logger.warn(
                            `RECONCILE FIX: recovered orphan into DB ${orphan.symbol} qty=${orphanQty} ` +
                            `entry=${recoveredEntryPrice.toFixed(3)} tradeId=${recoveredTradeId}`
                        );
                        continue;
                    }
                }

                let exitPrice = null;
                if (outcome === 'no' && position?.prices?.sell?.no != null) {
                    exitPrice = Number(position.prices.sell.no);
                } else if (outcome === 'yes' && position?.prices?.sell?.yes != null) {
                    exitPrice = Number(position.prices.sell.yes);
                }

                if (!Number.isFinite(exitPrice)) {
                    const market = await geminiClient.getMarketState(orphan.symbol);
                    if (outcome === 'yes') {
                        exitPrice = Number(market?.bid);
                    } else {
                        exitPrice = Number.isFinite(Number(market?.ask)) ? (1 - Number(market.ask)) : null;
                    }
                }

                if (!Number.isFinite(exitPrice)) {
                    exitPrice = 0.50; // final fallback
                }
                exitPrice = Math.max(0.01, Math.min(0.99, exitPrice));

                const availableQty = Math.floor((orphan.quantity || 0) - (orphan.quantityOnHold || 0));
                if (availableQty <= 0) {
                    actions.push({
                        step: 'skip_orphan',
                        symbol: orphan.symbol,
                        reason: 'qty_on_hold',
                        quantity: orphan.quantity,
                        quantityOnHold: orphan.quantityOnHold
                    });
                    continue;
                }
                const qty = availableQty;
                const exitOrder = await geminiClient.placeOrder({
                    symbol: orphan.symbol,
                    side: 'sell',
                    amount: qty,
                    price: exitPrice.toFixed(2),
                    direction: outcome.toUpperCase()
                });

                const filled = Number(exitOrder?.filledQuantity || 0);
                let status = 'unfilled';
                if (exitOrder?.success && filled > 0) {
                    status = 'filled';
                } else if (exitOrder?.success) {
                    // Accepted but unfilled: cancel immediately so subsequent
                    // reconcile/fix attempts are deterministic.
                    try {
                        if (exitOrder?.orderId) {
                            await geminiClient.cancelOrder(exitOrder.orderId);
                        }
                    } catch (cancelErr) {
                        errors.push({
                            step: 'close_orphan_cancel',
                            symbol: orphan.symbol,
                            orderId: exitOrder?.orderId,
                            error: cancelErr.message
                        });
                    }
                }

                actions.push({
                    step: 'close_orphan',
                    symbol: orphan.symbol,
                    qty,
                    exitPrice,
                    orderId: exitOrder?.orderId,
                    filled,
                    status,
                    reason: orphan.reason
                });
                logger.warn(
                    `RECONCILE FIX: closed orphan ${orphan.symbol} qty=${qty} @ ${exitPrice.toFixed(2)} ` +
                    `orderId=${exitOrder?.orderId} filled=${filled} status=${status}`
                );
            } catch (e) {
                errors.push({ step: 'close_orphan', symbol: orphan.symbol, error: e.message });
            }
        }

        // Step 4: close phantom DB trades (DB-only, not pending exit)
        for (const phantom of reconcile.phantom) {
            if (phantom.pendingExit) {
                actions.push({ step: 'skip_phantom', tradeId: phantom.tradeId, reason: 'exit_in_flight' });
                continue;
            }
            if (phantom.transientGrace) {
                actions.push({ step: 'skip_phantom', tradeId: phantom.tradeId, reason: 'recent_entry_grace' });
                continue;
            }
            try {
                const holdTime = now - (phantom.age ? now - phantom.age : now);
                db.closeTrade(phantom.tradeId, phantom.entryPrice, 0, phantom.age, 'reconcile_no_exchange');
                actions.push({
                    step: 'close_phantom_db',
                    tradeId: phantom.tradeId,
                    symbol: phantom.symbol,
                    pnl: 0,
                    reason: phantom.reason
                });
                logger.warn(
                    `RECONCILE FIX: closed phantom DB trade ${phantom.tradeId} ${phantom.symbol} ` +
                    `(${phantom.reason})`
                );
            } catch (e) {
                errors.push({ step: 'close_phantom_db', tradeId: phantom.tradeId, error: e.message });
            }
        }

        // Step 4b: recover DB rows for exchange positions that exceed tracked DB quantity.
        const liveOpenTrades = db.getOpenTrades('live') || [];
        for (const mismatch of reconcile.quantityMismatch || []) {
            if (mismatch.reason !== 'exchange_exceeds_db') continue;

            try {
                const sampleTrade = liveOpenTrades.find(t => t.id === mismatch.tradeId)
                    || liveOpenTrades.find(t =>
                        t.gemini_market_id === mismatch.symbol &&
                        String(t.direction || '').toUpperCase() === String(mismatch.dbDirection || '').toUpperCase()
                    );

                const outcome = String(mismatch.dbDirection || '').toLowerCase();
                const exchangePos = (exchangePositionsForPricing || []).find(p =>
                    p.symbol === mismatch.symbol &&
                    String(p.outcome || '').toLowerCase() === outcome
                );

                const missingQty = Math.max(0, Math.floor(Number(mismatch.exchangeAvailable || 0) - Number(mismatch.dbContracts || 0)));
                if (!sampleTrade || !exchangePos || missingQty <= 0) {
                    actions.push({
                        step: 'skip_qty_mismatch_recovery',
                        symbol: mismatch.symbol,
                        tradeId: mismatch.tradeId,
                        reason: !sampleTrade ? 'no_sample_trade' : !exchangePos ? 'no_exchange_position' : 'no_missing_qty'
                    });
                    continue;
                }

                const recoveredEntryPrice = Number(exchangePos.avgPrice || sampleTrade.entry_price);
                if (!Number.isFinite(recoveredEntryPrice) || recoveredEntryPrice <= 0) {
                    errors.push({
                        step: 'recover_qty_mismatch_db',
                        symbol: mismatch.symbol,
                        tradeId: mismatch.tradeId,
                        error: 'invalid_recovered_entry_price'
                    });
                    continue;
                }

                const recoveredPositionSize = parseFloat((missingQty * recoveredEntryPrice).toFixed(6));
                const recoveredTitle = sampleTrade.market_title
                    || `${exchangePos.contractMetadata?.eventName || mismatch.symbol}: ${exchangePos.contractMetadata?.contractName || mismatch.symbol}`;
                const recoveredCategory = sampleTrade.category || exchangePos.contractMetadata?.category || 'other';

                const recoveredTradeId = db.insertTrade({
                    timestamp: now,
                    gemini_market_id: mismatch.symbol,
                    market_title: recoveredTitle,
                    category: recoveredCategory,
                    trade_state: 'ENTERED',
                    direction: String(mismatch.dbDirection || '').toUpperCase(),
                    entry_price: recoveredEntryPrice,
                    position_size: recoveredPositionSize,
                    opportunity_score: sampleTrade.opportunity_score || 0,
                    gemini_entry_bid: sampleTrade.gemini_entry_bid,
                    gemini_entry_ask: sampleTrade.gemini_entry_ask,
                    gemini_volume: sampleTrade.gemini_volume || 0,
                    slippage: 0,
                    mode: 'live'
                });

                actions.push({
                    step: 'recover_qty_mismatch_db',
                    tradeId: recoveredTradeId,
                    symbol: mismatch.symbol,
                    qty: missingQty,
                    entryPrice: recoveredEntryPrice,
                    recoveredPositionSize,
                    sourceTradeId: mismatch.tradeId
                });
                logger.warn(
                    `RECONCILE FIX: recovered ${missingQty} contract(s) into DB for ${mismatch.symbol} ` +
                    `from exchange position tradeId=${recoveredTradeId}`
                );
            } catch (e) {
                errors.push({
                    step: 'recover_qty_mismatch_db',
                    symbol: mismatch.symbol,
                    tradeId: mismatch.tradeId,
                    error: e.message
                });
            }
        }

        // Step 5: final state check
        const finalReconcile = await tradingEngine.reconcilePositions();
        const nonPendingPreFixPhantom = (reconcile.phantom || []).filter(p => !p.pendingExit && !p.transientGrace);
        const nonPendingPostFixPhantom = (finalReconcile.phantom || []).filter(p => !p.pendingExit && !p.transientGrace);
        const finalFlat =
            finalReconcile.orphaned.length === 0 &&
            nonPendingPostFixPhantom.length === 0 &&
            finalReconcile.quantityMismatch.length === 0;

        res.json({
            actions,
            errors,
            is_flat: finalFlat,
            pre_fix: {
                orphaned: reconcile.orphaned.length,
                phantom: nonPendingPreFixPhantom.length,
                qty_mismatch: reconcile.quantityMismatch.length,
                matched: reconcile.matched.length
            },
            post_fix: {
                orphaned: finalReconcile.orphaned.length,
                phantom: nonPendingPostFixPhantom.length,
                qty_mismatch: finalReconcile.quantityMismatch.length,
                matched: finalReconcile.matched.length
            },
            quantity_mismatches: finalReconcile.quantityMismatch
        });
    } catch (error) {
        res.status(500).json({ error: error.message, actions, errors });
    }
});

// Serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// ===== WebSocket for Real-Time Updates =====

const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcastToClients(data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

wss.on('connection', (ws) => {
    logger.info('Dashboard WebSocket client connected');
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    // Send initial state
    ws.send(JSON.stringify({
        type: 'init',
        data: {
            status: tradingEngine.getStatus(),
            signals: latestSignals.slice(0, 20),
            markets: db.getActiveMarkets().slice(0, 50)
        }
    }));

    ws.on('close', () => {
        logger.debug('Dashboard WebSocket client disconnected');
    });
});

// WebSocket heartbeat — drop dead connections every 30s
const wsHeartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ===== Main Trading Bot Loop =====

let latestSignals = [];
let latestActionable = [];
let latestSignalFunnel = {
    snapshot_at: null,
    cycle_count: 0,
    stages: {},
    by_type: {},
    dropped: {},
    spot_status: {}
};

function createEmptyFunnelCounters() {
    return {
        updated_at: null,
        cycles_observed: 0,
        stages: {
            scored: 0,
            actionable_initial: 0,
            actionable_post_autonomous_filter: 0,
            actionable_post_session_ttx: 0,
            actionable_post_spot_freshness: 0,
            passed_to_tick: 0
        },
        by_type: {
            actionable_initial: {},
            actionable_post_autonomous_filter: {},
            actionable_post_session_ttx: {},
            actionable_post_spot_freshness: {},
            passed_to_tick: {}
        },
        dropped: {
            autonomous_15m_mode_filter: {
                total: 0,
                by_reason: {},
                by_type: {}
            },
            autonomous_session_ttx_filter: {
                total: 0,
                by_reason: {},
                by_type: {}
            },
            spot_freshness_filter: {
                total: 0,
                by_reason: {},
                by_type: {}
            }
        }
    };
}

function mergeCountMaps(target, source) {
    for (const [key, value] of Object.entries(source || {})) {
        const num = Number(value) || 0;
        target[key] = (target[key] || 0) + num;
    }
}

function accumulateFunnelCounters(counter, funnel) {
    if (!counter || !funnel) return;

    counter.updated_at = new Date().toISOString();
    counter.cycles_observed += 1;

    for (const [stage, value] of Object.entries(funnel.stages || {})) {
        counter.stages[stage] = (counter.stages[stage] || 0) + (Number(value) || 0);
    }

    for (const stage of Object.keys(counter.by_type)) {
        mergeCountMaps(counter.by_type[stage], funnel.by_type?.[stage] || {});
    }

    for (const dropStage of Object.keys(counter.dropped)) {
        const sourceDrop = funnel.dropped?.[dropStage] || {};
        counter.dropped[dropStage].total += Number(sourceDrop.total) || 0;
        mergeCountMaps(counter.dropped[dropStage].by_reason, sourceDrop.by_reason || {});
        mergeCountMaps(counter.dropped[dropStage].by_type, sourceDrop.by_type || {});
    }
}

let cumulativeSignalFunnel = createEmptyFunnelCounters();
let sessionSignalFunnel = createEmptyFunnelCounters();
let matchedMarketCache = [];
let cryptoMatchMeta = new Map(); // GEMI-* → { crypto_match, kalshi_synthetic_bid/ask/mid, ... }
let priceUpdateRunning = false;

function countBySignalType(signals) {
    const counts = {};
    for (const signal of signals || []) {
        const signalType = signal?.signalType || signal?.signal_type || 'unknown';
        counts[signalType] = (counts[signalType] || 0) + 1;
    }
    return counts;
}

function snapshotSpotStatusFromSignals(signals) {
    const assets = new Set();
    for (const signal of signals || []) {
        const marketId = signal?.marketId || '';
        const m = marketId.match(/^GEMI-([A-Z]+)/);
        if (m && m[1]) assets.add(m[1]);
    }

    const status = {};
    for (const asset of assets) {
        const ageMs = getSpotAgeMs(asset);
        const meta = spotPriceMeta[asset] || {};
        status[asset] = {
            age_ms: ageMs,
            source: meta.source || null,
            fetched_at: meta.fetchedAt || null,
            price: Number.isFinite(Number(spotPriceCache[asset])) ? Number(spotPriceCache[asset]) : null
        };
    }
    return status;
}

const botState = {
    running: false,
    startTime: null,
    stopReason: null,   // reason set when bot stops (session_loss_limit_hit, session_profit_target_hit, session_timeout, etc.)
    cycleCount: 0,
    lastCycleTime: 0,
    lastMatchTime: 0,
    lastPriceRefresh: 0,
    lastKalshiPriceRefresh: 0,
    priceUpdateInterval: null,
    matchInterval: null,
    cleanupInterval: null,
    // Session-end cleanup tracking (reset each time stopBot is called outside of active cleanup)
    cleanupStatus: 'idle',  // 'idle' | 'in_progress' | 'complete' | 'complete_non_flat' | 'failed'
    cleanupResult: null,
    cleanupTs: null
};

/**
 * Update prices for all matched markets
 */
async function updatePrices() {
    if (priceUpdateRunning) return; // Prevent overlapping cycles
    if (isCircuitOpen()) return;    // Circuit breaker active
    priceUpdateRunning = true;
    let cycleSuccess = true;
    const cycleStart = Date.now();
    try {
        // Drawdown kill-switch (check every 10 cycles)
        if (botState.cycleCount % 10 === 0 && checkDrawdownKillSwitch()) {
            return;
        }
        if (matchedMarketCache.length === 0) {
            matchedMarketCache = db.getMatchedMarkets(0.5);
            // Merge any crypto match metadata from last match cycle
            for (const m of matchedMarketCache) {
                const meta = cryptoMatchMeta.get(m.gemini_market_id);
                if (meta) Object.assign(m, meta);
            }
            if (matchedMarketCache.length > 0) {
                logger.info(`Loaded ${matchedMarketCache.length} matched markets for price updates`);
            }
        }

        if (matchedMarketCache.length === 0) return; // Nothing to do yet

        const marketStates = [];
        let pricesReceived = 0;

        // Refresh Polymarket prices from Gamma API every 30 seconds
        if (!botState.lastPriceRefresh || Date.now() - botState.lastPriceRefresh > REF_BULK_REFRESH_INTERVAL_MS) {
            try {
                const refreshed = await polyClient.refreshPrices();
                if (refreshed > 0) {
                    botState.lastPriceRefresh = Date.now();
                    logger.debug(`Refreshed ${refreshed} Polymarket prices from Gamma API`);
                    recordApiResult('polymarket', true);
                }
            } catch (e) {
                recordApiResult('polymarket', false, e);
            }
        }

        // Refresh Kalshi prices in bulk every 30 seconds (mirrors Polymarket pattern)
        if (!botState.lastKalshiPriceRefresh || Date.now() - botState.lastKalshiPriceRefresh > REF_BULK_REFRESH_INTERVAL_MS) {
            try {
                const refreshed = await kalshiClient.refreshPrices();
                if (refreshed > 0) {
                    botState.lastKalshiPriceRefresh = Date.now();
                    logger.debug(`Refreshed ${refreshed} Kalshi prices from REST API`);
                    recordApiResult('kalshi', true);
                }
            } catch (e) {
                recordApiResult('kalshi', false, e);
            }
        }

        // Fetch live spot prices for FairValueEngine (BTC, ETH, SOL)
        await fetchSpotPrices();

        // Refresh Gemini real market data ONCE per cycle (not per-market)
        if (geminiClient.useRealPrices) {
            await geminiClient.refreshRealData();
        }

        for (const matched of matchedMarketCache) {
            try {
                // Get Polymarket price from cached Gamma API data (fast, no per-market API call)
                const cachedPoly = polyClient.getCachedPrice(matched.polymarket_market_id);
                let polyPrices = { bid: null, ask: null, spread: null };
                if (cachedPoly) {
                    const halfSpread = cachedPoly.spread / 2;
                    polyPrices = {
                        bid: Math.max(0.01, cachedPoly.last - halfSpread),
                        ask: Math.min(0.99, cachedPoly.last + halfSpread),
                        last: cachedPoly.last,
                        spread: cachedPoly.spread
                    };
                }

                // Get Kalshi price
                let kalshiPrices = { bid: null, ask: null };
                const isCryptoMatch = matched.crypto_match ||
                    (matched.gemini_market_id && matched.gemini_market_id.startsWith('GEMI-'));
                if (isCryptoMatch && matched.kalshi_synthetic_bid != null) {
                    // Crypto structural match: use synthetic above-probability from brackets
                    kalshiPrices = {
                        bid: matched.kalshi_synthetic_bid,
                        ask: matched.kalshi_synthetic_ask,
                        last: matched.kalshi_synthetic_mid,
                        spread: matched.kalshi_synthetic_ask - matched.kalshi_synthetic_bid,
                        source: 'synthetic'
                    };
                } else if (isCryptoMatch) {
                    // Crypto match but no synthetic data yet (match cycle pending) — skip
                } else if (matched.kalshi_market_id) {
                    // Use bulk-refreshed price cache (no per-market API call)
                    const cachedKalshi = kalshiClient.getCachedPrice(matched.kalshi_market_id);
                    if (cachedKalshi) {
                        kalshiPrices = {
                            bid: cachedKalshi.bid,
                            ask: cachedKalshi.ask,
                            last: cachedKalshi.last,
                            spread: cachedKalshi.spread,
                            volume: cachedKalshi.volume,
                            source: 'cached'
                        };
                    } else {
                        // Fallback: check WS bracketCache for real-time data
                        const wsCached = kalshiClient.bracketCache.get(matched.kalshi_market_id);
                        if (wsCached && wsCached.ts && (Date.now() - wsCached.ts) < 30000) {
                            kalshiPrices = {
                                bid: wsCached.yesBid,
                                ask: wsCached.yesAsk,
                                last: wsCached.lastPrice,
                                spread: (wsCached.yesBid != null && wsCached.yesAsk != null)
                                    ? wsCached.yesAsk - wsCached.yesBid : null,
                                volume: wsCached.volume || 0,
                                source: 'ws'
                            };
                        }
                    }
                }

                if (polyPrices.bid !== null || kalshiPrices.bid !== null) pricesReceived++;
                // Update Gemini paper market with reference price
                const refPrice = [];
                if (polyPrices.bid && polyPrices.ask) {
                    refPrice.push((polyPrices.bid + polyPrices.ask) / 2);
                }
                if (kalshiPrices.bid && kalshiPrices.ask) {
                    refPrice.push((kalshiPrices.bid + kalshiPrices.ask) / 2);
                }

                if (refPrice.length > 0) {
                    const avgRef = refPrice.reduce((a, b) => a + b, 0) / refPrice.length;
                    geminiClient.updatePaperMarket(matched.gemini_market_id, avgRef, {
                        title: matched.event_title
                    });
                }

                // Get Gemini state
                const geminiState = await geminiClient.getMarketState(matched.gemini_market_id);
                if (geminiState && geminiState.bid !== null) {
                    recordApiResult('gemini', true);
                }

                // Look up additional reference sources (from match cycle cache)
                let metaculusProb = null;
                let oddsApiProb = null;
                try {
                    metaculusProb = metaculusClient.getProbability(matched.event_title);
                } catch (e) { /* ignore */ }
                try {
                    const oddsMatch = oddsClient.findMatchingOdds(matched.event_title);
                    if (oddsMatch && oddsMatch.outcomes) {
                        const titleLower = (matched.event_title || '').toLowerCase();
                        for (const [name, prob] of Object.entries(oddsMatch.outcomes)) {
                            if (titleLower.includes(name.toLowerCase())) {
                                oddsApiProb = prob;
                                break;
                            }
                        }
                    }
                } catch (e) { /* ignore */ }

                // Fetch Deribit options spread for short-TTX crypto markets
                let deribitSpread = null;
                try {
                    const ttx = matched.gemini_market_id ? (function() {
                        const m = (matched.gemini_market_id || '').match(/GEMI-(\w+?)(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
                        if (!m) return null;
                        const [, asset, yy, mm, dd, hh, mn] = m;
                        const exp = new Date(`20${yy}-${mm}-${dd}T${hh}:${mn}:00Z`);
                        return (exp.getTime() - Date.now()) / 1000;
                    })() : null;
                    
                    // Only fetch Deribit for short-TTX crypto markets (< 1 hour)
                    if (ttx && ttx > 0 && ttx <= 3600 && matched.category === 'crypto') {
                        const asset = matched.gemini_market_id ? matched.gemini_market_id.match(/GEMI-(\w+?)\d/)?.[1] : null;
                        if (asset) {
                            deribitSpread = await deribitClient.getOptionsSpread(asset, ttx * 1000);
                        }
                    }
                } catch (e) { /* ignore — Deribit is optional, use fallback */ }

                // Save price snapshot to DB
                db.insertPrice({
                    timestamp: Math.floor(Date.now() / 1000),
                    gemini_market_id: matched.gemini_market_id,
                    polymarket_bid: polyPrices.bid,
                    polymarket_ask: polyPrices.ask,
                    polymarket_last: polyPrices.bid && polyPrices.ask ? (polyPrices.bid + polyPrices.ask) / 2 : null,
                    kalshi_bid: kalshiPrices.bid,
                    kalshi_ask: kalshiPrices.ask,
                    kalshi_last: kalshiPrices.bid && kalshiPrices.ask ? (kalshiPrices.bid + kalshiPrices.ask) / 2 : null,
                    gemini_bid: geminiState.bid,
                    gemini_ask: geminiState.ask,
                    gemini_last: geminiState.last,
                    gemini_volume: geminiState.volume
                });

                // Build state for signal detector
                marketStates.push({
                    marketId: matched.gemini_market_id,
                    category: matched.category,
                    matchedMarket: matched,
                    gemini: geminiState,
                    polymarket: {
                        bid: polyPrices.bid,
                        ask: polyPrices.ask,
                        last: polyPrices.bid && polyPrices.ask ? (polyPrices.bid + polyPrices.ask) / 2 : null,
                        spread: polyPrices.spread
                    },
                    kalshi: {
                        bid: kalshiPrices.bid,
                        ask: kalshiPrices.ask,
                        last: kalshiPrices.bid && kalshiPrices.ask ? (kalshiPrices.bid + kalshiPrices.ask) / 2 : null,
                        spread: kalshiPrices.spread
                    },
                    metaculus: metaculusProb != null ? { probability: metaculusProb } : null,
                    oddsApi: oddsApiProb != null ? { probability: oddsApiProb } : null,
                    deribit: deribitSpread != null ? deribitSpread.mid : null
                });
            } catch (error) {
                logger.warn(`Market ${matched.gemini_market_id} update error: ${error.message}`);
                recordApiResult('gemini', false, error);
            }
        }

        const loopElapsed = Date.now() - cycleStart;

        // Run signal detection — DUAL STRATEGY
        // Strategy 1: Composite score (velocity + spread + consensus)
        latestSignals = signalDetector.processMarkets(marketStates);
        let actionable = latestSignals.filter(s => s.actionable);
        const funnel = {
            snapshot_at: new Date().toISOString(),
            cycle_count: botState.cycleCount,
            filter_config: {
                autonomous_allowed_signal_types: Array.from(autonomousAllowedSignalTypes),
                source_session_ttx_filter_enabled: AUTONOMOUS_SOURCE_TTX_FILTER
            },
            stages: {
                scored: latestSignals.length,
                actionable_initial: actionable.length,
                actionable_post_autonomous_filter: 0,
                actionable_post_session_ttx: 0,
                actionable_post_spot_freshness: 0,
                passed_to_tick: 0
            },
            by_type: {
                actionable_initial: countBySignalType(actionable),
                actionable_post_autonomous_filter: {},
                actionable_post_session_ttx: {},
                actionable_post_spot_freshness: {},
                passed_to_tick: {}
            },
            dropped: {
                autonomous_15m_mode_filter: {
                    total: 0,
                    by_reason: {},
                    by_type: {}
                },
                autonomous_session_ttx_filter: {
                    total: 0,
                    by_reason: {},
                    by_type: {}
                },
                spot_freshness_filter: {
                    total: 0,
                    by_reason: {},
                    by_type: {}
                }
            },
            spot_status: {}
        };

        // Strategy 2: Fair Value (Black-Scholes + Kalshi ensemble) — for crypto contracts
        try {
            const geminiContracts = buildGeminiContracts(matchedMarketCache, marketStates);
            if (geminiContracts.length > 0) {
                const fvSignals = await signalDetector.generateFairValueSignals(geminiContracts, (contract) => {
                    // Look up reference data for this contract from marketStates
                    const state = marketStates.find(s => s.marketId === contract.marketId);
                    if (!state) return {};
                    return {
                        polymarket: state.polymarket?.last,
                        metaculus: state.metaculus?.probability,
                        oddsApi: state.oddsApi?.probability,
                        category: state.category || 'crypto'
                    };
                });

                // Merge: fair-value signals take priority (model-based > heuristic)
                // De-duplicate by marketId, preferring higher edge
                const seenIds = new Set(actionable.map(s => s.marketId));
                for (const fvs of fvSignals) {
                    if (seenIds.has(fvs.marketId)) {
                        // Replace composite signal with fair-value if higher edge
                        const idx = actionable.findIndex(s => s.marketId === fvs.marketId);
                        if (idx >= 0 && (fvs.netEdge || 0) > (actionable[idx].edge || 0)) {
                            actionable[idx] = fvs;
                        }
                    } else {
                        actionable.push(fvs);
                        seenIds.add(fvs.marketId);
                    }
                }

                if (fvSignals.length > 0 && botState.cycleCount % 10 === 0) {
                    logger.info(`FairValue: ${geminiContracts.length} contracts analyzed, ${fvSignals.length} actionable`);
                }
            }
        } catch (fvErr) {
            logger.debug('FairValue signals: ' + fvErr.message);
        }

        // (Strategy 1+2 complete)

        // Strategy 3: Event-Driven Momentum — boost signals when spot moves but contracts lag
        // Strategy 4: Cross-Platform Synthetic Arb — Gemini YES price vs Kalshi implied NO
        try {
            const geminiContracts = buildGeminiContracts(matchedMarketCache, marketStates);
            for (const state of marketStates) {
                const { marketId, gemini, kalshi } = state;
                const contractInfo = geminiContracts.find(c => c.marketId === marketId);
                if (!contractInfo) continue;

                const { asset } = contractInfo;
                const spotPrice = spotPriceCache[asset];
                if (!spotPrice) continue;

                // Momentum: detect when spot moves fast but contract has not repriced
                const contractState = {
                    marketId,
                    bid: gemini?.bid,
                    ask: gemini?.ask,
                    delta: contractInfo.delta || 0   // delta from last FV signal (0 if unknown)
                };
                const momentum = signalDetector.detectMomentum(asset, spotPrice, contractState);
                if (momentum) {
                    // Boost any existing actionable signal for this market, or add new one
                    const idx = actionable.findIndex(s => s.marketId === marketId);
                    if (idx >= 0) {
                        actionable[idx] = signalDetector.applyMomentumBoost(actionable[idx], momentum);
                    } else {
                        // Create a momentum-only signal to enter on
                        actionable.push({
                            marketId,
                            title: state.matchedMarket?.event_title || '',
                            category: state.category || 'crypto',
                            signalType: 'momentum',
                            score: Math.min(100, Math.round(momentum.urgency * 75)),
                            direction: momentum.direction,
                            referencePrice: gemini?.last,
                            targetPrice: null,
                            gemini_bid: gemini?.bid,
                            gemini_ask: gemini?.ask,
                            gemini_last: gemini?.last,
                            edge: momentum.contractLag,
                            netEdge: momentum.contractLag,
                            confidence: 'medium',
                            momentum,
                            actionable: true,
                            timestamp: Date.now()
                        });
                    }
                }

                // Cross-platform arb: Gemini vs Kalshi synthetic
                if (kalshi && gemini) {
                    const kalshiAnalysis = await kalshiClient.analyzeGeminiContract(
                        asset,
                        contractInfo.strike,
                        gemini.bid,
                        gemini.ask,
                        contractInfo.settlementHour
                    ).catch(() => null);

                    if (kalshiAnalysis && kalshiAnalysis.matched) {
                        const arb = signalDetector.detectCrossPlatformArb(gemini, kalshiAnalysis);
                        if (arb) {
                            logger.info(
                                `CROSS-PLATFORM ARB: ${marketId} edge=${arb.netEdge?.toFixed(3)} ` +
                                `dir=${arb.direction} Gemini=${gemini.bid?.toFixed(3)}/${gemini.ask?.toFixed(3)} ` +
                                `KalshiFV=${kalshiAnalysis.kalshiFairValue?.toFixed(3)}`
                            );
                            // Send Discord arb alert (rate-limited per market)
                            const arbSignal = {
                                marketId,
                                title: state.matchedMarket?.event_title || '',
                                direction: arb.direction,
                                netEdge: arb.netEdge,
                                gemini_bid: gemini.bid,
                                gemini_ask: gemini.ask,
                                score: Math.min(100, Math.round((arb.netEdge || 0) * 1500)),
                                arb: { ...arb, kalshiFairValue: kalshiAnalysis.kalshiFairValue },
                                timestamp: Date.now()
                            };
                            alerts.sendArbAlert(arbSignal).catch(() => {});
                            // Inject as high-priority actionable signal
                            // Normalize arb direction: BUY_GEMINI_YES/SYNTHETIC_ARB → YES, SELL_GEMINI_YES → NO
                            // Paper trading engine expects 'YES'/'NO', not the arb-specific direction names
                            const arbDirection = (arb.direction === 'SELL_GEMINI_YES') ? 'NO' : 'YES';
                            const seenIds = new Set(actionable.map(s => s.marketId));
                            if (!seenIds.has(marketId)) {
                                actionable.push({
                                    marketId,
                                    title: state.matchedMarket?.event_title || '',
                                    category: state.category || 'crypto',
                                    signalType: 'cross_platform_arb',
                                    score: Math.min(100, Math.round((arb.netEdge || 0) * 1500)),
                                    direction: arbDirection,
                                    referencePrice: kalshiAnalysis.kalshiFairValue,
                                    gemini_bid: gemini.bid,
                                    gemini_ask: gemini.ask,
                                    gemini_ask_depth: gemini.ask_depth || null,
                                    edge: arb.edge,
                                    netEdge: arb.netEdge,
                                    confidence: 'high',
                                    arb,
                                    actionable: true,
                                    timestamp: Date.now()
                                });
                            }
                        }
                    }
                }
            }
        } catch (momentumErr) {
            logger.debug('Momentum/arb scan: ' + momentumErr.message);
        }

        // Strategy 5: Multi-source ensemble FV for non-crypto markets
        // Uses Polymarket + Kalshi + Metaculus + OddsAPI probabilities as fair value
        try {
            const seenIdsForFV = new Set(actionable.map(s => s.marketId));
            for (const state of marketStates) {
                if (state.category === 'crypto') continue; // Already handled by BS-based FV
                if (!state.gemini?.bid || !state.gemini?.ask) continue;
                if (seenIdsForFV.has(state.marketId)) continue;

                const polyMid = state.polymarket?.last;
                const metaProb = state.metaculus?.probability;
                const oddsProb = state.oddsApi?.probability;
                const kalshiMid = state.kalshi?.last;

                // Need at least one reference source
                if (polyMid == null && metaProb == null && oddsProb == null && kalshiMid == null) continue;

                const ensemble = signalDetector.fairValueEngine.ensembleFairValue(
                    null,
                    kalshiMid != null ? { model: 'KALSHI_SYNTHETIC', fairValue: kalshiMid } : null,
                    {
                        polymarket: polyMid,
                        metaculus: metaProb,
                        oddsApi: oddsProb,
                        category: state.category
                    }
                );

                if (!ensemble) continue;

                const fv = ensemble.fairValue;
                let direction = null;
                let edge = 0;

                if (fv > state.gemini.ask) {
                    direction = 'YES';
                    edge = fv - state.gemini.ask;
                } else if (fv < state.gemini.bid) {
                    direction = 'NO';
                    edge = state.gemini.bid - fv;
                }

                const fees = (state.gemini.ask || 0.5) * 0.0001 * 2;
                const netEdge = edge - fees;

                if (direction && netEdge >= 0.03) {
                    actionable.push({
                        marketId: state.marketId,
                        title: state.matchedMarket?.event_title || '',
                        category: state.category || 'other',
                        signalType: 'multi_source_fv',
                        score: Math.min(100, Math.round(netEdge * 1000)),
                        direction,
                        referencePrice: fv,
                        targetPrice: direction === 'YES' ? Math.min(fv, 0.99) : Math.max(fv, 0.01),
                        gemini_bid: state.gemini.bid,
                        gemini_ask: state.gemini.ask,
                        gemini_last: state.gemini.last,
                        edge,
                        netEdge,
                        confidence: netEdge >= 0.08 ? 'high' : 'medium',
                        models: ensemble,
                        actionable: true,
                        timestamp: Date.now()
                    });
                    seenIdsForFV.add(state.marketId);
                }
            }
        } catch (fvErr) {
            logger.debug('Multi-source FV: ' + fvErr.message);
        }

        if (autonomous15mSession) {
            // In autonomous mode, keep only GEMI fair-value signals by default.
            // This matches the trading engine's 15-minute session policy and
            // prevents composite signals from reaching tick() only to be rejected later.
            const kept = [];
            for (const signal of actionable) {
                const signalType = signal.signalType || signal.signal_type || 'unknown';
                let dropReason = null;

                if (!signal.marketId || !signal.marketId.startsWith('GEMI-')) {
                    dropReason = 'non_gemi_market';
                } else if (!autonomousAllowedSignalTypes.has(signalType)) {
                    dropReason = 'unsupported_signal_type';
                }

                if (dropReason) {
                    funnel.dropped.autonomous_15m_mode_filter.total += 1;
                    funnel.dropped.autonomous_15m_mode_filter.by_reason[dropReason] =
                        (funnel.dropped.autonomous_15m_mode_filter.by_reason[dropReason] || 0) + 1;
                    funnel.dropped.autonomous_15m_mode_filter.by_type[signalType] =
                        (funnel.dropped.autonomous_15m_mode_filter.by_type[signalType] || 0) + 1;
                } else {
                    kept.push(signal);
                }
            }
            actionable = kept;
        }

        funnel.stages.actionable_post_autonomous_filter = actionable.length;
        funnel.by_type.actionable_post_autonomous_filter = countBySignalType(actionable);

        if (autonomous15mSession) {
            const kept = [];
            for (const signal of actionable) {
                const signalType = signal.signalType || signal.signal_type || 'unknown';
                const ttxSeconds = parseGemiExpirySeconds(signal.marketId);
                let dropReason = null;
                const leakPrefix = AUTONOMOUS_SOURCE_TTX_FILTER ? 'source_filter_leak:' : '';

                if (ttxSeconds == null) {
                    dropReason = `${leakPrefix}ttx_unparseable`;
                } else if (ttxSeconds <= 0) {
                    dropReason = `${leakPrefix}ttx_expired`;
                } else if (ttxSeconds < sessionMinTtxSeconds) {
                    dropReason = `${leakPrefix}ttx_lt_${sessionMinTtxSeconds}s`;
                } else if (!allowLongTtxIn15mSession && ttxSeconds > sessionMaxTtxSeconds) {
                    dropReason = `${leakPrefix}ttx_gt_${sessionMaxTtxSeconds}s`;
                }

                if (dropReason) {
                    funnel.dropped.autonomous_session_ttx_filter.total += 1;
                    funnel.dropped.autonomous_session_ttx_filter.by_reason[dropReason] =
                        (funnel.dropped.autonomous_session_ttx_filter.by_reason[dropReason] || 0) + 1;
                    funnel.dropped.autonomous_session_ttx_filter.by_type[signalType] =
                        (funnel.dropped.autonomous_session_ttx_filter.by_type[signalType] || 0) + 1;
                } else {
                    kept.push(signal);
                }
            }
            actionable = kept;
        }

        funnel.stages.actionable_post_session_ttx = actionable.length;
        funnel.by_type.actionable_post_session_ttx = countBySignalType(actionable);
        funnel.spot_status = snapshotSpotStatusFromSignals(actionable);

        // Publish actionable signals AFTER all runtime filters so diagnostics
        // match the exact set handed to the trading engine.
        latestActionable = actionable.slice();

        // Periodic debug logging (every 10 cycles)
        if (botState.cycleCount % 10 === 0) {
            const topScore = latestSignals.length > 0 ? latestSignals[0].score : 0;
            const withPrices = pricesReceived;
            const spotInfo = Object.entries(spotPriceCache).map(([a, p]) => `${a}=$${Math.round(p)}`).join(' ');
            const refSources = [];
            if (metaculusClient.questions.size > 0) refSources.push(`Meta:${metaculusClient.questions.size}`);
            if (oddsClient.matchedOdds.size > 0) refSources.push(`Odds:${oddsClient.matchedOdds.size}`);
            const refInfo = refSources.length > 0 ? ` | Refs: ${refSources.join(' ')}` : '';
            logger.info(
                `Cycle ${botState.cycleCount}: ${matchedMarketCache.length} markets, ` +
                `${withPrices} with prices, ${latestSignals.length} scored, ` +
                `top=${topScore}, actionable=${actionable.length}, ${loopElapsed}ms` +
                (spotInfo ? ` | Spot: ${spotInfo}` : '') +
                refInfo
            );
        }

        // Run trading engine tick (skipped in DATA_ONLY mode)
        if (botState.running && !dataOnlyMode) {
            // Enrich signals with spot prices for deep-ITM/OTM guard
            const filteredForSpotFreshness = [];
            for (const sig of actionable) {
                if (sig.marketId && sig.marketId.startsWith('GEMI-')) {
                    const signalType = sig.signalType || sig.signal_type || 'unknown';
                    const assetMatch = sig.marketId.match(/^GEMI-([A-Z]+)/);
                    if (assetMatch && spotPriceCache[assetMatch[1]]) {
                        const asset = assetMatch[1];
                        const ageMs = getSpotAgeMs(asset);
                        if (ageMs !== null && ageMs > SPOT_STALE_THRESHOLD_MS) {
                            const reason = `spot_age_gt_${SPOT_STALE_THRESHOLD_MS}ms`;
                            funnel.dropped.spot_freshness_filter.total += 1;
                            funnel.dropped.spot_freshness_filter.by_reason[reason] =
                                (funnel.dropped.spot_freshness_filter.by_reason[reason] || 0) + 1;
                            funnel.dropped.spot_freshness_filter.by_type[signalType] =
                                (funnel.dropped.spot_freshness_filter.by_type[signalType] || 0) + 1;
                            continue;
                        }
                        sig._spotPrice = spotPriceCache[asset];
                    }
                }
                filteredForSpotFreshness.push(sig);
            }
            actionable = filteredForSpotFreshness;
            latestActionable = actionable.slice();
            funnel.stages.actionable_post_spot_freshness = actionable.length;
            funnel.by_type.actionable_post_spot_freshness = countBySignalType(actionable);
            funnel.stages.passed_to_tick = actionable.length;
            funnel.by_type.passed_to_tick = countBySignalType(actionable);
            latestSignalFunnel = funnel;
            accumulateFunnelCounters(cumulativeSignalFunnel, funnel);
            if (botState.running) {
                accumulateFunnelCounters(sessionSignalFunnel, funnel);
            }

            // Warm-up period: observe but don't trade for first N cycles
            if (warmupCyclesRemaining > 0) {
                warmupCyclesRemaining--;
                if (warmupCyclesRemaining === 0) {
                    logger.info(`Warm-up complete — trading enabled after ${WARMUP_CYCLES} observation cycles`);
                } else if (warmupCyclesRemaining % 10 === 0) {
                    logger.info(`Warm-up: ${warmupCyclesRemaining} cycles remaining, ${actionable.length} signals observed`);
                }
                // Still run tick with empty signals to process exits on existing positions
                const result = await tradingEngine.tick([]);
                signalDetector.loadParameters();

                // Autonomous session hard-stops: loss limit, profit target, or timeout.
                // Any of these conditions should fully stop the bot.
                const gate = tradingEngine.getStatus().pre_trade_gate;
                const autonomousStopReasons = ['session_loss_limit_hit', 'session_profit_target_hit', 'session_timeout'];
                if (tradingEngine.autonomous15mSession && gate && !gate.allowed && autonomousStopReasons.includes(gate.reason)) {
                    if (gate.reason === 'session_profit_target_hit') {
                        logger.info(
                            `AUTONOMOUS SESSION STOP: ${gate.reason} ` +
                            `(session_pnl=+$${gate.details?.session_pnl?.toFixed(2)}, target=$${gate.details?.profit_target_usd})`
                        );
                    } else if (gate.reason === 'session_timeout') {
                        logger.info(
                            `AUTONOMOUS SESSION STOP: ${gate.reason} ` +
                            `(elapsed=${gate.details?.elapsed_minutes}m, session_pnl=$${gate.details?.session_pnl?.toFixed(2)})`
                        );
                    } else {
                        logger.error(
                            `AUTONOMOUS SESSION STOP: ${gate.reason} ` +
                            `(session_pnl=${gate.details?.session_pnl}, limit=-${gate.details?.loss_limit_usd})`
                        );
                    }
                    stopBot(gate.reason);
                }
            } else {
            // Sort signals: near-expiry first so short-term contracts get priority
            // (15M and hourly contracts should fill before multi-day holds)
            actionable.sort((a, b) => {
                const getTTX = (sig) => {
                    if (!sig.marketId) return Infinity;
                    const m = sig.marketId.match(/GEMI-\w+?(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
                    if (!m) return Infinity;
                    const [, yy, mm, dd, hh, mn] = m;
                    const expiry = new Date(`20${yy}-${mm}-${dd}T${hh}:${mn}:00Z`);
                    return (expiry.getTime() - Date.now()) / 1000;
                };
                return getTTX(a) - getTTX(b);
            });
            const result = await tradingEngine.tick(actionable);
            signalDetector.loadParameters(); // sync minScore from DB after adaptive learning

            // Autonomous session hard-stops: loss limit, profit target, or timeout.
            const gate = tradingEngine.getStatus().pre_trade_gate;
            const autonomousStopReasons = ['session_loss_limit_hit', 'session_profit_target_hit', 'session_timeout'];
            if (tradingEngine.autonomous15mSession && gate && !gate.allowed && autonomousStopReasons.includes(gate.reason)) {
                if (gate.reason === 'session_profit_target_hit') {
                    logger.info(
                        `AUTONOMOUS SESSION STOP: ${gate.reason} ` +
                        `(session_pnl=+$${gate.details?.session_pnl?.toFixed(2)}, target=$${gate.details?.profit_target_usd})`
                    );
                } else if (gate.reason === 'session_timeout') {
                    logger.info(
                        `AUTONOMOUS SESSION STOP: ${gate.reason} ` +
                        `(elapsed=${gate.details?.elapsed_minutes}m, session_pnl=$${gate.details?.session_pnl?.toFixed(2)})`
                    );
                } else {
                    logger.error(
                        `AUTONOMOUS SESSION STOP: ${gate.reason} ` +
                        `(session_pnl=${gate.details?.session_pnl}, limit=-${gate.details?.loss_limit_usd})`
                    );
                }
                stopBot(gate.reason);
            }

            if (result.entries.length > 0 || result.exits.length > 0) {
                broadcastToClients({
                    type: 'trade_update',
                    data: {
                        entries: result.entries,
                        exits: result.exits,
                        status: tradingEngine.getStatus()
                    }
                });
            }
            } // end else (warm-up complete)
        }

        // Broadcast price updates
        const displayWallet = await getDisplayWallet();
        broadcastToClients({
            type: 'price_update',
            data: {
                signals: latestSignals.slice(0, 20),
                wallet: displayWallet,
                open_trades: db.getOpenTrades().length,
                spot_prices: spotPriceCache,
                timestamp: Date.now()
            }
        });

        botState.cycleCount++;
        botState.lastCycleTime = Date.now();

    } catch (error) {
        cycleSuccess = false;
        logger.error('Price update cycle error: ' + error.message);
    } finally {
        recordCycleResult(cycleSuccess, cycleSuccess ? null : new Error('cycle failed'));
        priceUpdateRunning = false;
    }
}

/**
 * Run market matching cycle
 */
async function runMatchCycle() {
    try {
        logger.info('Running market match cycle...');
        const result = await matcher.runMatchCycle(polyClient, kalshiClient, geminiClient);
        matchedMarketCache = db.getMatchedMarkets(0.5);
        botState.lastMatchTime = Date.now();

        // Preserve crypto match metadata (synthetic Kalshi prices not stored in DB)
        cryptoMatchMeta.clear();
        for (const match of (result.matches || [])) {
            if (match.crypto_match) {
                cryptoMatchMeta.set(match.gemini_market_id, {
                    crypto_match: true,
                    kalshi_synthetic_bid: match.kalshi_synthetic_bid,
                    kalshi_synthetic_ask: match.kalshi_synthetic_ask,
                    kalshi_synthetic_mid: match.kalshi_synthetic_mid,
                    kalshi_strike: match.kalshi_strike,
                    gemini_strike: match.gemini_strike,
                    kalshi_settlement_hour: match.kalshi_settlement_hour
                });
            }
        }

        // Merge crypto metadata into matchedMarketCache
        for (const m of matchedMarketCache) {
            const meta = cryptoMatchMeta.get(m.gemini_market_id);
            if (meta) Object.assign(m, meta);
        }

        logger.info(`Match cycle complete: ${result.matched_count} markets matched (${cryptoMatchMeta.size} crypto)`);

        // Fetch reference data from additional sources (best-effort, non-blocking)
        try {
            if (oddsClient.isConfigured()) {
                await oddsClient.getConsensusOdds();
                logger.info(`Odds API: ${oddsClient.matchedOdds.size} sports events cached`);
            }
        } catch (e) {
            logger.debug(`Odds API refresh skipped: ${e.message}`);
        }
        try {
            await metaculusClient.getActiveQuestions({ limit: 50 });
            logger.info(`Metaculus: ${metaculusClient.questions.size} questions cached`);
        } catch (e) {
            logger.debug(`Metaculus refresh skipped: ${e.message}`);
        }

        // Subscribe Kalshi WS to all matched Kalshi market tickers
        // Skip event tickers (KXBTC-*) — WS subscription is for individual market tickers
        const kalshiTickers = matchedMarketCache
            .filter(m => m.kalshi_market_id && !m.crypto_match)
            .map(m => m.kalshi_market_id);
        if (kalshiTickers.length > 0) {
            kalshiWS.subscribe(kalshiTickers);
            logger.info(`Kalshi WS: subscribed to ${kalshiTickers.length} brackets`);
        }

        broadcastToClients({
            type: 'match_update',
            data: result
        });
    } catch (error) {
        logger.error('Match cycle error: ' + error.message);
    }
}

/**
 * Cleanup old data
 */
async function runCleanup() {
    try {
        const cutoff = Math.floor(Date.now() / 1000) - (7 * 86400); // 7 days
        db.cleanOldPrices(cutoff);
        signalDetector.cleanup();
        signalDetector.updateCategoryWinRates();

        // Position reconciliation (live/sandbox mode only)
        const recon = await tradingEngine.reconcilePositions();
        const nonPendingPhantom = (recon.phantom || []).filter(p => !p.pendingExit && !p.transientGrace);
        if (!recon.skipped && (
            (recon.orphaned || []).length > 0 ||
            nonPendingPhantom.length > 0 ||
            (recon.quantityMismatch || []).length > 0
        )) {
            logger.warn(
                `RECONCILIATION ALERT: ${nonPendingPhantom.length} phantom, ` +
                `${recon.orphaned.length} orphaned, ${(recon.quantityMismatch || []).length} qty_mismatch`
            );
        }

        // Daily P&L alert (fires once per calendar day; Alerts module deduplicates)
        const wallet = db.getWallet();
        const dailyPnL = db.getDailyPnL();
        alerts.sendDailyPnL(wallet, dailyPnL).catch(() => {});
    } catch (error) {
        logger.warn('Cleanup error: ' + error.message);
    }
}

/**
 * Start the trading bot
 */
// Warm-up: observe N cycles before allowing trades (prevents blind entries on startup)
// Reduced warmup when the bot already has open positions (restart scenario)
// Autonomous 15m recovery mode trades immediately after restart.
const WARMUP_CYCLES = autonomous15mSession ? 0 : 30;
const WARMUP_FAST = 5;     // 5 cycles when restarting with existing positions
let warmupCyclesRemaining = WARMUP_CYCLES;

async function startBot() {
    if (botState.running) return;

    let preflight = null;
    const sessionTradeMode = isLiveOrSandboxMode() ? 'live' : 'paper';
    if (isLiveOrSandboxMode()) {
        preflight = await runLivePreflightCheck({ forceGate: true });
        if (!preflight.valid) {
            throw new Error(`live_preflight_failed:${preflight.reason}`);
        }
        if (preflight.details?.balance == null || preflight.details.balance <= 0) {
            throw new Error('live_balance_unavailable');
        }
        tradingEngine._liveBalance = preflight.details.balance;
    }

    const sessionDailyAtStart = db.getDailyPnL(sessionTradeMode);
    const sessionStartBalance = isLiveOrSandboxMode()
        ? (preflight?.details?.balance ?? null)
        : (db.getWallet()?.balance ?? null);
    tradingEngine.markSessionStart(sessionDailyAtStart?.daily_pnl || 0, sessionStartBalance);
    botState.running = true;
    botState.startTime = Date.now();
    botState.stopReason = null; // clear any previous stop reason
    tradingEngine.isRunning = true;
    warmupCyclesRemaining = WARMUP_CYCLES;
    peakBalance = null; // reset so kill-switch seeds from current real balance on first check
    sessionSignalFunnel = createEmptyFunnelCounters();
    // If we already have open positions, use shorter warmup (restart scenario)
    const openTrades = tradingEngine.db.getOpenTrades();
    if (openTrades.length > 0) {
        warmupCyclesRemaining = WARMUP_FAST;
        logger.info(`Fast warmup: ${openTrades.length} existing positions detected, ${WARMUP_FAST} cycles`);
    }

    // Load adaptive parameters
    signalDetector.loadParameters();
    signalDetector.updateCategoryWinRates();

    // Connect Kalshi WebSocket for real-time bracket prices
    kalshiWS.connect().catch(err => logger.warn('Kalshi WS connect failed: ' + err.message));

    // Connect Spot WebSocket for real-time BTC/ETH/SOL/XRP/ZEC prices (returns void, not promise)
    try {
        spotWS.connect();
    } catch (err) {
        logger.warn('Spot WS connect failed: ' + err.message);
    }

    // Initial market match
    runMatchCycle();

    // Price update interval (faster in autonomous short-session mode)
    botState.priceUpdateInterval = setInterval(updatePrices, PRICE_UPDATE_INTERVAL_MS);

    // Market re-match interval (faster in autonomous short-session mode)
    botState.matchInterval = setInterval(runMatchCycle, MATCH_INTERVAL_MS);

    botState.cleanupInterval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);

    // Live order status polling every 30 seconds (live/sandbox mode only)
    if (geminiMode === 'live' || geminiMode === 'sandbox') {
        botState.orderPollInterval = setInterval(async () => {
            try {
                await tradingEngine.pollLiveOrderStatus();
            } catch (e) {
                logger.debug('Order poll error: ' + e.message);
            }
        }, 30000);
    }

    logger.info(
        `Prediction Market Bot STARTED (${geminiMode} mode, profile=${tradingEngine.tradingProfile}` +
        `${dataOnlyMode ? ', DATA ONLY — no trades' : ''}, warmup=${WARMUP_CYCLES} cycles, ` +
        `autonomous15m=${autonomous15mSession ? 'ON' : 'OFF'}, ` +
        `sessionStartLivePnl=${tradingEngine.sessionStartLiveDailyPnl ?? 0})`
    );
}

/**
 * Pre-boot validation: check env vars, API connectivity, spot prices
 */
async function validateStartup() {
    const issues = [];
    const warnings = [];

    logger.info('=== STARTUP VALIDATION ===');
    logger.info(`Gemini mode: ${geminiMode.toUpperCase()} (set GEMINI_MODE in .env to change)`);
    if (dataOnlyMode) logger.info('DATA_ONLY mode: collecting price data, NO trades will be placed');
    if (isLiveOrSandboxMode()) {
        warnings.push('Live/sandbox mode requires explicit preflight before /api/bot/start (POST /api/bot/preflight)');
    }

    // 1. Env var checks for live/sandbox mode
    if (geminiClient.mode === 'live') {
        if (!process.env.GEMINI_API_KEY) issues.push('GEMINI_API_KEY not set (required for live mode)');
        if (!process.env.GEMINI_API_SECRET) issues.push('GEMINI_API_SECRET not set (required for live mode)');
    }
    if (geminiClient.mode === 'sandbox') {
        if (!process.env.SANDBOX_GEMINI_API_KEY) issues.push('SANDBOX_GEMINI_API_KEY not set (required for sandbox mode)');
        if (!process.env.SANDBOX_GEMINI_API_SECRET) issues.push('SANDBOX_GEMINI_API_SECRET not set (required for sandbox mode)');
    }

    // 2. Database + wallet check
    try {
        const wallet = db.getWallet();
        if (!wallet) {
            warnings.push('No wallet found — will be created on first trade');
        } else {
            logger.info(`Wallet: $${wallet.balance.toFixed(2)} (initial: $${wallet.initial_balance.toFixed(2)})`);
        }
    } catch (e) {
        issues.push('Database error: ' + e.message);
    }

    // 3. Polymarket connectivity
    try {
        await polyClient.refreshPrices();
        logger.info('Polymarket API: OK');
    } catch (e) {
        warnings.push('Polymarket unreachable: ' + e.message);
    }

    // 4. Kraken spot prices
    try {
        await fetchSpotPrices();
        if (spotPriceCache.BTC && spotPriceCache.BTC > 10000) {
            logger.info(`Spot prices: BTC=$${spotPriceCache.BTC.toLocaleString()}, ETH=$${spotPriceCache.ETH?.toLocaleString() || 'N/A'}, SOL=$${spotPriceCache.SOL?.toLocaleString() || 'N/A'}`);
        } else {
            warnings.push('BTC spot price missing or unreasonable');
        }
    } catch (e) {
        warnings.push('Kraken spot prices unreachable: ' + e.message);
    }

    // 5. Kalshi API (optional — bot works without it)
    if (process.env.KALSHI_API_KEY) {
        logger.info('Kalshi API key: SET (WS auth enabled)');
    } else {
        logger.info('Kalshi API key: NOT SET (REST polling only)');
    }

    // Report results
    for (const w of warnings) logger.warn(`STARTUP WARNING: ${w}`);
    for (const i of issues) logger.error(`STARTUP CRITICAL: ${i}`);

    logger.info(`=== VALIDATION COMPLETE: ${issues.length} critical, ${warnings.length} warnings ===`);

    return { issues, warnings, canStart: issues.length === 0 };
}

/**
 * Stop the trading bot
 * @param {string} [reason] - optional reason code persisted to botState.stopReason
 */
function stopBot(reason) {
    // Guard: never interrupt an in-progress cleanup (e.g. redundant stop calls).
    if (botState.cleanupStatus === 'in_progress') {
        logger.warn(`stopBot(${reason}) called while cleanup in progress — stopping trading only`);
    }

    botState.running = false;
    if (reason) botState.stopReason = reason;
    tradingEngine.isRunning = false;

    if (botState.priceUpdateInterval) clearInterval(botState.priceUpdateInterval);
    if (botState.matchInterval) clearInterval(botState.matchInterval);
    if (botState.cleanupInterval) clearInterval(botState.cleanupInterval);
    if (botState.orderPollInterval) clearInterval(botState.orderPollInterval);

    kalshiWS.disconnect();

    // Reset cleanup state so the harness/operator can trigger a fresh cleanup via
    // POST /api/bot/emergency-stop.  Do NOT reset if a cleanup is already running.
    if (botState.cleanupStatus !== 'in_progress') {
        botState.cleanupStatus = 'idle';
        botState.cleanupResult = null;
        botState.cleanupTs = null;
    }

    // NOTE: session-end cleanup (emergencyExitAll) is intentionally NOT fired here.
    // The harness always calls POST /api/bot/emergency-stop after detecting that the
    // bot has stopped, which runs a single awaited cleanup with proper state tracking.
    // Firing it here as well would race with the harness call and cause double-closes.

    logger.info('Prediction Market Bot STOPPED');
}

// ===== Start Server =====

const PORT = process.env.PREDICTION_PORT || 3003;

server.listen(PORT, async () => {
    logger.info(`Prediction Market Proxy running on port ${PORT}`);
    logger.info(`Dashboard: http://localhost:${PORT}`);
    logger.info(`WebSocket: ws://localhost:${PORT}/ws`);
    logger.info(`API: http://localhost:${PORT}/api/health`);

    // Run pre-boot validation
    const validation = await validateStartup();
    if (!validation.canStart) {
        logger.error('STARTUP BLOCKED: critical issues must be resolved before starting');
        return; // Server stays up (dashboard accessible) but bot doesn't start
    }

    // Auto-start bot unless explicitly disabled.
    const autoStart = String(process.env.BOT_AUTOSTART || 'true').toLowerCase() !== 'false';
    if (autoStart) {
        try {
            await startBot();
        } catch (e) {
            logger.warn(`Auto-start skipped: ${e.message}`);
        }
    } else {
        logger.warn('BOT_AUTOSTART=false — bot NOT started automatically');
    }
});

// Graceful shutdown — preserve positions for next session
process.on('SIGINT', async () => {
    logger.info('Shutting down (SIGINT) — preserving open positions for next session...');
    stopBot();
    try {
        const openTrades = db.getOpenTrades();
        if (openTrades.length > 0) {
            logger.info(`Shutdown: ${openTrades.length} positions remain open (will resume on next start)`);
            openTrades.forEach(t => logger.info(`  #${t.id} ${t.direction} ${t.gemini_market_id} entry=$${t.entry_price}`));
        }
    } catch (e) {
        logger.error(`Error during shutdown: ${e.message}`);
    }
    clearInterval(wsHeartbeatInterval);
    db.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Shutting down (SIGTERM) — preserving open positions for next session...');
    stopBot();
    try {
        const openTrades = db.getOpenTrades();
        if (openTrades.length > 0) {
            logger.info(`Shutdown: ${openTrades.length} positions remain open (will resume on next start)`);
            openTrades.forEach(t => logger.info(`  #${t.id} ${t.direction} ${t.gemini_market_id} entry=$${t.entry_price}`));
        }
    } catch (e) {
        logger.error(`Error during shutdown: ${e.message}`);
    }
    clearInterval(wsHeartbeatInterval);
    db.close();
    process.exit(0);
});

// Crash handlers — close positions on unhandled errors
process.on('uncaughtException', async (err) => {
    logger.error(`UNCAUGHT EXCEPTION: ${err.message}`);
    logger.error(err.stack);
    try {
        stopBot();
        const result = await emergencyExitAll();
        if (result.closed > 0) {
            logger.info(`Crash handler: closed ${result.closed} positions, P&L: $${result.totalPnl.toFixed(2)}`);
        }
        clearInterval(wsHeartbeatInterval);
        db.close();
    } catch (e) {
        logger.error(`Crash handler failed: ${e.message}`);
    }
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`UNHANDLED REJECTION: ${reason}`);
    // Don't exit for unhandled rejections — just log and continue
    // The circuit breaker will handle persistent API failures
});

module.exports = { app, server, startBot, stopBot, emergencyExitAll };
