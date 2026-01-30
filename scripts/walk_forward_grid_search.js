#!/usr/bin/env node
/**
 * Grid search over TP/SL using walk-forward evaluation
 * Usage: node scripts/walk_forward_grid_search.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TPs = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0];
const SLs = [0.2, 0.5, 1.0, 2.0];
const results = [];

function runWalk(candidate) {
    const cmd = `node scripts/walk_forward_backtest.js --candidate='${JSON.stringify(candidate)}' --folds=5`;
    const out = execSync(cmd, { encoding: 'utf8' });
    // parse saved JSON file path from output
    const match = out.match(/Walk-forward complete\. Summary saved to (.*\.json)/);
    if (match) {
        const jsonPath = match[1].trim();
        const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const avgPnl = j.results.reduce((s,r)=>s + r.metrics.totalPnl,0)/j.results.length;
        return { candidate, avgPnl, j };
    }
    return null;
}

(async () => {
    if (!fs.existsSync(path.join(__dirname,'..','logs'))) fs.mkdirSync(path.join(__dirname,'..','logs'));
    for (const tp of TPs) {
        for (const sl of SLs) {
            const cand = { tp: tp, sl: sl, trail_start: 0.3, trail_stop: 0.1 };
            try {
                const r = runWalk(cand);
                if (r) results.push(r);
                console.log(`TP=${tp} SL=${sl} avgPnl=${r.avgPnl.toFixed(2)}`);
            } catch (e) {
                console.error('Error running candidate', tp, sl, e.message);
            }
        }
    }
    results.sort((a,b)=> b.avgPnl - a.avgPnl);
    const outPath = path.join(__dirname, '..', 'logs', `walk_forward_grid_${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(results.slice(0,10), null, 2));
    console.log('\nTop candidates saved to', outPath);
    console.log(results.slice(0,10).map(r => ({tp: r.candidate.tp, sl: r.candidate.sl, avgPnl: r.avgPnl})).slice(0,10));
})();
