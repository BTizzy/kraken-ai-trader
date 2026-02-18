/**
 * Prediction Market Database Module
 * SQLite schema and data access for prediction market trading
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class PredictionDatabase {
    constructor(dbPath = null) {
        this.dbPath = dbPath || path.join(__dirname, '../data/prediction_markets.db');

        const dataDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');  // Enforce FK constraints

        this.initializeTables();
        this.migrateSchema();
        this.prepareStatements();
    }

    migrateSchema() {
        // Safe column additions (idempotent)
        const migrations = [
            'ALTER TABLE matched_markets ADD COLUMN polymarket_yes_token_id TEXT',
            'ALTER TABLE matched_markets ADD COLUMN polymarket_no_token_id TEXT'
        ];
        for (const sql of migrations) {
            try { this.db.exec(sql); } catch (e) { /* column already exists */ }
        }
    }

    initializeTables() {
        this.db.exec(`
            -- Market metadata
            CREATE TABLE IF NOT EXISTS markets (
                gemini_market_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                category TEXT DEFAULT 'other',
                resolution_date TEXT,
                polymarket_market_id TEXT,
                kalshi_market_id TEXT,
                outcomes TEXT DEFAULT '["YES","NO"]',
                first_seen INTEGER DEFAULT (strftime('%s','now')),
                last_updated INTEGER DEFAULT (strftime('%s','now')),
                is_active INTEGER DEFAULT 1
            );

            CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);
            CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(is_active);
            CREATE INDEX IF NOT EXISTS idx_markets_resolution ON markets(resolution_date);

            -- Cross-platform matched markets
            CREATE TABLE IF NOT EXISTS matched_markets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                gemini_market_id TEXT UNIQUE,
                polymarket_market_id TEXT,
                kalshi_market_id TEXT,
                event_title TEXT NOT NULL,
                resolution_date TEXT,
                category TEXT DEFAULT 'other',
                match_confidence REAL DEFAULT 0.0,
                manual_override INTEGER DEFAULT 0,
                is_active INTEGER DEFAULT 1,
                created_at INTEGER DEFAULT (strftime('%s','now')),
                FOREIGN KEY (gemini_market_id) REFERENCES markets(gemini_market_id)
            );

            CREATE INDEX IF NOT EXISTS idx_matched_confidence ON matched_markets(match_confidence);
            CREATE INDEX IF NOT EXISTS idx_matched_active ON matched_markets(is_active);

            -- Real-time price snapshots
            CREATE TABLE IF NOT EXISTS market_prices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                gemini_market_id TEXT NOT NULL,
                polymarket_price_bid REAL,
                polymarket_price_ask REAL,
                polymarket_last REAL,
                polymarket_volume REAL,
                kalshi_price_bid REAL,
                kalshi_price_ask REAL,
                kalshi_last REAL,
                kalshi_volume REAL,
                gemini_price_bid REAL,
                gemini_price_ask REAL,
                gemini_last REAL,
                gemini_volume REAL
            );

            CREATE INDEX IF NOT EXISTS idx_prices_market ON market_prices(gemini_market_id);
            CREATE INDEX IF NOT EXISTS idx_prices_ts ON market_prices(timestamp);
            CREATE INDEX IF NOT EXISTS idx_prices_market_ts ON market_prices(gemini_market_id, timestamp);

            -- Prediction market trades (paper & live)
            CREATE TABLE IF NOT EXISTS prediction_trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                gemini_market_id TEXT NOT NULL,
                market_title TEXT,
                category TEXT,
                direction TEXT NOT NULL,
                entry_price REAL NOT NULL,
                exit_price REAL,
                position_size REAL NOT NULL,
                pnl REAL DEFAULT 0.0,
                hold_time INTEGER DEFAULT 0,
                opportunity_score REAL DEFAULT 0.0,
                polymarket_signal_price REAL,
                kalshi_signal_price REAL,
                gemini_entry_bid REAL,
                gemini_entry_ask REAL,
                gemini_volume REAL,
                exit_reason TEXT,
                is_open INTEGER DEFAULT 1,
                take_profit_price REAL,
                stop_loss_price REAL,
                slippage REAL DEFAULT 0.0,
                mode TEXT DEFAULT 'paper',
                created_at INTEGER DEFAULT (strftime('%s','now'))
            );

            CREATE INDEX IF NOT EXISTS idx_ptrades_market ON prediction_trades(gemini_market_id);
            CREATE INDEX IF NOT EXISTS idx_ptrades_ts ON prediction_trades(timestamp);
            CREATE INDEX IF NOT EXISTS idx_ptrades_open ON prediction_trades(is_open);
            CREATE INDEX IF NOT EXISTS idx_ptrades_mode ON prediction_trades(mode);

            -- Signal log for ML training data
            CREATE TABLE IF NOT EXISTS signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                gemini_market_id TEXT NOT NULL,
                signal_type TEXT NOT NULL,
                opportunity_score REAL NOT NULL,
                price_velocity REAL DEFAULT 0.0,
                spread_differential REAL DEFAULT 0.0,
                cross_platform_consensus REAL DEFAULT 0.0,
                gemini_staleness INTEGER DEFAULT 0,
                category_win_rate REAL DEFAULT 0.0,
                polymarket_price REAL,
                kalshi_price REAL,
                gemini_price REAL,
                triggered_trade INTEGER DEFAULT 0,
                outcome_price_60s REAL,
                outcome_direction_correct INTEGER,
                created_at INTEGER DEFAULT (strftime('%s','now'))
            );

            CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(timestamp);
            CREATE INDEX IF NOT EXISTS idx_signals_market ON signals(gemini_market_id);
            CREATE INDEX IF NOT EXISTS idx_signals_score ON signals(opportunity_score);

            -- Paper wallet state
            CREATE TABLE IF NOT EXISTS paper_wallet (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                balance REAL NOT NULL DEFAULT 500.0,
                initial_balance REAL NOT NULL DEFAULT 500.0,
                peak_balance REAL NOT NULL DEFAULT 500.0,
                total_trades INTEGER DEFAULT 0,
                winning_trades INTEGER DEFAULT 0,
                losing_trades INTEGER DEFAULT 0,
                total_pnl REAL DEFAULT 0.0,
                max_drawdown_pct REAL DEFAULT 0.0,
                last_updated INTEGER DEFAULT (strftime('%s','now'))
            );

            -- Initialize paper wallet if not exists
            INSERT OR IGNORE INTO paper_wallet (id, balance, initial_balance, peak_balance) 
            VALUES (1, 500.0, 500.0, 500.0);

            -- Bot parameters (adaptive)
            CREATE TABLE IF NOT EXISTS bot_parameters (
                key TEXT PRIMARY KEY,
                value REAL NOT NULL,
                min_value REAL,
                max_value REAL,
                description TEXT,
                last_updated INTEGER DEFAULT (strftime('%s','now'))
            );

            -- Initialize default parameters
            INSERT OR IGNORE INTO bot_parameters (key, value, min_value, max_value, description) VALUES
                ('entry_threshold', 45.0, 30.0, 90.0, 'Min opportunity score to enter trade'),
                ('price_velocity_threshold', 0.03, 0.01, 0.10, 'Min price change on Poly/Kalshi to trigger'),
                ('take_profit_buffer', 0.01, 0.005, 0.03, 'Buffer from target price for TP'),
                ('stop_loss_width', 0.03, 0.01, 0.08, 'Max loss per trade in price units'),
                ('max_hold_time', 600, 60, 3600, 'Max seconds before forced exit'),
                ('kelly_multiplier', 0.25, 0.05, 0.50, 'Fraction of Kelly criterion to use'),
                ('max_concurrent_positions', 5, 1, 10, 'Max open positions at once'),
                ('max_position_size', 100.0, 10.0, 500.0, 'Max USD per trade'),
                ('max_capital_at_risk_pct', 50.0, 20.0, 80.0, 'Max % of bankroll at risk'),
                ('slippage_penalty', 0.005, 0.0, 0.02, 'Simulated slippage per trade'),
                ('min_gemini_volume', 30000, 1000, 100000, 'Max Gemini volume filter'),
                ('daily_loss_limit', -50.0, -200.0, -10.0, 'Stop trading if daily PnL below this');

            -- Daily performance log
            CREATE TABLE IF NOT EXISTS daily_performance (
                date TEXT PRIMARY KEY,
                total_pnl REAL DEFAULT 0.0,
                trade_count INTEGER DEFAULT 0,
                win_count INTEGER DEFAULT 0,
                loss_count INTEGER DEFAULT 0,
                avg_hold_time REAL DEFAULT 0.0,
                avg_score REAL DEFAULT 0.0,
                best_trade REAL DEFAULT 0.0,
                worst_trade REAL DEFAULT 0.0,
                max_drawdown REAL DEFAULT 0.0,
                end_balance REAL DEFAULT 0.0
            );
        `);
    }

    prepareStatements() {
        // Market operations
        this.stmts = {
            upsertMarket: this.db.prepare(`
                INSERT INTO markets (gemini_market_id, title, category, resolution_date, polymarket_market_id, kalshi_market_id, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
                ON CONFLICT(gemini_market_id) DO UPDATE SET
                    title = excluded.title,
                    category = excluded.category,
                    resolution_date = excluded.resolution_date,
                    polymarket_market_id = excluded.polymarket_market_id,
                    kalshi_market_id = excluded.kalshi_market_id,
                    last_updated = strftime('%s','now')
            `),

            insertPrice: this.db.prepare(`
                INSERT INTO market_prices (
                    timestamp, gemini_market_id,
                    polymarket_price_bid, polymarket_price_ask, polymarket_last, polymarket_volume,
                    kalshi_price_bid, kalshi_price_ask, kalshi_last, kalshi_volume,
                    gemini_price_bid, gemini_price_ask, gemini_last, gemini_volume
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),

            insertTrade: this.db.prepare(`
                INSERT INTO prediction_trades (
                    timestamp, gemini_market_id, market_title, category,
                    direction, entry_price, position_size, opportunity_score,
                    polymarket_signal_price, kalshi_signal_price,
                    gemini_entry_bid, gemini_entry_ask, gemini_volume,
                    take_profit_price, stop_loss_price, slippage, mode
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),

            closeTrade: this.db.prepare(`
                UPDATE prediction_trades SET
                    exit_price = ?,
                    pnl = ?,
                    hold_time = ?,
                    exit_reason = ?,
                    is_open = 0
                WHERE id = ?
            `),

            getOpenTrades: this.db.prepare(`
                SELECT * FROM prediction_trades WHERE is_open = 1 ORDER BY timestamp DESC
            `),

            getRecentTrades: this.db.prepare(`
                SELECT * FROM prediction_trades WHERE is_open = 0 ORDER BY timestamp DESC LIMIT ?
            `),

            insertSignal: this.db.prepare(`
                INSERT INTO signals (
                    timestamp, gemini_market_id, signal_type, opportunity_score,
                    price_velocity, spread_differential, cross_platform_consensus,
                    gemini_staleness, category_win_rate,
                    polymarket_price, kalshi_price, gemini_price, triggered_trade
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),

            updateSignalOutcome: this.db.prepare(`
                UPDATE signals SET outcome_price_60s = ?, outcome_direction_correct = ? WHERE id = ?
            `),

            getWallet: this.db.prepare(`SELECT * FROM paper_wallet WHERE id = 1`),

            updateWallet: this.db.prepare(`
                UPDATE paper_wallet SET
                    balance = ?,
                    peak_balance = MAX(peak_balance, ?),
                    total_trades = total_trades + 1,
                    winning_trades = winning_trades + CASE WHEN ? > 0 THEN 1 ELSE 0 END,
                    losing_trades = losing_trades + CASE WHEN ? < 0 THEN 1 ELSE 0 END,
                    total_pnl = total_pnl + ?,
                    max_drawdown_pct = MAX(max_drawdown_pct, ?),
                    last_updated = strftime('%s','now')
                WHERE id = 1
            `),

            getParameter: this.db.prepare(`SELECT value FROM bot_parameters WHERE key = ?`),

            setParameter: this.db.prepare(`
                UPDATE bot_parameters SET value = ?, last_updated = strftime('%s','now') WHERE key = ?
            `),

            getAllParameters: this.db.prepare(`SELECT * FROM bot_parameters`),

            getActiveMarkets: this.db.prepare(`
                SELECT m.*, mm.polymarket_market_id as mm_poly_id, mm.kalshi_market_id as mm_kalshi_id,
                       mm.match_confidence
                FROM markets m
                LEFT JOIN matched_markets mm ON m.gemini_market_id = mm.gemini_market_id
                WHERE m.is_active = 1
            `),

            getMatchedMarkets: this.db.prepare(`
                SELECT * FROM matched_markets WHERE is_active = 1 AND match_confidence >= ?
            `),

            upsertMatchedMarket: this.db.prepare(`
                INSERT INTO matched_markets (gemini_market_id, polymarket_market_id, kalshi_market_id, event_title, resolution_date, category, match_confidence, manual_override, polymarket_yes_token_id, polymarket_no_token_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(gemini_market_id) DO UPDATE SET
                    polymarket_market_id = excluded.polymarket_market_id,
                    kalshi_market_id = excluded.kalshi_market_id,
                    event_title = excluded.event_title,
                    resolution_date = excluded.resolution_date,
                    category = excluded.category,
                    match_confidence = excluded.match_confidence,
                    manual_override = excluded.manual_override,
                    polymarket_yes_token_id = excluded.polymarket_yes_token_id,
                    polymarket_no_token_id = excluded.polymarket_no_token_id
            `),

            getLatestPrices: this.db.prepare(`
                SELECT mp.* FROM market_prices mp
                INNER JOIN (
                    SELECT gemini_market_id, MAX(timestamp) as max_ts
                    FROM market_prices
                    GROUP BY gemini_market_id
                ) latest ON mp.gemini_market_id = latest.gemini_market_id AND mp.timestamp = latest.max_ts
            `),

            getPriceHistory: this.db.prepare(`
                SELECT * FROM market_prices
                WHERE gemini_market_id = ? AND timestamp >= ?
                ORDER BY timestamp ASC
            `),

            getTodayTrades: this.db.prepare(`
                SELECT * FROM prediction_trades
                WHERE timestamp >= ? AND is_open = 0
                ORDER BY timestamp DESC
            `),

            getDailyPnL: this.db.prepare(`
                SELECT COALESCE(SUM(pnl), 0) as daily_pnl,
                       COUNT(*) as trade_count,
                       SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                       SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses
                FROM prediction_trades
                WHERE timestamp >= ? AND is_open = 0
            `),

            getWinRateByCategory: this.db.prepare(`
                SELECT category,
                       COUNT(*) as total,
                       SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                       CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as win_rate
                FROM prediction_trades
                WHERE is_open = 0 AND timestamp >= ?
                GROUP BY category
            `),

            cleanOldPrices: this.db.prepare(`
                DELETE FROM market_prices WHERE timestamp < ?
            `),

            getWinRateByExitReason: this.db.prepare(`
                SELECT exit_reason,
                       COUNT(*) as total,
                       SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                       CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as win_rate,
                       AVG(pnl)     as avg_pnl,
                       AVG(hold_time) as avg_hold_time
                FROM prediction_trades
                WHERE is_open = 0 AND timestamp >= ?
                GROUP BY exit_reason
                ORDER BY total DESC
            `)
        };
    }

    // ----- Market Operations -----

    upsertMarket(market) {
        return this.stmts.upsertMarket.run(
            market.gemini_market_id, market.title, market.category || 'other',
            market.resolution_date || null, market.polymarket_market_id || null,
            market.kalshi_market_id || null
        );
    }

    getActiveMarkets() {
        return this.stmts.getActiveMarkets.all();
    }

    getMatchedMarkets(minConfidence = 0.5) {
        return this.stmts.getMatchedMarkets.all(minConfidence);
    }

    upsertMatchedMarket(match) {
        return this.stmts.upsertMatchedMarket.run(
            match.gemini_market_id, match.polymarket_market_id || null,
            match.kalshi_market_id || null, match.event_title,
            match.resolution_date || null, match.category || 'other',
            match.match_confidence || 0.0, match.manual_override ? 1 : 0,
            match.polymarket_yes_token_id || null,
            match.polymarket_no_token_id || null
        );
    }

    // ----- Price Operations -----

    insertPrice(price) {
        return this.stmts.insertPrice.run(
            price.timestamp, price.gemini_market_id,
            price.polymarket_bid || null, price.polymarket_ask || null,
            price.polymarket_last || null, price.polymarket_volume || null,
            price.kalshi_bid || null, price.kalshi_ask || null,
            price.kalshi_last || null, price.kalshi_volume || null,
            price.gemini_bid || null, price.gemini_ask || null,
            price.gemini_last || null, price.gemini_volume || null
        );
    }

    getLatestPrices() {
        return this.stmts.getLatestPrices.all();
    }

    getPriceHistory(marketId, sinceTimestamp) {
        return this.stmts.getPriceHistory.all(marketId, sinceTimestamp);
    }

    cleanOldPrices(olderThanTimestamp) {
        return this.stmts.cleanOldPrices.run(olderThanTimestamp);
    }

    // ----- Trade Operations -----

    insertTrade(trade) {
        const result = this.stmts.insertTrade.run(
            trade.timestamp, trade.gemini_market_id, trade.market_title || '',
            trade.category || 'other', trade.direction, trade.entry_price,
            trade.position_size, trade.opportunity_score || 0,
            trade.polymarket_signal_price || null, trade.kalshi_signal_price || null,
            trade.gemini_entry_bid || null, trade.gemini_entry_ask || null,
            trade.gemini_volume || null, trade.take_profit_price || null,
            trade.stop_loss_price || null, trade.slippage || 0, trade.mode || 'paper'
        );
        return result.lastInsertRowid;
    }

    closeTrade(id, exitPrice, pnl, holdTime, exitReason) {
        return this.stmts.closeTrade.run(exitPrice, pnl, holdTime, exitReason, id);
    }

    getOpenTrades() {
        return this.stmts.getOpenTrades.all();
    }

    getRecentTrades(limit = 20) {
        return this.stmts.getRecentTrades.all(limit);
    }

    getTodayTrades() {
        const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
        return this.stmts.getTodayTrades.all(todayStart);
    }

    getDailyPnL() {
        const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
        return this.stmts.getDailyPnL.get(todayStart);
    }

    // ----- Signal Operations -----

    insertSignal(signal) {
        const result = this.stmts.insertSignal.run(
            signal.timestamp, signal.gemini_market_id, signal.signal_type || 'composite',
            signal.opportunity_score, signal.price_velocity || 0,
            signal.spread_differential || 0, signal.cross_platform_consensus || 0,
            signal.gemini_staleness || 0, signal.category_win_rate || 0,
            signal.polymarket_price || null, signal.kalshi_price || null,
            signal.gemini_price || null, signal.triggered_trade ? 1 : 0
        );
        return result.lastInsertRowid;
    }

    updateSignalOutcome(id, outcomePrice60s, directionCorrect) {
        return this.stmts.updateSignalOutcome.run(outcomePrice60s, directionCorrect ? 1 : 0, id);
    }

    // ----- Wallet Operations -----

    getWallet() {
        return this.stmts.getWallet.get();
    }

    updateWallet(newBalance, pnl) {
        const wallet = this.getWallet();
        const drawdown = wallet.peak_balance > 0
            ? ((wallet.peak_balance - Math.min(newBalance, wallet.peak_balance)) / wallet.peak_balance) * 100
            : 0;
        return this.stmts.updateWallet.run(newBalance, newBalance, pnl, pnl, pnl, drawdown);
    }

    // ----- Parameter Operations -----

    getParameter(key) {
        const row = this.stmts.getParameter.get(key);
        return row ? row.value : null;
    }

    setParameter(key, value) {
        return this.stmts.setParameter.run(value, key);
    }

    getAllParameters() {
        return this.stmts.getAllParameters.all();
    }

    // ----- Analytics -----

    getWinRateByCategory(sinceDays = 7) {
        const since = Math.floor(Date.now() / 1000) - (sinceDays * 86400);
        return this.stmts.getWinRateByCategory.all(since);
    }

    /**
     * Break down win rate and avg P&L by exit_reason over the last N days.
     * Use this to measure whether time_decay_stop exits hurt or help performance.
     *   exit reasons: take_profit | stop_loss | time_decay_stop | time_exit
     */
    getWinRateByExitReason(sinceDays = 7) {
        const since = Math.floor(Date.now() / 1000) - (sinceDays * 86400);
        return this.stmts.getWinRateByExitReason.all(since);
    }

    getPerformanceSummary() {
        const wallet = this.getWallet();
        const daily = this.getDailyPnL();
        const openTrades = this.getOpenTrades();
        const params = this.getAllParameters();

        const paramMap = {};
        for (const p of params) {
            paramMap[p.key] = p.value;
        }

        return {
            wallet,
            daily,
            open_positions: openTrades.length,
            open_trades: openTrades,
            parameters: paramMap
        };
    }

    // ----- Maintenance -----

    vacuum() {
        this.db.exec('VACUUM');
    }

    close() {
        this.db.close();
    }
}

module.exports = PredictionDatabase;
