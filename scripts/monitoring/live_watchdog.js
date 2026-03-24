#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { execSync } = require('child_process');
const path = require('path');
const GeminiClient = require('../lib/gemini_client');

const ROOT = path.resolve(__dirname, '..');
const API = process.env.WATCHDOG_API || 'http://localhost:3003';
const POLL_MS = parseInt(process.env.WATCHDOG_POLL_MS || '30000', 10);
const RESTART_DELAY_MS = parseInt(process.env.WATCHDOG_RESTART_DELAY_MS || '20000', 10);
const TARGET_BALANCE = parseFloat(process.env.WATCHDOG_TARGET_BALANCE || '1000');
const LIVE_LOSS_LIMIT = parseFloat(process.env.WATCHDOG_LIVE_LOSS_LIMIT || '-5');

const gemini = new GeminiClient({ mode: 'live', logLevel: process.env.LOG_LEVEL || 'WARN' });

let coolingDownUntil = 0;

function ts() {
  return new Date().toISOString();
}

async function httpJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return r.json();
}

function isBotProcessRunning() {
  try {
    const out = execSync("ps -ef | grep -E 'node server/prediction-proxy.js' | grep -v grep || true", { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function startBot() {
  const cmd = 'nohup env GEMINI_MODE=live TRADING_PROFILE=short-run node server/prediction-proxy.js >> logs/live_run.log 2>&1 &';
  execSync(cmd, { cwd: ROOT, stdio: 'ignore' });
}

async function emergencyStop(reason) {
  try {
    const res = await httpJson(`${API}/api/bot/emergency-stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    console.log(`${ts()} | EMERGENCY_STOP | reason=${reason} | closed=${res.closed_count || 0} | pnl=${res.total_pnl || 0}`);
  } catch (e) {
    console.log(`${ts()} | EMERGENCY_STOP_FAILED | reason=${reason} | err=${e.message}`);
  }
}

async function ensureRunning() {
  const now = Date.now();
  if (now < coolingDownUntil) return;

  let health;
  try {
    health = await httpJson(`${API}/api/health`);
  } catch {
    health = null;
  }

  if (!health || !health.bot_running) {
    if (!isBotProcessRunning()) {
      startBot();
      console.log(`${ts()} | STARTED | mode=live profile=short-run`);
    }
  }
}

async function loop() {
  try {
    await ensureRunning();

    let status = null;
    let health = null;
    try { status = await httpJson(`${API}/api/bot/status`); } catch {}
    try { health = await httpJson(`${API}/api/health`); } catch {}

    let balance = null;
    try {
      balance = await gemini.getAvailableBalance();
    } catch (e) {
      console.log(`${ts()} | BALANCE_ERR | ${e.message}`);
    }

    if (status) {
      const liveToday = status.paper_live_split?.live?.today?.daily_pnl;
      const liveTrades = status.paper_live_split?.live?.today?.trade_count;
      const liveOpen = status.paper_live_split?.live?.open_positions;
      const mode = status.mode;
      const profile = status.trading_profile || status.parameters?.trading_profile || 'unknown';
      const cbOpen = Boolean(status.circuit_breaker?.open);

      console.log(`${ts()} | STATUS | mode=${mode} profile=${profile} bal=${balance ?? 'n/a'} live_pnl=${liveToday ?? 'n/a'} live_trades=${liveTrades ?? 'n/a'} live_open=${liveOpen ?? 'n/a'} cb_open=${cbOpen}`);

      if (balance != null && balance >= TARGET_BALANCE) {
        console.log(`${ts()} | TARGET_REACHED | balance=${balance} >= ${TARGET_BALANCE}`);
      }

      if (mode !== 'live') {
        await emergencyStop(`mode_not_live_${mode}`);
        coolingDownUntil = Date.now() + RESTART_DELAY_MS;
        return;
      }

      if (typeof liveToday === 'number' && liveToday <= LIVE_LOSS_LIMIT) {
        await emergencyStop(`live_daily_pnl_${liveToday}`);
        coolingDownUntil = Date.now() + RESTART_DELAY_MS;
        return;
      }

      if (cbOpen || health?.circuit_breaker?.open) {
        await emergencyStop('circuit_breaker_open');
        coolingDownUntil = Date.now() + RESTART_DELAY_MS;
      }
    }
  } catch (e) {
    console.log(`${ts()} | WATCHDOG_ERR | ${e.message}`);
  }
}

console.log(`${ts()} | WATCHDOG_START | api=${API} target=${TARGET_BALANCE} loss_limit=${LIVE_LOSS_LIMIT}`);

setInterval(loop, POLL_MS);
loop();
