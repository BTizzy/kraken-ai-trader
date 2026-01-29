// High-frequency price data collector for real-time technical analysis
// Replaces coarse OHLC candles with live price streams

const sqlite = require('better-sqlite3');
const path = require('path');
const EventEmitter = require('events');
let WebSocket;
try {
    WebSocket = require('ws');
} catch (e) {
    // ws may not be available in some test environments; handle gracefully
    WebSocket = null;
}

class PriceDataCollector extends EventEmitter {
    constructor(opts = {}) {
        super();
        const dbPath = opts.dbPath || path.join(__dirname, '..', 'data', 'price_history.db');
        this.fetchFn = opts.fetchFn || (global.fetch ? global.fetch.bind(global) : require('node-fetch'));
        this.failOnConsecutiveErrors = opts.failOnConsecutiveErrors !== undefined ? opts.failOnConsecutiveErrors : true;
        this.consecutiveErrorThreshold = opts.consecutiveErrorThreshold || parseInt(process.env.PRICE_COLLECTOR_CONSECUTIVE_ERROR_THRESHOLD) || 10;
    this.collectionInterval = opts.collectionInterval || 2000; // Collect every 2 seconds
    this.useWebSocket = opts.useWebSocket !== undefined ? opts.useWebSocket : true;
    this.wsUrl = opts.wsUrl || 'wss://futures.kraken.com/derivatives/ws/v1';
    this.wsSubscribeMessage = opts.wsSubscribeMessage || { event: 'subscribe', feed: 'ticker', product_ids: ['PI_XBTUSD','PI_ETHUSD','PI_ADAUSD','PI_LINKUSD','PI_LTCUSD'] };
    this.wsReconnectBackoff = opts.wsReconnectBackoff || { base: 1000, max: 60000 };
    this.lastWsConnectedTs = null;
    this.lastWsMessageTs = null;
    this.wsStatus = 'disconnected'; // connecting, connected, disconnected
    this.wsMessageCount = 0;
    this.perPairWsMessageCount = new Map(); // pair -> count
    this.perPairInsertLatency = new Map(); // pair -> { count, totalMs }
        console.log('=== PriceDataCollector constructor START ===');
        console.log('PriceDataCollector constructor called with dbPath:', dbPath);
        this.dbPath = dbPath;
        this.priceBuffers = new Map(); // pair -> {prices: [], timestamps: []}
        this.maxBufferSize = 1000; // Keep last 1000 prices per pair (about 30-50 minutes at 2s intervals)
    this.minCollectionInterval = opts.minCollectionInterval || 200; // Lower bound for tests
    this.maxBackoffMs = 60 * 1000; // 1 minute max backoff
    this.consecutiveErrors = new Map(); // pair -> count
    this.totalErrors = 0;
    this.lastSuccessfulSampleTs = null;
    this.lastError = null;
        this.isRunning = false;

        // Initialize database synchronously for now
        this.initDatabaseSync();
        // Don't start collection automatically to avoid hanging the server
        // this.startCollection();
        console.log('PriceDataCollector initialized successfully');
        console.log('=== PriceDataCollector constructor END ===');
    }

    initDatabaseSync() {
        console.log('Initializing price history database synchronously...');
        try {
            this.db = sqlite(this.dbPath);
            console.log('Database opened successfully');

            // Harden SQLite for durability and concurrency
            try {
                this.db.pragma('journal_mode = WAL');
                this.db.pragma('synchronous = FULL');
            } catch (e) {
                console.warn('Unable to set SQLite pragmas:', e.message || e);
            }

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

        // Start websocket first (if configured)
        if (this.useWebSocket && WebSocket) {
            this._startWebSocketLoop();
        } else if (this.useWebSocket && !WebSocket) {
            console.warn('WebSocket requested but ws package not available; falling back to REST polling');
        }

        // Start optional periodic metrics logging if enabled
        if (process.env.PRICE_COLLECTOR_METRICS === 'true') {
            this._startMetricsLoop();
        }
        // Use a robust loop with exponential backoff on repeated failures
        const collectPrices = async () => {
            if (!this.isRunning) return;

            try {
                await this.collectAllPrices();
                // Reset overall error state on success
                this.lastError = null;
            } catch (err) {
                this.totalErrors += 1;
                this.lastError = err && err.message ? err.message : String(err);
                console.error('Error collecting prices (overall):', err);
            }

            // Determine next delay: if we have many recent errors, back off
            const base = Math.max(this.collectionInterval, this.minCollectionInterval);
            const globalErrors = this.totalErrors;
            let delay = base;
            if (globalErrors > 0) {
                // Exponential backoff capped to maxBackoffMs
                delay = Math.min(this.maxBackoffMs, base * Math.pow(2, Math.min(globalErrors, 6)));
            }

            if (this.isRunning) {
                setTimeout(collectPrices, delay);
            }
        };

        // Start collection
        collectPrices();
    }

    _startMetricsLoop() {
        if (this._metricsLoopRunning) return;
        this._metricsLoopRunning = true;
        const emitMetrics = () => {
            try {
                const perPair = {};
                for (const [pair, buffer] of this.priceBuffers.entries()) {
                    const wsMsgs = this.perPairWsMessageCount.get(pair) || 0;
                    const stat = this.perPairInsertLatency.get(pair) || { count: 0, totalMs: 0 };
                    const avgMs = stat.count ? (stat.totalMs / stat.count) : 0;
                    perPair[pair] = { points: buffer.prices.length, ws_msgs: wsMsgs, avg_insert_latency_ms: avgMs };
                }
                console.log('Collector metrics:', { last_successful_sample_ts: this.lastSuccessfulSampleTs, per_pair: perPair });
            } catch (e) {
                console.error('Error emitting collector metrics:', e && e.message ? e.message : e);
            }
            if (this._metricsLoopRunning) setTimeout(emitMetrics, 30000);
        };
        emitMetrics();
    }

    async collectAllPrices() {
        const pairs = ['PI_XBTUSD', 'PI_ETHUSD', 'PI_ADAUSD', 'PI_LINKUSD', 'PI_LTCUSD'];

        for (const pair of pairs) {
            // If websocket is connected and recently received a message, prefer WS (skip REST fetch)
            const wsFreshThreshold = this.collectionInterval * 1.5;
            if (this.wsStatus === 'connected' && this.lastWsMessageTs && (Date.now() - this.lastWsMessageTs) < wsFreshThreshold) {
                // Skip REST fetch for this pair since WS is providing near-real-time data
                continue;
            }
            try {
                const tickerData = await this.fetchTicker(pair);
                if (tickerData) {
                    try {
                        await this.storePrice(tickerData);
                    } catch (err) {
                        // Database write failed for this pair - log and continue
                        console.error(`DB write failed for ${pair}:`, err);
                        this.totalErrors += 1;
                                const count = (this.consecutiveErrors.get(pair) || 0) + 1;
                                this.consecutiveErrors.set(pair, count);
                                if (this.failOnConsecutiveErrors && count >= this.consecutiveErrorThreshold) {
                                    const info = { pair, consecutive_errors: count };
                                    console.error('PriceDataCollector fatal: consecutive error threshold exceeded', info);
                                    this.emit('fatal', info);
                                    this.isRunning = false;
                                    return;
                                }
                        continue;
                    }

                    this.updateBuffer(pair, tickerData);
                    // success: reset consecutive error counter for this pair
                    this.consecutiveErrors.set(pair, 0);
                    this.lastSuccessfulSampleTs = Date.now();
                } else {
                    // Treat null ticker as a non-fatal failure
                    this.consecutiveErrors.set(pair, (this.consecutiveErrors.get(pair) || 0) + 1);
                    this.totalErrors += 1;
                            const count = this.consecutiveErrors.get(pair);
                            console.warn(`No ticker data for ${pair} (count=${count})`);
                            // If configured, emit fatal when consecutive errors exceed threshold
                            if (this.failOnConsecutiveErrors && count >= this.consecutiveErrorThreshold) {
                                const info = { pair, consecutive_errors: count };
                                console.error('PriceDataCollector fatal: consecutive error threshold exceeded', info);
                                this.emit('fatal', info);
                                // Stop running to avoid silent failures
                                this.isRunning = false;
                                return;
                            }
                }
                    } catch (err) {
                        console.error(`Failed to collect price for ${pair}:`, err);
                        this.totalErrors += 1;
                        const count = (this.consecutiveErrors.get(pair) || 0) + 1;
                        this.consecutiveErrors.set(pair, count);
                        if (this.failOnConsecutiveErrors && count >= this.consecutiveErrorThreshold) {
                            const info = { pair, consecutive_errors: count };
                            console.error('PriceDataCollector fatal: consecutive error threshold exceeded', info);
                            this.emit('fatal', info);
                            this.isRunning = false;
                            return;
                        }
                    }
        }
    }

    // WebSocket helpers
    _startWebSocketLoop() {
        if (this._wsLoopRunning) return;
        this._wsLoopRunning = true;
        this._attemptWsConnect();
    }

    _attemptWsConnect(attempt = 0) {
        if (!this.isRunning) {
            this.wsStatus = 'disconnected';
            return;
        }

        if (!WebSocket) {
            this.wsStatus = 'unsupported';
            return;
        }

        try {
            this.wsStatus = 'connecting';
            console.log('Attempting websocket connection to', this.wsUrl);
            this._ws = new WebSocket(this.wsUrl);

            this._ws.on('open', () => {
                this.wsStatus = 'connected';
                this.lastWsConnectedTs = Date.now();
                console.log('WebSocket connected');
                try {
                    this._ws.send(JSON.stringify(this.wsSubscribeMessage));
                    console.log('WebSocket subscribe message sent:', this.wsSubscribeMessage);
                } catch (e) {
                    console.warn('Failed to send subscribe message:', e && e.message ? e.message : e);
                }
            });

            this._ws.on('message', (data) => {
                this.lastWsMessageTs = Date.now();
                this.wsMessageCount += 1;
                this._handleWsMessage(data);
            });

            this._ws.on('error', (err) => {
                console.error('WebSocket error:', err && err.message ? err.message : err);
            });

            this._ws.on('close', (code, reason) => {
                this.wsStatus = 'disconnected';
                console.warn('WebSocket closed:', code, reason && reason.toString ? reason.toString() : reason);
                // schedule reconnect with backoff
                const base = this.wsReconnectBackoff.base || 1000;
                const max = this.wsReconnectBackoff.max || 60000;
                const delay = Math.min(max, base * Math.pow(2, Math.min(attempt, 10)));
                setTimeout(() => this._attemptWsConnect(attempt + 1), delay);
            });
        } catch (err) {
            console.error('Failed to establish WebSocket connection:', err);
            this.wsStatus = 'disconnected';
            const base = this.wsReconnectBackoff.base || 1000;
            const max = this.wsReconnectBackoff.max || 60000;
            const delay = Math.min(max, base * Math.pow(2, Math.min(attempt, 10)));
            setTimeout(() => this._attemptWsConnect(attempt + 1), delay);
        }
    }

    _handleWsMessage(data) {
        let parsed = null;
        try {
            parsed = JSON.parse(data.toString());
        } catch (e) {
            // Not JSON or binary data; ignore
            return;
        }

        // Kraken futures websocket has messages with feed: 'ticker' or similar; be permissive
        try {
            // Message may contain an array of tickers or a single ticker
            const maybeTickers = parsed.tickers || parsed.data || (Array.isArray(parsed) ? parsed : null);
            if (maybeTickers && Array.isArray(maybeTickers)) {
                    for (const t of maybeTickers) {
                        const ticker = this._normalizeTickerFromWs(t);
                        if (ticker) {
                            // increment per-pair ws message count
                            this.perPairWsMessageCount.set(ticker.pair, (this.perPairWsMessageCount.get(ticker.pair) || 0) + 1);

                            // store and buffer (measure latency via storePrice wrapper)
                            const start = Date.now();
                            this.storePrice(ticker).then(() => {
                                const ms = Date.now() - start;
                                const stat = this.perPairInsertLatency.get(ticker.pair) || { count: 0, totalMs: 0 };
                                stat.count += 1;
                                stat.totalMs += ms;
                                this.perPairInsertLatency.set(ticker.pair, stat);
                                if (ms > 200) console.warn(`Slow insert for ${ticker.pair}: ${ms}ms`);
                            }).catch(err => {
                                console.error('Failed to store WS price:', err && err.message ? err.message : err);
                            });

                            this.updateBuffer(ticker.pair, ticker);
                            // reset consecutive errors for pair
                            this.consecutiveErrors.set(ticker.pair, 0);
                            this.lastSuccessfulSampleTs = Date.now();
                        }
                    }
                return;
            }

            // If single ticker
            const ticker = this._normalizeTickerFromWs(parsed);
            if (ticker) {
                this.perPairWsMessageCount.set(ticker.pair, (this.perPairWsMessageCount.get(ticker.pair) || 0) + 1);
                const start = Date.now();
                this.storePrice(ticker).then(() => {
                    const ms = Date.now() - start;
                    const stat = this.perPairInsertLatency.get(ticker.pair) || { count: 0, totalMs: 0 };
                    stat.count += 1;
                    stat.totalMs += ms;
                    this.perPairInsertLatency.set(ticker.pair, stat);
                    if (ms > 200) console.warn(`Slow insert for ${ticker.pair}: ${ms}ms`);
                }).catch(err => {
                    console.error('Failed to store WS price:', err && err.message ? err.message : err);
                });
                this.updateBuffer(ticker.pair, ticker);
                this.consecutiveErrors.set(ticker.pair, 0);
                this.lastSuccessfulSampleTs = Date.now();
            }
        } catch (err) {
            console.error('Error handling WS message:', err);
        }
    }

    _normalizeTickerFromWs(msg) {
        // Try to extract common fields: symbol/pair, last/price, bid/ask, volume
        const pair = msg.symbol || msg.product_id || msg.product || msg.pair || msg.instrument || msg.symbol_pair;
        if (!pair) return null;

        // Kraken futures uses symbols like PI_XBTUSD; ensure we match our pairs
        const priceCandidates = [msg.price, msg.last, msg.markPrice, msg.indexPrice, msg.last_trade_price, msg.c];
        let price = null;
        for (const p of priceCandidates) {
            if (p !== undefined && p !== null) {
                const v = parseFloat(p);
                if (!isNaN(v) && v > 0) { price = v; break; }
            }
        }
        if (!price) return null;

        const bid = msg.bid !== undefined ? parseFloat(msg.bid) : (msg.best_bid !== undefined ? parseFloat(msg.best_bid) : null);
        const ask = msg.ask !== undefined ? parseFloat(msg.ask) : (msg.best_ask !== undefined ? parseFloat(msg.best_ask) : null);
        const volume = msg.volume !== undefined ? parseFloat(msg.volume) : (msg.volumeQuote !== undefined ? parseFloat(msg.volumeQuote) : 0);

        return {
            pair: pair,
            price: price,
            bid: isNaN(bid) ? null : bid,
            ask: isNaN(ask) ? null : ask,
            volume: isNaN(volume) ? 0 : volume,
            timestamp: Date.now()
        };
    }

    async fetchTicker(pair) {
        try {
            const response = await this.fetchFn(`https://futures.kraken.com/derivatives/api/v3/tickers?symbol=${pair}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();

            if (data.tickers && data.tickers.length > 0) {
                const ticker = data.tickers[0];
                
                // Use last price if available, otherwise fall back to markPrice or indexPrice
                let price = parseFloat(ticker.last);
                if (isNaN(price) || price <= 0) {
                    price = parseFloat(ticker.markPrice);
                }
                if (isNaN(price) || price <= 0) {
                    price = parseFloat(ticker.indexPrice);
                }
                
                const bid = parseFloat(ticker.bid);
                const ask = parseFloat(ticker.ask);
                const volume = parseFloat(ticker.volumeQuote || 0);

                // Validate that we have valid numeric values
                if (isNaN(price) || price <= 0) {
                    console.warn(`Invalid price data for ${pair}: last=${ticker.last}, markPrice=${ticker.markPrice}, indexPrice=${ticker.indexPrice}`);
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

    // Health/status report for monitoring
    status() {
        const perPair = {};
        for (const [pair, buffer] of this.priceBuffers.entries()) {
            perPair[pair] = {
                last_price: buffer.prices.length ? buffer.prices[buffer.prices.length - 1] : null,
                points: buffer.prices.length,
                consecutive_errors: this.consecutiveErrors.get(pair) || 0
            };
        }
        return {
            running: this.isRunning,
            last_successful_sample_ts: this.lastSuccessfulSampleTs,
            last_error: this.lastError,
            total_errors: this.totalErrors,
            per_pair: perPair,
            ws_status: this.wsStatus,
            last_ws_connected_ts: this.lastWsConnectedTs,
            last_ws_message_ts: this.lastWsMessageTs,
            ws_message_count: this.wsMessageCount || 0,
            per_pair_ws_messages: Array.from(this.perPairWsMessageCount.entries()).reduce((acc,[k,v])=>{acc[k]=v;return acc;},{}),
            per_pair_avg_insert_latency_ms: Array.from(this.perPairInsertLatency.entries()).reduce((acc,[k,v])=>{acc[k]= v.count ? (v.totalMs/v.count) : 0; return acc;},{})
        };
    }

    async storePrice(tickerData) {
        const sql = `
            INSERT INTO price_history (pair, price, timestamp, volume, bid, ask)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        // Reuse prepared statement for efficiency
        if (!this._insertStmt) {
            this._insertStmt = this.db.prepare(sql);
        }

        const maxRetries = 5;
        let attempt = 0;
        while (true) {
            try {
                const result = this._insertStmt.run(
                    tickerData.pair,
                    tickerData.price,
                    tickerData.timestamp,
                    tickerData.volume,
                    tickerData.bid,
                    tickerData.ask
                );
                return result.lastInsertRowid;
            } catch (err) {
                // Handle SQLITE_BUSY by retrying with backoff
                const isBusy = (err && (err.code === 'SQLITE_BUSY' || (err.message && err.message.indexOf('SQLITE_BUSY') !== -1)));
                if (isBusy && attempt < maxRetries) {
                    attempt += 1;
                    const delay = Math.min(500 * Math.pow(2, attempt), 5000);
                    console.warn(`DB busy on insert (attempt ${attempt}), retrying in ${delay}ms`);
                    await this._sleep(delay);
                    continue;
                }
                // Re-throw other errors or exhausted retries
                throw err;
            }
        }
    }

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
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
            return rows;
        } catch (err) {
            console.error('Error getting recent prices:', err);
            return [];
        }
    }

    getPriceVolatility(pair, minutes = 60) {
        console.log(`Calculating volatility for ${pair} over ${minutes} minutes`);
        
        // Get price data for the specified time period
        const cutoffTime = Date.now() - (minutes * 60 * 1000);
        const sql = `
            SELECT price FROM price_history 
            WHERE pair = ? AND timestamp > ?
            ORDER BY timestamp ASC
        `;
        
        try {
            const stmt = this.db.prepare(sql);
            const rows = stmt.all(pair, cutoffTime);
            
            if (rows.length < 2) {
                console.log(`Not enough data for ${pair} volatility calculation`);
                return 0.0;
            }
            
            // Calculate percentage changes
            const changes = [];
            for (let i = 1; i < rows.length; i++) {
                const change = (rows[i].price - rows[i-1].price) / rows[i-1].price;
                changes.push(change);
            }
            
            if (changes.length === 0) return 0.0;
            
            // Calculate standard deviation of changes
            const mean = changes.reduce((sum, change) => sum + change, 0) / changes.length;
            const variance = changes.reduce((sum, change) => sum + Math.pow(change - mean, 2), 0) / changes.length;
            const stdDev = Math.sqrt(variance);
            
            // Return as percentage
            const volatility = stdDev * 100;
            console.log(`Volatility for ${pair}: ${volatility.toFixed(4)}% (from ${changes.length} changes)`);
            return volatility;
            
        } catch (err) {
            console.error('Error calculating volatility:', err);
            return 0.0;
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

    get24HourStats(pair) {
        console.log('get24HourStats called for pair:', pair);
        const sql = `
            SELECT 
                MIN(price) as low24h,
                MAX(price) as high24h,
                (SELECT price FROM price_history WHERE pair = ? ORDER BY timestamp ASC LIMIT 1) as open24h,
                (SELECT price FROM price_history WHERE pair = ? ORDER BY timestamp DESC LIMIT 1) as last
            FROM price_history 
            WHERE pair = ?
        `;

        try {
            const stmt = this.db.prepare(sql);
            const row = stmt.get(pair, pair, pair);
            stmt.finalize();
            console.log('get24HourStats SQL result for', pair, ':', row);
            
            if (row && row.last) {
                const result = {
                    high24h: row.high24h || row.last,
                    low24h: row.low24h || row.last,
                    open24h: row.open24h || row.last,
                    last: row.last
                };
                console.log('get24HourStats returning:', result);
                return result;
            }
        } catch (err) {
            console.error('Error getting 24h stats:', err);
        }

        console.log('get24HourStats falling back to buffer for', pair);
        // Fallback to buffer data if database query fails
        const buffer = this.priceBuffers.get(pair);
        if (buffer && buffer.prices.length > 0) {
            const prices = buffer.prices;
            const last = prices[prices.length - 1];
            const result = {
                high24h: Math.max(...prices),
                low24h: Math.min(...prices),
                open24h: prices[0],
                last: last
            };
            console.log('get24HourStats buffer result:', result);
            return result;
        }

        console.log('get24HourStats returning null for', pair);
        return null;
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

        try {
            const stmt = this.db.prepare('DELETE FROM price_history WHERE timestamp < ?');
            const result = stmt.run(oneDayAgo);
            console.log(`Cleaned up ${result.changes} old price records`);
            return result.changes;
        } catch (err) {
            throw err;
        }
    }
}

module.exports = PriceDataCollector;