#!/usr/bin/env node
/**
 * start_bot_paper_mode.js - Starts the prediction market bot in paper mode
 * Kills any existing instances and starts fresh.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Ensure .env has GEMINI_MODE=paper
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
if (!envContent.includes('GEMINI_MODE=paper')) {
    console.error('ERROR: .env does not have GEMINI_MODE=paper. Fix .env first.');
    process.exit(1);
}

console.log('[bot starter] Starting prediction market bot in PAPER MODE...');
console.log('[bot starter] Reading .env (should have GEMINI_MODE=paper)');

// Start the bot
const botProc = spawn('node', ['server/prediction-proxy.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env }
});

botProc.on('exit', (code) => {
    console.log(`[bot starter] Bot exited with code ${code}`);
    process.exit(code || 0);
});

// Handle signals
process.on('SIGINT', () => {
    console.log('[bot starter] Received SIGINT, terminating bot...');
    botProc.kill();
});

process.on('SIGTERM', () => {
    console.log('[bot starter] Received SIGTERM, terminating bot...');
    botProc.kill();
});
