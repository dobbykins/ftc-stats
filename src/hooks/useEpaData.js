import { useState, useCallback, useRef, useEffect } from 'react'
import { ftcApi, hasCredentials, getCached, setCached, getLastSync, setLastSync } from '../api/ftc'
import { buildEpa, computeSeasonAccuracy, parseMatchRow } from '../utils/epa'

const SEASON = 2025
const DELTA_INTERVAL = 30_000  // poll for changes every 30s

// ── Build EPA state from rows ──────────────────────────────
function buildStateFromRows(rows) {
  const result = buildEpa(rows, {})
  const seasonAccuracy = computeSeasonAccuracy(result.chronoSnapshots, result)
  return { ...result, rows, seasonAccuracy, loaded: true }
}

// ── Merge incoming rows into existing set ──────────────────
// Rows are keyed by match string (e.g. "USMIFL-Q3")
function mergeRows(existing, incoming) {
  if (!incoming.length) return existing
  const map = new Map(existing.map(r => [r.match, r]))
  for (const row of incoming) map.set(row.match, row)
  return [...map.values()]
}

// ── Load cached state synchronously on first render ───────
function loadCachedState() {
  try {
    const rows = getCached()
    if (rows?.length) return buildStateFromRows(rows)
  } catch {}
  return null
}

export function useEpaData() {
  const [epaState, setEpaState]           = useState(() => loadCachedState())
  const [loading, setLoading]             = useState(false)
  const [progress, setProgress]           = useState(0)
  const [message, setMessage]             = useState('')
  const [error, setError]                 = useState(null)
  const [needsCredentials, setNeedsCredentials] = useState(!hasCredentials())
  const [lastSyncTime, setLastSyncTime]   = useState(() => getLastSync())

  const loadingRef  = useRef(false)
  const deltaTimer  = useRef(null)
  const isMounted   = useRef(true)

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
      clearInterval(deltaTimer.current)
    }
  }, [])

  // ── Delta poll: runs every 30s once data is loaded ────────
  const startDeltaPolling = useCallback((syncTime) => {
    clearInterval(deltaTimer.current)
    deltaTimer.current = setInterval(async () => {
      if (!isMounted.current || !hasCredentials()) return
      try {
        const result = await ftcApi.getDelta(syncTime)
        if (!result.hasChanges || !result.rows?.length) {
          // Update our local syncTime even if no changes
          if (result.syncTime > syncTime) {
            syncTime = result.syncTime
            setLastSyncTime(syncTime)
            setLastSync(syncTime)
          }
          return
        }

        // Merge new rows into existing state
        setEpaState(prev => {
          if (!prev?.rows) return prev
          const merged = mergeRows(prev.rows, result.rows)
          setCached(merged)
          return buildStateFromRows(merged)
        })

        syncTime = result.syncTime
        setLastSyncTime(syncTime)
        setLastSync(syncTime)
      } catch (e) {
        console.warn('[delta poll] failed:', e.message)
      }
    }, DELTA_INTERVAL)
  }, [])

  // ── Main load function ─────────────────────────────────────
  const load = useCallback(async (forceRefresh = false) => {
    console.log('[load] creds:', hasCredentials(), 'loading:', loadingRef.current)
    if (!hasCredentials()) { setNeedsCredentials(true); return }
    if (loadingRef.current) return
    if (!forceRefresh && epaState?.loaded) {
      // Already have data — just make sure delta polling is running
      startDeltaPolling(lastSyncTime)
      return
    }

    loadingRef.current = true
    setLoading(true)
    setError(null)
    setProgress(5)

    try {
      let rows     = []
      let syncTime = 0

      if (!forceRefresh) {
        // ── 1. Try localStorage cache first (instant) ──────
        const cached = getCached()
        if (cached?.length) {
          rows     = cached
          syncTime = getLastSync()
          setMessage('Loaded from cache — computing EPA…')
          setProgress(80)
        }
      }

      if (!rows.length || forceRefresh) {
        // ── 2. Fetch full dataset from worker /bulk ────────
        setMessage('Fetching full dataset from worker…')
        setProgress(10)

        try {
          const result = await ftcApi.getBulk()
          rows     = result.rows ?? []
          syncTime = result.syncTime ?? Date.now()

          if (rows.length) {
            setCached(rows)
            setLastSync(syncTime)
          }
          setProgress(85)
          setMessage(`Loaded ${rows.length} matches — computing EPA…`)
        } catch (e) {
          if (e.message === 'UNAUTHORIZED') {
            setNeedsCredentials(true)
            setLoading(false)
            loadingRef.current = false
            return
          }
          throw e
        }
      }
      
      if (!rows.length) {
        setMessage('No data — check credentials and worker URL')
        setLoading(false)
        loadingRef.current = false
        return
      }

      // ── 3. Build EPA ────────────────────────────────────
      setProgress(94)
      setMessage('Computing EPA ratings…')
      const newState = buildStateFromRows(rows)

      if (isMounted.current) {
        setEpaState(newState)
        setLastSyncTime(syncTime)
        setProgress(100)
        setMessage('')

        // Start polling for incremental updates
        startDeltaPolling(syncTime)
      }
    } catch (e) {
      if (e.message === 'UNAUTHORIZED') {
        setNeedsCredentials(true)
      } else {
        setError(e.message)
      }
    } finally {
      if (isMounted.current) setLoading(false)
      loadingRef.current = false
    }
  }, [epaState?.loaded, lastSyncTime, startDeltaPolling])

  return {
    state: epaState,
    loading, progress, message, error,
    needsCredentials, setNeedsCredentials,
    lastSyncTime,
    load,
  }
}