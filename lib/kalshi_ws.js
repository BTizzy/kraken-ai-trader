/**
 * Kalshi WebSocket Subscriber
 *
 * Real-time bracket price updates via Kalshi WebSocket.
 *
 * Endpoint: wss://api.elections.kalshi.com/trade-api/ws/v2
 * Auth:     RSA-PSS SHA256 signing (KALSHI-ACCESS-KEY, KALSHI-ACCESS-SIGNATURE, KALSHI-ACCESS-TIMESTAMP)
 *           Falls back to unauthenticated for public channels (ticker) if no private key
 * Channel:  ticker (public, no auth needed)
 *
 * Prices are in CENTS (0-100); divide by 100 → probability [0,1].
 *
 * Usage:
 *   const KalshiWS = require('./kalshi_ws');
 *   const ws = new KalshiWS({
 *       apiKey: process.env.KALSHI_API_KEY,
 *       privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH  // optional, for auth'd channels
 *   });
 *   ws.on('tick', ({ marketTicker, yesBid, yesAsk, lastPrice, volume }) => { ... });
 *   await ws.connect();
 *   ws.subscribe(['KXBTC-26FEB1712-B67000', 'KXBTC-26FEB1712-B67500']);
 */

const WebSocket = require('ws');
const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const { Logger } = require('./logger');

const KALSHI_WS_URL   = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const RECONNECT_DELAY = 5000;  // ms before reconnect attempt
const PING_INTERVAL   = 25000; // ms between keepalive pings
const MAX_RECONNECTS  = 10;

class KalshiWS extends EventEmitter {
    constructor(options = {}) {
        super();
        this.logger          = new Logger({ component: 'KALSHI-WS', level: options.logLevel || 'INFO' });
        this.apiKey          = options.apiKey || process.env.KALSHI_API_KEY || null;
        this.privateKey      = null; // loaded RSA private key
        this.ws              = null;
        this.connected       = false;
        this.authenticated   = false;
        this.reconnectCount  = 0;
        this.reconnectTimer  = null;
        this.pingTimer       = null;
        this.subscriptions   = new Set();   // market tickers to maintain after reconnect
        this.requestId       = 1;
        this.priceCache      = new Map();   // marketTicker -> { yesBid, yesAsk, lastPrice, volume, ts }
        this.stopped         = false;

        // Try to load RSA private key for authenticated connections
        // Supports: file path via KALSHI_PRIVATE_KEY_PATH, or PEM content via KALSHI_PRIVATE_KEY
        const keyPath = options.privateKeyPath || process.env.KALSHI_PRIVATE_KEY_PATH;
        const keyPem = options.privateKey || process.env.KALSHI_PRIVATE_KEY;
        if (keyPath) {
            try {
                const keyData = fs.readFileSync(keyPath, 'utf8');
                this.privateKey = crypto.createPrivateKey(keyData);
                this.logger.info('Loaded RSA private key from file for Kalshi auth');
            } catch (e) {
                this.logger.warn(`Could not load Kalshi private key from ${keyPath}: ${e.message}`);
            }
        } else if (keyPem) {
            try {
                // Support both raw PEM and escaped newlines from env vars
                const normalized = keyPem.replace(/\\n/g, '\n');
                this.privateKey = crypto.createPrivateKey(normalized);
                this.logger.info('Loaded RSA private key from env for Kalshi auth');
            } catch (e) {
                this.logger.warn(`Could not parse KALSHI_PRIVATE_KEY: ${e.message}`);
            }
        }
    }

    /**
     * Generate RSA-PSS SHA256 auth headers for the WS handshake.
     * Message: timestamp_ms + "GET" + "/trade-api/ws/v2"
     */
    _getAuthHeaders() {
        if (!this.apiKey || !this.privateKey) return {};

        const timestamp = String(Date.now());
        const message = timestamp + 'GET' + '/trade-api/ws/v2';

        try {
            const signature = crypto.sign('sha256', Buffer.from(message), {
                key: this.privateKey,
                padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
            });

            return {
                'KALSHI-ACCESS-KEY': this.apiKey,
                'KALSHI-ACCESS-TIMESTAMP': timestamp,
                'KALSHI-ACCESS-SIGNATURE': signature.toString('base64')
            };
        } catch (e) {
            this.logger.warn(`RSA signing failed: ${e.message}`);
            return {};
        }
    }

    // ── Connection ────────────────────────────────────────────────────────────

    async connect() {
        this.stopped = false;

        this.logger.info('Connecting to Kalshi WebSocket...');

        // Build headers: RSA-PSS auth if private key available, else unauthenticated (public channels only)
        const headers = this._getAuthHeaders();
        this.authenticated = Object.keys(headers).length > 0;

        if (this.authenticated) {
            this.logger.info('Using RSA-PSS authenticated connection');
        } else {
            this.logger.info('Using unauthenticated connection (public channels only)');
        }

        this.ws = new WebSocket(KALSHI_WS_URL, { headers });

        this.ws.on('open', () => {
            this.logger.info(`Kalshi WebSocket connected (${this.authenticated ? 'authenticated' : 'public'})`);
            this.connected     = true;
            this.reconnectCount = 0;

            // Re-subscribe to all tickers tracked before reconnect
            if (this.subscriptions.size > 0) {
                this._sendSubscribe([...this.subscriptions]);
            }

            // Start keepalive
            this._startPing();
        });

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                this._handleMessage(msg);
            } catch (e) {
                this.logger.debug(`WS parse error: ${e.message}`);
            }
        });

        this.ws.on('error', (err) => {
            // Log internally; do NOT re-emit — EventEmitter 'error' with no listener crashes Node
            this.logger.warn(`Kalshi WS error: ${err.message}`);
        });

        this.ws.on('close', (code, reason) => {
            this.connected = false;
            this._stopPing();
            this.logger.info(`Kalshi WS closed (code=${code})`);

            if (!this.stopped && this.reconnectCount < MAX_RECONNECTS) {
                this.reconnectCount++;
                const delay = RECONNECT_DELAY * Math.min(this.reconnectCount, 4);
                this.logger.info(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectCount}/${MAX_RECONNECTS})`);
                this.reconnectTimer = setTimeout(() => this.connect(), delay);
            } else if (!this.stopped) {
                this.logger.error('Kalshi WS max reconnects reached — giving up');
                this.emit('max_reconnects');
            }
        });
    }

    disconnect() {
        this.stopped = true;
        this._stopPing();
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) this.ws.close();
        this.connected = false;
        this.logger.info('Kalshi WS disconnected by user');
    }

    // ── Subscription ──────────────────────────────────────────────────────────

    /**
     * Subscribe to ticker for an array of market tickers.
     * Safe to call before connected — tickers are stored and replayed on open.
     */
    subscribe(marketTickers) {
        if (!Array.isArray(marketTickers) || marketTickers.length === 0) return;
        for (const t of marketTickers) this.subscriptions.add(t);

        if (this.connected) {
            this._sendSubscribe(marketTickers);
        }
    }

    /**
     * Unsubscribe from tickers.
     */
    unsubscribe(marketTickers) {
        if (!Array.isArray(marketTickers)) return;
        for (const t of marketTickers) this.subscriptions.delete(t);
        if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                id:     this.requestId++,
                cmd:    'unsubscribe',
                params: { channels: ['ticker'], market_tickers: marketTickers }
            }));
        }
    }

    _sendSubscribe(marketTickers) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            id:     this.requestId++,
            cmd:    'subscribe',
            params: { channels: ['ticker'], market_tickers: marketTickers }
        }));
        this.logger.debug(`Subscribed to ${marketTickers.length} Kalshi tickers`);
    }

    // ── Message Handling ──────────────────────────────────────────────────────

    _handleMessage(msg) {
        // Subscription ACK / errors
        if (msg.type === 'subscribed') {
            this.logger.debug(`Kalshi subscribed: ${JSON.stringify(msg.params?.market_tickers)}`);
            return;
        }
        if (msg.type === 'error') {
            this.logger.warn(`Kalshi WS error msg: ${msg.msg || JSON.stringify(msg)}`);
            return;
        }

        // ticker price update
        if (msg.type === 'ticker') {
            const tick = {
                marketTicker: msg.market_ticker,
                // Kalshi prices are in CENTS — convert to [0,1] probability
                yesBid:    msg.yes_bid   != null ? msg.yes_bid   / 100 : null,
                yesAsk:    msg.yes_ask   != null ? msg.yes_ask   / 100 : null,
                lastPrice: msg.last_price != null ? msg.last_price / 100 : null,
                volume:    msg.volume    ?? 0,
                openInterest: msg.open_interest ?? 0,
                ts: Date.now()
            };

            this.priceCache.set(tick.marketTicker, tick);
            this.emit('tick', tick);
        }
    }

    // ── Keepalive ─────────────────────────────────────────────────────────────

    _startPing() {
        this._stopPing();
        this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, PING_INTERVAL);
    }

    _stopPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    // ── Public Accessors ──────────────────────────────────────────────────────

    /**
     * Get the latest cached tick for a market ticker.
     * Returns null if no data available.
     */
    getLatestTick(marketTicker) {
        return this.priceCache.get(marketTicker) || null;
    }

    /**
     * Get bid/ask as { bid, ask, mid } scaled to [0,1] or null if no data.
     */
    getBestPrices(marketTicker) {
        const tick = this.priceCache.get(marketTicker);
        if (!tick) return null;
        return {
            bid:  tick.yesBid,
            ask:  tick.yesAsk,
            mid:  (tick.yesBid != null && tick.yesAsk != null)
                      ? (tick.yesBid + tick.yesAsk) / 2
                      : tick.lastPrice,
            last: tick.lastPrice,
            volume: tick.volume,
            ts:   tick.ts
        };
    }

    getStats() {
        return {
            connected:      this.connected,
            authenticated:  this.authenticated,
            reconnects:     this.reconnectCount,
            subscriptions:  this.subscriptions.size,
            cached_tickers: this.priceCache.size
        };
    }
}

module.exports = KalshiWS;
