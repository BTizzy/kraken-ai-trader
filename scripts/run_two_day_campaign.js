#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RESULT_PREFIX = 'CAPPED_SESSION_RESULT_JSON:';

function readFlagNumber(name, fallback) {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return fallback;
    const value = Number(process.argv[idx + 1]);
    return Number.isFinite(value) ? value : fallback;
}

function readFlagBool(name, fallback) {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return fallback;
    const raw = String(process.argv[idx + 1] ?? '').toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes') return true;
    if (raw === 'false' || raw === '0' || raw === 'no') return false;
    return fallback;
}

const HOURS = Math.max(1, readFlagNumber('--hours', Number(process.env.CAMPAIGN_HOURS || 2)));
const SESSION_SECONDS = Math.max(60, readFlagNumber('--session-seconds', Number(process.env.SESSION_SECONDS || 900)));
const POLL_SECONDS = Math.max(5, readFlagNumber('--poll-seconds', Number(process.env.POLL_SECONDS || 15)));
const MAX_LIVE_OPEN = Math.max(1, readFlagNumber('--max-live-open', Number(process.env.MAX_LIVE_OPEN || 1)));
const DRIFT_CONFIRM_TICKS = Math.max(1, readFlagNumber('--drift-confirm-ticks', Number(process.env.DRIFT_CONFIRM_TICKS || 2)));
const SESSION_GAP_SECONDS = Math.max(0, readFlagNumber('--session-gap-seconds', Number(process.env.SESSION_GAP_SECONDS || 30)));
const PROFIT_TARGET_USD = readFlagNumber('--profit-target-usd', Number(process.env.CAMPAIGN_PROFIT_TARGET_USD || 10));
const LOSS_LIMIT_USD = Math.abs(readFlagNumber('--loss-limit-usd', Number(process.env.CAMPAIGN_LOSS_LIMIT_USD || 3)));
const EXECUTE_START = readFlagBool('--execute-start', String(process.env.EXECUTE_START || 'true').toLowerCase() !== 'false');
const APPLY_PROFILE = readFlagBool('--apply-profile', String(process.env.APPLY_PROFILE || 'true').toLowerCase() !== 'false');
const RUN_GATES_EACH_RUN = readFlagBool('--verify-gates-each-run', String(process.env.VERIFY_GATES_EACH_RUN || 'true').toLowerCase() !== 'false');
const STOP_ON_FAILURE = readFlagBool('--stop-on-failure', String(process.env.CAMPAIGN_STOP_ON_FAILURE || 'true').toLowerCase() !== 'false');
const API_BASE = `http://localhost:${process.env.PREDICTION_PORT || 3003}`;
// WORKSPACE_ROOT is parent of scripts/ directory
const WORKSPACE_ROOT = path.dirname(__dirname);
const CHECKPOINT_DIR = path.join(WORKSPACE_ROOT, 'data', 'campaign-checkpoints');
const CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, 'two_day_campaign_state.json');

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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseResultJson(stdout = '') {
    const lines = String(stdout || '').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith(RESULT_PREFIX)) continue;
        try {
            return JSON.parse(line.slice(RESULT_PREFIX.length));
        } catch (_) {
            return null;
        }
    }
    return null;
}

async function apiGet(pathname, options = {}) {
    const maxAttempts = Math.max(1, Number(options.maxAttempts || 4));
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await fetch(`${API_BASE}${pathname}`);
            if (!response.ok) {
                throw new Error(`${pathname} returned ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            lastError = error;
            const shouldRetry = attempt < maxAttempts;
            if (!shouldRetry) break;
            const backoffMs = 300 * Math.pow(2, attempt - 1);
            await sleep(backoffMs);
        }
    }

    throw new Error(`api_get_failed ${pathname}: ${lastError?.message || 'unknown_error'}`);
}

async function getLiveDailyPnl() {
    const status = await apiGet('/api/bot/status');
    return Number(status?.paper_live_split?.live?.today?.daily_pnl || 0);
}

function loadCheckpoint() {
    try {
        if (fs.existsSync(CHECKPOINT_FILE)) {
            const data = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
            log('Loaded checkpoint', {
                total_runs: data.total_runs,
                cumulative_pnl: data.cumulative_pnl,
                last_run_at: data.last_run_at
            });
            return data;
        }
    } catch (e) {
        log('Checkpoint load failed, starting fresh', { error: e.message });
    }
    return {
        total_runs: 0,
        cumulative_pnl: 0,
        cumulative_profit_target_usd: PROFIT_TARGET_USD,
        cumulative_loss_limit_usd: LOSS_LIMIT_USD,
        runs: [],
        created_at: nowIso(),
        last_run_at: null
    };
}

function saveCheckpoint(checkpoint) {
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
    log('Checkpoint saved', {
        total_runs: checkpoint.total_runs,
        cumulative_pnl: checkpoint.cumulative_pnl
    });
}

function runVerifyGates() {
    const proc = spawnSync(process.execPath, ['scripts/verify_gates.js'], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 2
    });

    return {
        ok: proc.status === 0,
        exitCode: proc.status,
        stdoutTail: (proc.stdout || '').split('\n').slice(-30).join('\n'),
        stderrTail: (proc.stderr || '').split('\n').slice(-30).join('\n')
    };
}

function runSingleSession() {
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
    return {
        exitCode: proc.status,
        parsed,
        ok: proc.status === 0 && parsed && parsed.success === true,
        stdoutTail: (proc.stdout || '').split('\n').slice(-40).join('\n'),
        stderrTail: (proc.stderr || '').split('\n').slice(-40).join('\n')
    };
}

function makeRunSummary(runNumber, gateResult, sessionResult, pnlBefore, pnlAfter) {
    const outcome = sessionResult?.parsed?.outcome || {};
    const conversion = outcome?.conversion || {};
    return {
        run: runNumber,
        ts: nowIso(),
        gates_ok: gateResult ? gateResult.ok : null,
        session_ok: sessionResult.ok,
        stop_reason: outcome.stop_reason || null,
        entered_trade_count: Number(conversion.entered_trade_count || 0),
        completed_exit_count: Number(conversion.completed_exit_count || 0),
        ground_truth_flat: outcome.ground_truth_flat === true,
        reconcile_flat: conversion.reconcile_flat === true,
        pnl_before: pnlBefore,
        pnl_after: pnlAfter,
        pnl_delta: pnlAfter - pnlBefore,
        error: sessionResult.ok ? null : (sessionResult?.parsed?.error || `exit_code_${sessionResult.exitCode}`),
        stdout_tail: sessionResult.stdoutTail,
        stderr_tail: sessionResult.stderrTail,
        gate_stdout_tail: gateResult?.stdoutTail || null,
        gate_stderr_tail: gateResult?.stderrTail || null
    };
}

async function main() {
    const startedAt = Date.now();
    const deadlineMs = startedAt + HOURS * 3600 * 1000;

    log('Starting campaign invocation (checkpoint-resumable mode)', {
        hours: HOURS,
        session_seconds: SESSION_SECONDS,
        poll_seconds: POLL_SECONDS,
        max_live_open: MAX_LIVE_OPEN,
        drift_confirm_ticks: DRIFT_CONFIRM_TICKS,
        execute_start: EXECUTE_START,
        apply_profile: APPLY_PROFILE,
        verify_gates_each_run: RUN_GATES_EACH_RUN,
        profit_target_usd: PROFIT_TARGET_USD,
        loss_limit_usd: LOSS_LIMIT_USD,
        stop_on_failure: STOP_ON_FAILURE
    });

    // Load or create checkpoint
    const checkpoint = loadCheckpoint();
    let runsThisInvocation = 0;

    while (Date.now() < deadlineMs) {
        checkpoint.total_runs += 1;
        runsThisInvocation += 1;
        log(`Campaign run ${checkpoint.total_runs} starting (invocation run ${runsThisInvocation})...`);

        let gateResult = null;
        if (RUN_GATES_EACH_RUN) {
            gateResult = runVerifyGates();
            if (!gateResult.ok) {
                const summary = {
                    reason: 'verify_gates_failed',
                    run: checkpoint.total_runs,
                    gate_exit_code: gateResult.exitCode
                };
                log('Gate verification failed before session', summary);
                checkpoint.runs.push({
                    run: checkpoint.total_runs,
                    ts: nowIso(),
                    gates_ok: false,
                    session_ok: false,
                    error: 'verify_gates_failed',
                    gate_stdout_tail: gateResult.stdoutTail,
                    gate_stderr_tail: gateResult.stderrTail
                });
                saveCheckpoint(checkpoint);
                if (STOP_ON_FAILURE) break;
                await sleep(SESSION_GAP_SECONDS * 1000);
                continue;
            }
        }

        const pnlBefore = await getLiveDailyPnl();
        const sessionResult = runSingleSession();
        const pnlAfter = await getLiveDailyPnl();
        const runSummary = makeRunSummary(checkpoint.total_runs, gateResult, sessionResult, pnlBefore, pnlAfter);
        checkpoint.runs.push(runSummary);

        // Update cumulative PnL
        checkpoint.cumulative_pnl += runSummary.pnl_delta;
        checkpoint.last_run_at = nowIso();

        log(`Campaign run ${checkpoint.total_runs} complete`, {
            session_ok: runSummary.session_ok,
            entered_trade_count: runSummary.entered_trade_count,
            completed_exit_count: runSummary.completed_exit_count,
            pnl_delta: runSummary.pnl_delta,
            cumulative_pnl: checkpoint.cumulative_pnl,
            stop_reason: runSummary.stop_reason,
            reconcile_flat: runSummary.reconcile_flat,
            ground_truth_flat: runSummary.ground_truth_flat
        });

        // Save checkpoint after each run (for resumability)
        saveCheckpoint(checkpoint);

        // Check terminal conditions
        if (checkpoint.cumulative_pnl >= checkpoint.cumulative_profit_target_usd) {
            log('Campaign profit target reached across invocations, ending', {
                cumulative_pnl: checkpoint.cumulative_pnl,
                target: checkpoint.cumulative_profit_target_usd
            });
            break;
        }

        if (checkpoint.cumulative_pnl <= -checkpoint.cumulative_loss_limit_usd) {
            log('Campaign loss limit breached across invocations, ending', {
                cumulative_pnl: checkpoint.cumulative_pnl,
                loss_limit: -checkpoint.cumulative_loss_limit_usd
            });
            break;
        }

        if ((!sessionResult.ok || runSummary.reconcile_flat !== true || runSummary.ground_truth_flat !== true) && STOP_ON_FAILURE) {
            log('Session safety failure encountered, stopping this invocation', {
                session_ok: sessionResult.ok,
                reconcile_flat: runSummary.reconcile_flat,
                ground_truth_flat: runSummary.ground_truth_flat,
                error: runSummary.error
            });
            break;
        }

        if (SESSION_GAP_SECONDS > 0) {
            await sleep(SESSION_GAP_SECONDS * 1000);
        }
    }

    // Generate final artifact for this invocation
    const payload = {
        generated_at: nowIso(),
        api_base: API_BASE,
        checkpoint_mode: 'enabled',
        total_runs_across_all_invocations: checkpoint.total_runs,
        runs_this_invocation: runsThisInvocation,
        config: {
            hours: HOURS,
            session_seconds: SESSION_SECONDS,
            poll_seconds: POLL_SECONDS,
            max_live_open: MAX_LIVE_OPEN,
            drift_confirm_ticks: DRIFT_CONFIRM_TICKS,
            session_gap_seconds: SESSION_GAP_SECONDS,
            execute_start: EXECUTE_START,
            apply_profile: APPLY_PROFILE,
            verify_gates_each_run: RUN_GATES_EACH_RUN,
            stop_on_failure: STOP_ON_FAILURE,
            profit_target_usd: PROFIT_TARGET_USD,
            loss_limit_usd: LOSS_LIMIT_USD
        },
        summary: {
            runs_this_invocation: runsThisInvocation,
            runs_recorded_this_invocation: checkpoint.runs.slice(-runsThisInvocation).length,
            successful_runs_this_invocation: checkpoint.runs.slice(-runsThisInvocation).filter(r => r.session_ok === true).length,
            failed_runs_this_invocation: checkpoint.runs.slice(-runsThisInvocation).filter(r => r.session_ok !== true).length,
            total_runs_all_invocations: checkpoint.total_runs,
            cumulative_pnl_all_invocations: checkpoint.cumulative_pnl,
            elapsed_hours_this_invocation: (Date.now() - startedAt) / (1000 * 3600),
            checkpoint_file: CHECKPOINT_FILE
        },
        runs_this_invocation: checkpoint.runs.slice(-runsThisInvocation)
    };

    const outDir = path.join(WORKSPACE_ROOT, 'test-results');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(outDir, `campaign_invocation_${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));

    log('Campaign invocation finished', {
        output: outFile,
        runs_this_invocation: payload.summary.runs_this_invocation,
        successful_runs: payload.summary.successful_runs_this_invocation,
        pnl_this_invocation: payload.runs_this_invocation.reduce((sum, r) => sum + (r.pnl_delta || 0), 0),
        cumulative_pnl: checkpoint.cumulative_pnl,
        checkpoint_file: CHECKPOINT_FILE
    });

    if (payload.summary.failed_runs_this_invocation > 0) {
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error(`[${nowIso()}] Fatal campaign error: ${error.message}`);
    process.exit(1);
});
