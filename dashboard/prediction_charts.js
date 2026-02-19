/**
 * Prediction Market Dashboard - Client-Side Logic
 * WebSocket connection, UI updates, and chart rendering
 */

const API_BASE = window.location.origin;
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.host}/ws`;

let ws = null;
let botRunning = false;
let reconnectTimer = null;
const maxLogEntries = 100;

// ===== WebSocket Connection =====

function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    try {
        ws = new WebSocket(WS_URL);
    } catch (e) {
        console.warn('WebSocket construction failed, using REST polling only:', e.message);
        document.querySelector('h1').classList.remove('ws-connected');
        document.querySelector('h1').classList.add('ws-disconnected');
        return;
    }

    ws.onopen = () => {
        addLog('WebSocket connected', 'info');
        document.querySelector('h1').classList.add('ws-connected');
        document.querySelector('h1').classList.remove('ws-disconnected');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleWSMessage(msg);
        } catch (e) {
            console.error('WS parse error:', e);
        }
    };

    ws.onclose = () => {
        document.querySelector('h1').classList.remove('ws-connected');
        document.querySelector('h1').classList.add('ws-disconnected');
        reconnectTimer = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (error) => {
        console.error('WS error:', error);
    };
}

function handleWSMessage(msg) {
    switch (msg.type) {
        case 'init':
            updateStatus(msg.data.status);
            updateSignals(msg.data.signals);
            break;
        case 'price_update':
            updateWallet(msg.data.wallet);
            updateSignals(msg.data.signals);
            document.getElementById('open-positions').textContent = msg.data.open_trades;
            break;
        case 'trade_update':
            if (msg.data.entries) {
                for (const entry of msg.data.entries) {
                    addLog(`ENTRY: ${entry.order.direction} @ $${entry.order.fill_price.toFixed(3)} ($${entry.positionSize})`, 'trade');
                }
            }
            if (msg.data.exits) {
                for (const exit of msg.data.exits) {
                    const pnlStr = exit.pnl >= 0 ? `+$${exit.pnl.toFixed(2)}` : `-$${Math.abs(exit.pnl).toFixed(2)}`;
                    addLog(`EXIT (${exit.exitReason}): ${pnlStr} in ${exit.holdTime}s`, 'exit');
                }
            }
            if (msg.data.status) updateStatus(msg.data.status);
            loadRecentTrades();
            break;
        case 'match_update':
            addLog(`Market match: ${msg.data.matched_count} markets matched (Poly=${msg.data.polymarket_count}, Kalshi=${msg.data.kalshi_count})`, 'info');
            break;
        case 'emergency_stop':
            addLog(`EMERGENCY STOP: ${msg.data.closed} positions closed, P&L: $${msg.data.totalPnl.toFixed(2)}`, 'error');
            loadRecentTrades();
            periodicRefresh();
            break;
    }
}

// ===== API Calls =====

async function apiFetch(endpoint) {
    try {
        const res = await fetch(`${API_BASE}${endpoint}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (error) {
        console.error(`API error (${endpoint}):`, error);
        return null;
    }
}

async function apiPost(endpoint, body = {}) {
    try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return await res.json();
    } catch (error) {
        console.error(`API POST error (${endpoint}):`, error);
        return null;
    }
}

// ===== UI Update Functions =====

function updateWallet(wallet) {
    if (!wallet) return;
    const balance = document.getElementById('wallet-balance');
    const pnl = document.getElementById('wallet-pnl');

    balance.textContent = `$${wallet.balance.toFixed(2)}`;

    const totalPnl = wallet.total_pnl || (wallet.balance - wallet.initial_balance);
    pnl.textContent = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
    pnl.className = `wallet-pnl ${totalPnl >= 0 ? 'positive' : 'negative'}`;
}

function updateStatus(status) {
    if (!status) return;

    botRunning = status.running;
    const statusBadge = document.getElementById('bot-status');
    const startBtn = document.getElementById('btn-start');

    statusBadge.textContent = status.running ? 'RUNNING' : 'STOPPED';
    statusBadge.className = `status-badge ${status.running ? 'status-running' : 'status-stopped'}`;

    startBtn.textContent = status.running ? 'Stop Bot' : 'Start Bot';
    startBtn.className = `btn ${status.running ? 'btn-stop' : 'btn-start'}`;

    // Mode badge
    if (status.mode) {
        const modeBadge = document.getElementById('mode-badge');
        const isLive = status.mode === 'live';
        modeBadge.textContent = isLive ? 'LIVE' : 'PAPER';
        modeBadge.className = `mode-badge ${isLive ? 'mode-live' : 'mode-paper'}`;

        // Update wallet label
        const walletLabel = document.querySelector('.wallet-label');
        if (walletLabel) walletLabel.textContent = isLive ? 'Live Wallet' : 'Paper Wallet';
    }

    // Sharpe ratio
    if (status.sharpe !== undefined) {
        const sharpeEl = document.getElementById('sharpe-ratio');
        if (status.sharpe !== null) {
            sharpeEl.textContent = status.sharpe.toFixed(2);
            sharpeEl.className = `metric-value ${status.sharpe >= 2 ? 'positive' : status.sharpe >= 1 ? '' : 'negative'}`;
        } else {
            sharpeEl.textContent = '--';
        }
    }

    // Circuit breaker
    if (status.circuit_breaker) {
        const cbEl = document.getElementById('circuit-breaker');
        if (status.circuit_breaker.open) {
            cbEl.textContent = 'OPEN';
            cbEl.className = 'metric-value cb-open';
        } else {
            cbEl.textContent = 'OK';
            cbEl.className = 'metric-value cb-ok';
        }
        document.getElementById('health-errors').textContent = status.circuit_breaker.consecutive_errors || 0;
    }

    if (status.wallet) updateWallet(status.wallet);

    if (status.daily_pnl) {
        const dailyEl = document.getElementById('daily-pnl');
        const pnl = status.daily_pnl.daily_pnl || 0;
        dailyEl.textContent = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        dailyEl.className = `metric-value ${pnl >= 0 ? 'positive' : 'negative'}`;

        const trades = status.daily_pnl.trade_count || 0;
        const wins = status.daily_pnl.wins || 0;
        const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) + '%' : '--';
        document.getElementById('win-rate').textContent = winRate;
        document.getElementById('total-trades').textContent = trades;
    }

    document.getElementById('open-positions').textContent = status.open_positions || 0;

    if (status.wallet) {
        document.getElementById('max-drawdown').textContent =
            (status.wallet.max_drawdown_pct || 0).toFixed(1) + '%';
    }

    // Uptime
    if (status.uptime) {
        const secs = Math.floor(status.uptime / 1000);
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        document.getElementById('health-uptime').textContent = h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    if (status.mode) {
        document.getElementById('health-mode').textContent = status.mode.toUpperCase();
    }

    // Update parameters
    if (status.parameters) {
        updateParameters(status.parameters);
    }

    // Update open positions table
    if (status.open_trades) {
        updatePositionsTable(status.open_trades);
    }
}

function updateSignals(signals) {
    if (!signals || !Array.isArray(signals)) return;

    document.getElementById('signal-count').textContent = signals.length;

    const tbody = document.getElementById('signals-body');
    if (signals.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Waiting for signals...</td></tr>';
        return;
    }

    tbody.innerHTML = signals.map(s => {
        const scoreClass = s.score >= 60 ? 'score-high' : s.score >= 40 ? 'score-medium' : 'score-low';
        const rowClass = s.actionable ? 'signal-actionable' : s.score >= 50 ? 'signal-watch' : '';
        const dirClass = s.direction === 'YES' ? 'dir-yes' : s.direction === 'NO' ? 'dir-no' : '';
        const geminiMid = (s.gemini_bid && s.gemini_ask) ? ((s.gemini_bid + s.gemini_ask) / 2).toFixed(2) : '--';
        const refMid = s.referencePrice ? s.referencePrice.toFixed(2) : '--';
        const spreadDiff = s.details?.spread_differential ? s.details.spread_differential.toFixed(3) : '--';
        const volume = s.gemini_volume ? `$${(s.gemini_volume / 1000).toFixed(1)}k` : '--';
        const status = s.actionable ? 'TRADE' : s.on_cooldown ? 'COOL' : s.score >= 50 ? 'WATCH' : 'LOW';
        const statusClass = s.actionable ? 'status-trade' : s.on_cooldown ? 'status-cool' : s.score >= 50 ? 'status-watch' : 'status-low';
        const title = (s.title || 'Unknown').substring(0, 40);

        return `<tr class="${rowClass}">
            <td title="${s.title}">${title}</td>
            <td class="${scoreClass}">${s.score.toFixed(0)}</td>
            <td class="${dirClass}">${s.direction || '--'}</td>
            <td>${geminiMid}</td>
            <td>${refMid}</td>
            <td>${spreadDiff}</td>
            <td>${volume}</td>
            <td class="${statusClass}">${status}</td>
        </tr>`;
    }).join('');
}

function updatePositionsTable(trades) {
    const tbody = document.getElementById('positions-body');
    document.getElementById('position-count').textContent = trades.length;

    if (!trades || trades.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No open positions</td></tr>';
        return;
    }

    tbody.innerHTML = trades.map(t => {
        const holdTime = Math.floor(Date.now() / 1000) - t.timestamp;
        const holdStr = holdTime < 60 ? `${holdTime}s` : `${Math.floor(holdTime / 60)}m`;
        const dirClass = t.direction === 'YES' ? 'dir-yes' : 'dir-no';
        const title = (t.market_title || 'Unknown').substring(0, 35);
        const isLive = t.mode === 'live';
        const modeBadge = isLive
            ? '<span class="mode-badge-inline mode-live-inline">LIVE</span>'
            : '<span class="mode-badge-inline mode-paper-inline">PAPER</span>';

        return `<tr>
            <td title="${t.market_title}">${title}</td>
            <td>${modeBadge}</td>
            <td class="${dirClass}">${t.direction}</td>
            <td>${t.entry_price?.toFixed(3) || '--'}</td>
            <td>--</td>
            <td>$${t.position_size?.toFixed(0) || '--'}</td>
            <td>--</td>
            <td>${holdStr}</td>
            <td>${t.take_profit_price?.toFixed(2) || '--'}/${t.stop_loss_price?.toFixed(2) || '--'}</td>
            <td><button class="btn btn-close-position" onclick="closePosition(${t.id})" title="Close position">X</button></td>
        </tr>`;
    }).join('');
}

function updateParameters(params) {
    const container = document.getElementById('params-container');
    if (!params || typeof params !== 'object') return;

    const paramEntries = Object.entries(params);
    if (paramEntries.length === 0) return;

    container.innerHTML = paramEntries.map(([key, value]) => {
        const displayValue = typeof value === 'number' ?
            (Number.isInteger(value) ? value : value.toFixed(4)) : value;
        const shortKey = key.replace(/_/g, ' ');

        return `<div class="param-item">
            <span class="param-key">${shortKey}</span>
            <span class="param-value" title="Click to edit" onclick="editParam('${key}', ${value})">${displayValue}</span>
        </div>`;
    }).join('');
}

async function loadRecentTrades() {
    const modeFilter = document.getElementById('mode-filter')?.value || '';
    const modeParam = modeFilter ? `&mode=${modeFilter}` : '';
    const data = await apiFetch(`/api/trades/recent?limit=30${modeParam}`);
    if (!data || !data.trades) return;

    const tbody = document.getElementById('trades-body');
    if (data.trades.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No trades yet</td></tr>';
        return;
    }

    tbody.innerHTML = data.trades.map(t => {
        const time = new Date(t.timestamp * 1000).toLocaleTimeString();
        const pnlClass = t.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
        const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
        const holdStr = t.hold_time < 60 ? `${t.hold_time}s` : `${Math.floor(t.hold_time / 60)}m`;
        const dirClass = t.direction === 'YES' ? 'dir-yes' : 'dir-no';
        const title = (t.market_title || 'Unknown').substring(0, 30);
        const reasonClass = t.exit_reason === 'emergency_stop' ? 'reason-emergency' :
                           t.exit_reason === 'manual_close' ? 'reason-manual' : '';
        const isLive = t.mode === 'live';
        const modeBadge = isLive
            ? '<span class="mode-badge-inline mode-live-inline">LIVE</span>'
            : '<span class="mode-badge-inline mode-paper-inline">PAPER</span>';
        const rowClass = isLive ? '' : 'trade-paper-row';

        return `<tr class="${rowClass}">
            <td>${time}</td>
            <td>${modeBadge}</td>
            <td title="${t.market_title}">${title}</td>
            <td class="${dirClass}">${t.direction}</td>
            <td>${t.entry_price?.toFixed(3) || '--'}</td>
            <td>${t.exit_price?.toFixed(3) || '--'}</td>
            <td>$${t.position_size?.toFixed(0) || '--'}</td>
            <td class="${pnlClass}">${pnlStr}</td>
            <td>${holdStr}</td>
            <td class="${reasonClass}">${t.exit_reason || '--'}</td>
        </tr>`;
    }).join('');
}

// ===== User Actions =====

async function toggleBot() {
    if (botRunning) {
        await apiPost('/api/bot/stop');
        addLog('Bot stopped by user', 'info');
    } else {
        await apiPost('/api/bot/start');
        addLog('Bot started by user', 'info');
    }

    // Refresh status
    setTimeout(async () => {
        const status = await apiFetch('/api/bot/status');
        if (status) updateStatus(status);
    }, 500);
}

async function emergencyStop() {
    if (!confirm('EMERGENCY STOP\n\nThis will:\n1. Stop the trading bot immediately\n2. Close ALL open positions at current market prices\n\nContinue?')) {
        return;
    }

    const btn = document.getElementById('btn-emergency');
    btn.textContent = 'STOPPING...';
    btn.disabled = true;

    const result = await apiPost('/api/bot/emergency-stop');

    if (result) {
        const pnlStr = result.totalPnl >= 0 ? `+$${result.totalPnl.toFixed(2)}` : `-$${Math.abs(result.totalPnl).toFixed(2)}`;
        addLog(`EMERGENCY STOP: ${result.closed} positions closed, P&L: ${pnlStr}`, 'error');
        alert(`Emergency Stop Complete\n\nPositions closed: ${result.closed}\nTotal P&L: ${pnlStr}`);
    } else {
        addLog('Emergency stop request failed', 'error');
    }

    btn.textContent = 'EMERGENCY STOP';
    btn.disabled = false;

    setTimeout(async () => {
        const status = await apiFetch('/api/bot/status');
        if (status) updateStatus(status);
        loadRecentTrades();
    }, 500);
}

async function closePosition(tradeId) {
    if (!confirm('Close this position at current market price?')) return;

    const result = await apiPost(`/api/bot/close-position/${tradeId}`);
    if (result && result.success) {
        const pnlStr = result.pnl >= 0 ? `+$${result.pnl.toFixed(2)}` : `-$${Math.abs(result.pnl).toFixed(2)}`;
        addLog(`CLOSED: ${result.direction} "${result.market}" P&L: ${pnlStr}`, 'exit');
    } else {
        addLog(`Failed to close position ${tradeId}: ${result?.error || 'unknown error'}`, 'error');
    }

    // Refresh
    const status = await apiFetch('/api/bot/status');
    if (status) updateStatus(status);
    loadRecentTrades();
}

async function editParam(key, currentValue) {
    const newValue = prompt(`Edit parameter: ${key}\nCurrent value: ${currentValue}`, currentValue);
    if (newValue === null || newValue === '') return;

    const parsed = parseFloat(newValue);
    if (isNaN(parsed)) {
        alert('Invalid number');
        return;
    }

    await apiPost(`/api/parameters/${key}`, { value: parsed });
    addLog(`Parameter ${key} updated: ${currentValue} -> ${parsed}`, 'info');

    // Refresh
    const status = await apiFetch('/api/bot/status');
    if (status) updateStatus(status);
}

// ===== Health Indicators =====

async function updateHealthIndicators() {
    const healthData = await apiFetch('/api/health');
    if (!healthData) return;

    // API health dots
    const apis = { poly: 'polymarket', kalshi: 'kalshi', kraken: 'kraken', gemini: 'gemini' };
    for (const [dotId, apiName] of Object.entries(apis)) {
        const dot = document.getElementById(`dot-${dotId}`);
        const apiStats = healthData.api_health?.[apiName];
        if (!dot || !apiStats) continue;

        const total = (apiStats.ok || 0) + (apiStats.fail || 0);
        if (total === 0) {
            dot.className = 'api-dot api-dot-unknown';
        } else if (apiStats.fail > 0 && apiStats.lastFail && Date.now() - apiStats.lastFail < 60000) {
            dot.className = 'api-dot api-dot-fail';
        } else {
            dot.className = 'api-dot api-dot-ok';
        }

        // Health panel details
        const healthEl = document.getElementById(`health-${dotId}`);
        if (healthEl) {
            const rate = total > 0 ? ((apiStats.ok / total) * 100).toFixed(0) : '--';
            healthEl.textContent = `${rate}% (${apiStats.ok}/${total})`;
            healthEl.className = `health-value ${total > 0 && apiStats.fail === 0 ? 'positive' : ''}`;
        }
    }

    // Circuit breaker in health panel
    if (healthData.circuit_breaker) {
        const cbEl = document.getElementById('circuit-breaker');
        if (healthData.circuit_breaker.open) {
            cbEl.textContent = 'OPEN';
            cbEl.className = 'metric-value cb-open';
        } else {
            cbEl.textContent = 'OK';
            cbEl.className = 'metric-value cb-ok';
        }
    }

    // WS client count
    if (healthData.ws_clients !== undefined) {
        document.getElementById('health-ws').textContent = healthData.ws_clients;
    }
}

// ===== Logging =====

function addLog(message, type = 'info') {
    const logContainer = document.getElementById('bot-log');
    const entry = document.createElement('div');
    const time = new Date().toLocaleTimeString();
    entry.className = `log-entry log-${type}`;
    entry.textContent = `[${time}] ${message}`;
    logContainer.insertBefore(entry, logContainer.firstChild);

    // Trim old entries
    while (logContainer.children.length > maxLogEntries) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

// ===== Arb + Momentum Panel Updates =====

function updateArbEvents(arbEvents) {
    const tbody = document.getElementById('arb-body');
    const countEl = document.getElementById('arb-count');
    if (!tbody) return;

    const events = arbEvents || [];
    countEl.textContent = events.length;

    if (events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No arb events detected</td></tr>';
        return;
    }

    tbody.innerHTML = events.map(e => {
        const edgeCents = ((e.netEdge || 0) * 100).toFixed(1);
        const edgeClass = (e.netEdge || 0) >= 0.05 ? 'score-high' : 'score-medium';
        const dirClass  = e.direction === 'YES' ? 'dir-yes' : 'dir-no';
        const title     = (e.title || e.marketId || '').substring(0, 35);
        const bidAsk    = (e.geminiBid != null && e.geminiAsk != null)
            ? `${e.geminiBid.toFixed(3)}/${e.geminiAsk.toFixed(3)}`
            : '--';
        const kFV = e.kalshiFV != null ? e.kalshiFV.toFixed(3) : '--';
        return `<tr>
            <td title="${e.title}">${title}</td>
            <td class="${dirClass}">${e.direction || '--'}</td>
            <td class="${edgeClass}">${edgeCents}c</td>
            <td>${bidAsk}</td>
            <td>${kFV}</td>
            <td>${e.score || '--'}</td>
        </tr>`;
    }).join('');
}

function updateMomentumAlerts(momentumAlerts) {
    const tbody = document.getElementById('momentum-body');
    const countEl = document.getElementById('momentum-count');
    if (!tbody) return;

    const alerts = momentumAlerts || [];
    countEl.textContent = alerts.length;

    if (alerts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No momentum alerts</td></tr>';
        return;
    }

    tbody.innerHTML = alerts.map(a => {
        const lagCents  = a.contractLag != null ? (a.contractLag * 100).toFixed(1) + 'c' : '--';
        const urgency   = a.urgency != null ? a.urgency.toFixed(2) : '--';
        const dirClass  = a.direction === 'YES' ? 'dir-yes' : 'dir-no';
        const title     = (a.title || a.marketId || '').substring(0, 35);
        return `<tr>
            <td title="${a.title}">${title}</td>
            <td>${a.asset || '--'}</td>
            <td class="${dirClass}">${a.direction || '--'}</td>
            <td>${lagCents}</td>
            <td>${urgency}</td>
            <td>${a.score || '--'}</td>
        </tr>`;
    }).join('');
}

async function loadSignalPanels() {
    const data = await apiFetch('/api/signals');
    if (!data) return;
    updateArbEvents(data.arbEvents);
    updateMomentumAlerts(data.momentumAlerts);
}

// ===== Periodic Refresh =====

async function periodicRefresh() {
    try {
        const status = await apiFetch('/api/bot/status');
        if (status) {
            updateStatus(status);
            document.getElementById('cycle-count').textContent = status.cycle_count || 0;
        }
    } catch (e) {
        // silent
    }
}

// ===== Initialize =====

document.addEventListener('DOMContentLoaded', () => {
    connectWebSocket();
    periodicRefresh();
    loadRecentTrades();
    loadSignalPanels();
    updateHealthIndicators();

    // Periodic refresh every 5 seconds (backup for WebSocket)
    setInterval(periodicRefresh, 5000);
    setInterval(loadRecentTrades, 15000);
    setInterval(loadSignalPanels, 5000);
    setInterval(updateHealthIndicators, 5000);
});
