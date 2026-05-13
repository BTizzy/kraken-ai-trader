# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-05-13

### Changed
- Migrated from legacy Kraken spot trading to prediction market arbitrage architecture
- Reorganized project structure: `server/`, `tests/`, `skills/`, `scripts/`
- Added ESLint configuration with consistent code style rules
- Improved error handling across API proxy layer

### Added
- Prediction market trading engine (`server/prediction-proxy.js`)
- Cross-platform arbitrage detection (Gemini, Polymarket, Kalshi)
- Paper trading mode with full backtesting support
- SQLite-based trade logging and session persistence
- Health check and bot status API endpoints
- Dashboard at `http://localhost:3003`
- Comprehensive test suite (12 test files)
- Skills documentation for API auth, strategies, and validation

### Removed
- Legacy Kraken bot code (archived to `archive/legacy_kraken_bot/`)

## [1.x] - Legacy

- See `archive/legacy_kraken_bot/` for pre-2.0 Kraken spot trading bot history
