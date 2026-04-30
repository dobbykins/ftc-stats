import { useState, useCallback, useRef } from 'react'
import { ftcApi, hasCredentials, getCached, setCached } from '../api/ftc'
import { buildEpa, computeSeasonAccuracy, parseMatchRow } from '../utils/epa'

const SEASON = 2025
const CONCURRENCY = 8
const OFFSEASON_SFX   = ['OS', 'KO', 'SCRIMMAGE', 'DEMO', 'EXHIBITION']
const OFFSEASON_TYPES = ['offseason', 'kickoff', 'demonstration', 'workshop']

function isOffseason(code, type = '') {
  const u = (code || '').toUpperCase()
  return OFFSEASON_SFX.some(s => u.endsWith(s))
    || OFFSEASON_TYPES.includes((type || '').toLowerCase())
}

async function fetchEventRows(eventCode) {
  let result
  try {
    result = await ftcApi.getRetry(`/schedule/${eventCode}/qual/hybrid`)
  } catch (e) {
    return []
  }
  // ... existing qual parsing ...

  // ADD: fetch playoff matches too
  let playoffSchedule = []
  try {
    const playoffResult = await ftcApi.getRetry(`/schedule/${eventCode}/playoff/hybrid`)
    playoffSchedule = Array.isArray(playoffResult.schedule) ? playoffResult.schedule
                    : Array.isArray(playoffResult) ? playoffResult
                    : []
  } catch (_) {}

  const playoffScoreMap = {}
  if (playoffSchedule.length) {
    try {
      const scoresResult = await ftcApi.getRetry(`/scores/${eventCode}/playoff`)
      const scoresList = scoresResult.matchScores || scoresResult.scores || []
      for (const s of scoresList) {
        const num = s.matchNumber ?? s.matchNum
        if (num != null) playoffScoreMap[num] = s
      }
    } catch (_) {}
  }

  for (const m of playoffSchedule) {
    const row = parseMatchRow(SEASON, m, playoffScoreMap[m.matchNumber] ?? null, eventCode, 'playoff')
    if (row) rows.push(row)
  }

  return rows
}

// ── Synchronously build EPA state from cached rows ────────────────────────────
function buildStateFromRows(rows) {
  const result = buildEpa(rows, {})
  const seasonAccuracy = computeSeasonAccuracy(result.chronoSnapshots, result)
  return { ...result, rows, seasonAccuracy, loaded: true }
}

// ── Attempt to load and hydrate from localStorage cache on first render ───────
function loadCachedState() {
  try {
    const rows = getCached()
    if (rows?.length) return buildStateFromRows(rows)
  } catch {}
  return null
}

export function useEpaData() {
  // Initialize synchronously from cache — no loading spinner on revisit
  const [epaState, setEpaState] = useState(() => loadCachedState())
  const [loading, setLoading]   = useState(false)
  const [progress, setProgress] = useState(0)
  const [message, setMessage]   = useState('')
  const [error, setError]       = useState(null)
  const [needsCredentials, setNeedsCredentials] = useState(!hasCredentials())
  const loadingRef = useRef(false)

  const load = useCallback(async (forceRefresh = false) => {
    if (!hasCredentials()) { setNeedsCredentials(true); return }
    if (loadingRef.current) return
    // Already have data from cache and not forcing a refresh — do nothing
    if (!forceRefresh && epaState?.loaded) return
    loadingRef.current = true

    setLoading(true)
    setError(null)
    setProgress(5)

    try {
      // ── 1. Try cache first ────────────────────────────────────
      let rows = []
      if (!forceRefresh) {
        const cached = getCached()
        if (cached?.length) {
          rows = cached
          setMessage('Loaded from cache — computing EPA…')
        }
      }

      // ── 2. Full fetch if no cache / force refresh ─────────────
      if (!rows.length) {
        setMessage('Fetching event list…')
        let events = []
        try {
          const data = await ftcApi.getRetry('/events')
          events = data.events || []
        } catch (e) {
          if (e.message === 'UNAUTHORIZED') {
            setNeedsCredentials(true)
            setLoading(false)
            return
          }
          throw e
        }

        const qualifying = events.filter(ev => {
          const code = (ev.code || '').toUpperCase()
          const type = (ev.typeName || ev.type || '').toLowerCase()
          return !isOffseason(code, type)
        })

        setMessage(`Fetching ${qualifying.length} events…`)
        let idx = 0
        let completed = 0
        const allRows = []

        async function worker() {
          while (true) {
            let myIdx
            myIdx = idx++
            if (myIdx >= qualifying.length) break
            const ev = qualifying[myIdx]
            let evRows = []
            try {
              evRows = await fetchEventRows(ev.code)
            } catch (_) {}
            allRows.push(...evRows)
            completed++
            setProgress(Math.min(90, 10 + Math.round((completed / qualifying.length) * 78)))
            setMessage(`Fetching events… (${completed}/${qualifying.length}, ${allRows.length} matches so far)`)
          }
        }

        await Promise.all(Array.from({ length: CONCURRENCY }, worker))
        rows.push(...allRows)

        if (rows.length) setCached(rows)
      }

      if (!rows.length) {
        console.error('[useEpaData] all fetches returned empty — check proxy/events')
        setMessage('No data loaded — check credentials and proxy URL')
        setLoading(false)
        return
      }
      console.log('[useEpaData] rows loaded:', rows.length)

      // ── 3. Build EPA ──────────────────────────────────────────
      setProgress(94)
      setMessage('Computing EPA ratings…')
      const newState = buildStateFromRows(rows)

      setEpaState(newState)
      setProgress(100)
      setMessage('')

    } catch (e) {
      if (e.message === 'UNAUTHORIZED') {
        setNeedsCredentials(true)
      } else {
        setError(e.message)
      }
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [epaState?.loaded])

  return {
    state: epaState,
    loading, progress, message, error,
    needsCredentials, setNeedsCredentials,
    load,
  }
}