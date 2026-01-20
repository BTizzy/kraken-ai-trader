#!/usr/bin/env node
/**
 * Fix Historical Trade Data - Correct Fee Calculations
 * 
 * Problem: Historical trades were calculated with 0.4% fees (entry only)
 *          but should be 0.8% (entry + exit round-trip)
 * 
 * This script:
 * 1. Backs up current trade_log.json
 * 2. Recalculates P&L with correct 0.8% fees
 * 3. Updates win/loss classifications
 * 4. Regenerates pattern statistics
 */

const fs = require('fs');
const path = require('path');

const TRADE_LOG_PATH = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
const BACKUP_PATH = path.join(__dirname, '..', 'bot', 'build', `trade_log_backup_prefeefix_${Date.now()}.json`);

const OLD_FEE_RATE = 0.004;  // What was used (0.4%)
const NEW_FEE_RATE = 0.008;  // What it should be (0.8%)
const FEE_DIFFERENCE = NEW_FEE_RATE - OLD_FEE_RATE;  // 0.4% missing per trade

function loadTrades() {
    if (!fs.existsSync(TRADE_LOG_PATH)) {
        console.error('❌ trade_log.json not found');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8'));
}

function backupTrades(data) {
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(data, null, 2));
    console.log(`📁 Backed up to: ${BACKUP_PATH}`);
}

function fixTrade(trade) {
    const position = trade.position_size || 100;  // Default if missing
    const missingFee = position * FEE_DIFFERENCE;
    
    // Original P&L was calculated with only entry fee
    // Correct P&L = original P&L - missing exit fee
    const originalPnl = trade.pnl || 0;
    const correctedPnl = originalPnl - missingFee;
    
    return {
        ...trade,
        pnl: parseFloat(correctedPnl.toFixed(4)),
        pnl_original: originalPnl,  // Keep original for reference
        fee_corrected: true,
        fee_correction_amount: -missingFee
    };
}

function calculateStats(trades) {
    const completed = trades.filter(t => t.pnl !== undefined);
    const wins = completed.filter(t => t.pnl > 0);
    const losses = completed.filter(t => t.pnl <= 0);
    
    const totalPnl = completed.reduce((sum, t) => sum + t.pnl, 0);
    const winPnl = wins.reduce((sum, t) => sum + t.pnl, 0);
    const lossPnl = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
    
    return {
        total_trades: completed.length,
        wins: wins.length,
        losses: losses.length,
        win_rate: completed.length > 0 ? (wins.length / completed.length * 100).toFixed(2) + '%' : '0%',
        total_pnl: totalPnl.toFixed(2),
        avg_pnl: completed.length > 0 ? (totalPnl / completed.length).toFixed(4) : 0,
        profit_factor: lossPnl > 0 ? (winPnl / lossPnl).toFixed(3) : 'N/A',
        avg_win: wins.length > 0 ? (winPnl / wins.length).toFixed(4) : 0,
        avg_loss: losses.length > 0 ? (lossPnl / losses.length).toFixed(4) : 0
    };
}

function main() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║     FIX HISTORICAL TRADE DATA - FEE CORRECTION             ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    // Load and backup
    const data = loadTrades();
    backupTrades(data);
    
    const originalTrades = data.trades || [];
    console.log(`📊 Loaded ${originalTrades.length} trades\n`);
    
    // Calculate stats BEFORE fix
    console.log('BEFORE FEE CORRECTION:');
    const beforeStats = calculateStats(originalTrades);
    console.log(`  Total Trades: ${beforeStats.total_trades}`);
    console.log(`  Win Rate: ${beforeStats.win_rate} (${beforeStats.wins}W / ${beforeStats.losses}L)`);
    console.log(`  Total P&L: $${beforeStats.total_pnl}`);
    console.log(`  Avg P&L: $${beforeStats.avg_pnl}`);
    console.log(`  Profit Factor: ${beforeStats.profit_factor}`);
    console.log(`  Avg Win: $${beforeStats.avg_win} | Avg Loss: $${beforeStats.avg_loss}\n`);
    
    // Fix trades
    console.log('Applying fee correction (0.4% → 0.8%)...\n');
    const fixedTrades = originalTrades.map(fixTrade);
    
    // Calculate stats AFTER fix
    console.log('AFTER FEE CORRECTION:');
    const afterStats = calculateStats(fixedTrades);
    console.log(`  Total Trades: ${afterStats.total_trades}`);
    console.log(`  Win Rate: ${afterStats.win_rate} (${afterStats.wins}W / ${afterStats.losses}L)`);
    console.log(`  Total P&L: $${afterStats.total_pnl}`);
    console.log(`  Avg P&L: $${afterStats.avg_pnl}`);
    console.log(`  Profit Factor: ${afterStats.profit_factor}`);
    console.log(`  Avg Win: $${afterStats.avg_win} | Avg Loss: $${afterStats.avg_loss}\n`);
    
    // Show impact
    const pnlDiff = parseFloat(afterStats.total_pnl) - parseFloat(beforeStats.total_pnl);
    console.log('IMPACT:');
    console.log(`  P&L Change: $${pnlDiff.toFixed(2)}`);
    console.log(`  Win Rate Change: ${beforeStats.win_rate} → ${afterStats.win_rate}`);
    console.log(`  Profit Factor Change: ${beforeStats.profit_factor} → ${afterStats.profit_factor}\n`);
    
    // Save
    data.trades = fixedTrades;
    data.fee_corrected_at = Date.now();
    data.fee_correction_note = 'P&L corrected from 0.4% to 0.8% round-trip fees';
    
    fs.writeFileSync(TRADE_LOG_PATH, JSON.stringify(data, null, 2));
    console.log('✅ Saved corrected trade_log.json\n');
    
    // Verify
    const verification = JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8'));
    const verifyStats = calculateStats(verification.trades);
    console.log('VERIFICATION (re-read from file):');
    console.log(`  Total P&L: $${verifyStats.total_pnl}`);
    console.log(`  Win Rate: ${verifyStats.win_rate}`);
}

// Run with --dry-run to see impact without saving
if (process.argv.includes('--dry-run')) {
    console.log('🔍 DRY RUN MODE - No changes will be saved\n');
    const data = loadTrades();
    const originalTrades = data.trades || [];
    
    const beforeStats = calculateStats(originalTrades);
    const fixedTrades = originalTrades.map(fixTrade);
    const afterStats = calculateStats(fixedTrades);
    
    console.log(`Before: Win Rate ${beforeStats.win_rate}, P&L $${beforeStats.total_pnl}`);
    console.log(`After:  Win Rate ${afterStats.win_rate}, P&L $${afterStats.total_pnl}`);
    console.log(`Change: $${(parseFloat(afterStats.total_pnl) - parseFloat(beforeStats.total_pnl)).toFixed(2)}`);
} else {
    main();
}
