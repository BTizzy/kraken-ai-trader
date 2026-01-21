/**
 * Kraken Trading Proxy Server
 * Handles CORS issues by proxying requests to Kraken APIs
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');

const PORT = 8000;
const SERVER_START_TIME = Date.now();

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    
    return parts.join(' ');
}

// Global bot process tracking
let botProcess = null;
let botStatus = {
    running: false,
    mode: 'paper',
    pairs_scanned: 0,
    trades_completed: 0,
    current_pnl: 0.0,
    last_update: Date.now(),
    message: 'Bot not started'
};

// Learning data tracking - Enhanced
let learningData = {
    total_trades: 0,
    winning_trades: 0,
    losing_trades: 0,
    win_rate: 0.0,
    total_pnl: 0.0,
    profit_factor: 1.0,
    position_size: 100.0,
    avg_win: 0.0,
    avg_loss: 0.0,
    best_trade: 0.0,
    worst_trade: 0.0,
    max_drawdown: 0.0,
    tp_exits: 0,
    sl_exits: 0,
    trailing_exits: 0,
    timeout_exits: 0,
    blacklisted_pairs: 0,
    recent_trades: [],
    pair_stats: {},
    last_update: Date.now()
};

/**
 * Load training data from trade_log.json to preserve learning across restarts
 */
function loadTrainingData() {
    const tradeLogPath = path.join(__dirname, 'bot', 'build', 'trade_log.json');
    try {
        if (fs.existsSync(tradeLogPath)) {
            const data = JSON.parse(fs.readFileSync(tradeLogPath, 'utf8'));
            if (data && Array.isArray(data.trades)) {
                const validTrades = data.trades.filter(t => 
                    t && typeof t.pnl === 'number' && Math.abs(t.pnl) < 10000
                );
                
                let totalPnl = 0;
                let wins = 0;
                let losses = 0;
                let grossWins = 0;
                let grossLosses = 0;
                let tpExits = 0;
                let slExits = 0;
                let trailingExits = 0;
                let timeoutExits = 0;
                let bestTrade = 0;
                let worstTrade = 0;
                
                validTrades.forEach(trade => {
                    totalPnl += trade.pnl;
                    if (trade.pnl > 0) {
                        wins++;
                        grossWins += trade.pnl;
                    } else {
                        losses++;
                        grossLosses += Math.abs(trade.pnl);
                    }
                    if (trade.pnl > bestTrade) bestTrade = trade.pnl;
                    if (trade.pnl < worstTrade) worstTrade = trade.pnl;
                    
                    const reason = trade.exit_reason || '';
                    if (reason === 'take_profit') tpExits++;
                    else if (reason === 'stop_loss') slExits++;
                    else if (reason === 'trailing_stop') trailingExits++;
                    else if (reason === 'timeout') timeoutExits++;
                });
                
                // Calculate profit factor
                const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 0);
                
                learningData.total_trades = validTrades.length;
                learningData.winning_trades = wins;
                learningData.losing_trades = losses;
                learningData.total_pnl = parseFloat(totalPnl.toFixed(2));
                learningData.win_rate = validTrades.length > 0 ? (wins / validTrades.length * 100) : 0;
                learningData.profit_factor = parseFloat(profitFactor.toFixed(2));
                learningData.tp_exits = tpExits;
                learningData.sl_exits = slExits;
                learningData.trailing_exits = trailingExits;
                learningData.timeout_exits = timeoutExits;
                learningData.best_trade = bestTrade;
                learningData.worst_trade = worstTrade;
                
                // Load recent trades for display
                learningData.recent_trades = validTrades.slice(-20).reverse().map(t => ({
                    pair: t.pair,
                    direction: t.direction || 'LONG',  // Use actual direction from trade data
                    entry_price: t.entry_price || t.entry || 0,  // Include entry price
                    exit_price: t.exit_price || t.exit || 0,    // Include exit price
                    entry_time: t.timestamp || Date.now(),
                    exit_time: t.timestamp || Date.now(),
                    hold_time_seconds: t.hold_time || 0,
                    timestamp: t.timestamp || Date.now(),
                    status: 'completed',
                    pnl: t.pnl,
                    exit_reason: t.exit_reason,
                    result: t.exit_reason
                }));
                
                console.log(`Loaded ${validTrades.length} trades from trade_log.json (P&L: $${learningData.total_pnl.toFixed(2)})`);
            }
        }
    } catch (error) {
        console.error('Error loading training data:', error.message);
    }
}

/**
 * Persist a completed trade to trade_log.json
 * This ensures new trades survive server restarts
 */
function persistTrade(trade) {
    const tradeLogPath = path.join(__dirname, 'bot', 'build', 'trade_log.json');
    try {
        let data = { trades: [], version: '2.0.0' };
        
        // Load existing trades
        if (fs.existsSync(tradeLogPath)) {
            data = JSON.parse(fs.readFileSync(tradeLogPath, 'utf8'));
            if (!Array.isArray(data.trades)) {
                data.trades = [];
            }
        }
        
        // Add new trade with all required fields
        const persistedTrade = {
            pair: trade.pair,
            direction: trade.direction || 'LONG',
            entry_price: trade.entry_price || 0,
            exit_price: trade.exit_price || 0,
            pnl: trade.pnl || 0,
            exit_reason: trade.exit_reason || 'unknown',
            timestamp: trade.exit_time || Date.now(),
            entry_time: trade.entry_time || Date.now(),
            hold_time: trade.hold_time_seconds || 0,
            position_size: trade.position_size || 100,
            timeframe_seconds: trade.hold_time_seconds || 600
        };
        
        data.trades.push(persistedTrade);
        data.total_trades = data.trades.length;
        
        // Write back to file
        fs.writeFileSync(tradeLogPath, JSON.stringify(data, null, 2));
        console.log(`📁 Persisted trade: ${trade.pair} P&L: $${(trade.pnl || 0).toFixed(2)} (${data.trades.length} total trades)`);
        
    } catch (error) {
        console.error('Error persisting trade:', error.message);
    }
}

// Load training data on startup
loadTrainingData();

// MIME types for static files
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Kraken API endpoints
const KRAKEN_API_BASE = 'https://api.kraken.com/0';

// ============================================
// RATE LIMITER
// ============================================
const rateLimiter = {
    requests: new Map(),  // IP -> { count, resetTime }
    maxRequests: 300,     // Max requests per window (increased for dashboard polling)
    windowMs: 60000,      // 1 minute window
    
    // Endpoints exempt from rate limiting (internal dashboard endpoints)
    exemptPaths: ['/api/bot/status', '/api/bot/learning', '/api/health', '/api/ticker'],
    
    /**
     * Check if request should be allowed
     * @param {string} ip - Client IP address
     * @param {string} path - Request path
     * @returns {object} { allowed: boolean, remaining: number, resetIn: number }
     */
    check(ip, path = '') {
        // Skip rate limiting for exempt paths
        if (this.exemptPaths.some(p => path.startsWith(p))) {
            return { allowed: true, remaining: this.maxRequests, resetIn: 0 };
        }
        
        const now = Date.now();
        let record = this.requests.get(ip);
        
        // Create or reset if window expired
        if (!record || now > record.resetTime) {
            record = { count: 0, resetTime: now + this.windowMs };
            this.requests.set(ip, record);
        }
        
        // Check limit
        if (record.count >= this.maxRequests) {
            return {
                allowed: false,
                remaining: 0,
                resetIn: Math.ceil((record.resetTime - now) / 1000)
            };
        }
        
        // Increment and allow
        record.count++;
        return {
            allowed: true,
            remaining: this.maxRequests - record.count,
            resetIn: Math.ceil((record.resetTime - now) / 1000)
        };
    },
    
    /**
     * Clean up old entries periodically
     */
    cleanup() {
        const now = Date.now();
        for (const [ip, record] of this.requests.entries()) {
            if (now > record.resetTime + this.windowMs) {
                this.requests.delete(ip);
            }
        }
    }
};

// Cleanup rate limiter every 5 minutes
setInterval(() => rateLimiter.cleanup(), 5 * 60 * 1000);

/**
 * Get client IP from request
 */
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim() || 
           req.socket?.remoteAddress || 
           'unknown';
}

/**
 * Make HTTPS request and return promise
 */
function httpsGet(targetUrl) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);

        const options = {
            hostname: parsedUrl.hostname,
            port: 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'KrakenTrader/1.0',
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data
                });
            });
        });

        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.end();
    });
}

/**
 * Serve static files
 */
function serveStatic(req, res, filePath) {
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

/**
 * Handle API proxy requests
 */
async function handleProxy(req, res, endpoint) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        const result = await httpsGet(endpoint);
        res.writeHead(result.statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(result.body);
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

/**
 * Main request handler
 */
const server = http.createServer(async (req, res) => {
    try {
        const parsedUrl = new URL(req.url, `http://localhost:8000`);
        const pathname = parsedUrl.pathname;
        const clientIP = getClientIP(req);

        console.log(`${new Date().toISOString()} ${req.method} ${pathname} [${clientIP}]`);

        // Rate limiting for API routes (exempt paths handled inside check())
        if (pathname.startsWith('/api/')) {
            const rateCheck = rateLimiter.check(clientIP, pathname);
            
            // Add rate limit headers
            res.setHeader('X-RateLimit-Limit', rateLimiter.maxRequests);
            res.setHeader('X-RateLimit-Remaining', rateCheck.remaining);
            res.setHeader('X-RateLimit-Reset', rateCheck.resetIn);
            
            if (!rateCheck.allowed) {
                res.writeHead(429, {
                    'Content-Type': 'application/json',
                    'Retry-After': rateCheck.resetIn,
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({
                    error: 'Too many requests',
                    message: `Rate limit exceeded. Try again in ${rateCheck.resetIn} seconds.`,
                    retryAfter: rateCheck.resetIn
                }));
                return;
            }
        }

        // API Proxy routes
        if (pathname.startsWith('/api/')) {
            const apiPath = pathname.replace('/api/', '');

            // Asset pairs (markets)
            if (apiPath === 'assetpairs' || apiPath.startsWith('assetpairs?')) {
                const query = parsedUrl.search || '';
                await handleProxy(req, res, `${KRAKEN_API_BASE}/public/AssetPairs${query}`);
                return;
            }

            // Markets endpoint (frontend expects this format)
            if (apiPath === 'markets' || apiPath.startsWith('markets?')) {
                const limit = parsedUrl.searchParams.get('limit') || 100;
                const assetPairsResponse = await httpsGet(`${KRAKEN_API_BASE}/public/AssetPairs`);
                const data = JSON.parse(assetPairsResponse.body);
                
                if (!data.result) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid Kraken API response' }));
                    return;
                }

                // Convert Kraken asset pairs to frontend market format
                const markets = Object.entries(data.result)
                    .filter(([pair, info]) => info.status === 'online' && pair.endsWith('USD'))
                    .slice(0, parseInt(limit))
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
                        end_date: null,
                        active_override: true
                    }));

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ markets: markets }));
                return;
            }

            // Ticker data
            if (apiPath.startsWith('ticker/')) {
                const pair = apiPath.replace('ticker/', '');
                console.log(`Fetching ticker for pair: ${pair}`);
                await handleProxy(req, res, `${KRAKEN_API_BASE}/public/Ticker?pair=${pair}`);
                return;
            }

        // Order book (depth)
        if (apiPath.startsWith('depth/')) {
            const pair = apiPath.replace('depth/', '');
            const count = parsedUrl.searchParams.get('count') || 10;
            await handleProxy(req, res, `${KRAKEN_API_BASE}/public/Depth?pair=${pair}&count=${count}`);
            return;
        }

        // Recent trades
        if (apiPath.startsWith('trades/')) {
            const pair = apiPath.replace('trades/', '');
            const since = parsedUrl.searchParams.get('since') || '';
            await handleProxy(req, res, `${KRAKEN_API_BASE}/public/Trades?pair=${pair}${since ? `&since=${since}` : ''}`);
            return;
        }
        
        // OHLC data
        if (apiPath.startsWith('ohlc/')) {
            const pair = apiPath.replace('ohlc/', '');
            const interval = parsedUrl.searchParams.get('interval') || 1;
            const since = parsedUrl.searchParams.get('since') || '';
            await handleProxy(req, res, `${KRAKEN_API_BASE}/public/OHLC?pair=${pair}&interval=${interval}${since ? `&since=${since}` : ''}`);
            return;
        }        // Server time
        if (apiPath === 'time') {
            await handleProxy(req, res, `${KRAKEN_API_BASE}/public/Time`);
            return;
        }

        // System status
        if (apiPath === 'status') {
            await handleProxy(req, res, `${KRAKEN_API_BASE}/public/SystemStatus`);
            return;
        }

        // Bot status endpoint
        if (apiPath === 'bot/status') {
            botStatus.last_update = Date.now();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(botStatus));
            return;
        }

        // Health check endpoint - comprehensive system health
        if (apiPath === 'health') {
            const tradeLogPath = path.join(__dirname, 'bot', 'build', 'trade_log.json');
            let lastTradeTimestamp = null;
            let tradeCount = 0;
            let totalPnl = 0;
            
            try {
                if (fs.existsSync(tradeLogPath)) {
                    const data = JSON.parse(fs.readFileSync(tradeLogPath, 'utf8'));
                    if (data && Array.isArray(data.trades)) {
                        tradeCount = data.trades.length;
                        if (tradeCount > 0) {
                            const lastTrade = data.trades[data.trades.length - 1];
                            lastTradeTimestamp = lastTrade.timestamp || null;
                            totalPnl = data.trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
                        }
                    }
                }
            } catch (e) {
                console.error('Error reading trade log for health check:', e.message);
            }
            
            const memUsage = process.memoryUsage();
            const health = {
                status: 'ok',
                timestamp: Date.now(),
                uptime_seconds: Math.floor(process.uptime()),
                uptime_formatted: formatUptime(process.uptime()),
                bot: {
                    running: botProcess && !botProcess.killed,
                    mode: botStatus.mode,
                    last_update: botStatus.last_update
                },
                trades: {
                    total_count: tradeCount,
                    last_trade_timestamp: lastTradeTimestamp,
                    total_pnl: parseFloat(totalPnl.toFixed(2)),
                    minutes_since_last_trade: lastTradeTimestamp ? 
                        Math.floor((Date.now() - lastTradeTimestamp) / 60000) : null
                },
                memory: {
                    heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
                    heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
                    rss_mb: Math.round(memUsage.rss / 1024 / 1024),
                    usage_percent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
                },
                alerts: []
            };
            
            // Check for alert conditions
            if (health.trades.minutes_since_last_trade > 60) {
                health.alerts.push({
                    type: 'no_trades',
                    message: `No trades for ${health.trades.minutes_since_last_trade} minutes`,
                    severity: 'warning'
                });
            }
            if (health.memory.usage_percent > 80) {
                health.alerts.push({
                    type: 'high_memory',
                    message: `Memory usage at ${health.memory.usage_percent}%`,
                    severity: 'warning'
                });
            }
            if (health.trades.total_pnl < -50) {
                health.alerts.push({
                    type: 'pnl_drop',
                    message: `Total P&L is $${health.trades.total_pnl}`,
                    severity: 'critical'
                });
            }
            
            health.status = health.alerts.some(a => a.severity === 'critical') ? 'critical' :
                           health.alerts.length > 0 ? 'warning' : 'ok';
            
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(health, null, 2));
            return;
        }

        // Bot learning data endpoint
        if (apiPath === 'bot/learning') {
            learningData.last_update = Date.now();
            
            // Load pattern database from bot
            try {
                const patternFile = path.join(__dirname, 'bot', 'build', 'pattern_database.json');
                console.log('Looking for pattern file at:', patternFile);
                if (fs.existsSync(patternFile)) {
                    console.log('Pattern file exists, reading...');
                    const patternData = JSON.parse(fs.readFileSync(patternFile, 'utf8'));
                    // Support both old format (pattern_database) and new format (patterns)
                    learningData.pattern_database = patternData.patterns || patternData.pattern_database || {};
                    learningData.total_patterns = patternData.total_patterns || Object.keys(learningData.pattern_database).length;
                    
                    // Calculate edge patterns if not in file
                    if (patternData.edge_patterns !== undefined) {
                        learningData.edge_patterns = patternData.edge_patterns;
                    } else {
                        // Count patterns with has_edge: true
                        learningData.edge_patterns = Object.values(learningData.pattern_database).filter(p => p.has_edge).length;
                    }
                    
                    learningData.basic_patterns = patternData.basic_patterns || 0;
                    learningData.enhanced_patterns = patternData.enhanced_patterns || 0;
                    console.log('Loaded', learningData.total_patterns, 'patterns (' + learningData.edge_patterns + ' with edge)');
                } else {
                    console.log('Pattern file does not exist');
                    learningData.pattern_database = {};
                    learningData.total_patterns = 0;
                }
            } catch (error) {
                console.log('Could not load pattern database:', error.message);
                learningData.pattern_database = {};
                learningData.total_patterns = 0;
            }
            
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(learningData));
            return;
        }

        // Start bot endpoint - DISABLED for safety
        // Bot should be managed via terminal: cd bot/build && ./kraken_bot
        if (apiPath === 'bot/start') {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ 
                success: false, 
                error: 'Bot start via dashboard disabled. Use terminal: cd bot/build && ./kraken_bot' 
            }));
            return;
        }

        // DISABLED: Original bot/start code
        if (false && apiPath === 'bot/start_LEGACY') {
            // CRITICAL: Always kill any existing kraken_bot processes first
            // This prevents data corruption from multiple bot instances
            const { execSync } = require('child_process');
            try {
                // Check if any kraken_bot is already running
                const runningBots = execSync('pgrep -f kraken_bot 2>/dev/null || echo ""', { encoding: 'utf8' }).trim();
                if (runningBots) {
                    console.log(`Found running kraken_bot processes: ${runningBots.split('\n').join(', ')}`);
                    execSync('pkill -9 -f kraken_bot 2>/dev/null || true', { stdio: 'ignore' });
                    console.log('Killed existing kraken_bot processes with SIGKILL');
                    // Wait for processes to fully terminate
                    execSync('sleep 1', { stdio: 'ignore' });
                }
            } catch (e) {
                // Ignore errors - no existing processes to kill
            }
            
            // Also reset the botProcess reference if it's stale
            if (botProcess) {
                try {
                    botProcess.kill('SIGKILL');
                } catch (e) {
                    // Process already dead
                }
                botProcess = null;
            }

            try {
                // Start the bot process
                const botPath = path.join(__dirname, 'bot', 'build', 'kraken_bot');
                botProcess = spawn(botPath, [], {
                    cwd: path.join(__dirname, 'bot', 'build'),
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                botStatus = {
                    running: true,
                    mode: 'paper',
                    pairs_scanned: 0,
                    trades_completed: 0,
                    current_pnl: 0.0,
                    last_update: Date.now(),
                    message: 'Bot starting...'
                };

                // Handle bot process events
                botProcess.on('exit', (code) => {
                    console.log(`Bot process exited with code ${code}`);
                    botStatus = {
                        running: false,
                        mode: 'unknown',
                        pairs_scanned: 0,
                        trades_completed: 0,
                        current_pnl: 0.0,
                        last_update: Date.now(),
                        message: `Bot stopped (exit code: ${code})`
                    };
                    botProcess = null;
                });

                botProcess.on('error', (error) => {
                    console.error('Bot process error:', error);
                    botStatus.message = `Bot error: ${error.message}`;
                });

                // Monitor bot output for status updates - IMPROVED PARSING
                botProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    console.log('[BOT]', output.trim());
                    
                    // Parse pairs count - "Found 500 USD pairs"
                    const pairsMatch = output.match(/Found (\d+) USD pairs/);
                    if (pairsMatch) {
                        botStatus.pairs_scanned = parseInt(pairsMatch[1]);
                        botStatus.message = `Scanning ${pairsMatch[1]} USD pairs`;
                    }
                    
                    if (output.includes('Scanning')) {
                        botStatus.message = 'Scanning for opportunities';
                    }
                    
                    // Parse trade ENTRY: "--- ENTER SHORT XXUSD ---" or "--- ENTER LONG XXUSD ---"
                    const enterMatch = output.match(/--- ENTER (LONG|SHORT) (\w+) ---/);
                    if (enterMatch) {
                        const direction = enterMatch[1];
                        const pair = enterMatch[2];
                        const entryTime = Date.now();
                        // Store pair temporarily to associate with price line that follows
                        learningData._pendingEntryPair = pair;
                        learningData.recent_trades.unshift({
                            pair: pair,
                            direction: direction,
                            entry_time: entryTime,
                            entry_price: null, // Will be set from "Price: $X" line
                            exit_time: null,
                            exit_price: null,
                            hold_time_seconds: null,
                            timestamp: entryTime, // Keep for UI compatibility
                            status: 'active',
                            pnl: null,
                            exit_reason: null,
                            result: null // Add result field for UI compatibility
                        });
                        if (learningData.recent_trades.length > 30) {
                            learningData.recent_trades.pop();
                        }
                        botStatus.message = 'Entered ' + direction + ' ' + pair;
                    }
                    
                    // Parse entry price line: "  Price: $0.358105"
                    const entryPriceMatch = output.match(/^\s+Price: \$([\d.]+)/);
                    if (entryPriceMatch && learningData._pendingEntryPair) {
                        const price = parseFloat(entryPriceMatch[1]);
                        const trade = learningData.recent_trades.find(t => t.pair === learningData._pendingEntryPair && t.status === 'active');
                        if (trade && !isNaN(price)) {
                            trade.entry_price = price;
                        }
                        learningData._pendingEntryPair = null; // Clear pending
                    }
                    
                    // Parse trade EXIT: "--- EXIT SHORT XXUSD [max_hold_time] ---" or "--- EXIT LONG XXUSD [take_profit] ---"
                    // Bot outputs: direction (LONG/SHORT), then pair, then reason in brackets
                    const exitMatch = output.match(/--- EXIT (LONG|SHORT) (\w+) \[(take_profit|stop_loss|trailing_stop|timeout|max_hold_time)\] ---/);
                    if (exitMatch) {
                        const direction = exitMatch[1];
                        const pair = exitMatch[2];
                        const reason = exitMatch[3];
                        
                        // Normalize reason names
                        const normalizedReason = reason === 'max_hold_time' ? 'timeout' : reason;
                        
                        if (normalizedReason === 'take_profit') learningData.tp_exits++;
                        else if (normalizedReason === 'stop_loss') learningData.sl_exits++;
                        else if (normalizedReason === 'trailing_stop') learningData.trailing_exits++;
                        else learningData.timeout_exits++;
                        
                        const trade = learningData.recent_trades.find(t => t.pair === pair && t.status === 'active');
                        if (trade) {
                            const exitTime = Date.now();
                            trade.exit_time = exitTime;
                            trade.hold_time_seconds = Math.round((exitTime - trade.entry_time) / 1000);
                            trade.exit_reason = normalizedReason;
                            trade.result = normalizedReason; // Set result field for UI compatibility
                            trade.status = 'exiting';
                            trade.direction = direction; // Capture direction for persistence
                        }
                        // Store the pair being exited for matching subsequent price/pnl lines
                        learningData._pendingExitPair = pair;
                        botStatus.message = 'Exited ' + pair + ' [' + normalizedReason + ']';
                    }
                    
                    // Parse entry/exit prices: "Entry: $0.358105 -> Exit: $0.358200"
                    // Note: This line comes AFTER the EXIT header but BEFORE P&L line
                    // Use _pendingExitPair to find the correct trade
                    const priceMatch = output.match(/Entry: \$([\d.]+) -> Exit: \$([\d.]+)/);
                    if (priceMatch) {
                        const entryPrice = parseFloat(priceMatch[1]);
                        const exitPrice = parseFloat(priceMatch[2]);
                        
                        // Find trade by pending exit pair, or fall back to status-based search
                        let trade = null;
                        if (learningData._pendingExitPair) {
                            trade = learningData.recent_trades.find(t => t.pair === learningData._pendingExitPair);
                        }
                        if (!trade) {
                            // Fallback: look for any trade in 'exiting' status
                            trade = learningData.recent_trades.find(t => t.status === 'exiting');
                        }
                        if (!trade) {
                            // Last resort: most recent active trade
                            trade = learningData.recent_trades.find(t => t.status === 'active');
                        }
                        
                        if (trade) {
                            trade.entry_price = entryPrice;
                            trade.exit_price = exitPrice;
                            console.log(`[PRICE] Set prices on ${trade.pair}: entry=$${entryPrice}, exit=$${exitPrice}`);
                        } else {
                            console.log(`[PRICE] WARNING: No trade found for prices! pending=${learningData._pendingExitPair}`);
                        }
                    }
                    
                    // Parse P&L line: "  P&L: $1.50 (+1.5%)" - individual trade P&L (not summary with fees)
                    // Only count P&L when associated with a trade exit (status === 'exiting')
                    const tradePnlMatch = output.match(/P&L: \$([\-\d.]+)/);
                    if (tradePnlMatch && !output.includes('(fees:')) {
                        const tradePnl = parseFloat(tradePnlMatch[1]);
                        if (!isNaN(tradePnl) && Math.abs(tradePnl) < 10000) {
                            // Find trade by pending exit pair, or fall back to status-based search
                            let trade = null;
                            if (learningData._pendingExitPair) {
                                trade = learningData.recent_trades.find(t => t.pair === learningData._pendingExitPair);
                            }
                            if (!trade) {
                                // Fallback: look for any trade in 'exiting' status
                                trade = learningData.recent_trades.find(t => t.status === 'exiting');
                            }
                            
                            if (trade && (trade.status === 'exiting' || trade.status === 'active')) {
                                console.log(`[PNL] Trade ${trade.pair}: entry_price=${trade.entry_price}, exit_price=${trade.exit_price}, pnl=${tradePnl}`);
                                trade.pnl = tradePnl;
                                trade.status = 'completed';
                                
                                // Only count towards totals when completing a trade
                                botStatus.trades_completed++;
                                learningData.total_trades++;
                                learningData.total_pnl += tradePnl;
                                botStatus.current_pnl = learningData.total_pnl;
                                
                                if (tradePnl > 0) {
                                    learningData.winning_trades++;
                                    if (tradePnl > learningData.best_trade) learningData.best_trade = tradePnl;
                                } else {
                                    learningData.losing_trades++;
                                    if (tradePnl < learningData.worst_trade) learningData.worst_trade = tradePnl;
                                }
                                
                                learningData.win_rate = learningData.total_trades > 0 
                                    ? (learningData.winning_trades / learningData.total_trades * 100) 
                                    : 0;
                                
                                learningData.last_update = Date.now();
                                
                                // PERSIST TRADE: Save completed trade to trade_log.json
                                persistTrade(trade);
                                
                                // Clear pending exit pair after successful persist
                                learningData._pendingExitPair = null;
                            }
                        }
                    }
                    
                    // NOTE: Do NOT override trade counts/win rate from bot output
                    // The trade_log.json file loaded at startup is the source of truth
                    // Bot's in-memory stats only reflect current session, not historical data
                    
                    // Parse summary P&L with fees: "  P&L: $-2.50 (fees: $4.00)"
                    const summaryPnlMatch = output.match(/P&L: \$([\-\d.]+) \(fees:/);
                    if (summaryPnlMatch) {
                        const pnl = parseFloat(summaryPnlMatch[1]);
                        if (!isNaN(pnl) && Math.abs(pnl) < 100000) {
                            learningData.total_pnl = pnl;
                            botStatus.current_pnl = pnl;
                        }
                    }
                    
                    // Parse exit summary: "  Exits: TP:2 SL:3 Trail:1 TO:4"
                    const exitsMatch = output.match(/Exits: TP:(\d+) SL:(\d+) Trail:(\d+) TO:(\d+)/);
                    if (exitsMatch) {
                        learningData.tp_exits = parseInt(exitsMatch[1]);
                        learningData.sl_exits = parseInt(exitsMatch[2]);
                        learningData.trailing_exits = parseInt(exitsMatch[3]);
                        learningData.timeout_exits = parseInt(exitsMatch[4]);
                    }
                    
                    // Update timestamps
                    learningData.last_update = Date.now();
                    botStatus.last_update = Date.now();
                });

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ success: true, message: 'Bot started' }));

            } catch (error) {
                console.error('Failed to start bot:', error);
                res.writeHead(500, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ error: 'Failed to start bot process' }));
            }
            return;
        }

        // Stop bot endpoint
        if (apiPath === 'bot/stop') {
            if (!botProcess || botProcess.killed) {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ error: 'Bot is not running' }));
                return;
            }

            try {
                botProcess.kill('SIGTERM');
                
                // Give it a moment to clean up
                setTimeout(() => {
                    if (botProcess && !botProcess.killed) {
                        botProcess.kill('SIGKILL');
                    }
                }, 5000);

                botStatus = {
                    running: false,
                    mode: 'unknown',
                    pairs_scanned: 0,
                    trades_completed: 0,
                    current_pnl: 0.0,
                    last_update: Date.now(),
                    message: 'Bot stopping...'
                };

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ success: true, message: 'Bot stop signal sent' }));

            } catch (error) {
                console.error('Failed to stop bot:', error);
                res.writeHead(500, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ error: 'Failed to stop bot process' }));
            }
            return;
        }

        // Bot control endpoints
        if (apiPath === 'bot/start') {
            try {
                const { spawn } = require('child_process');
                const botPath = path.join(__dirname, 'bot', 'build', 'kraken_bot');
                
                // Check if bot is already running
                const statusFile = path.join(__dirname, 'bot_status.json');
                if (fs.existsSync(statusFile)) {
                    try {
                        const statusData = fs.readFileSync(statusFile, 'utf8');
                        const parsedStatus = JSON.parse(statusData);
                        if (parsedStatus.running) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Bot is already running' }));
                            return;
                        }
                    } catch (e) {
                        // Status file corrupted, continue
                    }
                }

                // Start the bot process
                const botProcess = spawn(botPath, [], {
                    cwd: path.join(__dirname, 'bot', 'build'),
                    detached: true,
                    stdio: 'ignore'
                });

                botProcess.unref();

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ success: true, message: 'Bot started successfully' }));
            } catch (error) {
                console.error('Failed to start bot:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to start bot: ' + error.message }));
            }
            return;
        }

        if (apiPath === 'bot/stop') {
            try {
                const { exec } = require('child_process');
                
                // Kill any running kraken_bot processes
                exec('pkill -f kraken_bot', (error, stdout, stderr) => {
                    // Clear the status file
                    const statusFile = path.join(__dirname, 'bot_status.json');
                    try {
                        const stoppedStatus = {
                            running: false,
                            mode: 'unknown',
                            pairs_scanned: 0,
                            trades_completed: 0,
                            current_pnl: 0.0,
                            last_update: Date.now(),
                            message: 'Bot stopped'
                        };
                        fs.writeFileSync(statusFile, JSON.stringify(stoppedStatus, null, 2));
                    } catch (e) {
                        console.error('Failed to write stopped status:', e);
                    }

                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(JSON.stringify({ success: true, message: 'Bot stop requested' }));
                });
            } catch (error) {
                console.error('Failed to stop bot:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to stop bot: ' + error.message }));
            }
            return;
        }

        // Unknown API route
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown API endpoint' }));
        return;
    }

    // Static file serving
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    serveStatic(req, res, filePath);
    } catch (error) {
        console.error('Request handler error:', error);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal server error');
    }
});

// Start server
server.listen(PORT, () => {
    // STARTUP: Kill any orphaned bot processes from previous server runs
    const { execSync } = require('child_process');
    try {
        const runningBots = execSync('pgrep -f kraken_bot 2>/dev/null || echo ""', { encoding: 'utf8' }).trim();
        if (runningBots) {
            console.log(`⚠️  Found orphaned kraken_bot processes at startup: ${runningBots.split('\n').join(', ')}`);
            execSync('pkill -9 -f kraken_bot 2>/dev/null || true', { stdio: 'ignore' });
            console.log('✅ Killed orphaned bot processes');
        }
    } catch (e) {
        // Ignore errors
    }
    
    console.log(`
╔════════════════════════════════════════════════════════════╗
║         Kraken Trading Server v1.0                     ║
║         http://localhost:${PORT}                              ║
╠════════════════════════════════════════════════════════════╣
║  API Endpoints:                                            ║
║    /api/assetpairs     - Get trading pairs                 ║
║    /api/markets        - Get markets (frontend format)     ║
║    /api/ticker/{pair}  - Get ticker data                   ║
║    /api/depth/{pair}   - Get order book                    ║
║    /api/trades/{pair}  - Get recent trades                 ║
║    /api/ohlc/{pair}    - Get OHLC data                     ║
║    /api/time          - Get server time                    ║
║    /api/status        - Get system status                  ║
║    /api/bot/status    - Get bot status                     ║
║    /api/bot/start     - Start bot process                  ║
║    /api/bot/stop      - Stop bot process                   ║
║    /api/bot/start     - Start the bot                      ║
║    /api/bot/stop      - Stop the bot                       ║
╠════════════════════════════════════════════════════════════╣
║  Real-time prices via Kraken WebSocket                     ║
╚════════════════════════════════════════════════════════════╝
`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
