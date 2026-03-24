const Database = require('better-sqlite3');
const db = new Database('./data/prediction_markets.db', { readonly: true });

const fixTime = 1773277891;
const newTrades = db.prepare("SELECT id, gemini_market_id, direction, entry_price, exit_price, position_size, pnl, exit_reason, is_open, mode, created_at FROM prediction_trades WHERE mode='live' AND created_at > ? ORDER BY id DESC").all(fixTime);
console.log(`=== TRADES SINCE FIX (${newTrades.length}) ===`);
let postPnl = 0;
for (const t of newTrades) {
    const pnl = t.pnl || 0;
    postPnl += pnl;
    const sym = t.gemini_market_id.substring(0, 42);
    const status = t.is_open ? 'OPEN' : 'CLOSED';
    console.log(`#${t.id} ${sym} ${t.direction} entry=${t.entry_price} exit=${t.exit_price || '-'} sz=${t.position_size} pnl=${pnl.toFixed(3)} ${status} ${t.exit_reason || ''}`);
}
console.log(`\nPost-fix PnL: $${postPnl.toFixed(2)}`);

// Check ALL open positions
const open = db.prepare("SELECT id, gemini_market_id, direction, entry_price, position_size, take_profit_price, stop_loss_price FROM prediction_trades WHERE is_open=1 AND mode='live'").all();
console.log(`\n=== OPEN POSITIONS (${open.length}) ===`);
for (const t of open) {
    console.log(`#${t.id} ${t.gemini_market_id.substring(0,42)} ${t.direction} entry=${t.entry_price} sz=${t.position_size} TP=${t.take_profit_price} SL=${t.stop_loss_price}`);
}

// Recent rejections since fix
const recent = db.prepare("SELECT rejection_reason, COUNT(*) as cnt FROM entry_rejections WHERE timestamp > ? GROUP BY rejection_reason ORDER BY cnt DESC LIMIT 10").all(fixTime);
console.log('\n=== REJECTION REASONS SINCE FIX ===');
for (const r of recent) console.log(`  ${r.rejection_reason}: ${r.cnt}`);

// Check balance from Gemini (via paper wallet as proxy)
const wallet = db.prepare("SELECT * FROM paper_wallet LIMIT 1").get();
console.log(`\nPaper wallet balance: $${wallet?.balance}, initial: $${wallet?.initial_balance}`);

// Summarize all-time live trades
const allLive = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN pnl <= 0 AND is_open=0 THEN 1 ELSE 0 END) as losses, SUM(CASE WHEN is_open=1 THEN 1 ELSE 0 END) as still_open, SUM(CASE WHEN is_open=0 THEN pnl ELSE 0 END) as total_pnl FROM prediction_trades WHERE mode='live'").get();
console.log(`\n=== ALL-TIME LIVE SUMMARY ===`);
console.log(`Total: ${allLive.total} | Wins: ${allLive.wins} | Losses: ${allLive.losses} | Open: ${allLive.still_open}`);
console.log(`Total realized PnL: $${(allLive.total_pnl || 0).toFixed(2)}`);

db.close();
