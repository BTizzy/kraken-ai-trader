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
    mode: 'unknown',
    pairs_scanned: 0,
    trades_completed: 0,
    current_pnl: 0.0,
    last_update: Date.now(),
    message: 'Bot not started'
};

// Learning data tracking
let learningData = {
    total_trades: 0,
    win_rate: 0.0,
    total_pnl: 0.0,
    position_size: 100.0,
    target_leverage: 2.0,
    recent_trades: [],
    patterns: {},
    last_update: Date.now()
};

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

                // Monitor bot output for status updates
                let outputBuffer = '';
                botProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    outputBuffer += output;
                    console.log('[BOT]', output.trim());
                    
                    // Extract status info from output
                    if (output.includes('Available trading pairs:')) {
                        const match = output.match(/Available trading pairs: (\d+)/);
                        if (match) {
                            botStatus.pairs_scanned = parseInt(match[1]);
                            botStatus.message = `Scanning ${match[1]} trading pairs`;
                        }
                    }
                    
                    if (output.includes('Scanning')) {
                        botStatus.message = 'Scanning trading pairs';
                    }

                    // Parse trade recording: 📝 Trade recorded: ADAUSD | WIN ✅ | ROI: 1.50% | Pattern: ADAUSD_2x_0
                    const tradeMatch = output.match(/📝 Trade recorded: (\w+) \| (WIN|LOSS) [✅❌] \| ROI: ([\-\d.]+)% \| Pattern: (\w+)/);
                    if (tradeMatch) {
                        const trade = {
                            pair: tradeMatch[1],
                            result: tradeMatch[2],
                            roi: parseFloat(tradeMatch[3]),
                            pattern: tradeMatch[4],
                            timestamp: Date.now()
                        };
                        learningData.recent_trades.unshift(trade);
                        if (learningData.recent_trades.length > 20) {
                            learningData.recent_trades.pop();
                        }
                        botStatus.trades_completed++;
                    }

                    // Parse learning update: Total Trades: 5, Win Rate: 20.0%, Total P&L: $-1.77
                    const totalTradesMatch = output.match(/Total Trades: (\d+)/);
                    if (totalTradesMatch) {
                        learningData.total_trades = parseInt(totalTradesMatch[1]);
                    }
                    
                    const winRateMatch = output.match(/Win Rate: ([\d.]+)%/);
                    if (winRateMatch) {
                        learningData.win_rate = parseFloat(winRateMatch[1]);
                    }
                    
                    const pnlMatch = output.match(/Total P&L: \$([\-\d.]+)/);
                    if (pnlMatch) {
                        learningData.total_pnl = parseFloat(pnlMatch[1]);
                        botStatus.current_pnl = learningData.total_pnl;
                    }

                    // Parse parameter adjustments: Position Size: $90.00, Target Leverage: 1.90x
                    const positionMatch = output.match(/Position Size: \$([\d.]+)/);
                    if (positionMatch) {
                        learningData.position_size = parseFloat(positionMatch[1]);
                    }
                    
                    const leverageMatch = output.match(/Target Leverage: ([\d.]+)x/);
                    if (leverageMatch) {
                        learningData.target_leverage = parseFloat(leverageMatch[1]);
                    }
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
