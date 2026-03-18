/**
 * Dashboard API Tests
 * Tests the server API endpoints for dashboard data
 */

const assert = require('assert');
const http = require('http');

const API_BASE = process.env.API_BASE || 'http://localhost:3003';
const API_TEST_MODE = (process.env.API_TEST_MODE || 'prediction').toLowerCase(); // 'prediction' | 'legacy'

function httpGet(path) {
    return new Promise((resolve, reject) => {
        http.get(`${API_BASE}${path}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        }).on('error', reject);
    });
}

async function runTests() {
    console.log('='.repeat(60));
    console.log('DASHBOARD API TESTS');
    console.log('='.repeat(60));
    console.log(`Mode: ${API_TEST_MODE}, Base: ${API_BASE}`);
    
    let passed = 0;
    let failed = 0;
    
    if (API_TEST_MODE === 'legacy') {
        // Legacy contract checks (kraken-proxy)
        try {
            const res = await httpGet('/api/bot/status');
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.data.hasOwnProperty('running'), 'Missing running field');
            assert(res.data.hasOwnProperty('mode'), 'Missing mode field');
            assert(res.data.hasOwnProperty('pairs_scanned'), 'Missing pairs_scanned field');
            console.log('✅ Test 1: /api/bot/status (legacy) PASSED');
            passed++;
        } catch (e) {
            console.log('❌ Test 1: /api/bot/status (legacy) FAILED:', e.message);
            failed++;
        }

        try {
            const res = await httpGet('/api/bot/learning');
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(Array.isArray(res.data.recent_trades), 'recent_trades must be array');
            assert(res.data.hasOwnProperty('total_trades'), 'Missing total_trades');
            console.log('✅ Test 2: /api/bot/learning (legacy) PASSED');
            passed++;
        } catch (e) {
            console.log('❌ Test 2: /api/bot/learning (legacy) FAILED:', e.message);
            failed++;
        }

        try {
            const res = await httpGet('/api/time');
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            console.log('✅ Test 3: /api/time (legacy) PASSED');
            passed++;
        } catch (e) {
            console.log('❌ Test 3: /api/time (legacy) FAILED:', e.message);
            failed++;
        }
    } else {
        // Prediction contract checks (prediction-proxy)
        try {
            const res = await httpGet('/api/health');
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.data.hasOwnProperty('status'), 'Missing status field');
            console.log('✅ Test 1: /api/health (prediction) PASSED');
            passed++;
        } catch (e) {
            console.log('❌ Test 1: /api/health (prediction) FAILED:', e.message);
            failed++;
        }

        try {
            const res = await httpGet('/api/bot/status');
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.data.hasOwnProperty('running'), 'Missing running field');
            assert(res.data.hasOwnProperty('mode'), 'Missing mode field');
            assert(res.data.hasOwnProperty('stop_reason'), 'Missing stop_reason field');
            assert(res.data.hasOwnProperty('live_preflight'), 'Missing live_preflight field');
            console.log('✅ Test 2: /api/bot/status (prediction) PASSED');
            passed++;
        } catch (e) {
            console.log('❌ Test 2: /api/bot/status (prediction) FAILED:', e.message);
            failed++;
        }

        try {
            const res = await httpGet('/api/trades/recent?limit=10');
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(Array.isArray(res.data.trades), 'trades must be array');
            assert(typeof res.data.count === 'number', 'count must be number');
            console.log('✅ Test 3: /api/trades/recent (prediction) PASSED');
            passed++;
        } catch (e) {
            console.log('❌ Test 3: /api/trades/recent (prediction) FAILED:', e.message);
            failed++;
        }

        try {
            const res = await httpGet('/api/markets');
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(Array.isArray(res.data.markets), 'markets must be array');
            console.log('✅ Test 4: /api/markets (prediction) PASSED');
            passed++;
        } catch (e) {
            console.log('❌ Test 4: /api/markets (prediction) FAILED:', e.message);
            failed++;
        }

        try {
            const res = await httpGet('/api/session/checkpoint');
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.data.hasOwnProperty('decision'), 'Missing decision field');
            assert(res.data.hasOwnProperty('metrics'), 'Missing metrics field');
            assert(typeof res.data.decision.value === 'string', 'decision.value must be string');
            console.log('✅ Test 5: /api/session/checkpoint (prediction) PASSED');
            passed++;
        } catch (e) {
            console.log('❌ Test 5: /api/session/checkpoint (prediction) FAILED:', e.message);
            failed++;
        }

        try {
            const res = await httpGet('/api/session/readiness');
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(typeof res.data.ready_to_start === 'boolean', 'ready_to_start must be boolean');
            assert(Array.isArray(res.data.checks), 'checks must be array');
            assert(typeof res.data.summary === 'string', 'summary must be string');
            console.log('✅ Test 6: /api/session/readiness (prediction) PASSED');
            passed++;
        } catch (e) {
            console.log('❌ Test 6: /api/session/readiness (prediction) FAILED:', e.message);
            failed++;
        }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));
    
    return { passed, failed };
}

// Run if called directly
if (require.main === module) {
    runTests()
        .then(results => process.exit(results.failed > 0 ? 1 : 0))
        .catch(e => {
            console.error('Test suite error:', e.message);
            process.exit(1);
        });
}

module.exports = { runTests };
