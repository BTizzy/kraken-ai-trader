#!/usr/bin/env node
/**
 * Regenerate Pattern Database from Enriched Trade Log
 * 
 * This script analyzes the trade log and generates both basic and enhanced pattern keys
 * to create a more granular pattern database for the learning engine.
 */

const fs = require('fs');
const path = require('path');

const TRADE_LOG_PATH = path.join(__dirname, '../bot/build/trade_log.json');
const PATTERN_DB_PATH = path.join(__dirname, '../bot/build/pattern_database.json');
const MIN_TRADES_FOR_PATTERN = 5;

console.log('🔄 Loading trade log...');
const data = JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8'));
const trades = data.trades || data;
console.log(`📊 Found ${trades.length} trades`);

// Pattern key generators
function getTimeframeBucket(seconds) {
    if (seconds < 30) return 0;
    if (seconds < 60) return 1;
    if (seconds < 120) return 2;
    return 3;
}

function getVolatilityBucket(volatility) {
    if (volatility < 2.0) return 0;  // Low
    if (volatility < 5.0) return 1;  // Medium
    if (volatility < 10.0) return 2; // High
    return 3;                         // Extreme
}

function getRegimeString(regime) {
    switch (regime) {
        case 0: return 'Q';  // Quiet
        case 1: return 'R';  // Ranging
        case 2: return 'T';  // Trending
        case 3: return 'V';  // Volatile
        default: return 'U'; // Unknown
    }
}

function generateBasicKey(trade) {
    const direction = trade.direction || 'LONG';
    const leverage = Math.floor(trade.leverage || 1);
    const tfBucket = getTimeframeBucket(trade.timeframe_seconds || 60);
    return `${trade.pair}_${direction}_${leverage}x_${tfBucket}`;
}

function generateEnhancedKey(trade) {
    const direction = trade.direction || 'LONG';
    const leverage = Math.floor(trade.leverage || 1);
    const tfBucket = getTimeframeBucket(trade.timeframe_seconds || 60);
    const volBucket = getVolatilityBucket(trade.volatility_at_entry || 0);
    const regimeStr = getRegimeString(trade.market_regime || 0);
    return `${trade.pair}_${direction}_${leverage}x_${tfBucket}_V${volBucket}_${regimeStr}`;
}

// Group trades by pattern
console.log('\n🔧 Generating patterns...');
const patterns = {};

for (const trade of trades) {
    // Skip incomplete trades (check for pair and either exit_price or exit)
    if (!trade.pair || (!trade.exit_price && !trade.exit)) continue;
    
    const basicKey = generateBasicKey(trade);
    const enhancedKey = generateEnhancedKey(trade);
    
    // Add to basic pattern
    if (!patterns[basicKey]) patterns[basicKey] = [];
    patterns[basicKey].push(trade);
    
    // Add to enhanced pattern
    if (!patterns[enhancedKey]) patterns[enhancedKey] = [];
    patterns[enhancedKey].push(trade);
}

console.log(`📊 Generated ${Object.keys(patterns).length} unique patterns`);

// Calculate metrics for each pattern
console.log('\n📈 Calculating pattern metrics...');
const patternDatabase = {};

for (const [key, patternTrades] of Object.entries(patterns)) {
    if (patternTrades.length < MIN_TRADES_FOR_PATTERN) continue;
    
    const wins = patternTrades.filter(t => t.pnl > 0);
    const losses = patternTrades.filter(t => t.pnl <= 0);
    
    const totalPnl = patternTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const grossWins = wins.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const grossLosses = Math.abs(losses.reduce((sum, t) => sum + (t.pnl || 0), 0));
    
    const winRate = patternTrades.length > 0 ? wins.length / patternTrades.length : 0;
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 0);
    const avgWin = wins.length > 0 ? grossWins / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLosses / losses.length : 0;
    
    // Calculate Sharpe-like ratio
    const returns = patternTrades.map(t => t.pnl || 0);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;
    
    // Calculate max drawdown
    let maxDrawdown = 0;
    let peak = 0;
    let cumulative = 0;
    for (const trade of patternTrades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))) {
        cumulative += trade.pnl || 0;
        peak = Math.max(peak, cumulative);
        const drawdown = peak - cumulative;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
    }
    
    // Edge calculation
    const edgePercentage = avgLoss > 0 ? ((avgWin * winRate - avgLoss * (1 - winRate)) / avgLoss) * 100 : 0;
    const hasEdge = profitFactor > 1.2 && winRate > 0.4 && patternTrades.length >= MIN_TRADES_FOR_PATTERN;
    
    // Confidence score
    const sampleSizeConfidence = Math.min(patternTrades.length / 20, 1);
    const winRateConfidence = winRate;
    const profitFactorConfidence = Math.min(profitFactor / 2, 1);
    const confidenceScore = (sampleSizeConfidence + winRateConfidence + profitFactorConfidence) / 3;
    
    // Parse key to extract components
    const keyParts = key.split('_');
    const pair = keyParts[0];
    const direction = keyParts[1];
    const leverage = parseInt(keyParts[2].replace('x', ''));
    const timeframeBucket = parseInt(keyParts[3]);
    
    patternDatabase[key] = {
        pair,
        direction,
        leverage,
        timeframe_bucket: timeframeBucket,
        total_trades: patternTrades.length,
        winning_trades: wins.length,
        losing_trades: losses.length,
        win_rate: winRate,
        profit_factor: profitFactor,
        avg_win: avgWin,
        avg_loss: avgLoss,
        total_pnl: totalPnl,
        sharpe_ratio: sharpeRatio,
        max_drawdown: maxDrawdown,
        edge_percentage: edgePercentage,
        has_edge: hasEdge,
        confidence_score: confidenceScore,
        total_fees: 0  // Would need fee data to calculate
    };
}

// Count patterns by type
const basicPatterns = Object.keys(patternDatabase).filter(k => !k.includes('_V'));
const enhancedPatterns = Object.keys(patternDatabase).filter(k => k.includes('_V'));
const edgePatterns = Object.entries(patternDatabase).filter(([k, v]) => v.has_edge);

console.log(`\n📋 Pattern Summary:`);
console.log(`   - Basic patterns (PAIR_DIR_LEV_TF): ${basicPatterns.length}`);
console.log(`   - Enhanced patterns (with volatility/regime): ${enhancedPatterns.length}`);
console.log(`   - Patterns with edge: ${edgePatterns.length}`);

// Show top 10 patterns with edge
console.log(`\n🏆 Top Patterns with Edge:`);
edgePatterns
    .sort((a, b) => b[1].profit_factor - a[1].profit_factor)
    .slice(0, 10)
    .forEach(([key, metrics], i) => {
        console.log(`   ${i + 1}. ${key}`);
        console.log(`      WR: ${(metrics.win_rate * 100).toFixed(1)}% | PF: ${metrics.profit_factor.toFixed(2)} | Trades: ${metrics.total_trades} | P&L: $${metrics.total_pnl.toFixed(2)}`);
    });

// Save pattern database
console.log('\n💾 Saving pattern database...');
const output = {
    generated_at: new Date().toISOString(),
    total_trades_analyzed: trades.length,
    total_patterns: Object.keys(patternDatabase).length,
    basic_patterns: basicPatterns.length,
    enhanced_patterns: enhancedPatterns.length,
    edge_patterns: edgePatterns.length,
    patterns: patternDatabase
};

fs.writeFileSync(PATTERN_DB_PATH, JSON.stringify(output, null, 2));
console.log(`✅ Saved ${Object.keys(patternDatabase).length} patterns to ${PATTERN_DB_PATH}`);

// Also output a summary file
const summaryPath = path.join(__dirname, '../bot/build/pattern_summary.json');
const summary = {
    generated_at: new Date().toISOString(),
    total_patterns: Object.keys(patternDatabase).length,
    patterns_with_edge: edgePatterns.map(([k, v]) => ({
        key: k,
        win_rate: v.win_rate,
        profit_factor: v.profit_factor,
        trades: v.total_trades,
        pnl: v.total_pnl
    }))
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(`📊 Saved pattern summary to ${summaryPath}`);

console.log('\n✅ Pattern regeneration complete!');
