/**
 * Price Collector Tests
 * Verifies that the collector emits a fatal event when consecutive errors exceed threshold
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PriceDataCollector = require('../lib/price_data_collector');

async function runTests() {
    console.log('='.repeat(60));
    console.log('PRICE DATA COLLECTOR TESTS');
    console.log('='.repeat(60));

    let passed = 0;
    let failed = 0;

    // Test: Collector emits fatal after threshold
    try {
        const tmpDb = path.join(os.tmpdir(), `test_price_history_${Date.now()}.db`);

        // Mock fetch that returns no tickers (causes null ticker -> error increment)
        const mockFetch = async (url, opts) => {
            return {
                ok: true,
                json: async () => ({ tickers: [] })
            };
        };

        const collector = new PriceDataCollector({
            dbPath: tmpDb,
            fetchFn: mockFetch,
            consecutiveErrorThreshold: 3,
            collectionInterval: 20,
            minCollectionInterval: 10,
            failOnConsecutiveErrors: true
        });

        let fatalReceived = false;
        const fatalPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timeout waiting for fatal event')), 2000);
            collector.on('fatal', (info) => {
                clearTimeout(timer);
                fatalReceived = true;
                resolve(info);
            });
        });

        collector.startCollection();

        const info = await fatalPromise;
        assert(info && info.pair, 'Fatal info missing pair');

        // Cleanup
        try { collector.stop(); } catch (e) {}
        try { fs.unlinkSync(tmpDb); } catch (e) {}

        console.log('✅ Test: Collector emits fatal after threshold PASSED', info);
        passed++;
    } catch (e) {
        console.log('❌ Test: Collector emits fatal after threshold FAILED:', e.message);
        failed++;
    }

    console.log('\n' + '='.repeat(60));
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));

    return { passed, failed };
}

// Run if called directly
if (require.main === module) {
    runTests().then(res => process.exit(res.failed > 0 ? 1 : 0)).catch(err => {
        console.error('Test error:', err);
        process.exit(1);
    });
}

module.exports = { runTests };
