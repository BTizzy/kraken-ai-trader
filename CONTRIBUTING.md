# Contributing to Kraken AI Trader

## Development Setup

1. Clone the repo
2. Copy `.env.example` to `.env` and configure your API keys
3. Run `npm install`
4. Start in paper mode: `node server/prediction-proxy.js`

## Running Tests

```bash
npm test                 # Run all tests
npm run test:unit        # Unit tests only
npm run test:prediction  # Prediction bot tests
```

## Code Style

- ESLint is configured (`.eslintrc.json`)
- 4-space indentation, single quotes, no trailing spaces
- Use `const` over `let`, never `var`
- All functions should have JSDoc comments

## Project Structure

```
├── server/           # Main server code
│   ├── prediction-proxy.js   # Main entry point (prediction markets)
│   ├── kraken-proxy.js       # Kraken API proxy (legacy)
│   ├── rate-limiter.js       # Rate limiting middleware
│   └── sqlite-utils.js       # Database utilities
├── tests/            # Test suite
├── skills/           # Documentation & reference
├── scripts/          # Utility scripts
└── archive/          # Legacy code (preserved for reference)
```

## Commit Convention

- `feat:` new feature
- `fix:` bug fix
- `chore:` maintenance, deps, config
- `docs:` documentation only
- `test:` adding or fixing tests
- `refactor:` code restructuring without behavior change
