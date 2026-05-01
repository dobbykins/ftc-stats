/**
 * FTC Stats Cloudflare Worker
 *
 * Endpoints:
 *   GET /bulk              → full dataset from KV
 *   GET /delta?since=<ts>  → rows changed since timestamp
 *   GET /force-sync        → resets cursor so cron rebuilds dataset
 *   GET /status            → sync progress info
 *   GET /<season>/*        → transparent proxy to FTC Events API
 *
 * KV bindings (set in wrangler.toml):
 *   FTC_KV  → stores rows per event, sync timestamps
 *
 * Secrets (set via `wrangler secret put`):
 *   FTC_USER  → your FIRST username
 *   FTC_KEY   → your FIRST API key
 *
 * KV schema:
 *   rows:<EVENTCODE>     → JSON array of match rows for that event
 *   meta:events          → JSON array of all event codes
 *   meta:events_full     → JSON array of full event objects (for dateEnd)
 *   meta:last_sync       → timestamp of last sync
 *   meta:cursor          → current chunk cursor index
 *   meta:active_events   → JSON array of active event codes
 *
 * Subrequest budget (Cloudflare free plan = 50 per invocation):
 *   - CHUNK_SIZE  = 20  events per cron tick
 *   - CONCURRENCY = 3   parallel fetches
 *   - fetchEventRows makes AT MOST 2 subrequests per event
 *     (hybrid schedule + scores fallback, but scores is skipped
 *      when the hybrid response already embeds them)
 *   - Worst case: 20 events × 2 = 40 subrequests — safely under 50.
 *   - deltaSync for active events uses the same concurrency cap.
 *
 * wrangler.toml:
 *   [triggers]
 *   crons = ["*\/2 * * * *"]
 */

const FTC_BASE    = 'https://ftc-api.firstinspires.org/v2.0'
const SEASON      = 2025

// ── Subrequest budget ─────────────────────────────────────
// Free plan hard limit is 50 subrequests per Worker invocation.
// Each event costs AT MOST 2 (schedule + scores fallback).
// Keep CHUNK_SIZE × 2 well below 50 so there is headroom for
// KV reads/writes and the event-list refresh on the first run.
const CONCURRENCY = 3
const CHUNK_SIZE  = 20

// ── Helpers ───────────────────────────────────────────────

function isOffseason(code = '', type = '') {
  const OFFSEASON_SFX   = ['OS', 'KO', 'SCRIMMAGE', 'DEMO', 'EXHIBITION']
  const OFFSEASON_TYPES = ['offseason', 'kickoff', 'demonstration', 'workshop']
  const u = code.toUpperCase()
  return OFFSEASON_SFX.some(s => u.endsWith(s))
    || OFFSEASON_TYPES.includes(type.toLowerCase())
}

function ftcAuth(env) {
  if (env.FTC_USER && env.FTC_KEY) {
    return 'Basic ' + btoa(`${env.FTC_USER}:${env.FTC_KEY}`)
  }
  return null
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function ftcFetch(path, env, clientAuth = null, attempt = 0) {
  const auth = ftcAuth(env) ?? clientAuth
  if (!auth) throw new Error('No auth available')

  const url = `${FTC_BASE}/${SEASON}${path}`
  let res
  try {
    res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    if (attempt < 3) {
      await sleep(500 * Math.pow(2, attempt))
      return ftcFetch(path, env, clientAuth, attempt + 1)
    }
    throw e
  }

  if (res.status === 401) throw new Error('UNAUTHORIZED')
  if (res.status === 429) {
    if (attempt < 3) {
      await sleep(1000 * Math.pow(2, attempt))
      return ftcFetch(path, env, clientAuth, attempt + 1)
    }
    throw new Error('Rate limited')
  }
  if (!res.ok) throw new Error(`FTC API error ${res.status} for ${path}`)
  return res.json()
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

// ── Row parsing ───────────────────────────────────────────

function parseMatchRow(m, scoreDetail, eventCode) {
  try {
    if (m.scoreRedFinal == null || m.scoreBlueFinal == null) return null
    const teams = m.teams || []
    const rt = teams
      .filter(t => t.station?.startsWith('Red') && !t.surrogate && !t.noShow)
      .map(t => t.teamNumber)
    const bt = teams
      .filter(t => t.station?.startsWith('Blue') && !t.surrogate && !t.noShow)
      .map(t => t.teamNumber)
    if (!rt.length || !bt.length) return null

    const redT = +(m.scoreRedFinal || 0)
    const bluT = +(m.scoreBlueFinal || 0)
    const redA = +(m.scoreRedAuto  || 0)
    const bluA = +(m.scoreBlueAuto || 0)

    const alliances = scoreDetail?.alliances ?? []
    const rsc = alliances.find(a => a.alliance === 'Red')  ?? {}
    const bsc = alliances.find(a => a.alliance === 'Blue') ?? {}
    const redF = +(rsc.foulPoints ?? m.scoreRedFoul  ?? 0)
    const bluF = +(bsc.foulPoints ?? m.scoreBlueFoul ?? 0)

    const code = eventCode.toUpperCase()
    return {
      season: SEASON,
      event:  code,
      match:  `${code}-Q${m.matchNumber}`,
      rt, bt,
      rs: Math.max(0, redT - bluF),
      bs: Math.max(0, bluT - redF),
      ra: Math.min(redA, Math.max(0, redT - bluF)),
      ba: Math.min(bluA, Math.max(0, bluT - redF)),
      rtot: redT, btot: bluT, rf: redF, bf: bluF,
      won: redT > bluT ? 1 : 0,
      mt:  m.actualStartTime || m.startTime || '',
      level: 'qual',
      matchNum: m.matchNumber,
      rPatPts:  +(rsc.patternPoints  ?? rsc.patternBonusPoints  ?? 0),
      bPatPts:  +(bsc.patternPoints  ?? bsc.patternBonusPoints  ?? 0),
      rParkPts: +(rsc.parkPoints     ?? rsc.endgameParkPoints   ?? rsc.ascent1Points ?? rsc.ascentPoints ?? 0),
      bParkPts: +(bsc.parkPoints     ?? bsc.endgameParkPoints   ?? bsc.ascent1Points ?? bsc.ascentPoints ?? 0),
      rNavPts:  +(rsc.autoNavigationPoints ?? rsc.autoNavPoints ?? 0),
      bNavPts:  +(bsc.autoNavigationPoints ?? bsc.autoNavPoints ?? 0),
    }
  } catch {
    return null
  }
}

async function fetchEventRows(eventCode, env, clientAuth = null) {
  // Subrequest 1: hybrid schedule (includes scores when available)
  let scheduleResult
  try {
    scheduleResult = await ftcFetch(`/schedule/${eventCode}/qual/hybrid`, env, clientAuth)
  } catch {
    return []
  }

  const schedule = Array.isArray(scheduleResult.schedule) ? scheduleResult.schedule
                 : Array.isArray(scheduleResult)          ? scheduleResult
                 : []

  if (!schedule.length) return []

  // Check whether the hybrid response already embedded scores.
  // If it did, we skip the separate scores fetch entirely —
  // saving a full subrequest per event (critical on the free plan).
  const hasEmbeddedScores = schedule.some(m => m.scoreRedFinal != null)

  const scoreMap = {}

  if (hasEmbeddedScores) {
    // Scores are already in the hybrid payload — no extra fetch needed.
    for (const m of schedule) {
      if (m.scoreRedFinal != null) {
        scoreMap[m.matchNumber] = { alliances: m.alliances ?? [] }
      }
    }
  } else {
    // Subrequest 2 (only when necessary): fetch scores separately.
    try {
      const scoresResult = await ftcFetch(`/scores/${eventCode}/qual`, env, clientAuth)
      const scoresList = scoresResult.matchScores ?? scoresResult.scores ?? []
      for (const s of scoresList) {
        const num = s.matchNumber ?? s.matchNum
        if (num != null) scoreMap[num] = s
      }
      // Merge scores back into schedule objects
      for (const m of schedule) {
        const s = scoreMap[m.matchNumber]
        if (s) {
          m.scoreRedFinal  = s.redTotalPoints  ?? s.redScore  ?? m.scoreRedFinal  ?? null
          m.scoreBlueFinal = s.blueTotalPoints ?? s.blueScore ?? m.scoreBlueFinal ?? null
          m.scoreRedAuto   = s.redAutoPoints   ?? s.redAuto   ?? m.scoreRedAuto   ?? 0
          m.scoreBlueAuto  = s.blueAutoPoints  ?? s.blueAuto  ?? m.scoreBlueAuto  ?? 0
          m.scoreRedFoul   = s.redFoulPoints   ?? s.redFouls  ?? m.scoreRedFoul   ?? 0
          m.scoreBlueFoul  = s.blueFoulPoints  ?? s.blueFouls ?? m.scoreBlueFoul  ?? 0
        }
      }
    } catch { /* non-fatal — rows without scores are filtered out by parseMatchRow */ }
  }

  const rows = []
  for (const m of schedule) {
    const row = parseMatchRow(m, scoreMap[m.matchNumber] ?? null, eventCode)
    if (row) rows.push(row)
  }
  return rows
}

// ── KV helpers (per-event sharding) ──────────────────────

async function putEventRows(env, eventCode, rows) {
  await env.FTC_KV.put(`rows:${eventCode.toUpperCase()}`, JSON.stringify(rows))
}

async function getAllRows(env) {
  const allRows = []
  let cursor = undefined
  while (true) {
    const result = await env.FTC_KV.list({ prefix: 'rows:', cursor, limit: 1000 })
    await Promise.all(result.keys.map(async k => {
      const raw = await env.FTC_KV.get(k.name)
      if (raw) {
        try { allRows.push(...JSON.parse(raw)) } catch {}
      }
    }))
    if (result.list_complete) break
    cursor = result.cursor
  }
  return allRows
}

async function getEventRows(env, eventCode) {
  const raw = await env.FTC_KV.get(`rows:${eventCode.toUpperCase()}`)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return [] }
}

// ── Event list management ─────────────────────────────────

async function refreshEventList(env, clientAuth = null) {
  const data   = await ftcFetch('/events', env, clientAuth)
  const events = (data.events ?? []).filter(ev =>
    !isOffseason(ev.code, ev.typeName ?? ev.type ?? '')
  )
  const codes = events.map(ev => ev.code)

  await Promise.all([
    env.FTC_KV.put('meta:events',      JSON.stringify(codes)),
    env.FTC_KV.put('meta:events_full', JSON.stringify(events)),
    env.FTC_KV.put('meta:cursor',      '0'),
  ])

  return { codes, events }
}

// ── Chunked sync ──────────────────────────────────────────

async function chunkSync(env, clientAuth = null) {
  const [rawCodes, rawFull, rawSync] = await Promise.all([
    env.FTC_KV.get('meta:events'),
    env.FTC_KV.get('meta:events_full'),
    env.FTC_KV.get('meta:last_sync'),
  ])

  const age = Date.now() - parseInt(rawSync ?? '0', 10)
  let allCodes, allMeta

  if (!rawCodes || age > 1000 * 60 * 60 * 24) {
    console.log('[cron] refreshing event list')
    const result = await refreshEventList(env, clientAuth)
    allCodes = result.codes
    allMeta  = result.events
  } else {
    allCodes = JSON.parse(rawCodes)
    allMeta  = rawFull ? JSON.parse(rawFull) : []
  }

  if (!allCodes.length) return { changed: 0, cursor: 0, total: 0 }

  const cursor     = parseInt((await env.FTC_KV.get('meta:cursor')) ?? '0', 10)
  const chunk      = allCodes.slice(cursor, cursor + CHUNK_SIZE)
  const nextCursor = cursor + CHUNK_SIZE >= allCodes.length ? 0 : cursor + CHUNK_SIZE

  if (!chunk.length) {
    await env.FTC_KV.put('meta:cursor', '0')
    return { changed: 0, cursor: 0, total: allCodes.length }
  }

  // Fetch rows for this chunk with capped concurrency
  const results = new Map()
  let idx = 0
  async function worker() {
    while (idx < chunk.length) {
      const code = chunk[idx++]
      const rows = await fetchEventRows(code, env, clientAuth)
      results.set(code.toUpperCase(), rows)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  // Only write events that actually returned rows, to avoid
  // overwriting good cached data with an empty array on a transient failure.
  await Promise.all(
    [...results.entries()]
      .filter(([, rows]) => rows.length > 0)
      .map(([code, rows]) => putEventRows(env, code, rows))
  )

  // Update active events list and advance cursor
  const now = new Date()
  const activeEvents = allMeta
    .filter(ev => new Date(ev.dateEnd) >= now)
    .map(ev => ev.code)

  const totalRows = [...results.values()].reduce((sum, r) => sum + r.length, 0)
  const syncTime  = Date.now()

  await Promise.all([
    env.FTC_KV.put('meta:last_sync',     syncTime.toString()),
    env.FTC_KV.put('meta:cursor',        nextCursor.toString()),
    env.FTC_KV.put('meta:active_events', JSON.stringify(activeEvents)),
  ])

  console.log(`[cron] chunk ${cursor}–${cursor + chunk.length - 1}/${allCodes.length} | ${totalRows} rows | cursor→${nextCursor}`)
  return { changed: totalRows, cursor: nextCursor, total: allCodes.length, syncTime }
}

// ── Delta sync (active events only) ──────────────────────

async function deltaSync(env) {
  const rawActive = await env.FTC_KV.get('meta:active_events')
  const active    = rawActive ? JSON.parse(rawActive) : []
  if (!active.length) return { changed: 0 }

  // Cap active-event delta to the same concurrency limit
  let totalChanged = 0
  let idx = 0
  async function worker() {
    while (idx < active.length) {
      const code = active[idx++]
      const rows = await fetchEventRows(code, env)
      if (rows.length > 0) {
        await putEventRows(env, code, rows)
        totalChanged += rows.length
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const syncTime = Date.now()
  await env.FTC_KV.put('meta:last_sync', syncTime.toString())
  return { changed: totalChanged, syncTime }
}

// ── Request handler ───────────────────────────────────────

export default {
  async scheduled(_event, env, _ctx) {
    try {
      const rawActive = await env.FTC_KV.get('meta:active_events')
      const active    = rawActive ? JSON.parse(rawActive) : []

      if (active.length) {
        const delta = await deltaSync(env)
        console.log(`[cron] delta: ${delta.changed} rows updated`)
      }

      const chunk = await chunkSync(env)
      console.log(`[cron] chunk done — cursor ${chunk.cursor}/${chunk.total}`)
    } catch (e) {
      console.error('[cron] failed:', e.message)
    }
  },

  async fetch(request, env) {
    const url    = new URL(request.url)
    const origin = request.headers.get('Origin')
    const cors   = corsHeaders(origin)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const clientAuth = request.headers.get('Authorization')
    const path       = url.pathname

    // ── GET /bulk ──────────────────────────────────────────
    if (path === '/bulk') {
      try {
        if (!ftcAuth(env) && !clientAuth) {
          return json({ error: 'UNAUTHORIZED' }, 401, cors)
        }

        const [rawSync, rawCursor, rawCodes] = await Promise.all([
          env.FTC_KV.get('meta:last_sync'),
          env.FTC_KV.get('meta:cursor'),
          env.FTC_KV.get('meta:events'),
        ])

        const syncTime = parseInt(rawSync ?? '0', 10)
        const cursor   = parseInt(rawCursor ?? '0', 10)
        const total    = rawCodes ? JSON.parse(rawCodes).length : 0
        const complete = total === 0 || cursor === 0

        if (!syncTime) {
          // Nothing synced yet — kick off first chunk
          const result = await chunkSync(env, clientAuth)
          const rows   = await getAllRows(env)
          return json({ rows, syncTime: result.syncTime ?? Date.now(), synced: result.cursor, total: result.total, complete: false }, 200, cors)
        }

        const rows = await getAllRows(env)
        return json({ rows, syncTime, synced: cursor, total, complete }, 200, cors)
      } catch (e) {
        if (e.message === 'UNAUTHORIZED') return json({ error: 'UNAUTHORIZED' }, 401, cors)
        return json({ error: e.message }, 500, cors)
      }
    }

    // ── GET /delta?since=<timestamp> ───────────────────────
    if (path === '/delta') {
      try {
        const since    = parseInt(url.searchParams.get('since') ?? '0', 10)
        const rawSync  = await env.FTC_KV.get('meta:last_sync')
        const syncTime = parseInt(rawSync ?? '0', 10)

        if (syncTime <= since) {
          return json({ rows: [], syncTime, hasChanges: false }, 200, cors)
        }

        const rawActive = await env.FTC_KV.get('meta:active_events')
        const active    = rawActive ? JSON.parse(rawActive) : []

        const deltaRows = []
        await Promise.all(active.map(async code => {
          const rows = await getEventRows(env, code)
          if (rows?.some(r => r.mt && new Date(r.mt).getTime() > since)) {
            deltaRows.push(...rows)
          }
        }))

        return json({ rows: deltaRows, syncTime, hasChanges: deltaRows.length > 0 }, 200, cors)
      } catch (e) {
        return json({ error: e.message }, 500, cors)
      }
    }

    // ── GET /force-sync ────────────────────────────────────
    // Only resets metadata — no event fetching here.
    // The cron rebuilds everything in safe 20-event chunks (every 2 min).
    if (path === '/force-sync') {
      try {
        if (!ftcAuth(env)) {
          return json({ error: 'No auth — set FTC_USER and FTC_KEY secrets' }, 401, cors)
        }

        // Clear all existing row keys
        let kvCursor = undefined
        while (true) {
          const result = await env.FTC_KV.list({ prefix: 'rows:', cursor: kvCursor, limit: 1000 })
          await Promise.all(result.keys.map(k => env.FTC_KV.delete(k.name)))
          if (result.list_complete) break
          kvCursor = result.cursor
        }

        // Reset meta — cron will refresh event list and start chunking
        await Promise.all([
          env.FTC_KV.delete('meta:events'),
          env.FTC_KV.delete('meta:events_full'),
          env.FTC_KV.delete('meta:active_events'),
          env.FTC_KV.put('meta:cursor',    '0'),
          env.FTC_KV.put('meta:last_sync', '0'),
        ])

        return json({
          ok: true,
          message: 'Reset complete. Cron will rebuild the full dataset over the next few minutes (20 events every 2 min).',
        }, 200, cors)
      } catch (e) {
        if (e.message === 'UNAUTHORIZED') return json({ error: 'UNAUTHORIZED' }, 401, cors)
        return json({ error: e.message }, 500, cors)
      }
    }

    // ── GET /status ────────────────────────────────────────
    if (path === '/status') {
      try {
        const [rawSync, rawCursor, rawCodes, rawActive] = await Promise.all([
          env.FTC_KV.get('meta:last_sync'),
          env.FTC_KV.get('meta:cursor'),
          env.FTC_KV.get('meta:events'),
          env.FTC_KV.get('meta:active_events'),
        ])

        const cursor       = parseInt(rawCursor ?? '0', 10)
        const allCodes     = rawCodes  ? JSON.parse(rawCodes)  : []
        const activeEvents = rawActive ? JSON.parse(rawActive) : []

        // Count synced event keys
        let syncedEvents = 0
        let kvCursor = undefined
        while (true) {
          const result = await env.FTC_KV.list({ prefix: 'rows:', cursor: kvCursor, limit: 1000 })
          syncedEvents += result.keys.length
          if (result.list_complete) break
          kvCursor = result.cursor
        }

        return json({
          lastSync:     parseInt(rawSync ?? '0', 10),
          cursor,
          totalEvents:  allCodes.length,
          syncedEvents,
          activeEvents: activeEvents.length,
          complete:     allCodes.length > 0 && syncedEvents >= allCodes.length,
        }, 200, cors)
      } catch (e) {
        return json({ error: e.message }, 500, cors)
      }
    }

    // ── Transparent proxy: /<season>/<anything> ────────────
    const proxyMatch = path.match(/^\/(\d{4})\/(.+)$/)
    if (proxyMatch) {
      try {
        const [, season, rest] = proxyMatch
        const ftcUrl = `${FTC_BASE}/${season}/${rest}${url.search}`
        const auth   = ftcAuth(env) ?? clientAuth
        if (!auth) return json({ error: 'UNAUTHORIZED' }, 401, cors)

        const ftcRes = await fetch(ftcUrl, {
          headers: { Authorization: auth, Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        })

        const body = await ftcRes.text()
        return new Response(body, {
          status: ftcRes.status,
          headers: { 'Content-Type': 'application/json', ...cors },
        })
      } catch (e) {
        return json({ error: e.message }, 502, cors)
      }
    }

    return json({ error: 'Not found' }, 404, cors)
  },
}