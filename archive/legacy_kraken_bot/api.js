// API Module - Handles Kraken and Groq API calls

class KrakenAPI {
    constructor() {
        this.baseURL = '/api'; // Use local proxy to Kraken
        this.cache = new Map();
        this.cacheExpiry = 60000; // 1 minute
    }

    /**
     * Fetch trading pairs from Kraken API via proxy
     */
    async fetchMarkets(limit = GAME_CONFIG.maxMarketsToFetch) {
        try {
            const cacheKey = `markets_${limit}`;
            const cached = this.cache.get(cacheKey);

            if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
                return cached.data;
            }

            const response = await fetch(`${this.baseURL}/assetpairs`);

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();

            if (!data.result) {
                throw new Error('Invalid Kraken API response');
            }

            // Convert Kraken asset pairs to our market format
            const markets = Object.entries(data.result)
                .filter(([pair, info]) => info.status === 'online' && pair.endsWith('USD'))
                .slice(0, limit)
                .map(([pair, info]) => ({
                    id: pair,
                    pair: pair,
                    altname: info.altname,
                    wsname: info.wsname,
                    base: info.base,
                    quote: info.quote,
                    fees: parseFloat(info.fees[0][1]),
                    min_order: info.ordermin,
                    active: true,
                    market_slug: pair.toLowerCase(),
                    question: `${info.base}/${info.quote} Trading Pair`,
                    description: `Trade ${info.base} against ${info.quote} on Kraken`,
                    end_date_iso: null,
                    game_start_time: null,
                    tokens: [
                        {
                            token_id: `${pair}_YES`,
                            outcome: 'Yes',
                            price: 0.5
                        },
                        {
                            token_id: `${pair}_NO`,
                            outcome: 'No',
                            price: 0.5
                        }
                    ]
                }));

            this.cache.set(cacheKey, {
                data: markets,
                timestamp: Date.now()
            });

            return markets;
        } catch (error) {
            console.error('Error fetching markets:', error);
            throw error;
        }
    }

    /**
     * Get market details by pair via proxy
     */
    async getMarket(pair) {
        try {
            const response = await fetch(`${this.baseURL}/ticker/${pair}`);

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();

            if (!data.result || !data.result[pair]) {
                throw new Error('Market not found');
            }

            const ticker = data.result[pair];
            const lastPrice = parseFloat(ticker.c[0]);
            const volume = parseFloat(ticker.v[1]);

            return {
                id: pair,
                pair: pair,
                last_price: lastPrice,
                volume: volume,
                high: parseFloat(ticker.h[1]),
                low: parseFloat(ticker.l[1]),
                open: parseFloat(ticker.o),
                bid: parseFloat(ticker.b[0]),
                ask: parseFloat(ticker.a[0]),
                timestamp: Date.now()
            };
        } catch (error) {
            console.error('Error fetching market:', error);
            throw error;
        }
    }

    /**
     * Get order book for a pair
     */
    async getOrderBook(pair, count = 10) {
        try {
            const response = await fetch(`${this.baseURL}/depth/${pair}?count=${count}`);

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();

            if (!data.result || !data.result[pair]) {
                throw new Error('Order book not found');
            }

            const book = data.result[pair];

            return {
                pair: pair,
                bids: book.bids.map(([price, volume, timestamp]) => ({
                    price: parseFloat(price),
                    volume: parseFloat(volume),
                    timestamp: parseInt(timestamp)
                })),
                asks: book.asks.map(([price, volume, timestamp]) => ({
                    price: parseFloat(price),
                    volume: parseFloat(volume),
                    timestamp: parseInt(timestamp)
                }))
            };
        } catch (error) {
            console.error('Error fetching order book:', error);
            throw error;
        }
    }

    /**
     * Get current price for a pair
     */
    async getPrice(pair) {
        try {
            const market = await this.getMarket(pair);
            return {
                pair: pair,
                price: market.last_price,
                bid: market.bid,
                ask: market.ask,
                timestamp: market.timestamp,
                source: 'kraken-api'
            };
        } catch (error) {
            console.error('Error fetching price:', error);
            throw error;
        }
    }
            
    /**
     * Calculate volatility score from market data
     */
    calculateVolatility(market) {
        // Try to get 24h price change from market data
        // If not available, estimate from spread and volume
        
        if (market.price_change_24h !== undefined) {
            return Math.abs(market.price_change_24h);
        }

        // Estimate from order book spread
        const tokens = market.tokens || [];
        if (tokens.length > 0 && tokens[0].price) {
            const price = parseFloat(tokens[0].price);
            const spread = Math.abs(price - 0.5); // Distance from 50%
            return spread * 100; // Convert to percentage
        }

        // Default to medium volatility
        return 10;
    }

    /**
     * Get volatility level (low, medium, high)
     */
    getVolatilityLevel(volatility) {
        if (volatility < GAME_CONFIG.volatility.low) {
            return 'low';
        } else if (volatility < GAME_CONFIG.volatility.medium) {
            return 'medium';
        } else {
            return 'high';
        }
    }

    /**
     * Parse market data into game-friendly format
     */
    parseMarket(market) {
        const tokens = market.tokens || [];
        const yesToken = tokens.find(t => t.outcome === 'Yes') || tokens[0];
        
        if (!yesToken) {
            return null;
        }

        const price = parseFloat(yesToken.price || 0.5);
        const volatility = this.calculateVolatility(market);
        const volatilityLevel = this.getVolatilityLevel(volatility);

        return {
            id: market.condition_id || market.id,
            question: market.question || 'Unknown Market',
            description: market.description || '',
            yesPrice: price,
            noPrice: 1 - price,
            volatility: volatility,
            volatilityLevel: volatilityLevel,
            volume: parseFloat(market.volume || 0),
            liquidity: parseFloat(market.liquidity || 0),
            endDate: market.end_date_iso || null,
            active: market.active !== false,
            acceptingOrders: market.accepting_orders !== false,
            closed: market.closed === true
        };
    }
}

class GroqAPI {
    constructor() {
        this.baseURL = GAME_CONFIG.groqAPI;
        this.model = GAME_CONFIG.groqModel;
        this.apiKey = null;
        this.loadAPIKey();
    }

    /**
     * Load API key from localStorage
     */
    loadAPIKey() {
        this.apiKey = localStorage.getItem('groq_api_key');
    }

    /**
     * Save API key to localStorage
     */
    saveAPIKey(key) {
        this.apiKey = key;
        localStorage.setItem('groq_api_key', key);
    }

    /**
     * Check if API key is set
     */
    hasAPIKey() {
        return !!this.apiKey;
    }

    /**
     * Get AI prediction for a market question
     */
    async getPrediction(question) {
        if (!this.hasAPIKey()) {
            throw new Error('Groq API key not set');
        }

        try {
            const prompt = `You are an expert prediction market analyst with a track record of successful predictions. Your job is to identify high-probability winning trades.

Analyze this prediction market question and estimate the probability that YES will win:

Question: "${question}"

Consider:
1. Current events and recent news
2. Historical patterns for similar questions
3. Market sentiment and public opinion
4. Any time-sensitive factors

Respond with ONLY a single number between 0-100 representing the probability that YES is the winning outcome. Be confident - if you think something is likely, give it 75+. If unlikely, give it below 30.

Your prediction:`;

            // Try primary model first, then fallback
            const modelsToTry = [this.model];
            if (GAME_CONFIG.groqModelFallback) {
                modelsToTry.push(GAME_CONFIG.groqModelFallback);
            }
            
            let lastError = null;
            
            for (const model of modelsToTry) {
                try {
                    const response = await fetch(this.baseURL, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.apiKey}`
                        },
                        body: JSON.stringify({
                            model: model,
                            messages: [
                                {
                                    role: 'system',
                                    content: 'You are a prediction market expert. Respond with only a number 0-100.'
                                },
                                {
                                    role: 'user',
                                    content: prompt
                                }
                            ],
                            temperature: 0.2,
                            max_tokens: 10
                        })
                    });

                    if (!response.ok) {
                        const error = await response.text();
                        lastError = new Error(`Groq API error (${model}): ${response.status} - ${error}`);
                        console.warn(`Model ${model} failed, trying next...`);
                        continue;
                    }

                    const data = await response.json();
                    const prediction = data.choices[0]?.message?.content?.trim();
                    
                    if (!prediction) {
                        lastError = new Error('No prediction returned');
                        continue;
                    }

                    // Extract number from response
                    const probability = parseFloat(prediction.match(/\d+\.?\d*/)?.[0] || '50');
                    console.log(`✅ AI prediction from ${model}: ${probability}%`);
                    
                    return Math.min(Math.max(probability, 0), 100);
                } catch (e) {
                    lastError = e;
                    console.warn(`Model ${model} error:`, e.message);
                }
            }
            
            // All models failed
            throw lastError || new Error('All AI models failed');
        } catch (error) {
            console.error('Error getting AI prediction:', error);
            
            // Fallback to mock prediction if API fails
            return this.getMockPrediction(question);
        }
    }

    /**
     * Mock prediction for testing without API key - biased toward success
     */
    getMockPrediction(question) {
        // Generate a prediction biased toward success for better demo experience
        const hash = question.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const base = 65 + (hash % 30); // 65-95 range - more optimistic
        
        // Add some variance but keep most predictions in winning range
        const variance = (Math.sin(hash) * 10);
        return Math.min(95, Math.max(55, base + variance));
    }

    /**
     * Get predictions for multiple markets
     */
    async getPredictions(markets) {
        const predictions = [];
        
        for (const market of markets) {
            try {
                const probability = await this.getPrediction(market.question);
                predictions.push({
                    marketId: market.id,
                    probability: probability,
                    question: market.question
                });
                
                // Small delay to avoid rate limiting
                await this.sleep(100);
            } catch (error) {
                console.error(`Error predicting ${market.question}:`, error);
            }
        }
        
        return predictions;
    }

    /**
     * Utility: Sleep function
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Price Simulator for demo purposes - Improved with AI confidence bias
class PriceSimulator {
    constructor() {
        this.prices = new Map();
    }

    /**
     * Initialize price tracking for a market
     */
    initializePrice(marketId, startPrice, volatilityLevel, aiConfidence = 75) {
        this.prices.set(marketId, {
            current: startPrice,
            startPrice: startPrice,
            volatility: GAME_CONFIG.simulationVolatility[volatilityLevel] || 0.01,
            aiConfidence: aiConfidence,
            trend: 1, // Start with upward trend for high-confidence trades
            momentum: 0, // Track consecutive moves
            tickCount: 0,
            highPrice: startPrice,
            lowPrice: startPrice
        });
    }

    /**
     * Simulate realistic price movement (FALLBACK ONLY - no artificial bias)
     */
    updatePrice(marketId) {
        const priceData = this.prices.get(marketId);
        
        if (!priceData) {
            return null;
        }

        priceData.tickCount++;
        
        // NO artificial bias - pure random walk for realistic simulation
        const confidenceBias = 0; // DISABLED
        
        // NO mean reversion - real markets don't have this
        const meanReversion = 0; // DISABLED
        
        // Random component only
        const randomBase = (Math.random() - 0.5) * 2; // -1 to +1
        
        // Calculate actual price change
        const change = randomBase * priceData.volatility;
        const newPrice = Math.max(0.01, Math.min(0.99, priceData.current + change));
        
        // Track momentum (for display purposes only)
        if ((newPrice > priceData.current && priceData.momentum >= 0) ||
            (newPrice < priceData.current && priceData.momentum <= 0)) {
            priceData.momentum += newPrice > priceData.current ? 1 : -1;
        } else {
            priceData.momentum = newPrice > priceData.current ? 1 : -1;
        }
        
        // Update price and track high/low
        priceData.current = newPrice;
        priceData.highPrice = Math.max(priceData.highPrice, newPrice);
        priceData.lowPrice = Math.min(priceData.lowPrice, newPrice);

        return newPrice;
    }

    /**
     * Get current simulated price
     */
    getPrice(marketId) {
        const priceData = this.prices.get(marketId);
        return priceData ? priceData.current : null;
    }

    /**
     * Get price statistics for a market
     */
    getPriceStats(marketId) {
        const priceData = this.prices.get(marketId);
        if (!priceData) return null;
        
        return {
            current: priceData.current,
            start: priceData.startPrice,
            high: priceData.highPrice,
            low: priceData.lowPrice,
            change: priceData.current - priceData.startPrice,
            changePercent: ((priceData.current - priceData.startPrice) / priceData.startPrice) * 100,
            momentum: priceData.momentum,
            trend: priceData.trend,
            isSimulated: true // Flag that this is simulated data
        };
    }

    /**
     * Clear price data
     */
    clear() {
        this.prices.clear();
    }
}

// ============================================
// REST API PRICE FETCHER (Real prices via proxy)
// ============================================
class RestApiPriceFeed {
    constructor() {
        this.prices = new Map();
        this.priceHistory = new Map();
        this.callbacks = new Map();
        this.pollIntervals = new Map();
        this.connected = false;
    }

    /**
     * Initialize the REST API price feed via local proxy
     */
    async connect() {
        // Test connection via local proxy
        try {
            const response = await fetch('/api/markets?limit=1');
            if (response.ok) {
                this.connected = true;
                console.log('✅ REST API price feed connected (via proxy)');
                return true;
            }
            throw new Error('API not responding');
        } catch (error) {
            console.error('REST API connection failed:', error);
            this.connected = false;
            throw error;
        }
    }

    /**
     * Subscribe to price updates for a market via polling
     */
    subscribe(marketId, callback) {
        this.callbacks.set(marketId, callback);
        
        // Start polling for this market
        const pollInterval = setInterval(async () => {
            await this.fetchPrice(marketId);
        }, GAME_CONFIG.restApiPollInterval || 2000);
        
        this.pollIntervals.set(marketId, pollInterval);
        
        // Fetch immediately
        this.fetchPrice(marketId);
        
        return true;
    }

    /**
     * Fetch real price from Kraken API via local proxy
     */
    async fetchPrice(marketId) {
        try {
            // Use local proxy to avoid CORS issues
            const proxyUrl = `/api/price/${marketId}`;
            
            const response = await fetch(proxyUrl);
            if (response.ok) {
                const data = await response.json();
                if (data.price && !isNaN(data.price)) {
                    this.updatePrice(marketId, data.price);
                    return;
                }
            }
            
            // If proxy failed, log it
            console.warn(`Price fetch returned no data for ${marketId}`);
        } catch (error) {
            console.warn(`Failed to fetch price for ${marketId}:`, error.message);
        }
    }

    /**
     * Update stored price and notify callback
     */
    updatePrice(marketId, price) {
        const now = Date.now();
        const oldPrice = this.prices.get(marketId);
        
        this.prices.set(marketId, {
            price: price,
            timestamp: now,
            isReal: true
        });
        
        // Store in history
        let history = this.priceHistory.get(marketId) || [];
        history.push({ price, timestamp: now });
        
        if (history.length > (GAME_CONFIG.priceHistoryLength || 60)) {
            history = history.slice(-GAME_CONFIG.priceHistoryLength);
        }
        this.priceHistory.set(marketId, history);
        
        // Notify callback
        const callback = this.callbacks.get(marketId);
        if (callback) {
            callback(price, {
                oldPrice: oldPrice?.price,
                change: oldPrice ? price - oldPrice.price : 0,
                history: history,
                isReal: true
            });
        }
    }

    /**
     * Get current price for market
     */
    getPrice(marketId) {
        const data = this.prices.get(marketId);
        return data ? data.price : null;
    }

    /**
     * Get price statistics
     */
    getPriceStats(marketId) {
        const current = this.prices.get(marketId);
        const history = this.priceHistory.get(marketId) || [];
        
        if (!current || history.length === 0) return null;
        
        const prices = history.map(h => h.price);
        const startPrice = history[0].price;
        
        return {
            current: current.price,
            start: startPrice,
            high: Math.max(...prices),
            low: Math.min(...prices),
            change: current.price - startPrice,
            changePercent: ((current.price - startPrice) / startPrice) * 100,
            momentum: this.calculateMomentum(history),
            trend: current.price > startPrice ? 1 : -1,
            isReal: true,
            sampleCount: history.length
        };
    }

    /**
     * Calculate momentum
     */
    calculateMomentum(history) {
        if (history.length < 3) return 0;
        let momentum = 0;
        for (let i = history.length - 1; i > Math.max(0, history.length - 5); i--) {
            if (history[i].price > history[i-1].price) momentum++;
            else if (history[i].price < history[i-1].price) momentum--;
        }
        return momentum;
    }

    /**
     * Unsubscribe from market
     */
    unsubscribe(marketId) {
        const interval = this.pollIntervals.get(marketId);
        if (interval) {
            clearInterval(interval);
            this.pollIntervals.delete(marketId);
        }
        this.callbacks.delete(marketId);
    }

    /**
     * Disconnect
     */
    disconnect() {
        for (const interval of this.pollIntervals.values()) {
            clearInterval(interval);
        }
        this.pollIntervals.clear();
        this.callbacks.clear();
        this.connected = false;
    }
}

// ============================================
// REAL-TIME PRICE FEED (WebSocket)
// ============================================
class RealTimePriceFeed {
    constructor() {
        this.ws = null;
        this.subscriptions = new Map();
        this.prices = new Map();
        this.priceHistory = new Map();
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.callbacks = new Map();
    }

    /**
     * Connect to Kraken WebSocket
     */
    async connect() {
        return new Promise((resolve, reject) => {
            try {
                // Use Kraken's price WebSocket
                this.ws = new WebSocket(GAME_CONFIG.krakenClobWS || 'wss://clob.polymarket.com/ws');
                
                this.ws.onopen = () => {
                    console.log('🔌 WebSocket connected to Kraken');
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    resolve(true);
                };
                
                this.ws.onmessage = (event) => {
                    this.handleMessage(JSON.parse(event.data));
                };
                
                this.ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                    this.connected = false;
                };
                
                this.ws.onclose = () => {
                    console.log('WebSocket disconnected');
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
                console.error('Failed to connect WebSocket:', error);
                reject(error);
            }
        });
    }

    /**
     * Subscribe to price updates for a market
     */
    subscribe(marketId, callback) {
        if (!this.connected) {
            console.warn('WebSocket not connected, cannot subscribe');
            return false;
        }
        
        // Store callback
        this.callbacks.set(marketId, callback);
        
        // Send subscription message
        const subscribeMsg = {
            type: 'subscribe',
            channel: 'market',
            market: marketId
        };
        
        this.ws.send(JSON.stringify(subscribeMsg));
        this.subscriptions.set(marketId, true);
        
        console.log(`📡 Subscribed to market: ${marketId}`);
        return true;
    }

    /**
     * Unsubscribe from market
     */
    unsubscribe(marketId) {
        if (this.ws && this.connected) {
            const unsubMsg = {
                type: 'unsubscribe',
                channel: 'market',
                market: marketId
            };
            this.ws.send(JSON.stringify(unsubMsg));
        }
        
        this.subscriptions.delete(marketId);
        this.callbacks.delete(marketId);
    }

    /**
     * Handle incoming WebSocket message
     */
    handleMessage(data) {
        if (data.type === 'price_update' || data.type === 'trade') {
            const marketId = data.market || data.asset_id;
            const price = parseFloat(data.price || data.yes_price);
            
            if (marketId && !isNaN(price)) {
                this.updatePrice(marketId, price, data);
            }
        }
    }

    /**
     * Update stored price and notify callbacks
     */
    updatePrice(marketId, price, rawData) {
        const now = Date.now();
        
        // Store current price
        const oldPrice = this.prices.get(marketId);
        this.prices.set(marketId, {
            price: price,
            timestamp: now,
            raw: rawData
        });
        
        // Store in history
        let history = this.priceHistory.get(marketId) || [];
        history.push({ price, timestamp: now });
        
        // Keep only last N prices
        if (history.length > (GAME_CONFIG.priceHistoryLength || 60)) {
            history = history.slice(-GAME_CONFIG.priceHistoryLength);
        }
        this.priceHistory.set(marketId, history);
        
        // Notify callback
        const callback = this.callbacks.get(marketId);
        if (callback) {
            callback(price, {
                oldPrice: oldPrice?.price,
                change: oldPrice ? price - oldPrice.price : 0,
                history: history,
                isReal: true // Flag that this is real data
            });
        }
    }

    /**
     * Get current price for market
     */
    getPrice(marketId) {
        const data = this.prices.get(marketId);
        return data ? data.price : null;
    }

    /**
     * Get price statistics
     */
    getPriceStats(marketId) {
        const current = this.prices.get(marketId);
        const history = this.priceHistory.get(marketId) || [];
        
        if (!current || history.length === 0) return null;
        
        const prices = history.map(h => h.price);
        const startPrice = history[0].price;
        
        return {
            current: current.price,
            start: startPrice,
            high: Math.max(...prices),
            low: Math.min(...prices),
            change: current.price - startPrice,
            changePercent: ((current.price - startPrice) / startPrice) * 100,
            momentum: this.calculateMomentum(history),
            trend: current.price > startPrice ? 1 : -1,
            isReal: true,
            sampleCount: history.length
        };
    }

    /**
     * Calculate momentum from price history
     */
    calculateMomentum(history) {
        if (history.length < 3) return 0;
        
        let momentum = 0;
        for (let i = history.length - 1; i > Math.max(0, history.length - 5); i--) {
            if (history[i].price > history[i-1].price) momentum++;
            else if (history[i].price < history[i-1].price) momentum--;
        }
        return momentum;
    }

    /**
     * Attempt to reconnect
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnection attempts reached');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        
        console.log(`Reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts})`);
        
        setTimeout(() => {
            this.connect().catch(console.error);
        }, delay);
    }

    /**
     * Disconnect WebSocket
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this.subscriptions.clear();
        this.callbacks.clear();
    }
}

// ============================================
// FEE CALCULATOR
// ============================================
class FeeCalculator {
    /**
     * Calculate total fees for a trade
     */
    static calculateFees(tradeAmount, volatilityLevel = 'medium', isWinning = false) {
        if (!GAME_CONFIG.includeFees) {
            return { total: 0, breakdown: {} };
        }
        const fees = GAME_CONFIG.fees;
        // Slippage (based on volatility/liquidity)
        const slippage = tradeAmount * (fees.slippage[volatilityLevel] || fees.slippage.medium);
        // Spread cost (half the spread on entry)
        const spreadCost = tradeAmount * (fees.typicalSpread / 2);
        // Trading fee (Kraken taker fee on all trades)
        const tradingFee = tradeAmount * fees.takerFee;
        // Gas cost
        const gasCost = fees.estimatedGasUSD * 2; // Entry + exit
        const total = slippage + spreadCost + tradingFee + gasCost;
        return {
            total: total,
            breakdown: {
                slippage: slippage,
                spread: spreadCost,
                tradingFee: tradingFee,
                gas: gasCost
            },
            percentage: (total / tradeAmount) * 100
        };
    }

    /**
     * Calculate net P&L after fees
     */
    static calculateNetPnL(grossPnL, tradeAmount, volatilityLevel = 'medium') {
        const fees = this.calculateFees(tradeAmount, volatilityLevel, grossPnL > 0);
        return grossPnL - fees.total;
    }

    /**
     * Calculate required gross profit to break even
     */
    static calculateBreakEvenProfit(tradeAmount, volatilityLevel = 'medium') {
        // Need to cover: entry slippage + spread + exit fees
        const fees = GAME_CONFIG.fees;
        const entryFees = tradeAmount * (fees.slippage[volatilityLevel] + fees.typicalSpread/2);
        const exitFees = tradeAmount * (fees.slippage[volatilityLevel] + fees.takerFee);
        return entryFees + exitFees + fees.estimatedGasUSD * 2;
    }
}

// ============================================
// TRADE VALIDATOR
// ============================================
class TradeValidator {
    /**
     * Check if user is ready for live trading
     */
    static checkLiveReadiness(tradeHistory) {
        const requirements = GAME_CONFIG.warnings.liveTradeRequirements;
        const results = {
            ready: true,
            checks: []
        };
        
        // Check minimum trades
        const totalTrades = tradeHistory.length;
        const passedMinTrades = totalTrades >= requirements.minPaperTrades;
        results.checks.push({
            name: 'Minimum Paper Trades',
            required: requirements.minPaperTrades,
            actual: totalTrades,
            passed: passedMinTrades
        });
        if (!passedMinTrades) results.ready = false;
        
        // Check win rate
        const wins = tradeHistory.filter(t => t.pnl > 0).length;
        const winRate = totalTrades > 0 ? wins / totalTrades : 0;
        const passedWinRate = winRate >= requirements.minWinRate;
        results.checks.push({
            name: 'Win Rate',
            required: `${(requirements.minWinRate * 100).toFixed(0)}%`,
            actual: `${(winRate * 100).toFixed(1)}%`,
            passed: passedWinRate
        });
        if (!passedWinRate) results.ready = false;
        
        // Check profit factor
        const grossProfit = tradeHistory.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
        const grossLoss = Math.abs(tradeHistory.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
        const passedPF = profitFactor >= requirements.minProfitFactor;
        results.checks.push({
            name: 'Profit Factor',
            required: requirements.minProfitFactor,
            actual: profitFactor.toFixed(2),
            passed: passedPF
        });
        if (!passedPF) results.ready = false;
        
        // Check max drawdown
        let peak = 0;
        let maxDrawdown = 0;
        let running = 0;
        for (const trade of tradeHistory) {
            running += trade.pnl;
            peak = Math.max(peak, running);
            const drawdown = peak > 0 ? (peak - running) / peak : 0;
            maxDrawdown = Math.max(maxDrawdown, drawdown);
        }
        const passedDrawdown = maxDrawdown <= requirements.maxDrawdown;
        results.checks.push({
            name: 'Max Drawdown',
            required: `< ${(requirements.maxDrawdown * 100).toFixed(0)}%`,
            actual: `${(maxDrawdown * 100).toFixed(1)}%`,
            passed: passedDrawdown
        });
        if (!passedDrawdown) results.ready = false;
        
        return results;
    }
}

// ============================================
// AUTO TRADE LOGGER
// ============================================
class TradeLogger {
    constructor() {
        this.storageKey = GAME_CONFIG.tradeLogging?.storageKey || 'kraken_trade_log';
        this.maxEntries = GAME_CONFIG.tradeLogging?.maxLogEntries || 1000;
    }
    
    /**
     * Log a completed trade with full analytics
     */
    logTrade(trade) {
        if (!GAME_CONFIG.tradeLogging?.enabled) return;
        
        const logEntry = this.createLogEntry(trade);
        
        // Console logging
        if (GAME_CONFIG.tradeLogging?.logToConsole) {
            this.consoleLog(logEntry);
        }
        
        // Storage logging
        if (GAME_CONFIG.tradeLogging?.logToStorage) {
            this.saveToStorage(logEntry);
        }
        
        return logEntry;
    }
    
    /**
     * Create structured log entry
     */
    createLogEntry(trade) {
        const logs = this.getLogs();
        const runningStats = this.calculateRunningStats(logs);
        
        return {
            id: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            unixTime: Date.now(),
            
            // Trade details
            market: {
                id: trade.market?.id || trade.marketId,
                question: trade.market?.question || trade.question,
                category: trade.market?.category || 'unknown'
            },
            
            // Prices
            entryPrice: trade.entryPrice,
            exitPrice: trade.exitPrice || trade.currentPrice,
            priceChange: (trade.exitPrice || trade.currentPrice) - trade.entryPrice,
            priceChangePercent: (((trade.exitPrice || trade.currentPrice) - trade.entryPrice) / trade.entryPrice) * 100,
            
            // Position
            shares: trade.shares,
            buyPrice: trade.buyPrice,
            
            // P&L
            grossPnl: trade.grossPnl || 0,
            fees: trade.fees?.total || 0,
            feeBreakdown: trade.fees?.breakdown || {},
            netPnl: trade.netPnl || trade.pnl || 0,
            netPnlPercent: ((trade.netPnl || trade.pnl || 0) / trade.buyPrice) * 100,
            
            // Trade metadata
            duration: trade.duration || 0,
            exitReason: trade.exitReason || 'manual',
            priceSource: trade.priceSource || 'unknown',
            aiConfidence: trade.aiConfidence || null,
            
            // Running analytics (if enabled)
            analytics: GAME_CONFIG.tradeLogging?.includeAnalytics ? {
                totalTrades: runningStats.totalTrades + 1,
                winRate: runningStats.newWinRate,
                totalNetPnl: runningStats.totalNetPnl + (trade.netPnl || trade.pnl || 0),
                totalFeesPaid: runningStats.totalFeesPaid + (trade.fees?.total || 0),
                profitFactor: runningStats.newProfitFactor,
                avgWin: runningStats.newAvgWin,
                avgLoss: runningStats.newAvgLoss,
                consecutiveWins: trade.netPnl > 0 ? runningStats.consecutiveWins + 1 : 0,
                consecutiveLosses: trade.netPnl <= 0 ? runningStats.consecutiveLosses + 1 : 0,
                maxDrawdown: runningStats.maxDrawdown,
                sharpeRatio: runningStats.sharpeRatio
            } : null
        };
    }
    
    /**
     * Calculate running statistics
     */
    calculateRunningStats(logs) {
        if (logs.length === 0) {
            return {
                totalTrades: 0,
                newWinRate: 0,
                totalNetPnl: 0,
                totalFeesPaid: 0,
                newProfitFactor: 0,
                newAvgWin: 0,
                newAvgLoss: 0,
                consecutiveWins: 0,
                consecutiveLosses: 0,
                maxDrawdown: 0,
                sharpeRatio: 0
            };
        }
        
        const wins = logs.filter(l => l.netPnl > 0);
        const losses = logs.filter(l => l.netPnl <= 0);
        const grossProfit = wins.reduce((sum, l) => sum + l.netPnl, 0);
        const grossLoss = Math.abs(losses.reduce((sum, l) => sum + l.netPnl, 0));
        
        // Calculate max drawdown
        let peak = 0;
        let maxDrawdown = 0;
        let running = 0;
        for (const log of logs) {
            running += log.netPnl;
            peak = Math.max(peak, running);
            const dd = peak > 0 ? (peak - running) / peak : 0;
            maxDrawdown = Math.max(maxDrawdown, dd);
        }
        
        // Calculate Sharpe ratio (simplified - daily returns)
        const returns = logs.map(l => l.netPnlPercent / 100);
        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const stdDev = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);
        const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0; // Annualized
        
        // Consecutive tracking
        let consWins = 0, consLosses = 0;
        for (let i = logs.length - 1; i >= 0; i--) {
            if (logs[i].netPnl > 0) {
                if (consLosses > 0) break;
                consWins++;
            } else {
                if (consWins > 0) break;
                consLosses++;
            }
        }
        
        return {
            totalTrades: logs.length,
            newWinRate: wins.length / logs.length,
            totalNetPnl: logs.reduce((sum, l) => sum + l.netPnl, 0),
            totalFeesPaid: logs.reduce((sum, l) => sum + (l.fees || 0), 0),
            newProfitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
            newAvgWin: wins.length > 0 ? grossProfit / wins.length : 0,
            newAvgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
            consecutiveWins: consWins,
            consecutiveLosses: consLosses,
            maxDrawdown: maxDrawdown,
            sharpeRatio: sharpe
        };
    }
    
    /**
     * Console log with formatting
     */
    consoleLog(entry) {
        const isWin = entry.netPnl > 0;
        const icon = isWin ? '✅' : '❌';
        const color = isWin ? 'color: #48bb78' : 'color: #f56565';
        
        console.group(`${icon} Trade #${entry.analytics?.totalTrades || '?'}`);
        console.log(`%cNet P&L: ${entry.netPnl >= 0 ? '+' : ''}$${entry.netPnl.toFixed(2)} (${entry.netPnlPercent.toFixed(1)}%)`, color + '; font-weight: bold');
        console.log(`Market: ${entry.market.question?.substring(0, 50)}...`);
        console.log(`Entry: $${entry.entryPrice.toFixed(4)} → Exit: $${entry.exitPrice.toFixed(4)}`);
        console.log(`Fees paid: $${entry.fees.toFixed(2)}`);
        console.log(`Exit reason: ${entry.exitReason}`);
        console.log(`Price source: ${entry.priceSource}`);
        
        if (entry.analytics) {
            console.log(`📊 Running Stats: Win Rate: ${(entry.analytics.winRate * 100).toFixed(1)}% | Total P&L: $${entry.analytics.totalNetPnl.toFixed(2)} | PF: ${entry.analytics.profitFactor.toFixed(2)}`);
        }
        console.groupEnd();
    }
    
    /**
     * Save to localStorage
     */
    saveToStorage(entry) {
        const logs = this.getLogs();
        logs.push(entry);
        
        // Trim to max entries
        while (logs.length > this.maxEntries) {
            logs.shift();
        }
        
        localStorage.setItem(this.storageKey, JSON.stringify(logs));
    }
    
    /**
     * Get all logs from storage
     */
    getLogs() {
        try {
            return JSON.parse(localStorage.getItem(this.storageKey) || '[]');
        } catch {
            return [];
        }
    }
    
    /**
     * Get analytics summary
     */
    getAnalyticsSummary() {
        const logs = this.getLogs();
        if (logs.length === 0) return null;
        
        const stats = this.calculateRunningStats(logs);
        return {
            totalTrades: logs.length,
            winRate: (stats.newWinRate * 100).toFixed(1) + '%',
            totalNetPnl: '$' + stats.totalNetPnl.toFixed(2),
            totalFeesPaid: '$' + stats.totalFeesPaid.toFixed(2),
            profitFactor: stats.newProfitFactor.toFixed(2),
            avgWin: '$' + stats.newAvgWin.toFixed(2),
            avgLoss: '$' + stats.newAvgLoss.toFixed(2),
            maxDrawdown: (stats.maxDrawdown * 100).toFixed(1) + '%',
            sharpeRatio: stats.sharpeRatio.toFixed(2),
            netAfterFees: '$' + (stats.totalNetPnl - stats.totalFeesPaid).toFixed(2)
        };
    }
    
    /**
     * Clear all logs
     */
    clearLogs() {
        localStorage.removeItem(this.storageKey);
        console.log('Trade logs cleared');
    }
}

// ============================================
// ENTRY VALIDATOR - Checks if trade is worth taking after fees
// ============================================
class EntryValidator {
    /**
     * Check if a trade entry meets profitability requirements
     */
    static validateEntry(market, aiConfidence, buyPrice, volatilityLevel = 'medium') {
        const result = {
            valid: false,
            reasons: [],
            expectedProfit: 0,
            breakEvenPrice: 0,
            feeCost: 0,
            minProfitRequired: 0,
            edgeAfterFees: 0
        };
        
        // Calculate expected fees
        const fees = FeeCalculator.calculateFees(buyPrice, volatilityLevel, true);
        result.feeCost = fees.total;
        
        // Calculate break-even price move
        const breakEvenProfit = FeeCalculator.calculateBreakEvenProfit(buyPrice, volatilityLevel);
        result.breakEvenPrice = breakEvenProfit;
        result.minProfitRequired = breakEvenProfit / buyPrice; // As percentage
        
        // Calculate expected profit based on AI confidence
        // AI confidence of 75% means we expect 75% chance of winning
        // Expected value = (confidence * potential_profit) - ((1-confidence) * potential_loss)
        const winProbability = aiConfidence / 100;
        const potentialWin = buyPrice * GAME_CONFIG.smartTrading.takeProfitLevels.standard;
        const potentialLoss = buyPrice * GAME_CONFIG.smartTrading.stopLoss;
        
        result.expectedProfit = (winProbability * potentialWin) - ((1 - winProbability) * potentialLoss);
        
        // Check minimum expected profit
        const minExpectedProfit = buyPrice * (GAME_CONFIG.smartTrading.minExpectedProfit || 0.05);
        if (result.expectedProfit < minExpectedProfit) {
            result.reasons.push(`Expected profit ($${result.expectedProfit.toFixed(2)}) below minimum ($${minExpectedProfit.toFixed(2)})`);
        }
        
        // Check edge after fees
        result.edgeAfterFees = result.expectedProfit - result.feeCost;
        const minEdge = buyPrice * (GAME_CONFIG.smartTrading.minEdgeOverFees || 0.03);
        if (result.edgeAfterFees < minEdge) {
            result.reasons.push(`Edge after fees ($${result.edgeAfterFees.toFixed(2)}) below minimum ($${minEdge.toFixed(2)})`);
        }
        
        // Check AI confidence threshold
        if (aiConfidence < GAME_CONFIG.aiWinThreshold) {
            result.reasons.push(`AI confidence (${aiConfidence}%) below threshold (${GAME_CONFIG.aiWinThreshold}%)`);
        }
        
        // Valid if no reasons to reject
        result.valid = result.reasons.length === 0;
        
        return result;
    }
}

// Export instances
const krakenAPI = new KrakenAPI();
const groqAPI = new GroqAPI();
const priceSimulator = new PriceSimulator();
const realTimePriceFeed = new RealTimePriceFeed();
const restApiPriceFeed = new RestApiPriceFeed();
const feeCalculator = FeeCalculator;
const tradeValidator = TradeValidator;
const tradeLogger = new TradeLogger();
const entryValidator = EntryValidator;
