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
const OddsApiClient = require('../lib/odds_api_client');
const MetaculusClient = require('../lib/metaculus_client');
const RateLimiter = require('./rate-limiter');
const Alerts = require('../lib/alerts');
const KalshiWS = require('../lib/kalshi_ws');
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
        const wallet = db.getWallet();
        if (!wallet) return false;
        const balance = wallet.balance || wallet.total || 500;

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

// ===== Emergency Exit All Positions =====

function emergencyExitAll() {
    const openTrades = db.getOpenTrades();
    if (openTrades.length === 0) return { closed: 0, totalPnl: 0, exits: [] };

    const exits = [];
    let totalPnl = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const trade of openTrades) {
        try {
            const exitPrice = geminiClient.getPaperExitPrice(trade.gemini_market_id, trade.direction);
            if (exitPrice === null) continue;

            const entryFee = trade.position_size * (tradingEngine.params?.fee_per_side || 0.0001);
            const exitValue = trade.direction === 'YES'
                ? (exitPrice - trade.entry_price) * trade.position_size / trade.entry_price
                : (trade.entry_price - exitPrice) * trade.position_size / (1 - trade.entry_price);
            const exitFee = Math.abs(exitValue + trade.position_size) * (tradingEngine.params?.fee_per_side || 0.0001);
            const pnl = exitValue - entryFee - exitFee;

            db.closeTrade(trade.id, exitPrice, pnl, now - trade.timestamp, 'emergency_stop');

            totalPnl += pnl;
            exits.push({
                tradeId: trade.id,
                market: trade.market_title || trade.gemini_market_id,
                direction: trade.direction,
                exitPrice,
                pnl,
                holdTime: now - trade.timestamp
            });

            logger.warn(`EMERGENCY EXIT: ${trade.direction} "${trade.market_title}" @ ${exitPrice.toFixed(3)} P&L: $${pnl.toFixed(2)}`);
        } catch (e) {
            logger.error(`Failed to emergency exit trade ${trade.id}: ${e.message}`);
        }
    }

    // Update wallet
    if (totalPnl !== 0) {
        try {
            const wallet = db.getWallet();
            if (wallet) {
                db.updateWallet(wallet.balance + totalPnl);
            }
        } catch (e) {
            logger.error(`Failed to update wallet after emergency exit: ${e.message}`);
        }
    }

    logger.warn(`EMERGENCY EXIT COMPLETE: ${exits.length} positions closed, total P&L: $${totalPnl.toFixed(2)}`);
    return { closed: exits.length, totalPnl, exits };
}

// ===== Initialize Components =====

const db = new PredictionDatabase();
const rateLimiter = new RateLimiter();

const polyClient = new PolymarketClient({ rateLimiter });
const kalshiClient = new KalshiClient({ rateLimiter });
const geminiMode = process.env.GEMINI_MODE || 'paper'; // 'paper' | 'live' | 'sandbox'
const geminiClient = new GeminiClient({
    mode: geminiMode,
    rateLimiter,
    categories: ['crypto', 'politics', 'sports', 'other'],
    useRealPrices: true,        // Use real Gemini Predictions API prices instead of simulation
    realisticPaper: true,       // Use actual bid/ask for paper fills (not synthetic mid)
    realFetchInterval: 10000,   // Full market refresh every 10s (metadata + prices)
    tickerFetchInterval: 2000,  // Batch ticker every 2s (lightweight price-only, matches cycle)
    cacheTTL: 2000,             // 2s cache TTL (was 3s)
    realCacheTTL: 2000,         // 2s real client cache TTL (was 10s)
    realApiInterval: 1000       // 1s min between Gemini requests (was 2s)
});

const matcher = new MarketMatcher(db);
const oddsClient = new OddsApiClient({ apiKey: process.env.ODDS_API_KEY });
const metaculusClient = new MetaculusClient();
const signalDetector = new SignalDetector(db, {
    feePerSide: 0.0001,
    minEdge: 0.03,
    highConfidenceEdge: 0.08,
    kalshiClient: kalshiClient
});
const tradingEngine = new PaperTradingEngine(db, geminiClient);
const alerts = new Alerts({ webhookUrl: process.env.DISCORD_WEBHOOK_URL });
const kalshiWS = new KalshiWS({ apiKey: process.env.KALSHI_API_KEY });

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

// Spot price state — fed to FairValueEngine for Black-Scholes pricing
let spotPriceCache = {};
let lastSpotFetch = 0;
const SPOT_REFRESH_INTERVAL = 15000; // 15s between Kraken spot requests

/**
 * Fetch live BTC/ETH/SOL spot prices from Kraken public API
 * Used by FairValueEngine for Black-Scholes binary option pricing
 */
async function fetchSpotPrices() {
    if (Date.now() - lastSpotFetch < SPOT_REFRESH_INTERVAL) return spotPriceCache;
    try {
        const resp = await fetch(
            'https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD,XETHZUSD,SOLUSD',
            { signal: AbortSignal.timeout(5000) }
        );
        if (!resp.ok) return spotPriceCache;
        const data = await resp.json();
        if (data.result) {
            for (const [key, val] of Object.entries(data.result)) {
                const price = parseFloat(val.c[0]);
                if (key.includes('XBT') || key.includes('BTC')) {
                    spotPriceCache.BTC = price;
                    signalDetector.recordSpotPrice('BTC', price);
                } else if (key.includes('ETH')) {
                    spotPriceCache.ETH = price;
                    signalDetector.recordSpotPrice('ETH', price);
                } else if (key.includes('SOL')) {
                    spotPriceCache.SOL = price;
                    signalDetector.recordSpotPrice('SOL', price);
                }
            }
            lastSpotFetch = Date.now();
            recordApiResult('kraken', true);
        }
    } catch (e) {
        logger.debug('Spot price fetch: ' + e.message);
        recordApiResult('kraken', false, e);
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
        peak_balance: peakBalance
    });
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

        res.json({ signals, count: signals.length, arbEvents, momentumAlerts });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get open trades
app.get('/api/trades/open', (req, res) => {
    try {
        const trades = db.getOpenTrades();
        res.json({ trades, count: trades.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get recent closed trades
app.get('/api/trades/recent', (req, res) => {
    try {
        const limit = parseInt(req.query.limit || 50);
        const trades = db.getRecentTrades(limit);
        res.json({ trades, count: trades.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get paper wallet status
app.get('/api/wallet', (req, res) => {
    try {
        const wallet = db.getWallet();
        res.json(wallet);
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

// Start/stop bot
app.post('/api/bot/start', (req, res) => {
    if (!botState.running) {
        startBot();
        res.json({ status: 'started' });
    } else {
        res.json({ status: 'already_running' });
    }
});

app.post('/api/bot/stop', (req, res) => {
    stopBot();
    res.json({ status: 'stopped' });
});

// Emergency stop: stops bot AND closes all positions
app.post('/api/bot/emergency-stop', (req, res) => {
    try {
        stopBot();
        const result = emergencyExitAll();

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
app.post('/api/bot/close-position/:tradeId', (req, res) => {
    try {
        const tradeId = parseInt(req.params.tradeId);
        const openTrades = db.getOpenTrades();
        const trade = openTrades.find(t => t.id === tradeId);

        if (!trade) {
            return res.status(404).json({ error: 'Trade not found or already closed' });
        }

        const exitPrice = geminiClient.getPaperExitPrice(trade.gemini_market_id, trade.direction);
        if (exitPrice === null) {
            return res.status(400).json({ error: 'Could not determine exit price' });
        }

        const now = Math.floor(Date.now() / 1000);
        const feeSide = tradingEngine.params?.fee_per_side || 0.0001;
        const entryFee = trade.position_size * feeSide;
        const exitValue = trade.direction === 'YES'
            ? (exitPrice - trade.entry_price) * trade.position_size / trade.entry_price
            : (trade.entry_price - exitPrice) * trade.position_size / (1 - trade.entry_price);
        const exitFee = Math.abs(exitValue + trade.position_size) * feeSide;
        const pnl = exitValue - entryFee - exitFee;

        db.closeTrade(tradeId, exitPrice, pnl, now - trade.timestamp, 'manual_close');

        // Update wallet
        const wallet = db.getWallet();
        if (wallet) {
            db.updateWallet(wallet.balance + pnl);
        }

        logger.info(`MANUAL CLOSE: ${trade.direction} "${trade.market_title}" @ ${exitPrice.toFixed(3)} P&L: $${pnl.toFixed(2)}`);
        res.json({
            success: true,
            tradeId,
            market: trade.market_title,
            direction: trade.direction,
            exitPrice,
            pnl,
            holdTime: now - trade.timestamp
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Bot status
app.get('/api/bot/status', (req, res) => {
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

    res.json({
        running: botState.running,
        mode: geminiClient.mode,
        uptime: botState.startTime ? Date.now() - botState.startTime : 0,
        cycle_count: botState.cycleCount,
        last_cycle_time: botState.lastCycleTime,
        last_match_time: botState.lastMatchTime,
        sharpe,
        circuit_breaker: {
            open: health.circuitOpen,
            consecutive_errors: health.consecutiveErrors,
            total_errors: health.totalErrors
        },
        ...tradingEngine.getStatus(),
        rate_limiter: rateLimiter.getStats(),
        signal_detector: signalDetector.getStats(),
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
let matchedMarketCache = [];
let cryptoMatchMeta = new Map(); // GEMI-* → { crypto_match, kalshi_synthetic_bid/ask/mid, ... }
let priceUpdateRunning = false;

const botState = {
    running: false,
    startTime: null,
    cycleCount: 0,
    lastCycleTime: 0,
    lastMatchTime: 0,
    lastPriceRefresh: 0,
    priceUpdateInterval: null,
    matchInterval: null,
    cleanupInterval: null
};

/**
 * Update prices for all matched markets
 */
async function updatePrices() {
    if (priceUpdateRunning) return; // Prevent overlapping cycles
    if (isCircuitOpen()) return;    // Circuit breaker active
    priceUpdateRunning = true;
    let cycleSuccess = true;
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
        if (!botState.lastPriceRefresh || Date.now() - botState.lastPriceRefresh > 30000) {
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

        // Fetch live spot prices for FairValueEngine (BTC, ETH, SOL)
        await fetchSpotPrices();

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
                    try {
                        kalshiPrices = await kalshiClient.getBestPrices(matched.kalshi_market_id);
                        recordApiResult('kalshi', true);
                    } catch (e) {
                        recordApiResult('kalshi', false, e);
                    }
                }

                if (polyPrices.bid !== null) pricesReceived++;
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
                    oddsApi: oddsApiProb != null ? { probability: oddsApiProb } : null
                });
            } catch (error) {
                logger.warn(`Market ${matched.gemini_market_id} update error: ${error.message}`);
                recordApiResult('gemini', false, error);
            }
        }

        // Run signal detection — DUAL STRATEGY
        // Strategy 1: Composite score (velocity + spread + consensus)
        latestSignals = signalDetector.processMarkets(marketStates);
        let actionable = latestSignals.filter(s => s.actionable);

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
                                `CROSS-PLATFORM ARB: ${marketId} edge=${arb.bestEdge?.toFixed(3)} ` +
                                `dir=${arb.direction} Gemini=${gemini.bid?.toFixed(3)}/${gemini.ask?.toFixed(3)} ` +
                                `KalshiFV=${kalshiAnalysis.kalshiFairValue?.toFixed(3)}`
                            );
                            // Send Discord arb alert (rate-limited per market)
                            const arbSignal = {
                                marketId,
                                title: state.matchedMarket?.event_title || '',
                                direction: arb.direction,
                                netEdge: arb.netProfit || arb.bestEdge,
                                gemini_bid: gemini.bid,
                                gemini_ask: gemini.ask,
                                score: Math.min(100, Math.round((arb.bestEdge || 0) * 1500)),
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
                                    score: Math.min(100, Math.round((arb.bestEdge || 0) * 1500)),
                                    direction: arbDirection,
                                    referencePrice: kalshiAnalysis.kalshiFairValue,
                                    gemini_bid: gemini.bid,
                                    gemini_ask: gemini.ask,
                                    gemini_ask_depth: gemini.ask_depth || null,
                                    edge: arb.bestEdge,
                                    netEdge: arb.netProfit || arb.bestEdge,
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
                `top=${topScore}, actionable=${actionable.length}` +
                (spotInfo ? ` | Spot: ${spotInfo}` : '') +
                refInfo
            );
        }

        // Run trading engine tick
        if (botState.running) {
            latestActionable = actionable; // capture for /api/signals
            const result = await tradingEngine.tick(actionable);
            signalDetector.loadParameters(); // sync minScore from DB after adaptive learning

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
        }

        // Broadcast price updates
        broadcastToClients({
            type: 'price_update',
            data: {
                signals: latestSignals.slice(0, 20),
                wallet: db.getWallet(),
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
function runCleanup() {
    try {
        const cutoff = Math.floor(Date.now() / 1000) - (7 * 86400); // 7 days
        db.cleanOldPrices(cutoff);
        signalDetector.cleanup();
        signalDetector.updateCategoryWinRates();

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
function startBot() {
    if (botState.running) return;

    botState.running = true;
    botState.startTime = Date.now();
    tradingEngine.isRunning = true;

    // Load adaptive parameters
    signalDetector.loadParameters();
    signalDetector.updateCategoryWinRates();

    // Connect Kalshi WebSocket for real-time bracket prices
    kalshiWS.connect().catch(err => logger.warn('Kalshi WS connect failed: ' + err.message));

    // Initial market match
    runMatchCycle();

    // Price update every 2 seconds
    botState.priceUpdateInterval = setInterval(updatePrices, 2000);

    // Market re-match every 5 minutes
    botState.matchInterval = setInterval(runMatchCycle, 300000);

    // Cleanup every hour
    botState.cleanupInterval = setInterval(runCleanup, 3600000);

    logger.info(`Prediction Market Bot STARTED (${geminiMode} mode)`);
}

/**
 * Pre-boot validation: check env vars, API connectivity, spot prices
 */
async function validateStartup() {
    const issues = [];
    const warnings = [];

    logger.info('=== STARTUP VALIDATION ===');
    logger.info(`Gemini mode: ${geminiMode.toUpperCase()} (set GEMINI_MODE in .env to change)`);

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
 */
function stopBot() {
    botState.running = false;
    tradingEngine.isRunning = false;

    if (botState.priceUpdateInterval) clearInterval(botState.priceUpdateInterval);
    if (botState.matchInterval) clearInterval(botState.matchInterval);
    if (botState.cleanupInterval) clearInterval(botState.cleanupInterval);

    kalshiWS.disconnect();

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

    // Auto-start bot
    startBot();
});

// Graceful shutdown — close positions before exiting
process.on('SIGINT', () => {
    logger.info('Shutting down (SIGINT)...');
    stopBot();
    const result = emergencyExitAll();
    if (result.closed > 0) {
        logger.info(`Shutdown: closed ${result.closed} positions, P&L: $${result.totalPnl.toFixed(2)}`);
    }
    clearInterval(wsHeartbeatInterval);
    db.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Shutting down (SIGTERM)...');
    stopBot();
    const result = emergencyExitAll();
    if (result.closed > 0) {
        logger.info(`Shutdown: closed ${result.closed} positions, P&L: $${result.totalPnl.toFixed(2)}`);
    }
    clearInterval(wsHeartbeatInterval);
    db.close();
    process.exit(0);
});

// Crash handlers — close positions on unhandled errors
process.on('uncaughtException', (err) => {
    logger.error(`UNCAUGHT EXCEPTION: ${err.message}`);
    logger.error(err.stack);
    try {
        stopBot();
        const result = emergencyExitAll();
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
