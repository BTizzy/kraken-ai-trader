/**
 * DB Locking Resilience Test
 * Simulates a short exclusive DB lock while the collector is running to ensure
 * collector retries and recovers from SQLITE_BUSY without emitting fatal.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite = require('better-sqlite3');

const PriceDataCollector = require('../lib/price_data_collector');

async function run() {
    console.log('='.repeat(60));
    console.log('DB LOCKING RESILIENCE TEST');
    console.log('='.repeat(60));

    const tmpDb = path.join(os.tmpdir(), `test_price_history_lock_${Date.now()}.db`);

    const collector = new PriceDataCollector({
        dbPath: tmpDb,
        fetchFn: async (url) => ({ ok: true, json: async () => ({ tickers: [{ last: 100.0, bid: 0, ask: 0, volumeQuote: 0 }] }) }),
        consecutiveErrorThreshold: 1000,
        collectionInterval: 20,
        minCollectionInterval: 5
    });

    collector.startCollection();

    // Open helper DB and take an exclusive lock for 500ms
    const helperDb = sqlite(tmpDb);
    try {
        helperDb.exec('BEGIN EXCLUSIVE');
        // hold exclusive lock briefly
        await new Promise(r => setTimeout(r, 500));
        helperDb.exec('COMMIT');
    } catch (e) {
        try { helperDb.exec('ROLLBACK'); } catch (e2) {}
        console.warn('helper lock error:', e.message || e);
    } finally {
        helperDb.close();
    }

    // Wait a bit for collector to recover and write
    await new Promise(r => setTimeout(r, 1000));

    collector.stop();

    // Check DB has rows
    const db = sqlite(tmpDb);
    const row = db.prepare('SELECT COUNT(*) as c FROM price_history').get();
    db.close();

    assert(row.c > 0, 'Collector failed to write after DB lock');

    try { fs.unlinkSync(tmpDb); } catch (e) {}

    console.log('✅ DB locking resilience test passed');
    console.log('='.repeat(60));
    return { passed: 1, failed: 0 };
}

if (require.main === module) {
    run().then(res => process.exit(res.failed > 0 ? 1 : 0)).catch(err => {
        console.error('DB lock test failed:', err);
        process.exit(1);
    });
}

module.exports = { run };
