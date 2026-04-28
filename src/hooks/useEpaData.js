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

  const schedule = Array.isArray(result.schedule) ? result.schedule
                 : Array.isArray(result)           ? result
                 : []

  // Build score detail map for penalty-accurate EPA
  const scoreMap = {}
  try {
    const scoresResult = await ftcApi.getRetry(`/scores/${eventCode}/qual`)
    const scoresList = scoresResult.matchScores || scoresResult.scores || []
    for (const s of scoresList) {
      const num = s.matchNumber ?? s.matchNum
      if (num != null) scoreMap[num] = s
    }
  } catch (_) {}

  const rows = []
  for (const m of schedule) {
    const row = parseMatchRow(SEASON, m, scoreMap[m.matchNumber] ?? null, eventCode)
    if (row) rows.push(row)
  }
  return rows
}

export function useEpaData() {
  const [epaState, setEpaState] = useState(null)
  const [loading, setLoading]   = useState(false)
  const [progress, setProgress] = useState(0)
  const [message, setMessage]   = useState('')
  const [error, setError]       = useState(null)
  const [needsCredentials, setNeedsCredentials] = useState(!hasCredentials())
  const loadingRef = useRef(false)

  const load = useCallback(async (forceRefresh = false) => {
    if (!hasCredentials()) { setNeedsCredentials(true); return }
    if (loadingRef.current) return
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
            // Atomic-safe: push result set, then update counters
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
      const result = buildEpa(rows, {})
      const seasonAccuracy = computeSeasonAccuracy(result.chronoSnapshots, result)

      setEpaState({ ...result, rows, seasonAccuracy, loaded: true })
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
  }, [])
  
  return {
    state: epaState,
    loading, progress, message, error,
    needsCredentials, setNeedsCredentials,
    load,
  }
}
