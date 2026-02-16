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
const RateLimiter = require('./rate-limiter');
const { Logger } = require('../lib/logger');

const logger = new Logger({ component: 'SERVER', level: 'INFO' });

// ===== Initialize Components =====

const db = new PredictionDatabase();
const rateLimiter = new RateLimiter();

const polyClient = new PolymarketClient({ rateLimiter });
const kalshiClient = new KalshiClient({ rateLimiter });
const geminiClient = new GeminiClient({ mode: 'paper', rateLimiter });

const matcher = new MarketMatcher(db);
const signalDetector = new SignalDetector(db);
const tradingEngine = new PaperTradingEngine(db, geminiClient);

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
        status: 'ok',
        uptime: process.uptime(),
        bot_running: botState.running,
        timestamp: Date.now()
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

// Get current signals (opportunities)
app.get('/api/signals', (req, res) => {
    try {
        const minScore = parseFloat(req.query.min_score || 0);
        const signals = latestSignals.filter(s => s.score >= minScore);
        res.json({ signals, count: signals.length });
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

// Bot status
app.get('/api/bot/status', (req, res) => {
    res.json({
        running: botState.running,
        uptime: botState.startTime ? Date.now() - botState.startTime : 0,
        cycle_count: botState.cycleCount,
        last_cycle_time: botState.lastCycleTime,
        last_match_time: botState.lastMatchTime,
        ...tradingEngine.getStatus(),
        rate_limiter: rateLimiter.getStats(),
        signal_detector: signalDetector.getStats(),
        gemini: geminiClient.getStats(),
        polymarket: polyClient.getStats(),
        kalshi: kalshiClient.getStats()
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

// ===== Main Trading Bot Loop =====

let latestSignals = [];
let matchedMarketCache = [];

const botState = {
    running: false,
    startTime: null,
    cycleCount: 0,
    lastCycleTime: 0,
    lastMatchTime: 0,
    priceUpdateInterval: null,
    matchInterval: null,
    cleanupInterval: null
};

/**
 * Update prices for all matched markets
 */
async function updatePrices() {
    try {
        if (matchedMarketCache.length === 0) {
            matchedMarketCache = db.getMatchedMarkets(0.5);
        }

        const marketStates = [];

        for (const matched of matchedMarketCache) {
            try {
                // Fetch prices from each platform (in parallel where possible)
                const promises = [];

                // Polymarket
                if (matched.polymarket_market_id) {
                    promises.push(
                        polyClient.getBestPrices(matched.polymarket_market_id)
                            .catch(e => ({ bid: null, ask: null }))
                    );
                } else {
                    promises.push(Promise.resolve({ bid: null, ask: null }));
                }

                // Kalshi
                if (matched.kalshi_market_id) {
                    promises.push(
                        kalshiClient.getBestPrices(matched.kalshi_market_id)
                            .catch(e => ({ bid: null, ask: null }))
                    );
                } else {
                    promises.push(Promise.resolve({ bid: null, ask: null }));
                }

                const [polyPrices, kalshiPrices] = await Promise.all(promises);

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
                    }
                });
            } catch (error) {
                // Skip individual market errors
            }
        }

        // Run signal detection
        latestSignals = signalDetector.processMarkets(marketStates);
        const actionable = latestSignals.filter(s => s.actionable);

        // Run trading engine tick
        if (botState.running) {
            const result = tradingEngine.tick(actionable);

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
                timestamp: Date.now()
            }
        });

        botState.cycleCount++;
        botState.lastCycleTime = Date.now();

    } catch (error) {
        logger.error('Price update cycle error: ' + error.message);
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
        logger.info(`Match cycle complete: ${result.matched_count} markets matched`);

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

    // Initial market match
    runMatchCycle();

    // Price update every 2 seconds
    botState.priceUpdateInterval = setInterval(updatePrices, 2000);

    // Market re-match every 5 minutes
    botState.matchInterval = setInterval(runMatchCycle, 300000);

    // Cleanup every hour
    botState.cleanupInterval = setInterval(runCleanup, 3600000);

    logger.info('🚀 Prediction Market Bot STARTED (paper mode)');
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

    logger.info('⏹️ Prediction Market Bot STOPPED');
}

// ===== Start Server =====

const PORT = process.env.PREDICTION_PORT || 3003;

server.listen(PORT, () => {
    logger.info(`Prediction Market Proxy running on port ${PORT}`);
    logger.info(`Dashboard: http://localhost:${PORT}`);
    logger.info(`WebSocket: ws://localhost:${PORT}/ws`);
    logger.info(`API: http://localhost:${PORT}/api/health`);

    // Auto-start bot
    startBot();
});

// Graceful shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down...');
    stopBot();
    db.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    stopBot();
    db.close();
    process.exit(0);
});

module.exports = { app, server, startBot, stopBot };
