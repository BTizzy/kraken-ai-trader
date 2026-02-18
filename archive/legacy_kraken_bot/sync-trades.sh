#!/bin/bash
# sync-trades.sh - Sync trading logs to git repository
# Run after each trading session to persist logs

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")

echo "📊 Kraken Trading Log Sync"
echo "================================"

# Create logs directory if it doesn't exist
mkdir -p "$LOGS_DIR"

# Check if there's a log file passed as argument (from browser download)
if [ -n "$1" ] && [ -f "$1" ]; then
    LOG_FILE="$1"
    DEST_FILE="$LOGS_DIR/$(basename "$LOG_FILE")"
    cp "$LOG_FILE" "$DEST_FILE"
    echo "✅ Copied log file: $DEST_FILE"
fi

# Check for any new JSON files in Downloads (common browser download location)
DOWNLOADS_DIR="$HOME/Downloads"
if [ -d "$DOWNLOADS_DIR" ]; then
    for file in "$DOWNLOADS_DIR"/trades_*.json; do
        if [ -f "$file" ]; then
            BASENAME=$(basename "$file")
            if [ ! -f "$LOGS_DIR/$BASENAME" ]; then
                mv "$file" "$LOGS_DIR/"
                echo "✅ Moved: $BASENAME to logs/"
            fi
        fi
    done
fi

# Generate combined analytics file
echo ""
echo "📈 Generating combined analytics..."

# Create a combined stats file
COMBINED_FILE="$LOGS_DIR/combined_analytics.json"
node -e "
const fs = require('fs');
const path = require('path');

const logsDir = '$LOGS_DIR';
const files = fs.readdirSync(logsDir).filter(f => f.startsWith('trades_') && f.endsWith('.json'));

let allTrades = [];
files.forEach(file => {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(logsDir, file), 'utf8'));
        if (data.trades) {
            allTrades = allTrades.concat(data.trades);
        }
    } catch (e) {
        console.error('Error reading ' + file + ':', e.message);
    }
});

// Remove duplicates by trade ID
const uniqueTrades = [...new Map(allTrades.map(t => [t.id, t])).values()];

// Sort by timestamp
uniqueTrades.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

// Calculate combined stats
const wins = uniqueTrades.filter(t => t.netPnl > 0);
const losses = uniqueTrades.filter(t => t.netPnl <= 0);
const totalPnl = uniqueTrades.reduce((sum, t) => sum + (t.netPnl || 0), 0);
const totalFees = uniqueTrades.reduce((sum, t) => sum + (t.fees || 0), 0);
const grossProfit = wins.reduce((sum, t) => sum + t.netPnl, 0);
const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.netPnl, 0));

// Calculate max drawdown
let peak = 0, maxDrawdown = 0, running = 0;
uniqueTrades.forEach(t => {
    running += t.netPnl || 0;
    peak = Math.max(peak, running);
    const dd = peak > 0 ? (peak - running) / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, dd);
});

// Calculate Sharpe (simplified)
const returns = uniqueTrades.map(t => (t.netPnlPercent || 0) / 100);
const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
const stdDev = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length || 1));
const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

const combined = {
    generatedAt: new Date().toISOString(),
    sourceFiles: files.length,
    stats: {
        totalTrades: uniqueTrades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: uniqueTrades.length > 0 ? ((wins.length / uniqueTrades.length) * 100).toFixed(1) + '%' : '0%',
        totalNetPnl: totalPnl.toFixed(2),
        totalFeesPaid: totalFees.toFixed(2),
        profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'N/A',
        avgWinAmount: wins.length > 0 ? (grossProfit / wins.length).toFixed(2) : '0',
        avgLossAmount: losses.length > 0 ? (grossLoss / losses.length).toFixed(2) : '0',
        maxDrawdown: (maxDrawdown * 100).toFixed(1) + '%',
        sharpeRatio: sharpe.toFixed(2)
    },
    allTrades: uniqueTrades
};

fs.writeFileSync('$COMBINED_FILE', JSON.stringify(combined, null, 2));
console.log('Generated combined analytics with ' + uniqueTrades.length + ' unique trades');
" 2>/dev/null || echo "⚠️ Node.js analytics generation skipped (no trades or node not available)"

# Git operations
echo ""
echo "🔄 Syncing to Git..."

cd "$SCRIPT_DIR"

# Check if git repo
if [ -d ".git" ]; then
    # Add logs
    git add logs/
    
    # Check if there are changes
    if git diff --cached --quiet; then
        echo "ℹ️ No new changes to commit"
    else
        # Count log files
        LOG_COUNT=$(ls -1 "$LOGS_DIR"/*.json 2>/dev/null | wc -l || echo "0")
        
        # Commit
        git commit -m "📊 Trading logs sync: $TIMESTAMP ($LOG_COUNT log files)"
        
        # Push
        if git push 2>/dev/null; then
            echo "✅ Pushed to remote repository"
        else
            echo "⚠️ Push failed - you may need to push manually"
        fi
    fi
else
    echo "⚠️ Not a git repository"
fi

echo ""
echo "✅ Sync complete!"
echo ""

# Show summary if combined file exists
if [ -f "$COMBINED_FILE" ]; then
    echo "📈 Combined Trading Statistics:"
    node -e "
    const data = require('$COMBINED_FILE');
    console.table(data.stats);
    " 2>/dev/null || cat "$COMBINED_FILE" | head -30
fi
