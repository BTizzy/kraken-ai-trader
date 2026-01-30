#!/usr/bin/env node
/**
 * Watch logs for experiment results and auto-promote candidates that meet thresholds.
 * This runs in background and takes actions autonomously:
 *  - If an experiment_result shows delta >= PROMOTE_PNL (default 2000), run two validation runs.
 *  - If validations pass (both positive PnL), mark candidate as promoted and stop the orchestrator loop.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const argv = require('minimist')(process.argv.slice(2));

const LOGDIR = path.resolve(process.cwd(), 'logs');
const PROMOTE_PNL = parseFloat(process.env.PROMOTE_PNL || argv.promote_pnl || 2000);
const VALIDATION_DURATION = parseInt(process.env.VAL_DURATION || argv.val_dur || 3600, 10);

function scanOnce() {
    const files = fs.readdirSync(LOGDIR).filter(f => f.startsWith('experiment_result_') && f.endsWith('.json'));
    for (const f of files) {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(LOGDIR,f),'utf8'));
            if (j.delta && j.delta >= PROMOTE_PNL && !j.promoted) {
                console.log('Candidate meets promotion threshold:', j.candidate, 'delta=', j.delta);
                // Run two validation runs sequentially
                const candStr = JSON.stringify(j.candidate);
                const val1 = spawn('bash', ['scripts/run_aggressive_paper.sh', candStr, String(VALIDATION_DURATION)], { env: Object.assign({}, process.env, { MONITOR_STOP_LOSS: '-1000', MONITOR_PROFIT_TARGET: String(PROMOTE_PNL) }), stdio: 'inherit' });
                val1.on('exit', () => {
                    console.log('Validation run 1 complete. Starting validation run 2');
                    const val2 = spawn('bash', ['scripts/run_aggressive_paper.sh', candStr, String(VALIDATION_DURATION)], { env: Object.assign({}, process.env, { MONITOR_STOP_LOSS: '-1000', MONITOR_PROFIT_TARGET: String(PROMOTE_PNL) }), stdio: 'inherit' });
                    val2.on('exit', () => {
                        // Mark promoted in the result file
                        j.promoted = true; j.promotedAt = new Date().toISOString();
                        fs.writeFileSync(path.join(LOGDIR,f), JSON.stringify(j, null, 2));
                        console.log('Candidate promoted and marked in', f);
                        // Stop orchestrator loop by writing a sentinel file
                        fs.writeFileSync(path.join(LOGDIR,'promoted_candidate.json'), JSON.stringify(j, null, 2));
                        process.exit(0);
                    });
                });
                return true;
            }
        } catch (e) { /* ignore parse errors */ }
    }
    return false;
}

console.log('Starting auto-promotion watchdog (PROMOTE_PNL=', PROMOTE_PNL, ')');
setInterval(() => { scanOnce(); }, 30*1000);
scanOnce();
