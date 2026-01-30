/**
 * Degraded Network Collector Test
 * Runs the collector with a flaky fetch function for a short period and ensures
 * it continues running and writing to the DB without emitting fatal.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PriceDataCollector = require('../lib/price_data_collector');

function mockFlakyFetchFactory(failRate = 0.3, maxDelayMs = 400) {
    return async (url, opts) => {
        // Random delay
        const delay = Math.floor(Math.random() * maxDelayMs);
        await new Promise(r => setTimeout(r, delay));
        if (Math.random() < failRate) {
            // Simulate network failure
            throw new Error('simulated network failure');
        }
        // Return a successful, but sometimes-empty ticker
        return {
            ok: true,
            json: async () => ({ tickers: [{ last: (1000 + Math.random() * 1000).toFixed(2), bid: 0, ask: 0, volumeQuote: 100 } ] })
        };
    };
}

async function run() {
    console.log('='.repeat(60));
    console.log('DEGRADED NETWORK COLLECTOR TEST');
    console.log('='.repeat(60));

    const tmpDb = path.join(os.tmpdir(), `test_price_history_degraded_${Date.now()}.db`);

    const collector = new PriceDataCollector({
        dbPath: tmpDb,
        fetchFn: mockFlakyFetchFactory(0.4, 300),
        consecutiveErrorThreshold: 1000, // won't hit fatal
        collectionInterval: 50,
        minCollectionInterval: 10
    });

    let fatal = false;
    collector.on('fatal', () => { fatal = true; });

    collector.startCollection();

    // Run for 5 seconds
    await new Promise(r => setTimeout(r, 5000));

    collector.stop();

    assert(!fatal, 'Collector emitted fatal under degraded network');

    // Open DB and check some rows exist
    const sqlite = require('better-sqlite3');
    const db = sqlite(tmpDb);
    const row = db.prepare('SELECT COUNT(*) as c FROM price_history').get();
    db.close();

    assert(row.c > 0, 'No rows written to DB under degraded network');

    try { fs.unlinkSync(tmpDb); } catch (e) {}

    console.log('✅ Degraded network test passed');
    console.log('='.repeat(60));
    return { passed: 1, failed: 0 };
}

if (require.main === module) {
    run().then(res => process.exit(res.failed > 0 ? 1 : 0)).catch(err => {
        console.error('Degraded test failed:', err);
        process.exit(1);
    });
}

module.exports = { run };
