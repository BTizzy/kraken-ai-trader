/**
 * Cross-Platform Market Matcher
 * Matches equivalent prediction markets across Polymarket, Kalshi, and Gemini
 * 
 * Matching Strategy:
 *   1. Manual overrides from JSON config (highest confidence)
 *   2. Fuzzy title matching using Levenshtein distance
 *   3. Outcome standardization (Yes/No mapping)
 *   4. Resolution date matching (±1 day tolerance)
 */

const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');

const MANUAL_MATCHES_PATH = path.join(__dirname, '../data/matched_markets.json');

class MarketMatcher {
    constructor(db, options = {}) {
        this.db = db;
        this.logger = new Logger({ component: 'MATCHER', level: options.logLevel || 'INFO' });
        this.minMatchConfidence = options.minMatchConfidence || 0.5;
        this.manualMatches = this.loadManualMatches();
        
        // In-memory index for fast lookups
        this.polymarketIndex = new Map(); // normalized_title -> market
        this.kalshiIndex = new Map();
        this.geminiIndex = new Map();
    }

    /**
     * Load manual market match overrides from JSON config
     */
    loadManualMatches() {
        try {
            if (fs.existsSync(MANUAL_MATCHES_PATH)) {
                const data = JSON.parse(fs.readFileSync(MANUAL_MATCHES_PATH, 'utf8'));
                this.logger.info(`Loaded ${data.length || 0} manual market matches`);
                return data || [];
            }
        } catch (error) {
            this.logger.warn('Failed to load manual matches: ' + error.message);
        }
        return [];
    }

    /**
     * Save manual matches to JSON
     */
    saveManualMatches() {
        try {
            const dir = path.dirname(MANUAL_MATCHES_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(MANUAL_MATCHES_PATH, JSON.stringify(this.manualMatches, null, 2));
        } catch (error) {
            this.logger.error('Failed to save manual matches: ' + error.message);
        }
    }

    /**
     * Normalize text for matching
     */
    normalizeTitle(title) {
        return (title || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Calculate Levenshtein distance between two strings
     */
    levenshteinDistance(a, b) {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;

        const matrix = [];
        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }
        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + cost
                );
            }
        }

        return matrix[b.length][a.length];
    }

    /**
     * Calculate similarity score between two titles (0 to 1)
     * Optimized: uses Jaccard first as a cheap filter, only runs
     * Levenshtein on promising candidates.
     */
    titleSimilarity(titleA, titleB) {
        const a = this.normalizeTitle(titleA);
        const b = this.normalizeTitle(titleB);

        if (a === b) return 1.0;
        if (a.length === 0 || b.length === 0) return 0.0;

        // Method 1 (cheap): Word overlap (Jaccard similarity)
        const wordsA = new Set(a.split(' ').filter(w => w.length > 2));
        const wordsB = new Set(b.split(' ').filter(w => w.length > 2));
        const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
        const union = new Set([...wordsA, ...wordsB]);
        const jaccardSim = union.size > 0 ? intersection.size / union.size : 0;

        // Fast exit: if word overlap is very low, skip expensive Levenshtein
        if (jaccardSim < 0.15) return jaccardSim * 0.5;

        // Method 2: Key entity extraction (numbers)
        const numbersA = (a.match(/\d+/g) || []).join(',');
        const numbersB = (b.match(/\d+/g) || []).join(',');
        const numberMatch = numbersA === numbersB && numbersA.length > 0 ? 0.2 : 0;

        // Method 3 (expensive): Levenshtein similarity — only for promising candidates
        const maxLen = Math.max(a.length, b.length);
        const distance = this.levenshteinDistance(a, b);
        const levenshteinSim = 1 - distance / maxLen;

        // Combine scores
        return Math.min(1.0, levenshteinSim * 0.3 + jaccardSim * 0.5 + numberMatch);
    }

    /**
     * Check if resolution dates match (±1 day tolerance)
     */
    datesMatch(dateA, dateB) {
        if (!dateA || !dateB) return true; // If either missing, don't penalize

        try {
            const a = new Date(dateA).getTime();
            const b = new Date(dateB).getTime();
            const dayMs = 86400000;
            return Math.abs(a - b) <= dayMs;
        } catch (e) {
            return true; // Parse error = don't penalize
        }
    }

    /**
     * Check if categories match
     */
    categoriesMatch(catA, catB) {
        if (!catA || !catB || catA === 'other' || catB === 'other') return true;
        if (catA === catB) return true;

        // Cross-platform synonyms (Gemini 'elections' ↔ Kalshi 'politics', etc.)
        const synonyms = {
            elections: 'politics',
            politics: 'politics',
            finance: 'economics',
            economics: 'economics',
        };
        return (synonyms[catA] || catA) === (synonyms[catB] || catB);
    }

    /**
     * Build search index from a list of normalized markets
     */
    buildIndex(markets, platform) {
        const index = new Map();
        for (const market of markets) {
            const key = this.normalizeTitle(market.title);
            if (!index.has(key)) {
                index.set(key, []);
            }
            index.get(key).push(market);
        }

        switch (platform) {
            case 'polymarket': this.polymarketIndex = index; break;
            case 'kalshi': this.kalshiIndex = index; break;
            case 'gemini': this.geminiIndex = index; break;
        }

        this.logger.debug(`Built ${platform} index with ${index.size} unique titles from ${markets.length} markets`);
    }

    /**
     * Find best match for a market across another platform's markets
     */
    findBestMatch(targetMarket, candidateMarkets) {
        let bestMatch = null;
        let bestScore = 0;

        for (const candidate of candidateMarkets) {
            // Title similarity
            let score = this.titleSimilarity(targetMarket.title, candidate.title);

            // Bonus for matching category
            if (this.categoriesMatch(targetMarket.category, candidate.category)) {
                score += 0.05;
            } else {
                score -= 0.1;
            }

            // Bonus for matching resolution date
            if (this.datesMatch(targetMarket.resolution_date, candidate.resolution_date)) {
                score += 0.05;
            } else {
                score -= 0.15;
            }

            // Cap at 1.0
            score = Math.min(1.0, Math.max(0, score));

            if (score > bestScore) {
                bestScore = score;
                bestMatch = { market: candidate, confidence: score };
            }
        }

        return bestMatch;
    }

    /**
     * Match all markets across platforms
     * Input: arrays of normalized markets from each platform
     * Output: array of matched market groups
     */
    matchMarkets(polymarkets, kalshiMarkets, geminiMarkets) {
        this.buildIndex(polymarkets, 'polymarket');
        this.buildIndex(kalshiMarkets, 'kalshi');
        this.buildIndex(geminiMarkets, 'gemini');

        const matches = [];
        const usedPolyIds = new Set();
        const usedKalshiIds = new Set();

        // Step 1: Apply manual overrides first
        for (const manual of this.manualMatches) {
            const match = {
                gemini_market_id: manual.gemini_market_id,
                polymarket_market_id: manual.polymarket_market_id || null,
                kalshi_market_id: manual.kalshi_market_id || null,
                event_title: manual.title || manual.event_title,
                resolution_date: manual.resolution_date || null,
                category: manual.category || 'other',
                match_confidence: 1.0,
                manual_override: true
            };

            matches.push(match);
            if (match.polymarket_market_id) usedPolyIds.add(match.polymarket_market_id);
            if (match.kalshi_market_id) usedKalshiIds.add(match.kalshi_market_id);
        }

        // Step 2: For each Gemini market, find best match on Polymarket and Kalshi
        for (const geminiMarket of geminiMarkets) {
            // Skip if already matched manually
            if (matches.find(m => m.gemini_market_id === geminiMarket.market_id)) continue;

            // Find Polymarket match
            const availablePoly = polymarkets.filter(m => !usedPolyIds.has(m.market_id));
            const polyMatch = this.findBestMatch(geminiMarket, availablePoly);

            // Find Kalshi match
            const availableKalshi = kalshiMarkets.filter(m => !usedKalshiIds.has(m.market_id));
            const kalshiMatch = this.findBestMatch(geminiMarket, availableKalshi);

            // Determine overall confidence
            const polyConf = polyMatch ? polyMatch.confidence : 0;
            const kalshiConf = kalshiMatch ? kalshiMatch.confidence : 0;
            const overallConfidence = Math.max(polyConf, kalshiConf);

            if (overallConfidence >= this.minMatchConfidence) {
                const match = {
                    gemini_market_id: geminiMarket.market_id,
                    polymarket_market_id: polyMatch && polyConf >= this.minMatchConfidence 
                        ? polyMatch.market.market_id : null,
                    polymarket_yes_token_id: polyMatch && polyConf >= this.minMatchConfidence 
                        ? polyMatch.market.yes_token_id : null,
                    polymarket_no_token_id: polyMatch && polyConf >= this.minMatchConfidence 
                        ? polyMatch.market.no_token_id : null,
                    kalshi_market_id: kalshiMatch && kalshiConf >= this.minMatchConfidence 
                        ? kalshiMatch.market.market_id : null,
                    event_title: geminiMarket.title,
                    resolution_date: geminiMarket.resolution_date,
                    category: geminiMarket.category,
                    match_confidence: overallConfidence,
                    manual_override: false,
                    polymarket_confidence: polyConf,
                    kalshi_confidence: kalshiConf
                };

                matches.push(match);

                if (match.polymarket_market_id) usedPolyIds.add(match.polymarket_market_id);
                if (match.kalshi_market_id) usedKalshiIds.add(match.kalshi_market_id);
            }
        }

        // Step 3: Cross-platform Poly↔Kalshi matching skipped at runtime
        // (too expensive for O(n²) with 1000+ markets per platform).
        // Run scripts/cross_match_analysis.js offline for this analysis.

        this.logger.info(`Matched ${matches.length} markets (${this.manualMatches.length} manual, ${matches.length - this.manualMatches.length} auto)`);
        return matches;
    }

    /**
     * Save all matches to database
     * Always ensures the parent markets row exists first (FK dependency).
     */
    saveMatchesToDB(matches) {
        let saved = 0;
        for (const match of matches) {
            try {
                // Guarantee the parent markets row exists before inserting matched_markets.
                // This prevents FK constraint failures for manual overrides and auto-matched
                // markets whose gemini_market_id was not already upserted.
                this.db.upsertMarket({
                    gemini_market_id: match.gemini_market_id,
                    title: match.event_title || match.gemini_market_id,
                    category: match.category || 'other',
                    resolution_date: match.resolution_date || null,
                    polymarket_market_id: match.polymarket_market_id || null,
                    kalshi_market_id: match.kalshi_market_id || null
                });
            } catch (marketErr) {
                this.logger.warn(`Could not ensure market row for ${match.gemini_market_id}: ${marketErr.message}`);
            }

            try {
                this.db.upsertMatchedMarket(match);
                saved++;
            } catch (error) {
                this.logger.warn(`Failed to save match for ${match.gemini_market_id}: ${error.message}`);
            }
        }
        this.logger.info(`Saved ${saved}/${matches.length} matches to database`);
        return saved;
    }

    /**
     * Add a manual market match
     */
    addManualMatch(match) {
        // Remove any existing match for this Gemini market
        this.manualMatches = this.manualMatches.filter(
            m => m.gemini_market_id !== match.gemini_market_id
        );
        this.manualMatches.push(match);
        this.saveManualMatches();
        this.logger.info(`Added manual match: ${match.gemini_market_id} → "${match.title || match.event_title}"`);
    }

    /**
     * Get all matched markets from DB with minimum confidence
     */
    getMatchedMarkets(minConfidence = 0.5) {
        return this.db.getMatchedMarkets(minConfidence);
    }

    /**
     * Full match cycle: fetch from all platforms, match, and save
     */
    async runMatchCycle(polyClient, kalshiClient, geminiClient) {
        this.logger.info('Starting market match cycle...');

        try {
            // Fetch markets from all platforms
            const [polyMarkets, kalshiMarkets, geminiMarkets] = await Promise.all([
                polyClient.fetchAllActiveMarkets().catch(e => {
                    this.logger.error('Polymarket fetch failed: ' + e.message);
                    return [];
                }),
                kalshiClient.fetchAllActiveMarkets().catch(e => {
                    this.logger.error('Kalshi fetch failed: ' + e.message);
                    return [];
                }),
                geminiClient.fetchAllActiveMarkets().catch(e => {
                    this.logger.error('Gemini fetch failed: ' + e.message);
                    return [];
                })
            ]);

            this.logger.info(`Fetched: Poly=${polyMarkets.length}, Kalshi=${kalshiMarkets.length}, Gemini=${geminiMarkets.length}`);

            // If Gemini has no markets yet, create simulated markets from Poly/Kalshi overlap
            let effectiveGemini = geminiMarkets;
            if (geminiMarkets.length === 0 && polyMarkets.length > 0) {
                this.logger.info('No Gemini markets found - creating simulated markets from Polymarket for paper trading');
                effectiveGemini = this.createSimulatedGeminiMarkets(polyMarkets, kalshiMarkets, geminiClient);
            }

            // Run matching (title-based for non-crypto)
            const matches = this.matchMarkets(polyMarkets, kalshiMarkets, effectiveGemini);

            // Step 3: Match real GEMI-* crypto contracts to Kalshi brackets (structural)
            const cryptoMatches = await this.matchCryptoContracts(effectiveGemini, kalshiClient);
            for (const cm of cryptoMatches) {
                // Avoid duplicates — only add if not already matched
                if (!matches.find(m => m.gemini_market_id === cm.gemini_market_id)) {
                    matches.push(cm);
                }
            }

            // Save individual markets to markets table FIRST (FK dependency)
            for (const market of effectiveGemini) {
                try {
                    this.db.upsertMarket({
                        gemini_market_id: market.market_id,
                        title: market.title,
                        category: market.category,
                        resolution_date: market.resolution_date,
                        polymarket_market_id: matches.find(m => m.gemini_market_id === market.market_id)?.polymarket_market_id,
                        kalshi_market_id: matches.find(m => m.gemini_market_id === market.market_id)?.kalshi_market_id
                    });
                } catch (e) { /* ignore duplicates */ }
            }

            // Ensure manual override gemini_market_ids exist in markets table (FK dependency)
            for (const match of matches) {
                if (match.manual_override) {
                    try {
                        this.db.upsertMarket({
                            gemini_market_id: match.gemini_market_id,
                            title: match.event_title || match.gemini_market_id,
                            category: match.category || 'manual',
                            resolution_date: match.resolution_date || null,
                            polymarket_market_id: match.polymarket_market_id,
                            kalshi_market_id: match.kalshi_market_id
                        });
                    } catch (e) { /* ignore duplicates */ }
                }
            }

            // Deactivate stale matches before inserting fresh ones
            this.db.deactivateAllMatches();

            // Now save matched markets (FK references markets table)
            this.saveMatchesToDB(matches);

            return {
                polymarket_count: polyMarkets.length,
                kalshi_count: kalshiMarkets.length,
                gemini_count: effectiveGemini.length,
                matched_count: matches.length,
                matches
            };
        } catch (error) {
            this.logger.error('Match cycle failed: ' + error.message);
            return { polymarket_count: 0, kalshi_count: 0, gemini_count: 0, matched_count: 0, matches: [] };
        }
    }

    /**
     * Match real GEMI-* crypto contracts to Kalshi brackets by asset + strike price.
     *
     * Gemini contracts: GEMI-BTC2602190200-HI66500  →  "BTC > $66,500"
     * Kalshi brackets:  KXBTC-26FEB1921 series      →  P(BTC > $66,500) via synthetic sum
     *
     * Returns array of match objects compatible with saveMatchesToDB().
     */
    async matchCryptoContracts(geminiMarkets, kalshiClient) {
        const cryptoMatches = [];
        // Only process real GEMI-* contracts (crypto category)
        const gemiContracts = geminiMarkets.filter(m =>
            m.market_id && m.market_id.startsWith('GEMI-') && m.category === 'crypto'
        );
        if (gemiContracts.length === 0) return cryptoMatches;

        // Parse asset from instrument symbol: GEMI-BTC2602190200-HI66500 → BTC
        const assetMap = new Map(); // asset → [contracts]
        for (const c of gemiContracts) {
            const assetMatch = c.market_id.match(/^GEMI-([A-Z]+)/);
            if (!assetMatch) continue;
            const asset = assetMatch[1];
            if (!assetMap.has(asset)) assetMap.set(asset, []);
            assetMap.get(asset).push(c);
        }

        // For each asset with Kalshi series, fetch brackets and match
        const KalshiClient = require('./kalshi_client');
        const supportedAssets = Object.keys(KalshiClient.SERIES_TICKERS); // BTC, ETH, SOL

        for (const asset of supportedAssets) {
            const contracts = assetMap.get(asset);
            if (!contracts || contracts.length === 0) continue;

            try {
                const bracketEvents = await kalshiClient.getBracketsByEvent(asset);
                if (Object.keys(bracketEvents).length === 0) continue;

                // For each Kalshi event, compute synthetic "above" probabilities
                // Parse Kalshi event dates for date matching against Gemini contracts
                const kalshiEventDates = {};
                const MONTH_MAP = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
                for (const [eventTicker, eventData] of Object.entries(bracketEvents)) {
                    // KXBTC-26FEB1916 → year=2026, month=Feb, day=19, hour=16
                    const kalshiMatch = eventTicker.match(/(\d{2})([A-Z]{3})(\d{2})(\d{2})$/);
                    if (kalshiMatch) {
                        const [, yy, mon, dd, hh] = kalshiMatch;
                        const monthIdx = MONTH_MAP[mon];
                        if (monthIdx !== undefined) {
                            kalshiEventDates[eventTicker] = new Date(Date.UTC(2000 + parseInt(yy), monthIdx, parseInt(dd), parseInt(hh)));
                        }
                    }
                }

                for (const [eventTicker, eventData] of Object.entries(bracketEvents)) {
                    const aboveProbs = kalshiClient.computeSyntheticAbove(eventData.brackets);
                    if (Object.keys(aboveProbs).length === 0) continue;

                    // Match each Gemini contract strike to nearest Kalshi strike
                    for (const contract of contracts) {
                        const strikeMatch = contract.market_id.match(/HI(\d+D?\d*)$/);
                        if (!strikeMatch) continue;
                        // Handle decimal strikes: HI1D3 → 1.3, HI66500 → 66500
                        const strikeStr = strikeMatch[1].replace('D', '.');
                        const strike = parseFloat(strikeStr);
                        if (isNaN(strike)) continue;

                        // Date matching: parse Gemini settlement date from market_id
                        // GEMI-BTC2602240800-HI67500 → year=2026, month=02, day=24, hour=08
                        let dateConfidence = 0.9; // default
                        const geminiDateMatch = contract.market_id.match(/^GEMI-[A-Z]+(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
                        const kalshiDate = kalshiEventDates[eventTicker];
                        if (geminiDateMatch && kalshiDate) {
                            const [, gyy, gmm, gdd, ghh, gmn] = geminiDateMatch;
                            const geminiDate = new Date(Date.UTC(2000 + parseInt(gyy), parseInt(gmm) - 1, parseInt(gdd), parseInt(ghh), parseInt(gmn)));
                            const dateDiffHours = Math.abs(geminiDate.getTime() - kalshiDate.getTime()) / (1000 * 60 * 60);

                            if (dateDiffHours > 48) {
                                // Skip — this Kalshi event is way too far from the Gemini settlement
                                continue;
                            } else if (dateDiffHours > 12) {
                                dateConfidence = 0.5; // Same general period but different day
                            } else if (dateDiffHours <= 12) {
                                dateConfidence = 0.95; // Same day, close settlement times
                            }
                        }

                        const syntheticMatch = kalshiClient.findSyntheticPrice(aboveProbs, strike);
                        if (!syntheticMatch) continue;

                        cryptoMatches.push({
                            gemini_market_id: contract.market_id,
                            polymarket_market_id: null,
                            kalshi_market_id: eventTicker, // KXBTC-26FEB1921
                            event_title: contract.title,
                            resolution_date: contract.resolution_date,
                            category: 'crypto',
                            match_confidence: dateConfidence,
                            manual_override: false,
                            crypto_match: true,
                            kalshi_strike: syntheticMatch.kalshiStrike,
                            gemini_strike: strike,
                            // Clamp to [0, 1] — bracket sums can exceed 1.0 with thin liquidity
                            kalshi_synthetic_mid: Math.min(1, Math.max(0, syntheticMatch.fairValueMid)),
                            kalshi_synthetic_bid: Math.min(1, Math.max(0, syntheticMatch.fairValueBid)),
                            kalshi_synthetic_ask: Math.min(1, Math.max(0, syntheticMatch.fairValueAsk)),
                            kalshi_settlement_hour: eventData.settlementHour
                        });
                    }
                }
            } catch (e) {
                this.logger.warn(`Kalshi bracket fetch failed for ${asset}: ${e.message}`);
            }
        }

        // Deduplicate: if a Gemini contract matched multiple Kalshi events, keep the highest confidence
        const bestByGemini = new Map();
        for (const match of cryptoMatches) {
            const existing = bestByGemini.get(match.gemini_market_id);
            if (!existing || match.match_confidence > existing.match_confidence) {
                bestByGemini.set(match.gemini_market_id, match);
            }
        }
        const dedupedMatches = [...bestByGemini.values()];

        if (dedupedMatches.length > 0) {
            this.logger.info(`Crypto structural match: ${dedupedMatches.length} GEMI-* ↔ Kalshi pairs (${cryptoMatches.length - dedupedMatches.length} date-filtered)`);
        }
        return dedupedMatches;
    }

    /**
     * Create simulated Gemini markets from Polymarket/Kalshi
     * Used when Gemini API is not available (paper trading mode)
     */
    createSimulatedGeminiMarkets(polyMarkets, kalshiMarkets, geminiClient) {
        const simulated = [];

        // Take top 30 Polymarket markets by liquidity, filtered for tradeable probabilities
        const topPoly = [...polyMarkets]
            .filter(m => {
                // Only include markets with tradeable probability and real liquidity
                const price = m.last_price_yes || 0.5;
                const liquidity = m.liquidity || 0;
                return price >= 0.10 && price <= 0.90 && liquidity >= 1000;
            })
            .sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0))
            .slice(0, 30);

        for (const poly of topPoly) {
            const geminiId = `gemini_sim_${poly.market_id.substring(0, 16)}`;
            const refPrice = poly.last_price_yes || 0.5;

            // Create simulated market in Gemini client
            geminiClient.updatePaperMarket(geminiId, refPrice, {
                title: poly.title,
                volume: Math.min(20000, Math.floor((poly.volume || 10000) * 0.001)), // Gemini has ~0.1% of Polymarket volume, capped low
            });

            simulated.push({
                platform: 'gemini',
                market_id: geminiId,
                title: poly.title,
                category: poly.category,
                outcomes: poly.outcomes,
                resolution_date: poly.resolution_date,
                volume: Math.min(20000, Math.floor((poly.volume || 10000) * 0.001)),
                last_price_yes: refPrice,
                active: true,
                simulated: true
            });
        }

        this.logger.info(`Created ${simulated.length} simulated Gemini markets for paper trading`);
        return simulated;
    }
}

module.exports = MarketMatcher;
