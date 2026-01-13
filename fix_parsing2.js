const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');

// Find the entire stdout.on('data') callback start and end
const callbackStart = content.indexOf("botProcess.stdout.on('data', (data) => {");
const callbackEnd = content.indexOf("res.writeHead(200,", callbackStart);

console.log('Callback markers:', callbackStart, callbackEnd);

if (callbackStart > 0 && callbackEnd > callbackStart) {
    const before = content.substring(0, callbackStart);
    const after = content.substring(callbackEnd);
    
    const newCallback = `botProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    console.log('[BOT]', output.trim());
                    
                    // Parse pairs count - "Found 500 USD pairs"
                    const pairsMatch = output.match(/Found (\\d+) USD pairs/);
                    if (pairsMatch) {
                        botStatus.pairs_scanned = parseInt(pairsMatch[1]);
                        botStatus.message = \`Scanning \${pairsMatch[1]} USD pairs\`;
                    }
                    
                    if (output.includes('Scanning')) {
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
                    const exitMatch = output.match(/--- EXIT (\\w+) \\[(take_profit|stop_loss|trailing_stop|timeout)\\] ---/);
                    if (exitMatch) {
                        const pair = exitMatch[1];
                        const reason = exitMatch[2];
                        
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
                    
                    // Parse P&L line: "  P&L: $1.50 (+1.5%)" - individual trade P&L (not summary with fees)
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
                    
                    // Parse PERFORMANCE SUMMARY: "  Trades: 10 (W:4 L:6)"
                    const summaryTradesMatch = output.match(/Trades: (\\d+) \\(W:(\\d+) L:(\\d+)\\)/);
                    if (summaryTradesMatch) {
                        learningData.total_trades = parseInt(summaryTradesMatch[1]);
                        learningData.winning_trades = parseInt(summaryTradesMatch[2]);
                        learningData.losing_trades = parseInt(summaryTradesMatch[3]);
                    }
                    
                    // Parse Win Rate: "  Win Rate: 40.0%"
                    const wrMatch = output.match(/Win Rate: ([\\d.]+)%/);
                    if (wrMatch) {
                        learningData.win_rate = parseFloat(wrMatch[1]);
                    }
                    
                    // Parse summary P&L with fees: "  P&L: $-2.50 (fees: $4.00)"
                    const summaryPnlMatch = output.match(/P&L: \\$([\\-\\d.]+) \\(fees:/);
                    if (summaryPnlMatch) {
                        const pnl = parseFloat(summaryPnlMatch[1]);
                        if (!isNaN(pnl) && Math.abs(pnl) < 100000) {
                            learningData.total_pnl = pnl;
                            botStatus.current_pnl = pnl;
                        }
                    }
                    
                    // Parse exit summary: "  Exits: TP:2 SL:3 Trail:1 TO:4"
                    const exitsMatch = output.match(/Exits: TP:(\\d+) SL:(\\d+) Trail:(\\d+) TO:(\\d+)/);
                    if (exitsMatch) {
                        learningData.tp_exits = parseInt(exitsMatch[1]);
                        learningData.sl_exits = parseInt(exitsMatch[2]);
                        learningData.trailing_exits = parseInt(exitsMatch[3]);
                        learningData.timeout_exits = parseInt(exitsMatch[4]);
                    }
                    
                    // Update timestamps
                    learningData.last_update = Date.now();
                    botStatus.last_update = Date.now();
                });

                `;
    
    content = before + newCallback + after;
    fs.writeFileSync('server.js', content);
    console.log('Successfully updated server.js parsing!');
} else {
    console.log('Could not find callback markers - manual update needed');
}
