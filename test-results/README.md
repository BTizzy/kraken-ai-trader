# Test Results Archive

This folder stores JSON exports from scalper test runs.

## File Naming Convention

Files are named: `scalper-test-{testNumber}-{timestamp}.json`

Example: `scalper-test-9-1767824500000.json` = Test #9, run at that Unix timestamp

## JSON Structure

Each test export contains:

```json
{
  "testNumber": 9,
  "timestamp": "2026-01-07T12:30:00.000Z",
  
  "strategyConfig": {
    "name": "Simple Mean Reversion",
    "version": "3.0",
    "entry": {
      "betaThreshold": 0.05,
      "requireOversold": true,
      "oversoldThreshold": -0.05,
      "momentumMin": 0,
      "directionAllowed": "LONG_ONLY"
    },
    "exit": {
      "profitTargetMultiple": 1.0,
      "stopLossMultiple": 1.0,
      "quickProfitThreshold": 0.2,
      "bigProfitThreshold": 3.0,
      "maxHoldTime": 120000
    },
    "position": {
      "baseSize": 100,
      "scalingEnabled": false
    },
    "costs": {
      "takerFee": 0.035,
      "makerFee": 0.01,
      "slippage": 0.02,
      "spread": 0.01,
      "estimatedRoundTrip": "$0.12"
    }
  },
  
  "summary": {
    "totalTrades": 25,
    "winRate": "68.0%",
    "wins": 17,
    "losses": 8,
    "totalPnL": "$2.14",
    "avgPnL": "$0.09"
  },
  
  "exitReasons": {
    "profit_target": 12,
    "quick_profit": 5,
    "stop_loss": 6,
    "fast_stop": 2
  },
  
  "allTrades": [/* detailed trade data */],
  
  "strategyLogRow": "| 9 | 2026-01-07 | **68%** | **+$2.14** | Simple Mean Reversion | ✅ Good |"
}
```

## How to Use

1. **After each test run**: JSON file is auto-downloaded to your browser
2. **Move to this folder**: Copy from Downloads to this folder for version control
3. **Update STRATEGY_LOG.md**: Copy the `strategyLogRow` value and paste into the log
4. **Commit both**: `git add test-results/ STRATEGY_LOG.md && git commit -m "Test #X results"`

## Analysis Tips

- Compare `strategyConfig` between tests to see what changed
- Look at `exitReasons` to understand why trades ended
- Check `allTrades` for patterns in winning vs losing trades
- The `pnlMultiple` shows profit as multiple of trading costs (>1.0 = profitable)
