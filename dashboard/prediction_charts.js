/**
 * Prediction Market Dashboard - Client-Side Logic
 * WebSocket connection, UI updates, and chart rendering
 */

const API_BASE = window.location.origin;
const WS_URL = `ws://${window.location.host}/ws`;

let ws = null;
let botRunning = false;
let reconnectTimer = null;
const maxLogEntries = 100;

// ===== WebSocket Connection =====

function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    ws = new WebSocket(WS_URL);

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
        const status = s.actionable ? '🟢 TRADE' : s.on_cooldown ? '🔵 COOL' : s.score >= 50 ? '🟡 WATCH' : '⚫ LOW';
        const title = (s.title || 'Unknown').substring(0, 40);

        return `<tr class="${rowClass}">
            <td title="${s.title}">${title}</td>
            <td class="${scoreClass}">${s.score.toFixed(0)}</td>
            <td class="${dirClass}">${s.direction || '--'}</td>
            <td>${geminiMid}¢</td>
            <td>${refMid}¢</td>
            <td>${spreadDiff}</td>
            <td>${volume}</td>
            <td>${status}</td>
        </tr>`;
    }).join('');
}

function updatePositionsTable(trades) {
    const tbody = document.getElementById('positions-body');
    document.getElementById('position-count').textContent = trades.length;

    if (!trades || trades.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No open positions</td></tr>';
        return;
    }

    tbody.innerHTML = trades.map(t => {
        const holdTime = Math.floor(Date.now() / 1000) - t.timestamp;
        const holdStr = holdTime < 60 ? `${holdTime}s` : `${Math.floor(holdTime / 60)}m`;
        const dirClass = t.direction === 'YES' ? 'dir-yes' : 'dir-no';
        const title = (t.market_title || 'Unknown').substring(0, 35);

        return `<tr>
            <td title="${t.market_title}">${title}</td>
            <td class="${dirClass}">${t.direction}</td>
            <td>${t.entry_price?.toFixed(3) || '--'}</td>
            <td>--</td>
            <td>$${t.position_size?.toFixed(0) || '--'}</td>
            <td>--</td>
            <td>${holdStr}</td>
            <td>${t.take_profit_price?.toFixed(2) || '--'}/${t.stop_loss_price?.toFixed(2) || '--'}</td>
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
    const data = await apiFetch('/api/trades/recent?limit=30');
    if (!data || !data.trades) return;

    const tbody = document.getElementById('trades-body');
    if (data.trades.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No trades yet</td></tr>';
        return;
    }

    tbody.innerHTML = data.trades.map(t => {
        const time = new Date(t.timestamp * 1000).toLocaleTimeString();
        const pnlClass = t.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
        const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
        const holdStr = t.hold_time < 60 ? `${t.hold_time}s` : `${Math.floor(t.hold_time / 60)}m`;
        const dirClass = t.direction === 'YES' ? 'dir-yes' : 'dir-no';
        const title = (t.market_title || 'Unknown').substring(0, 30);

        return `<tr>
            <td>${time}</td>
            <td title="${t.market_title}">${title}</td>
            <td class="${dirClass}">${t.direction}</td>
            <td>${t.entry_price?.toFixed(3) || '--'}</td>
            <td>${t.exit_price?.toFixed(3) || '--'}</td>
            <td>$${t.position_size?.toFixed(0) || '--'}</td>
            <td class="${pnlClass}">${pnlStr}</td>
            <td>${holdStr}</td>
            <td>${t.exit_reason || '--'}</td>
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

async function editParam(key, currentValue) {
    const newValue = prompt(`Edit parameter: ${key}\nCurrent value: ${currentValue}`, currentValue);
    if (newValue === null || newValue === '') return;

    const parsed = parseFloat(newValue);
    if (isNaN(parsed)) {
        alert('Invalid number');
        return;
    }

    await apiPost(`/api/parameters/${key}`, { value: parsed });
    addLog(`Parameter ${key} updated: ${currentValue} → ${parsed}`, 'info');

    // Refresh
    const status = await apiFetch('/api/bot/status');
    if (status) updateStatus(status);
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

    // Periodic refresh every 5 seconds (backup for WebSocket)
    setInterval(periodicRefresh, 5000);
    setInterval(loadRecentTrades, 15000);
});
