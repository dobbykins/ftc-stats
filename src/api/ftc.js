// FTC Events API client
// Routes all requests through your Cloudflare Worker proxy.
// Set VITE_PROXY_URL=https://your-worker.workers.dev in .env

const PROXY = (import.meta.env.VITE_PROXY_URL || '').replace(/\/$/, '')
const SEASON = 2025

// ── Credentials ───────────────────────────────────────────
export function getCredentials() {
  return {
    user: localStorage.getItem('ftc_api_user') || '',
    key:  localStorage.getItem('ftc_api_key')  || '',
  }
}
export function saveCredentials(user, key) {
  localStorage.setItem('ftc_api_user', user.trim())
  localStorage.setItem('ftc_api_key',  key.trim())
}
export function clearCredentials() {
  localStorage.removeItem('ftc_api_user')
  localStorage.removeItem('ftc_api_key')
}
export function hasCredentials() {
  const { user, key } = getCredentials()
  return !!(user && key)
}

function authHeader() {
  const { user, key } = getCredentials()
  return 'Basic ' + btoa(`${user}:${key}`)
}

// ── Core fetch ────────────────────────────────────────────
// `path` should be everything AFTER the season, e.g. '/events', '/scores/USMIFL/qual'
// The season is always prepended here.
async function ftcFetch(path, attempt = 0) {
  if (!PROXY) throw new Error('VITE_PROXY_URL not set — add it to your .env file')

  const url = `${PROXY}/${SEASON}${path}`
  let r
  try {
    r = await fetch(url, {
      headers: {
        'Authorization': authHeader(),
        'Accept': 'application/json',
      }
    })
  } catch (e) {
    throw new Error(`Network error (proxy unreachable): ${e.message}`)
  }

  if (r.status === 401) {
    clearCredentials()
    throw new Error('UNAUTHORIZED')
  }
  if (r.status === 429) {
    if (attempt < 3) {
      await new Promise(res => setTimeout(res, 300 * Math.pow(2, attempt)))
      return ftcFetch(path, attempt + 1)
    }
    throw new Error('Rate limited — try again in a moment')
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`)
  return r.json()
}

async function ftcFetchRetry(path, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try { return await ftcFetch(path) }
    catch (e) {
      if (e.message === 'UNAUTHORIZED') throw e
      if (i === attempts - 1) throw e
      await new Promise(res => setTimeout(res, 300 * Math.pow(2, i)))
    }
  }
}

export function getLastSync() {
  return parseInt(localStorage.getItem('ftc_last_sync') ?? '0', 10);
}

export function setLastSync(ts) {
  localStorage.setItem('ftc_last_sync', ts.toString());
}

// ── Public API ────────────────────────────────────────────
export const ftcApi = {
  // Events
  getRetry: (path) => ftcFetchRetry(path),

  // Hybrid schedule (includes team lists + scores in one call)
  getHybridSchedule: (eventCode, level = 'qual') =>
    ftcFetchRetry(`/schedule/${eventCode}/${level}/hybrid`),

  // Scores detail (for foul accuracy)
  getScores: (eventCode, level = 'qual') =>
    ftcFetchRetry(`/scores/${eventCode}/${level}`),

  // Rankings
  getRankings: (eventCode) =>
    ftcFetchRetry(`/rankings/${eventCode}`),

  // Team info
  getTeam: (teamNumber) =>
    ftcFetchRetry(`/teams?teamNumber=${teamNumber}`),
}

// ── Match data cache ──────────────────────────────────────
const CACHE_KEY = `ftc_stats_rows_v1_${SEASON}`
const CACHE_TTL = 1000 * 60 * 60 * 4 // 4 hours

export function getCached() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    if (!raw) return null
    if (Date.now() - (raw.ts || 0) > CACHE_TTL) return null // stale
    return raw.rows
  } catch { return null }
}
export function setCached(rows) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ rows, ts: Date.now() })) } catch {}
}
export function clearCache() { localStorage.removeItem(CACHE_KEY) }