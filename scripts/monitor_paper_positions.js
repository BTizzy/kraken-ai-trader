#!/usr/bin/env node
/**
 * Monitor Paper Positions
 * 
 * Real-time CLI monitor for active paper trading positions.
 * Shows open positions, P&L, and recent trade history.
 * 
 * Usage:
 *   node scripts/monitor_paper_positions.js [--refresh 5]
 */

'use strict';

const path = require('path');
const PredictionDatabase = require('../lib/prediction_db');
const { Logger } = require('../lib/logger');

const log = new Logger('MONITOR');

const args = process.argv.slice(2);
const refreshIdx = args.indexOf('--refresh');
const REFRESH_SEC = refreshIdx !== -1 && args[refreshIdx + 1]
  ? parseInt(args[refreshIdx + 1], 10) : 5;

const DB_PATH = path.join(__dirname, '..', 'data', 'prediction_markets.db');
let db;

try {
  db = new PredictionDatabase(DB_PATH);
} catch (e) {
  console.error('Cannot open database. Is the bot running?', e.message);
  process.exit(1);
}

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function colorPnl(val) {
  if (val > 0) return `\x1b[32m+$${val.toFixed(2)}\x1b[0m`;
  if (val < 0) return `\x1b[31m-$${Math.abs(val).toFixed(2)}\x1b[0m`;
  return `$${val.toFixed(2)}`;
}

function formatTime(iso) {
  if (!iso) return 'N/A';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

function holdTime(entryIso) {
  if (!entryIso) return '?';
  const ms = Date.now() - new Date(entryIso).getTime();
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function render() {
  clearScreen();

  const now = new Date().toLocaleString();
  console.log(`\x1b[1m📊 Paper Position Monitor\x1b[0m  |  ${now}  |  Refresh: ${REFRESH_SEC}s\n`);

  // Wallet
  const wallet = db.getWallet();
  if (wallet) {
    const totalReturn = ((wallet.balance - wallet.initial_balance) / wallet.initial_balance * 100).toFixed(2);
    const color = wallet.balance >= wallet.initial_balance ? '\x1b[32m' : '\x1b[31m';
    console.log(`  💰 Balance: ${color}$${wallet.balance.toFixed(2)}\x1b[0m`
      + `  |  Initial: $${wallet.initial_balance.toFixed(2)}`
      + `  |  Return: ${color}${totalReturn}%\x1b[0m`
      + `  |  Trades: ${wallet.total_trades}`
      + `  |  Win Rate: ${wallet.total_trades > 0 ? ((wallet.winning_trades / wallet.total_trades) * 100).toFixed(0) : 0}%`
    );
  }

  // Open positions
  const openTrades = db.db.prepare(`
    SELECT t.*, m.title
    FROM prediction_trades t
    LEFT JOIN markets m ON t.market_id = m.market_id
    WHERE t.status = 'open'
    ORDER BY t.entry_time DESC
  `).all();

  console.log(`\n\x1b[1m  Open Positions (${openTrades.length})\x1b[0m`);
  if (openTrades.length === 0) {
    console.log('  (none)');
  } else {
    console.log('  ' + '-'.repeat(100));
    console.log('  ' + [
      'Direction'.padEnd(6),
      'Market'.padEnd(40),
      'Entry'.padEnd(8),
      'TP'.padEnd(8),
      'SL'.padEnd(8),
      'Amount'.padEnd(10),
      'Hold'.padEnd(8),
      'Score'.padEnd(6)
    ].join(' '));
    console.log('  ' + '-'.repeat(100));

    for (const t of openTrades) {
      const title = (t.title || t.market_id).substring(0, 38);
      console.log('  ' + [
        (t.direction || '?').padEnd(6),
        title.padEnd(40),
        (t.entry_price != null ? t.entry_price.toFixed(3) : '?').padEnd(8),
        (t.take_profit != null ? t.take_profit.toFixed(3) : '?').padEnd(8),
        (t.stop_loss != null ? t.stop_loss.toFixed(3) : '?').padEnd(8),
        ('$' + (t.amount || 0).toFixed(0)).padEnd(10),
        holdTime(t.entry_time).padEnd(8),
        String(t.signal_score || '?').padEnd(6)
      ].join(' '));
    }
  }

  // Recent closed trades
  const recentTrades = db.db.prepare(`
    SELECT t.*, m.title
    FROM prediction_trades t
    LEFT JOIN markets m ON t.market_id = m.market_id
    WHERE t.status = 'closed'
    ORDER BY t.exit_time DESC
    LIMIT 15
  `).all();

  console.log(`\n\x1b[1m  Recent Trades (last 15)\x1b[0m`);
  if (recentTrades.length === 0) {
    console.log('  (none yet)');
  } else {
    console.log('  ' + '-'.repeat(110));
    console.log('  ' + [
      'Dir'.padEnd(4),
      'Market'.padEnd(35),
      'Entry'.padEnd(7),
      'Exit'.padEnd(7),
      'PnL'.padEnd(12),
      'Amount'.padEnd(8),
      'Reason'.padEnd(12),
      'Time'.padEnd(8)
    ].join(' '));
    console.log('  ' + '-'.repeat(110));

    for (const t of recentTrades) {
      const title = (t.title || t.market_id).substring(0, 33);
      console.log('  ' + [
        (t.direction || '?').padEnd(4),
        title.padEnd(35),
        (t.entry_price != null ? t.entry_price.toFixed(3) : '?').padEnd(7),
        (t.exit_price != null ? t.exit_price.toFixed(3) : '?').padEnd(7),
        colorPnl(t.pnl || 0).padEnd(22), // extra pad for ANSI codes
        ('$' + (t.amount || 0).toFixed(0)).padEnd(8),
        (t.exit_reason || '?').padEnd(12),
        formatTime(t.exit_time).padEnd(8)
      ].join(' '));
    }
  }

  // Daily stats
  const today = new Date().toISOString().slice(0, 10);
  const todayTrades = db.db.prepare(`
    SELECT COUNT(*) as count,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(pnl) as total_pnl,
           AVG(pnl) as avg_pnl
    FROM prediction_trades
    WHERE status = 'closed' AND DATE(exit_time) = ?
  `).get(today);

  console.log(`\n\x1b[1m  Today's Summary (${today})\x1b[0m`);
  if (todayTrades && todayTrades.count > 0) {
    console.log(`  Trades: ${todayTrades.count}`
      + `  |  Wins: ${todayTrades.wins}`
      + `  |  Win Rate: ${((todayTrades.wins / todayTrades.count) * 100).toFixed(0)}%`
      + `  |  PnL: ${colorPnl(todayTrades.total_pnl || 0)}`
      + `  |  Avg: ${colorPnl(todayTrades.avg_pnl || 0)}`
    );
  } else {
    console.log('  No trades today.');
  }

  // Signals count
  const signalCount = db.db.prepare(`
    SELECT COUNT(*) as count FROM signals WHERE DATE(detected_at) = ?
  `).get(today);
  console.log(`  Signals detected today: ${signalCount ? signalCount.count : 0}`);

  console.log(`\n  Press Ctrl+C to exit.`);
}

// --- Main loop ---
console.log('Starting position monitor...');
render();

const interval = setInterval(render, REFRESH_SEC * 1000);

process.on('SIGINT', () => {
  clearInterval(interval);
  db.close();
  console.log('\nMonitor stopped.');
  process.exit(0);
});
