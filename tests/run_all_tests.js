#!/usr/bin/env node
/**
 * Kraken AI Trader - Comprehensive Test Suite Runner
 * 
 * Runs all tests and provides a summary report
 */

const { spawn } = require('child_process');
const path = require('path');

const TESTS = [
    {
        name: 'Trade Calculations',
        file: 'test_trade_calculations.js',
        description: 'P&L, fees, and trade math verification'
    },
    {
        name: 'Trade Log Validation',
        file: 'test_trade_log.js',
        description: 'Data integrity and schema validation'
    },
    {
        name: 'Dashboard API',
        file: 'test_dashboard_api.js',
        description: 'API endpoints and data serving'
    }
];

async function runTest(testInfo) {
    return new Promise((resolve) => {
        const testPath = path.join(__dirname, testInfo.file);
        const proc = spawn('node', [testPath], { 
            cwd: path.join(__dirname, '..'),
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', (data) => stdout += data.toString());
        proc.stderr.on('data', (data) => stderr += data.toString());
        
        proc.on('close', (code) => {
            // Parse results from output
            const passMatch = stdout.match(/(\d+) passed/);
            const failMatch = stdout.match(/(\d+) failed/);
            const warnMatch = stdout.match(/(\d+) warnings?/);
            
            resolve({
                name: testInfo.name,
                description: testInfo.description,
                passed: passMatch ? parseInt(passMatch[1]) : 0,
                failed: failMatch ? parseInt(failMatch[1]) : 0,
                warnings: warnMatch ? parseInt(warnMatch[1]) : 0,
                exitCode: code,
                output: stdout,
                error: stderr
            });
        });
    });
}

async function main() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║       KRAKEN AI TRADER - COMPREHENSIVE TEST SUITE          ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  Running all tests...                                      ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    
    const results = [];
    let totalPassed = 0;
    let totalFailed = 0;
    let totalWarnings = 0;
    
    for (const test of TESTS) {
        console.log(`\n📋 ${test.name}`);
        console.log(`   ${test.description}`);
        console.log('   ' + '-'.repeat(50));
        
        const result = await runTest(test);
        results.push(result);
        
        totalPassed += result.passed;
        totalFailed += result.failed;
        totalWarnings += result.warnings;
        
        const status = result.failed > 0 ? '❌ FAILED' : '✅ PASSED';
        console.log(`   ${status} - ${result.passed} passed, ${result.failed} failed` + 
                   (result.warnings > 0 ? `, ${result.warnings} warnings` : ''));
    }
    
    // Summary
    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                    TEST SUMMARY                            ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    
    for (const result of results) {
        const icon = result.failed > 0 ? '❌' : '✅';
        const line = `║  ${icon} ${result.name.padEnd(25)} ${result.passed}P ${result.failed}F ${result.warnings}W`;
        console.log(line.padEnd(61) + '║');
    }
    
    console.log('╠════════════════════════════════════════════════════════════╣');
    
    const totalStatus = totalFailed > 0 ? '❌ SOME TESTS FAILED' : '✅ ALL TESTS PASSED';
    console.log(`║  ${totalStatus.padEnd(57)}║`);
    console.log(`║  Total: ${totalPassed} passed, ${totalFailed} failed, ${totalWarnings} warnings`.padEnd(61) + '║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    
    // Exit with failure if any tests failed
    process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(console.error);
