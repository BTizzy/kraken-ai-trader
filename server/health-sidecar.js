#!/usr/bin/env node
// Simple sidecar HTTP health server that reads the price_history SQLite DB
// and reports last sample timestamps so monitoring can probe even if main
// Express app endpoints are unreliable.

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.HEALTH_SIDECAR_PORT || 3006;
const DB_PATH = path.join(__dirname, '..', 'data', 'price_history.db');

let db;
try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    console.log('Health sidecar opened DB at', DB_PATH);
} catch (err) {
    console.error('Health sidecar failed to open DB:', err && err.message);
}

app.get('/health/collector', (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: 'db not available' });
    const stmt = db.prepare('SELECT pair, MAX(timestamp) as last_ts, COUNT(*) as points FROM price_history GROUP BY pair');
        const rows = stmt.all();
        const now = Date.now();
        const pairs = {};
        for (const r of rows) {
            pairs[r.pair] = { last_ts: r.last_ts, age_ms: now - r.last_ts, points: r.points };
        }
        return res.json({ pid: process.pid, ts: now, pairs });
    } catch (err) {
        console.error('Error in /health/collector:', err && err.message);
        return res.status(500).json({ error: err.message });
    }
});

app.get('/_whoami', (req, res) => {
    res.json({ pid: process.pid, uptime_s: Math.floor(process.uptime()), ts: Date.now() });
});

app.listen(PORT, () => {
    console.log('Health sidecar listening on port', PORT);
});
