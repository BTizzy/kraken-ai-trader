# Polymarket AI Trading Game

## Vision
A real-time prediction market trading game where AI selects high-probability trades and players compete against live market volatility to exit at optimal moments.

**Core Experience:**
- Markets appear as **colored squares** with real-time price updates
- Only trades with **≥75% AI-predicted win rate** are shown
- **Color = volatility level** (Green = stable, Yellow/Red = highly volatile)
- Players decide **when to sell** within 10-30 second windows
- Paper trading environment with session-based strategy refinement

---

## Game Mechanics

### 1. Market Display (Pre-Trade)
**Colored Square Grid UI:**
- Each market = square tile showing:
  - Question text
  - Buy price ($1-$10)
  - Potential win/loss amounts
  - Color indicating volatility level

**Color Coding (Volatility):**
- 🟢 **Green** = Low volatility (stable, easier timing)
- 🟡 **Yellow** = Moderate volatility (faster swings)
- 🔴 **Red** = High volatility (rapid price changes, hardest timing)

**AI Entry Filter:**
- Only show trades where Groq AI predicts:
  - **≥75% win probability** if user exits at optimal time
  - **≥51% win probability** if user times out (auto-sell)
- Buy prices scale with volatility: $1-$10 per trade

### 2. Active Trade (Post-Click)
**Real-Time Price Updates:**
- Square color changes based on **live Polymarket price ticks** (WebSocket/polling)
- Display **live P&L in dollars** (e.g., "+$2.50" or "-$1.20")
- Color intensity shifts with current profitability:
  - Bright green = winning
  - Fading yellow = breaking even
  - Red = losing (capped at buy price)

**Timer Options (2 Difficulty Modes):**
- **Standard Mode**: 20-30 second timer, lower volatility
- **High Volatility Mode**: 10-15 second timer, rapid swings
- **Manual Exit**: Click "Sell Now" anytime before timer expires
- **Auto-Exit**: Sells at current price when timer hits zero

**Loss Protection:**
- **Max loss per trade = buy price** ($1-$10)
- If P&L hits -$X (buy price), auto-exits immediately
- Prevents runaway losses on bad timing

### 3. Paper Trading Loop
**Session Flow:**
1. Start with $1,000 paper money
2. Trade until:
   - **Red Zone** (-10% drawdown = -$100 loss), OR
   - User clicks "End Session"
3. **Game locks** → Session Report displays:
   - Win rate %
   - Total P&L
   - Best/worst trades
   - Avg hold time vs optimal exit time
   - Algorithm performance suggestions
4. User analyzes data and refines strategy
5. Click "Start New Session" to continue

**Success Criteria:**
- Achieve **60%+ win rate** over 50+ trades
- Identify which market types/questions perform best
- Refine AI prompt and volatility model iteratively

---

## Technical Architecture

### Frontend
- **Hosting**: GitHub Pages (static HTML/CSS/JS)
- **UI Framework**: Vanilla JavaScript (no frameworks for MVP speed)
- **Design**: Colored square grid with real-time updates

### Data Sources
- **Market Data**: Polymarket CLOB API (`https://clob.polymarket.com/markets`)
- **Real-Time Prices**: WebSocket or 1-second polling for live ticks
- **AI Predictions**: Groq API (LLaMA 3.1 70B) for probability scoring

### Key APIs
```javascript
// Polymarket CLOB API
GET https://clob.polymarket.com/markets?limit=20

// Groq AI Prediction
POST https://api.groq.com/openai/v1/chat/completions
{
  "model": "llama-3.1-70b-versatile",
  "messages": [{
    "role": "user",
    "content": "What is the probability (0-100) that: [market question]?"
  }]
}
```

### Game Logic
```javascript
// Entry Filter
function shouldShowTrade(market) {
  const aiProb = await getGroqPrediction(market.question);
  const marketProb = market.yesPrice * 100;
  const optimalWinRate = aiProb >= 75;
  const safetyWinRate = aiProb >= 51;
  return optimalWinRate && safetyWinRate;
}

// Volatility Scoring
function getVolatilityColor(market) {
  const priceSwing = market.volatility_24h; // From Polymarket API
  if (priceSwing < 5) return 'green';  // Low volatility
  if (priceSwing < 15) return 'yellow'; // Moderate
  return 'red'; // High volatility
}

// Real-Time P&L
function updateSquareColor(position, currentPrice) {
  const pnl = (currentPrice - position.entryPrice) * position.shares;
  position.element.style.backgroundColor = pnl > 0 ? 'green' : 'red';
  position.element.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
}
```

---

## Development Roadmap

### Phase 1: MVP (Week 1)
- [x] Create GitHub repo
- [ ] Build colored square grid UI
- [ ] Integrate Polymarket CLOB API
- [ ] Add Groq AI prediction filtering (≥75% threshold)
- [ ] Implement static market display (no real-time updates yet)

### Phase 2: Real-Time Trading (Week 2)
- [ ] Add WebSocket/polling for live price ticks
- [ ] Implement timer system (10s, 15s, 20s, 30s options)
- [ ] Build manual "Sell Now" button
- [ ] Add auto-exit on timer expiry
- [ ] Implement loss cap (max loss = buy price)

### Phase 3: Session Management (Week 3)
- [ ] Build session state (start/stop/lock)
- [ ] Create Session Report dashboard:
  - Win rate chart
  - P&L over time
  - Best/worst trades table
  - Timing analysis (hold time vs optimal)
- [ ] Add "Start New Session" flow

### Phase 4: Strategy Refinement (Week 4)
- [ ] Add algorithm tuning UI:
  - Adjust AI threshold (75% → 80%?)
  - Change volatility filters
  - Modify timer durations
- [ ] Implement A/B testing framework
- [ ] Track metrics across 50+ sessions
- [ ] Optimize for 60%+ win rate

### Phase 5: Commercialization Prep (Week 5+)
- [ ] Security audit (rate limiting, API key protection)
- [ ] Add wallet connection (RainbowKit + Wagmi)
- [ ] Implement real USDC trading (Polymarket CLOB orders)
- [ ] Legal review (gambling vs skill-based game classification)
- [ ] Beta testing with 10-20 users

---

## Success Metrics

**MVP Goals:**
- 60%+ win rate on paper trades over 50+ sessions
- <2 second latency on live price updates
- <30 second iteration time on algorithm refinement
- Fun and addictive UX (clear feedback, satisfying exits)

**Commercialization Goals:**
- 100+ daily active users
- $10k+ monthly volume (real money)
- 65%+ user win rate (sustainable edge)
- <1% bug/error rate

---

## Local Development

```bash
# Clone repo
git clone https://github.com/BTizzy/polymarket-ai-trader.git
cd polymarket-ai-trader

# Open index.html in browser (no build step needed)
open index.html

# Or use Python local server
python3 -m http.server 8000
# Visit http://localhost:8000
```

---

## Configuration

**Required API Keys:**
1. **Groq API Key** (free tier): https://console.groq.com
   - Create account
   - Generate API key
   - Paste into game UI (stored in localStorage)

2. **Polymarket CLOB API** (no key required)
   - Public endpoint: `https://clob.polymarket.com/markets`

**Game Settings (Tunable):**
```javascript
const GAME_CONFIG = {
  startingBankroll: 1000,
  redZoneThreshold: -100, // -10%
  aiWinThreshold: 75, // Min AI prediction %
  safetyWinThreshold: 51, // Min win rate on timeout
  buyPriceRange: [1, 10], // $1-$10 per trade
  timerOptions: [10, 15, 20, 30], // seconds
  maxLossPerTrade: 'buyPrice', // Cap losses
  refreshInterval: 1000, // 1 second for live updates
};
```

---

## FAQ

**Q: Is this real money trading?**
A: MVP uses **paper money only** ($1,000 starting balance). Real money integration planned for Phase 5 after achieving 60%+ win rate.

**Q: How does the AI work?**
A: Groq's LLaMA 3.1 70B model analyzes each market question and returns a probability (0-100%). Only trades with ≥75% AI confidence are shown.

**Q: What makes this a "game" vs gambling?**
A: Skill-based timing challenge—players compete against volatility, not house edge. AI ensures positive expected value on all trades.

**Q: Can I lose more than the buy price?**
A: No. Max loss per trade is capped at the buy price ($1-$10). Auto-exits trigger when loss = buy price.

**Q: How do I refine the algorithm?**
A: After each session, review the Session Report and adjust:
- AI confidence threshold (75% → 80%?)
- Volatility filters (skip red squares?)
- Timer durations (longer = easier?)
- Market types (politics vs sports?)

**Q: What's the end goal?**
A: Build a strategy that wins 60%+ of trades over 50+ sessions, then deploy with real money and scale to 100+ users.

---

## License
MIT License - See LICENSE file for details

---

## Kraken Integration (US-ready)

If you want to run the bot against a US-compliant exchange, **Kraken** is the recommended option.

Quick setup:
1. Copy `.env.example` → `.env` and fill in keys (DO NOT commit `.env`).
2. Set `EXCHANGE=kraken` in `.env` or `config.js`.
3. Start a local static server (required for WS from browser):

```bash
python3 -m http.server 8000
# open http://localhost:8000/crypto-trader.html
```

Security notes:
- **Regenerate** API keys immediately if they are ever exposed.
- Store secrets in a secret manager or environment variables (never in repo).
- **Do not** call private trading endpoints directly from browser code; implement a server-side proxy to sign requests.

A minimal Node+Express proxy is included at `server/kraken-proxy.js` (development only). To run it locally:

```bash
# from project root
npm install express node-fetch
KRAKEN_API_KEY=yourkey KRAKEN_API_SECRET=yoursecret node server/kraken-proxy.js
# proxy will listen on http://localhost:3001
```

This proxy exposes:
- GET /public/assetpairs
- GET /public/depth?pair=PAIR
- GET /private/balance  (requires KRAKEN_API_KEY/KRAKEN_API_SECRET)

**Important**: Keep API keys secret and never commit them to git.

---

## Contact
Built by [@BTizzy](https://github.com/BTizzy) | Providence, RI

Questions? Open an issue or DM on GitHub.
