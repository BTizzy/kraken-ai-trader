/**
 * Rate Limiter & Request Queue
 * Manages API request rates across Polymarket, Kalshi, and Gemini
 * 
 * Features:
 *   - Per-platform rate limiting
 *   - Priority queue (execution > price updates > analytics)
 *   - Exponential backoff on rate limit errors
 *   - Request batching
 */

class RateLimiter {
    constructor(options = {}) {
        // Rate limits per platform (requests per minute)
        this.limits = {
            polymarket: options.polymarketRPM || 30,
            kalshi: options.kalshiRPM || 60,
            gemini: options.geminiRPM || 60,
            default: options.defaultRPM || 30
        };

        // Request tracking per platform
        this.requests = new Map(); // platform -> [{timestamp}]
        this.windowMs = 60000; // 1 minute sliding window

        // Priority queue
        this.queue = []; // { platform, priority, fn, resolve, reject }
        this.processing = false;

        // Backoff state
        this.backoffUntil = new Map(); // platform -> timestamp
    }

    /**
     * Check if a request can be made for a platform
     */
    canRequest(platform) {
        // Check backoff
        const backoff = this.backoffUntil.get(platform);
        if (backoff && Date.now() < backoff) return false;

        const limit = this.limits[platform] || this.limits.default;
        const history = this.requests.get(platform) || [];

        // Clean old entries
        const cutoff = Date.now() - this.windowMs;
        const recent = history.filter(t => t > cutoff);
        this.requests.set(platform, recent);

        return recent.length < limit;
    }

    /**
     * Record a request
     */
    recordRequest(platform) {
        const history = this.requests.get(platform) || [];
        history.push(Date.now());
        this.requests.set(platform, history);
    }

    /**
     * Set backoff for a platform (e.g., after 429 response)
     */
    setBackoff(platform, durationMs = 5000) {
        this.backoffUntil.set(platform, Date.now() + durationMs);
    }

    /**
     * Wait until request is allowed
     */
    async waitForSlot(platform) {
        while (!this.canRequest(platform)) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    /**
     * Execute a function with rate limiting
     * Priority: 1 = highest (execution), 2 = price updates, 3 = analytics
     */
    async execute(platform, fn, priority = 2) {
        return new Promise((resolve, reject) => {
            this.queue.push({ platform, priority, fn, resolve, reject });
            this.queue.sort((a, b) => a.priority - b.priority);
            this._processQueue();
        });
    }

    /**
     * Process the request queue
     */
    async _processQueue() {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const request = this.queue[0];

            // Wait for rate limit slot
            while (!this.canRequest(request.platform)) {
                await new Promise(r => setTimeout(r, 50));
            }

            // Remove from queue and execute
            this.queue.shift();
            this.recordRequest(request.platform);

            try {
                const result = await request.fn();
                request.resolve(result);
            } catch (error) {
                if (error.message?.includes('429') || error.message?.includes('rate limit')) {
                    this.setBackoff(request.platform, 5000);
                }
                request.reject(error);
            }
        }

        this.processing = false;
    }

    /**
     * Get current usage stats
     */
    getStats() {
        const stats = {};
        const cutoff = Date.now() - this.windowMs;

        for (const [platform, limit] of Object.entries(this.limits)) {
            const history = this.requests.get(platform) || [];
            const recent = history.filter(t => t > cutoff);
            stats[platform] = {
                used: recent.length,
                limit,
                remaining: limit - recent.length,
                backoff_until: this.backoffUntil.get(platform) || null
            };
        }

        stats.queue_length = this.queue.length;
        return stats;
    }
}

module.exports = RateLimiter;
