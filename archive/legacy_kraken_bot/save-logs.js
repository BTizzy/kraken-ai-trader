// Save Trading Logs Script
// This script extracts trade logs from localStorage and saves them to a file
// Run in browser console or via the "End Session" button

const TradingLogExporter = {
    /**
     * Get all trade logs from localStorage
     */
    getLogs() {
        const logs = localStorage.getItem('kraken_trade_log');
        return logs ? JSON.parse(logs) : [];
    },

    /**
     * Generate filename with timestamp
     */
    generateFilename() {
        const now = new Date();
        const date = now.toISOString().split('T')[0];
        const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
        return `trades_${date}_${time}.json`;
    },

    /**
     * Generate summary statistics
     */
    generateSummary(logs) {
        if (logs.length === 0) return null;

        const wins = logs.filter(l => l.netPnl > 0);
        const losses = logs.filter(l => l.netPnl <= 0);
        const totalPnl = logs.reduce((sum, l) => sum + l.netPnl, 0);
        const totalFees = logs.reduce((sum, l) => sum + (l.fees || 0), 0);
        const grossProfit = wins.reduce((sum, l) => sum + l.netPnl, 0);
        const grossLoss = Math.abs(losses.reduce((sum, l) => sum + l.netPnl, 0));

        return {
            generated: new Date().toISOString(),
            totalTrades: logs.length,
            wins: wins.length,
            losses: losses.length,
            winRate: ((wins.length / logs.length) * 100).toFixed(1) + '%',
            totalNetPnl: '$' + totalPnl.toFixed(2),
            totalFeesPaid: '$' + totalFees.toFixed(2),
            grossProfit: '$' + grossProfit.toFixed(2),
            grossLoss: '$' + grossLoss.toFixed(2),
            profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'N/A',
            avgWin: wins.length > 0 ? '$' + (grossProfit / wins.length).toFixed(2) : '$0.00',
            avgLoss: losses.length > 0 ? '$' + (grossLoss / losses.length).toFixed(2) : '$0.00',
            largestWin: wins.length > 0 ? '$' + Math.max(...wins.map(l => l.netPnl)).toFixed(2) : '$0.00',
            largestLoss: losses.length > 0 ? '$' + Math.min(...losses.map(l => l.netPnl)).toFixed(2) : '$0.00'
        };
    },

    /**
     * Export logs to downloadable JSON file
     */
    exportToFile() {
        const logs = this.getLogs();
        if (logs.length === 0) {
            console.log('No trades to export');
            return null;
        }

        const exportData = {
            metadata: {
                exportedAt: new Date().toISOString(),
                totalTrades: logs.length,
                version: '1.0'
            },
            summary: this.generateSummary(logs),
            trades: logs
        };

        const filename = this.generateFilename();
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`✅ Exported ${logs.length} trades to ${filename}`);
        return filename;
    },

    /**
     * Get logs as JSON string (for copying)
     */
    getLogsAsJSON() {
        const logs = this.getLogs();
        const exportData = {
            metadata: {
                exportedAt: new Date().toISOString(),
                totalTrades: logs.length
            },
            summary: this.generateSummary(logs),
            trades: logs
        };
        return JSON.stringify(exportData, null, 2);
    },

    /**
     * Clear all logs (use with caution)
     */
    clearLogs() {
        if (confirm('Are you sure you want to clear all trade logs? This cannot be undone.')) {
            localStorage.removeItem('kraken_trade_log');
            console.log('✅ Trade logs cleared');
        }
    },

    /**
     * Print summary to console
     */
    printSummary() {
        const logs = this.getLogs();
        const summary = this.generateSummary(logs);
        
        if (!summary) {
            console.log('No trades to summarize');
            return;
        }

        console.log('\n📊 === TRADING SESSION SUMMARY ===\n');
        console.table(summary);
        return summary;
    }
};

// Make available globally
window.TradingLogExporter = TradingLogExporter;

// Auto-print summary on load
console.log('💾 TradingLogExporter loaded. Commands:');
console.log('  TradingLogExporter.exportToFile() - Download logs as JSON');
console.log('  TradingLogExporter.printSummary() - Show summary in console');
console.log('  TradingLogExporter.getLogsAsJSON() - Get logs as string');
