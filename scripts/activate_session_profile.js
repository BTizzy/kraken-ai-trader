#!/usr/bin/env node

/**
 * Activate short_horizon_v1 profile DB overrides.
 *
 * Usage:
 *   node scripts/activate_session_profile.js --dry-run
 *   node scripts/activate_session_profile.js
 */

const path = require('path');
const crypto = require('crypto');
const PredictionDatabase = require('../lib/prediction_db');

const DRY_RUN = process.argv.includes('--dry-run');
const EMIT_JSON = process.argv.includes('--emit-json');
const dbPath = path.join(__dirname, '..', 'data', 'prediction_markets.db');
const PROFILE_NAME = 'short_horizon_v1';
const PROFILE_VERSION = 1;
const PROFILE_JSON_PREFIX = 'SESSION_PROFILE_JSON:';

const OVERRIDES = {
    entry_threshold: 30,
    max_position_size: 10.0,
    live_max_position_size: 1.0,
    stop_loss_width: 0.06,
    min_edge_live: 0.01,
    hold_to_settlement: 0,
    max_hold_time: 480,
    pre_expiry_exit_seconds: 180
};

function stableOverrides(overrides) {
    return Object.keys(overrides)
        .sort()
        .reduce((acc, key) => {
            acc[key] = overrides[key];
            return acc;
        }, {});
}

function buildProfileManifest() {
    const sorted = stableOverrides(OVERRIDES);
    const payload = {
        profile: PROFILE_NAME,
        version: PROFILE_VERSION,
        overrides: sorted
    };

    const checksum = crypto
        .createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');

    return {
        ...payload,
        checksum
    };
}

function toNumberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function main() {
    const db = new PredictionDatabase(dbPath);
    const profileManifest = buildProfileManifest();

    console.log(`Applying ${profileManifest.profile} parameter overrides`);
    console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'WRITE'}`);
    console.log(`Profile checksum: ${profileManifest.checksum}`);

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
        if (EMIT_JSON) {
            console.log(`${PROFILE_JSON_PREFIX}${JSON.stringify({
                ...profileManifest,
                dry_run: true,
                changed_parameters: rows.filter(r => r.change).map(r => r.key),
                changed_count: rows.filter(r => r.change).length
            })}`);
        }
        return profileManifest;
    }

    for (const row of rows) {
        if (row.change) {
            db.setParameter(row.key, row.target);
        }
    }

    console.log('Profile overrides applied.');
    if (EMIT_JSON) {
        console.log(`${PROFILE_JSON_PREFIX}${JSON.stringify({
            ...profileManifest,
            dry_run: false,
            changed_parameters: rows.filter(r => r.change).map(r => r.key),
            changed_count: rows.filter(r => r.change).length
        })}`);
    }
    return profileManifest;
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error('Failed to activate profile:', error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    PROFILE_NAME,
    PROFILE_VERSION,
    PROFILE_JSON_PREFIX,
    OVERRIDES,
    buildProfileManifest
};
