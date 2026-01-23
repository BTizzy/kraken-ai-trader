// High-frequency price data collector for real-time technical analysis
// Replaces coarse OHLC candles with live price streams

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class PriceDataCollector {
    constructor(dbPath = path.join(__dirname, '..', 'data', 'price_history.db')) {
        console.log('=== PriceDataCollector constructor START ===');
        console.log('PriceDataCollector constructor called with dbPath:', dbPath);
        this.dbPath = dbPath;
        this.priceBuffers = new Map(); // pair -> {prices: [], timestamps: []}
        this.maxBufferSize = 1000; // Keep last 1000 prices per pair (about 30-50 minutes at 2s intervals)
        this.collectionInterval = 2000; // Collect every 2 seconds
        this.isRunning = false;

        // Initialize database synchronously for now
        this.initDatabaseSync();
        // Don't start collection automatically to avoid hanging the server
        this.startCollection();
        console.log('PriceDataCollector initialized successfully');
        console.log('=== PriceDataCollector constructor END ===');
    }

    initDatabaseSync() {
        console.log('Initializing price history database synchronously...');
        try {
            this.db = new sqlite3.Database(this.dbPath);
            console.log('Database opened successfully');

            // Create price history table
            const createTableSQL = `
                CREATE TABLE IF NOT EXISTS price_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    pair TEXT NOT NULL,
                    price REAL NOT NULL,
                    timestamp INTEGER NOT NULL,
                    volume REAL DEFAULT 0,
                    bid REAL,
                    ask REAL
                );

                CREATE INDEX IF NOT EXISTS idx_pair_timestamp ON price_history(pair, timestamp);
                CREATE INDEX IF NOT EXISTS idx_timestamp ON price_history(timestamp);
            `;

            this.db.exec(createTableSQL);
            console.log('Price history table created');

            this.loadRecentPricesSync();
            console.log('Price history database initialized successfully');
        } catch (err) {
            console.error('Failed to initialize price history database:', err);
            console.error('Stack trace:', err.stack);
            throw err;
        }
    }

    loadRecentPricesSync() {
        // Load last 1000 prices per pair to initialize buffers
        const pairs = ['PI_XBTUSD', 'PI_ETHUSD', 'PI_ADAUSD', 'PI_LINKUSD', 'PI_LTCUSD'];

        for (const pair of pairs) {
            try {
                const prices = this.getRecentPricesSync(pair, 1000);
                this.priceBuffers.set(pair, {
                    prices: prices.map(p => p.price),
                    timestamps: prices.map(p => p.timestamp),
                    volumes: prices.map(p => p.volume || 0),
                    bids: prices.map(p => p.bid || 0),
                    asks: prices.map(p => p.ask || 0)
                });
                console.log(`Loaded ${prices.length} recent prices for ${pair}`);
            } catch (err) {
                console.error(`Failed to load recent prices for ${pair}:`, err);
                // Initialize empty buffer
                this.priceBuffers.set(pair, {
                    prices: [],
                    timestamps: [],
                    volumes: [],
                    bids: [],
                    asks: []
                });
            }
        }
    }

    startCollection() {
        if (this.isRunning) return;
        this.isRunning = true;

        console.log('Starting high-frequency price collection...');

        const collectPrices = async () => {
            try {
                await this.collectAllPrices();
            } catch (err) {
                console.error('Error collecting prices:', err);
            }

            if (this.isRunning) {
                setTimeout(collectPrices, this.collectionInterval);
            }
        };

        // Start collection
        collectPrices();
    }

    async collectAllPrices() {
        const pairs = ['PI_XBTUSD', 'PI_ETHUSD', 'PI_ADAUSD', 'PI_LINKUSD', 'PI_LTCUSD'];

        for (const pair of pairs) {
            try {
                const tickerData = await this.fetchTicker(pair);
                if (tickerData) {
                    await this.storePrice(tickerData);
                    this.updateBuffer(pair, tickerData);
                }
            } catch (err) {
                console.error(`Failed to collect price for ${pair}:`, err);
            }
        }
    }

    async fetchTicker(pair) {
        try {
            const response = await fetch(`https://futures.kraken.com/derivatives/api/v3/tickers?symbol=${pair}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();

            if (data.tickers && data.tickers.length > 0) {
                const ticker = data.tickers[0];
                const price = parseFloat(ticker.last);
                const bid = parseFloat(ticker.bid);
                const ask = parseFloat(ticker.ask);
                const volume = parseFloat(ticker.volumeQuote || 0);

                // Validate that we have valid numeric values
                if (isNaN(price) || price <= 0) {
                    console.warn(`Invalid price data for ${pair}: last=${ticker.last}`);
                    return null;
                }

                return {
                    pair,
                    price,
                    bid: isNaN(bid) ? null : bid,
                    ask: isNaN(ask) ? null : ask,
                    volume: isNaN(volume) ? 0 : volume,
                    timestamp: Date.now()
                };
            }
        } catch (err) {
            console.error(`Failed to fetch ticker for ${pair}:`, err);
        }
        return null;
    }

    async storePrice(tickerData) {
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO price_history (pair, price, timestamp, volume, bid, ask)
                VALUES (?, ?, ?, ?, ?, ?)
            `;

            this.db.run(sql, [
                tickerData.pair,
                tickerData.price,
                tickerData.timestamp,
                tickerData.volume,
                tickerData.bid,
                tickerData.ask
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
        });
    }

    updateBuffer(pair, tickerData) {
        let buffer = this.priceBuffers.get(pair);
        if (!buffer) {
            buffer = {
                prices: [],
                timestamps: [],
                volumes: [],
                bids: [],
                asks: []
            };
            this.priceBuffers.set(pair, buffer);
        }

        // Ensure all buffer properties are arrays
        if (!Array.isArray(buffer.prices)) buffer.prices = [];
        if (!Array.isArray(buffer.timestamps)) buffer.timestamps = [];
        if (!Array.isArray(buffer.volumes)) buffer.volumes = [];
        if (!Array.isArray(buffer.bids)) buffer.bids = [];
        if (!Array.isArray(buffer.asks)) buffer.asks = [];

        // Add new data
        buffer.prices.push(tickerData.price);
        buffer.timestamps.push(tickerData.timestamp);
        buffer.volumes.push(tickerData.volume);
        buffer.bids.push(tickerData.bid);
        buffer.asks.push(tickerData.ask);

        // Maintain buffer size
        if (buffer.prices.length > this.maxBufferSize) {
            buffer.prices.shift();
            buffer.timestamps.shift();
            buffer.volumes.shift();
            buffer.bids.shift();
            buffer.asks.shift();
        }
    }

    getPriceData(pair, maxPoints = 100) {
        const buffer = this.priceBuffers.get(pair);
        if (!buffer || !Array.isArray(buffer.prices) || buffer.prices.length === 0) {
            return {
                prices: [],
                timestamps: [],
                volumes: [],
                bids: [],
                asks: []
            };
        }

        // Return last maxPoints data points
        const startIdx = Math.max(0, buffer.prices.length - maxPoints);

        return {
            prices: buffer.prices.slice(startIdx),
            timestamps: buffer.timestamps.slice(startIdx),
            volumes: buffer.volumes.slice(startIdx),
            bids: buffer.bids.slice(startIdx),
            asks: buffer.asks.slice(startIdx)
        };
    }

    getRecentPricesSync(pair, limit = 100) {
        const sql = `
            SELECT price, timestamp, volume, bid, ask
            FROM price_history
            WHERE pair = ?
            ORDER BY timestamp DESC
            LIMIT ?
        `;

        try {
            const stmt = this.db.prepare(sql);
            const rows = stmt.all(pair, limit);
            stmt.finalize();
            // rows is already an array, no need to reverse for DESC order
            return rows;
        } catch (err) {
            console.error('Error getting recent prices:', err);
            return [];
        }
    }

    getLatestPrice(pair) {
        const buffer = this.priceBuffers.get(pair);
        if (!buffer || buffer.prices.length === 0) {
            return null;
        }

        const latestIdx = buffer.prices.length - 1;
        return {
            price: buffer.prices[latestIdx],
            timestamp: buffer.timestamps[latestIdx],
            bid: buffer.bids[latestIdx],
            ask: buffer.asks[latestIdx],
            volume: buffer.volumes[latestIdx]
        };
    }

    stop() {
        this.isRunning = false;
        if (this.db) {
            this.db.close();
        }
    }

    // Cleanup old data (keep last 24 hours)
    async cleanupOldData() {
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);

        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM price_history WHERE timestamp < ?', [oneDayAgo], function(err) {
                if (err) {
                    reject(err);
                } else {
                    console.log(`Cleaned up ${this.changes} old price records`);
                    resolve(this.changes);
                }
            });
        });
    }
}

module.exports = PriceDataCollector;