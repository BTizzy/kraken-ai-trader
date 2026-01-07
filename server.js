/**
 * Polymarket Trading Proxy Server
 * Handles CORS issues by proxying requests to Polymarket APIs
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8000;

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

// Polymarket API endpoints
const POLYMARKET_CLOB = 'https://clob.polymarket.com';
const POLYMARKET_GAMMA = 'https://gamma-api.polymarket.com';

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
                'User-Agent': 'PolymarketTrader/1.0',
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
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    console.log(`${new Date().toISOString()} ${req.method} ${pathname}`);

    // API Proxy routes
    if (pathname.startsWith('/api/')) {
        const apiPath = pathname.replace('/api/', '');
        
        // Markets list
        if (apiPath === 'markets' || apiPath.startsWith('markets?')) {
            const query = parsedUrl.search || '?limit=50';
            await handleProxy(req, res, `${POLYMARKET_CLOB}/markets${query}`);
            return;
        }
        
        // Order book for a token
        if (apiPath.startsWith('book/')) {
            const tokenId = apiPath.replace('book/', '');
            await handleProxy(req, res, `${POLYMARKET_CLOB}/book?token_id=${tokenId}`);
            return;
        }
        
        // Price for a token (midpoint)
        if (apiPath.startsWith('price/')) {
            const tokenId = apiPath.replace('price/', '');
            try {
                const result = await httpsGet(`${POLYMARKET_CLOB}/book?token_id=${tokenId}`);
                const orderbook = JSON.parse(result.body);
                
                let price = null;
                if (orderbook.bids?.length && orderbook.asks?.length) {
                    const bestBid = parseFloat(orderbook.bids[0].price);
                    const bestAsk = parseFloat(orderbook.asks[0].price);
                    price = (bestBid + bestAsk) / 2;
                } else if (orderbook.bids?.length) {
                    price = parseFloat(orderbook.bids[0].price);
                } else if (orderbook.asks?.length) {
                    price = parseFloat(orderbook.asks[0].price);
                }
                
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ 
                    tokenId, 
                    price, 
                    timestamp: Date.now(),
                    source: 'clob-orderbook'
                }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
            return;
        }
        
        // Gamma API market details
        if (apiPath.startsWith('gamma/')) {
            const marketPath = apiPath.replace('gamma/', '');
            await handleProxy(req, res, `${POLYMARKET_GAMMA}/${marketPath}`);
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
});

// Start server
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║         Polymarket Trading Server v1.0                     ║
║         http://localhost:${PORT}                              ║
╠════════════════════════════════════════════════════════════╣
║  API Endpoints:                                            ║
║    /api/markets          - List markets                    ║
║    /api/book/{tokenId}   - Get orderbook                   ║
║    /api/price/{tokenId}  - Get current price               ║
║    /api/gamma/{path}     - Proxy to Gamma API              ║
╠════════════════════════════════════════════════════════════╣
║  Real-time prices via server proxy (no CORS issues)        ║
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
