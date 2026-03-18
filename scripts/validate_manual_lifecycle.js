#!/usr/bin/env node

const API_BASE = process.env.API_BASE || 'http://localhost:3003';
const EXECUTE_LIVE = process.argv.includes('--execute-live');
const ALLOW_OPEN_ORDERS = process.argv.includes('--allow-open-orders');

async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
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
        throw new Error(`Invalid JSON from ${path}: ${text}`);
    }

    return { ok: response.ok, status: response.status, data };
}

async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function correlationId(prefix, cycleName) {
    return `${prefix}-${cycleName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function getBaseline() {
    const [health, preflight, groundTruth, checkpoint, readiness, signals] = await Promise.all([
        api('/api/health'),
        api('/api/bot/preflight'),
        api('/api/bot/ground-truth'),
        api('/api/session/checkpoint'),
        api('/api/session/readiness'),
        api('/api/signals')
    ]);

    return { health, preflight, groundTruth, checkpoint, readiness, signals };
}

function pickCandidates(signalPayload, exclude = new Set()) {
    const actionableSignals = signalPayload?.data?.actionableSignals || [];
    return actionableSignals
        .filter(signal => signal && signal.marketId && !exclude.has(signal.marketId))
        .filter(signal => signal.direction === 'YES' || signal.direction === 'NO')
        .slice(0, 10);
}

async function validateCycle(cycleName, candidate) {
    const entryCorrelationId = correlationId('entry', cycleName);
    const closeCorrelationId = correlationId('close', cycleName);

    const entryBody = {
        market_id: candidate.marketId,
        direction: candidate.direction,
        contracts: 1,
        guard_profile: 'session_relaxed',
        allow_open_orders: ALLOW_OPEN_ORDERS
    };

    const entry = await api('/api/trade/live', {
        method: 'POST',
        headers: { 'x-correlation-id': entryCorrelationId },
        body: entryBody
    });

    assert(entry.data?.success === true, `${cycleName}: entry failed (${entry.data?.reason_tag || entry.data?.error || entry.status})`);
    assert(!entry.data?.resting_order, `${cycleName}: entry resulted in resting order, not filled trade`);
    assert(entry.data?.trade_id, `${cycleName}: missing trade_id on successful entry`);

    const tradeId = entry.data.trade_id;

    const close = await api(`/api/bot/close-position/${tradeId}`, {
        method: 'POST',
        headers: { 'x-correlation-id': closeCorrelationId },
        body: {}
    });

    assert(close.ok, `${cycleName}: close request failed (${close.data?.reason_tag || close.data?.error || close.status})`);
    assert([
        'manual_close_success',
        'manual_close_reconciled_no_exchange',
        'manual_close_already_reconciled'
    ].includes(close.data?.reason_tag), `${cycleName}: unexpected close reason_tag ${close.data?.reason_tag || 'missing'}`);

    let groundTruth = null;
    const maxFlatPollAttempts = 10;
    for (let attempt = 1; attempt <= maxFlatPollAttempts; attempt++) {
        groundTruth = await api('/api/bot/ground-truth');
        if (groundTruth.data?.is_flat === true) {
            break;
        }
        if (attempt < maxFlatPollAttempts) {
            await sleep(1000 * attempt);
        }
    }

    const reconcile = await api('/api/reconcile/fix', { method: 'POST', body: {} });

    assert(groundTruth.ok, `${cycleName}: ground-truth request failed`);
    assert(reconcile.ok, `${cycleName}: reconcile/fix request failed`);
    assert(groundTruth.data?.is_flat === true, `${cycleName}: ground-truth not flat after close`);
    assert(reconcile.data?.is_flat === true, `${cycleName}: reconcile/fix result not flat`);
    assert((reconcile.data?.post_fix?.orphaned || 0) === 0, `${cycleName}: orphaned positions remain after reconcile`);
    assert((reconcile.data?.post_fix?.phantom || 0) === 0, `${cycleName}: phantom positions remain after reconcile`);
    assert((reconcile.data?.post_fix?.qty_mismatch || 0) === 0, `${cycleName}: quantity mismatch remains after reconcile`);

    return {
        cycleName,
        tradeId,
        marketId: candidate.marketId,
        direction: candidate.direction,
        entryCorrelationId,
        closeCorrelationId,
        closeReasonTag: close.data.reason_tag
    };
}

function isSkippableEntryFailure(entryData) {
    const reasonTag = String(entryData?.reason_tag || '');
    return [
        'manual_live_entry_unfilled',
        'manual_live_two_sided_book_missing',
        'manual_live_guard_spread_too_wide',
        'manual_live_guard_entry_band',
        'manual_live_guard_ttx_too_short',
        'manual_live_guard_repeat_cooldown',
        'manual_live_guard_no_band_low_edge',
        'manual_live_pre_trade_gate_blocked_reconcile_not_clean',
        'manual_live_gate_bypass_incoherent'
    ].includes(reasonTag);
}

async function validateCycleAcrossCandidates(cycleName, candidates, usedMarkets) {
    const attempted = [];

    for (const candidate of candidates) {
        if (usedMarkets.has(candidate.marketId)) continue;
        usedMarkets.add(candidate.marketId);

        try {
            console.log(`running ${cycleName} on ${candidate.marketId} ${candidate.direction}`);
            const result = await validateCycle(cycleName, candidate);
            return { result, attempted };
        } catch (error) {
            attempted.push({
                marketId: candidate.marketId,
                direction: candidate.direction,
                error: error.message
            });
            console.log(`${cycleName} candidate failed: ${candidate.marketId} ${candidate.direction} -> ${error.message}`);

            const reasonMatch = error.message.match(/\(([^)]+)\)$/);
            const reasonTag = reasonMatch ? reasonMatch[1] : null;
            if (!isSkippableEntryFailure({ reason_tag: reasonTag })) {
                throw new Error(`${cycleName}: non-skippable failure after ${candidate.marketId}: ${error.message}`);
            }
        }
    }

    throw new Error(`${cycleName}: no fillable candidate found after ${attempted.length} attempts`);
}

async function main() {
    console.log(`API_BASE=${API_BASE}`);
    console.log(`EXECUTE_LIVE=${EXECUTE_LIVE}`);
    console.log(`ALLOW_OPEN_ORDERS=${ALLOW_OPEN_ORDERS}`);

    const baseline = await getBaseline();
    console.log('baseline', JSON.stringify({
        health: baseline.health.data?.status,
        bot_running: baseline.health.data?.bot_running,
        preflight_valid: baseline.preflight.data?.valid,
        readiness: baseline.readiness.data?.ready_to_start,
        checkpoint: baseline.checkpoint.data?.decision?.value,
        flat: baseline.groundTruth.data?.is_flat,
        actionable_count: baseline.signals.data?.actionableCount || 0
    }, null, 2));

    assert(baseline.health.ok, 'health endpoint unavailable');
    assert(baseline.groundTruth.ok, 'ground-truth endpoint unavailable');

    const candidates = pickCandidates(baseline.signals);
    assert(candidates.length >= 2, 'not enough actionable candidates for two-cycle validation');

    console.log('candidate_preview', JSON.stringify(candidates.slice(0, 2).map(c => ({
        marketId: c.marketId,
        direction: c.direction,
        score: c.score,
        netEdge: c.netEdge
    })), null, 2));

    if (!EXECUTE_LIVE) {
        console.log('Dry run complete. Re-run with --execute-live to place real live validation orders.');
        return;
    }

    assert(baseline.health.data?.bot_running === false, 'bot must be stopped before execute-live validation');
    assert(baseline.groundTruth.data?.is_flat === true, 'exchange/DB must be flat before execute-live validation');
    assert(baseline.preflight.data?.valid === true, 'preflight must be valid before execute-live validation');

    const usedMarkets = new Set();
    const results = [];
    for (const cycleName of ['cycle1', 'cycle2']) {
        const cycleResult = await validateCycleAcrossCandidates(cycleName, candidates, usedMarkets);
        results.push({
            ...cycleResult.result,
            attempted: cycleResult.attempted
        });
    }

    console.log('validation_results', JSON.stringify(results, null, 2));
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});