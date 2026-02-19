/**
 * Metaculus API Client
 *
 * Fetches community prediction probabilities from Metaculus — the most well-calibrated
 * public prediction platform. Used as a reference signal in the fair value engine
 * for politics, economics, science, and tech events.
 *
 * API: https://www.metaculus.com/api2/
 * Free, no auth required for public questions.
 *
 * Metaculus community predictions are NOT trading markets, but their track record
 * on calibration is the best among public platforms. A Metaculus 72% estimate
 * diverging from a Gemini 55% contract price is a strong trading signal.
 */

const { Logger } = require('./logger');

const BASE_URL = 'https://www.metaculus.com/api2';

class MetaculusClient {
    constructor(options = {}) {
        this.logger = new Logger({ component: 'METACULUS', level: options.logLevel || 'INFO' });
        this.cache = new Map(); // url -> { data, time }
        this.cacheTTL = options.cacheTTL || 600000; // 10 min cache (predictions change slowly)
        this.lastRequestTime = 0;
        this.minRequestInterval = options.minRequestInterval || 3000; // 3s between requests
        this.requestCount = 0;

        // Matched questions: questionId -> { title, probability, ... }
        this.questions = new Map();
    }

    /**
     * Rate-limited fetch wrapper
     */
    async _fetch(url) {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minRequestInterval) {
            await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
        }

        const cached = this.cache.get(url);
        if (cached && (Date.now() - cached.time) < this.cacheTTL) {
            return cached.data;
        }

        try {
            this.lastRequestTime = Date.now();
            this.requestCount++;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'PredictionBot/1.0'
                }
            });

            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            this.cache.set(url, { data, time: Date.now() });
            return data;
        } catch (error) {
            this.logger.error(`Metaculus fetch failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Search Metaculus questions by keyword
     * @param {string} query - Search query
     * @param {Object} options - { limit, status, type }
     */
    async searchQuestions(query, options = {}) {
        const limit = options.limit || 20;
        const status = options.status || 'open'; // open, closed, resolved
        const type = options.type || 'forecast'; // forecast, notebook, group

        const params = new URLSearchParams({
            search: query,
            limit: limit.toString(),
            status,
            type,
            order_by: '-activity'
        });

        const url = `${BASE_URL}/questions/?${params.toString()}`;
        const data = await this._fetch(url);
        if (!data) return [];

        return (data.results || []).map(q => this._normalizeQuestion(q));
    }

    /**
     * Get a specific question by ID
     */
    async getQuestion(questionId) {
        const url = `${BASE_URL}/questions/${questionId}/`;
        const data = await this._fetch(url);
        if (!data) return null;
        return this._normalizeQuestion(data);
    }

    /**
     * Fetch popular/active questions across categories
     * Good for building a broad reference set
     */
    async getActiveQuestions(options = {}) {
        const limit = options.limit || 50;
        const params = new URLSearchParams({
            limit: limit.toString(),
            status: 'open',
            type: 'forecast',
            order_by: '-activity'
        });

        if (options.category) {
            params.set('search', options.category);
        }

        const url = `${BASE_URL}/questions/?${params.toString()}`;
        const data = await this._fetch(url);
        if (!data) return [];

        const questions = (data.results || []).map(q => this._normalizeQuestion(q));

        // Store in internal cache
        for (const q of questions) {
            if (q.probability !== null) {
                this.questions.set(q.id, q);
            }
        }

        this.logger.info(`Fetched ${questions.length} active Metaculus questions`);
        return questions;
    }

    /**
     * Normalize a Metaculus question to our internal format
     */
    _normalizeQuestion(raw) {
        // Community prediction (median)
        let probability = null;
        if (raw.community_prediction && raw.community_prediction.full) {
            probability = raw.community_prediction.full.q2; // median (q2 = 50th percentile)
        } else if (raw.community_prediction && typeof raw.community_prediction.y === 'number') {
            probability = raw.community_prediction.y;
        }

        // Metaculus prediction (staff)
        let metaculusPrediction = null;
        if (raw.metaculus_prediction && typeof raw.metaculus_prediction.full === 'object') {
            metaculusPrediction = raw.metaculus_prediction.full.q2;
        }

        return {
            id: raw.id,
            title: raw.title || '',
            url: raw.url || `https://www.metaculus.com/questions/${raw.id}/`,
            probability,           // Community median prediction (0-1)
            metaculusPrediction,   // Staff/algo prediction (0-1)
            forecasters: raw.number_of_forecasters || 0,
            resolutionDate: raw.resolve_time || raw.close_time,
            created: raw.created_time,
            category: this._inferCategory(raw),
            status: raw.status || 'open',
            questionType: raw.possibilities?.type || 'binary'
        };
    }

    /**
     * Infer category from Metaculus tags/title
     */
    _inferCategory(raw) {
        const title = (raw.title || '').toLowerCase();
        const tags = (raw.categories || []).map(c => (c.name || c || '').toLowerCase());
        const allText = title + ' ' + tags.join(' ');

        if (allText.includes('politic') || allText.includes('election') ||
            allText.includes('president') || allText.includes('congress')) return 'politics';
        if (allText.includes('econom') || allText.includes('gdp') ||
            allText.includes('inflation') || allText.includes('fed') ||
            allText.includes('interest rate')) return 'finance';
        if (allText.includes('sport') || allText.includes('nba') ||
            allText.includes('nfl') || allText.includes('world cup')) return 'sports';
        if (allText.includes('tech') || allText.includes('ai') ||
            allText.includes('software') || allText.includes('compute')) return 'tech';
        if (allText.includes('crypto') || allText.includes('bitcoin') ||
            allText.includes('ethereum')) return 'crypto';
        if (allText.includes('science') || allText.includes('climate') ||
            allText.includes('research')) return 'science';

        return 'other';
    }

    /**
     * Find matching Metaculus question for a prediction market event
     * Uses keyword matching between market title and Metaculus questions
     */
    findMatchingQuestion(marketTitle) {
        if (!marketTitle) return null;
        const title = marketTitle.toLowerCase();

        let bestMatch = null;
        let bestScore = 0;

        for (const [, question] of this.questions) {
            if (question.probability === null) continue;

            const qTitle = question.title.toLowerCase();

            // Simple word overlap scoring
            const titleWords = new Set(title.split(/\s+/).filter(w => w.length > 3));
            const qWords = new Set(qTitle.split(/\s+/).filter(w => w.length > 3));
            const overlap = [...titleWords].filter(w => qWords.has(w)).length;
            const score = overlap / Math.max(titleWords.size, 1);

            if (score > bestScore && score >= 0.3) {
                bestScore = score;
                bestMatch = question;
            }
        }

        return bestMatch;
    }

    /**
     * Get community probability for a market title
     * Returns probability (0-1) or null if not found
     */
    getProbability(marketTitle) {
        const match = this.findMatchingQuestion(marketTitle);
        return match ? match.probability : null;
    }

    /**
     * Get stats for monitoring
     */
    getStats() {
        return {
            requestCount: this.requestCount,
            cachedQuestions: this.questions.size,
            cacheEntries: this.cache.size
        };
    }
}

module.exports = MetaculusClient;
