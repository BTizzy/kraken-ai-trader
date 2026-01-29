// Minimal Kraken WebSocket/REST proxy for secure wallet and price feed
// Usage: KRAKEN_API_KEY=yourkey KRAKEN_API_SECRET=yoursecret node server/kraken-proxy.js

console.log('Server starting - loading kraken-proxy.js');
const express = require('express');
const https = require('https');
const path = require('path');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;

// SQLite utilities for bot status and trades
const { getRecentTrades, getBotStatus } = require('./sqlite-utils');

// REST endpoints
app.get('/public/assetpairs', async (req, res) => {
    try {
        const response = await fetch('https://futures.kraken.com/derivatives/api/v3/instruments');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error fetching asset pairs:', error);
        res.status(500).json({ error: 'Failed to fetch asset pairs', details: error.message });
    }
});

// Futures API endpoints
app.get('/derivatives/api/v3/instruments', async (req, res) => {
    try {
        const response = await fetch('https://futures.kraken.com/derivatives/api/v3/instruments');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error fetching instruments:', error);
        res.status(500).json({ error: 'Failed to fetch instruments', details: error.message });
    }
});

app.get('/derivatives/api/v3/tickers', async (req, res) => {
    console.log('Tickers endpoint called with symbol:', req.query.symbol);
    const symbol = req.query.symbol;
    try {
        let url = 'https://futures.kraken.com/derivatives/api/v3/tickers';
        if (symbol) {
            url += `?symbol=${symbol}`;
        }
        console.log('Fetching from:', url);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        console.log('Fetched data successfully');
        res.json(data);
    } catch (error) {
        console.error('Error fetching tickers:', error);
        res.status(500).json({ error: 'Failed to fetch tickers', details: error.message });
    }
});

app.get('/derivatives/api/v3/orderbook', async (req, res) => {
    const symbol = req.query.symbol;
    try {
        const response = await fetch(`https://futures.kraken.com/derivatives/api/v3/orderbook?symbol=${symbol}`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error fetching orderbook:', error);
        res.status(500).json({ error: 'Failed to fetch orderbook', details: error.message });
    }
});

app.get('/public/depth', async (req, res) => {
    const pair = req.query.pair;
    try {
        const response = await fetch(`https://futures.kraken.com/derivatives/api/v3/orderbook?symbol=${pair}`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error fetching depth:', error);
        res.status(500).json({ error: 'Failed to fetch depth', details: error.message });
    }
});

// Private balance endpoint (requires API keys)
app.get('/private/balance', async (req, res) => {
    // TODO: Implement Kraken private API signing
    res.status(501).json({ error: 'Not implemented. Add API key/secret logic.' });
});

// WebSocket proxy (for browser clients)
app.get('/ws', (req, res) => {
    res.send('WebSocket endpoint. Connect using wss://ws.kraken.com');
});

// Serve static files (HTML, CSS, JS) from root directory - AFTER API routes
console.log('Setting up static file serving from:', path.join(__dirname, '..'));
app.use(express.static(path.join(__dirname, '..')));
// app.use((req, res, next) => {
//     // Only serve static files if the request doesn't match API routes
//     if (req.path.startsWith('/derivatives/') || req.path.startsWith('/public/') || req.path === '/ws') {
//         return next();
//     }
//     express.static('.')(req, res, next);
// });

// GET /api/bot/status: Returns bot status and summary stats
app.get('/api/bot/status', async (req, res) => {
    try {
        const status = await getBotStatus();
        // Optionally, add more status info here (e.g., running state)
        res.json({ running: true, ...status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/bot/learning: Returns recent trades for dashboard
app.get('/api/bot/learning', async (req, res) => {
    try {
        const trades = await getRecentTrades(20);
        const status = await getBotStatus();
        // Use full stats from database
        let total_pnl = parseFloat(status.totalPnL) || 0;
        let total_trades = parseInt(status.tradeCount) || 0;
        let winning_trades = parseInt(status.winningTrades) || 0;
        let losing_trades = parseInt(status.losingTrades) || 0;
        let best_trade = parseFloat(status.bestTrade) || 0;
        let worst_trade = parseFloat(status.worstTrade) || 0;
        // Calculate exit types from recent trades
        let tp_exits = 0, sl_exits = 0, trailing_exits = 0, timeout_exits = 0;
        for (const t of trades) {
            const reason = (t.reason || t.exit_reason || '').toLowerCase();
            if (reason.includes('tp') || reason.includes('profit')) tp_exits++;
            else if (reason.includes('sl') || reason.includes('stop')) sl_exits++;
            else if (reason.includes('trail')) trailing_exits++;
            else timeout_exits++;
        }
        const win_rate = total_trades ? (winning_trades / total_trades) * 100 : 0;
        res.json({
            recent_trades: trades,
            total_pnl,
            total_trades,
            win_rate,
            winning_trades,
            losing_trades,
            best_trade,
            worst_trade,
            tp_exits,
            sl_exits,
            trailing_exits,
            timeout_exits,
            // Add more stats as needed
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});




// Start server
app.listen(PORT, () => {
    console.log(`Kraken proxy server running on port ${PORT}`);
    console.log(`WebSocket server available at ws://localhost:${PORT}`);
    
    // Initialize high-frequency price data collector AFTER server starts
    console.log("About to initialize price data collector...");
    try {
        const PriceDataCollector = require("../lib/price_data_collector");
        priceCollector = new PriceDataCollector();
        console.log("Price data collector created successfully");
    } catch (error) {
        console.error("Failed to create price data collector:", error.message);
    }
});

// OHLC endpoint for bot - uses high-frequency price data instead of Kraken candles
app.get("/api/ohlc/:pair", async (req, res) => {
    const pair = req.params.pair;
    const interval = parseInt(req.query.interval) || 15; // Default 15 minutes

    try {
        // Get high-frequency price data
        const priceData = priceCollector.getPriceData(pair, 200); // Get last 200 data points

        if (priceData.prices.length === 0) {
            return res.json({ result: {} });
        }

        // Convert high-frequency data to OHLC format
        const candles = generateOHLCFromPrices(priceData, interval);

        // Format response like Kraken API
        const result = {};
        result[pair] = candles;

        // Add "last" timestamp
        const lastTimestamp = Math.floor(Date.now() / 1000);
        result.last = lastTimestamp;

        res.json({ result });
    } catch (error) {
        console.error("Error generating OHLC data:", error);
        res.status(500).json({ error: "Failed to generate OHLC data", details: error.message });
    }
});

// High-frequency price data endpoint for bot
app.get("/api/prices/:pair", async (req, res) => {
    const pair = req.params.pair;
    const maxPoints = parseInt(req.query.limit) || 100;

    console.log(`Price data endpoint called for ${pair}, limit: ${maxPoints}`);

    try {
        const priceData = priceCollector.getPriceData(pair, maxPoints);
        console.log(`Returning ${priceData.prices.length} price points for ${pair}`);
        res.json(priceData);
    } catch (error) {
        console.error("Error fetching price data:", error);
        res.status(500).json({ error: "Failed to fetch price data", details: error.message });
    }
});

// Helper function to generate OHLC candles from high-frequency price data
function generateOHLCFromPrices(priceData, intervalMinutes) {
    const { prices, timestamps } = priceData;
    const intervalMs = intervalMinutes * 60 * 1000; // Convert to milliseconds
    const candles = [];

    if (prices.length === 0) return candles;

    // Group prices by time intervals
    const groupedPrices = new Map();

    for (let i = 0; i < prices.length; i++) {
        const timestamp = timestamps[i];
        const intervalStart = Math.floor(timestamp / intervalMs) * intervalMs;

        if (!groupedPrices.has(intervalStart)) {
            groupedPrices.set(intervalStart, []);
        }
        groupedPrices.get(intervalStart).push(prices[i]);
    }

    // Convert each group to OHLC candle
    for (const [intervalStart, intervalPrices] of groupedPrices) {
        if (intervalPrices.length > 0) {
            const open = intervalPrices[0];
            const close = intervalPrices[intervalPrices.length - 1];
            const high = Math.max(...intervalPrices);
            const low = Math.min(...intervalPrices);
            const volume = intervalPrices.length; // Use count as volume proxy

            // Format as Kraken OHLC: [timestamp, open, high, low, close, vwap, volume, count]
            const timestampSeconds = Math.floor(intervalStart / 1000);
            candles.push([
                timestampSeconds,
                open.toFixed(2),
                high.toFixed(2),
                low.toFixed(2),
                close.toFixed(2),
                close.toFixed(2), // VWAP approximation
                volume.toString(),
                intervalPrices.length.toString()
            ]);
        }
    }

    // Sort by timestamp
    candles.sort((a, b) => a[0] - b[0]);

    return candles;
}

