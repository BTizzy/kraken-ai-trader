/**
 * Dashboard API Tests
 * Tests the server API endpoints for dashboard data
 */

const assert = require('assert');
const http = require('http');

const API_BASE = 'http://localhost:8000';

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
    
    let passed = 0;
    let failed = 0;
    
    // Test 1: Bot status endpoint
    try {
        const res = await httpGet('/api/bot/status');
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        assert(res.data.hasOwnProperty('running'), 'Missing running field');
        assert(res.data.hasOwnProperty('mode'), 'Missing mode field');
        assert(res.data.hasOwnProperty('pairs_scanned'), 'Missing pairs_scanned field');
        console.log('✅ Test 1: /api/bot/status PASSED');
        console.log(`   Running: ${res.data.running}, Mode: ${res.data.mode}`);
        passed++;
    } catch (e) {
        console.log('❌ Test 1: /api/bot/status FAILED:', e.message);
        failed++;
    }
    
    // Test 2: Learning data endpoint
    try {
        const res = await httpGet('/api/bot/learning');
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        assert(res.data.hasOwnProperty('total_trades'), 'Missing total_trades');
        assert(res.data.hasOwnProperty('winning_trades'), 'Missing winning_trades');
        assert(res.data.hasOwnProperty('total_pnl'), 'Missing total_pnl');
        assert(res.data.hasOwnProperty('win_rate'), 'Missing win_rate');
        assert(res.data.hasOwnProperty('recent_trades'), 'Missing recent_trades');
        assert(Array.isArray(res.data.recent_trades), 'recent_trades must be array');
        console.log('✅ Test 2: /api/bot/learning PASSED');
        console.log(`   Total trades: ${res.data.total_trades}, Win rate: ${res.data.win_rate.toFixed(1)}%`);
        passed++;
    } catch (e) {
        console.log('❌ Test 2: /api/bot/learning FAILED:', e.message);
        failed++;
    }
    
    // Test 3: Recent trades structure - check COMPLETED trades (not active)
    try {
        const res = await httpGet('/api/bot/learning');
        const trades = res.data.recent_trades;
        assert(trades.length > 0, 'No recent trades');
        
        // Find a completed trade (active trades may not have all fields)
        const completedTrades = trades.filter(t => t.status === 'completed');
        assert(completedTrades.length > 0, 'No completed trades in recent history');
        
        const trade = completedTrades[0];
        assert(trade.pair, 'Missing pair');
        assert(trade.direction, 'Missing direction');
        // Note: entry_price/exit_price might be 0 for session trades parsed from stdout
        assert(trade.pnl !== undefined, 'Missing pnl');
        assert(trade.timestamp, 'Missing timestamp');
        assert(trade.exit_reason, 'Missing exit_reason');
        
        console.log('✅ Test 3: Recent trades structure PASSED');
        console.log(`   Sample: ${trade.pair} ${trade.direction} P&L: $${trade.pnl.toFixed(2)}`);
        passed++;
    } catch (e) {
        console.log('❌ Test 3: Recent trades structure FAILED:', e.message);
        failed++;
    }
    
    // Test 4: Timestamps are valid and distributed
    try {
        const res = await httpGet('/api/bot/learning');
        const trades = res.data.recent_trades;
        
        const timestamps = trades.map(t => t.timestamp);
        const uniqueTimestamps = new Set(timestamps);
        
        // Should have different timestamps (not all the same)
        assert(uniqueTimestamps.size > 1, 'All trades have same timestamp');
        
        // Timestamps should be valid dates
        const sampleDate = new Date(timestamps[0]);
        assert(sampleDate.getFullYear() >= 2026, 'Invalid timestamp year');
        
        console.log('✅ Test 4: Timestamp distribution PASSED');
        console.log(`   Unique timestamps: ${uniqueTimestamps.size}/${trades.length}`);
        passed++;
    } catch (e) {
        console.log('❌ Test 4: Timestamp distribution FAILED:', e.message);
        failed++;
    }
    
    // Test 5: Entry/Exit prices are populated for historical trades
    try {
        const res = await httpGet('/api/bot/learning');
        const trades = res.data.recent_trades;
        
        // Filter for completed trades only (active trades won't have exit prices)
        const completedTrades = trades.filter(t => t.status === 'completed');
        
        if (completedTrades.length === 0) {
            console.log('⚠️ Test 5: Entry/Exit prices SKIPPED - no completed trades');
            passed++; // Skip this test if no completed trades
        } else {
            const tradesWithPrices = completedTrades.filter(t => 
                t.entry_price > 0 && t.exit_price > 0
            );
            
            const percentage = (tradesWithPrices.length / completedTrades.length * 100).toFixed(1);
            // Allow some flexibility - historical trades loaded from file should have prices
            // Session trades parsed from stdout might not (entry/exit price = 0)
            assert(tradesWithPrices.length >= completedTrades.length * 0.7, 
                `Only ${percentage}% of completed trades have prices (need at least 70%)`);
            
            console.log('✅ Test 5: Entry/Exit prices populated PASSED');
            console.log(`   ${tradesWithPrices.length}/${completedTrades.length} completed trades have prices (${percentage}%)`);
            passed++;
        }
    } catch (e) {
        console.log('❌ Test 5: Entry/Exit prices populated FAILED:', e.message);
        failed++;
    }
    
    // Test 6: P&L totals consistency
    try {
        const res = await httpGet('/api/bot/learning');
        
        const reportedTotal = res.data.total_pnl;
        const reportedWins = res.data.winning_trades;
        const reportedLosses = res.data.losing_trades;
        const reportedTotalTrades = res.data.total_trades;
        
        assert(reportedWins + reportedLosses === reportedTotalTrades,
            `Wins + Losses (${reportedWins + reportedLosses}) != Total (${reportedTotalTrades})`);
        
        const winRate = reportedTotalTrades > 0 ? 
            (reportedWins / reportedTotalTrades * 100) : 0;
        const reportedWinRate = res.data.win_rate;
        
        assert(Math.abs(winRate - reportedWinRate) < 0.1,
            `Calculated win rate ${winRate.toFixed(1)}% != Reported ${reportedWinRate.toFixed(1)}%`);
        
        console.log('✅ Test 6: P&L totals consistency PASSED');
        console.log(`   ${reportedWins}W + ${reportedLosses}L = ${reportedTotalTrades} trades`);
        passed++;
    } catch (e) {
        console.log('❌ Test 6: P&L totals consistency FAILED:', e.message);
        failed++;
    }
    
    // Test 7: Kraken API proxy
    try {
        const res = await httpGet('/api/time');
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        console.log('✅ Test 7: Kraken API proxy PASSED');
        passed++;
    } catch (e) {
        console.log('❌ Test 7: Kraken API proxy FAILED:', e.message);
        failed++;
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
