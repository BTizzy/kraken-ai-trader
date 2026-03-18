const WebSocket = require('ws');
const EventEmitter = require('events');

/**
 * Kraken Spot Price WebSocket Client
 * Real-time BTC/ETH/SOL/XRP/ZEC spot price updates via public WebSocket
 * Falls back to REST if connection fails
 */
class SpotWebSocket extends EventEmitter {
    constructor(logger = console) {
        super();
        this.logger = logger;
        this.ws = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 0; // unlimited
        this.baseBackoffMs = 1000;
        this.maxBackoffMs = 30000;
        this.subscribed = false;
        this.pingIntervalId = null;
        this.heartbeatTimeoutId = null;
    }

    /**
     * Connect to Kraken spot price feed and subscribe to ticker updates
     * @param {array} pairs - Kraken asset pairs (e.g., ['XBT/USD', 'ETH/USD', ...])
     */
    connect(pairs = ['XBT/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD', 'ZEC/USD']) {
        if (this.ws) return; // already connecting or connected

        const wsUrl = 'wss://ws.kraken.com/';

        this.logger.info(`[SPOT WS] Connecting to ${wsUrl}`);

        try {
            this.ws = new WebSocket(wsUrl, {
                handshakeTimeout: 10000
            });

            this.ws.on('open', () => {
                this.connected = true;
                this.reconnectAttempts = 0;
                this.logger.info('[SPOT WS] Connected, subscribing to ticker...');

                // Subscribe to ticker updates
                const subscription = {
                    event: 'subscribe',
                    pair: pairs,
                    subscription: {
                        name: 'ticker'
                    }
                };

                this.ws.send(JSON.stringify(subscription), (err) => {
                    if (err) {
                        this.logger.error(`[SPOT WS] Subscribe send failed: ${err.message}`);
                    }
                });

                // Set up ping/pong heartbeat (30s interval, 10s timeout per community websocket.md)
                this.setupHeartbeat();

                this.emit('connected');
            });

            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data);
                    this.handleMessage(msg);
                } catch (e) {
                    this.logger.debug(`[SPOT WS] Parse error: ${e.message}`);
                }
            });

            this.ws.on('error', (err) => {
                this.logger.error(`[SPOT WS] Error: ${err.message}`);
                this.emit('error', err);
            });

            this.ws.on('close', (code, reason) => {
                this.connected = false;
                this.subscribed = false;
                this.clearHeartbeat();
                this.logger.warn(`[SPOT WS] Closed: ${code} ${reason}`);

                // Reconnect with backoff
                this.scheduleReconnect(pairs);
                this.emit('disconnected');
            });

            // Pong handler for heartbeat
            this.ws.on('pong', () => {
                this.clearHeartbeatTimeout();
            });
        } catch (e) {
            this.logger.error(`[SPOT WS] Connection failed: ${e.message}`);
            this.scheduleReconnect(pairs);
        }
    }

    /**
     * Handle incoming WebSocket messages
     */
    handleMessage(msg) {
        // Subscription confirmation
        if (msg.event === 'subscriptionStatus') {
            if (msg.status === 'subscribed') {
                this.subscribed = true;
                this.logger.info(`[SPOT WS] Subscribed to ${msg.pair} ticker`);
            } else if (msg.status === 'unsubscribed') {
                this.logger.warn(`[SPOT WS] Unsubscribed from ${msg.pair}`);
            } else if (msg.status === 'error') {
                this.logger.error(`[SPOT WS] Subscription error: ${msg.errorMessage}`);
            }
            return;
        }

        // Ticker update: [channelID, {c: [price, lot_volume], ...}, "ticker", "XBT/USD"]
        if (Array.isArray(msg) && msg.length >= 4 && msg[2] === 'ticker') {
            const pair = msg[3];
            const tickerData = msg[1];

            if (tickerData && tickerData.c && Array.isArray(tickerData.c)) {
                const price = parseFloat(tickerData.c[0]);
                if (Number.isFinite(price) && price > 0) {
                    // Convert Kraken pair notation to asset name
                    const asset = this.pairToAsset(pair);
                    if (asset) {
                        this.logger.info(`[SPOT WS] Tick: ${asset}: $${price.toFixed(2)}`);
                        this.emit('tick', { asset, price, pair, timestamp: Date.now() });
                    }
                }
            }
        }
    }

    /**
     * Convert Kraken pair notation (e.g., "XBT/USD") to asset name
     */
    pairToAsset(pair) {
        if (!pair) return null;
        const asset = pair.split('/')[0];
        // Convert Kraken naming to standard
        if (asset === 'XBT') return 'BTC';
        return asset;
    }

    /**
     * Set up ping/pong heartbeat (30s ping, 10s pong timeout)
     */
    setupHeartbeat() {
        this.clearHeartbeat();
        this.pingIntervalId = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
                // Set a 10s timeout for pong response
                this.heartbeatTimeoutId = setTimeout(() => {
                    this.logger.warn('[SPOT WS] Heartbeat timeout, reconnecting...');
                    this.disconnect();
                    this.scheduleReconnect();
                }, 10000);
            }
        }, 30000);
    }

    /**
     * Clear heartbeat timers
     */
    clearHeartbeat() {
        if (this.pingIntervalId) clearInterval(this.pingIntervalId);
        this.clearHeartbeatTimeout();
    }

    /**
     * Clear pong timeout
     */
    clearHeartbeatTimeout() {
        if (this.heartbeatTimeoutId) clearTimeout(this.heartbeatTimeoutId);
    }

    /**
     * Schedule reconnection with exponential backoff + jitter
     * Per community/websocket.md: backoff_ms = min(BASE * (2 ** attempt), MAX) + jitter
     */
    scheduleReconnect(pairs) {
        if (this.ws) {
            try {
                this.ws.close();
            } catch (e) {
                // ignore
            }
            this.ws = null;
        }

        const backoff = Math.min(
            this.baseBackoffMs * Math.pow(2, this.reconnectAttempts),
            this.maxBackoffMs
        );
        const jitter = Math.random() * backoff * 0.1; // 10% jitter
        const delayMs = backoff + jitter;

        this.reconnectAttempts++;
        this.logger.info(`[SPOT WS] Reconnecting in ${Math.round(delayMs)}ms (attempt ${this.reconnectAttempts})`);

        setTimeout(() => {
            this.connect(pairs);
        }, delayMs);
    }

    /**
     * Disconnect from WebSocket
     */
    disconnect() {
        this.clearHeartbeat();
        if (this.ws) {
            try {
                this.ws.close();
            } catch (e) {
                // ignore
            }
            this.ws = null;
        }
        this.connected = false;
        this.subscribed = false;
    }

    /**
     * Check if connected and subscribed
     */
    isReady() {
        return this.connected && this.subscribed;
    }
}

module.exports = SpotWebSocket;
