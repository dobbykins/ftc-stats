/**
 * FTC Stats Cloudflare Worker — D1 edition
 *
 * Endpoints:
 *   GET /bulk              → full dataset from D1
 *   GET /delta?since=<ts>  → rows changed since timestamp
 *   GET /force-sync        → wipes D1 tables so cron rebuilds dataset
 *   GET /status            → sync progress info
 *   GET /<season>/*        → transparent proxy to FTC Events API
 *
 * D1 binding (set in wrangler.toml):
 *   FTC_DB  → your D1 database
 *
 * Secrets (set via `wrangler secret put`):
 *   FTC_USER  → your FIRST username
 *   FTC_KEY   → your FIRST API key
 *
 * D1 schema (run schema.sql once via `wrangler d1 execute FTC_DB --file=schema.sql`):
 *   match_rows   → one row per match (replaces rows:ALL)
 *   events       → one row per event (replaces meta:events_full)
 *   meta         → key/value pairs   (replaces all meta:* KV keys)
 *
 * Subrequest budget (Cloudflare free plan = 50 per invocation):
 *   - CHUNK_SIZE  = 20  events per cron tick
 *   - CONCURRENCY = 3   parallel fetches
 *   - fetchEventRows makes AT MOST 2 subrequests per event
 *   - Worst case: 20 events × 2 = 40 subrequests — safely under 50.
 *   - /bulk is now a single D1 SELECT — no subrequest problem.
 *
 * Schema migration required (run once before deploying this version):
 *   ALTER TABLE match_rows ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
 *   CREATE INDEX IF NOT EXISTS idx_match_rows_updated_at ON match_rows(updated_at);
 */

const FTC_BASE    = 'https://ftc-api.firstinspires.org/v2.0'
const SEASON      = 2025
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

  const hasEmbeddedScores = schedule.some(m => m.scoreRedFinal != null)
  const scoreMap = {}

  if (hasEmbeddedScores) {
    for (const m of schedule) {
      if (m.scoreRedFinal != null) {
        scoreMap[m.matchNumber] = { alliances: m.alliances ?? [] }
      }
    }
  } else {
    try {
      const scoresResult = await ftcFetch(`/scores/${eventCode}/qual`, env, clientAuth)
      const scoresList = scoresResult.matchScores ?? scoresResult.scores ?? []
      for (const s of scoresList) {
        const num = s.matchNumber ?? s.matchNum
        if (num != null) scoreMap[num] = s
      }
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
    } catch {}
  }

  const rows = []
  for (const m of schedule) {
    const row = parseMatchRow(m, scoreMap[m.matchNumber] ?? null, eventCode)
    if (row) rows.push(row)
  }
  return rows
}

// ── D1 meta helpers (replaces KV meta:* keys) ────────────

async function getMeta(env, key) {
  const row = await env.FTC_DB.prepare('SELECT value FROM meta WHERE key = ?')
    .bind(key)
    .first()
  return row?.value ?? null
}

async function setMeta(env, key, value) {
  await env.FTC_DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, value).run()
}

async function deleteMeta(env, key) {
  await env.FTC_DB.prepare('DELETE FROM meta WHERE key = ?').bind(key).run()
}

// ── D1 row helpers (replaces rows:ALL KV key) ─────────────

/**
 * Read all rows back out as parsed JS objects.
 * Arrays (rt, bt) are stored as JSON strings in D1 and re-parsed here
 * so callers get the same shape as the old KV implementation.
 */
async function getAllRows(env) {
  const { results } = await env.FTC_DB.prepare('SELECT * FROM match_rows').all()
  return results.map(deserializeRow)
}

/**
 * Upsert a batch of rows into D1.
 * D1 has a max of 100 bound parameters per statement and a max batch size,
 * so we chunk into groups of 50 and use batched prepared statements.
 *
 * updated_at is set to the current UTC time on every upsert so that the
 * /delta endpoint can filter by "rows touched since last sync" rather than
 * by match start time (mt), which is semantically wrong for delta queries.
 */
async function upsertRows(env, rows) {
  if (!rows.length) return

  const BATCH = 50
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const stmts = chunk.map(row => {
      const s = serializeRow(row)
      return env.FTC_DB.prepare(`
        INSERT INTO match_rows
          (match_id, season, event, match, rt, bt, rs, bs, ra, ba,
           rtot, btot, rf, bf, won, mt, level, match_num,
           r_pat_pts, b_pat_pts, r_park_pts, b_park_pts, r_nav_pts, b_nav_pts,
           updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(match_id) DO UPDATE SET
          rs         = excluded.rs,
          bs         = excluded.bs,
          ra         = excluded.ra,
          ba         = excluded.ba,
          rtot       = excluded.rtot,
          btot       = excluded.btot,
          rf         = excluded.rf,
          bf         = excluded.bf,
          won        = excluded.won,
          mt         = excluded.mt,
          r_pat_pts  = excluded.r_pat_pts,
          b_pat_pts  = excluded.b_pat_pts,
          r_park_pts = excluded.r_park_pts,
          b_park_pts = excluded.b_park_pts,
          r_nav_pts  = excluded.r_nav_pts,
          b_nav_pts  = excluded.b_nav_pts,
          updated_at = excluded.updated_at
      `).bind(
        s.match_id, s.season, s.event, s.match, s.rt, s.bt,
        s.rs, s.bs, s.ra, s.ba, s.rtot, s.btot, s.rf, s.bf,
        s.won, s.mt, s.level, s.match_num,
        s.r_pat_pts, s.b_pat_pts, s.r_park_pts, s.b_park_pts,
        s.r_nav_pts, s.b_nav_pts,
        s.updated_at,
      )
    })
    await env.FTC_DB.batch(stmts)
  }
}

/** Flatten arrays to JSON strings for D1 storage */
function serializeRow(row) {
  return {
    match_id:   row.match,
    season:     row.season,
    event:      row.event,
    match:      row.match,
    rt:         JSON.stringify(row.rt),
    bt:         JSON.stringify(row.bt),
    rs:         row.rs,
    bs:         row.bs,
    ra:         row.ra,
    ba:         row.ba,
    rtot:       row.rtot,
    btot:       row.btot,
    rf:         row.rf,
    bf:         row.bf,
    won:        row.won,
    mt:         row.mt,
    level:      row.level,
    match_num:  row.matchNum,
    r_pat_pts:  row.rPatPts,
    b_pat_pts:  row.bPatPts,
    r_park_pts: row.rParkPts,
    b_park_pts: row.bParkPts,
    r_nav_pts:  row.rNavPts,
    b_nav_pts:  row.bNavPts,
    updated_at: new Date().toISOString(),  // wall-clock time of this upsert
  }
}

/** Re-inflate D1 row back to the shape the React app expects */
function deserializeRow(row) {
  return {
    season:   row.season,
    event:    row.event,
    match:    row.match,
    rt:       JSON.parse(row.rt),
    bt:       JSON.parse(row.bt),
    rs:       row.rs,
    bs:       row.bs,
    ra:       row.ra,
    ba:       row.ba,
    rtot:     row.rtot,
    btot:     row.btot,
    rf:       row.rf,
    bf:       row.bf,
    won:      row.won,
    mt:       row.mt,
    level:    row.level,
    matchNum: row.match_num,
    rPatPts:  row.r_pat_pts,
    bPatPts:  row.b_pat_pts,
    rParkPts: row.r_park_pts,
    bParkPts: row.b_park_pts,
    rNavPts:  row.r_nav_pts,
    bNavPts:  row.b_nav_pts,
  }
}

// ── Event list management ─────────────────────────────────

async function refreshEventList(env, clientAuth = null) {
  const data   = await ftcFetch('/events', env, clientAuth)
  const events = (data.events ?? []).filter(ev =>
    !isOffseason(ev.code, ev.typeName ?? ev.type ?? '')
  )

  // Upsert all events into the events table
  const BATCH = 50
  for (let i = 0; i < events.length; i += BATCH) {
    const chunk = events.slice(i, i + BATCH)
    const stmts = chunk.map(ev =>
      env.FTC_DB.prepare(`
        INSERT INTO events (code, name, type_name, city, stateprov, country, date_start, date_end)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          name       = excluded.name,
          type_name  = excluded.type_name,
          city       = excluded.city,
          stateprov  = excluded.stateprov,
          country    = excluded.country,
          date_start = excluded.date_start,
          date_end   = excluded.date_end
      `).bind(
        ev.code,
        ev.name ?? null,
        ev.typeName ?? ev.type ?? null,
        ev.city ?? null,
        ev.stateProv ?? ev.stateprov ?? null,
        ev.country ?? null,
        ev.dateStart ?? null,
        ev.dateEnd ?? null,
      )
    )
    await env.FTC_DB.batch(stmts)
  }

  await setMeta(env, 'cursor', '0')

  return { codes: events.map(ev => ev.code), events }
}

// ── Chunked sync ──────────────────────────────────────────

async function chunkSync(env, clientAuth = null) {
  const [rawSync, rawCursor] = await Promise.all([
    getMeta(env, 'last_sync'),
    getMeta(env, 'cursor'),
  ])

  const age = Date.now() - parseInt(rawSync ?? '0', 10)
  let allCodes, allMeta

  if (!rawCursor || age > 1000 * 60 * 60 * 24) {
    console.log('[cron] refreshing event list')
    const result = await refreshEventList(env, clientAuth)
    allCodes = result.codes
    allMeta  = result.events
  } else {
    // Read from D1 events table instead of KV
    const { results } = await env.FTC_DB.prepare('SELECT code, date_end FROM events ORDER BY rowid').all()
    allCodes = results.map(r => r.code)
    allMeta  = results
  }

  if (!allCodes.length) return { changed: 0, cursor: 0, total: 0 }

  const cursor     = parseInt(rawCursor ?? '0', 10)
  const chunk      = allCodes.slice(cursor, cursor + CHUNK_SIZE)
  const nextCursor = cursor + CHUNK_SIZE >= allCodes.length ? 0 : cursor + CHUNK_SIZE

  if (!chunk.length) {
    await setMeta(env, 'cursor', '0')
    return { changed: 0, cursor: 0, total: allCodes.length }
  }

  // Fetch rows for this chunk with capped concurrency
  const newRows = []
  let idx = 0
  async function worker() {
    while (idx < chunk.length) {
      const code = chunk[idx++]
      const rows = await fetchEventRows(code, env, clientAuth)
      newRows.push(...rows)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  // Upsert into D1 — ON CONFLICT handles deduplication
  await upsertRows(env, newRows)

  // Update active events and advance cursor
  const now = new Date()
  const activeEvents = allMeta
    .filter(ev => new Date(ev.dateEnd ?? ev.date_end) >= now)
    .map(ev => ev.code)

  const syncTime = Date.now()
  await Promise.all([
    setMeta(env, 'last_sync',     syncTime.toString()),
    setMeta(env, 'cursor',        nextCursor.toString()),
    setMeta(env, 'active_events', JSON.stringify(activeEvents)),
  ])

  console.log(`[cron] chunk ${cursor}–${cursor + chunk.length - 1}/${allCodes.length} | ${newRows.length} rows | cursor→${nextCursor}`)
  return { changed: newRows.length, cursor: nextCursor, total: allCodes.length, syncTime }
}

// ── Delta sync (active events only) ──────────────────────

async function deltaSync(env) {
  const rawActive = await getMeta(env, 'active_events')
  const active    = rawActive ? JSON.parse(rawActive) : []
  if (!active.length) return { changed: 0 }

  const newRows = []
  let idx = 0

  async function worker() {
    while (idx < active.length) {
      const code = active[idx++]
      const rows = await fetchEventRows(code, env)
      newRows.push(...rows)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  if (newRows.length > 0) {
    await upsertRows(env, newRows)
  }

  const syncTime = Date.now()
  await setMeta(env, 'last_sync', syncTime.toString())
  return { changed: newRows.length, syncTime }
}

// ── Request handler ───────────────────────────────────────

export default {
  async scheduled(_event, env, _ctx) {
    try {
      const rawActive = await getMeta(env, 'active_events')
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

        const [rawSync, rawCursor] = await Promise.all([
          getMeta(env, 'last_sync'),
          getMeta(env, 'cursor'),
        ])

        const syncTime = parseInt(rawSync ?? '0', 10)
        const cursor   = parseInt(rawCursor ?? '0', 10)

        // Count total events from D1
        const countRow = await env.FTC_DB.prepare('SELECT COUNT(*) AS n FROM events').first()
        const total    = countRow?.n ?? 0
        const complete = total === 0 || cursor === 0

        if (!syncTime) {
          // First request ever — kick off an initial chunk sync
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
        const rawSync  = await getMeta(env, 'last_sync')
        const syncTime = parseInt(rawSync ?? '0', 10)

        if (syncTime <= since) {
          return json({ rows: [], syncTime, hasChanges: false }, 200, cors)
        }

        // Filter by updated_at (wall-clock upsert time) rather than mt (match
        // start time). This ensures matches scored after their start time —
        // e.g. late score entry, corrections — are always included in deltas.
        const sinceISO = new Date(since).toISOString()
        const { results } = await env.FTC_DB.prepare(`
          SELECT * FROM match_rows
          WHERE updated_at > ?
        `).bind(sinceISO).all()

        const deltaRows = results.map(deserializeRow)
        return json({ rows: deltaRows, syncTime, hasChanges: deltaRows.length > 0 }, 200, cors)
      } catch (e) {
        return json({ error: e.message }, 500, cors)
      }
    }

    // ── GET /force-sync ────────────────────────────────────
    if (path === '/force-sync') {
      try {
        if (!ftcAuth(env)) {
          return json({ error: 'No auth — set FTC_USER and FTC_KEY secrets' }, 401, cors)
        }

        // Wipe all data so cron rebuilds from scratch
        await env.FTC_DB.batch([
          env.FTC_DB.prepare('DELETE FROM match_rows'),
          env.FTC_DB.prepare('DELETE FROM events'),
          env.FTC_DB.prepare('DELETE FROM meta'),
        ])

        return json({
          ok: true,
          message: 'Reset complete. Cron will refresh the event list and rebuild all rows over the next ~20 min (20 events every 2 min).',
        }, 200, cors)
      } catch (e) {
        if (e.message === 'UNAUTHORIZED') return json({ error: 'UNAUTHORIZED' }, 401, cors)
        return json({ error: e.message }, 500, cors)
      }
    }

    // ── GET /status ────────────────────────────────────────
    if (path === '/status') {
      try {
        const [rawSync, rawCursor, rawActive, totalEventsRow, totalRowsRow] = await Promise.all([
          getMeta(env, 'last_sync'),
          getMeta(env, 'cursor'),
          getMeta(env, 'active_events'),
          env.FTC_DB.prepare('SELECT COUNT(*) AS n FROM events').first(),
          env.FTC_DB.prepare('SELECT COUNT(*) AS n FROM match_rows').first(),
        ])

        const cursor       = parseInt(rawCursor ?? '0', 10)
        const activeEvents = rawActive ? JSON.parse(rawActive) : []

        return json({
          lastSync:     parseInt(rawSync ?? '0', 10),
          cursor,
          totalEvents:  totalEventsRow?.n ?? 0,
          activeEvents: activeEvents.length,
          totalRows:    totalRowsRow?.n ?? 0,
          complete:     cursor === 0 && (totalRowsRow?.n ?? 0) > 0,
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