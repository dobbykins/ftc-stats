# FTC Stats

Statbotics-style FTC analytics app — React + Vite + Recharts.

## Quick start

```bash
npm install
cp .env.example .env
# Set VITE_PROXY_URL to your Cloudflare Worker URL
npm run dev
```

## .env

```
VITE_PROXY_URL=https://your-worker.your-subdomain.workers.dev
```

Your Cloudflare Worker should forward requests to `https://ftc-api.firstinspires.org/v2.0`
and pass through the `Authorization` header (or inject it server-side).

## First run

1. Open the app → click **API Key** in the navbar
2. Enter your FIRST username + API key (from ftc-events.firstinspires.org → Account)
3. Data loads automatically and is cached in localStorage — subsequent visits are instant

## Structure

```
src/
  api/ftc.js           — FTC Events API client (proxy + credentials)
  hooks/
    useEpaData.js      — Loads all match data, runs EPA engine, caches result
    useLiveData.js     — Auto-polling hook for live event data (30s interval)
  utils/epa.js         — Full EPA engine (buildEpa, epaWinProb, parseMatchRow, etc.)
  components/
    Navbar             — Nav + API Key button + refresh
    CredentialsModal   — Username/key entry UI
    LiveBadge          — Green pulse / syncing indicator
    StatCard           — Metric tile
    EPAChart           — Recharts EPA trend line
  pages/
    Home               — Landing, auto-loads EPA on mount
    Rankings           — Full EPA rankings table with sort/filter
    Events             — Event list with search
    EventDetail        — Per-event rankings, matches, win probability predictions
    Teams              — Team lookup with EPA stats
```

## EPA constants (from index.html)

| Constant | Value |
|---|---|
| K_PEAK_VAL | 0.40 |
| K_FLOOR | 0.25 |
| PRIOR_SEASON_WEIGHT | 0.35 |
| MOMENTUM_WEIGHT | 0.35 |
| ELO_SCALE_MULTIPLIER | 1.8 |
| MIN_MATCHES_FOR_PRED | 3 |
