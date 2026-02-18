/**
 * Discord Alert Module
 *
 * Sends webhook notifications for:
 *   - Cross-platform arb events (netEdge >= ARB_THRESHOLD)
 *   - Daily P&L summary (called once per day)
 *   - Circuit-breaker open / drawdown kill-switch events
 *
 * Usage:
 *   const Alerts = require('./alerts');
 *   const alerts = new Alerts({ webhookUrl: process.env.DISCORD_WEBHOOK_URL });
 *   await alerts.sendArbAlert(signal);
 *   await alerts.sendDailyPnL(wallet, dailyPnL);
 */

const { Logger } = require('./logger');

const ARB_THRESHOLD  = 0.03;  // 3¢ net edge minimum for arb alert
const ALERT_COOLDOWN = 60000; // ms — don't spam same market within 60s

class Alerts {
    constructor(options = {}) {
        this.logger     = new Logger({ component: 'ALERTS', level: options.logLevel || 'INFO' });
        this.webhookUrl = options.webhookUrl || process.env.DISCORD_WEBHOOK_URL || null;
        this.enabled    = !!this.webhookUrl;
        this.lastAlerts = new Map(); // marketId -> last alert timestamp (cooldown)
        this.dailySentAt = null;     // Date string (YYYY-MM-DD) of last daily summary

        if (!this.enabled) {
            this.logger.info('Discord alerts DISABLED (set DISCORD_WEBHOOK_URL to enable)');
        }
    }

    // ── Internal POST ─────────────────────────────────────────────────────────

    async _post(payload) {
        if (!this.enabled) return;
        try {
            const resp = await fetch(this.webhookUrl, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload),
                signal:  AbortSignal.timeout(5000)
            });
            if (!resp.ok) {
                this.logger.warn(`Discord webhook HTTP ${resp.status}`);
            }
        } catch (err) {
            this.logger.warn(`Discord webhook error: ${err.message}`);
        }
    }

    // ── Public Alert Methods ──────────────────────────────────────────────────

    /**
     * Send arb alert when cross-platform edge >= ARB_THRESHOLD
     * Applies per-market cooldown to prevent spam.
     */
    async sendArbAlert(signal) {
        if (!this.enabled) return;
        const edge = signal.netEdge || signal.edge || 0;
        if (edge < ARB_THRESHOLD) return;

        const marketId = signal.marketId || 'unknown';
        const now      = Date.now();
        const lastSent = this.lastAlerts.get(marketId) || 0;
        if (now - lastSent < ALERT_COOLDOWN) return;
        this.lastAlerts.set(marketId, now);

        const dirEmoji = signal.direction === 'YES' ? '📈' : '📉';
        const title    = signal.title || marketId;
        const edgeCents = (edge * 100).toFixed(1);

        await this._post({
            embeds: [{
                title:  `${dirEmoji} ARB ALERT — ${edgeCents}¢ edge`,
                color:  0x00cc44,
                fields: [
                    { name: 'Market',    value: title,                              inline: false },
                    { name: 'Direction', value: signal.direction || '?',            inline: true  },
                    { name: 'Net Edge',  value: `${edgeCents}¢`,                   inline: true  },
                    { name: 'Score',     value: String(signal.score || 0),          inline: true  },
                    { name: 'Gemini',
                      value: `bid=${signal.gemini_bid?.toFixed(3) ?? '?'} ask=${signal.gemini_ask?.toFixed(3) ?? '?'}`,
                      inline: true },
                    { name: 'KalshiFV',
                      value: signal.arb?.kalshiFairValue != null
                          ? signal.arb.kalshiFairValue.toFixed(3)
                          : (signal.referencePrice?.toFixed(3) ?? '?'),
                      inline: true }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: 'Prediction Market Bot (paper mode)' }
            }]
        });

        this.logger.info(`ARB alert sent: ${marketId} edge=${edgeCents}¢`);
    }

    /**
     * Send daily P&L summary. Only fires once per calendar day.
     */
    async sendDailyPnL(wallet, dailyPnL) {
        if (!this.enabled) return;
        const today = new Date().toISOString().slice(0, 10);
        if (this.dailySentAt === today) return;
        this.dailySentAt = today;

        const pnl       = dailyPnL?.daily_pnl ?? 0;
        const trades    = dailyPnL?.trade_count ?? 0;
        const wins      = dailyPnL?.wins ?? 0;
        const winRate   = trades > 0 ? ((wins / trades) * 100).toFixed(1) : '--';
        const balance   = wallet?.balance ?? 0;
        const initial   = wallet?.initial_balance ?? 500;
        const totalPnl  = balance - initial;
        const color     = pnl >= 0 ? 0x00cc44 : 0xff4444;
        const sign      = pnl >= 0 ? '+' : '';

        await this._post({
            embeds: [{
                title:  `📊 Daily P&L Summary — ${today}`,
                color,
                fields: [
                    { name: 'Daily P&L',   value: `${sign}$${pnl.toFixed(2)}`,     inline: true },
                    { name: 'Trades',      value: String(trades),                   inline: true },
                    { name: 'Win Rate',    value: `${winRate}%`,                    inline: true },
                    { name: 'Balance',     value: `$${balance.toFixed(2)}`,         inline: true },
                    { name: 'Total P&L',   value: `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`, inline: true },
                    { name: 'Peak',        value: `$${(wallet?.peak_balance ?? balance).toFixed(2)}`,    inline: true }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: 'Prediction Market Bot' }
            }]
        });

        this.logger.info(`Daily P&L alert sent: ${sign}$${pnl.toFixed(2)} (${trades} trades)`);
    }

    /**
     * Send circuit-breaker or kill-switch event alert (critical).
     */
    async sendCriticalAlert(title, message) {
        if (!this.enabled) return;
        await this._post({
            embeds: [{
                title,
                description: message,
                color: 0xff0000,
                timestamp: new Date().toISOString(),
                footer: { text: 'Prediction Market Bot' }
            }]
        });
        this.logger.warn(`Critical alert sent: ${title}`);
    }
}

module.exports = Alerts;
