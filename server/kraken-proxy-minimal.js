// Minimal Kraken WebSocket/REST proxy for secure wallet and price feed
// Usage: KRAKEN_API_KEY=yourkey KRAKEN_API_SECRET=yoursecret node server/kraken-proxy.js

console.log('Server starting - loading kraken-proxy.js');

const express = require('express');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
require('dotenv').config();

console.log('All modules loaded, setting up app...');

const app = express();
const PORT = process.env.PORT || 3002;

console.log('App created, loading sqlite-utils...');

// SQLite utilities for bot status and trades
const { getRecentTrades, getBotStatus } = require('./sqlite-utils');

// High-frequency price data collector
let priceCollector;

console.log('About to call app.listen...');

app.listen(PORT, () => {
    console.log('=== APP.LISTEN CALLBACK STARTED ===');
    console.log(`Kraken proxy server running on port ${PORT}`);
    console.log('WebSocket server available at ws://localhost:3002');

    // Initialize high-frequency price data collector AFTER server starts
    console.log('About to initialize price data collector...');
    console.log('About to require price_data_collector...');
    try {
        const priceCollectorPath = path.join(__dirname, '..', 'lib', 'price_data_collector');
        console.log('Loading PriceDataCollector from:', priceCollectorPath);
        const PriceDataCollector = require(priceCollectorPath);
        console.log('Require successful, about to create instance...');
        priceCollector = new PriceDataCollector();
        console.log('Price data collector created successfully');
    } catch (error) {
        console.error('Failed to create price data collector:', error.message);
        console.error('Stack trace:', error.stack);
    }
    console.log('Finished initializing price data collector');
    console.log('=== APP.LISTEN CALLBACK ENDED ===');
});