#!/usr/bin/env node
/**
 * Train Opportunity Model
 * 
 * Builds a logistic regression model from closed paper trades to learn
 * which signal features predict profitable trades. Exports model weights
 * for use by the signal detector.
 * 
 * Usage:
 *   node scripts/train_opportunity_model.js [--min-trades 50]
 */

'use strict';

const path = require('path');
const fs = require('fs');
const PredictionDatabase = require('../lib/prediction_db');
const { Logger } = require('../lib/logger');

const log = new Logger('ML-TRAIN');

const args = process.argv.slice(2);
const minIdx = args.indexOf('--min-trades');
const MIN_TRADES = minIdx !== -1 && args[minIdx + 1] ? parseInt(args[minIdx + 1], 10) : 50;

const DB_PATH = path.join(__dirname, '..', 'data', 'prediction_markets.db');
const MODEL_PATH = path.join(__dirname, '..', 'config', 'opportunity_model.json');

let db;
try {
  db = new PredictionDatabase(DB_PATH);
} catch (e) {
  console.error('Cannot open database:', e.message);
  process.exit(1);
}

// --- Sigmoid ---
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// --- Feature extraction ---
function extractFeatures(trade) {
  return [
    trade.signal_score / 100 || 0,       // Normalized score
    trade.entry_price || 0.5,             // Entry price
    Math.abs(0.5 - (trade.entry_price || 0.5)) * 2, // Distance from 50/50
    trade.amount / 500 || 0,              // Position size relative to initial capital
    trade.direction === 'YES' ? 1 : 0,    // Direction encoding
  ];
}

// --- Logistic Regression ---
class LogisticRegression {
  constructor(numFeatures) {
    this.weights = new Array(numFeatures).fill(0).map(() => (Math.random() - 0.5) * 0.1);
    this.bias = 0;
    this.learningRate = 0.01;
  }

  predict(features) {
    let z = this.bias;
    for (let i = 0; i < features.length; i++) {
      z += this.weights[i] * features[i];
    }
    return sigmoid(z);
  }

  train(X, y, epochs = 1000) {
    const m = X.length;
    const losses = [];

    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalLoss = 0;

      for (let i = 0; i < m; i++) {
        const pred = this.predict(X[i]);
        const error = pred - y[i];

        // Update weights
        for (let j = 0; j < this.weights.length; j++) {
          this.weights[j] -= this.learningRate * error * X[i][j];
        }
        this.bias -= this.learningRate * error;

        // Binary cross-entropy loss
        const loss = -(y[i] * Math.log(pred + 1e-10) + (1 - y[i]) * Math.log(1 - pred + 1e-10));
        totalLoss += loss;
      }

      if (epoch % 100 === 0) {
        losses.push(totalLoss / m);
      }
    }

    return losses;
  }

  evaluate(X, y) {
    let correct = 0;
    let tp = 0, fp = 0, fn = 0, tn = 0;

    for (let i = 0; i < X.length; i++) {
      const pred = this.predict(X[i]) >= 0.5 ? 1 : 0;
      if (pred === y[i]) correct++;
      if (pred === 1 && y[i] === 1) tp++;
      if (pred === 1 && y[i] === 0) fp++;
      if (pred === 0 && y[i] === 1) fn++;
      if (pred === 0 && y[i] === 0) tn++;
    }

    const accuracy = correct / X.length;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

    return { accuracy, precision, recall, f1, tp, fp, fn, tn };
  }

  toJSON() {
    return {
      weights: this.weights,
      bias: this.bias,
      feature_names: [
        'signal_score_norm',
        'entry_price',
        'price_distance_from_50',
        'position_size_norm',
        'direction_yes'
      ]
    };
  }
}

// --- Main ---
function run() {
  log.info('=== Training Opportunity Model ===');

  // Fetch closed trades
  const trades = db.db.prepare(`
    SELECT * FROM prediction_trades
    WHERE status = 'closed'
    ORDER BY exit_time ASC
  `).all();

  log.info(`Found ${trades.length} closed trades`);

  if (trades.length < MIN_TRADES) {
    log.warn(`Need at least ${MIN_TRADES} trades to train. Currently have ${trades.length}.`);
    log.info('Run the bot longer to collect more trade data.');
    db.close();
    process.exit(0);
  }

  // Prepare training data
  const X = [];
  const y = [];

  for (const trade of trades) {
    const features = extractFeatures(trade);
    const label = trade.pnl > 0 ? 1 : 0; // Win = 1, Loss = 0
    X.push(features);
    y.push(label);
  }

  // Split 80/20 train/test
  const splitIdx = Math.floor(X.length * 0.8);
  const X_train = X.slice(0, splitIdx);
  const y_train = y.slice(0, splitIdx);
  const X_test = X.slice(splitIdx);
  const y_test = y.slice(splitIdx);

  log.info(`Training set: ${X_train.length} | Test set: ${X_test.length}`);

  // Class distribution
  const posCount = y.filter(v => v === 1).length;
  const negCount = y.filter(v => v === 0).length;
  log.info(`Class distribution: ${posCount} wins (${((posCount / y.length) * 100).toFixed(1)}%), ${negCount} losses`);

  // Train model
  const model = new LogisticRegression(X[0].length);
  const losses = model.train(X_train, y_train, 2000);

  log.info(`Training complete. Final loss: ${losses[losses.length - 1].toFixed(4)}`);

  // Evaluate
  const trainMetrics = model.evaluate(X_train, y_train);
  const testMetrics = model.evaluate(X_test, y_test);

  console.log('\n' + '='.repeat(50));
  console.log('  MODEL EVALUATION');
  console.log('='.repeat(50));

  console.log('\n  Training Set:');
  console.log(`    Accuracy:  ${(trainMetrics.accuracy * 100).toFixed(1)}%`);
  console.log(`    Precision: ${(trainMetrics.precision * 100).toFixed(1)}%`);
  console.log(`    Recall:    ${(trainMetrics.recall * 100).toFixed(1)}%`);
  console.log(`    F1-Score:  ${(trainMetrics.f1 * 100).toFixed(1)}%`);

  console.log('\n  Test Set:');
  console.log(`    Accuracy:  ${(testMetrics.accuracy * 100).toFixed(1)}%`);
  console.log(`    Precision: ${(testMetrics.precision * 100).toFixed(1)}%`);
  console.log(`    Recall:    ${(testMetrics.recall * 100).toFixed(1)}%`);
  console.log(`    F1-Score:  ${(testMetrics.f1 * 100).toFixed(1)}%`);
  console.log(`    Confusion: TP=${testMetrics.tp} FP=${testMetrics.fp} FN=${testMetrics.fn} TN=${testMetrics.tn}`);

  // Feature importance (by weight magnitude)
  const featureImportance = model.toJSON();
  console.log('\n  Feature Weights:');
  for (let i = 0; i < featureImportance.weights.length; i++) {
    const bar = '█'.repeat(Math.min(20, Math.abs(Math.round(featureImportance.weights[i] * 10))));
    const sign = featureImportance.weights[i] >= 0 ? '+' : '-';
    console.log(`    ${featureImportance.feature_names[i].padEnd(25)} ${sign}${Math.abs(featureImportance.weights[i]).toFixed(4)} ${bar}`);
  }
  console.log(`    ${'bias'.padEnd(25)} ${model.bias.toFixed(4)}`);

  // Save model
  const modelData = {
    ...model.toJSON(),
    metadata: {
      trained_at: new Date().toISOString(),
      total_trades: trades.length,
      train_size: X_train.length,
      test_size: X_test.length,
      test_accuracy: testMetrics.accuracy,
      test_f1: testMetrics.f1,
      training_losses: losses
    }
  };

  fs.writeFileSync(MODEL_PATH, JSON.stringify(modelData, null, 2));
  log.info(`Model saved to ${MODEL_PATH}`);

  console.log('\n' + '='.repeat(50));

  db.close();
}

run();
