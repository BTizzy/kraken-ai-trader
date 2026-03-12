# Must Read Before Any Agent Task

## Mission
Run a reliable, profitable 15-minute live trading session with capital protection first.

Priority order:
1. State correctness (exchange/DB/orders must agree)
2. Exit reliability (no DB close unless exchange exit is confirmed)
3. Risk controls (hard daily/session loss cap)
4. Profit optimization (only after 1-3 are stable)

## Hard Rules
1. Never place new live entries if reconciliation is not clean.
2. Never close DB trade on failed/unfilled live exit.
3. Keep one live position max during autonomous 15m sessions unless explicitly widened.
4. Stop session immediately when live daily/session PnL breaches configured loss cap.
5. Use deterministic cleanup flow: cancel active orders -> close available quantity -> re-check -> classify leftovers.

## Autonomous 15m Session Mode
Enable with environment variables:

- AUTONOMOUS_15M_SESSION=true
- SESSION_DAILY_LOSS_LIMIT_USD=3
- SESSION_MIN_TTX_SECONDS=600
- SESSION_MAX_TTX_SECONDS=3600
- SESSION_MAX_CONCURRENT_LIVE=1

Behavior:
- Entries restricted to GEMI contracts with TTX in [600, 3600] seconds.
- Pre-trade gate fail-closes entries when unresolved orphaned/phantom/qty mismatch/open orders exist.
- Pre-trade gate blocks entries when session PnL since bot start <= `-SESSION_DAILY_LOSS_LIMIT_USD`, when orphaned live positions exist, when phantom live trades exist, or when quantity mismatches exist.
- Hard stop shuts down the bot if the session loss cap is breached after startup.

## Standard Run Order (Live)
1. Stop bot if running.
2. Capture ground truth snapshot.
3. Run reconcile fix (live mode only).
4. Run verification gates.
5. Start constrained session (autonomous or manual).
6. Keep periodic reconcile heartbeat active.

Commands:

- curl -sS -X POST http://localhost:3003/api/bot/stop | jq .
- curl -sS http://localhost:3003/api/bot/ground-truth | jq .
- curl -sS -X POST http://localhost:3003/api/reconcile/fix | jq .
- node scripts/verify_gates.js
- curl -sS -X POST http://localhost:3003/api/bot/start | jq .
- curl -sS http://localhost:3003/api/reconcile | jq .

## Runtime Checks
Use these endpoints continuously:

- /api/bot/status
	- watch: running, warmup_remaining, open_positions, wallet.balance, daily_pnl
	- watch: pre_trade_gate and session_policy (from trading engine status)
- /api/reconcile
	- require: orphaned=0, phantom(non-pending)=0, quantityMismatch=0
- /api/bot/ground-truth
	- require flat-state before and after cleanup cycles

## Rollback Conditions (Immediate)
Stop session and reconcile/fix if any of these occur:
1. orphaned > 0
2. phantom(non-pending) > 0
3. quantityMismatch > 0
4. repeated unfilled exits without clean cancel/retry resolution
5. live daily/session PnL beyond loss cap

## First Milestone Before Scaling
Do not widen risk until all are true:
1. 20 live trades completed
2. Net realized live PnL > 0
3. No unresolved reconciliation drift across repeated runs
4. Exit lifecycle remains clean (no premature DB closes)
