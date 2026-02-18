// Kraken WebSocket Price Feed
// Drop-in replacement for HyperliquidPriceFeed

class KrakenPriceFeed {
    constructor() {
        this.ws = null;
        this.prices = new Map();
        this.priceHistory = new Map();
        this.callbacks = new Map();
        this.connected = false;
        this.subscriptions = new Set();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.lastRestPoll = 0;
        this.restPollInterval = 30000; // 30 seconds
        this.allPairs = [];
    }

    async connect() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket('wss://ws.kraken.com');
                this.ws.onopen = async () => {
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    // Dynamically load all valid, top crypto USD pairs from kraken-data/usd_pairs_top_filtered.json
                    let pairs = [];
                    try {
                        const resp = await fetch('kraken-data/usd_pairs_top_filtered.json');
                        const data = await resp.json();
                        pairs = data.map(p => p.wsname);
                        this.allPairs = pairs;
                    } catch (e) {
                        // Fallback to a few major pairs if file not found
                        pairs = ['XBT/USD', 'ETH/USD', 'SOL/USD', 'ADA/USD', 'USDT/USD', 'DOT/USD', 'LINK/USD'];
                        this.allPairs = pairs;
                    }
                    // Subscribe to all pairs using TRADE feed for more frequent updates
                    for (let i = 0; i < pairs.length; i += 25) {
                        const batch = pairs.slice(i, i + 25);
                        this.ws.send(JSON.stringify({ event: 'subscribe', pair: batch, subscription: { name: 'trade' } }));
                    }
                    // Start REST polling for fallback
                    this.startRestPolling();
                    resolve(true);
                };
                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (Array.isArray(data) && data[2] === 'trade' && data[1] && Array.isArray(data[1])) {
                            // Trade update: [channelID, [[price, volume, time, side, type, misc]], pair]
                            const pair = data[3];
                            const lastTrade = data[1][data[1].length - 1]; // Get latest trade
                            if (lastTrade && lastTrade[0]) {
                                const price = parseFloat(lastTrade[0]);
                                this.prices.set(pair, price);
                                if (this.onPriceUpdate) this.onPriceUpdate(pair, price);
                            }
                        }
                    } catch (e) {
                        console.warn('Kraken WS parse error:', e);
                    }
                };
                this.ws.onerror = (err) => {
                    this.connected = false;
                    reject(err);
                };
                this.ws.onclose = () => {
                    this.connected = false;
                };
            } catch (e) {
                reject(e);
            }
        });
    }

    getPrice(symbol) {
        // Map all possible symbol formats to Kraken pair
        // Accepts: BTCUSD, BTC/USD, XBTUSD, XBT/USD, etc.
        const normalized = symbol.replace(/[-_]/g, '').toUpperCase();
        for (const [krakenPair, price] of this.prices.entries()) {
            // Normalize Kraken pair (e.g. XBT/USD -> XBTUSD)
            const kNorm = krakenPair.replace(/[-_]/g, '').toUpperCase();
            if (normalized === kNorm) return price;
        }
        return this.prices.get(symbol) || null;
    }

    startRestPolling() {
        setInterval(async () => {
            if (!this.allPairs.length) return;
            try {
                const now = Date.now();
                if (now - this.lastRestPoll < this.restPollInterval) return;
                this.lastRestPoll = now;
                
                // Poll prices for all pairs via REST API
                const pairsStr = this.allPairs.join(',');
                const url = `https://api.kraken.com/0/public/Ticker?pair=${pairsStr}`;
                const resp = await fetch(url);
                const data = await resp.json();
                
                if (data.result) {
                    for (const [pair, ticker] of Object.entries(data.result)) {
                        const price = parseFloat(ticker.c[0]); // Last trade price
                        this.prices.set(pair, price);
                        // Only log if it's a new or changed price
                        if (!this.priceHistory.has(pair) || this.priceHistory.get(pair) !== price) {
                            this.priceHistory.set(pair, price);
                            this.onPriceUpdate(pair, price);
                        }
                    }
                }
            } catch (e) {
                console.warn('Kraken REST poll error:', e);
            }
        }, 5000); // Check every 5 seconds, but only poll every 30 seconds
    }

    getAllPrices() {
        return Object.fromEntries(this.prices);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = KrakenPriceFeed;
}
