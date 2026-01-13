#!/usr/bin/env node
/**
 * Trade Log Migration Script
 * 
 * Migrates legacy trade data to include all required fields:
 * - timestamp: Estimates based on file modification date and trade index
 * - direction: Defaults to "LONG" for legacy trades (pre-SHORT support)
 * - Normalizes leverage to 1.0 for consistency
 * 
 * PRESERVES ALL TRAINING DATA - only adds missing fields
 */

const fs = require('fs');
const path = require('path');

const TRADE_LOG_PATH = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'bot', 'build', 'trade_log_migrated.json');

// Configuration
const CONFIG = {
    // Estimated start date of trading (adjust based on your actual start)
    estimatedStartDate: new Date('2026-01-09T00:00:00Z'),
    // Average time between trades in milliseconds (for timestamp estimation)
    avgTradeIntervalMs: 60 * 1000,  // 1 minute average
    // Default values for missing fields
    defaults: {
        direction: 'LONG',
        leverage: 1.0,
        position_size: 100,
        timeframe_seconds: 60
    }
};

function loadTradeLog() {
    if (!fs.existsSync(TRADE_LOG_PATH)) {
        throw new Error(`Trade log not found at ${TRADE_LOG_PATH}`);
    }
    return JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8'));
}

function estimateTimestamp(index, totalTrades, startDate, endDate) {
    // Distribute trades evenly between start and end dates
    const totalDuration = endDate.getTime() - startDate.getTime();
    const intervalPerTrade = totalDuration / totalTrades;
    return startDate.getTime() + (index * intervalPerTrade);
}

function migrateTrade(trade, index, totalTrades, startDate, endDate) {
    const migrated = { ...trade };
    
    // 1. Add timestamp if missing
    if (!migrated.timestamp) {
        migrated.timestamp = estimateTimestamp(index, totalTrades, startDate, endDate);
    }
    
    // 2. Add direction if missing (all legacy trades are LONG)
    if (!migrated.direction) {
        migrated.direction = CONFIG.defaults.direction;
    }
    
    // 3. Normalize leverage (0.9 seems like a bug, should be 1.0)
    // Keep the original for calculation accuracy, but flag it
    if (migrated.leverage === 0.9) {
        migrated.original_leverage = 0.9;
        // Don't change it - the P&L was calculated with 0.9, so keep it consistent
    }
    
    // 4. Normalize field names (reason -> exit_reason for consistency)
    if (migrated.reason && !migrated.exit_reason) {
        migrated.exit_reason = migrated.reason;
    }
    
    // 5. Add entry_price/exit_price aliases if only entry/exit exist
    if (migrated.entry !== undefined && migrated.entry_price === undefined) {
        migrated.entry_price = migrated.entry;
    }
    if (migrated.exit !== undefined && migrated.exit_price === undefined) {
        migrated.exit_price = migrated.exit;
    }
    
    return migrated;
}

function validateMigration(original, migrated) {
    const issues = [];
    
    // Check that all original data is preserved
    if (original.pair !== migrated.pair) issues.push('pair mismatch');
    if (original.entry !== migrated.entry) issues.push('entry mismatch');
    if (original.exit !== migrated.exit) issues.push('exit mismatch');
    if (Math.abs(original.pnl - migrated.pnl) > 0.0001) issues.push('pnl mismatch');
    
    // Check new required fields exist
    if (!migrated.timestamp) issues.push('missing timestamp');
    if (!migrated.direction) issues.push('missing direction');
    
    return issues;
}

function runMigration(dryRun = false) {
    console.log('='.repeat(60));
    console.log('TRADE LOG MIGRATION');
    console.log('='.repeat(60));
    console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
    console.log('');
    
    // Load original data
    const data = loadTradeLog();
    const trades = data.trades || [];
    
    console.log(`Loaded ${trades.length} trades from ${TRADE_LOG_PATH}`);
    
    // Analyze current state
    const analysis = {
        total: trades.length,
        withTimestamp: trades.filter(t => t.timestamp).length,
        withDirection: trades.filter(t => t.direction).length,
        withLeverage09: trades.filter(t => t.leverage === 0.9).length,
        withLeverage10: trades.filter(t => t.leverage === 1.0).length,
        uniquePairs: new Set(trades.map(t => t.pair)).size
    };
    
    console.log('\nCurrent State Analysis:');
    console.log(`  Trades with timestamp: ${analysis.withTimestamp}/${analysis.total}`);
    console.log(`  Trades with direction: ${analysis.withDirection}/${analysis.total}`);
    console.log(`  Trades with leverage 0.9: ${analysis.withLeverage09}`);
    console.log(`  Trades with leverage 1.0: ${analysis.withLeverage10}`);
    console.log(`  Unique pairs: ${analysis.uniquePairs}`);
    
    // Estimate date range for timestamp assignment
    const fileStats = fs.statSync(TRADE_LOG_PATH);
    const endDate = fileStats.mtime;
    const startDate = CONFIG.estimatedStartDate;
    
    console.log(`\nTimestamp estimation range:`);
    console.log(`  Start: ${startDate.toISOString()}`);
    console.log(`  End: ${endDate.toISOString()}`);
    
    // Migrate trades
    console.log('\nMigrating trades...');
    const migratedTrades = trades.map((trade, index) => 
        migrateTrade(trade, index, trades.length, startDate, endDate)
    );
    
    // Validate migration
    let validationErrors = 0;
    trades.forEach((original, index) => {
        const issues = validateMigration(original, migratedTrades[index]);
        if (issues.length > 0) {
            validationErrors++;
            if (validationErrors <= 5) {
                console.log(`  ⚠️ Trade ${index}: ${issues.join(', ')}`);
            }
        }
    });
    
    if (validationErrors > 0) {
        console.log(`\n⚠️ ${validationErrors} validation issues found`);
    } else {
        console.log('\n✅ All trades validated successfully');
    }
    
    // Post-migration analysis
    const postAnalysis = {
        total: migratedTrades.length,
        withTimestamp: migratedTrades.filter(t => t.timestamp).length,
        withDirection: migratedTrades.filter(t => t.direction).length,
    };
    
    console.log('\nPost-Migration State:');
    console.log(`  Trades with timestamp: ${postAnalysis.withTimestamp}/${postAnalysis.total}`);
    console.log(`  Trades with direction: ${postAnalysis.withDirection}/${postAnalysis.total}`);
    
    // Sample output
    console.log('\nSample migrated trade:');
    console.log(JSON.stringify(migratedTrades[migratedTrades.length - 1], null, 2));
    
    // Write output
    if (!dryRun) {
        const output = {
            version: '2.0',
            migrated_at: Date.now(),
            migration_notes: 'Added timestamps, direction, normalized fields',
            total_trades: migratedTrades.length,
            trades: migratedTrades
        };
        
        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
        console.log(`\n✅ Migrated data written to ${OUTPUT_PATH}`);
        
        // Also update the original file
        fs.writeFileSync(TRADE_LOG_PATH, JSON.stringify(output, null, 2));
        console.log(`✅ Original file updated at ${TRADE_LOG_PATH}`);
    } else {
        console.log('\n[DRY RUN] No files were modified');
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('MIGRATION COMPLETE');
    console.log('='.repeat(60));
    
    return { success: true, migratedCount: migratedTrades.length };
}

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-n');

if (require.main === module) {
    try {
        runMigration(dryRun);
    } catch (e) {
        console.error('Migration failed:', e.message);
        process.exit(1);
    }
}

module.exports = { runMigration, migrateTrade, validateMigration };
