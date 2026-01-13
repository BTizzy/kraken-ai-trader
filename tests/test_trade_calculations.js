/**
 * Trade Calculation Tests
 * Tests P&L calculations, fee handling, and trade validation
 */

const assert = require('assert');

// Configuration constants (should match bot)
const FEE_RATE = 0.004;  // 0.4% Kraken fee
const DEFAULT_POSITION_SIZE = 100;
const DEFAULT_LEVERAGE = 1.0;

// Test utilities
function calculateExpectedPnL(entryPrice, exitPrice, positionSize, leverage, direction = 'LONG') {
    const effectivePosition = positionSize * leverage;
    let pricePnlPct;
    
    if (direction === 'LONG') {
        pricePnlPct = (exitPrice - entryPrice) / entryPrice;
    } else {
        pricePnlPct = (entryPrice - exitPrice) / entryPrice;
    }
    
    const grossPnL = effectivePosition * pricePnlPct;
    const fees = effectivePosition * FEE_RATE;
    const netPnL = grossPnL - fees;
    
    return {
        grossPnL,
        fees,
        netPnL,
        pricePnlPct: pricePnlPct * 100
    };
}

function runTests() {
    console.log('='.repeat(60));
    console.log('TRADE CALCULATION TESTS');
    console.log('='.repeat(60));
    
    let passed = 0;
    let failed = 0;
    
    // Test 1: LONG trade with profit
    try {
        const result = calculateExpectedPnL(100, 101, 100, 1.0, 'LONG');
        assert(result.grossPnL === 1.0, `Expected gross P&L 1.0, got ${result.grossPnL}`);
        assert(result.fees === 0.4, `Expected fees 0.4, got ${result.fees}`);
        assert(result.netPnL === 0.6, `Expected net P&L 0.6, got ${result.netPnL}`);
        console.log('✅ Test 1: LONG profit calculation PASSED');
        passed++;
    } catch (e) {
        console.log('❌ Test 1: LONG profit calculation FAILED:', e.message);
        failed++;
    }
    
    // Test 2: LONG trade with loss
    try {
        const result = calculateExpectedPnL(100, 99, 100, 1.0, 'LONG');
        assert(result.grossPnL === -1.0, `Expected gross P&L -1.0, got ${result.grossPnL}`);
        assert(result.netPnL === -1.4, `Expected net P&L -1.4, got ${result.netPnL}`);
        console.log('✅ Test 2: LONG loss calculation PASSED');
        passed++;
    } catch (e) {
        console.log('❌ Test 2: LONG loss calculation FAILED:', e.message);
        failed++;
    }
    
    // Test 3: SHORT trade with profit (price drops)
    try {
        const result = calculateExpectedPnL(100, 99, 100, 1.0, 'SHORT');
        assert(result.grossPnL === 1.0, `Expected gross P&L 1.0, got ${result.grossPnL}`);
        assert(result.netPnL === 0.6, `Expected net P&L 0.6, got ${result.netPnL}`);
        console.log('✅ Test 3: SHORT profit calculation PASSED');
        passed++;
    } catch (e) {
        console.log('❌ Test 3: SHORT profit calculation FAILED:', e.message);
        failed++;
    }
    
    // Test 4: SHORT trade with loss (price rises)
    try {
        const result = calculateExpectedPnL(100, 101, 100, 1.0, 'SHORT');
        assert(result.grossPnL === -1.0, `Expected gross P&L -1.0, got ${result.grossPnL}`);
        assert(result.netPnL === -1.4, `Expected net P&L -1.4, got ${result.netPnL}`);
        console.log('✅ Test 4: SHORT loss calculation PASSED');
        passed++;
    } catch (e) {
        console.log('❌ Test 4: SHORT loss calculation FAILED:', e.message);
        failed++;
    }
    
    // Test 5: Breakeven threshold calculation
    // Need price to move > fees to profit
    try {
        const breakeven = FEE_RATE * 100;  // 0.4%
        const result = calculateExpectedPnL(100, 100.4, 100, 1.0, 'LONG');
        // At exactly 0.4% move, gross = $0.40, fees = $0.40, net = $0
        assert(Math.abs(result.netPnL) < 0.01, `Expected near-zero P&L, got ${result.netPnL}`);
        console.log('✅ Test 5: Breakeven threshold PASSED');
        passed++;
    } catch (e) {
        console.log('❌ Test 5: Breakeven threshold FAILED:', e.message);
        failed++;
    }
    
    // Test 6: Real trade from log validation
    // ATHUSD: Entry 0.01006, Exit 0.01005, P&L -0.43
    try {
        const result = calculateExpectedPnL(0.01006, 0.01005, 100, 0.9, 'LONG');
        const expectedNetPnL = -0.45;  // Approximately
        assert(Math.abs(result.netPnL - (-0.45)) < 0.05, 
            `Expected ~-0.45, got ${result.netPnL}`);
        console.log('✅ Test 6: Real trade validation PASSED');
        console.log(`   Entry: $0.01006, Exit: $0.01005`);
        console.log(`   Gross P&L: $${result.grossPnL.toFixed(4)}`);
        console.log(`   Fees: $${result.fees.toFixed(4)}`);
        console.log(`   Net P&L: $${result.netPnL.toFixed(4)}`);
        passed++;
    } catch (e) {
        console.log('❌ Test 6: Real trade validation FAILED:', e.message);
        failed++;
    }
    
    // Test 7: Minimum profitable move calculation
    try {
        // To profit after 0.4% fees, price must move > 0.4%
        const minMoveForProfit = FEE_RATE;
        const result = calculateExpectedPnL(100, 100.5, 100, 1.0, 'LONG');
        assert(result.netPnL > 0, `Expected profit, got ${result.netPnL}`);
        console.log('✅ Test 7: Minimum profitable move PASSED');
        console.log(`   Minimum move for profit: >${(minMoveForProfit * 100).toFixed(1)}%`);
        passed++;
    } catch (e) {
        console.log('❌ Test 7: Minimum profitable move FAILED:', e.message);
        failed++;
    }
    
    // Test 8: Leverage impact on fees
    try {
        const lowLev = calculateExpectedPnL(100, 101, 100, 0.5, 'LONG');
        const highLev = calculateExpectedPnL(100, 101, 100, 2.0, 'LONG');
        assert(highLev.fees === lowLev.fees * 4, `Fees should scale with leverage`);
        assert(highLev.grossPnL === lowLev.grossPnL * 4, `P&L should scale with leverage`);
        console.log('✅ Test 8: Leverage impact PASSED');
        passed++;
    } catch (e) {
        console.log('❌ Test 8: Leverage impact FAILED:', e.message);
        failed++;
    }
    
    console.log('\n' + '='.repeat(60));
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));
    
    return { passed, failed };
}

// Run if called directly
if (require.main === module) {
    const results = runTests();
    process.exit(results.failed > 0 ? 1 : 0);
}

module.exports = { calculateExpectedPnL, runTests };
