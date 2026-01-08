// Minimal Kraken WebSocket/REST proxy for secure wallet and price feed
// Usage: KRAKEN_API_KEY=yourkey KRAKEN_API_SECRET=yoursecret node server/kraken-proxy.js

const express = require('express');
const fetch = require('node-fetch');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;

// REST endpoints
app.get('/public/assetpairs', async (req, res) => {
    const r = await fetch('https://api.kraken.com/0/public/AssetPairs');
    res.json(await r.json());
});

app.get('/public/depth', async (req, res) => {
    const pair = req.query.pair;
    const r = await fetch(`https://api.kraken.com/0/public/Depth?pair=${pair}`);
    res.json(await r.json());
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

app.listen(PORT, () => {
    console.log(`Kraken proxy listening on http://localhost:${PORT}`);
});
