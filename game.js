// Main Game Logic

class PolymarketTradingGame {
    constructor() {
        // Game state
        this.state = {
            sessionActive: false,
            bankroll: GAME_CONFIG.startingBankroll,
            startingBankroll: GAME_CONFIG.startingBankroll,
            totalPnL: 0,
            totalFeesPaid: 0,
            trades: [],
            activeTrade: null,
            markets: [],
            filteredMarkets: [],
            priceSource: GAME_CONFIG.priceSource, // 'real' or 'simulated' or 'unavailable'
            wsConnected: false,
            tradingEnabled: true, // Will be set to false if real prices required but unavailable
            dailyPnL: 0,
            consecutiveWins: 0,
            consecutiveLosses: 0
        };

        // Settings
        this.settings = {
            aiThreshold: GAME_CONFIG.aiWinThreshold,
            timerDuration: GAME_CONFIG.defaultTimer
        };

        // Timer
        this.tradeTimer = null;
        this.priceUpdateTimer = null;

        // DOM elements
        this.initializeElements();

        // Event listeners
        this.attachEventListeners();

        // Load saved settings
        this.loadSettings();
        
        // Load trade history
        this.loadTradeHistory();
        
        // Initialize analytics
        this.analytics = new TradeAnalytics();
        
        // Show risk disclaimer
        this.showRiskDisclaimer();
        
        // Initialize real-time price feed
        this.initializePriceFeed();
        
        // Show existing trade log analytics on startup
        this.showTradeLogSummary();
    }
    
    /**
     * Show trade log analytics summary in console
     */
    showTradeLogSummary() {
        const summary = tradeLogger.getAnalyticsSummary();
        if (summary) {
            console.log('📊 === TRADE LOG ANALYTICS ===');
            console.table(summary);
        } else {
            console.log('📊 No previous trades logged. Start trading to build your track record.');
        }
    }

    /**
     * Show risk disclaimer on startup
     */
    showRiskDisclaimer() {
        if (GAME_CONFIG.warnings?.showDisclaimer) {
            console.log('⚠️ ' + GAME_CONFIG.warnings.disclaimerText);
            this.showStatus('⚠️ PAPER TRADING MODE - Using real market data but no real money', 'info');
        }
        
        // Update price source indicator
        this.updatePriceSourceIndicator();
    }
    
    /**
     * Update the price source indicator in the UI
     */
    updatePriceSourceIndicator() {
        const label = document.getElementById('price-source-label');
        if (label) {
            if (this.state.priceSource === 'real-ws') {
                label.textContent = '🟢 Real-Time (WebSocket)';
                label.className = 'real';
            } else if (this.state.priceSource === 'real-rest') {
                label.textContent = '🟢 Real-Time (REST API)';
                label.className = 'real';
            } else if (this.state.priceSource === 'unavailable') {
                label.textContent = '🔴 BLOCKED - No Real Data';
                label.className = 'blocked';
            } else {
                label.textContent = '⛔ Simulated (DISABLED)';
                label.className = 'simulated';
            }
        }
    }
    
    /**
     * Show live readiness check modal
     */
    showLiveReadinessCheck() {
        const modal = document.getElementById('readiness-modal');
        const results = document.getElementById('readiness-results');
        
        if (!modal || !results) return;
        
        // Get trade history
        const tradeHistory = JSON.parse(localStorage.getItem(GAME_CONFIG.localStorageKeys?.tradeHistory || 'polymarket_trades') || '[]');
        
        // Run readiness check
        const readiness = TradeValidator.checkLiveReadiness(tradeHistory);
        
        // Build results HTML
        let html = '';
        readiness.checks.forEach(check => {
            html += `
                <div class="readiness-check">
                    <span class="check-name">${check.name}</span>
                    <span class="check-status ${check.passed ? 'passed' : 'failed'}">
                        ${check.passed ? '✓ ' : '✗ '}${check.actual} (need ${check.required})
                    </span>
                </div>
            `;
        });
        
        html += `
            <div class="readiness-summary ${readiness.ready ? 'ready' : 'not-ready'}">
                ${readiness.ready 
                    ? '✓ Ready for Live Trading!' 
                    : `⚠️ Not Yet Ready - Complete ${readiness.checks.filter(c => !c.passed).length} more requirements`}
            </div>
        `;
        
        if (!readiness.ready) {
            html += `
                <p style="margin-top: 15px; font-size: 12px; color: #666;">
                    Continue paper trading to build your track record. 
                    The system requires proof of profitability before real money is risked.
                </p>
            `;
        }
        
        results.innerHTML = html;
        modal.classList.add('active');
    }
    
    /**
     * Export trades to CSV
     */
    exportTrades() {
        const tradeHistory = JSON.parse(localStorage.getItem(GAME_CONFIG.localStorageKeys?.tradeHistory || 'polymarket_trades') || '[]');
        
        if (tradeHistory.length === 0) {
            this.showStatus('No trades to export', 'error');
            return;
        }
        
        // CSV header
        const headers = ['Date', 'Market', 'Entry Price', 'Exit Price', 'Position', 'Gross P&L', 'Fees', 'Net P&L', 'Price Source'];
        
        // CSV rows
        const rows = tradeHistory.map(trade => [
            trade.timestamp ? new Date(trade.timestamp).toISOString() : 'N/A',
            `"${(trade.marketQuestion || trade.question || 'Unknown').replace(/"/g, '""')}"`,
            trade.entryPrice?.toFixed(4) || 'N/A',
            trade.exitPrice?.toFixed(4) || 'N/A',
            trade.position || trade.shares || 'N/A',
            (trade.pnl || trade.grossPnl || 0).toFixed(2),
            (trade.fees || 0).toFixed(2),
            (trade.netPnl || trade.pnl || 0).toFixed(2),
            trade.priceSource || 'simulated'
        ]);
        
        // Combine
        const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        
        // Download
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `polymarket_trades_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.showStatus(`Exported ${tradeHistory.length} trades to CSV`, 'success');
    }

    /**
     * Initialize real-time price feed
     */
    async initializePriceFeed() {
        if (GAME_CONFIG.priceSource === 'real') {
            // Try WebSocket first
            try {
                await realTimePriceFeed.connect();
                this.state.wsConnected = true;
                this.state.priceSource = 'real-ws';
                this.state.priceFeedType = 'websocket';
                this.state.tradingEnabled = true;
                console.log('✅ Connected to real-time WebSocket price feed');
                this.updatePriceSourceIndicator();
                return;
            } catch (wsError) {
                console.warn('⚠️ WebSocket failed:', wsError.message);
                
                // Try REST API fallback (still real data!)
                if (GAME_CONFIG.useRestApiFallback) {
                    try {
                        await restApiPriceFeed.connect();
                        this.state.wsConnected = false;
                        this.state.priceSource = 'real-rest';
                        this.state.priceFeedType = 'rest';
                        this.state.tradingEnabled = true;
                        console.log('✅ Connected to REST API price feed (real data)');
                        this.showStatus('📊 Using REST API for real prices (WebSocket unavailable)', 'info');
                        this.updatePriceSourceIndicator();
                        return;
                    } catch (restError) {
                        console.error('❌ REST API also failed:', restError.message);
                    }
                }
                
                // Both failed - block trading
                this.state.wsConnected = false;
                this.state.priceSource = 'unavailable';
                this.state.tradingEnabled = false;
                this.showStatus('❌ TRADING BLOCKED: Cannot get real prices from any source', 'error');
                console.error('🚫 Trading disabled - no real price source available');
                this.updatePriceSourceIndicator();
            }
        } else {
            // Config set to simulated - block if real prices required
            this.state.priceSource = 'simulated';
            this.state.tradingEnabled = !GAME_CONFIG.requireRealPrices;
            this.updatePriceSourceIndicator();
            
            if (GAME_CONFIG.requireRealPrices) {
                this.showStatus('❌ TRADING BLOCKED: Real prices required. Change priceSource in config.', 'error');
            }
        }
    }

    /**
     * Get current price feed (WebSocket or REST)
     */
    getPriceFeed() {
        if (this.state.priceFeedType === 'websocket') {
            return realTimePriceFeed;
        } else if (this.state.priceFeedType === 'rest') {
            return restApiPriceFeed;
        }
        return null;
    }

    /**
     * Initialize DOM element references
     */
    initializeElements() {
        this.elements = {
            // Header stats
            bankroll: document.getElementById('bankroll'),
            totalPnL: document.getElementById('total-pnl'),
            winRate: document.getElementById('win-rate'),
            tradeCount: document.getElementById('trade-count'),

            // Controls
            startSession: document.getElementById('start-session'),
            endSession: document.getElementById('end-session'),
            showSettings: document.getElementById('show-settings'),
            refreshMarkets: document.getElementById('refresh-markets'),

            // Settings
            settingsPanel: document.getElementById('settings-panel'),
            groqApiKey: document.getElementById('groq-api-key'),
            saveApiKey: document.getElementById('save-api-key'),
            aiThreshold: document.getElementById('ai-threshold'),
            timerDuration: document.getElementById('timer-duration'),
            closeSettings: document.getElementById('close-settings'),

            // Status
            statusMessage: document.getElementById('status-message'),

            // Market grid
            marketGrid: document.getElementById('market-grid'),

            // Active trade
            activeTradePanel: document.getElementById('active-trade-panel'),
            tradeQuestion: document.getElementById('trade-question'),
            entryPrice: document.getElementById('entry-price'),
            currentPrice: document.getElementById('current-price'),
            positionSize: document.getElementById('position-size'),
            pnlDisplay: document.getElementById('pnl-display'),
            timerDisplay: document.getElementById('timer-display'),
            startTrade: document.getElementById('start-trade'),
            sellNow: document.getElementById('sell-now'),
            closeTrade: document.getElementById('close-trade'),
            momentumIndicator: document.getElementById('momentum-indicator'),
            takeProfitTarget: document.getElementById('take-profit-target'),
            stopLossTarget: document.getElementById('stop-loss-target'),

            // Session report
            sessionReport: document.getElementById('session-report'),
            reportPnL: document.getElementById('report-pnl'),
            reportWinRate: document.getElementById('report-win-rate'),
            reportTrades: document.getElementById('report-trades'),
            reportBest: document.getElementById('report-best'),
            reportWorst: document.getElementById('report-worst'),
            tradeHistoryList: document.getElementById('trade-history-list'),
            newSession: document.getElementById('new-session'),
            realisticMode: document.getElementById('realistic-mode'),
            aiBias: document.getElementById('ai-bias')
        };
    }

    /**
     * Attach event listeners
     */
    attachEventListeners() {
        this.elements.startSession.addEventListener('click', () => this.startSession());
        this.elements.endSession.addEventListener('click', () => this.endSession());
        this.elements.showSettings.addEventListener('click', () => this.toggleSettings());
        this.elements.refreshMarkets.addEventListener('click', () => this.loadMarkets());
        
        this.elements.saveApiKey.addEventListener('click', () => this.saveApiKey());
        this.elements.aiThreshold.addEventListener('change', (e) => this.updateSettings());
        this.elements.timerDuration.addEventListener('change', (e) => this.updateSettings());
        this.elements.closeSettings.addEventListener('click', () => this.toggleSettings());
        
        // Realistic mode and AI bias toggles
        if (this.elements.realisticMode) {
            this.elements.realisticMode.addEventListener('change', (e) => {
                GAME_CONFIG.realisticMode = e.target.checked;
                localStorage.setItem('realistic_mode', e.target.checked);
                this.showStatus(e.target.checked ? 'Realistic mode enabled - fees & slippage active' : 'Fun mode enabled - easier wins', 'info');
            });
        }
        
        if (this.elements.aiBias) {
            this.elements.aiBias.addEventListener('change', (e) => {
                GAME_CONFIG.smartTrading.aiConfidenceBias = e.target.checked;
                localStorage.setItem('ai_bias', e.target.checked);
                this.showStatus(e.target.checked ? 'AI confidence bias enabled' : 'Random market mode - harder!', 'info');
            });
        }

        this.elements.sellNow.addEventListener('click', () => this.exitTrade());
        this.elements.startTrade.addEventListener('click', () => this.startTrade());
        this.elements.closeTrade.addEventListener('click', () => this.cancelTrade());

        this.elements.newSession.addEventListener('click', () => this.startNewSession());
        
        // Live readiness check
        const liveReadinessBtn = document.getElementById('check-live-readiness');
        if (liveReadinessBtn) {
            liveReadinessBtn.addEventListener('click', () => this.showLiveReadinessCheck());
        }
        
        // Export trades button
        const exportBtn = document.getElementById('export-trades');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportTrades());
        }
        
        // Modal close (click outside or close button)
        const readinessModal = document.getElementById('readiness-modal');
        if (readinessModal) {
            readinessModal.addEventListener('click', (e) => {
                if (e.target === readinessModal) {
                    readinessModal.classList.remove('active');
                }
            });
        }
        
        const closeModalBtn = document.getElementById('close-readiness-modal');
        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', () => {
                document.getElementById('readiness-modal')?.classList.remove('active');
            });
        }
        
        // Keyboard shortcuts
        this.attachKeyboardShortcuts();
    }

    /**
     * Attach keyboard shortcuts for quick actions
     */
    attachKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Don't trigger shortcuts when typing in input fields
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
                return;
            }
            
            // Space - Sell now (when in active trade)
            if (e.code === 'Space' && this.state.activeTrade && this.tradeTimer) {
                e.preventDefault();
                this.exitTrade();
            }
            
            // Enter - Start trade (when trade panel is open but timer not started)
            if (e.code === 'Enter' && this.state.activeTrade && !this.tradeTimer) {
                e.preventDefault();
                this.startTrade();
            }
            
            // Escape - Cancel/close trade panel
            if (e.code === 'Escape') {
                e.preventDefault();
                if (this.state.activeTrade) {
                    this.cancelTrade();
                } else if (this.elements.settingsPanel.classList.contains('active')) {
                    this.toggleSettings();
                }
            }
            
            // R - Refresh markets
            if (e.code === 'KeyR' && !this.state.activeTrade && this.state.sessionActive) {
                e.preventDefault();
                this.loadMarkets();
            }
            
            // S - Toggle settings
            if (e.code === 'KeyS' && !this.state.activeTrade) {
                e.preventDefault();
                this.toggleSettings();
            }
        });
    }

    /**
     * Load saved settings from localStorage
     */
    loadSettings() {
        const savedThreshold = localStorage.getItem('ai_threshold');
        const savedTimer = localStorage.getItem('timer_duration');

        if (savedThreshold) {
            this.settings.aiThreshold = parseInt(savedThreshold);
            this.elements.aiThreshold.value = savedThreshold;
        }

        if (savedTimer) {
            this.settings.timerDuration = parseInt(savedTimer);
            this.elements.timerDuration.value = savedTimer;
        }

        // Check for API key
        if (groqAPI.hasAPIKey()) {
            this.elements.groqApiKey.value = '••••••••••••••••';
        }
    }

    /**
     * Save API key
     */
    saveApiKey() {
        const key = this.elements.groqApiKey.value.trim();
        
        if (key && key !== '••••••••••••••••') {
            groqAPI.saveAPIKey(key);
            this.showStatus('API key saved successfully!', 'success');
            this.elements.groqApiKey.value = '••••••••••••••••';
        }
    }

    /**
     * Update settings
     */
    updateSettings() {
        this.settings.aiThreshold = parseInt(this.elements.aiThreshold.value);
        this.settings.timerDuration = parseInt(this.elements.timerDuration.value);

        localStorage.setItem('ai_threshold', this.settings.aiThreshold);
        localStorage.setItem('timer_duration', this.settings.timerDuration);

        this.showStatus('Settings updated!', 'success');
    }

    /**
     * Toggle settings panel
     */
    toggleSettings() {
        this.elements.settingsPanel.classList.toggle('active');
    }

    /**
     * Show status message
     */
    showStatus(message, type = 'info') {
        this.elements.statusMessage.textContent = message;
        this.elements.statusMessage.className = `status-message ${type}`;
        
        setTimeout(() => {
            this.elements.statusMessage.className = 'status-message';
        }, 5000);
    }

    /**
     * Show message when no active markets are available
     */
    showNoMarketsMessage() {
        this.elements.marketGrid.innerHTML = `
            <div class="no-markets-message">
                <h3>No Active Markets Available</h3>
                <p>Polymarket currently has no markets accepting orders. This can happen when:</p>
                <ul>
                    <li>All markets are closed or resolved</li>
                    <li>Trading is paused temporarily</li>
                    <li>Markets are in settlement period</li>
                </ul>
                <p>Please check back later or try the demo mode with mock data.</p>
                <button id="load-demo-markets" class="demo-button">Load Demo Markets</button>
            </div>
        `;

        // Add event listener for demo button
        document.getElementById('load-demo-markets').addEventListener('click', () => this.loadDemoMarkets());

        this.showStatus('No active markets found. Try demo mode!', 'info');
    }

    /**
     * Load demo markets for testing
     */
    async loadDemoMarkets() {
        this.elements.marketGrid.innerHTML = '<div class="loading">Loading demo markets...</div>';

        // Create mock markets
        const mockMarkets = [
            {
                id: 'demo-1',
                question: 'Will the stock market be up tomorrow?',
                description: 'Demo market for testing purposes',
                active: true,
                acceptingOrders: true,
                endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                outcomes: ['Yes', 'No'],
                tokens: [
                    { outcome: 'Yes', price: 0.55 },
                    { outcome: 'No', price: 0.45 }
                ],
                volume: 10000,
                liquidity: 5000
            },
            {
                id: 'demo-2',
                question: 'Will it rain in New York tomorrow?',
                description: 'Weather prediction demo market',
                active: true,
                acceptingOrders: true,
                endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                outcomes: ['Yes', 'No'],
                tokens: [
                    { outcome: 'Yes', price: 0.30 },
                    { outcome: 'No', price: 0.70 }
                ],
                volume: 5000,
                liquidity: 2000
            },
            {
                id: 'demo-3',
                question: 'Will Bitcoin be above $50,000 tomorrow?',
                description: 'Cryptocurrency price prediction',
                active: true,
                acceptingOrders: true,
                endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                outcomes: ['Yes', 'No'],
                tokens: [
                    { outcome: 'Yes', price: 0.65 },
                    { outcome: 'No', price: 0.35 }
                ],
                volume: 15000,
                liquidity: 8000
            }
        ];

        this.state.markets = mockMarkets;

        // Get AI predictions for demo markets
        this.showStatus('Getting AI predictions for demo markets...', 'info');
        
        try {
            const predictions = await groqAPI.getPredictions(mockMarkets);
            
            // Add AI predictions to markets
            this.state.filteredMarkets = mockMarkets.map((market, index) => ({
                ...market,
                aiProbability: predictions[index] ? predictions[index].probability : 0.5
            }));

            this.renderMarkets();
            this.showStatus('Demo markets loaded! AI predictions ready.', 'success');
        } catch (error) {
            console.error('Error getting AI predictions:', error);
            // Fallback without AI predictions
            this.state.filteredMarkets = mockMarkets.map(market => ({
                ...market,
                aiProbability: 0.5
            }));
            this.renderMarkets();
            this.showStatus('Demo markets loaded (AI predictions unavailable)', 'warning');
        }
    }

    /**
     * Update UI stats
     */
    updateStats() {
        this.elements.bankroll.textContent = `$${this.state.bankroll.toFixed(2)}`;
        this.elements.totalPnL.textContent = `$${this.state.totalPnL >= 0 ? '+' : ''}${this.state.totalPnL.toFixed(2)}`;
        this.elements.totalPnL.style.color = this.state.totalPnL >= 0 ? '#48bb78' : '#f56565';
        
        const winRate = this.calculateWinRate();
        this.elements.winRate.textContent = `${winRate}%`;
        this.elements.tradeCount.textContent = this.state.trades.length;

        // Check for red zone
        if (this.state.sessionActive && this.state.totalPnL <= GAME_CONFIG.redZoneThreshold) {
            this.triggerRedZone();
        }
    }

    /**
     * Calculate win rate
     */
    calculateWinRate() {
        if (this.state.trades.length === 0) return 0;
        
        const wins = this.state.trades.filter(t => t.pnl > 0).length;
        return Math.round((wins / this.state.trades.length) * 100);
    }

    /**
     * Start a new session
     */
    async startSession() {
        this.state.sessionActive = true;
        this.state.bankroll = GAME_CONFIG.startingBankroll;
        this.state.startingBankroll = GAME_CONFIG.startingBankroll;
        this.state.totalPnL = 0;
        this.state.trades = [];

        this.elements.startSession.disabled = true;
        this.elements.endSession.disabled = false;
        this.elements.refreshMarkets.disabled = false;

        this.updateStats();
        this.showStatus('Session started! Loading markets...', 'info');

        await this.loadMarkets();
    }

    /**
     * Load markets from Polymarket
     */
    async loadMarkets() {
        try {
            this.elements.marketGrid.innerHTML = `
                <div class="loading-container">
                    <div class="spinner"></div>
                    <div class="loading-text">Loading markets from Polymarket...</div>
                </div>
            `;

            // Fetch markets
            const rawMarkets = await polymarketAPI.fetchMarkets();
            
            // Parse markets
            this.state.markets = rawMarkets
                .map(m => polymarketAPI.parseMarket(m))
                .filter(m => m !== null && m.active && m.acceptingOrders);

            // Check if no markets are accepting orders
            if (this.state.markets.length === 0) {
                this.showNoMarketsMessage();
                return;
            }

            this.elements.marketGrid.innerHTML = `
                <div class="loading-container">
                    <div class="spinner"></div>
                    <div class="loading-text">🤖 Analyzing markets with AI...</div>
                </div>
            `;
            this.showStatus('Getting AI predictions...', 'info');

            // Get AI predictions
            const predictions = await groqAPI.getPredictions(this.state.markets.slice(0, 30));

            // Filter markets by AI threshold and personal preferences
            this.state.filteredMarkets = [];
            
            for (const prediction of predictions) {
                if (prediction.probability >= this.settings.aiThreshold) {
                    const market = this.state.markets.find(m => m.id === prediction.marketId);
                    if (market) {
                        market.aiProbability = prediction.probability;
                        this.state.filteredMarkets.push(market);
                    }
                }
            }

            // Apply personalized recommendations if we have trade history
            const history = this.loadTradeHistory();
            if (history.length >= 5) {
                this.state.filteredMarkets = this.getPersonalizedRecommendations(this.state.filteredMarkets);
            }

            // Limit to max markets
            this.state.filteredMarkets = this.state.filteredMarkets.slice(0, GAME_CONFIG.maxMarketsToShow);

            this.renderMarkets();
            this.showStatus(`Found ${this.state.filteredMarkets.length} high-probability trades!`, 'success');

        } catch (error) {
            console.error('Error loading markets:', error);
            this.showStatus('Error loading markets. Please try again.', 'error');
            this.elements.marketGrid.innerHTML = `
                <div class="loading-container">
                    <div class="loading-text" style="color: #f56565;">⚠️ Error loading markets</div>
                    <div class="loading-text" style="font-size: 14px;">Click "Refresh Markets" to try again</div>
                </div>
            `;
        }
    }

    /**
     * Render market cards
     */
    renderMarkets() {
        if (this.state.filteredMarkets.length === 0) {
            this.elements.marketGrid.innerHTML = '<div class="loading">No markets match your criteria. Try lowering the AI threshold in settings.</div>';
            return;
        }

        this.elements.marketGrid.innerHTML = '';

        for (const market of this.state.filteredMarkets) {
            const card = this.createMarketCard(market);
            this.elements.marketGrid.appendChild(card);
        }
    }

    /**
     * Create a market card element
     */
    createMarketCard(market) {
        const card = document.createElement('div');
        card.className = `market-card volatility-${market.volatilityLevel}`;
        
        const buyPrice = this.calculateBuyPrice(market.volatilityLevel);
        const potentialWin = (buyPrice * 2).toFixed(2);
        const potentialLoss = buyPrice.toFixed(2);

        card.innerHTML = `
            <span class="volatility-badge">${market.volatilityLevel}</span>
            <div class="market-question">${market.question}</div>
            <div class="market-details">
                <div class="detail-row">
                    <span class="detail-label">Buy Price:</span>
                    <span class="detail-value">$${buyPrice.toFixed(2)}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Potential Win:</span>
                    <span class="detail-value">+$${potentialWin}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Max Loss:</span>
                    <span class="detail-value">-$${potentialLoss}</span>
                </div>
            </div>
            <div class="ai-confidence">🤖 AI Confidence: ${market.aiProbability.toFixed(0)}%</div>
            ${market.recommendationReasons && market.recommendationReasons.length > 0 ? 
                `<div class="recommendation-reasons">✨ ${market.recommendationReasons[0]}</div>` : ''}
        `;

        card.addEventListener('click', () => this.enterTrade(market, buyPrice));

        return card;
    }

    /**
     * Calculate buy price based on volatility
     */
    calculateBuyPrice(volatilityLevel) {
        const [min, max] = GAME_CONFIG.buyPriceRange;
        
        switch (volatilityLevel) {
            case 'low':
                return min + (max - min) * 0.2; // $1-$3
            case 'medium':
                return min + (max - min) * 0.5; // $4-$6
            case 'high':
                return min + (max - min) * 0.8; // $7-$10
            default:
                return min + (max - min) * 0.5;
        }
    }

    /**
     * Enter a trade
     */
    enterTrade(market, buyPrice) {
        if (!this.state.sessionActive) {
            this.showStatus('Please start a session first!', 'error');
            return;
        }

        // CRITICAL: Block trading if real prices unavailable
        if (!this.state.tradingEnabled) {
            this.showStatus('❌ Trading blocked! Real price feed unavailable.', 'error');
            return;
        }

        if (this.state.activeTrade) {
            this.showStatus('You already have an active trade!', 'error');
            return;
        }

        if (this.state.bankroll < buyPrice) {
            this.showStatus('Insufficient bankroll!', 'error');
            return;
        }

        // VALIDATE ENTRY - Check if trade is profitable after fees
        const entryValidation = EntryValidator.validateEntry(
            market, 
            market.aiProbability || 75, 
            buyPrice, 
            market.volatilityLevel || 'medium'
        );
        
        if (!entryValidation.valid) {
            console.warn('🚫 Trade rejected by entry validator:', entryValidation.reasons);
            this.showStatus(`❌ Trade not profitable enough: ${entryValidation.reasons[0]}`, 'error');
            return;
        }
        
        console.log(`✅ Trade validated: Expected profit $${entryValidation.expectedProfit.toFixed(2)}, Edge after fees $${entryValidation.edgeAfterFees.toFixed(2)}`);

        // Create trade - optimized position sizing based on confidence
        const confidenceMultiplier = market.aiProbability ? (market.aiProbability / 75) : 1;
        const shares = Math.floor((buyPrice / market.yesPrice) * confidenceMultiplier * 1.5);
        
        // Calculate take profit target
        const takeProfitLevel = GAME_CONFIG.smartTrading?.takeProfitLevels?.standard || 0.30;
        const takeProfitAmount = buyPrice * takeProfitLevel;
        
        this.state.activeTrade = {
            market: market,
            entryPrice: market.yesPrice,
            currentPrice: market.yesPrice,
            buyPrice: buyPrice,
            shares: shares,
            startTime: Date.now(),
            timeRemaining: this.settings.timerDuration,
            takeProfitTarget: takeProfitAmount,
            stopLossTarget: -(buyPrice * (GAME_CONFIG.smartTrading?.stopLoss || 0.25)),
            aiConfidence: market.aiProbability || 75,
            priceSource: this.state.priceSource,
            entryValidation: entryValidation
        };

        // Subscribe to real price updates for this market
        const priceFeed = this.getPriceFeed();
        if (priceFeed) {
            priceFeed.subscribe(market.id, (price, data) => {
                if (this.state.activeTrade && this.state.activeTrade.market.id === market.id) {
                    this.state.activeTrade.currentPrice = price;
                }
            });
            console.log(`📊 Subscribed to real price updates for market ${market.id}`);
        }

        // Deduct from bankroll
        this.state.bankroll -= buyPrice;
        this.updateStats();

        // Show active trade panel
        this.showActiveTrade();

        // Note: Timers are not started automatically - user must click "Start Trade"
    }

    /**
     * Show active trade panel
     */
    showActiveTrade() {
        const trade = this.state.activeTrade;

        this.elements.tradeQuestion.textContent = trade.market.question;
        this.elements.entryPrice.textContent = `$${trade.entryPrice.toFixed(3)}`;
        this.elements.currentPrice.textContent = `$${trade.currentPrice.toFixed(3)}`;
        this.elements.positionSize.textContent = `${trade.shares} shares (AI: ${trade.aiConfidence}%)`;
        
        // Show take profit and stop loss targets
        if (this.elements.takeProfitTarget) {
            this.elements.takeProfitTarget.textContent = `+$${trade.takeProfitTarget.toFixed(2)}`;
        }
        if (this.elements.stopLossTarget) {
            this.elements.stopLossTarget.textContent = `-$${Math.abs(trade.stopLossTarget).toFixed(2)}`;
        }
        
        // Initialize momentum indicator
        this.updateMomentumIndicator(0);
        
        this.updateTradePnL();

        // Show start button, hide timer and sell button initially
        this.elements.startTrade.style.display = 'block';
        this.elements.sellNow.style.display = 'none';
        this.elements.timerDisplay.style.display = 'none';

        this.elements.activeTradePanel.classList.add('active');
    }

    /**
     * Update momentum indicator
     */
    updateMomentumIndicator(momentum) {
        if (!this.elements.momentumIndicator) return;
        
        let text, className;
        
        if (momentum >= 3) {
            text = '🚀 Strong Bullish';
            className = 'bullish';
        } else if (momentum >= 1) {
            text = '📈 Bullish';
            className = 'bullish';
        } else if (momentum <= -3) {
            text = '📉 Strong Bearish';
            className = 'bearish';
        } else if (momentum <= -1) {
            text = '⬇️ Bearish';
            className = 'bearish';
        } else {
            text = '⏸️ Neutral';
            className = 'neutral';
        }
        
        this.elements.momentumIndicator.textContent = text;
        this.elements.momentumIndicator.className = className;
    }

    /**
     * Start the trade (called when user clicks Start Trade button)
     */
    startTrade() {
        if (!this.state.activeTrade) return;

        // Update trade start time
        this.state.activeTrade.startTime = Date.now();

        // Hide start button, show timer and sell button
        this.elements.startTrade.style.display = 'none';
        this.elements.sellNow.style.display = 'block';
        this.elements.timerDisplay.style.display = 'block';

        // Start timers
        this.startTradeTimers();

        this.showStatus('Trade started! Timer is running.', 'info');
    }

    /**
     * Update trade P&L display with smart exit logic and FEES
     */
    updateTradePnL() {
        if (!this.state.activeTrade) return;

        const trade = this.state.activeTrade;
        const grossPnl = (trade.currentPrice - trade.entryPrice) * trade.shares;
        
        // Calculate fees
        const fees = FeeCalculator.calculateFees(
            trade.buyPrice, 
            trade.market.volatilityLevel, 
            grossPnl > 0
        );
        
        // Net P&L after fees
        const netPnl = grossPnl - fees.total;
        const pnlPercent = (netPnl / trade.buyPrice) * 100;
        
        // Store for later
        trade.grossPnl = grossPnl;
        trade.fees = fees;
        trade.netPnl = netPnl;

        // Update display with NET P&L (what you actually get)
        const feeNote = GAME_CONFIG.includeFees ? ` (fees: $${fees.total.toFixed(2)})` : '';
        this.elements.pnlDisplay.textContent = `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)${feeNote}`;
        this.elements.pnlDisplay.className = 'pnl-display ' + (netPnl >= 0 ? 'positive' : 'negative');

        // Smart exit checks (only if trading has started)
        if (this.tradeTimer) {
            // Auto take profit (using NET P&L)
            if (GAME_CONFIG.smartTrading?.autoTakeProfit && netPnl >= trade.takeProfitTarget) {
                this.autoExitTrade(`🎯 Take profit hit (+${pnlPercent.toFixed(1)}%)`);
                return;
            }
            
            // Stop loss (using NET P&L)
            if (GAME_CONFIG.smartTrading?.autoStopLoss && netPnl <= trade.stopLossTarget) {
                this.autoExitTrade(`⛔ Stop loss triggered (${pnlPercent.toFixed(1)}%)`);
                return;
            }
            
            // Max loss (full position)
            if (netPnl <= -trade.buyPrice) {
                this.autoExitTrade('Max loss reached');
                return;
            }
        }
    }

    /**
     * Start trade timers
     */
    startTradeTimers() {
        // Countdown timer
        this.tradeTimer = setInterval(() => {
            if (!this.state.activeTrade) {
                clearInterval(this.tradeTimer);
                return;
            }

            this.state.activeTrade.timeRemaining--;
            this.elements.timerDisplay.textContent = `${this.state.activeTrade.timeRemaining}s`;

            if (this.state.activeTrade.timeRemaining <= 5) {
                this.elements.timerDisplay.classList.add('warning');
            }

            if (this.state.activeTrade.timeRemaining <= 0) {
                this.autoExitTrade('Timer expired');
            }
        }, 1000);

        // Price update timer - use real price feed (WebSocket or REST)
        this.priceUpdateTimer = setInterval(() => {
            if (!this.state.activeTrade) {
                return;
            }
            
            let newPrice;
            let priceStats;
            const priceFeed = this.getPriceFeed();
            
            if (priceFeed && (this.state.priceSource === 'real-ws' || this.state.priceSource === 'real-rest')) {
                // Use real prices from WebSocket or REST API
                newPrice = priceFeed.getPrice(this.state.activeTrade.market.id);
                priceStats = priceFeed.getPriceStats(this.state.activeTrade.market.id);
                
                // If no price yet (REST polling may have delay), keep current
                if (!newPrice) {
                    newPrice = this.state.activeTrade.currentPrice;
                }
            } else {
                // Should not reach here in production - trading should be blocked
                console.error('🚫 No real price feed available!');
                return;
            }
            
            if (newPrice) {
                this.state.activeTrade.currentPrice = newPrice;
                this.elements.currentPrice.textContent = `$${newPrice.toFixed(3)}`;
                this.updateTradePnL();
                
                // Update momentum indicator using the stats we already fetched
                if (priceStats) {
                    this.updateMomentumIndicator(priceStats.momentum);
                    this.elements.currentPrice.title = `Real market price (${this.state.priceFeedType})`;
                }
            }
        }, GAME_CONFIG.refreshInterval);
    }

    /**
     * Stop trade timers
     */
    stopTradeTimers() {
        if (this.tradeTimer) {
            clearInterval(this.tradeTimer);
            this.tradeTimer = null;
        }

        if (this.priceUpdateTimer) {
            clearInterval(this.priceUpdateTimer);
            this.priceUpdateTimer = null;
        }
    }

    /**
     * Exit trade manually
     */
    exitTrade() {
        if (!this.state.activeTrade) return;

        const trade = this.state.activeTrade;
        const holdTime = Math.round((Date.now() - trade.startTime) / 1000);

        // Use pre-calculated fees from updateTradePnL
        const grossPnL = trade.grossPnl || (trade.currentPrice - trade.entryPrice) * trade.shares;
        const fees = trade.fees || FeeCalculator.calculateFees(trade.buyPrice, trade.market.volatilityLevel, grossPnL > 0);
        const netPnL = trade.netPnl || (grossPnL - fees.total);

        // Record trade with fee breakdown
        this.recordTrade(trade, netPnL, holdTime, 'manual', { grossPnL, fees });
        
        // AUTO-LOG TRADE
        const logEntry = tradeLogger.logTrade({
            market: trade.market,
            entryPrice: trade.entryPrice,
            exitPrice: trade.currentPrice,
            shares: trade.shares,
            buyPrice: trade.buyPrice,
            grossPnl: grossPnL,
            fees: fees,
            netPnl: netPnL,
            duration: holdTime,
            exitReason: 'manual',
            priceSource: trade.priceSource || this.state.priceSource,
            aiConfidence: trade.aiConfidence
        });

        // Update bankroll with NET P&L
        this.state.bankroll += trade.buyPrice + netPnL;
        this.state.totalPnL += netPnL;
        this.state.totalFeesPaid += fees.total;
        
        // Track win/loss streaks
        if (netPnL >= 0) {
            this.state.consecutiveWins++;
            this.state.consecutiveLosses = 0;
        } else {
            this.state.consecutiveLosses++;
            this.state.consecutiveWins = 0;
        }

        // Show visual feedback
        this.showTradeFeedback(netPnL >= 0);

        this.updateStats();
        this.closeActiveTrade();

        const feeMsg = GAME_CONFIG.includeFees ? ` (fees: $${fees.total.toFixed(2)})` : '';
        const result = netPnL >= 0 ? 'profit' : 'loss';
        this.showStatus(`Trade closed: ${netPnL >= 0 ? '+' : ''}$${netPnL.toFixed(2)} ${result}${feeMsg}`, netPnL >= 0 ? 'success' : 'error');
    }

    /**
     * Auto-exit trade
     */
    autoExitTrade(reason) {
        if (!this.state.activeTrade) return;

        const trade = this.state.activeTrade;
        const holdTime = Math.round((Date.now() - trade.startTime) / 1000);

        // Use pre-calculated fees from updateTradePnL
        const grossPnL = trade.grossPnl || (trade.currentPrice - trade.entryPrice) * trade.shares;
        const fees = trade.fees || FeeCalculator.calculateFees(trade.buyPrice, trade.market.volatilityLevel, grossPnL > 0);
        const netPnL = trade.netPnl || (grossPnL - fees.total);

        // Record trade with fee breakdown
        this.recordTrade(trade, netPnL, holdTime, 'auto', { grossPnL, fees });
        
        // AUTO-LOG TRADE
        const logEntry = tradeLogger.logTrade({
            market: trade.market,
            entryPrice: trade.entryPrice,
            exitPrice: trade.currentPrice,
            shares: trade.shares,
            buyPrice: trade.buyPrice,
            grossPnl: grossPnL,
            fees: fees,
            netPnl: netPnL,
            duration: holdTime,
            exitReason: reason,
            priceSource: trade.priceSource || this.state.priceSource,
            aiConfidence: trade.aiConfidence
        });

        // Update bankroll with NET P&L
        this.state.bankroll += trade.buyPrice + netPnL;
        this.state.totalPnL += netPnL;
        this.state.totalFeesPaid += fees.total;

        // Track win/loss streaks
        if (netPnL >= 0) {
            this.state.consecutiveWins++;
            this.state.consecutiveLosses = 0;
        } else {
            this.state.consecutiveLosses++;
            this.state.consecutiveWins = 0;
        }

        // Show visual feedback
        this.showTradeFeedback(netPnL >= 0);

        this.updateStats();
        this.closeActiveTrade();

        const feeMsg = GAME_CONFIG.includeFees ? ` (fees: $${fees.total.toFixed(2)})` : '';
        this.showStatus(`Trade auto-closed (${reason}): ${netPnL >= 0 ? '+' : ''}$${netPnL.toFixed(2)}${feeMsg}`, netPnL >= 0 ? 'success' : 'error');
        
        // Check for red zone
        if (this.state.totalPnL <= (GAME_CONFIG.riskManagement?.redZoneThreshold || -100)) {
            this.triggerRedZone();
        }
    }

    /**
     * Show visual feedback for trade result
     */
    showTradeFeedback(isWin) {
        const panel = this.elements.activeTradePanel;
        
        // Add animation class
        panel.classList.add(isWin ? 'win-animation' : 'loss-animation');
        
        // Show confetti for wins
        if (isWin) {
            this.showConfetti();
        }
        
        // Flash the stats
        const bankrollStat = this.elements.bankroll.closest('.stat');
        const pnlStat = this.elements.totalPnL.closest('.stat');
        
        if (bankrollStat) {
            bankrollStat.classList.add(isWin ? 'flash-green' : 'flash-red');
            setTimeout(() => bankrollStat.classList.remove('flash-green', 'flash-red'), 500);
        }
        
        if (pnlStat) {
            pnlStat.classList.add(isWin ? 'flash-green' : 'flash-red');
            setTimeout(() => pnlStat.classList.remove('flash-green', 'flash-red'), 500);
        }
        
        // Remove animation class after completion
        setTimeout(() => {
            panel.classList.remove('win-animation', 'loss-animation');
        }, 800);
    }

    /**
     * Show confetti animation for winning trades
     */
    showConfetti() {
        const colors = ['#48bb78', '#667eea', '#ecc94b', '#f56565', '#ed64a6'];
        const container = document.createElement('div');
        container.className = 'confetti-container';
        document.body.appendChild(container);
        
        // Create confetti pieces
        for (let i = 0; i < 50; i++) {
            const confetti = document.createElement('div');
            confetti.className = 'confetti';
            confetti.style.left = Math.random() * 100 + '%';
            confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            confetti.style.animationDelay = Math.random() * 0.5 + 's';
            confetti.style.animationDuration = (2 + Math.random() * 2) + 's';
            container.appendChild(confetti);
        }
        
        // Remove container after animation
        setTimeout(() => {
            container.remove();
        }, 4000);
    }

    /**
     * Cancel trade without executing
     */
    cancelTrade() {
        if (!this.state.activeTrade) return;

        // Refund buy price
        this.state.bankroll += this.state.activeTrade.buyPrice;
        this.updateStats();

        this.closeActiveTrade();
        this.showStatus('Trade cancelled', 'info');
    }

    /**
     * Close active trade panel
     */
    closeActiveTrade() {
        this.stopTradeTimers();
        this.state.activeTrade = null;
        this.elements.activeTradePanel.classList.remove('active');
        this.elements.timerDisplay.classList.remove('warning');
    }

    /**
     * Record completed trade
     */
    recordTrade(trade, pnl, holdTime, exitType) {
        const tradeData = {
            question: trade.market.question,
            entryPrice: trade.entryPrice,
            exitPrice: trade.currentPrice,
            shares: trade.shares,
            buyPrice: trade.buyPrice,
            pnl: pnl,
            holdTime: holdTime,
            exitType: exitType,
            timestamp: new Date().toISOString(),
            marketId: trade.market.id,
            volatilityLevel: trade.market.volatilityLevel
        };
        
        this.state.trades.push(tradeData);
        this.addToTradeHistory(tradeData);
    }

    /**
     * Add trade to persistent history
     */
    addToTradeHistory(tradeData) {
        const history = this.loadTradeHistory();
        history.push(tradeData);
        
        // Keep only last 1000 trades to prevent storage bloat
        if (history.length > 1000) {
            history.splice(0, history.length - 1000);
        }
        
        localStorage.setItem('polymarket_trade_history', JSON.stringify(history));
    }

    /**
     * Trigger red zone (session lock)
     */
    triggerRedZone() {
        this.state.sessionActive = false;
        
        if (this.state.activeTrade) {
            this.cancelTrade();
        }

        this.showSessionReport();
        this.showStatus('🚨 Red Zone! Session locked due to -10% drawdown', 'error');
    }

    /**
     * End session manually
     */
    endSession() {
        if (!this.state.sessionActive) return;

        if (this.state.activeTrade) {
            const confirmExit = confirm('You have an active trade. Close it and end session?');
            if (confirmExit) {
                this.exitTrade();
            } else {
                return;
            }
        }

        this.state.sessionActive = false;
        
        // Auto-export trading logs
        this.autoExportSessionLogs();
        
        this.showSessionReport();
    }
    
    /**
     * Auto-export session logs on session end
     */
    autoExportSessionLogs() {
        if (typeof TradingLogExporter !== 'undefined') {
            console.log('📊 Auto-exporting session logs...');
            TradingLogExporter.printSummary();
            
            // Auto-download the log file
            const filename = TradingLogExporter.exportToFile();
            if (filename) {
                this.showStatus(`📁 Logs exported to ${filename} - Run ./sync-trades.sh to push to git`, 'success');
            }
        } else {
            // Fallback if TradingLogExporter not loaded
            console.log('📊 Session Summary:');
            const summary = tradeLogger.getAnalyticsSummary();
            if (summary) {
                console.table(summary);
            }
        }
    }

    /**
     * Show session report
     */
    showSessionReport() {
        this.elements.startSession.disabled = false;
        this.elements.endSession.disabled = true;
        this.elements.refreshMarkets.disabled = true;

        // Calculate stats
        const winningTrades = this.state.trades.filter(t => t.pnl > 0);
        const losingTrades = this.state.trades.filter(t => t.pnl <= 0);
        const winRate = this.calculateWinRate();
        const bestTrade = this.state.trades.reduce((max, t) => t.pnl > max.pnl ? t : max, { pnl: 0 });
        const worstTrade = this.state.trades.reduce((min, t) => t.pnl < min.pnl ? t : min, { pnl: 0 });

        // Update report
        this.elements.reportPnL.textContent = `$${this.state.totalPnL >= 0 ? '+' : ''}${this.state.totalPnL.toFixed(2)}`;
        this.elements.reportPnL.style.color = this.state.totalPnL >= 0 ? '#48bb78' : '#f56565';
        this.elements.reportWinRate.textContent = `${winRate}%`;
        this.elements.reportTrades.textContent = this.state.trades.length;
        this.elements.reportBest.textContent = `+$${bestTrade.pnl.toFixed(2)}`;
        this.elements.reportWorst.textContent = `$${worstTrade.pnl.toFixed(2)}`;

        // Render trade history
        this.renderTradeHistory();

        this.elements.sessionReport.classList.add('active');
    }

    /**
     * Render trade history
     */
    renderTradeHistory() {
        this.elements.tradeHistoryList.innerHTML = '';

        if (this.state.trades.length === 0) {
            this.elements.tradeHistoryList.innerHTML = '<p style="text-align: center; color: #999;">No trades yet</p>';
            return;
        }

        // Show most recent trades first
        const recentTrades = [...this.state.trades].reverse().slice(0, 20);

        for (const trade of recentTrades) {
            const item = document.createElement('div');
            item.className = `trade-history-item ${trade.pnl > 0 ? 'win' : 'loss'}`;
            
            item.innerHTML = `
                <div class="trade-history-question">${trade.question.substring(0, 60)}...</div>
                <div class="trade-history-pnl ${trade.pnl >= 0 ? 'positive' : 'negative'}">
                    ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}
                </div>
            `;

            this.elements.tradeHistoryList.appendChild(item);
        }
    }

    /**
     * Start a new session after report
     */
    startNewSession() {
        this.elements.sessionReport.classList.remove('active');
        
        // Analyze trading patterns to improve AI recommendations
        this.analyzeTradingPatterns();
        
        this.startSession();
    }

    /**
     * Load trade history from localStorage
     */
    loadTradeHistory() {
        try {
            const history = localStorage.getItem('polymarket_trade_history');
            return history ? JSON.parse(history) : [];
        } catch (e) {
            console.warn('Failed to load trade history:', e);
            return [];
        }
    }
    
    /**
     * Analyze trading patterns to improve AI recommendations
     */
    analyzeTradingPatterns() {
        const history = this.loadTradeHistory();
        if (history.length < 5) return; // Need minimum data for analysis
        
        // Analyze win rates by volatility level
        const volatilityStats = {};
        const exitTypeStats = {};
        const holdTimeStats = {};
        
        history.forEach(trade => {
            // Volatility analysis
            const vol = trade.volatilityLevel || 'unknown';
            if (!volatilityStats[vol]) {
                volatilityStats[vol] = { wins: 0, losses: 0, totalPnL: 0 };
            }
            if (trade.pnl > 0) {
                volatilityStats[vol].wins++;
            } else {
                volatilityStats[vol].losses++;
            }
            volatilityStats[vol].totalPnL += trade.pnl;
            
            // Exit type analysis
            const exit = trade.exitType;
            if (!exitTypeStats[exit]) {
                exitTypeStats[exit] = { wins: 0, losses: 0, totalPnL: 0 };
            }
            if (trade.pnl > 0) {
                exitTypeStats[exit].wins++;
            } else {
                exitTypeStats[exit].losses++;
            }
            exitTypeStats[exit].totalPnL += trade.pnl;
            
            // Hold time analysis (categorize by duration)
            const holdCategory = trade.holdTime < 30 ? 'quick' : 
                               trade.holdTime < 120 ? 'medium' : 'long';
            if (!holdTimeStats[holdCategory]) {
                holdTimeStats[holdCategory] = { wins: 0, losses: 0, totalPnL: 0 };
            }
            if (trade.pnl > 0) {
                holdTimeStats[holdCategory].wins++;
            } else {
                holdTimeStats[holdCategory].losses++;
            }
            holdTimeStats[holdCategory].totalPnL += trade.pnl;
        });
        
        // Calculate win rates and adjust AI thresholds
        this.adjustAIThresholds(volatilityStats, exitTypeStats, holdTimeStats);
    }
    
    /**
     * Adjust AI thresholds based on trading patterns
     */
    adjustAIThresholds(volatilityStats, exitTypeStats, holdTimeStats) {
        // Find best performing volatility level
        let bestVolatility = 'medium'; // default
        let bestWinRate = 0;
        
        Object.keys(volatilityStats).forEach(vol => {
            const stats = volatilityStats[vol];
            const total = stats.wins + stats.losses;
            if (total >= 3) { // minimum trades for significance
                const winRate = stats.wins / total;
                if (winRate > bestWinRate) {
                    bestWinRate = winRate;
                    bestVolatility = vol;
                }
            }
        });
        
        // Adjust AI confidence threshold based on performance
        if (bestWinRate > 0.6) {
            this.aiThreshold = Math.max(0.6, this.aiThreshold - 0.05); // More aggressive
        } else if (bestWinRate < 0.4) {
            this.aiThreshold = Math.min(0.8, this.aiThreshold + 0.05); // More conservative
        }
        
        // Store preferred volatility for market filtering
        this.preferredVolatility = bestVolatility;
        
        console.log(`AI Analysis: Best volatility ${bestVolatility} (${(bestWinRate*100).toFixed(1)}% win rate), adjusted threshold to ${(this.aiThreshold*100).toFixed(1)}%`);
    }
    
    /**
     * Get personalized market recommendations based on trading history
     */
    getPersonalizedRecommendations(markets) {
        const history = this.loadTradeHistory();
        if (history.length < 5) return markets;
        
        // Score markets based on user's successful patterns
        const scoredMarkets = markets.map(market => {
            let score = market.aiProbability * 100; // Base score from AI probability
            const reasons = [];
            
            // Boost score for preferred volatility level
            if (this.preferredVolatility && market.volatilityLevel === this.preferredVolatility) {
                score += 20;
                reasons.push(`Matches your preferred ${this.preferredVolatility} volatility`);
            }
            
            // Check for successful market keywords/themes
            const successfulKeywords = this.getSuccessfulKeywords(history);
            const questionLower = market.question.toLowerCase();
            
            for (const keyword of successfulKeywords) {
                if (questionLower.includes(keyword.toLowerCase())) {
                    score += 15;
                    reasons.push(`Similar to your winning trades (${keyword})`);
                    break; // Only count first match
                }
            }
            
            // Consider timing preferences
            const currentHour = new Date().getHours();
            const bestHours = this.getBestTradingHours(history);
            if (bestHours.includes(currentHour)) {
                score += 10;
                reasons.push('Good timing based on your history');
            }
            
            market.recommendationScore = score;
            market.recommendationReasons = reasons;
            
            return market;
        });
        
        // Sort by recommendation score and return top markets
        return scoredMarkets
            .sort((a, b) => b.recommendationScore - a.recommendationScore)
            .slice(0, GAME_CONFIG.maxMarketsToShow);
    }
    
    /**
     * Get keywords that appear in successful trades
     */
    getSuccessfulKeywords(history) {
        const winningTrades = history.filter(t => t.pnl > 0);
        const keywords = new Set();
        
        winningTrades.forEach(trade => {
            // Extract common keywords from successful trade questions
            const words = trade.question.toLowerCase().split(' ');
            const commonWords = words.filter(word => 
                word.length > 3 && 
                !['will', 'what', 'when', 'where', 'which', 'that', 'this', 'with', 'from', 'have', 'been'].includes(word)
            );
            commonWords.forEach(word => keywords.add(word));
        });
        
        return Array.from(keywords).slice(0, 5); // Top 5 keywords
    }
    
    /**
     * Get best trading hours based on history
     */
    getBestTradingHours(history) {
        const hourStats = {};
        
        history.forEach(trade => {
            const hour = new Date(trade.timestamp).getHours();
            if (!hourStats[hour]) {
                hourStats[hour] = { wins: 0, total: 0 };
            }
            hourStats[hour].total++;
            if (trade.pnl > 0) {
                hourStats[hour].wins++;
            }
        });
        
        // Return hours with >60% win rate and at least 3 trades
        return Object.entries(hourStats)
            .filter(([hour, stats]) => stats.total >= 3 && (stats.wins / stats.total) > 0.6)
            .map(([hour]) => parseInt(hour));
    }

}

// Trade Analytics Class
class TradeAnalytics {
    constructor() {
        this.analytics = {
            totalTrades: 0,
            winRate: 0,
            avgHoldTime: 0,
            avgPnL: 0,
            profitableExitTypes: {},
            marketPreferences: {},
            timePreferences: {},
            volatilityPreferences: {},
            pnlByHour: {},
            pnlByDayOfWeek: {}
        };
    }

    /**
     * Update analytics with new trade data
     */
    updateAnalytics(tradeHistory) {
        if (!tradeHistory || tradeHistory.length === 0) return;

        this.analytics.totalTrades = tradeHistory.length;
        
        // Calculate win rate
        const winningTrades = tradeHistory.filter(t => t.pnl > 0);
        this.analytics.winRate = (winningTrades.length / tradeHistory.length) * 100;
        
        // Average hold time
        this.analytics.avgHoldTime = tradeHistory.reduce((sum, t) => sum + t.holdTime, 0) / tradeHistory.length;
        
        // Average P&L
        this.analytics.avgPnL = tradeHistory.reduce((sum, t) => sum + t.pnl, 0) / tradeHistory.length;
        
        // Profitable exit types
        this.analytics.profitableExitTypes = {};
        tradeHistory.forEach(trade => {
            if (!this.analytics.profitableExitTypes[trade.exitType]) {
                this.analytics.profitableExitTypes[trade.exitType] = { count: 0, profitable: 0 };
            }
            this.analytics.profitableExitTypes[trade.exitType].count++;
            if (trade.pnl > 0) {
                this.analytics.profitableExitTypes[trade.exitType].profitable++;
            }
        });
        
        // Market preferences (keywords that appear in successful trades)
        this.analytics.marketPreferences = this.analyzeMarketPreferences(tradeHistory);
        
        // Time preferences
        this.analyzeTimePreferences(tradeHistory);
        
        // Volatility preferences
        this.analyzeVolatilityPreferences(tradeHistory);
    }

    /**
     * Analyze market preferences based on keywords in questions
     */
    analyzeMarketPreferences(tradeHistory) {
        const keywords = {};
        const profitableTrades = tradeHistory.filter(t => t.pnl > 0);
        
        profitableTrades.forEach(trade => {
            const question = trade.question.toLowerCase();
            const words = question.split(/\s+/);
            
            words.forEach(word => {
                if (word.length > 3) { // Skip short words
                    keywords[word] = (keywords[word] || 0) + 1;
                }
            });
        });
        
        // Return top keywords
        return Object.entries(keywords)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 10)
            .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {});
    }

    /**
     * Analyze time preferences
     */
    analyzeTimePreferences(tradeHistory) {
        tradeHistory.forEach(trade => {
            const date = new Date(trade.timestamp);
            const hour = date.getHours();
            const dayOfWeek = date.getDay();
            
            // P&L by hour
            if (!this.analytics.pnlByHour[hour]) {
                this.analytics.pnlByHour[hour] = { total: 0, count: 0 };
            }
            this.analytics.pnlByHour[hour].total += trade.pnl;
            this.analytics.pnlByHour[hour].count++;
            
            // P&L by day of week
            if (!this.analytics.pnlByDayOfWeek[dayOfWeek]) {
                this.analytics.pnlByDayOfWeek[dayOfWeek] = { total: 0, count: 0 };
            }
            this.analytics.pnlByDayOfWeek[dayOfWeek].total += trade.pnl;
            this.analytics.pnlByDayOfWeek[dayOfWeek].count++;
        });
    }

    /**
     * Analyze volatility preferences
     */
    analyzeVolatilityPreferences(tradeHistory) {
        // This would need volatility data from trades, but we can infer from buy prices
        tradeHistory.forEach(trade => {
            let volatility = 'medium'; // default
            if (trade.buyPrice < 3) volatility = 'low';
            else if (trade.buyPrice > 7) volatility = 'high';
            
            if (!this.analytics.volatilityPreferences[volatility]) {
                this.analytics.volatilityPreferences[volatility] = { count: 0, profitable: 0 };
            }
            this.analytics.volatilityPreferences[volatility].count++;
            if (trade.pnl > 0) {
                this.analytics.volatilityPreferences[volatility].profitable++;
            }
        });
    }

    /**
     * Get personalized recommendations
     */
    getRecommendations(markets) {
        const recommendations = [];
        
        markets.forEach(market => {
            let score = 50; // Base score
            let reasons = [];
            
            // Boost score based on market preferences
            const question = market.question.toLowerCase();
            Object.keys(this.analytics.marketPreferences).forEach(keyword => {
                if (question.includes(keyword)) {
                    score += 10;
                    reasons.push(`Matches your interest in "${keyword}"`);
                }
            });
            
            // Consider volatility preferences
            let preferredVolatility = 'medium';
            const volPrefs = this.analytics.volatilityPreferences;
            if (volPrefs.low && volPrefs.medium && volPrefs.high) {
                const lowRate = volPrefs.low.profitable / volPrefs.low.count;
                const medRate = volPrefs.medium.profitable / volPrefs.medium.count;
                const highRate = volPrefs.high.profitable / volPrefs.high.count;
                
                if (lowRate > medRate && lowRate > highRate) preferredVolatility = 'low';
                else if (highRate > medRate && highRate > lowRate) preferredVolatility = 'high';
            }
            
            if (market.volatilityLevel === preferredVolatility) {
                score += 15;
                reasons.push(`Matches your preferred ${preferredVolatility} volatility`);
            }
            
            // Consider profitable exit types (suggest markets that might allow those strategies)
            if (this.analytics.profitableExitTypes.timeout && 
                this.analytics.profitableExitTypes.timeout.profitable > this.analytics.profitableExitTypes.timeout.count * 0.6) {
                score += 10;
                reasons.push('Good for your timeout strategy');
            }
            
            market.recommendationScore = score;
            market.recommendationReasons = reasons;
            
            if (score > 60) {
                recommendations.push(market);
            }
        });
        
        return recommendations.sort((a, b) => b.recommendationScore - a.recommendationScore);
    }

    /**
     * Get analytics summary
     */
    getAnalyticsSummary() {
        return {
            ...this.analytics,
            bestHours: this.getBestHours(),
            bestDays: this.getBestDays(),
            topKeywords: Object.keys(this.analytics.marketPreferences).slice(0, 5)
        };
    }

    /**
     * Get best trading hours
     */
    getBestHours() {
        const hourStats = Object.entries(this.analytics.pnlByHour)
            .map(([hour, data]) => ({
                hour: parseInt(hour),
                avgPnL: data.total / data.count
            }))
            .sort((a, b) => b.avgPnL - a.avgPnL);
        
        return hourStats.slice(0, 3);
    }

    /**
     * Get best trading days
     */
    getBestDays() {
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayStats = Object.entries(this.analytics.pnlByDayOfWeek)
            .map(([day, data]) => ({
                day: dayNames[parseInt(day)],
                avgPnL: data.total / data.count
            }))
            .sort((a, b) => b.avgPnL - a.avgPnL);
        
        return dayStats.slice(0, 3);
    }
}

// Initialize game when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.game = new PolymarketTradingGame();
    console.log('Polymarket Trading Game initialized!');
    console.log('Configure your Groq API key in Settings to enable AI predictions.');
});
