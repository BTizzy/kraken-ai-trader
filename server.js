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
                let tpExits = 0;
                let slExits = 0;
                let trailingExits = 0;
                let timeoutExits = 0;
                let bestTrade = 0;
                let worstTrade = 0;
                
                validTrades.forEach(trade => {
                    totalPnl += trade.pnl;
                    if (trade.pnl > 0) wins++;
                    else losses++;
                    if (trade.pnl > bestTrade) bestTrade = trade.pnl;
                    if (trade.pnl < worstTrade) worstTrade = trade.pnl;
                    
                    const reason = trade.exit_reason || '';
                    if (reason === 'take_profit') tpExits++;
                    else if (reason === 'stop_loss') slExits++;
                    else if (reason === 'trailing_stop') trailingExits++;
                    else if (reason === 'timeout') timeoutExits++;
                });
                
                learningData.total_trades = validTrades.length;
                learningData.winning_trades = wins;
                learningData.losing_trades = losses;
                learningData.total_pnl = parseFloat(totalPnl.toFixed(2));
                learningData.win_rate = validTrades.length > 0 ? (wins / validTrades.length * 100) : 0;
                learningData.tp_exits = tpExits;
                learningData.sl_exits = slExits;
                learningData.trailing_exits = trailingExits;
                learningData.timeout_exits = timeoutExits;
                learningData.best_trade = bestTrade;
                learningData.worst_trade = worstTrade;
                
                // Load recent trades for display
                learningData.recent_trades = validTrades.slice(-20).reverse().map(t => ({
                    pair: t.pair,
                    direction: 'LONG',
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

        console.log(`${new Date().toISOString()} ${req.method} ${pathname}`);

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

        // Bot learning data endpoint
        if (apiPath === 'bot/learning') {
            learningData.last_update = Date.now();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(learningData));
            return;
        }

        // Start bot endpoint
        if (apiPath === 'bot/start') {
            if (botProcess && !botProcess.killed) {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ error: 'Bot is already running' }));
                return;
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
                    
                    // Parse trade ENTRY: "--- ENTER XXUSD ---"
                    const enterMatch = output.match(/--- ENTER (\w+) ---/);
                    if (enterMatch) {
                        const pair = enterMatch[1];
                        const entryTime = Date.now();
                        learningData.recent_trades.unshift({
                            pair: pair,
                            direction: 'LONG',
                            entry_time: entryTime,
                            exit_time: null,
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
                        botStatus.message = 'Entered ' + pair;
                    }
                    
                    // Parse trade EXIT: "--- EXIT XXUSD [take_profit] ---"
                    const exitMatch = output.match(/--- EXIT (\w+) \[(take_profit|stop_loss|trailing_stop|timeout)\] ---/);
                    if (exitMatch) {
                        const pair = exitMatch[1];
                        const reason = exitMatch[2];
                        
                        if (reason === 'take_profit') learningData.tp_exits++;
                        else if (reason === 'stop_loss') learningData.sl_exits++;
                        else if (reason === 'trailing_stop') learningData.trailing_exits++;
                        else learningData.timeout_exits++;
                        
                        const trade = learningData.recent_trades.find(t => t.pair === pair && t.status === 'active');
                        if (trade) {
                            const exitTime = Date.now();
                            trade.exit_time = exitTime;
                            trade.hold_time_seconds = Math.round((exitTime - trade.entry_time) / 1000);
                            trade.exit_reason = reason;
                            trade.result = reason; // Set result field for UI compatibility
                            trade.status = 'exiting';
                        }
                        botStatus.message = 'Exited ' + pair + ' [' + reason + ']';
                    }
                    
                    // Parse P&L line: "  P&L: $1.50 (+1.5%)" - individual trade P&L (not summary with fees)
                    // Only count P&L when associated with a trade exit (status === 'exiting')
                    const tradePnlMatch = output.match(/P&L: \$([\-\d.]+)/);
                    if (tradePnlMatch && !output.includes('(fees:')) {
                        const tradePnl = parseFloat(tradePnlMatch[1]);
                        if (!isNaN(tradePnl) && Math.abs(tradePnl) < 10000) {
                            // Only process P&L if there's a trade in 'exiting' state (prevents double-counting)
                            const trade = learningData.recent_trades.find(t => t.status === 'exiting');
                            if (trade) {
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
                            }
                        }
                    }
                    
                    // Parse PERFORMANCE SUMMARY: "  Trades: 10 (W:4 L:6)"
                    const summaryTradesMatch = output.match(/Trades: (\d+) \(W:(\d+) L:(\d+)\)/);
                    if (summaryTradesMatch) {
                        learningData.total_trades = parseInt(summaryTradesMatch[1]);
                        learningData.winning_trades = parseInt(summaryTradesMatch[2]);
                        learningData.losing_trades = parseInt(summaryTradesMatch[3]);
                    }
                    
                    // Parse Win Rate: "  Win Rate: 40.0%"
                    const wrMatch = output.match(/Win Rate: ([\d.]+)%/);
                    if (wrMatch) {
                        learningData.win_rate = parseFloat(wrMatch[1]);
                    }
                    
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
