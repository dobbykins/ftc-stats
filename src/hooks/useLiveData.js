import { useState, useEffect, useRef, useCallback } from 'react'

export function useLiveData(fetchFn, deps = [], interval = 30000) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const timerRef = useRef(null)

  const fetch_ = useCallback(async (isBackground = false) => {
    if (isBackground) setSyncing(true)
    else setLoading(true)
    setError(null)
    try {
      const result = await fetchFn()
      setData(result)
      setLastUpdated(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      setSyncing(false)
    }
  }, deps)

  useEffect(() => {
    fetch_(false)
    timerRef.current = setInterval(() => fetch_(true), interval)
    return () => clearInterval(timerRef.current)
  }, [fetch_, interval])

  return { data, loading, error, lastUpdated, syncing, refetch: () => fetch_(false) }
}
