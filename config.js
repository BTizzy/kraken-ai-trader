// Game Configuration - PRODUCTION READY
const GAME_CONFIG = {
    // ============================================
    // CRITICAL TRADING MODE SETTINGS
    // ============================================
    
    // Trading mode: 'paper' or 'live'
    // NEVER set to 'live' without extensive paper trading validation
    tradingMode: 'paper',
    
    // Price source: 'real' uses WebSocket, 'simulated' uses fake prices
    // MUST be 'real' for any serious use
    priceSource: 'kraken-ws',
    
    // Fallback to simulation if real prices fail
    // DISABLED - Real prices only for production trading
    fallbackToSimulation: false,
    
    // Block trading entirely if real prices unavailable
    // TRUE = production mode, no fake data ever
    requireRealPrices: true,
    
    // Use REST API polling when WebSocket fails (still real data)
    useRestApiFallback: true,
    restApiPollInterval: 2000,  // Poll every 2 seconds
    
    // ============================================
    // RISK WARNINGS - READ CAREFULLY
    // ============================================
    warnings: {
        showDisclaimer: true,
        disclaimerText: `⚠️ RISK WARNING:
• This is PAPER TRADING - no real money is at risk yet
• AI predictions are NOT guaranteed to be accurate
• Past performance does NOT predict future results
• Real prediction markets have fees, slippage, and liquidity risks
• You can lose your entire investment
• Only trade with money you can afford to lose`,
        
        // Requirements before live trading is allowed
        liveTradeRequirements: {
            minPaperTrades: 50,      // Complete 50+ paper trades
            minWinRate: 0.55,        // 55%+ win rate
            minProfitFactor: 1.2,    // Gross profit / gross loss > 1.2
            minConsecutiveWins: 3,   // At least one 3-win streak
            maxDrawdown: 0.20        // Never lost more than 20% in paper
        }
    },
    
    // ============================================
    // BANKROLL & POSITION SIZING
    // ============================================
    startingBankroll: 1000,
    
    // Risk management
    riskManagement: {
        maxPositionPct: 0.05,       // Max 5% of bankroll per trade
        maxDailyLossPct: 0.10,      // Stop trading at 10% daily loss
        maxOpenTrades: 1,           // Only 1 trade at a time
        cooldownAfterLoss: 30000,   // 30 second cooldown after loss
        
        // Red zone threshold (triggers session lock)
        redZoneThreshold: -100,     // -$100 or -10% of starting
        
        // Position sizing adjustments based on performance
        sizeAdjustment: {
            increaseAfterWins: 3,   // Increase size after 3 consecutive wins
            decreaseAfterLosses: 2, // Decrease size after 2 consecutive losses
            maxMultiplier: 1.5,     // Never more than 1.5x base size
            minMultiplier: 0.5      // Never less than 0.5x base size
        }
    },
    
    // ============================================
    // TRADING FEES (POLYMARKET ACTUAL)
    // ============================================
    fees: {
        // Kraken spot fee structure (2026)
        takerFee: 0.004,             // 0.4% taker fee (as decimal)
        makerFee: 0.0,               // 0% maker fee
        slippage: {
            low: 0.0005,             // 0.05% for liquid markets
            medium: 0.001,           // 0.1% for average markets
            high: 0.002              // 0.2% for illiquid markets
        },
        estimatedGasUSD: 0,          // No gas fee for spot
        typicalSpread: 0.0001        // 0.01% typical spread
    },
    
    // Include fees in P&L calculations?
    includeFees: true,
    
    // ============================================
    // AI PREDICTION SETTINGS
    // ============================================
    aiWinThreshold: 75,             // Min AI prediction % to show trade
    
    // Groq API
    groqAPI: 'https://api.groq.com/openai/v1/chat/completions',
    groqModel: 'llama-3.3-70b-versatile',  // Updated Jan 2026
    groqModelFallback: 'llama-3.1-8b-instant',  // Backup model
    
    // ============================================
    // POLYMARKET API ENDPOINTS
    // ============================================
    polymarketAPI: 'https://clob.polymarket.com/markets',
    polymarketWS: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    polymarketGammaAPI: 'https://gamma-api.polymarket.com',
    polymarketClobWS: 'wss://clob.polymarket.com/ws',
    
    // ============================================
    // MARKET SETTINGS
    // ============================================
    maxMarketsToFetch: 50,
    maxMarketsToShow: 20,
    
    // Volatility classification
    volatility: {
        low: 5,                     // < 5% = green (stable)
        medium: 15                  // 5-15% = yellow, >15% = red
    },
    
    // ============================================
    // TRADING TIMER
    // ============================================
    timerOptions: [10, 15, 20, 30],
    defaultTimer: 20,
    
    // Buy price range per trade
    buyPriceRange: [2, 25],
    
    // ============================================
    // SMART TRADING (Exit Strategies)
    // ============================================
    smartTrading: {
        // CRITICAL: NO artificial bias in real mode
        aiConfidenceBias: false,    // MUST be false for real trading
        
        // ENTRY REQUIREMENTS - must exceed fees + buffer
        minExpectedProfit: 0.05,    // Min 5% expected profit to enter
        minEdgeOverFees: 0.03,      // Must have 3% edge after fees
        
        // Take profit levels (after fees)
        takeProfitLevels: {
            conservative: 0.08,     // 8% profit target (realistic)
            standard: 0.15,         // 15% profit target
            aggressive: 0.25        // 25% profit target
        },
        
        // Currently active take profit level
        activeTakeProfitLevel: 'standard',
        
        // Stop loss (exit to limit losses)
        stopLoss: 0.12,             // 12% loss triggers exit
        
        // Auto-execute take profit?
        autoTakeProfit: true,
        
        // Auto-execute stop loss?
        autoStopLoss: true,
        
        // Momentum detection
        momentumThreshold: 3,
        
        // Mean reversion (DISABLED for real trading)
        meanReversionStrength: 0.0
    },
    
    // ============================================
    // PRICE UPDATES
    // ============================================
    refreshInterval: 1000,          // 1 second for WebSocket
    priceHistoryLength: 60,         // Keep 60 price points for charts
    
    // Price simulation (ONLY for fallback/testing)
    enablePriceSimulation: false,   // DISABLED by default
    simulationVolatility: {
        low: 0.003,                 // Realistic: 0.3% per tick
        medium: 0.006,              // 0.6% per tick
        high: 0.01                  // 1% per tick
    },
    
    // ============================================
    // VALIDATION & BACKTESTING
    // ============================================
    validation: {
        // Track all trades for analysis
        trackAllTrades: true,
        
        // Store price history for backtesting
        storePriceHistory: true,
        
        // Calculate Sharpe ratio, max drawdown, etc.
        calculateAdvancedMetrics: true,
        
        // Export trades to CSV
        enableExport: true
    },
    
    // ============================================
    // AUTO TRADE LOGGING
    // ============================================
    tradeLogging: {
        enabled: true,
        logToConsole: true,         // Real-time console output
        logToStorage: true,         // Auto-save to localStorage
        storageKey: 'polymarket_trade_log',
        maxLogEntries: 1000,        // Keep last 1000 entries
        includeAnalytics: true      // Include running stats in each log
    },
    
    // ============================================
    // WALLET INTEGRATION (FUTURE)
    // ============================================
    wallet: {
        enabled: true,
        supportedWallets: ['kraken'],
        krakenWsUrl: 'wss://ws.kraken.com',
        krakenRestUrl: 'http://localhost:3002',
        // Add more wallet config as needed
    }
};

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GAME_CONFIG;
}
