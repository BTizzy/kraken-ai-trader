/**
 * Hyperliquid Trading Integration
 * Real-time prices, low fees, no CORS issues
 */

// Hyperliquid API endpoints
const HYPERLIQUID_WS = 'wss://api.hyperliquid.xyz/ws';
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz';

/**
 * Real-time price feed via WebSocket
 */
class HyperliquidPriceFeed {
    constructor() {
        this.ws = null;
        this.prices = new Map();
        this.priceHistory = new Map();
        this.callbacks = new Map();
        this.connected = false;
        this.subscriptions = new Set();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
    }

    /**
     * Connect to Hyperliquid WebSocket
     */
    async connect() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(HYPERLIQUID_WS);
                
                this.ws.onopen = async () => {
                    console.log('🔌 Connected to Hyperliquid WebSocket');
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    
                    // Subscribe to allMids for ALL symbols in real-time
                    this.ws.send(JSON.stringify({
                        method: 'subscribe',
                        subscription: { type: 'allMids' }
                    }));
                    
                    console.log('📊 Subscribed to ALL Hyperliquid markets via allMids');
                    resolve(true);
                };

                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        // Debug first few messages
                        if (!this._messageCount) this._messageCount = 0;
                        if (this._messageCount < 5) {
                            console.log(`📨 WebSocket message ${this._messageCount + 1}:`, JSON.stringify(data).substring(0, 200));
                            this._messageCount++;
                        }
                        this.handleMessage(data);
                    } catch (e) {
                        console.warn('Failed to parse message:', e);
                    }
                };

                this.ws.onerror = (error) => {
                    console.error('Hyperliquid WebSocket error:', error);
                };

                this.ws.onclose = () => {
                    console.log('Hyperliquid WebSocket closed');
                    this.connected = false;
                    this.attemptReconnect();
                };

                // Timeout after 10 seconds
                setTimeout(() => {
                    if (!this.connected) {
                        reject(new Error('WebSocket connection timeout'));
                    }
                }, 10000);

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Subscribe to specific symbol (optional - allMids covers all)
     */
    subscribeToSymbol(symbol) {
        if (!this.connected || !this.ws) return;
        
        this.subscriptions.add(symbol);
        this.ws.send(JSON.stringify({
            method: 'subscribe',
            subscription: { type: 'trades', coin: symbol }
        }));
        
        console.log(`📊 Subscribed to ${symbol} trades`);
    }

    /**
     * Handle incoming WebSocket messages
     */
    handleMessage(data) {
        // Handle connection confirmation
        if (typeof data === 'string' && data.includes('Websocket connection established')) {
            console.log('✅ WebSocket connection confirmed');
            return;
        }

        // Handle allMids updates (all prices at once)
        if (data.channel === 'allMids') {
            const mids = data.data?.mids || {};
            const symbolCount = Object.keys(mids).length;
            console.log(`📊 Received ${symbolCount} prices via allMids`);
            for (const [symbol, price] of Object.entries(mids)) {
                this.updatePrice(symbol, parseFloat(price));
            }
            return;
        }

        // Handle individual trade updates
        if (data.channel === 'trades' && data.data) {
            const trades = Array.isArray(data.data) ? data.data : [data.data];
            trades.forEach(trade => {
                if (trade.coin && trade.px) {
                    this.updatePrice(trade.coin, parseFloat(trade.px));
                }
            });
        }
    }

    /**
     * Update price and notify callbacks
     */
    updatePrice(symbol, price) {
        const now = Date.now();
        const oldPrice = this.prices.get(symbol);

        // Debug: Log BTC price updates
        if (symbol === 'BTC' && (!this._btcUpdateCount || this._btcUpdateCount < 5)) {
            if (!this._btcUpdateCount) this._btcUpdateCount = 0;
            console.log(`💰 BTC price update ${this._btcUpdateCount + 1}: ${oldPrice?.price} → ${price}`);
            this._btcUpdateCount++;
        }

        this.prices.set(symbol, {
            price: price,
            timestamp: now
        });

        // Store in history
        let history = this.priceHistory.get(symbol) || [];
        history.push({ price, timestamp: now });
        if (history.length > 100) {
            history = history.slice(-100);
        }
        this.priceHistory.set(symbol, history);

        // Notify callback
        const callback = this.callbacks.get(symbol);
        if (callback) {
            callback(price, {
                oldPrice: oldPrice?.price,
                change: oldPrice ? price - oldPrice.price : 0,
                changePercent: oldPrice ? ((price - oldPrice.price) / oldPrice.price) * 100 : 0,
                history: history
            });
        }
    }

    /**
     * Subscribe to price updates for a symbol
     */
    subscribe(symbol, callback) {
        this.callbacks.set(symbol, callback);
        
        // Return current price if available
        const current = this.prices.get(symbol);
        if (current) {
            callback(current.price, { oldPrice: null, change: 0, history: [] });
        }
    }

    /**
     * Get current price
     */
    getPrice(symbol) {
        const data = this.prices.get(symbol);
        return data ? data.price : null;
    }

    /**
     * Get all prices
     */
    getAllPrices() {
        const prices = {};
        this.prices.forEach((data, symbol) => {
            prices[symbol] = data.price;
        });
        return prices;
    }

    /**
     * Get price statistics
     */
    getPriceStats(symbol) {
        const current = this.prices.get(symbol);
        const history = this.priceHistory.get(symbol) || [];

        if (!current || history.length === 0) return null;

        const prices = history.map(h => h.price);
        const startPrice = history[0].price;

        // Calculate momentum
        let momentum = 0;
        for (let i = history.length - 1; i > Math.max(0, history.length - 5); i--) {
            if (prices[i] > prices[i - 1]) momentum++;
            else if (prices[i] < prices[i - 1]) momentum--;
        }

        return {
            current: current.price,
            start: startPrice,
            high: Math.max(...prices),
            low: Math.min(...prices),
            change: current.price - startPrice,
            changePercent: ((current.price - startPrice) / startPrice) * 100,
            momentum: momentum,
            volatility: this.calculateVolatility(prices),
            trend: current.price > startPrice ? 1 : -1
        };
    }

    /**
     * Calculate volatility
     */
    calculateVolatility(prices) {
        if (prices.length < 2) return 0;
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
        }
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
        return Math.sqrt(variance) * 100; // As percentage
    }

    /**
     * Attempt reconnection
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

        console.log(`Reconnecting to Hyperliquid in ${delay / 1000}s...`);

        setTimeout(() => {
            this.connect().catch(console.error);
        }, delay);
    }

    /**
     * Disconnect
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }
}

/**
 * Hyperliquid Trading API
 */
class HyperliquidTrading {
    constructor() {
        this.baseURL = HYPERLIQUID_API;
    }

    /**
     * Get market metadata
     */
    async getMarkets() {
        try {
            const response = await fetch(`${this.baseURL}/info`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'meta' })
            });
            
            if (!response.ok) throw new Error(`API error: ${response.status}`);
            
            const data = await response.json();
            return data.universe || [];
        } catch (error) {
            console.error('Error fetching markets:', error);
            throw error;
        }
    }

    /**
     * Get order book for a symbol
     */
    async getOrderBook(symbol) {
        try {
            const response = await fetch(`${this.baseURL}/info`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'l2Book', coin: symbol })
            });
            
            if (!response.ok) throw new Error(`API error: ${response.status}`);
            
            return await response.json();
        } catch (error) {
            console.error('Error fetching order book:', error);
            throw error;
        }
    }

    /**
     * Get user's open positions (requires wallet connection)
     */
    async getPositions(walletAddress) {
        try {
            const response = await fetch(`${this.baseURL}/info`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    type: 'clearinghouseState', 
                    user: walletAddress 
                })
            });
            
            if (!response.ok) throw new Error(`API error: ${response.status}`);
            
            return await response.json();
        } catch (error) {
            console.error('Error fetching positions:', error);
            throw error;
        }
    }

    /**
     * Calculate fees for a trade
     */
    calculateFees(tradeValue, isMaker = false) {
        // Hyperliquid fees: 0.01% maker, 0.035% taker
        const feeRate = isMaker ? 0.0001 : 0.00035;
        const tradingFee = tradeValue * feeRate;
        
        // No gas fees on Hyperliquid!
        return {
            tradingFee: tradingFee,
            gasFee: 0,
            total: tradingFee,
            percentage: feeRate * 100
        };
    }
}

/**
 * Fee Calculator for Hyperliquid
 */
class HyperliquidFeeCalculator {
    static MAKER_FEE = 0.0001;  // 0.01%
    static TAKER_FEE = 0.00035; // 0.035%

    /**
     * Calculate round-trip fees (entry + exit)
     */
    static calculateRoundTripFees(tradeValue, isMaker = false) {
        const feeRate = isMaker ? this.MAKER_FEE : this.TAKER_FEE;
        const entryFee = tradeValue * feeRate;
        const exitFee = tradeValue * feeRate;
        
        return {
            entry: entryFee,
            exit: exitFee,
            total: entryFee + exitFee,
            breakEvenMove: feeRate * 2 * 100 // Percentage move needed to break even
        };
    }

    /**
     * Calculate net P&L after fees
     */
    static calculateNetPnL(grossPnL, tradeValue, isMaker = false) {
        const fees = this.calculateRoundTripFees(tradeValue, isMaker);
        return grossPnL - fees.total;
    }

    /**
     * Check if trade is worth taking
     */
    static validateEntry(expectedProfitPercent, isMaker = false) {
        const feeRate = isMaker ? this.MAKER_FEE : this.TAKER_FEE;
        const roundTripFeePercent = feeRate * 2 * 100;
        const minProfitRequired = roundTripFeePercent * 2; // Need 2x fees to be worthwhile
        
        return {
            valid: expectedProfitPercent >= minProfitRequired,
            expectedProfit: expectedProfitPercent,
            minRequired: minProfitRequired,
            fees: roundTripFeePercent
        };
    }
}

/**
 * Simple Trading Strategy
 */
class TradingStrategy {
    constructor(priceFeed) {
        this.priceFeed = priceFeed;
        this.positions = new Map();
        this.tradeHistory = [];
        this.config = {
            takeProfitPercent: 0.5,  // 0.5% take profit
            stopLossPercent: 0.25,   // 0.25% stop loss
            maxPositionSize: 0.1,    // 10% of bankroll per trade
            cooldownMs: 30000        // 30 second cooldown between trades
        };
        this.lastTradeTime = 0;
    }

    /**
     * Analyze market for trading signals
     */
    analyzeMarket(symbol) {
        const stats = this.priceFeed.getPriceStats(symbol);
        if (!stats) return null;

        const signals = {
            symbol: symbol,
            price: stats.current,
            momentum: stats.momentum,
            volatility: stats.volatility,
            trend: stats.trend,
            signal: 'HOLD',
            confidence: 50
        };

        // Simple momentum strategy
        if (stats.momentum >= 3 && stats.volatility < 2) {
            signals.signal = 'BUY';
            signals.confidence = 60 + (stats.momentum * 5);
        } else if (stats.momentum <= -3 && stats.volatility < 2) {
            signals.signal = 'SELL';
            signals.confidence = 60 + (Math.abs(stats.momentum) * 5);
        }

        // Mean reversion signal
        if (stats.changePercent < -1 && stats.volatility < 1.5) {
            signals.signal = 'BUY';
            signals.confidence = 65;
            signals.reason = 'Mean reversion - oversold';
        } else if (stats.changePercent > 1 && stats.volatility < 1.5) {
            signals.signal = 'SELL';
            signals.confidence = 65;
            signals.reason = 'Mean reversion - overbought';
        }

        return signals;
    }

    /**
     * Get trading opportunities across all markets
     */
    getOpportunities() {
        const opportunities = [];
        const prices = this.priceFeed.getAllPrices();

        for (const symbol of Object.keys(prices)) {
            const analysis = this.analyzeMarket(symbol);
            if (analysis && analysis.signal !== 'HOLD' && analysis.confidence >= 60) {
                opportunities.push(analysis);
            }
        }

        // Sort by confidence
        return opportunities.sort((a, b) => b.confidence - a.confidence);
    }
}

/**
 * REST-based Price Feed (CORS-safe fallback)
 */
class HyperliquidRestPriceFeed {
    constructor() {
        this.prices = new Map();
        this.priceHistory = new Map();
        this.callbacks = new Map();
        this.connected = false;
        this.pollInterval = null;
    }

    /**
     * Connect via REST polling
     */
    async connect() {
        console.log('📡 Connecting to Hyperliquid REST API...');
        
        try {
            // Test connection
            await this.fetchPrices();
            this.connected = true;
            
            // Start polling every 1 second
            this.pollInterval = setInterval(() => this.fetchPrices(), 1000);
            
            console.log('✅ Connected to Hyperliquid REST API');
            return true;
        } catch (error) {
            console.error('Failed to connect to Hyperliquid:', error);
            throw error;
        }
    }

    /**
     * Fetch all prices via REST
     */
    async fetchPrices() {
        try {
            const response = await fetch('https://api.hyperliquid.xyz/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'allMids' })
            });

            if (!response.ok) throw new Error(`API error: ${response.status}`);

            const mids = await response.json();
            const now = Date.now();

            // Update all prices
            for (const [symbol, priceStr] of Object.entries(mids)) {
                // Filter to known symbols (skip internal indices)
                if (symbol.startsWith('@') || symbol.startsWith('0')) continue;
                
                const price = parseFloat(priceStr);
                if (isNaN(price) || price <= 0) continue;

                this.updatePrice(symbol, price, now);
            }

        } catch (error) {
            console.warn('Price fetch error:', error.message);
        }
    }

    /**
     * Update price and notify callbacks
     */
    updatePrice(symbol, price, timestamp) {
        const oldData = this.prices.get(symbol);
        
        this.prices.set(symbol, {
            price: price,
            timestamp: timestamp
        });

        // Store in history
        let history = this.priceHistory.get(symbol) || [];
        history.push({ price, timestamp });
        if (history.length > 100) {
            history = history.slice(-100);
        }
        this.priceHistory.set(symbol, history);

        // Notify callback
        const callback = this.callbacks.get(symbol);
        if (callback) {
            callback(price, {
                oldPrice: oldData?.price,
                change: oldData ? price - oldData.price : 0,
                changePercent: oldData ? ((price - oldData.price) / oldData.price) * 100 : 0,
                history: history
            });
        }
    }

    /**
     * Subscribe to price updates for a symbol
     */
    subscribe(symbol, callback) {
        this.callbacks.set(symbol, callback);
        const current = this.prices.get(symbol);
        if (current) {
            callback(current.price, { oldPrice: null, change: 0, history: [] });
        }
    }

    /**
     * Get current price
     */
    getPrice(symbol) {
        const data = this.prices.get(symbol);
        return data ? data.price : null;
    }

    /**
     * Get all prices
     */
    getAllPrices() {
        const prices = {};
        this.prices.forEach((data, symbol) => {
            prices[symbol] = data.price;
        });
        return prices;
    }

    /**
     * Get price statistics
     */
    getPriceStats(symbol) {
        const current = this.prices.get(symbol);
        const history = this.priceHistory.get(symbol) || [];

        if (!current || history.length === 0) return null;

        const prices = history.map(h => h.price);
        const startPrice = history[0].price;

        // Calculate momentum (last 5 moves)
        let momentum = 0;
        for (let i = history.length - 1; i > Math.max(0, history.length - 5); i--) {
            if (prices[i] > prices[i - 1]) momentum++;
            else if (prices[i] < prices[i - 1]) momentum--;
        }

        return {
            current: current.price,
            start: startPrice,
            high: Math.max(...prices),
            low: Math.min(...prices),
            change: current.price - startPrice,
            changePercent: ((current.price - startPrice) / startPrice) * 100,
            momentum: momentum,
            volatility: this.calculateVolatility(prices),
            trend: current.price > startPrice ? 1 : -1
        };
    }

    /**
     * Calculate volatility
     */
    calculateVolatility(prices) {
        if (prices.length < 2) return 0;
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
        }
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
        return Math.sqrt(variance) * 100;
    }

    /**
     * Disconnect
     */
    disconnect() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.connected = false;
    }
}

// Export for use - Use WebSocket for REAL-TIME updates
const hyperliquidPriceFeed = new HyperliquidPriceFeed();
const hyperliquidTrading = new HyperliquidTrading();
const hyperliquidFees = HyperliquidFeeCalculator;
const tradingStrategy = new TradingStrategy(hyperliquidPriceFeed);

// Auto-connect on load
console.log('🚀 Hyperliquid module loaded. Call hyperliquidPriceFeed.connect() to start.');
