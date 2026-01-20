/**
 * Sync Trade Log (JSON) to SQLite Database
 * 
 * The C++ bot writes to trade_log.json
 * This script syncs new trades to SQLite for easy analysis
 * 
 * Usage:
 *   node scripts/sync_to_sqlite.js           # One-time sync
 *   node scripts/sync_to_sqlite.js --watch   # Watch for changes
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const TRADE_LOG_PATH = path.join(__dirname, '../bot/build/trade_log.json');
const DB_PATH = path.join(__dirname, '../data/trades.db');

// Initialize database
const db = new Database(DB_PATH);

// Ensure table exists with all columns
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pair TEXT NOT NULL,
    direction TEXT,
    entry_price REAL,
    exit_price REAL,
    position_size REAL,
    leverage INTEGER DEFAULT 1,
    pnl REAL,
    gross_pnl REAL,
    fees_paid REAL,
    exit_reason TEXT,
    timestamp INTEGER,
    entry_time INTEGER,
    hold_time INTEGER,
    timeframe_seconds INTEGER,
    volatility_pct REAL,
    bid_ask_spread REAL,
    rsi REAL,
    macd_histogram REAL,
    macd_signal REAL,
    bb_position REAL,
    volume_ratio REAL,
    momentum_score REAL,
    atr_pct REAL,
    market_regime INTEGER,
    trend_direction INTEGER,
    fee_corrected INTEGER DEFAULT 0,
    pnl_original REAL,
    fee_correction_amount REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pair, timestamp)
  )
`);

// Create index for faster queries
db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair)`);

// Prepare insert statement
const insertTrade = db.prepare(`
  INSERT OR IGNORE INTO trades (
    pair, direction, entry_price, exit_price, position_size, leverage,
    pnl, gross_pnl, fees_paid, exit_reason, timestamp, entry_time, hold_time,
    timeframe_seconds, volatility_pct, bid_ask_spread, rsi, macd_histogram,
    macd_signal, bb_position, volume_ratio, momentum_score, atr_pct,
    market_regime, trend_direction, fee_corrected, pnl_original, fee_correction_amount
  ) VALUES (
    @pair, @direction, @entry_price, @exit_price, @position_size, @leverage,
    @pnl, @gross_pnl, @fees_paid, @exit_reason, @timestamp, @entry_time, @hold_time,
    @timeframe_seconds, @volatility_pct, @bid_ask_spread, @rsi, @macd_histogram,
    @macd_signal, @bb_position, @volume_ratio, @momentum_score, @atr_pct,
    @market_regime, @trend_direction, @fee_corrected, @pnl_original, @fee_correction_amount
  )
`);

function syncTrades() {
  if (!fs.existsSync(TRADE_LOG_PATH)) {
    console.log('Trade log not found:', TRADE_LOG_PATH);
    return { synced: 0, total: 0 };
  }

  const data = fs.readFileSync(TRADE_LOG_PATH, 'utf8');
  let tradeLog;
  
  try {
    tradeLog = JSON.parse(data);
  } catch (e) {
    console.error('Failed to parse trade log:', e.message);
    return { synced: 0, total: 0 };
  }

  const trades = tradeLog.trades || [];
  console.log(`Found ${trades.length} trades in JSON log`);

  // Get latest timestamp in DB
  const latestRow = db.prepare('SELECT MAX(timestamp) as latest FROM trades').get();
  const latestTimestamp = latestRow.latest || 0;
  console.log(`Latest trade in SQLite: ${latestTimestamp ? new Date(latestTimestamp).toLocaleString() : 'none'}`);

  // Filter new trades
  const newTrades = trades.filter(t => (t.timestamp || 0) > latestTimestamp);
  console.log(`New trades to sync: ${newTrades.length}`);

  let synced = 0;
  const insertMany = db.transaction((tradesToInsert) => {
    for (const trade of tradesToInsert) {
      try {
        insertTrade.run({
          pair: trade.pair || '',
          direction: trade.direction || 'LONG',
          entry_price: trade.entry_price || 0,
          exit_price: trade.exit_price || 0,
          position_size: trade.position_size || trade.position_size_usd || 100,
          leverage: trade.leverage || 1,
          pnl: trade.pnl_usd || trade.pnl || 0,
          gross_pnl: trade.gross_pnl || trade.pnl_usd || trade.pnl || 0,
          fees_paid: trade.fees_paid || 0,
          exit_reason: trade.exit_reason || 'unknown',
          timestamp: trade.timestamp || Date.now(),
          entry_time: trade.entry_time || trade.timestamp || Date.now(),
          hold_time: trade.hold_time_seconds || trade.hold_time || 0,
          timeframe_seconds: trade.timeframe_seconds || 600,
          volatility_pct: trade.volatility_at_entry || trade.volatility_pct || 0,
          bid_ask_spread: trade.spread_at_entry || trade.bid_ask_spread || 0,
          rsi: trade.rsi || 0,
          macd_histogram: trade.macd_histogram || 0,
          macd_signal: trade.macd_signal || 0,
          bb_position: trade.bb_position || 0,
          volume_ratio: trade.volume_ratio || 0,
          momentum_score: trade.momentum_score || 0,
          atr_pct: trade.atr_pct || 0,
          market_regime: trade.market_regime || 0,
          trend_direction: trade.trend_direction || 0,
          fee_corrected: trade.fee_corrected_at ? 1 : 0,
          pnl_original: trade.pnl_original || null,
          fee_correction_amount: trade.fee_correction_amount || null
        });
        synced++;
      } catch (e) {
        // Ignore duplicate errors
        if (!e.message.includes('UNIQUE constraint')) {
          console.error(`Error inserting trade ${trade.pair}:`, e.message);
        }
      }
    }
  });

  insertMany(newTrades);

  // Print stats
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winners,
      SUM(pnl) as total_pnl
    FROM trades
  `).get();

  console.log('\n=== SQLite Database Stats ===');
  console.log(`Total trades: ${stats.total}`);
  console.log(`Winners: ${stats.winners}`);
  console.log(`Win rate: ${(stats.winners / stats.total * 100).toFixed(1)}%`);
  console.log(`Total P&L: $${stats.total_pnl.toFixed(2)}`);

  return { synced, total: stats.total };
}

// Watch mode
if (process.argv.includes('--watch')) {
  console.log('Starting watch mode...');
  console.log(`Watching: ${TRADE_LOG_PATH}\n`);
  
  syncTrades();
  
  let lastMtime = fs.existsSync(TRADE_LOG_PATH) 
    ? fs.statSync(TRADE_LOG_PATH).mtime.getTime() 
    : 0;
  
  setInterval(() => {
    if (!fs.existsSync(TRADE_LOG_PATH)) return;
    
    const currentMtime = fs.statSync(TRADE_LOG_PATH).mtime.getTime();
    if (currentMtime > lastMtime) {
      console.log(`\n[${new Date().toLocaleTimeString()}] Trade log updated, syncing...`);
      syncTrades();
      lastMtime = currentMtime;
    }
  }, 10000); // Check every 10 seconds
} else {
  // One-time sync
  const result = syncTrades();
  console.log(`\nSynced ${result.synced} new trades. Total in DB: ${result.total}`);
  db.close();
}
