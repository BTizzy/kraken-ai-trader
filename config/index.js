/**
 * Unified Configuration Loader
 * Single source of truth for all bot settings
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

let config = null;

/**
 * Load configuration from JSON file
 */
function loadConfig() {
    try {
        const rawConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
        config = JSON.parse(rawConfig);
        console.log('[CONFIG] Loaded configuration v' + config._version);
        return config;
    } catch (error) {
        console.error('[CONFIG] Error loading config:', error.message);
        // Return defaults if file not found
        return getDefaults();
    }
}

/**
 * Get default configuration
 */
function getDefaults() {
    return {
        trading: {
            mode: 'paper',
            enable_learning: true,
            max_concurrent_trades: 2,
            scan_interval_seconds: 20
        },
        position_sizing: {
            base_position_usd: 100.0,
            min_position_usd: 25.0,
            max_position_usd: 500.0,
            kelly_fraction: 0.25
        },
        risk_management: {
            take_profit_pct: 1.5,
            stop_loss_pct: 0.6,
            trailing_start_pct: 0.8,
            trailing_stop_pct: 0.3,
            max_drawdown_pct: 10.0
        },
        filters: {
            min_confidence_threshold: 0.65
        },
        fees: {
            taker_fee_pct: 0.4,
            min_profit_after_fees_pct: 0.5
        },
        api: {
            rate_limit_requests_per_second: 1,
            retry_max_attempts: 3,
            retry_base_delay_ms: 1000
        },
        server: {
            port: 8000
        }
    };
}

/**
 * Get current configuration (lazy load)
 */
function getConfig() {
    if (!config) {
        config = loadConfig();
    }
    return config;
}

/**
 * Get a specific config section
 */
function getSection(section) {
    const cfg = getConfig();
    return cfg[section] || {};
}

/**
 * Reload configuration from disk
 */
function reloadConfig() {
    config = null;
    return loadConfig();
}

/**
 * Save configuration to disk
 */
function saveConfig(newConfig) {
    try {
        newConfig._updated = new Date().toISOString().split('T')[0];
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
        config = newConfig;
        console.log('[CONFIG] Configuration saved');
        return true;
    } catch (error) {
        console.error('[CONFIG] Error saving config:', error.message);
        return false;
    }
}

module.exports = {
    loadConfig,
    getConfig,
    getSection,
    getDefaults,
    reloadConfig,
    saveConfig,
    CONFIG_PATH
};
