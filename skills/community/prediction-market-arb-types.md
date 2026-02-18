# Prediction Market Arbitrage — 5-Type Taxonomy

> Source: [openclaw/skills — rimelucci/reef-polymarket-arb](https://github.com/openclaw/skills/tree/main/skills/rimelucci/reef-polymarket-arb)
> Relevant to: `lib/signal_detector.js`, `lib/market_matcher.js`

## The 5 Arbitrage Types

### Type 1: Same-Market Mispricing

YES + NO doesn't equal 100% (minus fees) on the **same platform**.

```
Example:
  YES: 45¢, NO: 52¢ → combined: 97¢ (should be ~98¢ after fees)
  If combined < 98¢: Buy both sides → guaranteed profit
  If combined > 100¢: Counterparty loss exists, not exploitable by buying
```

**Detection:** Scan markets where YES + NO != 100% ± 2%
**Min edge:** 1% net

### Type 2: Correlated Market Arbitrage

Markets with logical containment relationships priced inconsistently.

```
Example:
  "Will Biden win?" YES: 30¢
  "Will a Democrat win?" YES: 25¢
  Logic: Biden winning implies Democrat winning → Democrat price MUST be ≥ Biden price
  Arb: Buy "Democrat wins" at 25¢ → must converge to ≥ 30¢
```

**Min edge:** 3% net (harder to verify the correlation holds)

### Type 3: Conditional Probability Arb

Superset/subset relationships across time windows.

```
Example:
  "Will X happen in January?" YES: 20¢
  "Will X happen in Q1?" YES: 15¢
  Logic: Q1 includes January → Q1 price MUST be ≥ January price
```

**Min edge:** 3% net

### Type 4: Time Decay Arb

Contracts approaching resolution where prices haven't adjusted.

```
Example:
  Event happening in 2 hours, strong evidence it WILL happen
  YES still at 85¢ when it should be 95¢+
  Buy YES, hold to resolution
```

**Min edge:** 5% net (timing/certainty risk)

### Type 5: Cross-Platform Arb (PRIMARY STRATEGY FOR THIS BOT)

Same or equivalent events priced differently across platforms.

```
Platforms:
  - Polymarket (high volume, 2% taker)
  - Kalshi (deep book, ~1.2%)
  - Gemini Predictions (thin, 0.01% maker)

Example:
  Poly YES: 52¢, Kalshi YES: 48¢ (same event)
  → Buy Kalshi YES + wait for convergence (or arb NO on Poly)
  → Or: Poly NO ask 47¢ + Kalshi YES ask 48¢ = 95¢ total → 5% gross
```

**Min edge:** 2% net

---

## Edge Thresholds by Type

| Type | Strategy | Min Net Edge | Why Higher? |
|------|----------|-------------|-------------|
| 1 | Same-market misprice | 1% | Near-guaranteed if executable |
| 2 | Correlated markets | 3% | Correlation may break on new info |
| 3 | Conditional probability | 3% | Same logic risk |
| 4 | Time decay | 5% | Timing and certainty risk |
| 5 | Cross-platform | 2% | Execution + platform match risk |

---

## Exit Rules

- Exit if edge compresses below **0.5%** (fees eat the rest)
- Exit immediately if **new information** invalidates the correlation logic
- Always exit before resolution if **certainty is unclear**
- **Never hold through resolution on Type 2/3 arbs** unless the logical relationship is airtight

---

## Position Limits

| Exposure Type | Max |
|---------------|-----|
| Single market | 10% of portfolio |
| Correlated positions | 20% of portfolio |
| Illiquid market | 5% of portfolio |

---

## Self-Improvement Protocol

After every 10 resolved arbs:
1. Calculate realized vs theoretical edge per type
2. Track win rate per arb type
3. Update min edge thresholds if actual performance diverges
4. Remove strategies with persistent negative or zero edge

---

## Applied to This Bot

The bot's `lib/signal_detector.js` currently implements Types 3-5 implicitly:
- **Type 4** (time decay): `time_decay_stop` exit logic, settlement-hour weighting in FairValueEngine
- **Type 5** (cross-platform): `detectCrossPlatformArb()` compares Gemini vs Kalshi implied fair value
- **Type 2** (correlated): Not yet implemented — future opportunity for "bracket series" logic (if BTC > $67k then BTC > $65k must also be YES)

Type 1 (same-market YES+NO < $0.98) is rarely seen on liquid platforms but worth scanning during volatility spikes.
