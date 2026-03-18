#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNS = Math.max(1, Number(process.env.RUNS || 5));
const SESSION_SECONDS = Math.max(60, Number(process.env.SESSION_SECONDS || 120));
const POLL_SECONDS = Math.max(5, Number(process.env.POLL_SECONDS || 15));
const MAX_LIVE_OPEN = Math.max(1, Number(process.env.MAX_LIVE_OPEN || 1));
const DRIFT_CONFIRM_TICKS = Math.max(1, Number(process.env.DRIFT_CONFIRM_TICKS || 2));
const APPLY_PROFILE = String(process.env.APPLY_PROFILE || 'true').toLowerCase() !== 'false';
const EXECUTE_START = String(process.env.EXECUTE_START || 'true').toLowerCase() !== 'false';

const RESULT_PREFIX = 'CAPPED_SESSION_RESULT_JSON:';

function nowIso() {
    return new Date().toISOString();
}

function log(message, extra) {
    if (extra !== undefined) {
        console.log(`[${nowIso()}] ${message}`, extra);
    } else {
        console.log(`[${nowIso()}] ${message}`);
    }
}

function parseResultJson(stdout = '') {
    const lines = String(stdout || '').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith(RESULT_PREFIX)) continue;
        const raw = line.slice(RESULT_PREFIX.length);
        try {
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }
    return null;
}

function median(values = []) {
    const nums = values.filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
    if (nums.length === 0) return null;
    const mid = Math.floor(nums.length / 2);
    if (nums.length % 2 === 0) return (nums[mid - 1] + nums[mid]) / 2;
    return nums[mid];
}

function mergeCounts(target, source) {
    for (const [key, value] of Object.entries(source || {})) {
        target[key] = (target[key] || 0) + Number(value || 0);
    }
}

function runOnce(runNumber) {
    const args = ['scripts/run_capped_live_session.js'];
    if (EXECUTE_START) args.push('--execute-start');
    if (APPLY_PROFILE) args.push('--apply-profile');

    const env = {
        ...process.env,
        EMIT_RESULT_JSON: 'true',
        SESSION_SECONDS: String(SESSION_SECONDS),
        POLL_SECONDS: String(POLL_SECONDS),
        MAX_LIVE_OPEN: String(MAX_LIVE_OPEN),
        DRIFT_CONFIRM_TICKS: String(DRIFT_CONFIRM_TICKS)
    };

    const proc = spawnSync(process.execPath, args, {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 4
    });

    const parsed = parseResultJson(proc.stdout);
    const success = proc.status === 0 && parsed && parsed.success === true;

    return {
        run: runNumber,
        exit_code: proc.status,
        success,
        result: parsed,
        stdout_tail: (proc.stdout || '').split('\n').slice(-25).join('\n'),
        stderr_tail: (proc.stderr || '').split('\n').slice(-25).join('\n')
    };
}

function summarize(runs) {
    const succeeded = runs.filter(r => r.success && r.result && r.result.outcome);
    const failed = runs.filter(r => !r.success);

    const entered = [];
    const completedExits = [];
    const openPost = [];
    const groundTruthFlat = [];
    const reconcileFlat = [];
    const topRejections = {};

    for (const run of succeeded) {
        const outcome = run.result.outcome || {};
        const conversion = outcome.conversion || {};
        const diagnostics = outcome.diagnostics || {};
        const postRejections = diagnostics.post?.rejection_summary?.by_reason || {};

        entered.push(Number(conversion.entered_trade_count || 0));
        completedExits.push(Number(conversion.completed_exit_count || 0));
        openPost.push(Number(conversion.open_live_post_count || 0));
        groundTruthFlat.push(outcome.ground_truth_flat === true ? 1 : 0);
        reconcileFlat.push(conversion.reconcile_flat === true ? 1 : 0);
        mergeCounts(topRejections, postRejections);
    }

    const topRejectionList = Object.entries(topRejections)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([reason, count]) => ({ reason, count }));

    return {
        total_runs: runs.length,
        success_count: succeeded.length,
        failed_count: failed.length,
        medians: {
            entered_trade_count: median(entered),
            completed_exit_count: median(completedExits),
            open_live_post_count: median(openPost)
        },
        flatness: {
            ground_truth_flat_runs: groundTruthFlat.reduce((a, b) => a + b, 0),
            reconcile_flat_runs: reconcileFlat.reduce((a, b) => a + b, 0)
        },
        top_rejection_reasons: topRejectionList,
        failed_runs: failed.map(f => ({
            run: f.run,
            exit_code: f.exit_code,
            error: f.result?.error || 'no_result_json'
        }))
    };
}

function main() {
    log(`Starting capped-session batch: runs=${RUNS}, execute=${EXECUTE_START}, apply_profile=${APPLY_PROFILE}`);

    const allRuns = [];
    for (let i = 1; i <= RUNS; i++) {
        log(`Running session ${i}/${RUNS}...`);
        const result = runOnce(i);
        allRuns.push(result);

        if (!result.success) {
            log(`Run ${i} failed`, {
                exit_code: result.exit_code,
                error: result.result?.error || 'no_result_json'
            });
        } else {
            const conv = result.result?.outcome?.conversion || {};
            log(`Run ${i} success`, {
                entered: conv.entered_trade_count,
                exits: conv.completed_exit_count,
                ground_truth_flat: result.result?.outcome?.ground_truth_flat,
                reconcile_flat: conv.reconcile_flat
            });
        }
    }

    const summary = summarize(allRuns);
    const payload = {
        generated_at: nowIso(),
        config: {
            runs: RUNS,
            execute_start: EXECUTE_START,
            apply_profile: APPLY_PROFILE,
            session_seconds: SESSION_SECONDS,
            poll_seconds: POLL_SECONDS,
            max_live_open: MAX_LIVE_OPEN,
            drift_confirm_ticks: DRIFT_CONFIRM_TICKS
        },
        summary,
        runs: allRuns
    };

    const outDir = path.join(process.cwd(), 'test-results');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(outDir, `capped_session_batch_${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));

    log('Batch complete', {
        output: outFile,
        total_runs: summary.total_runs,
        success_count: summary.success_count,
        failed_count: summary.failed_count,
        medians: summary.medians
    });

    if (summary.failed_count > 0) {
        process.exitCode = 1;
    }
}

main();
