#!/usr/bin/env node

/**
 * Analyze trade data in SQLite database
 * 
 * Usage: node scripts/analyze_trades.js [options]
 * 
 * Options:
 *   --pairs         Show stats by pair
 *   --directions    Show stats by pair + direction
 *   --exits         Show stats by exit reason
 *   --regimes       Show stats by market regime
 *   --rsi           Show stats by RSI zone
 *   --winners       Show profitable combinations
 *   --losers        Show worst performers
 *   --all           Show all analysis
 */

const path = require('path');
const TradeDatabase = require('../lib/database');

const DB_PATH = path.join(__dirname, '../data/trades.db');

function formatPercent(value) {
    return (value * 100).toFixed(1) + '%';
}

function formatMoney(value) {
    return (value >= 0 ? '$' : '-$') + Math.abs(value).toFixed(2);
}

function printTable(rows, columns) {
    // Calculate column widths
    const widths = columns.map(col => Math.max(col.header.length, ...rows.map(r => String(col.format ? col.format(r[col.key]) : r[col.key]).length)));
    
    // Print header
    const headerRow = columns.map((col, i) => col.header.padEnd(widths[i])).join(' | ');
    console.log(headerRow);
    console.log('-'.repeat(headerRow.length));
    
    // Print rows
    for (const row of rows) {
        const rowStr = columns.map((col, i) => {
            const value = col.format ? col.format(row[col.key]) : String(row[col.key]);
            return value.padEnd(widths[i]);
        }).join(' | ');
        console.log(rowStr);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const showAll = args.includes('--all') || args.length === 0;
    
    console.log('='.repeat(60));
    console.log('TRADE ANALYSIS');
    console.log('='.repeat(60));
    
    const db = new TradeDatabase(DB_PATH);
    
    // Overall stats
    const overall = db.getOverallStatsAll();
    console.log('\n📊 OVERALL STATISTICS');
    console.log('-'.repeat(40));
    console.log(`Total Trades: ${overall.total_trades}`);
    console.log(`Win/Loss: ${overall.winning_trades}/${overall.losing_trades}`);
    console.log(`Win Rate: ${formatPercent(overall.win_rate)}`);
    console.log(`Total P&L: ${formatMoney(overall.total_pnl)}`);
    console.log(`Total Fees: ${formatMoney(overall.total_fees || 0)}`);
    console.log(`Avg P&L: ${formatMoney(overall.avg_pnl)}`);
    console.log(`Avg Win: ${formatMoney(overall.avg_win || 0)}`);
    console.log(`Avg Loss: ${formatMoney(overall.avg_loss || 0)}`);
    console.log(`Best Trade: ${formatMoney(overall.best_trade)}`);
    console.log(`Worst Trade: ${formatMoney(overall.worst_trade)}`);
    
    // Profit Factor
    const grossWins = (overall.avg_win || 0) * overall.winning_trades;
    const grossLosses = (overall.avg_loss || 0) * overall.losing_trades;
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : 0;
    console.log(`Profit Factor: ${profitFactor.toFixed(2)}`);
    
    // By Exit Reason
    if (showAll || args.includes('--exits')) {
        console.log('\n📈 BY EXIT REASON');
        console.log('-'.repeat(40));
        const exitStats = db.getStatsByExitReasonAll();
        printTable(exitStats, [
            { key: 'exit_reason', header: 'Exit Reason' },
            { key: 'total_trades', header: 'Trades' },
            { key: 'win_rate', header: 'Win Rate', format: formatPercent },
            { key: 'total_pnl', header: 'Total P&L', format: formatMoney },
            { key: 'avg_pnl', header: 'Avg P&L', format: formatMoney }
        ]);
    }
    
    // By Market Regime
    if (showAll || args.includes('--regimes')) {
        console.log('\n🌡️ BY MARKET REGIME');
        console.log('-'.repeat(40));
        const regimeStats = db.getStatsByRegimeAll();
        const regimeNames = {
            '0': 'Ranging',
            '1': 'Uptrend',
            '-1': 'Downtrend',
            '2': 'Volatile',
            '-2': 'Quiet'
        };
        const regimeStatsNamed = regimeStats.map(r => ({
            ...r,
            regime_name: regimeNames[String(r.market_regime)] || 'Unknown'
        }));
        printTable(regimeStatsNamed, [
            { key: 'regime_name', header: 'Regime' },
            { key: 'total_trades', header: 'Trades' },
            { key: 'win_rate', header: 'Win Rate', format: formatPercent },
            { key: 'total_pnl', header: 'Total P&L', format: formatMoney },
            { key: 'avg_pnl', header: 'Avg P&L', format: formatMoney }
        ]);
    }
    
    // By RSI Zone
    if (showAll || args.includes('--rsi')) {
        console.log('\n📉 BY RSI ZONE');
        console.log('-'.repeat(40));
        const rsiStats = db.getStatsByRSIAll();
        printTable(rsiStats, [
            { key: 'rsi_bucket', header: 'RSI Zone' },
            { key: 'total_trades', header: 'Trades' },
            { key: 'win_rate', header: 'Win Rate', format: formatPercent },
            { key: 'total_pnl', header: 'Total P&L', format: formatMoney },
            { key: 'avg_pnl', header: 'Avg P&L', format: formatMoney }
        ]);
    }
    
    // Profitable Pairs
    if (showAll || args.includes('--winners')) {
        console.log('\n🏆 PROFITABLE PATTERNS (5+ trades, positive P&L)');
        console.log('-'.repeat(40));
        const profitable = db.getProfitablePairsAll();
        if (profitable.length === 0) {
            console.log('(none found)');
        } else {
            printTable(profitable.slice(0, 15), [
                { key: 'pair', header: 'Pair' },
                { key: 'direction', header: 'Dir' },
                { key: 'total_trades', header: 'Trades' },
                { key: 'win_rate', header: 'Win Rate', format: formatPercent },
                { key: 'total_pnl', header: 'Total P&L', format: formatMoney },
                { key: 'avg_pnl', header: 'Avg P&L', format: formatMoney }
            ]);
        }
    }
    
    // Worst Performers
    if (showAll || args.includes('--losers')) {
        console.log('\n💀 WORST PERFORMERS (5+ trades)');
        console.log('-'.repeat(40));
        const worst = db.getWorstPairsAll();
        printTable(worst.slice(0, 15), [
            { key: 'pair', header: 'Pair' },
            { key: 'direction', header: 'Dir' },
            { key: 'total_trades', header: 'Trades' },
            { key: 'win_rate', header: 'Win Rate', format: formatPercent },
            { key: 'total_pnl', header: 'Total P&L', format: formatMoney },
            { key: 'avg_pnl', header: 'Avg P&L', format: formatMoney }
        ]);
    }
    
    // Winning combinations (requires indicator data)
    if (showAll || args.includes('--winners')) {
        console.log('\n🎯 WINNING COMBINATIONS (5+ trades, 30%+ WR)');
        console.log('-'.repeat(40));
        const combinations = db.getWinningCombinations(5, 0.3);
        if (combinations.length === 0) {
            console.log('(none found - need more trades with indicator data)');
        } else {
            printTable(combinations.slice(0, 15), [
                { key: 'pair', header: 'Pair' },
                { key: 'direction', header: 'Dir' },
                { key: 'regime', header: 'Regime' },
                { key: 'rsi_zone', header: 'RSI' },
                { key: 'trades', header: 'Trades' },
                { key: 'win_rate', header: 'WR', format: formatPercent },
                { key: 'total_pnl', header: 'P&L', format: formatMoney }
            ]);
        }
    }
    
    // By Pair (top 20)
    if (args.includes('--pairs')) {
        console.log('\n📋 BY PAIR (Top 20)');
        console.log('-'.repeat(40));
        const pairStats = db.getStatsByPairAll();
        printTable(pairStats.slice(0, 20), [
            { key: 'pair', header: 'Pair' },
            { key: 'total_trades', header: 'Trades' },
            { key: 'winning_trades', header: 'Wins' },
            { key: 'win_rate', header: 'Win Rate', format: formatPercent },
            { key: 'total_pnl', header: 'Total P&L', format: formatMoney },
            { key: 'avg_pnl', header: 'Avg P&L', format: formatMoney }
        ]);
    }
    
    // By Pair + Direction (top 20)
    if (args.includes('--directions')) {
        console.log('\n📋 BY PAIR + DIRECTION (Top 20)');
        console.log('-'.repeat(40));
        const dirStats = db.getStatsByPairDirectionAll();
        printTable(dirStats.slice(0, 20), [
            { key: 'pair', header: 'Pair' },
            { key: 'direction', header: 'Dir' },
            { key: 'total_trades', header: 'Trades' },
            { key: 'win_rate', header: 'Win Rate', format: formatPercent },
            { key: 'total_pnl', header: 'Total P&L', format: formatMoney },
            { key: 'avg_pnl', header: 'Avg P&L', format: formatMoney }
        ]);
    }
    
    // Key insights
    console.log('\n💡 KEY INSIGHTS');
    console.log('-'.repeat(40));
    
    // Take profit vs timeout analysis
    const tpTrades = db.query(`SELECT COUNT(*) as count, SUM(pnl) as pnl, AVG(pnl) as avg FROM trades WHERE exit_reason = 'take_profit'`)[0];
    const toTrades = db.query(`SELECT COUNT(*) as count, SUM(pnl) as pnl, AVG(pnl) as avg FROM trades WHERE exit_reason = 'timeout'`)[0];
    
    console.log(`• Take Profit exits: ${tpTrades.count} trades (${formatPercent(tpTrades.count / overall.total_trades)}) = ${formatMoney(tpTrades.pnl)}`);
    console.log(`• Timeout exits: ${toTrades.count} trades (${formatPercent(toTrades.count / overall.total_trades)}) = ${formatMoney(toTrades.pnl)}`);
    console.log(`• Timeout is losing ${formatMoney(Math.abs(toTrades.pnl))} (${formatMoney(toTrades.avg)} avg per trade)`);
    
    // Direction analysis
    const longTrades = db.query(`SELECT COUNT(*) as count, SUM(pnl) as pnl FROM trades WHERE direction = 'LONG'`)[0];
    const shortTrades = db.query(`SELECT COUNT(*) as count, SUM(pnl) as pnl FROM trades WHERE direction = 'SHORT'`)[0];
    
    console.log(`• LONG trades: ${longTrades.count} = ${formatMoney(longTrades.pnl)}`);
    console.log(`• SHORT trades: ${shortTrades.count} = ${formatMoney(shortTrades.pnl)}`);
    
    // Pairs to avoid
    const toAvoid = db.query(`
        SELECT pair, COUNT(*) as trades, SUM(pnl) as pnl 
        FROM trades 
        GROUP BY pair 
        HAVING COUNT(*) >= 10 AND SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) < 0.1
        ORDER BY pnl ASC
        LIMIT 5
    `);
    
    if (toAvoid.length > 0) {
        console.log(`• Pairs to AVOID (10+ trades, <10% WR): ${toAvoid.map(p => p.pair).join(', ')}`);
    }
    
    db.close();
    console.log('\n✅ Analysis complete!');
}

main().catch(err => {
    console.error('Analysis failed:', err);
    process.exit(1);
});
