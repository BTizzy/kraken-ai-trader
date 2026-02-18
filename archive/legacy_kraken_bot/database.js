/**
 * SQLite Database Module for Kraken AI Trader
 * 
 * Provides fast queries for pattern discovery and trade analysis
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class TradeDatabase {
    constructor(dbPath = null) {
        this.dbPath = dbPath || path.join(__dirname, '../data/trades.db');
        
        // Ensure data directory exists
        const dataDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');  // Better concurrent access
        this.db.pragma('synchronous = NORMAL'); // Balance safety/speed
        
        this.initializeTables();
        this.prepareStatements();
    }
    
    initializeTables() {
        // Main trades table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pair TEXT NOT NULL,
                direction TEXT NOT NULL,
                entry_price REAL NOT NULL,
                exit_price REAL NOT NULL,
                position_size REAL NOT NULL,
                leverage REAL DEFAULT 1.0,
                pnl REAL NOT NULL,
                gross_pnl REAL,
                fees_paid REAL,
                exit_reason TEXT,
                timestamp INTEGER NOT NULL,
                entry_time INTEGER,
                hold_time INTEGER,
                timeframe_seconds INTEGER,
                
                -- Technical indicators at entry
                volatility_pct REAL,
                bid_ask_spread REAL,
                rsi REAL DEFAULT 50.0,
                macd_histogram REAL DEFAULT 0.0,
                macd_signal REAL DEFAULT 0.0,
                bb_position REAL DEFAULT 0.5,
                volume_ratio REAL DEFAULT 1.0,
                momentum_score REAL DEFAULT 0.0,
                atr_pct REAL DEFAULT 0.0,
                market_regime INTEGER DEFAULT 0,
                trend_direction REAL DEFAULT 0.0,
                
                -- Fee correction tracking
                fee_corrected INTEGER DEFAULT 0,
                pnl_original REAL,
                fee_correction_amount REAL,
                
                -- Metadata
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );
            
            -- Indexes for common queries
            CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair);
            CREATE INDEX IF NOT EXISTS idx_trades_direction ON trades(direction);
            CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
            CREATE INDEX IF NOT EXISTS idx_trades_exit_reason ON trades(exit_reason);
            CREATE INDEX IF NOT EXISTS idx_trades_pnl ON trades(pnl);
            CREATE INDEX IF NOT EXISTS idx_trades_market_regime ON trades(market_regime);
            CREATE INDEX IF NOT EXISTS idx_trades_rsi ON trades(rsi);
            CREATE INDEX IF NOT EXISTS idx_trades_pair_direction ON trades(pair, direction);
        `);
        
        // Patterns summary table (materialized view for fast lookups)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS pattern_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern_key TEXT UNIQUE NOT NULL,
                pair TEXT NOT NULL,
                direction TEXT NOT NULL,
                volatility_bucket TEXT,
                regime_bucket TEXT,
                
                total_trades INTEGER DEFAULT 0,
                winning_trades INTEGER DEFAULT 0,
                losing_trades INTEGER DEFAULT 0,
                total_pnl REAL DEFAULT 0.0,
                total_fees REAL DEFAULT 0.0,
                avg_pnl REAL DEFAULT 0.0,
                avg_win REAL DEFAULT 0.0,
                avg_loss REAL DEFAULT 0.0,
                win_rate REAL DEFAULT 0.0,
                profit_factor REAL DEFAULT 0.0,
                sharpe_ratio REAL DEFAULT 0.0,
                
                last_updated INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );
            
            CREATE INDEX IF NOT EXISTS idx_patterns_pair ON pattern_stats(pair);
            CREATE INDEX IF NOT EXISTS idx_patterns_win_rate ON pattern_stats(win_rate);
            CREATE INDEX IF NOT EXISTS idx_patterns_profit_factor ON pattern_stats(profit_factor);
        `);
        
        // Indicator effectiveness table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS indicator_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                indicator TEXT NOT NULL,
                bucket TEXT NOT NULL,
                total_trades INTEGER DEFAULT 0,
                winning_trades INTEGER DEFAULT 0,
                total_pnl REAL DEFAULT 0.0,
                avg_pnl REAL DEFAULT 0.0,
                win_rate REAL DEFAULT 0.0,
                
                UNIQUE(indicator, bucket)
            );
        `);
    }
    
    prepareStatements() {
        // Insert trade
        this.insertTrade = this.db.prepare(`
            INSERT INTO trades (
                pair, direction, entry_price, exit_price, position_size, leverage,
                pnl, gross_pnl, fees_paid, exit_reason, timestamp, entry_time,
                hold_time, timeframe_seconds, volatility_pct, bid_ask_spread,
                rsi, macd_histogram, macd_signal, bb_position, volume_ratio,
                momentum_score, atr_pct, market_regime, trend_direction,
                fee_corrected, pnl_original, fee_correction_amount
            ) VALUES (
                @pair, @direction, @entry_price, @exit_price, @position_size, @leverage,
                @pnl, @gross_pnl, @fees_paid, @exit_reason, @timestamp, @entry_time,
                @hold_time, @timeframe_seconds, @volatility_pct, @bid_ask_spread,
                @rsi, @macd_histogram, @macd_signal, @bb_position, @volume_ratio,
                @momentum_score, @atr_pct, @market_regime, @trend_direction,
                @fee_corrected, @pnl_original, @fee_correction_amount
            )
        `);
        
        // Get stats by pair
        this.getStatsByPair = this.db.prepare(`
            SELECT 
                pair,
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losing_trades,
                SUM(pnl) as total_pnl,
                AVG(pnl) as avg_pnl,
                AVG(CASE WHEN pnl > 0 THEN pnl ELSE NULL END) as avg_win,
                AVG(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE NULL END) as avg_loss,
                CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as win_rate
            FROM trades
            GROUP BY pair
            ORDER BY total_pnl DESC
        `);
        
        // Get stats by pair and direction
        this.getStatsByPairDirection = this.db.prepare(`
            SELECT 
                pair,
                direction,
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(pnl) as total_pnl,
                AVG(pnl) as avg_pnl,
                CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as win_rate
            FROM trades
            GROUP BY pair, direction
            ORDER BY total_pnl DESC
        `);
        
        // Get stats by exit reason
        this.getStatsByExitReason = this.db.prepare(`
            SELECT 
                exit_reason,
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(pnl) as total_pnl,
                AVG(pnl) as avg_pnl,
                CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as win_rate
            FROM trades
            GROUP BY exit_reason
            ORDER BY total_pnl DESC
        `);
        
        // Get stats by market regime
        this.getStatsByRegime = this.db.prepare(`
            SELECT 
                market_regime,
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(pnl) as total_pnl,
                AVG(pnl) as avg_pnl,
                CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as win_rate
            FROM trades
            GROUP BY market_regime
            ORDER BY total_pnl DESC
        `);
        
        // Get RSI bucket stats
        this.getStatsByRSI = this.db.prepare(`
            SELECT 
                CASE 
                    WHEN rsi < 30 THEN 'oversold'
                    WHEN rsi > 70 THEN 'overbought'
                    ELSE 'neutral'
                END as rsi_bucket,
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(pnl) as total_pnl,
                AVG(pnl) as avg_pnl,
                CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as win_rate
            FROM trades
            GROUP BY rsi_bucket
            ORDER BY win_rate DESC
        `);
        
        // Get profitable pairs (positive P&L)
        this.getProfitablePairs = this.db.prepare(`
            SELECT 
                pair,
                direction,
                COUNT(*) as total_trades,
                SUM(pnl) as total_pnl,
                AVG(pnl) as avg_pnl,
                CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as win_rate
            FROM trades
            GROUP BY pair, direction
            HAVING total_pnl > 0 AND COUNT(*) >= 5
            ORDER BY total_pnl DESC
        `);
        
        // Get worst performers
        this.getWorstPairs = this.db.prepare(`
            SELECT 
                pair,
                direction,
                COUNT(*) as total_trades,
                SUM(pnl) as total_pnl,
                AVG(pnl) as avg_pnl,
                CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as win_rate
            FROM trades
            GROUP BY pair, direction
            HAVING COUNT(*) >= 5
            ORDER BY total_pnl ASC
            LIMIT 20
        `);
        
        // Get overall stats
        this.getOverallStats = this.db.prepare(`
            SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losing_trades,
                SUM(pnl) as total_pnl,
                SUM(fees_paid) as total_fees,
                AVG(pnl) as avg_pnl,
                AVG(CASE WHEN pnl > 0 THEN pnl ELSE NULL END) as avg_win,
                AVG(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE NULL END) as avg_loss,
                MAX(pnl) as best_trade,
                MIN(pnl) as worst_trade,
                CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as win_rate
            FROM trades
        `);
        
        // Get recent trades
        this.getRecentTrades = this.db.prepare(`
            SELECT * FROM trades 
            ORDER BY timestamp DESC 
            LIMIT ?
        `);
        
        // Count trades
        this.countTrades = this.db.prepare(`SELECT COUNT(*) as count FROM trades`);
    }
    
    // Insert a single trade
    addTrade(trade) {
        return this.insertTrade.run({
            pair: trade.pair,
            direction: trade.direction || 'LONG',
            entry_price: trade.entry_price || trade.entry || 0,
            exit_price: trade.exit_price || trade.exit || 0,
            position_size: trade.position_size || 100,
            leverage: trade.leverage || trade.original_leverage || 1.0,
            pnl: trade.pnl || 0,
            gross_pnl: trade.gross_pnl || null,
            fees_paid: trade.fees_paid || null,
            exit_reason: trade.exit_reason || trade.reason || 'unknown',
            timestamp: trade.timestamp || Date.now(),
            entry_time: trade.entry_time || null,
            hold_time: trade.hold_time || null,
            timeframe_seconds: trade.timeframe_seconds || null,
            volatility_pct: trade.volatility_at_entry || trade.volatility_pct || null,
            bid_ask_spread: trade.bid_ask_spread || null,
            rsi: trade.rsi || 50.0,
            macd_histogram: trade.macd_histogram || 0.0,
            macd_signal: trade.macd_signal || 0.0,
            bb_position: trade.bb_position || 0.5,
            volume_ratio: trade.volume_ratio || 1.0,
            momentum_score: trade.momentum_score || 0.0,
            atr_pct: trade.atr_pct || 0.0,
            market_regime: trade.market_regime || 0,
            trend_direction: trade.trend_direction || 0.0,
            fee_corrected: trade.fee_corrected ? 1 : 0,
            pnl_original: trade.pnl_original || null,
            fee_correction_amount: trade.fee_correction_amount || null
        });
    }
    
    // Bulk insert trades (for migration)
    addTrades(trades) {
        const insert = this.db.transaction((trades) => {
            for (const trade of trades) {
                this.addTrade(trade);
            }
        });
        return insert(trades);
    }
    
    // Analysis methods
    getStatsByPairAll() { return this.getStatsByPair.all(); }
    getStatsByPairDirectionAll() { return this.getStatsByPairDirection.all(); }
    getStatsByExitReasonAll() { return this.getStatsByExitReason.all(); }
    getStatsByRegimeAll() { return this.getStatsByRegime.all(); }
    getStatsByRSIAll() { return this.getStatsByRSI.all(); }
    getProfitablePairsAll() { return this.getProfitablePairs.all(); }
    getWorstPairsAll() { return this.getWorstPairs.all(); }
    getOverallStatsAll() { return this.getOverallStats.get(); }
    getRecentTradesAll(limit = 50) { return this.getRecentTrades.all(limit); }
    getTradeCount() { return this.countTrades.get().count; }
    
    // Custom query for advanced analysis
    query(sql, params = []) {
        return this.db.prepare(sql).all(...params);
    }
    
    // Get winning combinations
    getWinningCombinations(minTrades = 5, minWinRate = 0.3) {
        return this.db.prepare(`
            SELECT 
                pair,
                direction,
                CASE 
                    WHEN market_regime = 1 THEN 'uptrend'
                    WHEN market_regime = -1 THEN 'downtrend'
                    WHEN market_regime = 2 THEN 'volatile'
                    WHEN market_regime = -2 THEN 'quiet'
                    ELSE 'ranging'
                END as regime,
                CASE 
                    WHEN rsi < 30 THEN 'oversold'
                    WHEN rsi > 70 THEN 'overbought'
                    ELSE 'neutral'
                END as rsi_zone,
                COUNT(*) as trades,
                SUM(pnl) as total_pnl,
                AVG(pnl) as avg_pnl,
                CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as win_rate
            FROM trades
            GROUP BY pair, direction, regime, rsi_zone
            HAVING COUNT(*) >= ? AND win_rate >= ?
            ORDER BY total_pnl DESC
        `).all(minTrades, minWinRate);
    }
    
    // Close database connection
    close() {
        this.db.close();
    }
}

module.exports = TradeDatabase;
