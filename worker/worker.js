/**
 * FTC Stats Cloudflare Worker
 *
 * Endpoints:
 *   GET /bulk              → full dataset from KV
 *   GET /delta?since=<ts>  → rows changed since timestamp
 *   GET /force-sync        → resets cursor so cron rebuilds dataset
 *   GET /<season>/*        → transparent proxy to FTC Events API
 *
 * KV bindings (set in wrangler.toml):
 *   FTC_KV  → stores rows, etags, sync timestamps
 *
 * Secrets (set via `wrangler secret put`):
 *   FTC_USER  → your FIRST username
 *   FTC_KEY   → your FIRST API key
 *
 * Cron: runs every 2 minutes
 *   - Refreshes event list every 24h
 *   - Syncs CHUNK_SIZE events per run (rolling cursor)
 *   - Full dataset (~880 events) built in ~35 min on first run
 *
 * wrangler.toml cron:
 *   [triggers]
 *   crons = ["*\/2 * * * *"]
 */

const FTC_BASE    = 'https://ftc-api.firstinspires.org/v2.0'
const SEASON      = 2025
const CONCURRENCY = 10
const CHUNK_SIZE  = 50   // events per cron tick

const KV_KEYS = {
  allRows:      'all_rows_v1',
  lastSync:     'last_sync_time',
  activeEvents: 'active_events',
  allEvents:    'all_events',    // full filtered event code list
  allEventsMeta:'all_events_meta', // full event objects (for dateEnd)
  syncCursor:   'sync_cursor',   // index into allEvents for chunked sync
}

const OFFSEASON_SFX   = ['OS', 'KO', 'SCRIMMAGE', 'DEMO', 'EXHIBITION']
const OFFSEASON_TYPES = ['offseason', 'kickoff', 'demonstration', 'workshop']

// ── Helpers ───────────────────────────────────────────────

function isOffseason(code = '', type = '') {
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

async function ftcFetch(path, env, clientAuth = null) {
  const auth = ftcAuth(env) ?? clientAuth
  if (!auth) throw new Error('No auth available')

  const url = `${FTC_BASE}/${SEASON}${path}`
  const res = await fetch(url, {
    headers: { Authorization: auth, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })

  if (res.status === 401) throw new Error('UNAUTHORIZED')
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
  let scheduleResult
  try {
    scheduleResult = await ftcFetch(`/schedule/${eventCode}/qual/hybrid`, env, clientAuth)
  } catch {
    return []
  }

  const schedule = Array.isArray(scheduleResult.schedule) ? scheduleResult.schedule
                 : Array.isArray(scheduleResult)          ? scheduleResult
                 : []

  const scoreMap = {}
  for (const m of schedule) {
    if (m.scoreRedFinal != null) {
      scoreMap[m.matchNumber] = { alliances: m.alliances ?? [] }
    }
  }

  const needsScores = schedule.some(m => m.scoreRedFinal != null && !m.alliances)
  if (needsScores) {
    try {
      const scoresResult = await ftcFetch(`/scores/${eventCode}/qual`, env, clientAuth)
      const scoresList = scoresResult.matchScores ?? scoresResult.scores ?? []
      for (const s of scoresList) {
        const num = s.matchNumber ?? s.matchNum
        if (num != null) scoreMap[num] = s
      }
    } catch { /* non-fatal */ }
  }

  const rows = []
  for (const m of schedule) {
    const row = parseMatchRow(m, scoreMap[m.matchNumber] ?? null, eventCode)
    if (row) rows.push(row)
  }
  return rows
}

// ── Fetch + cache event list ──────────────────────────────

async function refreshEventList(env, clientAuth = null) {
  const data   = await ftcFetch('/events', env, clientAuth)
  const events = (data.events ?? []).filter(ev =>
    !isOffseason(ev.code, ev.typeName ?? ev.type ?? '')
  )
  const codes = events.map(ev => ev.code)

  await Promise.all([
    env.FTC_KV.put(KV_KEYS.allEvents,    JSON.stringify(codes)),
    env.FTC_KV.put(KV_KEYS.allEventsMeta, JSON.stringify(events)),
    env.FTC_KV.put(KV_KEYS.syncCursor,   '0'),
  ])

  return { codes, events }
}

// ── Chunked sync (one cron tick) ──────────────────────────

async function chunkSync(env) {
  // 1. Get or refresh event list (refresh every 24h)
  const [rawEvents, rawMeta, rawSync] = await Promise.all([
    env.FTC_KV.get(KV_KEYS.allEvents),
    env.FTC_KV.get(KV_KEYS.allEventsMeta),
    env.FTC_KV.get(KV_KEYS.lastSync),
  ])

  const age = Date.now() - parseInt(rawSync ?? '0', 10)
  let allCodes, allMeta

  if (!rawEvents || age > 1000 * 60 * 60 * 24) {
    console.log('[cron] refreshing event list')
    const result = await refreshEventList(env)
    allCodes = result.codes
    allMeta  = result.events
  } else {
    allCodes = JSON.parse(rawEvents)
    allMeta  = rawMeta ? JSON.parse(rawMeta) : []
  }

  if (!allCodes.length) {
    console.log('[cron] no events found')
    return { changed: 0, cursor: 0, total: 0 }
  }

  // 2. Get cursor
  const cursor     = parseInt((await env.FTC_KV.get(KV_KEYS.syncCursor)) ?? '0', 10)
  const chunk      = allCodes.slice(cursor, cursor + CHUNK_SIZE)
  const nextCursor = cursor + CHUNK_SIZE >= allCodes.length ? 0 : cursor + CHUNK_SIZE

  if (!chunk.length) {
    await env.FTC_KV.put(KV_KEYS.syncCursor, '0')
    return { changed: 0, cursor: 0, total: allCodes.length }
  }

  // 3. Fetch rows for this chunk concurrently
  const freshRows = []
  let idx = 0
  async function worker() {
    while (idx < chunk.length) {
      const code = chunk[idx++]
      const rows = await fetchEventRows(code, env)
      freshRows.push(...rows)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  // 4. Merge into existing KV rows
  const rawRows      = await env.FTC_KV.get(KV_KEYS.allRows)
  const existingRows = rawRows ? JSON.parse(rawRows) : []
  const chunkSet     = new Set(chunk.map(c => c.toUpperCase()))
  const baseRows     = existingRows.filter(r => !chunkSet.has(r.event))
  const merged       = [...baseRows, ...freshRows]

  // 5. Update active events (those whose dateEnd is in the future)
  const now = new Date()
  const activeEvents = allMeta
    .filter(ev => new Date(ev.dateEnd) >= now)
    .map(ev => ev.code)

  const syncTime = Date.now()
  await Promise.all([
    env.FTC_KV.put(KV_KEYS.allRows,       JSON.stringify(merged)),
    env.FTC_KV.put(KV_KEYS.lastSync,      syncTime.toString()),
    env.FTC_KV.put(KV_KEYS.syncCursor,    nextCursor.toString()),
    env.FTC_KV.put(KV_KEYS.activeEvents,  JSON.stringify(activeEvents)),
  ])

  console.log(`[cron] chunk ${cursor}–${cursor + chunk.length - 1}/${allCodes.length} | ${freshRows.length} rows | cursor→${nextCursor}`)
  return { changed: freshRows.length, cursor: nextCursor, total: allCodes.length, syncTime }
}

// ── Delta sync (active events only, used between chunks) ──

async function deltaSync(env) {
  const [rawRows, rawActive] = await Promise.all([
    env.FTC_KV.get(KV_KEYS.allRows),
    env.FTC_KV.get(KV_KEYS.activeEvents),
  ])

  const existingRows = rawRows  ? JSON.parse(rawRows)  : []
  const activeEvents = rawActive ? JSON.parse(rawActive) : []
  if (!activeEvents.length) return { changed: 0 }

  const freshRows = []
  let idx = 0
  async function worker() {
    while (idx < activeEvents.length) {
      const code = activeEvents[idx++]
      const rows = await fetchEventRows(code, env)
      freshRows.push(...rows)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const activeSet = new Set(activeEvents.map(c => c.toUpperCase()))
  const baseRows  = existingRows.filter(r => !activeSet.has(r.event))
  const merged    = [...baseRows, ...freshRows]

  const syncTime = Date.now()
  await Promise.all([
    env.FTC_KV.put(KV_KEYS.allRows,  JSON.stringify(merged)),
    env.FTC_KV.put(KV_KEYS.lastSync, syncTime.toString()),
  ])

  return { changed: freshRows.length, syncTime }
}

// ── Request handler ───────────────────────────────────────

export default {
  // ── Cron trigger ────────────────────────────────────────
  async scheduled(_event, env, _ctx) {
    try {
      // If there are active events, do a delta sync first for freshness,
      // then advance the chunk cursor for full coverage
      const rawActive = await env.FTC_KV.get(KV_KEYS.activeEvents)
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

  // ── HTTP handler ─────────────────────────────────────────
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
        const [rawRows, rawSync] = env.FTC_KV
          ? await Promise.all([
              env.FTC_KV.get(KV_KEYS.allRows),
              env.FTC_KV.get(KV_KEYS.lastSync),
            ])
          : [null, null]

        if (!rawRows) {
          // KV empty — trigger first chunk synchronously so client gets something
          const result = await chunkSync(env)
          const rows   = result.changed ? JSON.parse(await env.FTC_KV.get(KV_KEYS.allRows)) : []
          return json({ rows, syncTime: result.syncTime ?? Date.now(), partial: true }, 200, cors)
        }

        const rows     = JSON.parse(rawRows)
        const syncTime = parseInt(rawSync ?? '0', 10)

        // Also include sync progress info so the UI can show "X% synced"
        const rawCursor = await env.FTC_KV.get(KV_KEYS.syncCursor)
        const rawTotal  = await env.FTC_KV.get(KV_KEYS.allEvents)
        const cursor    = parseInt(rawCursor ?? '0', 10)
        const total     = rawTotal ? JSON.parse(rawTotal).length : 0
        const synced    = total > 0 ? Math.min(cursor, total) : total
        const complete  = total === 0 || cursor === 0  // cursor wraps to 0 when done

        return json({ rows, syncTime, synced, total, complete }, 200, cors)
      } catch (e) {
        if (e.message === 'UNAUTHORIZED') return json({ error: 'UNAUTHORIZED' }, 401, cors)
        return json({ error: e.message }, 500, cors)
      }
    }

    // ── GET /delta?since=<timestamp> ───────────────────────
    if (path === '/delta') {
      try {
        const since = parseInt(url.searchParams.get('since') ?? '0', 10)

        const [rawRows, rawSync] = env.FTC_KV
          ? await Promise.all([
              env.FTC_KV.get(KV_KEYS.allRows),
              env.FTC_KV.get(KV_KEYS.lastSync),
            ])
          : [null, null]

        const syncTime = parseInt(rawSync ?? '0', 10)

        if (rawRows && syncTime > since) {
          const allRows = JSON.parse(rawRows)
          const changedEvents = new Set(
            allRows
              .filter(r => r.mt && new Date(r.mt).getTime() > since)
              .map(r => r.event)
          )
          const deltaRows = changedEvents.size > 0
            ? allRows.filter(r => changedEvents.has(r.event))
            : []

          return json({ rows: deltaRows, syncTime, hasChanges: deltaRows.length > 0 }, 200, cors)
        }

        return json({ rows: [], syncTime, hasChanges: false }, 200, cors)
      } catch (e) {
        return json({ error: e.message }, 500, cors)
      }
    }

    // ── GET /force-sync ────────────────────────────────────
    // Resets cursor + clears event list so cron does a full rebuild.
    // Does NOT block — returns immediately.
    if (path === '/force-sync') {
      try {
        if (!ftcAuth(env)) return json({ error: 'No auth available — set FTC_USER and FTC_KEY secrets' }, 401, cors)

        await Promise.all([
          env.FTC_KV.delete(KV_KEYS.allEvents),
          env.FTC_KV.delete(KV_KEYS.allEventsMeta),
          env.FTC_KV.put(KV_KEYS.syncCursor, '0'),
        ])

        // Kick off first chunk synchronously so there's something in KV fast
        const result = await chunkSync(env)
        const rawRows = await env.FTC_KV.get(KV_KEYS.allRows)
        const currentRows = rawRows ? JSON.parse(rawRows).length : 0

        return json({
          ok: true,
          message: `First chunk synced (${result.changed} rows). Cron will continue building the full dataset every 2 min.`,
          rowsInKV: currentRows,
          cursor: result.cursor,
          total: result.total,
        }, 200, cors)
      } catch (e) {
        if (e.message === 'UNAUTHORIZED') return json({ error: 'UNAUTHORIZED' }, 401, cors)
        return json({ error: e.message }, 500, cors)
      }
    }

    // ── GET /status ────────────────────────────────────────
    // Shows sync progress without downloading all rows
    if (path === '/status') {
      try {
        const [rawSync, rawCursor, rawEvents, rawRows] = await Promise.all([
          env.FTC_KV.get(KV_KEYS.lastSync),
          env.FTC_KV.get(KV_KEYS.syncCursor),
          env.FTC_KV.get(KV_KEYS.allEvents),
          env.FTC_KV.get(KV_KEYS.allRows),
        ])
        const cursor   = parseInt(rawCursor ?? '0', 10)
        const allCodes = rawEvents ? JSON.parse(rawEvents) : []
        const rowCount = rawRows   ? JSON.parse(rawRows).length : 0
        return json({
          lastSync:   parseInt(rawSync ?? '0', 10),
          cursor,
          totalEvents: allCodes.length,
          rowsInKV:   rowCount,
          complete:   allCodes.length === 0 || cursor === 0,
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