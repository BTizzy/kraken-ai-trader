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
            'ALTER TABLE matched_markets ADD COLUMN polymarket_no_token_id TEXT',
            // Realistic paper shadow tracking columns (V15)
            'ALTER TABLE prediction_trades ADD COLUMN realistic_entry_price REAL',
            'ALTER TABLE prediction_trades ADD COLUMN realistic_exit_price REAL',
            'ALTER TABLE prediction_trades ADD COLUMN realistic_pnl REAL',
            'ALTER TABLE prediction_trades ADD COLUMN gemini_actual_bid REAL',
            'ALTER TABLE prediction_trades ADD COLUMN gemini_actual_ask REAL',
            'ALTER TABLE prediction_trades ADD COLUMN gemini_actual_spread REAL',
            // V19: Signal rejection tracking
            'ALTER TABLE signals ADD COLUMN rejection_reason TEXT',
            // V20: Data collection — signal outcome tracking + entry rejection logging + component storage
            'ALTER TABLE signals ADD COLUMN direction TEXT',
            'ALTER TABLE signals ADD COLUMN signal_components TEXT',
            `CREATE TABLE IF NOT EXISTS entry_rejections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                gemini_market_id TEXT NOT NULL,
                signal_score REAL,
                direction TEXT,
                rejection_stage TEXT NOT NULL,
                rejection_reason TEXT NOT NULL,
                entry_price_est REAL,
                edge_est REAL,
                rejection_details TEXT,
                mode TEXT DEFAULT 'paper',
                created_at INTEGER DEFAULT (strftime('%s','now'))
            )`,
            'ALTER TABLE entry_rejections ADD COLUMN rejection_details TEXT',
            'CREATE INDEX IF NOT EXISTS idx_rejections_ts ON entry_rejections(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_rejections_reason ON entry_rejections(rejection_reason)',
            // V21: explicit trade lifecycle state machine
            'ALTER TABLE prediction_trades ADD COLUMN trade_state TEXT DEFAULT \"ENTERED\"'
        ];
        for (const sql of migrations) {
            try { this.db.exec(sql); } catch (e) { /* column/table already exists */ }
        }

        // V17: Fix phantom live trades (one-time data fix, safe to re-run)
        try {
            // Reclassify phantom gemini_sim_* trades incorrectly marked as live
            this.db.exec(`UPDATE prediction_trades SET mode = 'paper' WHERE mode = 'live' AND gemini_market_id LIKE 'gemini_sim_%'`);

            // V17 parameter resets removed — they ran on every DB open, overwriting
            // runtime parameter changes (entry_threshold, daily_loss_limit, etc).
            // Parameters should only be set via bot_parameters table or explicit code.

            // Restore conservative fractional Kelly baseline when legacy 0.25 default
            // is still present and no explicit tuning has been applied.
            this.db.exec(`UPDATE bot_parameters SET value = 0.15 WHERE key = 'kelly_multiplier' AND value = 0.25`);

            // Add min_edge_live parameter
            this.db.exec(`INSERT OR IGNORE INTO bot_parameters (key, value, min_value, max_value, description) VALUES ('min_edge_live', 0.08, 0.03, 0.20, 'Min net edge for live trades after spread costs')`);
        } catch (e) { /* already migrated */ }

        // V18: Backtest-optimized parameters (one-time migration, uses INSERT OR IGNORE)
        try {

            // Add hold_to_settlement parameter (V18)
            this.db.exec(`INSERT OR IGNORE INTO bot_parameters (key, value, min_value, max_value, description) VALUES ('hold_to_settlement', 1, 0, 1, 'Hold positions up to 80% of time-to-expiry instead of fixed max_hold_time')`);
            this.db.exec(`INSERT OR IGNORE INTO bot_parameters (key, value, min_value, max_value, description) VALUES ('pre_expiry_exit_seconds', 300, 60, 7200, 'Force exit when this many seconds remain before settlement')`);
            this.db.exec(`INSERT OR IGNORE INTO bot_parameters (key, value, min_value, max_value, description) VALUES ('high_score_min_hold_time', 14400, 300, 28800, 'Minimum hold time for high-score positions')`);
            this.db.exec(`INSERT OR IGNORE INTO bot_parameters (key, value, min_value, max_value, description) VALUES ('time_decay_start_fraction', 0.80, 0.50, 0.95, 'Fraction of hold window where decay stop tightening begins')`);
        } catch (e) { /* already migrated */ }

        // V19: Parallel paper+live data collection
        // Fix phantom trade #93 (paper exit on live NO position → $489 fake PnL),
        // separate paper/live wallet tracking, add live-specific sizing params,
        // lower min_edge_live for data collection frequency.
        try {
            // 1. Zero out phantom trade #93 PnL and reclassify as paper
            this.db.exec(`UPDATE prediction_trades SET pnl = 0, mode = 'paper' WHERE id = 93 AND pnl > 400`);

            // 2. Recalculate paper_wallet from actual paper trade PnLs
            const paperPnlResult = this.db.prepare(
                `SELECT COALESCE(SUM(pnl), 0) as total_pnl,
                        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
                        COUNT(*) as total
                 FROM prediction_trades WHERE is_open = 0 AND mode = 'paper'`
            ).get();
            const wallet = this.db.prepare('SELECT * FROM paper_wallet WHERE id = 1').get();
            if (wallet && paperPnlResult) {
                const correctedBalance = wallet.initial_balance + paperPnlResult.total_pnl;
                this.db.prepare(`
                    UPDATE paper_wallet SET
                        balance = ?,
                        peak_balance = ?,
                        total_pnl = ?,
                        winning_trades = ?,
                        losing_trades = ?,
                        total_trades = ?,
                        max_drawdown_pct = 0
                    WHERE id = 1
                `).run(
                    correctedBalance,
                    correctedBalance, // Reset peak to current (clean slate)
                    paperPnlResult.total_pnl,
                    paperPnlResult.wins || 0,
                    paperPnlResult.losses || 0,
                    paperPnlResult.total || 0
                );
            }

            // 3. Add live-specific parameters for parallel paper+live operation
            this.db.exec(`INSERT OR IGNORE INTO bot_parameters (key, value, min_value, max_value, description)
                VALUES ('live_max_position_size', 2, 1, 50, 'Max USD per live trade (data collection: $2)')`);
            this.db.exec(`INSERT OR IGNORE INTO bot_parameters (key, value, min_value, max_value, description)
                VALUES ('live_daily_loss_limit', -5, -100, 0, 'Daily loss limit for live trades only')`);
            this.db.exec(`INSERT OR IGNORE INTO bot_parameters (key, value, min_value, max_value, description)
                VALUES ('live_max_concurrent', 3, 1, 10, 'Max concurrent live positions')`);
            this.db.exec(`INSERT OR IGNORE INTO bot_parameters (key, value, min_value, max_value, description)
                VALUES ('paper_max_concurrent', 5, 1, 20, 'Max concurrent paper positions')`);

            // 4. Lower min_edge_live from 8¢ → 5¢ for data collection (more trades)
            this.db.exec(`UPDATE bot_parameters SET value = 0.05 WHERE key = 'min_edge_live' AND value >= 0.08`);
        } catch (e) { /* already migrated */ }

        // V20: Retroactive NO-trade PnL correction
        // Bug: old formula used wrong sign+denominator: (entry-exit)*size/(1-entry)
        // Fix: unified formula matching YES trades: (exit-entry)*size/entry
        // Idempotent: guarded by sentinel key in bot_parameters
        try {
            const alreadyDone = this.db.prepare(
                "SELECT value FROM bot_parameters WHERE key='v20_no_pnl_backfill_done'"
            ).get();
            if (!alreadyDone) {
                const feeParam = this.db.prepare(
                    "SELECT value FROM bot_parameters WHERE key='fee_per_side'"
                ).get();
                const feePerSide = feeParam ? parseFloat(feeParam.value) : 0.0001;

                const fixTrades = this.db.transaction(() => {
                    const noTrades = this.db.prepare(
                        "SELECT id, entry_price, exit_price, position_size, realistic_entry_price, realistic_exit_price " +
                        "FROM prediction_trades WHERE direction='NO' AND is_open=0 AND exit_price IS NOT NULL"
                    ).all();

                    let fixed = 0;
                    for (const t of noTrades) {
                        // Corrected PnL: (exit - entry) * size / entry (same as YES)
                        const exitValue = (t.exit_price - t.entry_price) * t.position_size / t.entry_price;
                        const entryFee = t.position_size * feePerSide;
                        const exitFee = Math.abs(exitValue + t.position_size) * feePerSide;
                        const correctedPnl = parseFloat((exitValue - entryFee - exitFee).toFixed(4));

                        let correctedRealPnl = null;
                        if (t.realistic_entry_price != null && t.realistic_exit_price != null) {
                            const rExitValue = (t.realistic_exit_price - t.realistic_entry_price) * t.position_size / t.realistic_entry_price;
                            correctedRealPnl = parseFloat((rExitValue - entryFee - exitFee).toFixed(4));
                        }

                        this.db.prepare(
                            "UPDATE prediction_trades SET pnl=?, realistic_pnl=? WHERE id=?"
                        ).run(correctedPnl, correctedRealPnl, t.id);
                        fixed++;
                    }

                    // Reconcile paper_wallet balance from corrected trade PnLs
                    const wallet = this.db.prepare('SELECT * FROM paper_wallet WHERE id=1').get();
                    if (wallet) {
                        const sumRow = this.db.prepare(
                            "SELECT SUM(pnl) s, SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) w, SUM(CASE WHEN pnl<0 THEN 1 ELSE 0 END) l, COUNT(*) c " +
                            "FROM prediction_trades WHERE mode='paper' AND is_open=0"
                        ).get();
                        const newBalance = wallet.initial_balance + (sumRow.s || 0);
                        this.db.prepare(
                            "UPDATE paper_wallet SET balance=?, total_pnl=?, winning_trades=?, losing_trades=?, total_trades=? WHERE id=1"
                        ).run(newBalance, sumRow.s || 0, sumRow.w || 0, sumRow.l || 0, sumRow.c || 0);
                    }

                    // Set sentinel
                    this.db.prepare(
                        "INSERT OR IGNORE INTO bot_parameters (key, value, description) VALUES ('v20_no_pnl_backfill_done', 1, 'V20: NO-trade PnL retroactive correction applied')"
                    ).run();

                    return fixed;
                });

                const n = fixTrades();
                if (n > 0) {
                    console.log(`[DB V20] Retroactively corrected PnL for ${n} NO trades`);
                }
            }
        } catch (e) { /* already migrated or schema mismatch */ }

        // V21: backfill trade_state for existing rows (idempotent)
        try {
            this.db.exec(`UPDATE prediction_trades SET trade_state = 'ENTERED' WHERE trade_state IS NULL`);
            this.db.exec(`UPDATE prediction_trades SET trade_state = 'CLOSED' WHERE is_open = 0`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ptrades_state ON prediction_trades(trade_state)`);
        } catch (e) { /* non-fatal */ }
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
                trade_state TEXT DEFAULT 'ENTERED',
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
                ('hold_to_settlement', 1, 0, 1, 'Hold positions up to 80% of time-to-expiry instead of fixed max_hold_time'),
                ('pre_expiry_exit_seconds', 300, 60, 7200, 'Force exit when this many seconds remain before settlement'),
                ('high_score_min_hold_time', 14400, 300, 28800, 'Minimum hold time for high-score positions'),
                ('time_decay_start_fraction', 0.80, 0.50, 0.95, 'Fraction of hold window where decay stop tightening begins'),
                ('kelly_multiplier', 0.15, 0.05, 0.50, 'Fraction of Kelly criterion to use'),
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
                    trade_state,
                    direction, entry_price, position_size, opportunity_score,
                    polymarket_signal_price, kalshi_signal_price,
                    gemini_entry_bid, gemini_entry_ask, gemini_volume,
                    take_profit_price, stop_loss_price, slippage, mode
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),

            closeTrade: this.db.prepare(`
                UPDATE prediction_trades SET
                    exit_price = ?,
                    pnl = ?,
                    hold_time = ?,
                    exit_reason = ?,
                    is_open = 0,
                    trade_state = 'CLOSED'
                WHERE id = ?
            `),

            updateTradeState: this.db.prepare(`
                UPDATE prediction_trades SET trade_state = ? WHERE id = ?
            `),

            getOpenTrades: this.db.prepare(`
                SELECT * FROM prediction_trades WHERE is_open = 1 ORDER BY timestamp DESC
            `),

            getOpenTradesByMode: this.db.prepare(`
                SELECT * FROM prediction_trades WHERE is_open = 1 AND mode = ? ORDER BY timestamp DESC
            `),

            getRecentTrades: this.db.prepare(`
                SELECT * FROM prediction_trades WHERE is_open = 0 ORDER BY timestamp DESC LIMIT ?
            `),

            getRecentTradesByMode: this.db.prepare(`
                SELECT * FROM prediction_trades WHERE is_open = 0 AND mode = ? ORDER BY timestamp DESC LIMIT ?
            `),

            insertSignal: this.db.prepare(`
                INSERT INTO signals (
                    timestamp, gemini_market_id, signal_type, opportunity_score,
                    price_velocity, spread_differential, cross_platform_consensus,
                    gemini_staleness, category_win_rate,
                    polymarket_price, kalshi_price, gemini_price, triggered_trade,
                    rejection_reason, direction, signal_components
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),

            updateSignalOutcome: this.db.prepare(`
                UPDATE signals SET outcome_price_60s = ?, outcome_direction_correct = ? WHERE id = ?
            `),

            insertEntryRejection: this.db.prepare(`
                INSERT INTO entry_rejections (
                    timestamp, gemini_market_id, signal_score, direction,
                    rejection_stage, rejection_reason, entry_price_est, edge_est, rejection_details, mode
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                INSERT INTO matched_markets (gemini_market_id, polymarket_market_id, kalshi_market_id, event_title, resolution_date, category, match_confidence, manual_override, polymarket_yes_token_id, polymarket_no_token_id, is_active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(gemini_market_id) DO UPDATE SET
                    polymarket_market_id = excluded.polymarket_market_id,
                    kalshi_market_id = excluded.kalshi_market_id,
                    event_title = excluded.event_title,
                    resolution_date = excluded.resolution_date,
                    category = excluded.category,
                    match_confidence = excluded.match_confidence,
                    manual_override = excluded.manual_override,
                    polymarket_yes_token_id = excluded.polymarket_yes_token_id,
                    polymarket_no_token_id = excluded.polymarket_no_token_id,
                    is_active = 1
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

            getDailyPnLByMode: this.db.prepare(`
                SELECT COALESCE(SUM(pnl), 0) as daily_pnl,
                       COUNT(*) as trade_count,
                       SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                       SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses
                FROM prediction_trades
                WHERE timestamp >= ? AND is_open = 0 AND mode = ?
            `),

            getRecentTradeStats: this.db.prepare(`
                SELECT COALESCE(SUM(pnl), 0) as daily_pnl,
                       COUNT(*) as trade_count,
                       SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                       SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses
                FROM (
                    SELECT pnl FROM prediction_trades
                    WHERE is_open = 0
                    ORDER BY timestamp DESC
                    LIMIT ?
                )
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
            `),

            updateTradeRealisticEntry: this.db.prepare(`
                UPDATE prediction_trades SET
                    realistic_entry_price = ?,
                    gemini_actual_bid = ?,
                    gemini_actual_ask = ?,
                    gemini_actual_spread = ?
                WHERE id = ?
            `),

            updateTradeRealisticExit: this.db.prepare(`
                UPDATE prediction_trades SET
                    realistic_exit_price = ?,
                    realistic_pnl = ?
                WHERE id = ?
            `),

            getRealisticTradeStats: this.db.prepare(`
                SELECT COALESCE(SUM(realistic_pnl), 0) as realistic_pnl,
                       COALESCE(SUM(pnl), 0) as synthetic_pnl,
                       COUNT(*) as trade_count,
                       SUM(CASE WHEN realistic_pnl > 0 THEN 1 ELSE 0 END) as realistic_wins,
                       SUM(CASE WHEN realistic_pnl < 0 THEN 1 ELSE 0 END) as realistic_losses,
                       SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as synthetic_wins,
                       AVG(pnl - realistic_pnl) as avg_pnl_gap
                FROM (
                    SELECT pnl, realistic_pnl FROM prediction_trades
                    WHERE is_open = 0 AND realistic_pnl IS NOT NULL
                    ORDER BY timestamp DESC
                    LIMIT ?
                )
            `),

            getSignalFrequencyStats: this.db.prepare(`
                SELECT COUNT(*) as total_signals,
                       SUM(CASE WHEN triggered_trade = 1 THEN 1 ELSE 0 END) as actionable,
                       SUM(CASE WHEN triggered_trade = 0 THEN 1 ELSE 0 END) as rejected,
                       rejection_reason,
                       COUNT(*) as reason_count
                FROM signals
                WHERE timestamp >= ?
                GROUP BY rejection_reason
                ORDER BY reason_count DESC
                        `),

                        getEntryRejectionSummary: this.db.prepare(`
                                SELECT rejection_stage,
                                             rejection_reason,
                                             COUNT(*) as count,
                                             MAX(timestamp) as last_timestamp
                                FROM entry_rejections
                                WHERE timestamp >= ?
                                    AND (? IS NULL OR rejection_stage = ?)
                                    AND (? IS NULL OR mode = ?)
                                GROUP BY rejection_stage, rejection_reason
                                ORDER BY count DESC, last_timestamp DESC
                        `),

                        getRecentEntryRejections: this.db.prepare(`
                                SELECT timestamp,
                                             gemini_market_id,
                                             signal_score,
                                             direction,
                                             rejection_stage,
                                             rejection_reason,
                                             entry_price_est,
                                             edge_est,
                                             rejection_details,
                                             mode
                                FROM entry_rejections
                                WHERE timestamp >= ?
                                    AND (? IS NULL OR rejection_stage = ?)
                                    AND (? IS NULL OR mode = ?)
                                ORDER BY timestamp DESC
                                LIMIT ?
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

    deactivateAllMatches() {
        return this.db.prepare('UPDATE matched_markets SET is_active = 0 WHERE manual_override = 0').run();
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
            trade.category || 'other', trade.trade_state || 'ENTERED', trade.direction, trade.entry_price,
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

    updateTradeState(id, tradeState) {
        return this.stmts.updateTradeState.run(tradeState, id);
    }

    updateTradeRealisticEntry(id, realisticEntryPrice, actualBid, actualAsk, actualSpread) {
        return this.stmts.updateTradeRealisticEntry.run(
            realisticEntryPrice, actualBid, actualAsk, actualSpread, id
        );
    }

    updateTradeRealisticExit(id, realisticExitPrice, realisticPnl) {
        return this.stmts.updateTradeRealisticExit.run(realisticExitPrice, realisticPnl, id);
    }

    getOpenTrades(mode = null) {
        if (mode) {
            return this.stmts.getOpenTradesByMode.all(mode);
        }
        return this.stmts.getOpenTrades.all();
    }

    getRecentTrades(limit = 20, mode = null) {
        if (mode) {
            return this.stmts.getRecentTradesByMode.all(mode, limit);
        }
        return this.stmts.getRecentTrades.all(limit);
    }

    getRecentTradeStats(n = 20) {
        return this.stmts.getRecentTradeStats.get(n);
    }

    getTodayTrades() {
        const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
        return this.stmts.getTodayTrades.all(todayStart);
    }

    getDailyPnL(mode = null) {
        const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
        if (mode) {
            return this.stmts.getDailyPnLByMode.get(todayStart, mode);
        }
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
            signal.gemini_price || null, signal.triggered_trade ? 1 : 0,
            signal.rejection_reason || null,
            signal.direction || null,
            signal.signal_components || null
        );
        return result.lastInsertRowid;
    }

    updateSignalOutcome(id, outcomePrice60s, directionCorrect) {
        return this.stmts.updateSignalOutcome.run(outcomePrice60s, directionCorrect ? 1 : 0, id);
    }

    insertEntryRejection(rejection) {
        const rejectionDetails = rejection.rejection_details
            ? JSON.stringify(rejection.rejection_details)
            : null;
        return this.stmts.insertEntryRejection.run(
            rejection.timestamp, rejection.gemini_market_id,
            rejection.signal_score || null, rejection.direction || null,
            rejection.rejection_stage, rejection.rejection_reason,
            rejection.entry_price_est || null, rejection.edge_est || null,
            rejectionDetails,
            rejection.mode || 'paper'
        );
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

    getRealisticTradeStats(n = 50) {
        return this.stmts.getRealisticTradeStats.get(n);
    }

    getSignalFrequencyStats(sinceDays = 1) {
        const since = Math.floor(Date.now() / 1000) - (sinceDays * 86400);
        return this.stmts.getSignalFrequencyStats.all(since);
    }

    getEntryRejectionSummary({ sinceMs, stage = null, mode = null } = {}) {
        const sinceRaw = Number(sinceMs);
        const since = Number.isFinite(sinceRaw)
            ? (sinceRaw > 1e11 ? Math.floor(sinceRaw / 1000) : Math.floor(sinceRaw))
            : Math.floor(Date.now() / 1000) - 3600;
        const stageFilter = stage || null;
        const modeFilter = mode || null;
        return this.stmts.getEntryRejectionSummary.all(
            since,
            stageFilter,
            stageFilter,
            modeFilter,
            modeFilter
        );
    }

    getRecentEntryRejections({ sinceMs, limit = 50, stage = null, mode = null } = {}) {
        const sinceRaw = Number(sinceMs);
        const since = Number.isFinite(sinceRaw)
            ? (sinceRaw > 1e11 ? Math.floor(sinceRaw / 1000) : Math.floor(sinceRaw))
            : Math.floor(Date.now() / 1000) - 3600;
        const stageFilter = stage || null;
        const modeFilter = mode || null;
        const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
        return this.stmts.getRecentEntryRejections.all(
            since,
            stageFilter,
            stageFilter,
            modeFilter,
            modeFilter,
            safeLimit
        );
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
