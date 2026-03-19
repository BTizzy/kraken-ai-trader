#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PROFILE_JSON_PREFIX } = require('./activate_session_profile');

const API_BASE = process.env.API_BASE || `http://localhost:${process.env.PREDICTION_PORT || 3003}`;
const EXECUTE_START = process.argv.includes('--execute-start');
const APPLY_PROFILE = process.argv.includes('--apply-profile');
const EMIT_RESULT_JSON = String(process.env.EMIT_RESULT_JSON || '').toLowerCase() === 'true';
const SESSION_SECONDS = Math.max(60, Number(process.env.SESSION_SECONDS || 900));
const POLL_SECONDS = Math.max(5, Number(process.env.POLL_SECONDS || 15));
const MAX_LIVE_OPEN = Math.max(1, Number(process.env.MAX_LIVE_OPEN || 1));
const DRIFT_CONFIRM_TICKS = Math.max(1, Number(process.env.DRIFT_CONFIRM_TICKS || 2));
const DRIFT_SETTLE_WAIT_MS = Math.max(0, Number(process.env.DRIFT_SETTLE_WAIT_MS || 10000));
const ORPHAN_RECOVERY_GRACE_MS = Math.max(0, Number(process.env.ORPHAN_RECOVERY_GRACE_MS || 8000));
const ORPHAN_RECOVERY_POLL_MS = Math.max(250, Number(process.env.ORPHAN_RECOVERY_POLL_MS || 1000));
const ORPHAN_RECOVERY_RETRY_AFTER_MS = Math.max(0, Number(process.env.ORPHAN_RECOVERY_RETRY_AFTER_MS || 2000));
const BASELINE_RECOVERY_MAX_ATTEMPTS = Math.max(1, Number(process.env.BASELINE_RECOVERY_MAX_ATTEMPTS || 3));
const BASELINE_RECOVERY_WAIT_MS = Math.max(250, Number(process.env.BASELINE_RECOVERY_WAIT_MS || 1200));
const DEFAULT_MIN_EXECUTE_LIVE_BALANCE_USD = 0;
const MIN_EXECUTE_LIVE_BALANCE_USD = Math.max(0, Number(process.env.MIN_EXECUTE_LIVE_BALANCE_USD || DEFAULT_MIN_EXECUTE_LIVE_BALANCE_USD));
const API_TIMEOUT_MS = Math.max(1000, Number(process.env.API_TIMEOUT_MS || 15000));
const API_MAX_RETRIES = Math.max(0, Number(process.env.API_MAX_RETRIES || 2));
const ALLOW_LIVE_CAPITAL_RISK = String(process.env.ALLOW_LIVE_CAPITAL_RISK || '').toLowerCase() === 'true';
const STABILITY_RESULTS_DIR = process.env.STABILITY_RESULTS_DIR || path.join(__dirname, '..', 'test-results');
const STABILITY_LOOKBACK_FILES = Math.max(1, Number(process.env.STABILITY_LOOKBACK_FILES || 20));
const REQUIRED_CONSECUTIVE_CLEAN_RUNS = Math.max(1, Number(process.env.REQUIRED_CONSECUTIVE_CLEAN_RUNS || 3));
const ALLOW_UNSTABLE_EXECUTE_START = String(process.env.ALLOW_UNSTABLE_EXECUTE_START || '').toLowerCase() === 'true';
const STABILITY_STATE_FILE = process.env.STABILITY_STATE_FILE || path.join(STABILITY_RESULTS_DIR, 'capped_stability_state.json');
let lastAppliedProfileManifest = null;

const ALLOWED_STOP_REASONS = new Set([
    null,
    '',
    'session_profit_target_hit',
    'session_timeout',
    'session_loss_limit_hit'
]);

function timestamp() {
    return new Date().toISOString();
}

function log(message, extra) {
    if (extra !== undefined) {
        console.log(`[${timestamp()}] ${message}`, extra);
    } else {
        console.log(`[${timestamp()}] ${message}`);
    }
}

async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}

async function api(pathname, options = {}) {
    let lastError = null;

    for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
            const response = await fetch(`${API_BASE}${pathname}`, {
                method: options.method || 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    ...(options.headers || {})
                },
                body: options.body ? JSON.stringify(options.body) : undefined,
                signal: controller.signal
            });

            clearTimeout(timeout);

            const text = await response.text();
            let data;
            try {
                data = text ? JSON.parse(text) : {};
            } catch (_) {
                throw new Error(`${pathname} returned invalid JSON: ${text}`);
            }

            return { ok: response.ok, status: response.status, data };
        } catch (error) {
            clearTimeout(timeout);
            lastError = error;

            if (attempt >= API_MAX_RETRIES) {
                break;
            }

            const message = String(error?.message || '').toLowerCase();
            const isTransient = message.includes('fetch failed')
                || message.includes('econnrefused')
                || message.includes('enotfound')
                || message.includes('eai_again')
                || message.includes('socket hang up')
                || message.includes('aborted');

            if (!isTransient) {
                break;
            }

            // Exponential backoff between retry attempts for transient transport failures.
            await sleep(500 * (2 ** attempt));
        }
    }

    throw lastError || new Error(`${pathname} request failed`);
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function formatPreflightError(response, contextLabel = 'preflight invalid') {
    const status = response?.status;
    const payload = response?.data || {};
    const reason = payload?.reason || payload?.error || (status != null ? `status_${status}` : 'unknown');
    const details = payload?.details || {};

    const balance = Number(details.balance);
    const tradable = Number(details.tradable_balance);
    const reserve = Number(details.live_usd_reserve);
    const minTradable = Number(details.live_min_tradable_balance);
    const parts = [];

    if (Number.isFinite(balance)) parts.push(`balance=${balance.toFixed(2)}`);
    if (Number.isFinite(tradable)) parts.push(`tradable=${tradable.toFixed(2)}`);
    if (Number.isFinite(reserve)) parts.push(`reserve=${reserve.toFixed(2)}`);
    if (Number.isFinite(minTradable)) parts.push(`min_tradable=${minTradable.toFixed(2)}`);

    const detailSuffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `${contextLabel}: ${reason}${detailSuffix}`;
}

function getExecuteBalanceThreshold(preflightDetails = {}) {
    const staticThreshold = MIN_EXECUTE_LIVE_BALANCE_USD;
    const reserve = Number(
        preflightDetails.live_usd_reserve_effective ?? preflightDetails.live_usd_reserve
    );
    const minTradable = Number(
        preflightDetails.live_min_tradable_balance_effective ?? preflightDetails.live_min_tradable_balance
    );

    const policyThreshold = (Number.isFinite(reserve) && Number.isFinite(minTradable))
        ? Math.max(0, reserve + minTradable)
        : 0;

    return {
        staticThreshold,
        policyThreshold,
        effectiveThreshold: Math.max(staticThreshold, policyThreshold)
    };
}

function listRecentBatchFiles() {
    if (!fs.existsSync(STABILITY_RESULTS_DIR)) return [];

    const names = fs.readdirSync(STABILITY_RESULTS_DIR)
        .filter(name => /^capped_session_batch_.*\.json$/.test(name));

    return names
        .map(name => {
            const filePath = path.join(STABILITY_RESULTS_DIR, name);
            let mtimeMs = 0;
            try {
                mtimeMs = fs.statSync(filePath).mtimeMs;
            } catch (_) {
                mtimeMs = 0;
            }
            return { name, filePath, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, STABILITY_LOOKBACK_FILES);
}

function readBatchJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function isCleanRun(run) {
    const outcome = run?.result?.outcome;
    const conversion = outcome?.conversion || {};
    return run?.success === true
        && outcome?.ground_truth_flat === true
        && conversion?.reconcile_flat === true
        && Number(conversion?.open_live_post_count || 0) === 0;
}

function evaluateRecentStabilityGate() {
    const files = listRecentBatchFiles();
    const recentRuns = [];

    for (const file of files) {
        const batch = readBatchJson(file.filePath);
        if (!batch || !Array.isArray(batch.runs)) continue;
        for (const run of batch.runs) {
            recentRuns.push({
                file: file.name,
                run: run?.run ?? null,
                clean: isCleanRun(run),
                success: run?.success === true,
                error: run?.result?.error || null
            });
        }
    }

    let consecutiveClean = 0;
    let firstBlocking = null;
    for (const run of recentRuns) {
        if (run.clean) {
            consecutiveClean += 1;
            if (consecutiveClean >= REQUIRED_CONSECUTIVE_CLEAN_RUNS) break;
            continue;
        }
        firstBlocking = run;
        break;
    }

    return {
        passed: consecutiveClean >= REQUIRED_CONSECUTIVE_CLEAN_RUNS,
        source: 'artifacts',
        required_consecutive_clean_runs: REQUIRED_CONSECUTIVE_CLEAN_RUNS,
        lookback_files: STABILITY_LOOKBACK_FILES,
        files_considered: files.length,
        runs_considered: recentRuns.length,
        consecutive_clean_runs: consecutiveClean,
        first_blocking_run: firstBlocking,
        sample: recentRuns.slice(0, Math.max(REQUIRED_CONSECUTIVE_CLEAN_RUNS + 2, 6))
    };
}

function readStabilityState() {
    try {
        if (!fs.existsSync(STABILITY_STATE_FILE)) return null;
        const raw = JSON.parse(fs.readFileSync(STABILITY_STATE_FILE, 'utf8'));
        if (!raw || typeof raw !== 'object') return null;
        return {
            consecutive_clean_runs: Math.max(0, Number(raw.consecutive_clean_runs || 0)),
            total_runs_recorded: Math.max(0, Number(raw.total_runs_recorded || 0)),
            last_result: raw.last_result || null,
            updated_at: raw.updated_at || null
        };
    } catch (_) {
        return null;
    }
}

function writeStabilityState(nextState) {
    try {
        fs.mkdirSync(path.dirname(STABILITY_STATE_FILE), { recursive: true });
        fs.writeFileSync(STABILITY_STATE_FILE, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
    } catch (error) {
        log('Failed to persist stability state', { error: error.message, file: STABILITY_STATE_FILE });
    }
}

function updateStabilityState(runWasClean, resultContext = {}) {
    const prev = readStabilityState() || {
        consecutive_clean_runs: 0,
        total_runs_recorded: 0,
        last_result: null,
        updated_at: null
    };

    const countTowardsStreak = resultContext.count_towards_streak !== false;

    const next = {
        consecutive_clean_runs: countTowardsStreak
            ? (runWasClean ? (prev.consecutive_clean_runs + 1) : 0)
            : prev.consecutive_clean_runs,
        total_runs_recorded: countTowardsStreak
            ? (prev.total_runs_recorded + 1)
            : prev.total_runs_recorded,
        last_result: {
            clean: !!runWasClean,
            counted: countTowardsStreak,
            mode: resultContext.mode || null,
            stop_reason: resultContext.stop_reason || null,
            ground_truth_flat: resultContext.ground_truth_flat === true,
            reconcile_flat: resultContext.reconcile_flat === true,
            error: resultContext.error || null,
            ts: new Date().toISOString()
        },
        updated_at: new Date().toISOString()
    };

    writeStabilityState(next);
    return next;
}

function isNonSessionQualityFailure(message) {
    const text = String(message || '').toLowerCase();
    if (!text) return false;

    return text.includes('fetch failed')
        || text.includes('this operation was aborted')
        || text === 'aborted'
        || text.includes(' aborted')
        || text.includes('preflight invalid')
        || text.includes('balance_below_reserve_floor')
        || text.includes('live_balance_below_reserve_floor')
        || text.includes('econnrefused')
        || text.includes('enotfound')
        || text.includes('eai_again')
        || text.includes('socket hang up')
        || text.includes('valid_live_preflight_required')
        || text.includes('zero_eligible_contracts')
        || text.includes('zero_actionable_signals')
        || text.includes('run entered zero trades')
        || text.includes('run exited zero trades')
        || text.includes('below execute threshold')
        || text.includes('capital_preservation_lock')
        || text.includes('live_preflight_failed:capital_preservation_lock')
        || text.includes('bot start failed');
}

    function getSessionUniverseEligibleCount(outcome, baseline) {
        const fromOutcome = Number(outcome?.diagnostics?.post?.funnel?.session_universe?.eligible_contracts);
        if (Number.isFinite(fromOutcome)) return fromOutcome;

        const fromBaselineDiag = Number(baseline?.diagnostics?.funnel?.session_universe?.eligible_contracts);
        if (Number.isFinite(fromBaselineDiag)) return fromBaselineDiag;

        const fromReadiness = Number(baseline?.readiness?.session_universe?.eligible_contracts);
        if (Number.isFinite(fromReadiness)) return fromReadiness;

        return 0;
    }

function evaluateStabilityGate() {
    const state = readStabilityState();
    if (state && Number.isFinite(state.consecutive_clean_runs)) {
        return {
            passed: state.consecutive_clean_runs >= REQUIRED_CONSECUTIVE_CLEAN_RUNS,
            source: 'state_file',
            required_consecutive_clean_runs: REQUIRED_CONSECUTIVE_CLEAN_RUNS,
            consecutive_clean_runs: state.consecutive_clean_runs,
            total_runs_recorded: state.total_runs_recorded,
            updated_at: state.updated_at,
            last_result: state.last_result,
            state_file: STABILITY_STATE_FILE
        };
    }

    const artifactEval = evaluateRecentStabilityGate();
    return {
        ...artifactEval,
        state_file: STABILITY_STATE_FILE
    };
}

function summarizeTradeSnapshot(trades = []) {
    const normalized = Array.isArray(trades) ? trades : [];
    const open = normalized.filter(t => t && (t.is_open === 1 || t.is_open === true));
    const closed = normalized.filter(t => t && !(t.is_open === 1 || t.is_open === true));
    const completedExits = closed.filter(t => t.exit_price !== null && t.exit_price !== undefined);
    return {
        total: normalized.length,
        open_count: open.length,
        closed_count: closed.length,
        completed_exit_count: completedExits.length,
        ids: new Set(normalized.map(t => t?.id).filter(v => v !== null && v !== undefined))
    };
}

function summarizeDiagnosticsWindow({ signalTypes, rejectionSummary, funnel, filters, allowlistShadow }) {
    return {
        signal_types: {
            total_scored: signalTypes?.total_scored || 0,
            total_actionable: signalTypes?.total_actionable || 0,
            actionable_by_type: signalTypes?.actionable_by_type || {},
            scored_by_type: signalTypes?.scored_by_type || {}
        },
        funnel: {
            stages: funnel?.funnel?.stages || {},
            dropped: funnel?.funnel?.dropped || {},
            session_universe: funnel?.session_universe || null
        },
        filters: {
            dropped: filters?.dropped || {},
            stages: filters?.stages || {}
        },
        rejection_summary: {
            total_rejections: rejectionSummary?.total_rejections || 0,
            by_stage: rejectionSummary?.by_stage || {},
            by_reason: rejectionSummary?.by_reason || {}
        },
        allowlist_shadow: {
            latest_blocked_total: allowlistShadow?.latest?.blocked_total || 0,
            cumulative_blocked_total: allowlistShadow?.cumulative?.blocked_total || 0,
            session_blocked_total: allowlistShadow?.current_session?.blocked_total || 0,
            latest_blocked_by_type: allowlistShadow?.latest?.blocked_by_type || {},
            latest_blocked_by_reason: allowlistShadow?.latest?.blocked_by_reason || {}
        }
    };
}

function summarizeOpportunitySufficiency(outcome, baseline) {
    const eligibleContracts = getSessionUniverseEligibleCount(outcome, baseline);
    const scoredSignals = Number(outcome?.diagnostics?.post?.funnel?.stages?.scored || 0);
    const actionableSignals = Number(outcome?.diagnostics?.post?.funnel?.stages?.actionable_post_spot_freshness || 0);
    const enteredTrades = Number(outcome?.conversion?.entered_trade_count || 0);
    const exitedTrades = Number(outcome?.conversion?.completed_exit_count || 0);
    const sessionMinutes = Math.max(SESSION_SECONDS / 60, 1 / 60);

    let classification = 'sufficient';
    if (eligibleContracts <= 0) {
        classification = 'sparse_universe';
    } else if (actionableSignals <= 0) {
        classification = 'sparse_signals';
    } else if (enteredTrades <= 0) {
        classification = 'conversion_zero_entries';
    } else if (exitedTrades <= 0) {
        classification = 'conversion_zero_exits';
    }

    return {
        classification,
        eligible_contracts: eligibleContracts,
        scored_signals: scoredSignals,
        actionable_signals: actionableSignals,
        entered_trades: enteredTrades,
        completed_exits: exitedTrades,
        actionable_per_minute: Number((actionableSignals / sessionMinutes).toFixed(3)),
        entered_per_minute: Number((enteredTrades / sessionMinutes).toFixed(3))
    };
}

function parseProfileManifest(stdout = '') {
    const lines = String(stdout || '').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line.startsWith(PROFILE_JSON_PREFIX)) continue;
        const raw = line.slice(PROFILE_JSON_PREFIX.length);
        try {
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }
    return null;
}

function toTradeMode(runtimeMode) {
    const mode = String(runtimeMode || '').toLowerCase();
    if (mode === 'live' || mode === 'sandbox') return 'live';
    if (mode === 'paper') return 'paper';
    return null;
}

async function ensureBaseline() {
    const baselineSinceMs = Date.now() - 15 * 60 * 1000;
    let [health, groundTruth, reconcile, status, diagnosticsBundle] = await Promise.all([
        api('/api/health'),
        api('/api/bot/ground-truth'),
        api('/api/reconcile'),
        api('/api/bot/status'),
        api(`/api/session/diagnostics-bundle?force_gate=true&rejection_since_ms=${baselineSinceMs}&rejection_limit=25`)
    ]);

    assert(health.ok && health.data?.status === 'ok', 'health check failed');
    assert(status.ok, 'bot status unavailable');
    assert(diagnosticsBundle.ok, 'diagnostics bundle unavailable before capped session start');

    let preflight = await api('/api/bot/preflight', { method: 'POST', body: {} });
    assert(groundTruth.ok, 'ground-truth unavailable');
    assert(reconcile.ok, 'reconcile endpoint unavailable');

    let tradeMode = toTradeMode(status.data?.mode);
    const tradesRecentPath = tradeMode
        ? `/api/trades/recent?limit=500&mode=${tradeMode}`
        : '/api/trades/recent?limit=500';
    const tradesOpenPath = tradeMode
        ? `/api/trades/open?mode=${tradeMode}`
        : '/api/trades/open';
    let [recentTrades, openTrades] = await Promise.all([
        api(tradesRecentPath),
        api(tradesOpenPath)
    ]);
    assert(recentTrades.ok, 'trades/recent endpoint unavailable');
    assert(openTrades.ok, 'trades/open endpoint unavailable');

    let orphaned = reconcile.data?.orphaned?.length || 0;
    let phantom = (reconcile.data?.phantom || []).filter(item => !item.pendingExit && !item.transientGrace).length;
    let qtyMismatch = reconcile.data?.quantityMismatch?.length || 0;
    let groundTruthFlat = groundTruth.ok && groundTruth.data?.is_flat === true;
    let openLiveCount = Number(openTrades.data?.count || 0);
    let running = status.data?.running === true;

    for (let attempt = 1; attempt <= BASELINE_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
        const preflightValid = preflight.ok && preflight.data?.valid === true;
        const reconcileFlat = orphaned === 0 && phantom === 0 && qtyMismatch === 0;
        const fullyReady = !running && groundTruthFlat && reconcileFlat && openLiveCount === 0 && preflightValid;
        const preflightReason = String(preflight.data?.reason || preflight.data?.error || `status_${preflight.status}`);
        const reserveFloorOnly = !preflightValid
            && !running
            && groundTruthFlat
            && reconcileFlat
            && openLiveCount === 0
            && (preflightReason === 'balance_below_reserve_floor'
                || preflightReason === 'live_balance_below_reserve_floor');

        if (fullyReady) {
            break;
        }

        if (reserveFloorOnly) {
            log('Baseline recovery skipped: reserve-floor preflight blocker is operational', {
                preflight_reason: preflightReason,
                details: preflight.data?.details || null
            });
            break;
        }

        log('Baseline pre-run state requires recovery', {
            attempt,
            max_attempts: BASELINE_RECOVERY_MAX_ATTEMPTS,
            running,
            ground_truth_flat: groundTruthFlat,
            reconcile: { orphaned, phantom, qtyMismatch },
            open_live: openLiveCount,
            preflight_valid: preflightValid,
            preflight_reason: preflightReason
        });

        await api('/api/bot/stop', { method: 'POST', body: {} }).catch(() => null);
        await api('/api/bot/emergency-stop', {
            method: 'POST',
            body: {}
        }).catch(() => null);

        await sleep(BASELINE_RECOVERY_WAIT_MS);

        await api('/api/reconcile/fix', {
            method: 'POST',
            body: { recover_orphans: true }
        }).catch(() => null);

        await sleep(BASELINE_RECOVERY_WAIT_MS);

        [groundTruth, reconcile, status, preflight] = await Promise.all([
            api('/api/bot/ground-truth'),
            api('/api/reconcile'),
            api('/api/bot/status'),
            api('/api/bot/preflight', { method: 'POST', body: {} })
        ]);

        tradeMode = toTradeMode(status.data?.mode);
        const refreshedOpenPath = tradeMode
            ? `/api/trades/open?mode=${tradeMode}`
            : '/api/trades/open';
        openTrades = await api(refreshedOpenPath);

        assert(groundTruth.ok, 'ground-truth unavailable after baseline auto-recovery');
        assert(reconcile.ok, 'reconcile unavailable after baseline auto-recovery');
        assert(status.ok, 'bot status unavailable after baseline auto-recovery');
        assert(openTrades.ok, 'trades/open unavailable after baseline auto-recovery');

        orphaned = reconcile.data?.orphaned?.length || 0;
        phantom = (reconcile.data?.phantom || []).filter(item => !item.pendingExit && !item.transientGrace).length;
        qtyMismatch = reconcile.data?.quantityMismatch?.length || 0;
        groundTruthFlat = groundTruth.data?.is_flat === true;
        openLiveCount = Number(openTrades.data?.count || 0);
        running = status.data?.running === true;
    }

    assert(status.data?.running === false, 'bot must be stopped before capped session start');
    if (!(preflight.ok && preflight.data?.valid === true)) {
        throw new Error(formatPreflightError(preflight, 'preflight invalid'));
    }

    assert(orphaned === 0 && phantom === 0 && qtyMismatch === 0, 'reconcile drift present before session start');
    assert(groundTruthFlat, 'ground-truth is not flat');
    assert(openLiveCount === 0, 'live trades remain open before session start');

    const [readiness, finalPreflight] = await Promise.all([
        api('/api/session/readiness?force_gate=true'),
        api('/api/bot/preflight', { method: 'POST', body: {} })
    ]);

    assert(readiness.ok, 'session readiness unavailable');
    if (!(finalPreflight.ok && finalPreflight.data?.valid === true)) {
        throw new Error(formatPreflightError(finalPreflight, 'final preflight invalid'));
    }

    return {
        startTimestampSec: Math.floor(Date.now() / 1000),
        token: finalPreflight.data.token,
        trade_mode: tradeMode,
        balance: finalPreflight.data?.details?.balance ?? preflight.data?.details?.balance,
        livePreflight: finalPreflight.data,
        readiness: readiness.data,
        status: status.data,
        trades: {
            recent: Array.isArray(recentTrades.data?.trades) ? recentTrades.data.trades : [],
            open_count: Number(openTrades.data?.count || 0)
        },
        diagnostics: {
            window_start_ms: baselineSinceMs,
            ...summarizeDiagnosticsWindow({
                signalTypes: diagnosticsBundle.data?.diagnostics?.signal_types,
                rejectionSummary: diagnosticsBundle.data?.diagnostics?.rejection_summary,
                funnel: diagnosticsBundle.data?.diagnostics?.funnel,
                filters: diagnosticsBundle.data?.diagnostics?.filters,
                allowlistShadow: diagnosticsBundle.data?.diagnostics?.allowlist_shadow
            })
        },
        parameter_audit: diagnosticsBundle.data?.parameter_audit || null
    };
}

function applyShortHorizonProfile() {
    const scriptPath = path.join(__dirname, 'activate_session_profile.js');
    const stdout = execFileSync(process.execPath, [scriptPath, '--emit-json'], {
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'inherit']
    });
    process.stdout.write(stdout);
    const manifest = parseProfileManifest(stdout);
    assert(manifest && manifest.checksum, 'profile activation did not return manifest/checksum');
    return manifest;
}

async function startBot(token) {
    const startResponse = await api('/api/bot/start', {
        method: 'POST',
        body: { preflight_token: token }
    });

    assert(startResponse.ok, `bot start failed: ${startResponse.data?.error || startResponse.status}`);
    return startResponse.data;
}

async function flattenSession(reason) {
    log(`Flattening session: ${reason}`);
    const response = await api('/api/bot/emergency-stop', { method: 'POST', body: {} });
    if (!response.ok) {
        throw new Error(`emergency stop failed during flatten: ${response.data?.error || response.status}`);
    }
    return response.data;
}

function summarizeStatus(status, reconcile) {
    const liveSplit = status?.paper_live_split?.live || {};
    const unresolvedPhantom = (reconcile?.phantom || []).filter(item => !item.pendingExit && !item.transientGrace);
    return {
        running: status?.running,
        stop_reason: status?.stop_reason || null,
        open_live: liveSplit.open_positions || 0,
        daily_pnl: liveSplit.today?.daily_pnl || 0,
        trade_count: liveSplit.today?.trade_count || 0,
        circuit_open: status?.circuit_breaker?.open || false,
        gate_reason: status?.pre_trade_gate?.reason || null,
        reconcile: {
            orphaned: reconcile?.orphaned?.length || 0,
            phantom: unresolvedPhantom.length,
            qtyMismatch: reconcile?.quantityMismatch?.length || 0,
            phantom_samples: unresolvedPhantom.slice(0, 3).map(item => ({
                tradeId: item.tradeId,
                symbol: item.symbol,
                reason: item.reason,
                age: item.age,
                transientGrace: !!item.transientGrace
            }))
        }
    };
}

function summarizeReconcileCounts(reconcile, openCount) {
    const unresolvedPhantom = (reconcile?.phantom || []).filter(item => !item.pendingExit && !item.transientGrace);
    return {
        orphaned: reconcile?.orphaned?.length || 0,
        phantom: unresolvedPhantom.length,
        qtyMismatch: reconcile?.quantityMismatch?.length || 0,
        openLive: Number(openCount || 0),
        phantom_samples: unresolvedPhantom.slice(0, 3).map(item => ({
            tradeId: item.tradeId,
            symbol: item.symbol,
            reason: item.reason,
            age: item.age,
            transientGrace: !!item.transientGrace
        }))
    };
}

async function tryOrphanOnlyRecovery(contextLabel) {
    if (ORPHAN_RECOVERY_GRACE_MS <= 0) {
        return {
            attempted: false,
            reason: 'disabled',
            context: contextLabel,
            grace_ms: ORPHAN_RECOVERY_GRACE_MS
        };
    }

    const startedAt = Date.now();
    let attemptedRetryFix = false;
    let lastSnapshot = null;

    while (Date.now() - startedAt <= ORPHAN_RECOVERY_GRACE_MS) {
        const [groundTruthRes, reconcileRes, openTradesRes] = await Promise.all([
            api('/api/bot/ground-truth'),
            api('/api/reconcile'),
            api('/api/trades/open?mode=live')
        ]);

        if (!(groundTruthRes.ok && reconcileRes.ok && openTradesRes.ok)) {
            return {
                attempted: true,
                context: contextLabel,
                recovered: false,
                reason: 'snapshot_unavailable',
                ground_truth_ok: groundTruthRes.ok,
                reconcile_ok: reconcileRes.ok,
                open_trades_ok: openTradesRes.ok,
                status_codes: {
                    ground_truth: groundTruthRes.status,
                    reconcile: reconcileRes.status,
                    open_trades: openTradesRes.status
                }
            };
        }

        const counts = summarizeReconcileCounts(reconcileRes.data, openTradesRes.data?.count || 0);
        const groundTruthFlat = groundTruthRes.data?.is_flat === true;
        const fullyFlat = groundTruthFlat
            && counts.orphaned === 0
            && counts.phantom === 0
            && counts.qtyMismatch === 0
            && counts.openLive === 0;

        lastSnapshot = {
            ts: new Date().toISOString(),
            ground_truth_flat: groundTruthFlat,
            counts
        };

        if (fullyFlat) {
            return {
                attempted: true,
                context: contextLabel,
                recovered: true,
                attempted_retry_fix: attemptedRetryFix,
                elapsed_ms: Date.now() - startedAt,
                final_snapshot: lastSnapshot
            };
        }

        const orphanOnlyResidual = counts.orphaned > 0
            && counts.phantom === 0
            && counts.qtyMismatch === 0
            && counts.openLive === 0;

        if (!orphanOnlyResidual) {
            return {
                attempted: true,
                context: contextLabel,
                recovered: false,
                reason: 'non_orphan_drift',
                attempted_retry_fix: attemptedRetryFix,
                elapsed_ms: Date.now() - startedAt,
                final_snapshot: lastSnapshot
            };
        }

        const elapsed = Date.now() - startedAt;
        if (!attemptedRetryFix && elapsed >= ORPHAN_RECOVERY_RETRY_AFTER_MS) {
            attemptedRetryFix = true;
            const fix = await api('/api/reconcile/fix', {
                method: 'POST',
                body: { recover_orphans: true }
            }).catch(error => ({ ok: false, status: 0, data: { error: error.message } }));

            log('Orphan-only post-flatten recovery retry', {
                context: contextLabel,
                ok: fix.ok,
                status: fix.status,
                response: fix.data || null
            });
        }

        await sleep(ORPHAN_RECOVERY_POLL_MS);
    }

    return {
        attempted: true,
        context: contextLabel,
        recovered: false,
        reason: 'grace_timeout',
        attempted_retry_fix: attemptedRetryFix,
        elapsed_ms: Date.now() - startedAt,
        final_snapshot: lastSnapshot
    };
}

async function settleFinalFlatness(contextLabel) {
    if (ORPHAN_RECOVERY_GRACE_MS <= 0) {
        return {
            attempted: false,
            context: contextLabel,
            reason: 'disabled',
            grace_ms: ORPHAN_RECOVERY_GRACE_MS
        };
    }

    const startedAt = Date.now();
    let lastSnapshot = null;

    while (Date.now() - startedAt <= ORPHAN_RECOVERY_GRACE_MS) {
        const [groundTruthRes, reconcileRes, openTradesRes] = await Promise.all([
            api('/api/bot/ground-truth'),
            api('/api/reconcile'),
            api('/api/trades/open?mode=live')
        ]);

        if (!(groundTruthRes.ok && reconcileRes.ok && openTradesRes.ok)) {
            return {
                attempted: true,
                context: contextLabel,
                settled: false,
                reason: 'snapshot_unavailable',
                elapsed_ms: Date.now() - startedAt,
                status_codes: {
                    ground_truth: groundTruthRes.status,
                    reconcile: reconcileRes.status,
                    open_trades: openTradesRes.status
                }
            };
        }

        const counts = summarizeReconcileCounts(reconcileRes.data, openTradesRes.data?.count || 0);
        const groundTruthFlat = groundTruthRes.data?.is_flat === true;
        const reconcileFlat = counts.orphaned === 0
            && counts.phantom === 0
            && counts.qtyMismatch === 0
            && counts.openLive === 0;

        lastSnapshot = {
            ts: new Date().toISOString(),
            ground_truth_flat: groundTruthFlat,
            reconcile_flat: reconcileFlat,
            counts
        };

        if (groundTruthFlat && reconcileFlat) {
            return {
                attempted: true,
                context: contextLabel,
                settled: true,
                elapsed_ms: Date.now() - startedAt,
                final_snapshot: lastSnapshot
            };
        }

        await sleep(ORPHAN_RECOVERY_POLL_MS);
    }

    return {
        attempted: true,
        context: contextLabel,
        settled: false,
        reason: 'grace_timeout',
        elapsed_ms: Date.now() - startedAt,
        final_snapshot: lastSnapshot
    };
}

async function monitorSession(sessionDeadlineMs) {
    let consecutiveDriftTicks = 0;
    let driftCooldownUntilMs = 0;
    const driftTimeline = [];

    while (Date.now() < sessionDeadlineMs) {
        const [statusRes, reconcileRes, groundTruthRes, checkpointRes] = await Promise.all([
            api('/api/bot/status'),
            api('/api/reconcile'),
            api('/api/bot/ground-truth'),
            api('/api/session/checkpoint')
        ]);

        assert(statusRes.ok, 'bot status polling failed');
        assert(reconcileRes.ok, 'reconcile polling failed');
        assert(groundTruthRes.ok, 'ground-truth polling failed');
        assert(checkpointRes.ok, 'checkpoint polling failed');

        const status = statusRes.data;
        const reconcile = reconcileRes.data;
        const groundTruth = groundTruthRes.data;
        const summary = summarizeStatus(status, reconcile);

        log('Session tick', summary);

        const unresolvedOrphaned = summary.reconcile.orphaned;
        const unresolvedPhantom = summary.reconcile.phantom;
        const unresolvedQtyMismatch = summary.reconcile.qtyMismatch;
        if (unresolvedOrphaned > 0 || unresolvedPhantom > 0 || unresolvedQtyMismatch > 0) {
            consecutiveDriftTicks += 1;
            driftTimeline.push({
                ts: new Date().toISOString(),
                consecutiveDriftTicks,
                orphaned: unresolvedOrphaned,
                phantom: unresolvedPhantom,
                qtyMismatch: unresolvedQtyMismatch,
                phantom_samples: summary.reconcile.phantom_samples || []
            });
            log('Reconcile drift detected', {
                consecutiveDriftTicks,
                confirmTicks: DRIFT_CONFIRM_TICKS,
                orphaned: unresolvedOrphaned,
                phantom: unresolvedPhantom,
                qtyMismatch: unresolvedQtyMismatch,
                phantom_samples: summary.reconcile.phantom_samples || []
            });

            // First drift detection gets one recovery attempt before forcing flatten.
            if (consecutiveDriftTicks === 1) {
                try {
                    await api('/api/bot/stop', { method: 'POST', body: {} }).catch(() => null);
                    await sleep(1000);
                    const fix = await api('/api/reconcile/fix', {
                        method: 'POST',
                        body: { recover_orphans: true }
                    });
                    log('Reconcile auto-fix attempt', {
                        ok: fix.ok,
                        status: fix.status,
                        is_flat: fix.data?.is_flat,
                        post_fix: fix.data?.post_fix || null,
                        errors: fix.data?.errors || [],
                        response: fix.data,
                        recover_orphans: true
                    });

                    const postFixGroundTruth = await api('/api/bot/ground-truth');
                    if (fix.ok && fix.data?.is_flat === true && postFixGroundTruth.ok && postFixGroundTruth.data?.is_flat === true) {
                        return {
                            completed: true,
                            stop_reason: 'reconcile_drift_autofixed',
                            checkpoint: checkpointRes.data?.decision || null,
                            ground_truth_flat: true,
                            reconcile_fix: fix.data,
                            summary,
                            drift_timeline: driftTimeline
                        };
                    }

                    // The auto-fix path stops the bot before attempting repair.
                    // If we didn't restore a flat state immediately, don't keep
                    // polling a stopped bot; flatten deterministically and end.
                    log('Reconcile auto-fix incomplete after bot stop, ending capped session', {
                        fix_ok: fix.ok,
                        fix_is_flat: fix.data?.is_flat,
                        ground_truth_flat: postFixGroundTruth.ok ? postFixGroundTruth.data?.is_flat : null,
                        post_fix: fix.data?.post_fix || null,
                        response: fix.data || null
                    });

                    const flattenResult = await flattenSession('reconcile_drift_autofix_incomplete');
                    const finalGroundTruth = await api('/api/bot/ground-truth');
                    return {
                        completed: true,
                        stop_reason: 'reconcile_drift_autofix_incomplete',
                        checkpoint: checkpointRes.data?.decision || null,
                        ground_truth_flat: finalGroundTruth.ok && finalGroundTruth.data?.is_flat === true,
                        reconcile_fix: fix.data,
                        flatten_result: flattenResult,
                        summary,
                        drift_timeline: driftTimeline
                    };
                } catch (fixErr) {
                    log('Reconcile auto-fix failed', { error: fixErr.message });
                }
                driftCooldownUntilMs = Date.now() + DRIFT_SETTLE_WAIT_MS;
            }

            if (driftCooldownUntilMs > Date.now()) {
                log('Reconcile drift cooldown active', {
                    remaining_ms: driftCooldownUntilMs - Date.now(),
                    drift_confirm_ticks: DRIFT_CONFIRM_TICKS
                });
                await sleep(POLL_SECONDS * 1000);
                continue;
            }

            if (consecutiveDriftTicks >= DRIFT_CONFIRM_TICKS) {
                log('Drift timeline summary', {
                    total_drift_events: driftTimeline.length,
                    first_event: driftTimeline[0] || null,
                    last_event: driftTimeline[driftTimeline.length - 1] || null
                });
                await flattenSession('reconcile_drift_detected');
                throw new Error(`reconcile drift detected during session (orphaned=${unresolvedOrphaned}, phantom=${unresolvedPhantom}, qtyMismatch=${unresolvedQtyMismatch})`);
            }
        } else {
            consecutiveDriftTicks = 0;
        }

        if ((summary.open_live || 0) > MAX_LIVE_OPEN) {
            await flattenSession('live_open_position_limit_exceeded');
            throw new Error(`live open positions exceeded cap (${summary.open_live} > ${MAX_LIVE_OPEN})`);
        }

        if (summary.circuit_open) {
            await flattenSession('circuit_breaker_open');
            throw new Error('circuit breaker opened during session');
        }

        if (status.running === false) {
            if (!ALLOWED_STOP_REASONS.has(summary.stop_reason)) {
                await flattenSession(`unexpected_stop_reason:${summary.stop_reason || 'unknown'}`);
                throw new Error(`bot stopped unexpectedly: ${summary.stop_reason || 'unknown'}`);
            }

            // Bot stopped with an allowed (session-end) reason.
            // Always run cleanup flatten — positions may still be open on the exchange
            // even though trading has stopped.  emergencyExitAll is idempotent when
            // there is nothing to close.
            log('Bot stopped with allowed reason, running cleanup flatten', {
                stop_reason: summary.stop_reason
            });
            const flattenResult = await flattenSession(`cleanup_${summary.stop_reason}`);
            let postGT = await api('/api/bot/ground-truth');
            let orphanRecovery = null;

            // If still non-flat after flatten (e.g. GTC sell not yet filled), attempt
            // a reconcile/fix to cancel outstanding orders and repair state.
            if (!flattenResult.is_flat && !flattenResult.skipped_duplicate) {
                log('Post-flatten non-flat state detected, attempting reconcile/fix', {
                    is_flat: flattenResult.is_flat,
                    unresolved: flattenResult.unresolved,
                    post_reconcile: flattenResult.post_reconcile
                });
                await api('/api/reconcile/fix', {
                    method: 'POST',
                    body: { recover_orphans: true }
                }).catch(e => log('reconcile/fix after flatten failed', { error: e.message }));

                orphanRecovery = await tryOrphanOnlyRecovery(`cleanup_${summary.stop_reason}`);
                if (orphanRecovery?.attempted) {
                    log('Orphan-only post-flatten recovery outcome', orphanRecovery);
                }
                postGT = await api('/api/bot/ground-truth');
            }

            return {
                completed: true,
                stop_reason: summary.stop_reason,
                checkpoint: checkpointRes.data?.decision || null,
                ground_truth_flat: postGT.data?.is_flat === true,
                flatten_result: flattenResult,
                orphan_recovery: orphanRecovery,
                summary,
                drift_timeline: driftTimeline
            };
        }

        await sleep(POLL_SECONDS * 1000);
    }

    const flattenResult = await flattenSession('session_time_cap_reached');

    // If still non-flat after flatten (e.g. GTC sell not yet filled), attempt
    // a reconcile/fix to cancel outstanding orders and repair state.
    if (!flattenResult.is_flat && !flattenResult.skipped_duplicate) {
        log('Post-cap-flatten non-flat, attempting reconcile/fix', {
            is_flat: flattenResult.is_flat,
            unresolved: flattenResult.unresolved,
            post_reconcile: flattenResult.post_reconcile
        });
        await api('/api/reconcile/fix', {
            method: 'POST',
            body: { recover_orphans: true }
        }).catch(e => log('reconcile/fix after cap-flatten failed', { error: e.message }));
    }

    const orphanRecovery = await tryOrphanOnlyRecovery('session_time_cap_reached');
    if (orphanRecovery?.attempted) {
        log('Orphan-only cap-flatten recovery outcome', orphanRecovery);
    }

    const postGroundTruth = await api('/api/bot/ground-truth');
    return {
        completed: true,
        stop_reason: 'session_time_cap_reached',
        flattened: flattenResult,
        ground_truth_flat: postGroundTruth.data?.is_flat === true,
        orphan_recovery: orphanRecovery,
        drift_timeline: driftTimeline
    };
}

async function main() {
    log(`API_BASE=${API_BASE}`);
    log(`EXECUTE_START=${EXECUTE_START}`);
    log(`APPLY_PROFILE=${APPLY_PROFILE}`);
    log(`SESSION_SECONDS=${SESSION_SECONDS}`);
    log(`POLL_SECONDS=${POLL_SECONDS}`);
    log(`MAX_LIVE_OPEN=${MAX_LIVE_OPEN}`);
    log(`BASELINE_RECOVERY_MAX_ATTEMPTS=${BASELINE_RECOVERY_MAX_ATTEMPTS}`);
    log(`BASELINE_RECOVERY_WAIT_MS=${BASELINE_RECOVERY_WAIT_MS}`);
    log(`ORPHAN_RECOVERY_GRACE_MS=${ORPHAN_RECOVERY_GRACE_MS}`);
    log(`ORPHAN_RECOVERY_POLL_MS=${ORPHAN_RECOVERY_POLL_MS}`);
    log(`ORPHAN_RECOVERY_RETRY_AFTER_MS=${ORPHAN_RECOVERY_RETRY_AFTER_MS}`);
    log(`MIN_EXECUTE_LIVE_BALANCE_USD=${MIN_EXECUTE_LIVE_BALANCE_USD}`);
    log(`API_TIMEOUT_MS=${API_TIMEOUT_MS}`);
    log(`API_MAX_RETRIES=${API_MAX_RETRIES}`);
    log(`ALLOW_LIVE_CAPITAL_RISK=${ALLOW_LIVE_CAPITAL_RISK}`);
    log(`REQUIRED_CONSECUTIVE_CLEAN_RUNS=${REQUIRED_CONSECUTIVE_CLEAN_RUNS}`);
    log(`ALLOW_UNSTABLE_EXECUTE_START=${ALLOW_UNSTABLE_EXECUTE_START}`);

    let profileManifest = null;
    if (APPLY_PROFILE) {
        log('Applying short_horizon_v1 profile overrides');
        profileManifest = applyShortHorizonProfile();
        lastAppliedProfileManifest = profileManifest;
        log('Applied profile manifest', {
            profile: profileManifest.profile,
            version: profileManifest.version,
            checksum: profileManifest.checksum,
            changed_count: profileManifest.changed_count,
            dry_run: profileManifest.dry_run
        });
    }

    const baseline = await ensureBaseline();
    log('Baseline OK', {
        balance: baseline.balance,
        mode: baseline.status?.mode,
        preflight_reason: baseline.livePreflight?.reason,
        can_enter_now: baseline.status?.can_enter_now,
        readiness_blockers: baseline.status?.readiness_blockers || [],
        gate_reason: baseline.status?.pre_trade_gate_reason || baseline.status?.pre_trade_gate?.reason || null,
        session_ready: baseline.readiness?.ready_to_start,
        session_universe: baseline.readiness?.session_universe || null
    });

    log('Baseline diagnostics', {
        signal_types: baseline.diagnostics?.signal_types || {},
        funnel: baseline.diagnostics?.funnel?.stages || {},
        filter_dropped: baseline.diagnostics?.filters?.dropped || {},
        session_universe: baseline.diagnostics?.funnel?.session_universe || null,
        rejection_summary: baseline.diagnostics?.rejection_summary || {},
        allowlist_shadow: baseline.diagnostics?.allowlist_shadow || {},
        session_sanity: baseline.status?.session_sanity || null
    });

    if (!EXECUTE_START) {
        log('Dry run complete. Re-run with --execute-start to launch capped live session.');
        return;
    }

    const mode = String(baseline.status?.mode || '').toLowerCase();
    const isLiveMode = mode === 'live' || mode === 'sandbox';

    if (EXECUTE_START && isLiveMode && !ALLOW_LIVE_CAPITAL_RISK) {
        throw new Error('capital_preservation_lock: live execute disabled; set ALLOW_LIVE_CAPITAL_RISK=true to override');
    }

    if (isLiveMode) {
        const stabilityGate = evaluateStabilityGate();
        log('Recent stability gate', stabilityGate);
        if (!ALLOW_UNSTABLE_EXECUTE_START && !stabilityGate.passed) {
            throw new Error(
                `stability gate blocked --execute-start: require ${stabilityGate.required_consecutive_clean_runs} ` +
                `consecutive clean capped runs, found ${stabilityGate.consecutive_clean_runs}; ` +
                `set ALLOW_UNSTABLE_EXECUTE_START=true to bypass`
            );
        }
    }

    const liveBalance = Number(baseline.balance);
    if (isLiveMode) {
        if (!Number.isFinite(liveBalance)) {
            throw new Error('live balance unavailable/non-finite; refusing --execute-start');
        }
        const thresholds = getExecuteBalanceThreshold(baseline.livePreflight?.details || {});
        if (liveBalance < thresholds.effectiveThreshold) {
            throw new Error(
                `live balance $${liveBalance.toFixed(2)} below execute threshold ` +
                `$${thresholds.effectiveThreshold.toFixed(2)} ` +
                `(static=$${thresholds.staticThreshold.toFixed(2)}, policy=$${thresholds.policyThreshold.toFixed(2)}); refusing --execute-start`
            );
        }
    }

    await startBot(baseline.token);
    log('Bot started with fresh preflight token');

    const sessionDeadlineMs = Date.now() + SESSION_SECONDS * 1000;
    const outcome = await monitorSession(sessionDeadlineMs);

    const postTradeMode = baseline.trade_mode || toTradeMode(baseline.status?.mode);
    const postRecentPath = postTradeMode
        ? `/api/trades/recent?limit=500&mode=${postTradeMode}`
        : '/api/trades/recent?limit=500';
    const postOpenPath = postTradeMode
        ? `/api/trades/open?mode=${postTradeMode}`
        : '/api/trades/open';

    const [postRecentRes, postOpenRes, postReconcileRes] = await Promise.all([
        api(postRecentPath),
        api(postOpenPath),
        api('/api/reconcile')
    ]);
    assert(postRecentRes.ok, 'post-session trades/recent endpoint unavailable');
    assert(postOpenRes.ok, 'post-session trades/open endpoint unavailable');
    assert(postReconcileRes.ok, 'post-session reconcile endpoint unavailable');

    const baselineSnapshot = summarizeTradeSnapshot(baseline.trades.recent || []);
    const postTrades = Array.isArray(postRecentRes.data?.trades) ? postRecentRes.data.trades : [];
    const enteredTrades = postTrades.filter(t => {
        if (!t) return false;
        if (t.id !== null && t.id !== undefined) return !baselineSnapshot.ids.has(t.id);
        return Number(t.timestamp || 0) >= Number(baseline.startTimestampSec || 0);
    });
    const enteredSnapshot = summarizeTradeSnapshot(enteredTrades);
    const unresolvedOrphaned = postReconcileRes.data?.orphaned?.length || 0;
    const unresolvedPhantom = (postReconcileRes.data?.phantom || []).filter(item => !item.pendingExit && !item.transientGrace).length;
    const unresolvedQtyMismatch = postReconcileRes.data?.quantityMismatch?.length || 0;
    const reconcileFlat = unresolvedOrphaned === 0 && unresolvedPhantom === 0 && unresolvedQtyMismatch === 0 && Number(postOpenRes.data?.count || 0) === 0;

    outcome.conversion = {
        entered_trade_count: enteredSnapshot.total,
        completed_exit_count: enteredSnapshot.completed_exit_count,
        open_live_post_count: Number(postOpenRes.data?.count || 0),
        reconcile_flat: reconcileFlat,
        reconcile: {
            orphaned: unresolvedOrphaned,
            phantom: unresolvedPhantom,
            qtyMismatch: unresolvedQtyMismatch
        }
    };

    const diagnosticsSinceMs = Number(baseline.startTimestampSec || Math.floor(Date.now() / 1000)) * 1000;
    const postBundleRes = await api(
        `/api/session/diagnostics-bundle?force_gate=true&rejection_since_ms=${diagnosticsSinceMs}&rejection_limit=100`
    );
    assert(postBundleRes.ok, 'post-session diagnostics bundle endpoint unavailable');

    const postDiagnostics = summarizeDiagnosticsWindow({
        signalTypes: postBundleRes.data?.diagnostics?.signal_types,
        rejectionSummary: postBundleRes.data?.diagnostics?.rejection_summary,
        funnel: postBundleRes.data?.diagnostics?.funnel,
        filters: postBundleRes.data?.diagnostics?.filters,
        allowlistShadow: postBundleRes.data?.diagnostics?.allowlist_shadow
    });

    outcome.diagnostics = {
        window_start_ms: diagnosticsSinceMs,
        baseline: baseline.diagnostics,
        post: postDiagnostics,
        parameter_audit: {
            baseline: baseline.parameter_audit || null,
            post: postBundleRes.data?.parameter_audit || null
        },
        delta: {
            scored: (postDiagnostics.signal_types.total_scored || 0) - (baseline.diagnostics?.signal_types?.total_scored || 0),
            actionable: (postDiagnostics.signal_types.total_actionable || 0) - (baseline.diagnostics?.signal_types?.total_actionable || 0),
            rejections: (postDiagnostics.rejection_summary.total_rejections || 0) - (baseline.diagnostics?.rejection_summary?.total_rejections || 0),
            allowlist_blocked: (postDiagnostics.allowlist_shadow.latest_blocked_total || 0) - (baseline.diagnostics?.allowlist_shadow?.latest_blocked_total || 0)
        }
    };

    outcome.opportunity_sufficiency = summarizeOpportunitySufficiency(outcome, baseline);

    if (EXECUTE_START) {
        if (!(outcome.conversion.entered_trade_count > 0)) {
            const opportunity = outcome.opportunity_sufficiency || summarizeOpportunitySufficiency(outcome, baseline);
            const eligibleContracts = Number(opportunity.eligible_contracts || 0);
            const actionableSignals = Number(opportunity.actionable_signals || 0);
            const scoredSignals = Number(opportunity.scored_signals || 0);

            if (eligibleContracts <= 0) {
                throw new Error(
                    `--execute-start run entered zero trades: zero_eligible_contracts ` +
                    `(eligible=${eligibleContracts}, scored=${scoredSignals}, actionable=${actionableSignals})`
                );
            }

            if (actionableSignals <= 0) {
                throw new Error(
                    `--execute-start run entered zero trades: zero_actionable_signals ` +
                    `(eligible=${eligibleContracts}, scored=${scoredSignals}, actionable=${actionableSignals})`
                );
            }

            throw new Error('--execute-start run entered zero trades');
        }

        // Exchange and DB snapshots can lag by a few seconds after flatten; give
        // ground-truth a bounded settle window before declaring non-flat failure.
        if (outcome.ground_truth_flat !== true || outcome.conversion.reconcile_flat !== true) {
            const flatnessSettle = await settleFinalFlatness('post_execute_assertions');
            outcome.final_flatness_settle = flatnessSettle;
            if (flatnessSettle?.settled && flatnessSettle.final_snapshot) {
                outcome.ground_truth_flat = flatnessSettle.final_snapshot.ground_truth_flat === true;
                outcome.conversion.reconcile_flat = flatnessSettle.final_snapshot.reconcile_flat === true;
                outcome.conversion.open_live_post_count = Number(flatnessSettle.final_snapshot.counts?.openLive || 0);
                outcome.conversion.reconcile = {
                    orphaned: Number(flatnessSettle.final_snapshot.counts?.orphaned || 0),
                    phantom: Number(flatnessSettle.final_snapshot.counts?.phantom || 0),
                    qtyMismatch: Number(flatnessSettle.final_snapshot.counts?.qtyMismatch || 0)
                };
            }
            log('Post-execute flatness settle result', flatnessSettle || null);
        }

        assert(outcome.conversion.completed_exit_count > 0, '--execute-start run exited zero trades');
        assert(outcome.ground_truth_flat === true, '--execute-start run ended non-flat according to ground-truth');
        assert(outcome.conversion.reconcile_flat === true, '--execute-start run ended with reconcile drift or open live positions');

        const state = updateStabilityState(true, {
            mode: 'execute',
            stop_reason: outcome.stop_reason || null,
            ground_truth_flat: outcome.ground_truth_flat === true,
            reconcile_flat: outcome.conversion.reconcile_flat === true,
            error: null
        });
        log('Updated stability state', state);
    }

    log('Session complete', outcome);
    return {
        success: true,
        mode: EXECUTE_START ? 'execute' : 'dry',
        api_base: API_BASE,
        session_seconds: SESSION_SECONDS,
        poll_seconds: POLL_SECONDS,
        max_live_open: MAX_LIVE_OPEN,
        applied_profile: APPLY_PROFILE,
        profile_manifest: profileManifest,
        outcome
    };
}

main().then((result) => {
    if (EMIT_RESULT_JSON) {
        // Single-line marker for batch parsers.
        console.log(`CAPPED_SESSION_RESULT_JSON:${JSON.stringify(result)}`);
    }
}).catch(error => {
    if (EXECUTE_START) {
        const countTowardsStreak = !isNonSessionQualityFailure(error.message);
        const state = updateStabilityState(false, {
            mode: 'execute',
            stop_reason: null,
            ground_truth_flat: false,
            reconcile_flat: false,
            error: error.message,
            count_towards_streak: countTowardsStreak
        });
        log('Updated stability state', state);
    }

    const failure = {
        success: false,
        mode: EXECUTE_START ? 'execute' : 'dry',
        api_base: API_BASE,
        session_seconds: SESSION_SECONDS,
        poll_seconds: POLL_SECONDS,
        max_live_open: MAX_LIVE_OPEN,
        applied_profile: APPLY_PROFILE,
        profile_manifest: lastAppliedProfileManifest,
        error: error.message,
        failed_at: new Date().toISOString()
    };

    console.error(`[${timestamp()}] ${error.message}`);
    if (EMIT_RESULT_JSON) {
        console.log(`CAPPED_SESSION_RESULT_JSON:${JSON.stringify(failure)}`);
    }
    process.exitCode = 1;
});