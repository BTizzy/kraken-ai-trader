#!/usr/bin/env node

/**
 * Migrate trade_log.json to SQLite database
 * 
 * Usage: node scripts/migrate_to_sqlite.js [--force]
 * 
 * Options:
 *   --force    Overwrite existing database
 */

const fs = require('fs');
const path = require('path');
const TradeDatabase = require('../lib/database');

const TRADE_LOG_PATH = path.join(__dirname, '../bot/build/trade_log.json');
const DB_PATH = path.join(__dirname, '../data/trades.db');

async function main() {
    const forceOverwrite = process.argv.includes('--force');
    
    console.log('='.repeat(60));
    console.log('SQLite Migration Tool');
    console.log('='.repeat(60));
    
    // Check if database exists
    if (fs.existsSync(DB_PATH) && !forceOverwrite) {
        console.log('\n⚠️  Database already exists at:', DB_PATH);
        console.log('Use --force to overwrite\n');
        
        // Show current stats
        const db = new TradeDatabase(DB_PATH);
        const count = db.getTradeCount();
        console.log(`Current database has ${count} trades\n`);
        db.close();
        return;
    }
    
    // Remove existing database if force
    if (forceOverwrite && fs.existsSync(DB_PATH)) {
        console.log('Removing existing database...');
        fs.unlinkSync(DB_PATH);
        // Also remove WAL and SHM files if they exist
        const walPath = DB_PATH + '-wal';
        const shmPath = DB_PATH + '-shm';
        if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
        if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
    }
    
    // Load JSON trade log
    console.log('\n📂 Loading trade log from:', TRADE_LOG_PATH);
    
    if (!fs.existsSync(TRADE_LOG_PATH)) {
        console.error('❌ Trade log not found!');
        process.exit(1);
    }
    
    const tradeLog = JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8'));
    const trades = tradeLog.trades || [];
    
    console.log(`   Found ${trades.length} trades to migrate`);
    
    // Create database
    console.log('\n🗄️  Creating SQLite database...');
    const db = new TradeDatabase(DB_PATH);
    
    // Migrate trades
    console.log('📥 Migrating trades...');
    const startTime = Date.now();
    
    let migrated = 0;
    let errors = 0;
    
    // Use transaction for bulk insert
    try {
        db.addTrades(trades);
        migrated = trades.length;
    } catch (err) {
        console.error('Bulk insert failed, trying one by one...');
        
        for (const trade of trades) {
            try {
                db.addTrade(trade);
                migrated++;
            } catch (e) {
                errors++;
                if (errors <= 5) {
                    console.error(`   Error on trade: ${e.message}`);
                }
            }
        }
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ Migration complete!`);
    console.log(`   Migrated: ${migrated} trades`);
    console.log(`   Errors: ${errors}`);
    console.log(`   Time: ${elapsed}s`);
    console.log(`   Database: ${DB_PATH}`);
    
    // Show summary stats
    console.log('\n' + '='.repeat(60));
    console.log('DATABASE SUMMARY');
    console.log('='.repeat(60));
    
    const stats = db.getOverallStatsAll();
    console.log(`\n📊 Overall Statistics:`);
    console.log(`   Total Trades: ${stats.total_trades}`);
    console.log(`   Win Rate: ${(stats.win_rate * 100).toFixed(1)}%`);
    console.log(`   Total P&L: $${stats.total_pnl.toFixed(2)}`);
    console.log(`   Avg P&L: $${stats.avg_pnl.toFixed(2)}`);
    console.log(`   Best Trade: $${stats.best_trade.toFixed(2)}`);
    console.log(`   Worst Trade: $${stats.worst_trade.toFixed(2)}`);
    
    // Show stats by exit reason
    console.log('\n📈 By Exit Reason:');
    const exitStats = db.getStatsByExitReasonAll();
    for (const stat of exitStats) {
        console.log(`   ${stat.exit_reason}: ${stat.total_trades} trades, ${(stat.win_rate * 100).toFixed(1)}% WR, $${stat.total_pnl.toFixed(2)}`);
    }
    
    // Show profitable pairs
    console.log('\n🏆 Profitable Pairs/Directions:');
    const profitable = db.getProfitablePairsAll();
    if (profitable.length === 0) {
        console.log('   (none found with 5+ trades and positive P&L)');
    } else {
        for (const p of profitable.slice(0, 10)) {
            console.log(`   ${p.pair} ${p.direction}: ${p.total_trades} trades, ${(p.win_rate * 100).toFixed(1)}% WR, $${p.total_pnl.toFixed(2)}`);
        }
    }
    
    // Show worst performers
    console.log('\n💀 Worst Performers (5+ trades):');
    const worst = db.getWorstPairsAll();
    for (const w of worst.slice(0, 10)) {
        console.log(`   ${w.pair} ${w.direction}: ${w.total_trades} trades, ${(w.win_rate * 100).toFixed(1)}% WR, $${w.total_pnl.toFixed(2)}`);
    }
    
    db.close();
    console.log('\n✅ Done!');
}

main().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
