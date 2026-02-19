/**
 * The Odds API Client
 *
 * Fetches real-time odds from 40+ sportsbooks (DraftKings, FanDuel, BetMGM, Pinnacle, etc.)
 * and converts them to implied probabilities for use as reference signals in the
 * fair value engine.
 *
 * API: https://the-odds-api.com/
 * Free tier: 500 requests/month
 *
 * Sports betting odds serve as deep-liquidity reference prices for sports prediction
 * markets on Gemini/Kalshi/Polymarket. This is the sharp-vs-soft book model:
 * consensus sportsbook odds = "true" probability, prediction market = potential mispricing.
 */

const { Logger } = require('./logger');

const BASE_URL = 'https://api.the-odds-api.com/v4';

// Map Odds API sport keys to our internal categories
const SPORT_CATEGORIES = {
    'americanfootball_nfl': 'sports',
    'americanfootball_ncaaf': 'sports',
    'basketball_nba': 'sports',
    'basketball_ncaab': 'sports',
    'baseball_mlb': 'sports',
    'icehockey_nhl': 'sports',
    'soccer_epl': 'sports',
    'soccer_usa_mls': 'sports',
    'mma_mixed_martial_arts': 'sports',
    'boxing_boxing': 'sports',
    'golf_pga': 'sports',
    'tennis_atp': 'sports',
    'politics_us_presidential_election_winner': 'politics',
};

class OddsApiClient {
    constructor(options = {}) {
        this.apiKey = options.apiKey || process.env.ODDS_API_KEY || '';
        this.logger = new Logger({ component: 'ODDS-API', level: options.logLevel || 'INFO' });
        this.cache = new Map(); // sport -> { data, time }
        this.cacheTTL = options.cacheTTL || 300000; // 5 min cache (conserve free tier credits)
        this.lastRequestTime = 0;
        this.minRequestInterval = options.minRequestInterval || 5000; // 5s between requests
        this.requestCount = 0;
        this.remainingCredits = null;

        // Matched odds: eventKey -> { homeTeam, awayTeam, homeProb, awayProb, drawProb, ... }
        this.matchedOdds = new Map();
    }

    /**
     * Check if the client is configured with an API key
     */
    isConfigured() {
        return !!this.apiKey;
    }

    /**
     * Rate-limited fetch wrapper
     */
    async _fetch(url) {
        if (!this.apiKey) {
            this.logger.debug('No ODDS_API_KEY configured, skipping fetch');
            return null;
        }

        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minRequestInterval) {
            await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
        }

        // Check cache
        const cached = this.cache.get(url);
        if (cached && (Date.now() - cached.time) < this.cacheTTL) {
            return cached.data;
        }

        try {
            this.lastRequestTime = Date.now();
            this.requestCount++;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            const separator = url.includes('?') ? '&' : '?';
            const fullUrl = `${url}${separator}apiKey=${this.apiKey}`;

            const response = await fetch(fullUrl, {
                signal: controller.signal,
                headers: { 'Accept': 'application/json' }
            });

            clearTimeout(timeout);

            // Track remaining credits from response headers
            const remaining = response.headers.get('x-requests-remaining');
            if (remaining !== null) {
                this.remainingCredits = parseInt(remaining);
                if (this.remainingCredits < 50) {
                    this.logger.warn(`Odds API credits low: ${this.remainingCredits} remaining`);
                }
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            this.cache.set(url, { data, time: Date.now() });
            return data;
        } catch (error) {
            this.logger.error(`Odds API fetch failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Convert American odds to implied probability
     * American odds: +150 means bet $100 to win $150, -200 means bet $200 to win $100
     */
    americanToProb(odds) {
        if (odds > 0) {
            return 100 / (odds + 100);
        } else {
            return Math.abs(odds) / (Math.abs(odds) + 100);
        }
    }

    /**
     * Convert decimal odds to implied probability
     * Decimal odds 2.50 means get $2.50 back for $1 bet (including stake)
     */
    decimalToProb(odds) {
        return 1 / odds;
    }

    /**
     * Get available sports
     */
    async getSports() {
        const data = await this._fetch(`${BASE_URL}/sports`);
        if (!data) return [];
        return data.filter(s => s.active);
    }

    /**
     * Get odds for a specific sport
     * @param {string} sportKey - e.g., 'americanfootball_nfl', 'basketball_nba'
     * @param {Object} options - { markets: 'h2h,spreads,totals', regions: 'us', oddsFormat: 'american' }
     */
    async getOdds(sportKey, options = {}) {
        const markets = options.markets || 'h2h';
        const regions = options.regions || 'us';
        const oddsFormat = options.oddsFormat || 'american';

        const url = `${BASE_URL}/sports/${sportKey}/odds?regions=${regions}&markets=${markets}&oddsFormat=${oddsFormat}`;
        const data = await this._fetch(url);
        if (!data) return [];

        return data;
    }

    /**
     * Get consensus implied probabilities for all events across key sports
     * Returns normalized odds from the sharpest bookmaker (Pinnacle if available)
     */
    async getConsensusOdds(sportKeys = null) {
        if (!this.isConfigured()) return [];

        const sports = sportKeys || [
            'americanfootball_nfl',
            'basketball_nba',
            'baseball_mlb',
            'icehockey_nhl',
            'soccer_epl',
            'mma_mixed_martial_arts',
        ];

        const allOdds = [];

        for (const sport of sports) {
            const events = await this.getOdds(sport, {
                markets: 'h2h',
                regions: 'us,eu',
                oddsFormat: 'american'
            });

            if (!events || !Array.isArray(events)) continue;

            for (const event of events) {
                const consensus = this._extractConsensus(event);
                if (consensus) {
                    allOdds.push({
                        ...consensus,
                        sport,
                        category: SPORT_CATEGORIES[sport] || 'sports'
                    });
                }
            }
        }

        // Update internal matched odds cache
        for (const odds of allOdds) {
            this.matchedOdds.set(odds.eventKey, odds);
        }

        this.logger.info(`Fetched consensus odds for ${allOdds.length} events across ${sports.length} sports`);
        return allOdds;
    }

    /**
     * Extract consensus probability from event data
     * Prefers Pinnacle (sharp book), falls back to average across bookmakers
     */
    _extractConsensus(event) {
        if (!event.bookmakers || event.bookmakers.length === 0) return null;

        // Prefer Pinnacle (sharpest US-accessible book)
        const pinnacle = event.bookmakers.find(b => b.key === 'pinnacle');
        const source = pinnacle || event.bookmakers[0];

        const h2h = source.markets?.find(m => m.key === 'h2h');
        if (!h2h || !h2h.outcomes) return null;

        // Convert odds to probabilities
        const outcomes = {};
        let totalProb = 0;
        for (const outcome of h2h.outcomes) {
            const prob = this.americanToProb(outcome.price);
            outcomes[outcome.name] = prob;
            totalProb += prob;
        }

        // Normalize (remove vig/overround)
        const normalized = {};
        for (const [name, prob] of Object.entries(outcomes)) {
            normalized[name] = prob / totalProb;
        }

        return {
            eventKey: event.id,
            eventTitle: `${event.home_team} vs ${event.away_team}`,
            homeTeam: event.home_team,
            awayTeam: event.away_team,
            commenceTime: event.commence_time,
            outcomes: normalized,
            source: source.key,
            rawOverround: totalProb,
            bookmakerCount: event.bookmakers.length
        };
    }

    /**
     * Find matching odds for a prediction market event title
     * Uses fuzzy title matching against sports events
     */
    findMatchingOdds(marketTitle) {
        if (!marketTitle) return null;
        const title = marketTitle.toLowerCase();

        for (const [, odds] of this.matchedOdds) {
            const eventTitle = odds.eventTitle.toLowerCase();
            const homeTeam = (odds.homeTeam || '').toLowerCase();
            const awayTeam = (odds.awayTeam || '').toLowerCase();

            // Check if market title mentions both teams
            if (homeTeam && awayTeam &&
                (title.includes(homeTeam) || title.includes(awayTeam))) {
                return odds;
            }

            // Check if "will X win" or "X vs Y" patterns match
            if (title.includes(eventTitle) || eventTitle.includes(title)) {
                return odds;
            }
        }

        return null;
    }

    /**
     * Get implied probability for a specific team/outcome from matched odds
     * @param {string} marketTitle - The prediction market event title
     * @param {string} outcomeName - Name of the team/outcome to look up
     * @returns {number|null} Probability 0-1 or null if not found
     */
    getImpliedProbability(marketTitle, outcomeName) {
        const odds = this.findMatchingOdds(marketTitle);
        if (!odds) return null;

        const outcome = outcomeName.toLowerCase();
        for (const [name, prob] of Object.entries(odds.outcomes)) {
            if (name.toLowerCase().includes(outcome) || outcome.includes(name.toLowerCase())) {
                return prob;
            }
        }

        return null;
    }

    /**
     * Get stats for monitoring
     */
    getStats() {
        return {
            configured: this.isConfigured(),
            requestCount: this.requestCount,
            remainingCredits: this.remainingCredits,
            cachedEvents: this.matchedOdds.size,
            cacheEntries: this.cache.size
        };
    }
}

module.exports = OddsApiClient;
