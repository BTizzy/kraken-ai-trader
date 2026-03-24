#!/usr/bin/env node
/**
 * Backtest Prediction Strategy
 * 
 * Replays historical market data through the signal detector and paper trading
 * engine to evaluate strategy performance over time.
 * 
 * Usage:
 *   node scripts/backtest_prediction_strategy.js [--days 30] [--params config/prediction_params.json]
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { Logger } = require('../lib/logger');
const PredictionDatabase = require('../lib/prediction_db');
const SignalDetector = require('../lib/signal_detector');

const log = new Logger('BACKTEST');

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const LOOKBACK_DAYS = parseInt(getArg('days', '30'), 10);
const PARAMS_FILE = getArg('params', path.join(__dirname, '..', 'config', 'prediction_params.json'));

// --- Load parameters ---
let params;
try {
  params = JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf-8'));
} catch (e) {
  log.warn(`Could not load params from ${PARAMS_FILE}, using defaults`);
  params = {
    signal_threshold: 55,
    min_edge: 0.08,
    max_position_pct: 0.12,
    take_profit: 0.10,
    stop_loss: 0.05,
    kelly_fraction: 0.25
  };
}

// --- Setup ---
const DB_PATH = path.join(__dirname, '..', 'data', 'prediction_markets.db');
const db = new PredictionDatabase(DB_PATH);
const detector = new SignalDetector(db);

function run() {
  log.info(`=== Prediction Strategy Backtest ===`);
  log.info(`Lookback: ${LOOKBACK_DAYS} days | Signal threshold: ${params.signal_threshold}`);

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  // Fetch historical prices
  const prices = db.db.prepare(`
    SELECT mp.*, m.title, m.category, m.platform
    FROM market_prices mp
    JOIN markets m ON mp.market_id = m.market_id
    WHERE mp.timestamp >= ?
    ORDER BY mp.timestamp ASC
  `).all(cutoff);

  if (!prices.length) {
    log.warn('No historical price data found. Run the bot first to collect data.');
    process.exit(0);
  }

  log.info(`Loaded ${prices.length} price snapshots across markets`);

  // Group by market
  const byMarket = {};
  for (const p of prices) {
    if (!byMarket[p.market_id]) byMarket[p.market_id] = [];
    byMarket[p.market_id].push(p);
  }

  const marketIds = Object.keys(byMarket);
  log.info(`Markets with data: ${marketIds.length}`);

  // --- Simulate ---
  let wallet = 500;
  const trades = [];
  const positions = {};
  let totalSignals = 0;
  let qualifiedSignals = 0;

  for (const marketId of marketIds) {
    const snapshots = byMarket[marketId];
    if (snapshots.length < 3) continue;

    // Feed prices into detector to build velocity
    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i];
      const price = snap.yes_price || snap.last_price || 0.5;

      // Record for velocity calculation
      detector.recordPrice(marketId, price);

      if (i < 2) continue; // Need at least 3 points

      // Score opportunity
      const signal = {
        market_id: marketId,
        title: snap.title,
        platform: snap.platform,
        category: snap.category || 'unknown',
        yes_price: price,
        no_price: 1 - price,
        spread: Math.abs(price - (1 - price)),
        velocity: detector.calculatePriceVelocity(marketId),
        timestamp: snap.timestamp
      };

      const score = detector.scoreOpportunity(signal);
      totalSignals++;

      if (score.total >= params.signal_threshold && score.total < 95) {
        qualifiedSignals++;
        const direction = detector.determineDirection(signal);

        // Check if we already have a position
        if (positions[marketId]) continue;

        // Position sizing (simplified Kelly)
        const edge = score.total / 100 - 0.5;
        if (edge < params.min_edge) continue;

        const kellyFraction = Math.min(
          edge / (1 - edge) * params.kelly_fraction,
          params.max_position_pct
        );
        const positionSize = Math.round(wallet * kellyFraction);
        if (positionSize < 5 || positionSize > wallet * 0.15) continue;

        const entryPrice = direction === 'YES' ? price : (1 - price);
        const tp = direction === 'YES'
          ? entryPrice - params.take_profit
          : entryPrice + params.take_profit;
        const sl = direction === 'YES'
          ? entryPrice + params.stop_loss
          : entryPrice - params.stop_loss;

        positions[marketId] = {
          market_id: marketId,
          title: snap.title,
          direction,
          entry_price: entryPrice,
          take_profit: tp,
          stop_loss: sl,
          amount: positionSize,
          contracts: Math.floor(positionSize / entryPrice),
          entry_idx: i,
          score: score.total
        };

        wallet -= positionSize;
      }

      // Check exits for open positions
      for (const [posMarketId, pos] of Object.entries(positions)) {
        if (posMarketId !== marketId) continue;

        const currentPrice = pos.direction === 'YES' ? price : (1 - price);
        const holdBars = i - pos.entry_idx;

        let exitReason = null;
        if (pos.direction === 'YES' && currentPrice <= pos.take_profit) exitReason = 'take_profit';
        else if (pos.direction === 'YES' && currentPrice >= pos.stop_loss) exitReason = 'stop_loss';
        else if (pos.direction === 'NO' && currentPrice >= pos.take_profit) exitReason = 'take_profit';
        else if (pos.direction === 'NO' && currentPrice <= pos.stop_loss) exitReason = 'stop_loss';
        else if (holdBars >= 60) exitReason = 'time_exit'; // 60 snapshots ~2min

        if (exitReason) {
          const pnl = (pos.entry_price - currentPrice) * pos.contracts;
          wallet += pos.amount + pnl;

          trades.push({
            market_id: posMarketId,
            title: pos.title,
            direction: pos.direction,
            entry_price: pos.entry_price,
            exit_price: currentPrice,
            pnl: pnl,
            amount: pos.amount,
            exit_reason: exitReason,
            hold_bars: holdBars,
            score: pos.score
          });

          delete positions[posMarketId];
        }
      }
    }
  }

  // Force-close remaining positions at last known price
  for (const [marketId, pos] of Object.entries(positions)) {
    const lastSnap = byMarket[marketId][byMarket[marketId].length - 1];
    const lastPrice = lastSnap.yes_price || lastSnap.last_price || 0.5;
    const currentPrice = pos.direction === 'YES' ? lastPrice : (1 - lastPrice);
    const pnl = (pos.entry_price - currentPrice) * pos.contracts;
    wallet += pos.amount + pnl;

    trades.push({
      market_id: marketId,
      title: pos.title,
      direction: pos.direction,
      entry_price: pos.entry_price,
      exit_price: currentPrice,
      pnl: pnl,
      amount: pos.amount,
      exit_reason: 'end_of_data',
      hold_bars: 0,
      score: pos.score
    });
  }

  // --- Report ---
  console.log('\n' + '='.repeat(60));
  console.log('  BACKTEST RESULTS');
  console.log('='.repeat(60));
  console.log(`  Period:           ${LOOKBACK_DAYS} days`);
  console.log(`  Markets analyzed: ${marketIds.length}`);
  console.log(`  Price snapshots:  ${prices.length}`);
  console.log(`  Total signals:    ${totalSignals}`);
  console.log(`  Qualified:        ${qualifiedSignals} (${((qualifiedSignals / totalSignals) * 100).toFixed(1)}%)`);
  console.log(`  Trades executed:  ${trades.length}`);

  if (trades.length > 0) {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

    const byReason = {};
    for (const t of trades) {
      byReason[t.exit_reason] = (byReason[t.exit_reason] || 0) + 1;
    }

    console.log(`\n  --- Performance ---`);
    console.log(`  Starting capital: $500.00`);
    console.log(`  Final capital:    $${wallet.toFixed(2)}`);
    console.log(`  Total PnL:        $${totalPnl.toFixed(2)} (${((totalPnl / 500) * 100).toFixed(1)}%)`);
    console.log(`  Win rate:         ${((wins.length / trades.length) * 100).toFixed(1)}%`);
    console.log(`  Avg win:          $${avgWin.toFixed(2)}`);
    console.log(`  Avg loss:         $${avgLoss.toFixed(2)}`);
    console.log(`  Profit factor:    ${avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : 'N/A'}`);

    console.log(`\n  --- Exit Reasons ---`);
    for (const [reason, count] of Object.entries(byReason)) {
      console.log(`  ${reason.padEnd(15)} ${count}`);
    }

    // Top trades
    const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
    console.log(`\n  --- Top 5 Trades ---`);
    for (const t of sorted.slice(0, 5)) {
      console.log(`  ${t.direction} ${t.title.substring(0, 35).padEnd(35)} PnL: $${t.pnl.toFixed(2)} (${t.exit_reason})`);
    }
    console.log(`\n  --- Worst 5 Trades ---`);
    for (const t of sorted.slice(-5)) {
      console.log(`  ${t.direction} ${t.title.substring(0, 35).padEnd(35)} PnL: $${t.pnl.toFixed(2)} (${t.exit_reason})`);
    }
  } else {
    console.log('\n  No trades executed — insufficient data or no qualifying signals.');
  }

  console.log('\n' + '='.repeat(60));

  db.close();
}

run();
