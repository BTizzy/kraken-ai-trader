#!/usr/bin/env node
/**
 * Fetch recent public trades from local server proxy (/api/trades/:pair) and save to data/market_data.json
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const pairsFile = path.join(__dirname, '..', 'kraken-data', 'usd_pairs_top_filtered.json');
const OUT = path.join(__dirname, '..', 'data', 'market_data.json');

const pairs = JSON.parse(fs.readFileSync(pairsFile,'utf8')).slice(0,10).map(p => p.altname || p.pair);

function fetchPair(pair) {
    return new Promise((resolve) => {
        const opts = { hostname: 'localhost', port: 3002, path: `/api/trades/${pair}?limit=200`, method: 'GET' };
        http.get(opts, (res) => {
            let data=''; res.on('data', c=>data+=c); res.on('end', ()=>{
                try {
                    const json = JSON.parse(data);
                    // json.trades expected to be array of {price, volume, time}
                    const trades = json.trades || [];
                    if (!trades.length) return resolve(null);
                    const last_price = trades[0].price || trades[trades.length-1].price;
                    let vwap_num=0, vwap_den=0, vol_sum=0;
                    const prices = [];
                    for (const t of trades) {
                        const p = parseFloat(t.price); const v = Math.abs(parseFloat(t.volume)||0);
                        vwap_num += p * v; vwap_den += v; vol_sum += v; prices.push(p);
                    }
                    const vwap = vwap_den ? (vwap_num / vwap_den) : last_price;
                    // compute simple volatility (std of returns)
                    const returns = [];
                    for (let i=1;i<prices.length;i++) returns.push(Math.abs((prices[i]-prices[i-1])/prices[i-1]));
                    const mean = returns.reduce((a,b)=>a+b,0)/Math.max(1,returns.length);
                    const varr = returns.reduce((a,b)=>a+Math.pow(b-mean,2),0)/Math.max(1,returns.length);
                    const vol_pct = Math.sqrt(varr) * 100.0;
                    resolve({ pair, last_price, volume: vol_sum, vwap, timestamp: Date.now(), volatility_pct: vol_pct });
                } catch (e) { resolve(null); }
            });
        }).on('error', (e)=> resolve(null));
    });
}

(async () => {
    const out = [];
    for (const p of pairs) {
        const r = await fetchPair(p);
        if (r) out.push(r);
    }
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), data: out }, null, 2));
    console.log('Fetched market data for', out.length, 'pairs ->', OUT);
})();
