const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

async function runTests() {
    console.log('='.repeat(60));
    console.log('PRICE HISTORY DB SANITY TEST');
    console.log('='.repeat(60));

    let passed = 0;
    let failed = 0;

    try {
        const dbPath = path.join(__dirname, '..', 'data', 'price_history.db');
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) throw err;
        });

        const pairs = ['PI_XBTUSD', 'PI_ETHUSD', 'PI_ADAUSD', 'PI_LINKUSD', 'PI_LTCUSD'];
        for (const pair of pairs) {
            const rows = await new Promise((resolve, reject) => {
                db.all('SELECT price FROM price_history WHERE pair = ? ORDER BY timestamp DESC LIMIT 100', [pair], (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows.map(r => r.price));
                });
            });

            assert(rows.length > 0, `No rows for ${pair}`);

            const unique = new Set(rows);
            assert(unique.size > 1, `Degenerate prices for ${pair} (unique=${unique.size})`);

            // compute simple stddev on log returns
            const returns = [];
            for (let i = 0; i < rows.length - 1; i++) {
                if (rows[i+1] > 0) returns.push(Math.abs(Math.log(rows[i] / rows[i+1])));
            }
            const mean = returns.reduce((a,b) => a+b, 0) / returns.length;
            const variance = returns.reduce((a,b) => a + Math.pow(b-mean,2), 0) / returns.length;
            const std = Math.sqrt(variance);
            assert(std > 0, `Computed zero stddev for ${pair}`);

            console.log(`✅ ${pair}: ${rows.length} rows, unique=${unique.size}, std_pct=${(std*100).toFixed(6)}`);
            passed++;
        }

        db.close();
    } catch (e) {
        console.log('❌ Test FAILED:', e.message);
        failed++;
    }

    console.log('\n' + '='.repeat(60));
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));

    return { passed, failed };
}

if (require.main === module) {
    runTests().then(res => process.exit(res.failed > 0 ? 1 : 0)).catch(err => {
        console.error('Test error:', err.message);
        process.exit(1);
    });
}

module.exports = { runTests };
