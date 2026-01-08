# Contributing to Kraken AI Trading Game

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## 🎯 Project Goals

- Build a fun, educational prediction market trading game
- Achieve 60%+ win rate through AI-powered trade selection
- Maintain simple, vanilla JavaScript architecture
- Keep the user experience fast and intuitive

## 🚀 Getting Started

### Prerequisites

- Basic knowledge of HTML, CSS, and JavaScript
- A Groq API key (free at [console.groq.com](https://console.groq.com))
- A web browser and text editor

### Local Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/kraken-ai-trader.git
   cd kraken-ai-trader
   ```

3. Start local server:
   ```bash
   python3 -m http.server 8000
   ```

4. Open `http://localhost:8000/setup.html` in your browser

5. Create a new branch for your feature:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## 📝 How to Contribute

### Reporting Bugs

1. Check if the bug is already reported in [Issues](https://github.com/BTizzy/kraken-ai-trader/issues)
2. If not, create a new issue with:
   - Clear title describing the bug
   - Steps to reproduce
   - Expected vs actual behavior
   - Browser and version
   - Console errors (if any)

### Suggesting Features

1. Open a new issue with the `enhancement` label
2. Describe the feature and why it's valuable
3. Include mockups or examples if applicable
4. Discuss implementation approach

### Pull Requests

1. **Before starting work:**
   - Check existing PRs to avoid duplicates
   - Comment on the issue you want to work on
   - Get consensus on approach for large changes

2. **Code guidelines:**
   - Keep vanilla JavaScript (no frameworks)
   - Follow existing code style
   - Add comments for complex logic
   - Keep functions small and focused
   - Use meaningful variable names

3. **Testing your changes:**
   - Test in Chrome, Firefox, and Safari
   - Test on mobile devices
   - Verify all game flows work:
     - Start session
     - Enter/exit trades
     - Session reports
     - Settings changes

4. **Commit messages:**
   ```
   Type: Brief description

   Longer explanation if needed

   Types: feat, fix, docs, style, refactor, test, chore
   ```

   Examples:
   ```
   feat: Add keyboard shortcuts for trade actions
   fix: Prevent negative bankroll when entering trades
   docs: Update README with new API configuration
   ```

5. **Submit PR:**
   - Push to your fork
   - Create PR against `main` branch
   - Fill out PR template
   - Link related issues
   - Request review

## 🏗️ Architecture Overview

### File Structure

```
/
├── index.html          # Main game interface
├── setup.html          # Setup/onboarding page
├── styles.css          # All styles
├── config.js           # Game configuration constants
├── api.js              # API integrations (Kraken, Groq)
├── game.js             # Core game logic
├── README.md           # Project documentation
├── DEPLOYMENT.md       # Deployment guide
└── LICENSE             # MIT license
```

### Key Components

1. **KrakenAPI** (api.js)
   - Fetches markets from CLOB API
   - Calculates volatility
   - Caches responses

2. **GroqAPI** (api.js)
   - Gets AI predictions
   - Handles API key storage
   - Fallback to mock predictions

3. **PriceSimulator** (api.js)
   - Simulates real-time price movement
   - Different volatility levels
   - Random walk with trends

4. **KrakenTradingGame** (game.js)
   - Main game controller
   - Session management
   - Trade execution
   - UI updates

### Data Flow

```
User clicks "Start Session"
    ↓
Fetch markets from Kraken API
    ↓
Get AI predictions for each market
    ↓
Filter markets by AI threshold (≥75%)
    ↓
Display market cards (colored by volatility)
    ↓
User clicks market → Enter trade
    ↓
Start timer & price simulation
    ↓
User clicks "Sell Now" → Exit trade
    ↓
Update P&L and session stats
    ↓
Session ends → Show report
```

## 🎨 Coding Style

### JavaScript

```javascript
// Use camelCase for variables and functions
const marketData = fetchMarkets();
function calculatePnL(trade) { ... }

// Use PascalCase for classes
class KrakenAPI { ... }

// Use UPPERCASE for constants
const API_BASE_URL = 'https://api.example.com';

// Prefer async/await over promises
async function loadData() {
    const data = await fetch(url);
    return data.json();
}

// Add JSDoc comments for functions
/**
 * Calculate profit/loss for a trade
 * @param {Object} trade - Trade object
 * @returns {number} P&L in dollars
 */
function calculatePnL(trade) { ... }
```

### CSS

```css
/* Use BEM-like naming */
.market-card { }
.market-card__title { }
.market-card--active { }

/* Group related styles */
/* Header */
.header { }
.header-stats { }

/* Market Grid */
.market-grid { }
.market-card { }
```

### HTML

```html
<!-- Use semantic HTML -->
<header>
<main>
<section>

<!-- Add ARIA labels for accessibility -->
<button aria-label="Start new session">Start</button>

<!-- Use data attributes for JS hooks -->
<div data-market-id="123">...</div>
```

## 🔄 Development Workflow

### Priority Areas

Check the README's Development Roadmap for current priorities.

Current focus areas:
- [ ] Real WebSocket integration for live prices
- [ ] Better mobile UX
- [ ] More volatility indicators
- [ ] Historical performance charts
- [ ] Wallet connection for real trading

### Testing Checklist

Before submitting PR, verify:

- [ ] Game starts without errors
- [ ] Markets load and display correctly
- [ ] Trades can be entered and exited
- [ ] Timer counts down properly
- [ ] P&L calculates correctly
- [ ] Session report shows accurate stats
- [ ] Settings save and persist
- [ ] Works on mobile devices
- [ ] No console errors
- [ ] Code is commented

## 🐛 Common Issues

### CORS Errors

- Kraken API supports CORS
- Groq API supports CORS
- If testing locally, use a local server (not file://)

### API Rate Limits

- Groq free tier: 30 requests/minute
- Add delays between batch predictions
- Implement exponential backoff for retries

### LocalStorage Not Working

- Check browser privacy settings
- Clear localStorage: `localStorage.clear()`
- Test in incognito mode

## 📚 Resources

- [Kraken CLOB API Docs](https://docs.polymarket.com)
- [Groq API Docs](https://console.groq.com/docs)
- [MDN Web Docs](https://developer.mozilla.org)
- [JavaScript.info](https://javascript.info)

## 🤝 Code of Conduct

- Be respectful and inclusive
- Welcome newcomers
- Provide constructive feedback
- Focus on what's best for the project
- Show empathy and kindness

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## ❓ Questions?

- Open a [GitHub Discussion](https://github.com/BTizzy/kraken-ai-trader/discussions)
- Tag [@BTizzy](https://github.com/BTizzy) in issues
- Check existing docs and issues first

---

**Thank you for contributing! 🎉**
