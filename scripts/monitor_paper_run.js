#!/usr/bin/env node
// Monitor script to run the full state model in paper mode for a specified duration
// and collect health/errors from server and bot without modifying processes.

const http = require('http');
const { spawnSync } = require('child_process');

const RUN_SECONDS = parseInt(process.env.RUN_SECONDS) || 600; // default 10 minutes
const BASE = process.env.SERVER_URL || 'http://localhost:3002';
const HEALTH_BASE = process.env.HEALTH_URL || 'http://localhost:3006';
const HEALTH_STALE_MS = parseInt(process.env.HEALTH_STALE_MS) || 60000; // consider sidecar stale after this

function httpGet(path) {
    return new Promise((resolve) => {
        const opts = { method: 'GET', host: new URL(BASE).hostname, port: new URL(BASE).port, path };
        // If requesting internal endpoints, include internal secret header
        if (path.startsWith('/internal') && process.env.INTERNAL_SECRET) {
            opts.headers = { 'X-INTERNAL-SECRET': process.env.INTERNAL_SECRET };
        }
        http.get(Object.assign({}, opts, { protocol: new URL(BASE).protocol }), (res) => {
            let data = '';
            res.on('data', (c) => data += c.toString());
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }).on('error', (err) => resolve({ status: 0, error: err.message }));
    });
}

function isProcessRunning(name) {
    const r = spawnSync('pgrep', ['-f', name]);
    return r.status === 0 && r.stdout && r.stdout.toString().trim().length > 0;
}

(async function main() {
    console.log('Starting paper-mode monitoring for', RUN_SECONDS, 'seconds');
    console.log('Server base URL:', BASE);

    // Pre-check server readiness: try status2 and routes, but don't abort the run if missing
    let status2Ok = false;
    const preStatus2 = await httpGet('/api/collector/status2');
    if (preStatus2.status === 200) {
        status2Ok = true;
        console.log('/api/collector/status2 OK');
    } else {
        console.warn('/api/collector/status2 not available (continuing with fallback probes):', preStatus2.status, preStatus2.body || preStatus2.error);
    }

    // Pre-check health sidecar if available
    const healthPre = await (async () => {
        return new Promise((resolve) => {
            http.get(`${HEALTH_BASE}/health/collector`, (res) => {
                let data = '';
                res.on('data', (c) => data += c.toString());
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            }).on('error', (err) => resolve({ status: 0, error: err.message }));
        });
    })();
    if (healthPre.status === 200) {
        console.log('Health sidecar OK at', HEALTH_BASE);
    } else {
        console.warn('Health sidecar not available at', HEALTH_BASE, healthPre.status, healthPre.error || '');
    }

    const routes = await httpGet('/__routes__');
    if (routes.status === 200) {
        try { console.log('/__routes__:', JSON.parse(routes.body)); } catch (e) { console.log('/__routes__ returned non-json'); }
    } else {
        console.warn('/__routes__ not available (continuing):', routes.status);
    }

    const startTs = Date.now();
    const endTs = startTs + RUN_SECONDS * 1000;
    const events = [];

    while (Date.now() < endTs) {
        const now = Date.now();
        const uptime = Math.floor((now - startTs) / 1000);
        // Prefer health sidecar as primary signal for collector health
        let usedSidecar = false;
        try {
            const h = await new Promise(r => {
                http.get(`${HEALTH_BASE}/health/collector`, (res) => {
                    let data = '';
                    res.on('data', c => data += c.toString());
                    res.on('end', () => r({ status: res.statusCode, body: data }));
                }).on('error', (err) => r({ status: 0, error: err.message }));
            });
            if (h.status === 200) {
                usedSidecar = true;
                try {
                    const parsed = JSON.parse(h.body);
                    const pairInfo = parsed.pairs && parsed.pairs['PI_XBTUSD'];
                    if (pairInfo) {
                        if (pairInfo.age_ms > HEALTH_STALE_MS) {
                            events.push({ ts: now, type: 'health_sidecar_stale', age_ms: pairInfo.age_ms });
                            console.error('Health sidecar reports stale data at', uptime + 's', pairInfo.age_ms);
                        } else {
                            events.push({ ts: now, type: 'collector_ok_via_sidecar' });
                            console.log('Collector OK via health sidecar at', uptime + 's');
                        }
                    } else {
                        events.push({ ts: now, type: 'health_sidecar_no_pair' });
                        console.error('Health sidecar missing pair data at', uptime + 's');
                    }
                } catch (e) {
                    events.push({ ts: now, type: 'health_sidecar_parse_error', error: e.message });
                    console.error('Failed to parse health sidecar response at', uptime + 's', e.message);
                }
            }
        } catch (e) {
            // sidecar request failed; fall back to main collector status
            usedSidecar = false;
        }

        if (!usedSidecar) {
            // Check server collector status
            const coll = await httpGet('/api/collector/status');
            if (coll.status !== 200) {
                events.push({ ts: now, type: 'collector_unhealthy', status: coll.status, body: coll.body || coll.error });
                console.error('Collector unhealthy at', uptime + 's', coll.status, coll.body || coll.error);
                // Fallback probe: try a lightweight status2 endpoint we control
                const coll2 = await httpGet('/api/collector/status2');
                if (coll2.status === 200) {
                    events.push({ ts: now, type: 'collector_status2_ok' });
                    console.log('Collector status2 OK at', uptime + 's');
                } else {
                    events.push({ ts: now, type: 'collector_status2_unavailable', status: coll2.status });
                    console.error('Collector status2 unavailable at', uptime + 's', coll2.status);
                    // Fallback to health sidecar if available
                    try {
                        const h = await new Promise(r => { http.get(`${HEALTH_BASE}/health/collector`, (res) => {
                            let data=''; res.on('data', c => data += c.toString()); res.on('end', () => r({ status: res.statusCode, body: data }));
                        }).on('error', (err) => r({ status: 0, error: err.message })); });
                        if (h.status === 200) {
                            events.push({ ts: now, type: 'health_sidecar_ok' });
                            console.log('Health sidecar OK at', uptime + 's');
                        } else {
                            events.push({ ts: now, type: 'health_sidecar_unavailable', status: h.status });
                            console.error('Health sidecar unavailable at', uptime + 's', h.status, h.error || '');
                        }
                    } catch (e) {
                        events.push({ ts: now, type: 'health_sidecar_error', error: e.message });
                    }
                }
            } else {
                try {
                    const parsed = JSON.parse(coll.body);
                    if (parsed.fatal) {
                        events.push({ ts: now, type: 'collector_fatal', info: parsed.fatal });
                        console.error('Collector fatal at', uptime + 's', parsed.fatal);
                    }
                    // Monitor websocket status if present
                    const st = parsed.status || {};
                    if (st.ws_status && st.ws_status !== 'connected') {
                        events.push({ ts: now, type: 'collector_ws_not_connected', ws_status: st.ws_status });
                        console.error('Collector websocket not connected at', uptime + 's', st.ws_status);
                    }
                    if (st.last_ws_message_ts && (Date.now() - st.last_ws_message_ts) > 60000) {
                        events.push({ ts: now, type: 'collector_ws_stale', last_ws_message_ts: st.last_ws_message_ts });
                        console.error('Collector websocket stale (no messages in last minute) at', uptime + 's');
                    }
                } catch (e) {
                    // ignore parse errors
                }
            }
        }

        // Poll volatility endpoint
        const vol = await httpGet('/api/volatility/PI_XBTUSD?minutes=60');
        if (vol.status !== 200) {
            events.push({ ts: now, type: 'vol_unavailable', status: vol.status, body: vol.body || vol.error });
            console.error('Volatility endpoint returned non-200 at', uptime + 's', vol.status, vol.body || vol.error);
            // Try a direct price probe as a fallback signal
            // Prefer authoritative DB-backed price probe to avoid loopback hijacking
            const p = await httpGet('/api/prices/authoritative/PI_XBTUSD?limit=1');
            if (p.status === 200) {
                events.push({ ts: now, type: 'price_probe_ok' });
                console.log('Price probe OK at', uptime + 's');
            } else {
                events.push({ ts: now, type: 'price_probe_unavailable', status: p.status });
                console.error('Price probe unavailable at', uptime + 's', p.status);
            }
        } else {
            try {
                const parsed = JSON.parse(vol.body);
                if (!parsed.volatility || parsed.volatility <= 0) {
                    events.push({ ts: now, type: 'vol_zero', val: parsed.volatility });
                    console.error('Volatility zero or missing at', uptime + 's', parsed.volatility);
                }
            } catch (e) {
                events.push({ ts: now, type: 'vol_parse_error', error: e.message });
                console.error('Volatility parse error at', uptime + 's', e.message);
            }
        }

        // Also probe collector status2 and whoami to capture which process responds
        const s2 = await httpGet('/api/collector/status2');
        if (s2.status === 200) {
            events.push({ ts: now, type: 'collector_status2_ok' });
        } else {
            events.push({ ts: now, type: 'collector_status2_unavailable', status: s2.status });
        }
        const who = await httpGet('/_whoami');
        if (who.status === 200) {
            try { events.push({ ts: now, type: 'whoami', info: JSON.parse(who.body) }); } catch (e) { events.push({ ts: now, type: 'whoami_raw', body: who.body }); }
        }

        // Poll bot status
        const bot = await httpGet('/api/bot/status');
        if (bot.status !== 200) {
            events.push({ ts: now, type: 'bot_status_unavailable', status: bot.status, body: bot.body || bot.error });
            console.error('Bot status unavailable at', uptime + 's', bot.status);
        }

        // Check processes
        const serverRunning = isProcessRunning('kraken-proxy.js');
        const botRunning = isProcessRunning('kraken_bot');
        if (!serverRunning) {
            events.push({ ts: now, type: 'server_down' });
            console.error('Server process not running at', uptime + 's');
        }
        if (!botRunning) {
            events.push({ ts: now, type: 'bot_down' });
            console.error('Bot process not running at', uptime + 's');
        }

        // Wait next cycle (10s)
        await new Promise(r => setTimeout(r, 10000));
    }

    // Summary
    console.log('Run complete. Summary of events:');
    const counts = events.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {});
    console.log('Event counts:', counts);
    const fatalEvents = events.filter(e => e.type === 'collector_fatal');
    if (fatalEvents.length > 0) {
        console.error('Fatal collector events detected:', fatalEvents);
    }

    if (Object.keys(counts).length === 0) {
        console.log('No issues detected during monitoring period.');
        process.exit(0);
    } else {
        console.error('Issues detected during monitoring period.');
        process.exit(2);
    }
})();
