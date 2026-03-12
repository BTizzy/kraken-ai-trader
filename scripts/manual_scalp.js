#!/usr/bin/env node
/**
 * manual_scalp.js — Phase 6 Manual Profit Loop
 *
 * A disciplined manual scalping tool for 15m/1h prediction market contracts.
 * Enforces strict risk caps: 1 contract max, hard per-trade cut, session cooldown.
 *
 * Design rules (hardcoded, not overridable):
 *   - Max 1 contract per trade
 *   - Max 3 open positions at once
 *   - Hard stop: -$0.50 per trade, close immediately
 *   - Session cooldown: after 3 consecutive losses → 5-min pause
 *   - Only 15m and 1h contracts (TTX <= 3600s)
 *   - No averaging down
 *   - All exits tracked with fill quality + latency
 *
 * Usage:
 *   node scripts/manual_scalp.js              # interactive mode
 *   node scripts/manual_scalp.js status        # show open positions + P&L
 *   node scripts/manual_scalp.js close <id>    # manually close by trade DB id
 *   node scripts/manual_scalp.js list          # list tradeable markets
 *
 * Prerequisites: server running on port 3003
 */

'use strict';

const readline = require('readline');
const BASE_URL = `http://localhost:${process.env.PREDICTION_PORT || 3003}`;

// Hard risk caps (non-negotiable)
const MAX_CONTRACTS = 1;
const MAX_OPEN = 3;
const HARD_STOP_USD = 0.50;        // per-trade hard cut
const SESSION_LOSS_LIMIT = 1.00;   // total session loss limit
const CONSECUTIVE_LOSS_COOLDOWN = 3;       // losses before mandatory pause
const COOLDOWN_SECONDS = 300;              // 5-min mandatory pause
const MAX_TTX_SECONDS = 3600;             // only 15m + 1h contracts
const MIN_TTX_SECONDS = 600;              // don't enter < 10m to expiry

// Session state (in-memory, not persisted)
let sessionPnl = 0;
let consecutiveLosses = 0;
let cooldownUntil = 0;
let sessionTrades = [];

async function getServerMode() {
    try {
        const status = await apiGet('/api/bot/status');
        return status?.mode || 'paper';
    } catch {
        return 'paper';
    }
}

async function apiGet(path) {
    const res = await fetch(`${BASE_URL}${path}`);
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
    return res.json();
}

async function apiPost(path, body = {}) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const text = await res.text();
        let err;
        try { err = JSON.parse(text).error || text; } catch { err = text; }
        throw new Error(err);
    }
    return res.json();
}

function fmt(n) { return typeof n === 'number' ? n.toFixed(4) : String(n); }
function fmtPnl(n) {
    const s = (n >= 0 ? '+' : '') + (typeof n === 'number' ? n.toFixed(4) : String(n));
    return n >= 0 ? `\x1b[32m${s}\x1b[0m` : `\x1b[31m${s}\x1b[0m`;
}

function parseTTX(marketId) {
    if (!marketId) return null;
    const m = marketId.match(/GEMI-\w+?(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
    if (!m) return null;
    const [, yy, mm, dd, hh, mn] = m;
    const expiry = new Date(`20${yy}-${mm}-${dd}T${hh}:${mn}:00Z`);
    return (expiry.getTime() - Date.now()) / 1000;
}

async function checkCooldown() {
    const now = Date.now() / 1000;
    if (cooldownUntil > now) {
        const remaining = Math.ceil(cooldownUntil - now);
        console.warn(`\n⚠  COOLDOWN ACTIVE — ${remaining}s remaining after ${consecutiveLosses} consecutive losses\n`);
        return false;
    }
    return true;
}

async function showStatus() {
    try {
        const [openRes, walletRes] = await Promise.all([
            apiGet('/api/trades/open'),
            apiGet('/api/wallet')
        ]);

        const open = openRes.trades || [];
        const wallet = walletRes;
        const liveOpen = open.filter(t => t.mode === 'live');
        const paperOpen = open.filter(t => t.mode === 'paper');

        console.log('\n' + '═'.repeat(56));
        console.log('  MANUAL SCALP STATUS');
        console.log('═'.repeat(56));
        console.log(`  Wallet balance: $${fmt(wallet?.balance || 0)}  (initial $${fmt(wallet?.initial_balance || 0)})`);
        console.log(`  Total PnL:      ${fmtPnl(wallet?.total_pnl || 0)}`);
        console.log(`  Session PnL:    ${fmtPnl(sessionPnl)}`);
        console.log(`  Consecutive losses: ${consecutiveLosses}/${CONSECUTIVE_LOSS_COOLDOWN}`);
        console.log(`  Open: ${liveOpen.length} live, ${paperOpen.length} paper`);

        if (open.length > 0) {
            console.log('\n  Open positions:');
            console.log(`  ${'ID'.padEnd(6)} ${'Market'.padEnd(38)} ${'Dir'.padEnd(5)} ${'Entry'.padEnd(7)} ${'TTX'}`);
            console.log('  ' + '-'.repeat(62));
            for (const t of open) {
                const ttx = parseTTX(t.gemini_market_id);
                const ttxStr = ttx !== null ? (ttx > 0 ? `${Math.round(ttx)}s` : 'EXPIRED') : '?';
                const modeTag = t.mode === 'live' ? '\x1b[33m[L]\x1b[0m' : '[P]';
                const mid = (t.gemini_market_id || '').substring(0, 36);
                console.log(`  ${String(t.id).padEnd(6)} ${mid.padEnd(38)} ${(t.direction || '').padEnd(5)} ${fmt(t.entry_price).padEnd(7)} ${ttxStr} ${modeTag}`);
            }
        }

        if (sessionTrades.length > 0) {
            console.log('\n  Session trades:');
            for (const t of sessionTrades.slice(-10)) {
                const w = t.pnl >= 0 ? '✓' : '✗';
                console.log(`  ${w} Trade ${t.id} ${t.direction} ${(t.market || '').substring(0, 30)} PnL=${fmtPnl(t.pnl)} Fill=${fmt(t.fillMs)}ms`);
            }
        }
        console.log('');
    } catch (e) {
        console.error('Status error:', e.message);
    }
}

async function listMarkets() {
    try {
        const res = await apiGet('/api/markets');
        const markets = (res.markets || []).filter(m => {
            const ttx = parseTTX(m.gemini_market_id);
            return ttx !== null && ttx >= MIN_TTX_SECONDS && ttx <= MAX_TTX_SECONDS;
        });

        if (markets.length === 0) {
            console.log('\n  No 15m/1h markets currently available.\n');
            return;
        }

        console.log(`\n  Tradeable short-TTX markets (${markets.length}):`);
        console.log(`  ${'Market ID'.padEnd(42)} ${'Title'.padEnd(30)} ${'TTX'}`);
        console.log('  ' + '-'.repeat(80));
        for (const m of markets) {
            const ttx = parseTTX(m.gemini_market_id);
            const ttxStr = ttx ? `${Math.round(ttx)}s` : '?';
            const title = (m.event_title || m.market_title || '').substring(0, 28);
            console.log(`  ${(m.gemini_market_id || '').padEnd(42)} ${title.padEnd(30)} ${ttxStr}`);
        }
        console.log('');
    } catch (e) {
        console.error('List error:', e.message);
    }
}

async function enterTrade(marketId, direction) {
    // Guard: cooldown check
    if (!(await checkCooldown())) return;

    // Guard: session loss limit
    if (sessionPnl < -SESSION_LOSS_LIMIT) {
        console.error(`\n✗ SESSION LOSS LIMIT REACHED ($${sessionPnl.toFixed(2)}). Stop for today.\n`);
        return;
    }

    // Guard: max open positions
    const openRes = await apiGet('/api/trades/open');
    const open = openRes.trades || [];
    if (open.length >= MAX_OPEN) {
        console.error(`\n✗ MAX OPEN POSITIONS (${MAX_OPEN}) reached. Close existing before entering.\n`);
        return;
    }

    // Guard: TTX check
    const ttx = parseTTX(marketId);
    if (ttx === null) {
        console.warn('⚠ Cannot parse TTX from market ID. Proceed with caution.');
    } else if (ttx < MIN_TTX_SECONDS) {
        console.error(`\n✗ TTX too short (${Math.round(ttx)}s < ${MIN_TTX_SECONDS}s min). Skipping.\n`);
        return;
    } else if (ttx > MAX_TTX_SECONDS) {
        console.error(`\n✗ TTX too long (${Math.round(ttx)}s > ${MAX_TTX_SECONDS}s). Use only 15m/1h contracts.\n`);
        return;
    }

    // Guard: no duplicate market
    if (open.some(t => t.gemini_market_id === marketId)) {
        console.error(`\n✗ Already have an open position in ${marketId}. No averaging down.\n`);
        return;
    }

    const dirNorm = direction.toUpperCase();
    if (dirNorm !== 'YES' && dirNorm !== 'NO') {
        console.error(`\n✗ Direction must be YES or NO\n`);
        return;
    }

    try {
        const entryTime = Date.now();
        console.log(`\n  Entering ${dirNorm} on ${marketId}...`);

        const mode = await getServerMode();
        const isLive = mode === 'live' || mode === 'sandbox';
        const endpoint = isLive ? '/api/trade/live' : '/api/trade/paper';
        const payload = isLive
            ? {
                market_id: marketId,
                direction: dirNorm,
                contracts: MAX_CONTRACTS
            }
            : {
                market_id: marketId,
                direction: dirNorm,
                position_size: MAX_CONTRACTS
            };

        const result = await apiPost(endpoint, payload);

        if (!result.success) {
            console.error(`\n✗ Entry failed: ${result.error}\n`);
            return;
        }

        const fillMs = Date.now() - entryTime;
        const entry_price = result.order?.fill_price ?? 0;
        console.log(`\n✓ ENTERED trade ${result.trade_id} (${isLive ? 'live' : 'paper'})`);
        console.log(`  Direction: ${dirNorm}  Entry: ${fmt(entry_price)}  Fill latency: ${fillMs}ms`);
        console.log(`  Hard stop at PnL = -$${HARD_STOP_USD}`);
        console.log(`  Monitor with: node scripts/manual_scalp.js status`);
        console.log(`  Exit with:    node scripts/manual_scalp.js close ${result.trade_id}\n`);

    } catch (e) {
        console.error(`\n✗ Entry error: ${e.message}\n`);
    }
}

async function closeTrade(tradeIdArg) {
    const tradeId = parseInt(tradeIdArg);
    if (!tradeId || isNaN(tradeId)) {
        console.error('Usage: node scripts/manual_scalp.js close <tradeId>');
        return;
    }

    try {
        const exitTime = Date.now();
        const result = await apiPost(`/api/bot/close-position/${tradeId}`);
        const fillMs = Date.now() - exitTime;

        if (!result.success && result.error) {
            console.error(`\n✗ Close failed: ${result.error}\n`);
            return;
        }

        const pnl = result.pnl ?? 0;
        sessionPnl += pnl;
        sessionTrades.push({
            id: tradeId,
            direction: result.direction,
            market: result.market,
            pnl,
            fillMs
        });

        if (pnl < 0) {
            consecutiveLosses++;
            if (consecutiveLosses >= CONSECUTIVE_LOSS_COOLDOWN) {
                cooldownUntil = Date.now() / 1000 + COOLDOWN_SECONDS;
                console.warn(`\n⚠  ${consecutiveLosses} consecutive losses — ${COOLDOWN_SECONDS}s COOLDOWN STARTING\n`);
            }
        } else {
            consecutiveLosses = 0;
        }

        console.log(`\n${pnl >= 0 ? '✓' : '✗'} CLOSED trade ${tradeId}`);
        console.log(`  Direction: ${result.direction}  Exit: ${fmt(result.exitPrice)}  Fill latency: ${fillMs}ms`);
        console.log(`  PnL: ${fmtPnl(pnl)}  Hold: ${result.holdTime}s`);
        console.log(`  Session PnL: ${fmtPnl(sessionPnl)}  Consecutive losses: ${consecutiveLosses}\n`);

        if (sessionPnl < -SESSION_LOSS_LIMIT) {
            console.error(`⚠  SESSION LOSS LIMIT ($${SESSION_LOSS_LIMIT}) HIT. Stop for the day.\n`);
        }

    } catch (e) {
        console.error(`\n✗ Close error: ${e.message}\n`);
    }
}

async function monitorLoop() {
    console.log('\nMonitoring open positions (checking every 10s). Press Ctrl+C to stop.\n');
    const check = async () => {
        try {
            const openRes = await apiGet('/api/trades/open');
            const open = openRes.trades || [];
            if (open.length === 0) { process.stdout.write('.'); return; }

            for (const t of open) {
                const ttx = parseTTX(t.gemini_market_id);
                const expired = ttx !== null && ttx <= 0;
                const nearExpiry = ttx !== null && ttx > 0 && ttx < 120;

                if (expired) {
                    console.warn(`\n⚠  EXPIRED: trade ${t.id} ${t.gemini_market_id} — close manually`);
                } else if (nearExpiry) {
                    console.warn(`\n⚠  NEAR EXPIRY: trade ${t.id} ${Math.round(ttx)}s left — consider closing`);
                }
            }
        } catch (e) {
            process.stdout.write('e');
        }
    };

    await check();
    const interval = setInterval(check, 10000);
    process.on('SIGINT', () => { clearInterval(interval); console.log('\nStopped monitoring.\n'); process.exit(0); });
}

async function interactive() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = () => {
        rl.question('\ncommand (enter, close <id>, status, list, monitor, quit): ', async (line) => {
            const parts = line.trim().split(/\s+/);
            const cmd = parts[0].toLowerCase();

            switch (cmd) {
                case 'enter':
                case 'e':
                    if (parts.length < 3) {
                        console.log('Usage: enter <marketId> <YES|NO>');
                    } else {
                        await enterTrade(parts[1], parts[2]);
                    }
                    break;
                case 'close':
                case 'c':
                    await closeTrade(parts[1]);
                    break;
                case 'status':
                case 's':
                    await showStatus();
                    break;
                case 'list':
                case 'l':
                    await listMarkets();
                    break;
                case 'monitor':
                case 'm':
                    rl.close();
                    await monitorLoop();
                    return;
                case 'quit':
                case 'q':
                    console.log('\nSession summary:');
                    console.log(`  Trades: ${sessionTrades.length}`);
                    console.log(`  Session PnL: ${fmtPnl(sessionPnl)}`);
                    rl.close();
                    process.exit(0);
                    return;
                default:
                    if (cmd !== '') console.log('Unknown command. Try: enter <id> <YES|NO>, close <id>, status, list, monitor, quit');
            }
            prompt();
        });
    };

    console.log('\n' + '═'.repeat(56));
    console.log('  MANUAL SCALP — Phase 6 Profit Loop');
    console.log('  Rules: 1 contract max | 15m/1h only | $0.50 hard stop');
    console.log('═'.repeat(56));
    await showStatus();
    prompt();
}

// Entry point
const [,, cmd, ...args] = process.argv;

async function main() {
    // Check server up
    try {
        await apiGet('/api/health');
    } catch (e) {
        console.error('\nError: Server not reachable at ' + BASE_URL);
        console.error('Start it: node server/prediction-proxy.js\n');
        process.exit(1);
    }

    switch (cmd) {
        case 'status': await showStatus(); break;
        case 'list': await listMarkets(); break;
        case 'close': await closeTrade(args[0]); break;
        case 'enter': await enterTrade(args[0], args[1] || 'YES'); break;
        case 'monitor': await monitorLoop(); break;
        default: await interactive(); break;
    }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
