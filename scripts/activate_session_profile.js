#!/usr/bin/env node

/**
 * Activate short_horizon_v1 profile DB overrides.
 *
 * Usage:
 *   node scripts/activate_session_profile.js --dry-run
 *   node scripts/activate_session_profile.js
 */

const path = require('path');
const PredictionDatabase = require('../lib/prediction_db');

const DRY_RUN = process.argv.includes('--dry-run');
const dbPath = path.join(__dirname, '..', 'data', 'prediction_markets.db');

const OVERRIDES = {
    max_position_size: 10.0,
    live_max_position_size: 1.0,
    stop_loss_width: 0.06,
    min_edge_live: 0.06,
    hold_to_settlement: 0,
    max_hold_time: 480,
    pre_expiry_exit_seconds: 180
};

function toNumberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function main() {
    const db = new PredictionDatabase(dbPath);

    console.log('Applying short_horizon_v1 parameter overrides');
    console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'WRITE'}`);

    const rows = Object.entries(OVERRIDES).map(([key, target]) => {
        const current = toNumberOrNull(db.getParameter(key));
        return { key, current, target, change: current !== target };
    });

    for (const row of rows) {
        const currentText = row.current == null ? 'null' : row.current;
        console.log(`${row.key}: ${currentText} -> ${row.target}${row.change ? '' : ' (no change)'}`);
    }

    if (DRY_RUN) {
        console.log('Dry-run complete. No changes written.');
        return;
    }

    for (const row of rows) {
        if (row.change) {
            db.setParameter(row.key, row.target);
        }
    }

    console.log('Profile overrides applied.');
}

try {
    main();
} catch (error) {
    console.error('Failed to activate profile:', error.message);
    process.exitCode = 1;
}
