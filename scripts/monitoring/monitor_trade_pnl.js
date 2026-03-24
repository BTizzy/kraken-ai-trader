#!/usr/bin/env node
/**
 * Monitor trades DB total P&L and stop a process if thresholds are hit
 * Usage: node scripts/monitor_trade_pnl.js --db=./data/trades.db --pid=<PID> --stop-loss=-100 --profit-target=200
 */
const sqlite3 = require('sqlite3').verbose();
const argv = require('minimist')(process.argv.slice(2));
const dbPath = argv.db || './data/trades.db';
const pid = parseInt(argv.pid, 10);
const stopLoss = parseFloat(argv['stop-loss'] || argv.stop_loss || -100);
const profitTarget = parseFloat(argv['profit-target'] || argv.profit_target || 200);
const poll = parseInt(argv.poll || 10) * 1000 || 10000;

if (!pid) {
    console.error('Missing pid'); process.exit(2);
}

function getTotalPnl(cb) {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) return cb(err);
        db.get('SELECT SUM(pnl) as total FROM trades', (e,row) => {
            db.close();
            if (e) return cb(e);
            cb(null, row ? (row.total || 0) : 0);
        });
    });
}

async function main() {
    console.log(`Monitoring PID ${pid} for thresholds: stopLoss=${stopLoss}, profitTarget=${profitTarget}`);
    while (true) {
        await new Promise(r => setTimeout(r,poll));
        try {
            await new Promise((resolve, reject) => {
                getTotalPnl((err,total) => {
                    if (err) return reject(err);
                    console.log(new Date().toISOString(), 'total_pnl=', total.toFixed(2));
                    if (total <= stopLoss) {
                        console.error('Stop-loss breached; killing PID', pid);
                        try { process.kill(pid, 'SIGTERM'); } catch(e) {}
                        resolve('stopped');
                    } else if (total >= profitTarget) {
                        console.log('Profit target reached; killing PID', pid);
                        try { process.kill(pid, 'SIGTERM'); } catch(e) {}
                        resolve('stopped');
                    } else {
                        resolve();
                    }
                });
            });
        } catch (e) {
            console.error('Monitor error:', e.message);
        }
    }
}

main().catch(e => { console.error(e); process.exit(1); });
