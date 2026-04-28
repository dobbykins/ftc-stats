import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveData } from '../hooks/useLiveData'
import { ftcApi } from '../api/ftc'
import LiveBadge from '../components/LiveBadge'
import styles from './Events.module.css'

export default function Events() {
  const [search, setSearch] = useState('')
  const { data, loading, error, lastUpdated, syncing } = useLiveData(
  () => ftcApi.getRetry('/events'),
  [],
  60000
)

  const events = data?.events ?? data ?? []
  const filtered = events.filter(e =>
    e.name?.toLowerCase().includes(search.toLowerCase()) ||
    e.code?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Events</h1>
          <p className={styles.sub}>2025–26 Decode season</p>
        </div>
        <LiveBadge syncing={syncing} lastUpdated={lastUpdated} />
      </div>

      <input
        className={styles.search}
        placeholder="Search events..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      {loading && <div className={styles.state}>Loading events...</div>}
      {error && <div className={styles.error}>Error: {error}</div>}

      <div className={styles.list}>
        {filtered.map(event => (
          <Link key={event.code} to={`/events/${event.code}`} className={styles.row}>
            <div>
              <div className={styles.eventName}>{event.name}</div>
              <div className={styles.eventMeta}>
                {event.code} · {event.city}, {event.stateprov} · {new Date(event.dateStart).toLocaleDateString()}
              </div>
            </div>
            <div className={styles.arrow}>→</div>
          </Link>
        ))}
        {!loading && !error && filtered.length === 0 && (
          <div className={styles.state}>No events found.</div>
        )}
      </div>
    </div>
  )
}
