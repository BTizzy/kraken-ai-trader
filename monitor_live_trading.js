const http = require('http');
const db = require('better-sqlite3')('./data/prediction_markets.db');

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

async function monitor() {
    const status = await getStatus();
    console.log('\n═══════════════════════════════════════════════');
    console.log('  LIVE BOT STATUS');
    console.log('═══════════════════════════════════════════════');
    console.log(`Mode: ${status.mode || 'N/A'}`);
    console.log(`Balance: $${status.balance?.toFixed(4) || 'N/A'}`);
    console.log(`Open Positions: ${status.open_positions || 0}`);
    console.log(`Total Trades: ${status.total_trades || 0}`);
    console.log(`Cycle Count: ${status.cycle_count || 0}`);
    
    console.log('\n═══════════════════════════════════════════════');
    console.log('  RECENT TRADES (Last 10)');
    console.log('═══════════════════════════════════════════════');
    const trades = db.prepare(`
        SELECT id, mode, direction, position_size, entry_price, exit_price, pnl, 
               is_open, created_at
        FROM prediction_trades 
        ORDER BY id DESC LIMIT 10
    `).all();
    
    let totalPnL = 0;
    trades.forEach(t => {
        totalPnL += (t.pnl || 0);
        console.log(`[${t.id}] ${t.mode.toUpperCase()} ${t.direction} $${t.position_size?.toFixed(2)} @ $${t.entry_price?.toFixed(2)} → $${t.exit_price?.toFixed(2)} | PnL: $${(t.pnl || 0).toFixed(4)} | ${t.is_open ? 'OPEN' : 'CLOSED'}`);
    });
    
    console.log('\n═══════════════════════════════════════════════');
    console.log(`Total PnL (Recent): $${totalPnL.toFixed(4)}`);
    console.log(`Target Balance: >$0.4800 (starting balance)`);
    console.log(`Current Balance: $${status.balance?.toFixed(4) || 'N/A'}`);
    if (status.balance > 0.48) {
        console.log(`✅ PROFITABLE! Balance increased!`);
    } else {
        console.log(`⏳ Still working... Balance below target`);
    }
    console.log('═══════════════════════════════════════════════\n');
    process.exit(0);
}

monitor().catch(e => { console.error(e); process.exit(1); });
