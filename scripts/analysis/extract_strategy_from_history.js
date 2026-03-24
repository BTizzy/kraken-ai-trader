#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'prediction_markets.db');
const OUT_DIR = path.join(__dirname, '..', 'test-results');
const OUT_RULES = path.join(__dirname, '..', 'config', 'data_mined_strategy_rules.json');
const BOOKKEEPING_EXIT_REASONS = new Set([
  'reconcile_no_exchange',
  'manual_reconcile_no_exchange',
  'exchange_cancelled'
]);
const ROBUST_MAX_ABS_PNL = Number(process.env.ROBUST_MAX_ABS_PNL || 5);

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function pct(numer, denom) {
  if (!Number.isFinite(numer) || !Number.isFinite(denom) || denom === 0) return 0;
  return numer / denom;
}

function summarize(trades) {
  const total = trades.length;
  const wins = trades.filter(t => Number(t.pnl || 0) > 0).length;
  const pnl = trades.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const avg = total > 0 ? pnl / total : 0;
  return { total, wins, losses: total - wins, win_rate: pct(wins, total), pnl, avg_pnl: avg };
}

function bucketSpread(spread) {
  if (!Number.isFinite(spread)) return 'unknown';
  if (spread < 0.03) return '<3c';
  if (spread < 0.06) return '3-6c';
  if (spread < 0.10) return '6-10c';
  return '>=10c';
}

function bucketScore(score) {
  if (!Number.isFinite(score)) return 'unknown';
  if (score < 45) return '<45';
  if (score < 55) return '45-55';
  if (score < 65) return '55-65';
  return '>=65';
}

function groupBy(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const key = keyFn(t);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return map;
}

function evaluateGroups(grouped, minTrades = 8) {
  const rows = [];
  for (const [key, arr] of grouped.entries()) {
    const s = summarize(arr);
    if (s.total < minTrades) continue;
    rows.push({ key, ...s });
  }
  rows.sort((a, b) => b.pnl - a.pnl);
  return rows;
}

function pickAvoidGroups(groups, baselineAvgPnl, options = {}) {
  const {
    minTrades = 20,
    minDelta = 0.05,
    maxShare = 0.5,
    excludeKeys = []
  } = options;
  const excluded = new Set(excludeKeys);
  const candidates = groups.filter(g =>
    g.total >= minTrades &&
    !excluded.has(g.key) &&
    g.avg_pnl < (baselineAvgPnl - minDelta)
  );

  // Never block the majority of traffic from one dimension.
  const totalTrades = groups.reduce((s, g) => s + g.total, 0);
  let blocked = 0;
  const picked = [];
  for (const g of candidates.sort((a, b) => a.avg_pnl - b.avg_pnl)) {
    if (totalTrades > 0 && (blocked + g.total) / totalTrades > maxShare) continue;
    picked.push(g.key);
    blocked += g.total;
  }
  return picked;
}

function formatCompoundKey(parts) {
  return parts.join(' | ');
}

function hasRobustPositiveExpectancy(groups, options = {}) {
  const minTrades = Number(options.minTrades || 20);
  const minAvgPnl = Number(options.minAvgPnl || 0);
  const minWinRate = Number(options.minWinRate || 0.15);
  return groups.some(group =>
    group.total >= minTrades &&
    group.avg_pnl > minAvgPnl &&
    group.win_rate >= minWinRate
  );
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const windowSec = Number(process.env.STRATEGY_WINDOW_DAYS || 14) * 86400;
  const startTs = nowSec() - windowSec;

  const trades = db.prepare(`
    SELECT id, mode, category, direction, pnl, exit_reason, created_at,
           opportunity_score, gemini_actual_spread, gemini_market_id
    FROM prediction_trades
    WHERE is_open = 0
      AND created_at >= ?
      AND mode IN ('live', 'paper')
  `).all(startTs).map(t => ({
    ...t,
    pnl: Number(t.pnl || 0),
    opportunity_score: Number(t.opportunity_score || 0),
    gemini_actual_spread: Number(t.gemini_actual_spread || NaN)
  }));

  const live = trades.filter(t => t.mode === 'live');
  const paper = trades.filter(t => t.mode === 'paper');
  const robustLive = live.filter(t =>
    !BOOKKEEPING_EXIT_REASONS.has(String(t.exit_reason || '')) &&
    Math.abs(Number(t.pnl || 0)) <= ROBUST_MAX_ABS_PNL
  );

  const spreadGroups = evaluateGroups(groupBy(trades, t => bucketSpread(t.gemini_actual_spread)), 10);
  const scoreGroups = evaluateGroups(groupBy(trades, t => bucketScore(t.opportunity_score)), 10);
  const categoryGroups = evaluateGroups(groupBy(trades, t => t.category || 'unknown'), 8);
  const directionGroups = evaluateGroups(groupBy(trades, t => t.direction || 'unknown'), 8);
  const reasonGroups = evaluateGroups(groupBy(trades, t => t.exit_reason || 'unknown'), 6);
  const robustLiveCompoundGroups = evaluateGroups(groupBy(robustLive, t => formatCompoundKey([
    t.category || 'unknown',
    t.direction || 'unknown',
    bucketScore(t.opportunity_score),
    bucketSpread(t.gemini_actual_spread)
  ])), 5);
  const robustLiveExitGroups = evaluateGroups(groupBy(robustLive, t => t.exit_reason || 'unknown'), 4);

  const allSummary = summarize(trades);
  const liveSummary = summarize(live);
  const paperSummary = summarize(paper);
  const robustLiveSummary = summarize(robustLive);

  // Build mined rules from cohorts that are materially worse than baseline.
  const baselineAvg = allSummary.avg_pnl;
  const badSpreads = pickAvoidGroups(spreadGroups, baselineAvg, {
    minTrades: 25,
    minDelta: 0.07,
    maxShare: 0.45,
    excludeKeys: ['unknown']
  });
  const badScores = pickAvoidGroups(scoreGroups, baselineAvg, {
    minTrades: 20,
    minDelta: 0.06,
    maxShare: 0.60,
    excludeKeys: ['unknown']
  });
  const badCategories = pickAvoidGroups(categoryGroups, baselineAvg, {
    minTrades: 20,
    minDelta: 0.05,
    maxShare: 0.60,
    excludeKeys: ['unknown']
  });

  const directionBias = (() => {
    const byDir = Object.fromEntries(directionGroups.map(g => [g.key, g]));
    const yes = byDir.YES;
    const no = byDir.NO;
    if (!yes || !no) return 'neutral';
    if (no.total >= 30 && no.avg_pnl > yes.avg_pnl + 0.08) return 'prefer_no';
    if (yes.total >= 30 && yes.avg_pnl > no.avg_pnl + 0.08) return 'prefer_yes';
    return 'neutral';
  })();

  const suspendLiveEntriesRecommended = !hasRobustPositiveExpectancy(robustLiveCompoundGroups, {
    minTrades: 20,
    minAvgPnl: 0,
    minWinRate: 0.15
  });

  const rules = {
    generated_at: new Date().toISOString(),
    window_days: Number(process.env.STRATEGY_WINDOW_DAYS || 14),
    counts: {
      closed_trades: allSummary.total,
      live_closed_trades: liveSummary.total,
      paper_closed_trades: paperSummary.total
    },
    global: {
      min_entry_score_recommended: (() => {
        const good = scoreGroups.filter(g => g.pnl > 0);
        if (good.length === 0) return 60;
        const keys = good.map(g => g.key);
        if (keys.includes('>=65')) return 65;
        if (keys.includes('55-65')) return 55;
        if (keys.includes('45-55')) return 45;
        return 60;
      })(),
      direction_bias: directionBias,
      avoid_spread_buckets: badSpreads,
      avoid_score_buckets: badScores,
      avoid_categories: badCategories,
      suspend_live_entries: suspendLiveEntriesRecommended
    },
    diagnostics: {
      overall: allSummary,
      live: liveSummary,
      paper: paperSummary,
      robust_live: {
        summary: robustLiveSummary,
        bookkeeping_exit_reasons_excluded: Array.from(BOOKKEEPING_EXIT_REASONS),
        max_abs_pnl_included: ROBUST_MAX_ABS_PNL,
        suspend_live_entries_recommended: suspendLiveEntriesRecommended,
        top_compound_cohorts: robustLiveCompoundGroups.slice(0, 10),
        exit_reasons: robustLiveExitGroups
      },
      by_spread: spreadGroups,
      by_score: scoreGroups,
      by_category: categoryGroups,
      by_direction: directionGroups,
      by_exit_reason: reasonGroups
    }
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'strategy_from_history.json'), JSON.stringify(rules, null, 2));
  fs.writeFileSync(OUT_RULES, JSON.stringify(rules.global, null, 2));

  console.log(JSON.stringify({
    written: {
      full_report: path.join('test-results', 'strategy_from_history.json'),
      rules: path.join('config', 'data_mined_strategy_rules.json')
    },
    summary: {
      overall: allSummary,
      live: liveSummary,
      paper: paperSummary
    },
    recommended: rules.global
  }, null, 2));

  db.close();
}

main();
