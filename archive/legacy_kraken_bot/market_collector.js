// Live Market Data Collector for Kraken
// Collects ticker data and stores in SQLite for analysis

const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch').default || require('node-fetch');
const path = require('path');

// Database setup
const DB_PATH = path.resolve(__dirname, 'data/market_data.db');

// NEW: Shared market data cache for real-time access by learning engine
class MarketDataCache {
    constructor() {
        this.marketData = new Map(); // pair -> deque of data points
        this.latestData = new Map(); // pair -> latest data point
        this.MAX_POINTS = 2000;
    }

    updateData(pair, dataPoint) {
        // Update latest
        this.latestData.set(pair, dataPoint);

        // Add to historical
        if (!this.marketData.has(pair)) {
            this.marketData.set(pair, []);
        }
        const deque = this.marketData.get(pair);
        deque.push(dataPoint);
        if (deque.length > this.MAX_POINTS) {
            deque.shift(); // Remove oldest
        }
    }

    getLatestData(pair) {
        return this.latestData.get(pair) || null;
    }

    getRecentData(pair, minutes = 60) {
        const deque = this.marketData.get(pair);
        if (!deque) return [];

        const cutoffTime = Date.now() - (minutes * 60 * 1000);
        return deque.filter(point => point.timestamp > cutoffTime);
    }

    getActivePairs() {
        return Array.from(this.latestData.keys());
    }
}

// Global cache instance
const marketDataCache = new MarketDataCache();

function initDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, err => {
            if (err) return reject(err);

            // Create tables
            db.run(`
                CREATE TABLE IF NOT EXISTS ticker_data (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pair TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    ask REAL,
                    bid REAL,
                    last REAL,
                    volume REAL,
                    vwap REAL,
                    trades INTEGER,
                    low REAL,
                    high REAL,
                    open REAL
                )
            `, err => {
                if (err) return reject(err);

                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_ticker_pair_time ON ticker_data(pair, timestamp)
                `, err => {
                    if (err) return reject(err);
                    resolve(db);
                });
            });
        });
    });
}

async function fetchKrakenTicker(pairs) {
    try {
        // Use futures API for leverage trading - fetch one pair at a time
        const results = {};
        
        for (const pair of pairs) {
            // Convert our format (e.g., ETHUSD) to futures format (PI_ETHUSD)
            const futuresPair = `PI_${pair.replace('USD', '')}USD`;
            const url = `https://futures.kraken.com/derivatives/api/v3/tickers?symbol=${futuresPair}`;
            
            const response = await fetch(url);
            const data = await response.json();

            if (data.result === 'success' && data.tickers && data.tickers.length > 0) {
                // Store under our pair name format
                results[pair] = data.tickers[0];
            }
        }

        return results;
    } catch (error) {
        console.error('Error fetching futures ticker:', error);
        return null;
    }
}

async function collectMarketData(db, pairs) {
    const timestamp = Date.now();
    const tickerData = await fetchKrakenTicker(pairs);

    if (!tickerData) return;

    for (const [pair, data] of Object.entries(tickerData)) {
        // Futures API format - data is already in the correct structure
        const ask = parseFloat(data.ask);
        const bid = parseFloat(data.bid);
        const last = parseFloat(data.last);
        const volume = parseFloat(data.volumeQuote || data.volume || 0);
        const vwap = parseFloat(data.markPrice || last); // Use mark price as VWAP approximation
        const trades = 0; // Futures API doesn't provide trade count in ticker
        const low = parseFloat(data.low24h || last);
        const high = parseFloat(data.high24h || last);
        const open = parseFloat(data.open24h || last);

        db.run(`
            INSERT INTO ticker_data (pair, timestamp, ask, bid, last, volume, vwap, trades, low, high, open)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [pair, timestamp, ask, bid, last, volume, vwap, trades, low, high, open], function(err) {
            if (err) {
                console.error('Error inserting data:', err);
            }
        });
    }

    console.log(`Collected data for ${Object.keys(tickerData).length} pairs at ${new Date(timestamp).toISOString()}`);
    
    // Update shared cache for immediate access (no longer saving to JSON file)
    for (const [pair, data] of Object.entries(tickerData)) {
        const ask = parseFloat(data.ask);
        const bid = parseFloat(data.bid);
        const last = parseFloat(data.last);
        const volume = parseFloat(data.volumeQuote || data.volume || 0);
        const vwap = parseFloat(data.markPrice || last);
        
        // Update cache with real-time data
        marketDataCache.updateData(pair, {
            pair: pair,
            bid_price: bid,
            ask_price: ask,
            last_price: last,
            volume: volume,
            vwap: vwap,
            timestamp: timestamp,
            volatility_pct: 0.0, // Will be calculated by learning engine
            market_regime: 0     // Will be detected by learning engine
        });
    }
}

async function analyzeRecentData(db, pair, minutes = 60) {
    const cutoff = Date.now() - (minutes * 60 * 1000);

    return new Promise((resolve, reject) => {
        db.all(`
            SELECT * FROM ticker_data
            WHERE pair = ? AND timestamp > ?
            ORDER BY timestamp ASC
        `, [pair, cutoff], (err, rows) => {
            if (err) return reject(err);

            if (rows.length === 0) {
                console.log(`No data for ${pair} in last ${minutes} minutes`);
                resolve([]);
                return;
            }

            // Analyze price movements
            const first = rows[0];
            const last = rows[rows.length - 1];
            const priceChange = ((last.last - first.last) / first.last) * 100;
            const highLowRange = ((last.high - last.low) / last.low) * 100;

            console.log(`\n=== ${pair} Analysis (last ${minutes}min) ===`);
            console.log(`Data points: ${rows.length}`);
            console.log(`Price change: ${priceChange.toFixed(4)}%`);
            console.log(`High-Low range: ${highLowRange.toFixed(4)}%`);
            console.log(`Start price: ${first.last}`);
            console.log(`End price: ${last.last}`);
            console.log(`Max price: ${Math.max(...rows.map(r => r.high))}`);
            console.log(`Min price: ${Math.min(...rows.map(r => r.low))}`);

            // Check if 1.5% move is realistic
            const realisticMove = Math.abs(priceChange) >= 1.5;
            console.log(`1.5% move possible: ${realisticMove ? 'YES' : 'NO'}`);

            resolve(rows);
        });
    });
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    const db = await initDatabase();

    // Common USD perpetual futures pairs to monitor
    const pairs = [
        'XBTUSD', 'ETHUSD', 'LTCUSD', 'XRPUSD', 'SOLUSD',
        'DOGEUSD', 'LINKUSD', 'ADAUSD', 'DOTUSD', 'AVAXUSD'
    ];

    if (command === 'collect') {
        console.log('Starting market data collection...');
        // Collect data every 30 seconds for 10 minutes
        const interval = setInterval(() => collectMarketData(db, pairs), 30000);
        setTimeout(() => {
            clearInterval(interval);
            console.log('Collection complete');
            db.close();
        }, 10 * 60 * 1000); // 10 minutes

    } else if (command === 'analyze') {
        const pair = args[1] || 'ATOMUSD';
        await analyzeRecentData(db, pair);
        db.close();

    } else if (command === 'continuous') {
        console.log('Starting continuous collection (Ctrl+C to stop)...');
        setInterval(() => collectMarketData(db, pairs), 30000);

    } else {
        console.log('Usage:');
        console.log('  node market_collector.js collect    # Collect for 10 minutes');
        console.log('  node market_collector.js analyze [pair]  # Analyze recent data');
        console.log('  node market_collector.js continuous # Continuous collection');
        db.close();
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { initDatabase, fetchKrakenTicker, collectMarketData, analyzeRecentData };