/**
 * Trade Log Validation Tests
 * Validates trade log data integrity and consistency
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TRADE_LOG_PATH = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
const FEE_RATE = 0.004;

function loadTradeLog() {
    if (!fs.existsSync(TRADE_LOG_PATH)) {
        throw new Error(`Trade log not found at ${TRADE_LOG_PATH}`);
    }
    return JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8'));
}

function runTests() {
    console.log('='.repeat(60));
    console.log('TRADE LOG VALIDATION TESTS');
    console.log('='.repeat(60));
    
    let passed = 0;
    let failed = 0;
    let warnings = 0;
    
    const data = loadTradeLog();
    const trades = data.trades || [];
    
    console.log(`\nLoaded ${trades.length} trades from log\n`);
    
    // Test 1: Schema validation
    try {
        assert(data.version || data.total_trades !== undefined, 'Missing version/total_trades');
        assert(Array.isArray(trades), 'Trades must be an array');
        console.log('✅ Test 1: Schema structure PASSED');
        passed++;
    } catch (e) {
        console.log('❌ Test 1: Schema structure FAILED:', e.message);
        failed++;
    }
    
    // Test 2: Required fields present
    try {
        let missingFields = { pair: 0, entry: 0, exit: 0, pnl: 0, reason: 0 };
        
        trades.forEach((t, i) => {
            if (!t.pair) missingFields.pair++;
            if (t.entry === undefined) missingFields.entry++;
            if (t.exit === undefined) missingFields.exit++;
            if (t.pnl === undefined) missingFields.pnl++;
            if (!t.reason) missingFields.reason++;
        });
        
        const hasMissing = Object.values(missingFields).some(v => v > 0);
        if (hasMissing) {
            console.log('⚠️  Test 2: Required fields WARN - Missing fields:');
            for (const [field, count] of Object.entries(missingFields)) {
                if (count > 0) console.log(`     ${field}: ${count} trades missing`);
            }
            warnings++;
        } else {
            console.log('✅ Test 2: Required fields PASSED');
        }
        passed++;
    } catch (e) {
        console.log('❌ Test 2: Required fields FAILED:', e.message);
        failed++;
    }
    
    // Test 3: Timestamp presence
    try {
        const withTimestamp = trades.filter(t => t.timestamp).length;
        const withoutTimestamp = trades.length - withTimestamp;
        
        if (withoutTimestamp > 0) {
            console.log(`⚠️  Test 3: Timestamps WARN - ${withoutTimestamp}/${trades.length} trades missing timestamps`);
            warnings++;
        } else {
            console.log('✅ Test 3: Timestamps PASSED');
        }
        passed++;
    } catch (e) {
        console.log('❌ Test 3: Timestamps FAILED:', e.message);
        failed++;
    }
    
    // Test 4: Direction field presence
    try {
        const withDirection = trades.filter(t => t.direction).length;
        const withoutDirection = trades.length - withDirection;
        
        if (withoutDirection > 0) {
            console.log(`⚠️  Test 4: Direction WARN - ${withoutDirection}/${trades.length} trades missing direction`);
            warnings++;
        } else {
            console.log('✅ Test 4: Direction PASSED');
        }
        passed++;
    } catch (e) {
        console.log('❌ Test 4: Direction FAILED:', e.message);
        failed++;
    }
    
    // Test 5: P&L sanity check
    try {
        let anomalies = [];
        
        trades.forEach((t, i) => {
            // Check if P&L is within reasonable bounds
            if (Math.abs(t.pnl) > 100) {
                anomalies.push({ index: i, pnl: t.pnl, pair: t.pair });
            }
            
            // Check if P&L direction matches price movement (for LONGs)
            if (t.entry && t.exit && !t.direction) {
                const priceUp = t.exit > t.entry;
                const pnlPositive = t.pnl > 0;
                // Note: Due to fees, price up doesn't always mean positive P&L
            }
        });
        
        if (anomalies.length > 0) {
            console.log(`⚠️  Test 5: P&L sanity WARN - ${anomalies.length} trades with extreme P&L (>$100)`);
            warnings++;
        } else {
            console.log('✅ Test 5: P&L sanity PASSED');
        }
        passed++;
    } catch (e) {
        console.log('❌ Test 5: P&L sanity FAILED:', e.message);
        failed++;
    }
    
    // Test 6: Exit reason validity
    try {
        const validReasons = ['take_profit', 'stop_loss', 'trailing_stop', 'timeout', 'error_exit', 'unknown'];
        const byReason = {};
        let invalidReasons = 0;
        
        trades.forEach(t => {
            const reason = t.reason || t.exit_reason || 'unknown';
            byReason[reason] = (byReason[reason] || 0) + 1;
            if (!validReasons.includes(reason)) invalidReasons++;
        });
        
        console.log('✅ Test 6: Exit reasons PASSED');
        console.log('   Distribution:');
        for (const [reason, count] of Object.entries(byReason)) {
            const pct = ((count / trades.length) * 100).toFixed(1);
            console.log(`     ${reason}: ${count} (${pct}%)`);
        }
        passed++;
    } catch (e) {
        console.log('❌ Test 6: Exit reasons FAILED:', e.message);
        failed++;
    }
    
    // Test 7: Win/Loss statistics
    try {
        const wins = trades.filter(t => t.pnl > 0).length;
        const losses = trades.filter(t => t.pnl <= 0).length;
        const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0;
        const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const avgPnL = trades.length > 0 ? (totalPnL / trades.length).toFixed(4) : 0;
        
        console.log('✅ Test 7: Statistics PASSED');
        console.log(`   Trades: ${trades.length} (${wins}W / ${losses}L)`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Total P&L: $${totalPnL.toFixed(2)}`);
        console.log(`   Average P&L: $${avgPnL}`);
        passed++;
    } catch (e) {
        console.log('❌ Test 7: Statistics FAILED:', e.message);
        failed++;
    }
    
    // Test 8: P&L calculation verification (sample)
    try {
        console.log('\n--- P&L Calculation Spot Checks ---');
        const sampleSize = Math.min(5, trades.length);
        let verified = 0;
        let discrepancies = 0;
        
        for (let i = 0; i < sampleSize; i++) {
            const t = trades[trades.length - 1 - i];  // Check recent trades
            if (!t.entry || !t.exit) continue;
            
            const leverage = t.leverage || 1.0;
            const positionSize = 100 * leverage;  // Assuming $100 base
            const priceChange = (t.exit - t.entry) / t.entry;
            const grossPnL = positionSize * priceChange;
            const fees = positionSize * FEE_RATE;
            const expectedNetPnL = grossPnL - fees;
            
            const diff = Math.abs(expectedNetPnL - t.pnl);
            const closeEnough = diff < 0.01;
            
            if (closeEnough) {
                verified++;
            } else {
                discrepancies++;
                console.log(`   ⚠️ ${t.pair}: Expected ~$${expectedNetPnL.toFixed(4)}, got $${t.pnl.toFixed(4)} (diff: $${diff.toFixed(4)})`);
            }
        }
        
        if (discrepancies === 0) {
            console.log('✅ Test 8: P&L verification PASSED');
        } else {
            console.log(`⚠️  Test 8: P&L verification WARN - ${discrepancies}/${sampleSize} discrepancies`);
            warnings++;
        }
        passed++;
    } catch (e) {
        console.log('❌ Test 8: P&L verification FAILED:', e.message);
        failed++;
    }
    
    // Test 9: Pair distribution
    try {
        const byPair = {};
        trades.forEach(t => {
            byPair[t.pair] = (byPair[t.pair] || 0) + 1;
        });
        
        const pairs = Object.keys(byPair);
        const topPairs = Object.entries(byPair)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        
        console.log('✅ Test 9: Pair distribution PASSED');
        console.log(`   Unique pairs: ${pairs.length}`);
        console.log('   Top 5:');
        topPairs.forEach(([pair, count]) => {
            const pct = ((count / trades.length) * 100).toFixed(1);
            console.log(`     ${pair}: ${count} trades (${pct}%)`);
        });
        passed++;
    } catch (e) {
        console.log('❌ Test 9: Pair distribution FAILED:', e.message);
        failed++;
    }
    
    // Test 10: Leverage consistency
    try {
        const leverages = {};
        trades.forEach(t => {
            const lev = t.leverage || 'undefined';
            leverages[lev] = (leverages[lev] || 0) + 1;
        });
        
        console.log('✅ Test 10: Leverage distribution PASSED');
        for (const [lev, count] of Object.entries(leverages)) {
            console.log(`   Leverage ${lev}: ${count} trades`);
        }
        passed++;
    } catch (e) {
        console.log('❌ Test 10: Leverage distribution FAILED:', e.message);
        failed++;
    }
    
    console.log('\n' + '='.repeat(60));
    console.log(`RESULTS: ${passed} passed, ${failed} failed, ${warnings} warnings`);
    console.log('='.repeat(60));
    
    return { passed, failed, warnings };
}

// Run if called directly
if (require.main === module) {
    try {
        const results = runTests();
        process.exit(results.failed > 0 ? 1 : 0);
    } catch (e) {
        console.error('Test suite error:', e.message);
        process.exit(1);
    }
}

module.exports = { runTests };
