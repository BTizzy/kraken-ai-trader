#!/usr/bin/env node
/**
 * Train a simple logistic regression direction model from historical trades.
 * Saves model to data/direction_model.json
 */
const fs = require('fs');
const path = require('path');

const TRADE_LOG = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
if (!fs.existsSync(TRADE_LOG)) { console.error('trade_log.json missing'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(TRADE_LOG,'utf8'));
const trades = (data.trades || []).filter(t => t.entry_price && t.exit_price);

function featurize(t) {
    const vol = t.volatility_at_entry || 0.1;
    const vwap = t.vwap || 0;
    const vdev = (vwap && t.entry_price) ? ((t.entry_price - vwap) / vwap * 100.0) : 0;
    return {
        volatility_pct: vol,
        rsi: t.rsi || 50,
        macd_hist: t.macd_histogram || 0,
        bb_pos: t.bb_position || 0.5,
        momentum: t.momentum_score || 0,
        atr_pct: t.atr_pct || 0,
        vwap_dev: vdev,
        volume: t.volume_ratio || 1.0
    };
}

// Build dataset
const X = [];
const Y = [];
for (const t of trades) {
    const f = featurize(t);
    X.push([f.volatility_pct, f.rsi, f.macd_hist, f.bb_pos, f.momentum, f.atr_pct, f.vwap_dev, f.volume]);
    Y.push(t.pnl > 0 ? 1 : 0);
}

function normalize(X) {
    const m = X[0].length;
    const mean = Array(m).fill(0);
    const std = Array(m).fill(0);
    const n = X.length;
    for (let j=0;j<m;j++) {
        let s = 0; for (let i=0;i<n;i++) s += X[i][j]; mean[j]=s/n;
        let ss = 0; for (let i=0;i<n;i++) ss += Math.pow(X[i][j]-mean[j],2); std[j]=Math.sqrt(ss/n)||1;
    }
    const Xn = X.map(row => row.map((v,j)=> (v-mean[j])/std[j]));
    return {Xn, mean, std};
}

function sigmoid(z) { return 1.0 / (1.0 + Math.exp(-z)); }

const {Xn, mean, std} = normalize(X);
const m = Xn[0].length;
let weights = Array(m).fill(0);
let bias = 0;
const lr = 0.01;
for (let epoch=0; epoch<2000; epoch++) {
    let dw = Array(m).fill(0); let db = 0;
    for (let i=0;i<Xn.length;i++) {
        const z = weights.reduce((s,wj,idx)=> s + wj*Xn[i][idx], bias);
        const p = sigmoid(z);
        const e = p - Y[i];
        for (let j=0;j<m;j++) dw[j] += e * Xn[i][j];
        db += e;
    }
    for (let j=0;j<m;j++) weights[j] -= lr * (dw[j]/Xn.length);
    bias -= lr * (db / Xn.length);
}

// Map weights back to feature names
const feat_names = ['volatility_pct','rsi','macd_hist','bb_pos','momentum','atr_pct','vwap_dev','volume'];
const model = { bias: bias, weights: {} };
for (let j=0;j<m;j++) model.weights[feat_names[j]] = weights[j];
fs.writeFileSync(path.join(__dirname,'..','data','direction_model.json'), JSON.stringify(model, null, 2));
console.log('Trained direction model saved to data/direction_model.json');
