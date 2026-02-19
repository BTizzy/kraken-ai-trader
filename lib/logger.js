/**
 * Unified Logging System
 * Provides consistent logging with levels: DEBUG, INFO, WARN, ERROR
 */

const fs = require('fs');
const path = require('path');

// Log levels (lower = more verbose)
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

class Logger {
    constructor(options = {}) {
        this.level = LOG_LEVELS[options.level] !== undefined ? LOG_LEVELS[options.level] : LOG_LEVELS.INFO;
        this.logToConsole = options.logToConsole !== false;
        this.logToFile = options.logToFile || false;
        this.logFile = options.logFile || path.join(__dirname, '..', 'logs', 'bot.log');
        this.maxFileSize = (options.maxFileSizeMB || 10) * 1024 * 1024;
        this.component = options.component || 'BOT';
        
        // Ensure log directory exists
        if (this.logToFile) {
            const logDir = path.dirname(this.logFile);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
        }
    }

    /**
     * Format timestamp for log entries
     */
    formatTimestamp() {
        const now = new Date();
        return now.toISOString().replace('T', ' ').split('.')[0];
    }

    /**
     * Format a log message
     */
    formatMessage(level, message, data = null) {
        const timestamp = this.formatTimestamp();
        const component = this.component.padEnd(10);
        let formatted = `[${timestamp}] [${level.padEnd(5)}] [${component}] ${message}`;
        
        if (data) {
            if (typeof data === 'object') {
                formatted += ' ' + JSON.stringify(data);
            } else {
                formatted += ' ' + data;
            }
        }
        
        return formatted;
    }

    /**
     * Write to log file with rotation
     */
    writeToFile(message) {
        if (!this.logToFile) return;
        
        try {
            // Check file size and rotate if needed
            if (fs.existsSync(this.logFile)) {
                const stats = fs.statSync(this.logFile);
                if (stats.size > this.maxFileSize) {
                    // Rotate: rename current to .old, start fresh
                    const oldFile = this.logFile + '.old';
                    if (fs.existsSync(oldFile)) {
                        fs.unlinkSync(oldFile);
                    }
                    fs.renameSync(this.logFile, oldFile);
                }
            }
            
            fs.appendFileSync(this.logFile, message + '\n');
        } catch (error) {
            console.error('Failed to write to log file:', error.message);
        }
    }

    /**
     * Log at DEBUG level
     */
    debug(message, data = null) {
        if (this.level <= LOG_LEVELS.DEBUG) {
            const formatted = this.formatMessage('DEBUG', message, data);
            if (this.logToConsole) console.log('\x1b[90m' + formatted + '\x1b[0m'); // Gray
            this.writeToFile(formatted);
        }
    }

    /**
     * Log at INFO level
     */
    info(message, data = null) {
        if (this.level <= LOG_LEVELS.INFO) {
            const formatted = this.formatMessage('INFO', message, data);
            if (this.logToConsole) console.log('\x1b[36m' + formatted + '\x1b[0m'); // Cyan
            this.writeToFile(formatted);
        }
    }

    /**
     * Log at WARN level
     */
    warn(message, data = null) {
        if (this.level <= LOG_LEVELS.WARN) {
            const formatted = this.formatMessage('WARN', message, data);
            if (this.logToConsole) console.log('\x1b[33m' + formatted + '\x1b[0m'); // Yellow
            this.writeToFile(formatted);
        }
    }

    /**
     * Log at ERROR level
     */
    error(message, data = null) {
        if (this.level <= LOG_LEVELS.ERROR) {
            const formatted = this.formatMessage('ERROR', message, data);
            if (this.logToConsole) console.error('\x1b[31m' + formatted + '\x1b[0m'); // Red
            this.writeToFile(formatted);
        }
    }

    /**
     * Log a trade entry
     */
    trade(action, details) {
        const message = `${action}: ${details.pair} ${details.direction || 'LONG'} @ $${details.price}`;
        this.info(message, { pnl: details.pnl, reason: details.reason });
    }

    /**
     * Log an API call
     */
    api(method, endpoint, status, latencyMs = null) {
        const latency = latencyMs ? ` (${latencyMs}ms)` : '';
        this.debug(`${method} ${endpoint} -> ${status}${latency}`);
    }

    /**
     * Set log level
     */
    setLevel(level) {
        if (LOG_LEVELS[level] !== undefined) {
            this.level = LOG_LEVELS[level];
            this.info(`Log level set to ${level}`);
        }
    }

    /**
     * Create a child logger with a different component name
     */
    child(component) {
        return new Logger({
            level: Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === this.level),
            logToConsole: this.logToConsole,
            logToFile: this.logToFile,
            logFile: this.logFile,
            component: component
        });
    }
}

// Default logger instance
const defaultLogger = new Logger({
    level: 'INFO',
    logToConsole: true,
    logToFile: true
});

module.exports = {
    Logger,
    LOG_LEVELS,
    defaultLogger,
    // Convenience exports
    debug: (msg, data) => defaultLogger.debug(msg, data),
    info: (msg, data) => defaultLogger.info(msg, data),
    warn: (msg, data) => defaultLogger.warn(msg, data),
    error: (msg, data) => defaultLogger.error(msg, data)
};
