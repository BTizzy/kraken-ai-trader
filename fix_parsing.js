const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');

// Find the parsing section start and end
const oldStart = content.indexOf("if (output.includes('Scanning'))");
const oldEnd = content.indexOf("// Parse trade entry with pair");

console.log('Found markers at:', oldStart, oldEnd);

if (oldStart > 0 && oldEnd > oldStart) {
    const before = content.substring(0, oldStart);
    const after = content.substring(oldEnd);
    
    const newParsing = `if (output.includes('Scanning')) {
                        botStatus.message = 'Scanning for opportunities';
                    }
                    
                    // Parse trade ENTRY: "--- ENTER XXUSD ---"
                    const enterMatch = output.match(/--- ENTER (\\w+) ---/);
                    if (enterMatch) {
                        const pair = enterMatch[1];
                        learningData.recent_trades.unshift({
                            pair: pair,
                            direction: 'LONG',
                            timestamp: Date.now(),
                            status: 'active',
                            pnl: null,
                            exit_reason: null
                        });
                        if (learningData.recent_trades.length > 30) {
                            learningData.recent_trades.pop();
                        }
                        botStatus.message = 'Entered ' + pair;
                    }
                    
                    // Parse trade EXIT: "--- EXIT XXUSD [take_profit] ---"
                    const exitMatch2 = output.match(/--- EXIT (\\w+) \\[(take_profit|stop_loss|trailing_stop|timeout)\\] ---/);
                    if (exitMatch2) {
                        const pair = exitMatch2[1];
                        const reason = exitMatch2[2];
                        
                        if (reason === 'take_profit') learningData.tp_exits++;
                        else if (reason === 'stop_loss') learningData.sl_exits++;
                        else if (reason === 'trailing_stop') learningData.trailing_exits++;
                        else learningData.timeout_exits++;
                        
                        const trade = learningData.recent_trades.find(t => t.pair === pair && t.status === 'active');
                        if (trade) {
                            trade.exit_reason = reason;
                            trade.status = 'exiting';
                        }
                        botStatus.message = 'Exited ' + pair + ' [' + reason + ']';
                    }
                    
                    // Parse P&L line: "  P&L: $1.50 (+1.5%)"
                    const tradePnlMatch = output.match(/P&L: \\$([\\-\\d.]+)/);
                    if (tradePnlMatch && !output.includes('(fees:')) {
                        const tradePnl = parseFloat(tradePnlMatch[1]);
                        if (!isNaN(tradePnl) && Math.abs(tradePnl) < 10000) {
                            botStatus.trades_completed++;
                            learningData.total_trades++;
                            learningData.total_pnl += tradePnl;
                            botStatus.current_pnl = learningData.total_pnl;
                            
                            if (tradePnl > 0) {
                                learningData.winning_trades++;
                                if (tradePnl > learningData.best_trade) learningData.best_trade = tradePnl;
                            } else {
                                learningData.losing_trades++;
                                if (tradePnl < learningData.worst_trade) learningData.worst_trade = tradePnl;
                            }
                            
                            learningData.win_rate = learningData.total_trades > 0 
                                ? (learningData.winning_trades / learningData.total_trades * 100) 
                                : 0;
                            
                            const trade = learningData.recent_trades.find(t => t.status === 'exiting');
                            if (trade) {
                                trade.pnl = tradePnl;
                                trade.status = 'completed';
                            }
                            
                            learningData.last_update = Date.now();
                        }
                    }
                    
                    // Parse PERFORMANCE SUMMARY
                    const summaryTradesMatch = output.match(/Trades: (\\d+) \\(W:(\\d+) L:(\\d+)\\)/);
                    if (summaryTradesMatch) {
                        learningData.total_trades = parseInt(summaryTradesMatch[1]);
                        learningData.winning_trades = parseInt(summaryTradesMatch[2]);
                        learningData.losing_trades = parseInt(summaryTradesMatch[3]);
                    }
                    
                    const wrMatch = output.match(/Win Rate: ([\\d.]+)%/);
                    if (wrMatch) {
                        learningData.win_rate = parseFloat(wrMatch[1]);
                    }
                    
                    const summaryPnlMatch = output.match(/P&L: \\$([\\-\\d.]+) \\(fees:/);
                    if (summaryPnlMatch) {
                        const pnl = parseFloat(summaryPnlMatch[1]);
                        if (!isNaN(pnl) && Math.abs(pnl) < 100000) {
                            learningData.total_pnl = pnl;
                            botStatus.current_pnl = pnl;
                        }
                    }
                    
                    const exitsMatch = output.match(/Exits: TP:(\\d+) SL:(\\d+) Trail:(\\d+) TO:(\\d+)/);
                    if (exitsMatch) {
                        learningData.tp_exits = parseInt(exitsMatch[1]);
                        learningData.sl_exits = parseInt(exitsMatch[2]);
                        learningData.trailing_exits = parseInt(exitsMatch[3]);
                        learningData.timeout_exits = parseInt(exitsMatch[4]);
                    }
                    
                    `;
    
    content = before + newParsing + after;
    fs.writeFileSync('server.js', content);
    console.log('Updated server.js parsing');
} else {
    console.log('Could not find markers - manual update needed');
}
