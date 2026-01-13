#!/usr/bin/env python3
"""
Clean trade_log.json - remove fake trades and keep valid learnings
"""
import json
import shutil
from datetime import datetime

# Load the trade log
trade_log_path = 'bot/build/trade_log.json'

# Make a backup first
backup_path = f'bot/build/trade_log_backup_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json'
shutil.copy(trade_log_path, backup_path)
print(f"✅ Backup saved to: {backup_path}")

with open(trade_log_path, 'r') as f:
    data = json.load(f)

trades = data['trades']
print(f"Original trades: {len(trades)}")

# Filter criteria for valid trades:
# 1. entry != exit (actual trade executed - not just a scan)
# 2. P&L is reasonable (-50 to +50 for $100 positions with 10% max move)
# 3. No duplicate trades (same pair, entry, exit, pnl)

valid_trades = []
seen = set()

for t in trades:
    # Skip fake trades (no price movement)
    if t['entry'] == t['exit']:
        continue
    
    # Skip trades with absurd P&L values (>$50 is unrealistic for $100 position)
    if abs(t['pnl']) > 50:
        continue
    
    # Create a unique key to detect duplicates
    key = (t['pair'], t['entry'], t['exit'], round(t['pnl'], 4))
    if key in seen:
        continue
    seen.add(key)
    
    valid_trades.append(t)

print(f"Valid trades after filtering: {len(valid_trades)}")

# Calculate stats
if valid_trades:
    wins = len([t for t in valid_trades if t['pnl'] > 0])
    total_pnl = sum(t['pnl'] for t in valid_trades)
    print(f"Win rate: {wins}/{len(valid_trades)} = {wins/len(valid_trades)*100:.1f}%")
    print(f"Total P&L: ${total_pnl:.2f}")
    print(f"Avg P&L per trade: ${total_pnl/len(valid_trades):.2f}")
    
    # Exit reason breakdown
    reasons = {}
    for t in valid_trades:
        r = t.get('reason', 'unknown')
        reasons[r] = reasons.get(r, 0) + 1
    print(f"Exit reasons: {reasons}")
    
    # Show sample of valid trades
    print("\nSample valid trades:")
    for t in valid_trades[:10]:
        print(f"  {t['pair']}: ${t['entry']:.6f} -> ${t['exit']:.6f}, P&L: ${t['pnl']:.2f}, {t['reason']}")

# Save cleaned data
cleaned_data = {
    "version": "2.0-cleaned",
    "total_trades": len(valid_trades),
    "cleaned_at": datetime.now().isoformat(),
    "original_count": len(trades),
    "removed_fake_trades": len([t for t in trades if t['entry'] == t['exit']]),
    "removed_outliers": len([t for t in trades if t['entry'] != t['exit'] and abs(t['pnl']) > 50]),
    "trades": valid_trades
}

with open(trade_log_path, 'w') as f:
    json.dump(cleaned_data, f, indent=2)

print(f"\n✅ Saved {len(valid_trades)} cleaned trades to trade_log.json")
