#!/usr/bin/env node
/**
 * Orchestrate sequential aggressive paper runs for a list of candidate parameter sets.
 * Usage:
 *   node scripts/orchestrate_paper_experiments.js --candidates='[{},{}]' --duration=3600
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const argv = require('minimist')(process.argv.slice(2));
const sqlite3 = require('sqlite3').verbose();

const CAND_JSON = argv.candidates || argv.c || null;
const CAND_FILE = argv['candidates-file'] || argv.cfile || null;
const TOP_N = parseInt(argv.top || argv.t || '10', 10);
const DURATION = parseInt(argv.duration || argv.d || '3600', 10);
const LOGDIR = path.resolve(process.cwd(), 'logs');
const MON_STOP = argv['monitor-stop'] || argv['monitor_stop'] || process.env.MONITOR_STOP_LOSS || '-200';
const MON_PROF = argv['monitor-profit'] || argv['monitor_profit'] || process.env.MONITOR_PROFIT_TARGET || '500';
const LOOP = argv.loop || false;
if (!CAND_JSON && !CAND_FILE) {
    console.error('Usage: --candidates JSON_ARRAY --candidates-file <file> --duration seconds');
    process.exit(2);
}

let candidates;
if (CAND_FILE) {
    try {
        const raw = fs.readFileSync(CAND_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        candidates = Array.isArray(parsed) ? parsed.slice(0, TOP_N) : [parsed];
    } catch (e) { console.error('Failed to read candidates file:', e.message); process.exit(2); }
} else {
    try { candidates = JSON.parse(CAND_JSON); } catch (e) { console.error('Failed to parse candidates JSON:', e.message); process.exit(2); }
    if (!Array.isArray(candidates)) candidates = [candidates];
}

function getTotalPnl(cb) {
    const db = new sqlite3.Database('./data/trades.db', sqlite3.OPEN_READONLY, (err) => {
        if (err) return cb(err);
        db.get('SELECT SUM(pnl) as total FROM trades', (e,row) => {
            db.close();
            if (e) return cb(e);
            cb(null, row ? (row.total || 0) : 0);
        });
    });
}

async function runCandidate(candidate, idx) {
    return new Promise((resolve) => {
        const ts = new Date().toISOString().replace(/[:.]/g,'-');
        const runLog = path.join(LOGDIR, `experiment_${idx}_${ts}.log`);
        console.log(`Starting candidate #${idx} log=${runLog}`);

        getTotalPnl((err, initial) => {
            if (err) initial = 0;
            const candStr = JSON.stringify(candidate);
            const env = Object.assign({}, process.env, { MONITOR_STOP_LOSS: String(MON_STOP), MONITOR_PROFIT_TARGET: String(MON_PROF) });
            const child = spawn('bash', ['scripts/run_aggressive_paper.sh', candStr, String(DURATION)], { stdio: ['ignore','ignore','ignore'], env });
            child.on('exit', (code, sig) => {
                // After run, compute final PnL
                getTotalPnl((err2, final) => {
                    if (err2) final = initial;
                    const delta = (final || 0) - (initial || 0);
                    const summary = { candidate: candidate, duration: DURATION, initial_total: initial, final_total: final, delta: delta, exit_code: code, signal: sig, timestamp: new Date().toISOString() };
                    const outFile = path.join(LOGDIR, `experiment_result_${idx}_${ts}.json`);
                    fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
                    console.log(`Candidate #${idx} complete. PnL delta=${delta.toFixed(2)} summary=${outFile}`);
                    // Update directional rules from latest trades (offline analysis)
                    try {
                        const a = spawn('node', ['scripts/analyze_directional_misfires.js'], { stdio: 'inherit' });
                        a.on('exit', () => console.log('Directional analysis updated'));
                    } catch (e) { console.error('Failed to run directional analysis:', e.message); }
                    try {
                        const t = spawn('node', ['scripts/train_direction_model.js'], { stdio: 'inherit' });
                        t.on('exit', () => console.log('Direction model retrained'));
                    } catch (e) { console.error('Failed to retrain direction model:', e.message); }
                    resolve(summary);
                });
            });
        });
    });
}

(async () => {
    if (!fs.existsSync(LOGDIR)) fs.mkdirSync(LOGDIR);
    const results = [];
    for (let i = 0; i < candidates.length; i++) {
        try {
            const r = await runCandidate(candidates[i], i+1);
            results.push(r);
        } catch (e) {
            console.error('Candidate run failed:', e.message);
        }
    }
    if (LOOP) {
        console.log('Loop mode enabled; restarting orchestrator');
        // Simple restart: spawn a new orchestrator process with same args
        const args = process.argv.slice(1);
        const re = spawn('node', args, { stdio: 'inherit' });
        re.on('exit', () => process.exit(0));
        return;
    }
    const master = { generatedAt: new Date().toISOString(), results };
    const outPath = path.join(LOGDIR, `experiment_master_${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    fs.writeFileSync(outPath, JSON.stringify(master, null, 2));
    console.log('All experiments complete. Master summary:', outPath);
    process.exit(0);
})();
