# Test #14 Results Log

## Summary
- Test Number: 14
- Date: 2026-01-08
- Strategy: Data-Driven Mean Reversion v7.0
- Win Rate: 96.0%
- Total Trades: 25
- Wins: 24
- Losses: 1
- Total P&L: +$4.13
- Avg P&L: +$0.17
- Start Balance: $984.32
- End Balance: $988.45
- Net Change: +$4.13

## Strategy Configuration
- Entry: β ≥ 0.10, β ≤ 0.5, oversold < -0.05%, momentum ≥ 0, LONG only
- Exit: 1.0x profit target, 1.0x stop, quick profit after 5s, reversion complete
- Position Sizing: $100 base, $75 for β < 0.20
- Costs: taker 0.035, maker 0.01, slippage 0.02, spread 0.01, round trip ~$0.12

## Performance Breakdown
- LONG: 25 trades, 96.0% WR, +$4.13
- SHORT: 0 trades
- Exit Reasons: profit_target 23, reversion_complete 1, fast_stop 1
- Best Trade: FOGO +$0.91 (profit_target)
- Worst Trade: FOGO -$0.14 (fast_stop)

## All Trades
See scalper-test-14-1767830527414.json for full trade details.

## Strategy Log Row
| 14 | 2026-01-08 | **96%** | **+$4.13** | Data-Driven Mean Reversion | ✅ Good |
