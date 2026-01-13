#!/usr/bin/env node
/**
 * Enrich Trade Log with Missing Fields
 * 
 * This script enriches legacy trades with missing fields:
 * - volatility_at_entry: Estimated from price movement
 * - market_regime: Inferred from trade patterns
 * - technical indicators: Estimated where possible
 * 
 * Does NOT delete any data - only adds missing fields.
 */

const fs = require('fs');
const path = require('path');

const TRADE_LOG_PATH = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
const BACKUP_PATH = path.join(__dirname, '..', 'bot', 'build', 'trade_log_pre_enrichment.json');

function loadTradeLog() {
    if (!fs.existsSync(TRADE_LOG_PATH)) {
        console.error('❌ Trade log not found:', TRADE_LOG_PATH);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8'));
}

function saveTradeLog(data) {
    fs.writeFileSync(TRADE_LOG_PATH, JSON.stringify(data, null, 2));
}

function backupTradeLog(data) {
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(data, null, 2));
    console.log('✅ Backup created:', BACKUP_PATH);
}

/**
 * Estimate volatility from entry/exit prices
 */
function estimateVolatility(trade) {
    if (!trade.entry_price || !trade.exit_price || trade.entry_price === 0) {
        return 2.0; // Default medium volatility
    }
    
    // Calculate price change percentage
    const priceChange = Math.abs(trade.exit_price - trade.entry_price) / trade.entry_price * 100;
    
    // Estimate daily volatility (trade is usually < 1 hour, so scale up)
    // Assuming trade duration ~10-30 minutes, scale by ~6-12x for daily
    const scaleFactor = 8;
    const estimatedVolatility = priceChange * scaleFactor;
    
    // Clamp to reasonable range
    return Math.max(0.5, Math.min(25.0, estimatedVolatility));
}

/**
 * Infer market regime from trade characteristics
 */
function inferMarketRegime(trade, neighborTrades) {
    // 0=quiet, 1=ranging, 2=trending, 3=volatile
    
    const volatility = trade.volatility_at_entry || estimateVolatility(trade);
    const exitReason = trade.exit_reason || trade.reason || '';
    
    // High volatility suggests volatile regime
    if (volatility > 10.0) return 3; // volatile
    
    // Check exit reason for clues
    if (exitReason === 'take_profit' || exitReason === 'trailing_stop') {
        // Successful exits often happen in trending markets
        return 2; // trending
    }
    
    if (exitReason === 'timeout') {
        // Timeouts often happen in quiet/ranging markets
        if (volatility < 2.0) return 0; // quiet
        return 1; // ranging
    }
    
    if (exitReason === 'stop_loss') {
        // Stop losses can happen in volatile or ranging markets
        if (volatility > 5.0) return 3; // volatile
        return 1; // ranging
    }
    
    // Default to ranging
    return 1;
}

/**
 * Estimate timeframe from hold time or default
 */
function estimateTimeframe(trade) {
    if (trade.hold_time && trade.hold_time > 0) {
        return trade.hold_time;
    }
    if (trade.timeframe_seconds && trade.timeframe_seconds > 0) {
        return trade.timeframe_seconds;
    }
    // Default to 60 seconds
    return 60;
}

/**
 * Estimate position size from P&L and price movement
 */
function estimatePositionSize(trade) {
    if (trade.position_size && trade.position_size > 0) {
        return trade.position_size;
    }
    
    if (!trade.entry_price || !trade.exit_price || trade.entry_price === 0) {
        return 100.0; // Default $100
    }
    
    // Estimate from P&L and price change
    const priceChangePct = Math.abs(trade.exit_price - trade.entry_price) / trade.entry_price;
    if (priceChangePct > 0 && trade.pnl !== undefined) {
        const estimated = Math.abs(trade.pnl / priceChangePct);
        if (estimated > 10 && estimated < 1000) {
            return estimated;
        }
    }
    
    return 100.0; // Default $100
}

/**
 * Enrich a single trade with missing fields
 */
function enrichTrade(trade, index, allTrades) {
    const enriched = { ...trade };
    
    // Ensure basic fields exist
    if (!enriched.direction) {
        enriched.direction = 'LONG'; // Default for legacy trades
    }
    
    if (!enriched.entry_price && enriched.entry) {
        enriched.entry_price = enriched.entry;
    }
    
    if (!enriched.exit_price && enriched.exit) {
        enriched.exit_price = enriched.exit;
    }
    
    if (!enriched.exit_reason && enriched.reason) {
        enriched.exit_reason = enriched.reason;
    }
    
    // Estimate timeframe
    if (!enriched.timeframe_seconds || enriched.timeframe_seconds <= 0) {
        enriched.timeframe_seconds = estimateTimeframe(trade);
    }
    
    // Estimate position size
    if (!enriched.position_size || enriched.position_size <= 0) {
        enriched.position_size = estimatePositionSize(trade);
    }
    
    // Estimate volatility at entry
    if (!enriched.volatility_at_entry || enriched.volatility_at_entry <= 0) {
        enriched.volatility_at_entry = estimateVolatility(trade);
    }
    
    // Get neighbor trades for context
    const startIdx = Math.max(0, index - 5);
    const endIdx = Math.min(allTrades.length, index + 5);
    const neighborTrades = allTrades.slice(startIdx, endIdx);
    
    // Infer market regime
    if (enriched.market_regime === undefined || enriched.market_regime === null) {
        enriched.market_regime = inferMarketRegime(enriched, neighborTrades);
    }
    
    // Set default technical indicators if missing (neutral values)
    if (!enriched.rsi) enriched.rsi = 50.0;
    if (!enriched.momentum_score) enriched.momentum_score = 0.0;
    if (!enriched.bb_position) enriched.bb_position = 0.5;
    if (!enriched.volume_ratio) enriched.volume_ratio = 1.0;
    
    // Calculate gross_pnl if missing (assume ~0.4% fees)
    if (!enriched.gross_pnl && enriched.pnl !== undefined) {
        const estimatedFees = enriched.position_size * 0.004;
        enriched.gross_pnl = enriched.pnl + estimatedFees;
        enriched.fees_paid = estimatedFees;
    }
    
    return enriched;
}

/**
 * Main enrichment process
 */
function main() {
    console.log('🔄 Loading trade log...');
    const data = loadTradeLog();
    
    if (!data.trades || !Array.isArray(data.trades)) {
        console.error('❌ Invalid trade log format');
        process.exit(1);
    }
    
    console.log(`📊 Found ${data.trades.length} trades`);
    
    // Create backup before modifying
    console.log('💾 Creating backup...');
    backupTradeLog(data);
    
    // Count fields before enrichment
    let missingVolatility = 0;
    let missingRegime = 0;
    let missingTimeframe = 0;
    let missingPositionSize = 0;
    
    data.trades.forEach(trade => {
        if (!trade.volatility_at_entry || trade.volatility_at_entry <= 0) missingVolatility++;
        if (trade.market_regime === undefined || trade.market_regime === null) missingRegime++;
        if (!trade.timeframe_seconds || trade.timeframe_seconds <= 0) missingTimeframe++;
        if (!trade.position_size || trade.position_size <= 0) missingPositionSize++;
    });
    
    console.log(`\n📋 Fields to enrich:`);
    console.log(`   - Missing volatility: ${missingVolatility}`);
    console.log(`   - Missing regime: ${missingRegime}`);
    console.log(`   - Missing timeframe: ${missingTimeframe}`);
    console.log(`   - Missing position_size: ${missingPositionSize}`);
    
    // Enrich trades
    console.log('\n🔧 Enriching trades...');
    const enrichedTrades = data.trades.map((trade, index) => 
        enrichTrade(trade, index, data.trades)
    );
    
    // Update data
    data.trades = enrichedTrades;
    data.enriched_at = Date.now();
    data.enrichment_notes = 'Added volatility_at_entry, market_regime, timeframe_seconds, position_size estimates';
    
    // Save enriched data
    console.log('💾 Saving enriched trade log...');
    saveTradeLog(data);
    
    // Verify enrichment
    let enrichedVolatility = 0;
    let enrichedRegime = 0;
    let enrichedTimeframe = 0;
    let enrichedPositionSize = 0;
    
    enrichedTrades.forEach(trade => {
        if (trade.volatility_at_entry && trade.volatility_at_entry > 0) enrichedVolatility++;
        if (trade.market_regime !== undefined && trade.market_regime !== null) enrichedRegime++;
        if (trade.timeframe_seconds && trade.timeframe_seconds > 0) enrichedTimeframe++;
        if (trade.position_size && trade.position_size > 0) enrichedPositionSize++;
    });
    
    console.log(`\n✅ Enrichment complete!`);
    console.log(`   - With volatility: ${enrichedVolatility} / ${enrichedTrades.length}`);
    console.log(`   - With regime: ${enrichedRegime} / ${enrichedTrades.length}`);
    console.log(`   - With timeframe: ${enrichedTimeframe} / ${enrichedTrades.length}`);
    console.log(`   - With position_size: ${enrichedPositionSize} / ${enrichedTrades.length}`);
    
    // Count unique patterns that can now be generated
    const patterns = new Set();
    enrichedTrades.forEach(trade => {
        const direction = trade.direction || 'LONG';
        const leverage = Math.round(trade.leverage || 1);
        
        let timeframeBucket = 1;
        if (trade.timeframe_seconds < 30) timeframeBucket = 0;
        else if (trade.timeframe_seconds < 60) timeframeBucket = 1;
        else if (trade.timeframe_seconds < 120) timeframeBucket = 2;
        else timeframeBucket = 3;
        
        let volBucket = 1;
        if (trade.volatility_at_entry < 2.0) volBucket = 0;
        else if (trade.volatility_at_entry < 5.0) volBucket = 1;
        else if (trade.volatility_at_entry < 10.0) volBucket = 2;
        else volBucket = 3;
        
        const regimeMap = {0: 'Q', 1: 'R', 2: 'T', 3: 'V'};
        const regime = regimeMap[trade.market_regime] || 'U';
        
        // Basic pattern
        const basicKey = `${trade.pair}_${direction}_${leverage}x_${timeframeBucket}`;
        patterns.add(basicKey);
        
        // Enhanced pattern
        const enhancedKey = `${trade.pair}_${direction}_${leverage}x_${timeframeBucket}_V${volBucket}_${regime}`;
        patterns.add(enhancedKey);
    });
    
    console.log(`\n🧠 Pattern potential: ${patterns.size} unique patterns from ${enrichedTrades.length} trades`);
    console.log('   (Before enrichment, patterns were limited by missing volatility/regime data)');
}

main();
