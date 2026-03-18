#!/usr/bin/env node

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const API_BASE = process.env.API_BASE || `http://localhost:${process.env.PREDICTION_PORT || 3003}`;
const EXECUTE_START = process.argv.includes('--execute-start');
const APPLY_PROFILE = process.argv.includes('--apply-profile');
const SESSION_SECONDS = Math.max(60, Number(process.env.SESSION_SECONDS || 900));
const POLL_SECONDS = Math.max(5, Number(process.env.POLL_SECONDS || 15));
const MAX_LIVE_OPEN = Math.max(1, Number(process.env.MAX_LIVE_OPEN || 1));
const DRIFT_CONFIRM_TICKS = Math.max(1, Number(process.env.DRIFT_CONFIRM_TICKS || 2));
const DRIFT_SETTLE_WAIT_MS = Math.max(0, Number(process.env.DRIFT_SETTLE_WAIT_MS || 10000));

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
    const response = await fetch(`${API_BASE}${pathname}`, {
        method: options.method || 'GET',
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
    });

    const text = await response.text();
    let data;
    try {
        data = text ? JSON.parse(text) : {};
    } catch (error) {
        throw new Error(`${pathname} returned invalid JSON: ${text}`);
    }

    return { ok: response.ok, status: response.status, data };
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
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

async function ensureBaseline() {
    const baselineSinceMs = Date.now() - 15 * 60 * 1000;
    const [health, preflightInitial, readiness, groundTruth, reconcile, status, signalTypes, rejectionSummary, funnel, filters, allowlistShadow, recentTrades, openTrades] = await Promise.all([
        api('/api/health'),
        api('/api/bot/preflight', { method: 'POST', body: {} }),
        api('/api/session/readiness?force_preflight=true&force_gate=true'),
        api('/api/bot/ground-truth'),
        api('/api/reconcile'),
        api('/api/bot/status'),
        api('/api/signals/types'),
        api(`/api/rejections/summary?since_ms=${baselineSinceMs}&limit=25`),
        api('/api/signals/funnel'),
        api('/api/signals/filters'),
        api('/api/signals/allowlist-shadow?limit=25'),
        api('/api/trades/recent?limit=500&mode=live'),
        api('/api/trades/open?mode=live')
    ]);

    assert(health.ok && health.data?.status === 'ok', 'health check failed');
    assert(status.ok, 'bot status unavailable');
    assert(status.data?.running === false, 'bot must be stopped before capped session start');

    let preflight = preflightInitial;
    if (!(preflight.ok && preflight.data?.valid === true)) {
        const reason = preflight.data?.reason || preflight.data?.error || `status_${preflight.status}`;
        log('Preflight invalid before run, attempting auto-recovery', { reason });

        // Best-effort recovery path for stale open orders / orphaned state.
        await api('/api/reconcile/fix', {
            method: 'POST',
            body: { recover_orphans: true }
        }).catch(() => null);

        await api('/api/bot/emergency-stop', {
            method: 'POST',
            body: {}
        }).catch(() => null);

        await sleep(3000);
        preflight = await api('/api/bot/preflight', { method: 'POST', body: {} });
    }

    assert(preflight.ok && preflight.data?.valid === true, `preflight invalid: ${preflight.data?.reason || preflight.status}`);
    assert(readiness.ok, 'session readiness unavailable');
    assert(groundTruth.ok && groundTruth.data?.is_flat === true, 'ground-truth is not flat');
    assert(reconcile.ok, 'reconcile endpoint unavailable');
    assert(signalTypes.ok, 'signals/types endpoint unavailable');
    assert(rejectionSummary.ok, 'rejections/summary endpoint unavailable');
    assert(funnel.ok, 'signals/funnel endpoint unavailable');
    assert(filters.ok, 'signals/filters endpoint unavailable');
    assert(allowlistShadow.ok, 'signals/allowlist-shadow endpoint unavailable');
    assert(recentTrades.ok, 'trades/recent endpoint unavailable');
    assert(openTrades.ok, 'trades/open endpoint unavailable');

    const orphaned = reconcile.data?.orphaned?.length || 0;
    const phantom = (reconcile.data?.phantom || []).filter(item => !item.pendingExit && !item.transientGrace).length;
    const qtyMismatch = reconcile.data?.quantityMismatch?.length || 0;
    assert(orphaned === 0 && phantom === 0 && qtyMismatch === 0, 'reconcile drift present before session start');

    return {
        startTimestampSec: Math.floor(Date.now() / 1000),
        token: preflight.data.token,
        balance: preflight.data?.details?.balance,
        livePreflight: preflight.data,
        readiness: readiness.data,
        status: status.data,
        trades: {
            recent: Array.isArray(recentTrades.data?.trades) ? recentTrades.data.trades : [],
            open_count: Number(openTrades.data?.count || 0)
        },
        diagnostics: {
            window_start_ms: baselineSinceMs,
            ...summarizeDiagnosticsWindow({
                signalTypes: signalTypes.data,
                rejectionSummary: rejectionSummary.data,
                funnel: funnel.data,
                filters: filters.data,
                allowlistShadow: allowlistShadow.data
            })
        }
    };
}

function applyShortHorizonProfile() {
    const scriptPath = path.join(__dirname, 'activate_session_profile.js');
    execFileSync(process.execPath, [scriptPath], { stdio: 'inherit' });
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
            const postGT = await api('/api/bot/ground-truth');

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
            }

            return {
                completed: true,
                stop_reason: summary.stop_reason,
                checkpoint: checkpointRes.data?.decision || null,
                ground_truth_flat: postGT.data?.is_flat === true,
                flatten_result: flattenResult,
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

    const postGroundTruth = await api('/api/bot/ground-truth');
    return {
        completed: true,
        stop_reason: 'session_time_cap_reached',
        flattened: flattenResult,
        ground_truth_flat: postGroundTruth.data?.is_flat === true,
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

    if (APPLY_PROFILE) {
        log('Applying short_horizon_v1 profile overrides');
        applyShortHorizonProfile();
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

    await startBot(baseline.token);
    log('Bot started with fresh preflight token');

    const sessionDeadlineMs = Date.now() + SESSION_SECONDS * 1000;
    const outcome = await monitorSession(sessionDeadlineMs);

    const [postRecentRes, postOpenRes, postReconcileRes] = await Promise.all([
        api('/api/trades/recent?limit=500&mode=live'),
        api('/api/trades/open?mode=live'),
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
    const [postSignalTypesRes, postRejectionSummaryRes, postFunnelRes, postFiltersRes, postAllowlistShadowRes] = await Promise.all([
        api('/api/signals/types'),
        api(`/api/rejections/summary?since_ms=${diagnosticsSinceMs}&limit=100`),
        api('/api/signals/funnel'),
        api('/api/signals/filters'),
        api('/api/signals/allowlist-shadow?limit=50')
    ]);

    assert(postSignalTypesRes.ok, 'post-session signals/types endpoint unavailable');
    assert(postRejectionSummaryRes.ok, 'post-session rejections/summary endpoint unavailable');
    assert(postFunnelRes.ok, 'post-session signals/funnel endpoint unavailable');
    assert(postFiltersRes.ok, 'post-session signals/filters endpoint unavailable');
    assert(postAllowlistShadowRes.ok, 'post-session signals/allowlist-shadow endpoint unavailable');

    const postDiagnostics = summarizeDiagnosticsWindow({
        signalTypes: postSignalTypesRes.data,
        rejectionSummary: postRejectionSummaryRes.data,
        funnel: postFunnelRes.data,
        filters: postFiltersRes.data,
        allowlistShadow: postAllowlistShadowRes.data
    });

    outcome.diagnostics = {
        window_start_ms: diagnosticsSinceMs,
        baseline: baseline.diagnostics,
        post: postDiagnostics,
        delta: {
            scored: (postDiagnostics.signal_types.total_scored || 0) - (baseline.diagnostics?.signal_types?.total_scored || 0),
            actionable: (postDiagnostics.signal_types.total_actionable || 0) - (baseline.diagnostics?.signal_types?.total_actionable || 0),
            rejections: (postDiagnostics.rejection_summary.total_rejections || 0) - (baseline.diagnostics?.rejection_summary?.total_rejections || 0),
            allowlist_blocked: (postDiagnostics.allowlist_shadow.latest_blocked_total || 0) - (baseline.diagnostics?.allowlist_shadow?.latest_blocked_total || 0)
        }
    };

    if (EXECUTE_START) {
        assert(outcome.conversion.entered_trade_count > 0, '--execute-start run entered zero trades');
        assert(outcome.conversion.completed_exit_count > 0, '--execute-start run exited zero trades');
        assert(outcome.ground_truth_flat === true, '--execute-start run ended non-flat according to ground-truth');
        assert(outcome.conversion.reconcile_flat === true, '--execute-start run ended with reconcile drift or open live positions');
    }

    log('Session complete', outcome);
}

main().catch(error => {
    console.error(`[${timestamp()}] ${error.message}`);
    process.exitCode = 1;
});