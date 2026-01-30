// Simple SQLite utility for querying trades and bot status
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.resolve(__dirname, '../data/trades.db');

function getRecentTrades(limit = 20) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, err => {
            if (err) return reject(err);
        });
        db.all('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?', [limit], (err, rows) => {
            db.close();
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function getBotStatus() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, err => {
            if (err) return reject(err);
        });
        db.get('SELECT COUNT(*) as tradeCount, SUM(pnl) as totalPnL, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winningTrades, SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losingTrades, MAX(pnl) as bestTrade, MIN(pnl) as worstTrade FROM trades', [], (err, row) => {
            db.close();
            if (err) return reject(err);
            resolve(row);
        });
    });
}

module.exports = { getRecentTrades, getBotStatus };
