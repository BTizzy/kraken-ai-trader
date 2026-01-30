# ⚠️ LEGACY DEPLOYMENT GUIDE — See `Must_read_before_any_agent_task.md` for all current info

> **IMPORTANT:** This file contains legacy deployment instructions for the original web-based trading game. The current production system is a C++/SQLite trading bot. All agents and contributors should refer to `Must_read_before_any_agent_task.md` and `bot/BUILD_AND_DEPLOY.md` for up-to-date deployment and operational information.

---

# Deployment Guide

## 🌐 GitHub Pages Deployment (Recommended)

GitHub Pages is the easiest way to deploy this static web app for free.

### Step 1: Push to GitHub

```bash
# Initialize git (if not already done)
git init
git add .
git commit -m "Initial release - Kraken AI Trading Game"

# Add remote and push
git remote add origin https://github.com/BTizzy/kraken-ai-trader.git
git branch -M main
git push -u origin main
```

### Step 2: Enable GitHub Pages

1. Go to your repository on GitHub
2. Click **Settings** (top right)
3. Scroll down to **Pages** (left sidebar)
4. Under **Source**, select:
   - Branch: `main`
   - Folder: `/ (root)`
5. Click **Save**

### Step 3: Access Your Live Game

Your game will be available at:
```
https://BTizzy.github.io/kraken-ai-trader/
```

Setup page:
```
https://BTizzy.github.io/kraken-ai-trader/setup.html
```

**Note:** It may take 1-2 minutes for the site to go live after enabling Pages.

---

## 🔧 Alternative Deployment Options

### Netlify

1. Create a free account at [netlify.com](https://netlify.com)
2. Click "Add new site" → "Import an existing project"
3. Connect your GitHub repository
4. Deploy settings:
   - Build command: (leave empty)
   - Publish directory: `/` (root)
5. Click "Deploy site"

Your site will be live at: `https://your-site-name.netlify.app`

### Vercel

1. Create a free account at [vercel.com](https://vercel.com)
2. Click "Add New" → "Project"
3. Import your GitHub repository
4. Framework Preset: `Other`
5. Click "Deploy"

Your site will be live at: `https://your-project.vercel.app`

### Local Development

For testing locally:

```bash
# Using Python 3
python3 -m http.server 8000

# Or using Node.js
npx http-server -p 8000

# Or using PHP
php -S localhost:8000
```

Then visit: `http://localhost:8000/setup.html`

---

## 🔐 Security Notes

### API Key Storage

- User API keys are stored in browser `localStorage`
- Keys never leave the user's browser
- Keys are not sent to your server (this is a static site)
- Users should NEVER share their API keys

### CORS Considerations

The app makes requests to:
- `https://clob.polymarket.com/markets` (Polymarket API)
- `https://api.groq.com/openai/v1/chat/completions` (Groq API)

Both APIs support CORS and can be called from browser JavaScript.

### Rate Limiting

- Groq free tier: 30 requests/minute
- Kraken CLOB: No official limit (but be respectful)
- The app includes caching to minimize API calls

---

## 📊 Analytics (Optional)

To track usage, add Google Analytics or Plausible:

### Google Analytics

Add to `<head>` in `index.html` and `setup.html`:

```html
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

### Plausible (Privacy-Friendly)

Add to `<head>`:

```html
<script defer data-domain="yourdomain.com" src="https://plausible.io/js/script.js"></script>
```

---

## 🐛 Troubleshooting

### Markets Not Loading

- Check browser console for errors (F12)
- Verify Polymarket API is accessible: https://clob.polymarket.com/markets
- Check CORS policy in browser

### AI Predictions Failing

- Verify Groq API key is valid
- Check API key in Settings
- Look for rate limit errors (wait 1 minute)
- Try the mock prediction fallback (works without API key)

### Prices Not Updating

- Price simulation is enabled by default
- Real-time WebSocket integration coming in future updates
- Check `GAME_CONFIG.enablePriceSimulation` in `config.js`

---

## 🔄 Updates & Maintenance

### Updating the Game

```bash
# Pull latest changes
git pull origin main

# Make your changes
# ...

# Commit and push
git add .
git commit -m "Update: description of changes"
git push origin main
```

GitHub Pages will auto-deploy within 1-2 minutes.

### Cache Busting

If users see old versions after updates, add version query strings:

```html
<link rel="stylesheet" href="styles.css?v=1.1">
<script src="game.js?v=1.1"></script>
```

---

## 📱 Mobile Optimization

The app is responsive, but for best mobile experience:

1. Add to `<head>` in `index.html`:

```html
<meta name="theme-color" content="#667eea">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="icon.png">
```

2. Create a 192x192 icon.png for PWA support

---

## ⚡ Performance Tips

### Optimize Loading

- Markets are cached for 60 seconds
- AI predictions use batching to reduce calls
- Price updates are throttled to 1 second intervals

### Reduce API Calls

- Increase cache expiry in `api.js`:
  ```javascript
  this.cacheExpiry = 300000; // 5 minutes
  ```

- Limit markets to show:
  ```javascript
  maxMarketsToShow: 10, // in config.js
  ```

---

## 📞 Support

For issues or questions:

1. Check the [GitHub Issues](https://github.com/BTizzy/kraken-ai-trader/issues)
2. Open a new issue with:
   - Browser and version
   - Error messages from console
   - Steps to reproduce
3. Contact: [@BTizzy](https://github.com/BTizzy)

---

## 📄 License

MIT License - See [LICENSE](LICENSE) file for details.
