const http = require('http');
const db = require('better-sqlite3')('./data/prediction_markets.db');

let lastTradeCount = 0;

function getStatus() {
    return new Promise((resolve) => {
        const req = http.get('http://localhost:3003/api/bot/status', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve({ error: 'Parse error' });
                }
            });
        });
        req.on('error', () => resolve({ error: 'Connection failed' }));
        req.setTimeout(3000);
    });
}

async function checkProgress() {
    const status = await getStatus();
    
    // Get balance from Gemini API
    const GeminiClient = require('./lib/gemini_client.js');
    const key = process.env.GEMINI_API_KEY || '';
    const secret = process.env.GEMINI_API_SECRET || '';
    
    let realBalance = null;
    if (key && secret) {
        try {
            const client = new GeminiClient(key, secret, 'live');
            realBalance = await client.getAvailableBalance();
        } catch (e) {
            realBalance = 'Error fetching';
        }
    }
    
    const tradeCount = status.total_trades || 0;
    const liveTradeRow = db.prepare(`
        SELECT COUNT(*) as count FROM prediction_trades WHERE mode = 'live'
    `).get();
    const liveTradeCount = liveTradeRow?.count || 0;
    
    const pnlRow = db.prepare(`
        SELECT SUM(pnl) as total_pnl FROM prediction_trades WHERE mode = 'live' AND is_open = 0
    `).get();
    const livePnL = pnlRow?.total_pnl || 0;
    
    const timestamp = new Date().toLocaleTimeString();
    
    console.log(`\n[${timestamp}] Cycle ${status.cycle_count} | Trades: ${status.total_trades} | Live Trades: ${liveTradeCount} | Live PnL: $${livePnL.toFixed(4)} | Balance: $${realBalance || 'N/A'}`);
    
    if (liveTradeCount > 0 && realBalance > 0.48) {
        console.log('✅ SUCCESS! Balance above starting level ($0.48)!');
        process.exit(0);
    }
    
    if (liveTradeCount > 0 && realBalance < 0.10) {
        console.log('⚠️  Warning: Balance critically low!');
    }
}

async function monitor() {
    console.log('Starting continuous monitoring... (Press Ctrl+C to stop)');
    console.log('Checking every 10 seconds for profitability goal: balance > $0.48');
    
    checkProgress();
    const interval = setInterval(checkProgress, 10000);
    
    // Auto-exit after 15 minutes if not profitable
    setTimeout(() => {
        clearInterval(interval);
        console.log('\n⏹️  15-minute monitoring window complete.');
        process.exit(0);
    }, 15 * 60 * 1000);
}

monitor().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
