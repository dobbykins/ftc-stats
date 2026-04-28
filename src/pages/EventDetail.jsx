import { useParams } from 'react-router-dom'
import { useState } from 'react'
import { useLiveData } from '../hooks/useLiveData'
import { ftcApi } from '../api/ftc'
import { epaWinProb, getStats } from '../utils/epa'
import LiveBadge from '../components/LiveBadge'
import StatCard from '../components/StatCard'
import styles from './EventDetail.module.css'

const TABS = ['Rankings', 'Matches', 'Predictions']

export default function EventDetail({ epa }) {
  const { eventCode } = useParams()
  const [tab, setTab] = useState('Rankings')

  const rankings = useLiveData(
    () => ftcApi.getRankings(eventCode),
    [eventCode], 30000
  )
  const matches = useLiveData(
    () => ftcApi.getHybridSchedule(eventCode, 'qual'),
    [eventCode], 30000
  )

  const rankData = rankings.data?.Rankings ?? rankings.data?.rankings ?? []
  const matchData = (matches.data?.schedule ?? [])
  const played   = matchData.filter(m => m.scoreRedFinal !== null)
  const upcoming = matchData.filter(m => m.scoreRedFinal === null)
  const syncing  = rankings.syncing || matches.syncing
  const lastUpdated = rankings.lastUpdated

  // Top team EPA from global state
  const topTeam = rankData[0]?.team
  const topStats = topTeam && epa?.state ? getStats(topTeam, epa.state) : null

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.code}>{eventCode}</div>
          <h1 className={styles.title}>Event Dashboard</h1>
        </div>
        <LiveBadge syncing={syncing} lastUpdated={lastUpdated} />
      </div>

      <div className={styles.stats}>
        <StatCard label="Teams" value={rankData.length} />
        <StatCard label="Matches Played" value={played.length} />
        <StatCard label="Matches Remaining" value={upcoming.length} accent="var(--accent-2)" />
        {topStats
          ? <StatCard label="Top EPA" value={topStats.epa.toFixed(1)} sub={`Team ${topTeam} · ${topStats.uepa_label}`} accent="var(--green)" />
          : <StatCard label="Rank 1" value={topTeam ?? '—'} sub="OPR rank" accent="var(--green)" />
        }
      </div>

      <div className={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.active : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Rankings'   && <RankingsTable data={rankData} loading={rankings.loading} error={rankings.error} epa={epa} />}
      {tab === 'Matches'    && <MatchList matches={matchData} loading={matches.loading} error={matches.error} />}
      {tab === 'Predictions'&& <PredictionList upcoming={upcoming} epa={epa} />}
    </div>
  )
}

// ── Rankings tab ──────────────────────────────────────────
function RankingsTable({ data, loading, error, epa }) {
  if (loading) return <div className={styles.state}>Loading rankings…</div>
  if (error)   return <div className={styles.error}>{error}</div>
  if (!data.length) return <div className={styles.state}>No rankings yet.</div>

  return (
    <div className={styles.table}>
      <div className={styles.tableHead}>
        <span>#</span>
        <span>Team</span>
        <span>W-L-T</span>
        <span>Rank Pts</span>
        <span>EPA</span>
        <span>Tier</span>
      </div>
      {data.map((r, i) => {
        const stats = epa?.state ? getStats(r.team, epa.state) : null
        return (
          <div key={r.team} className={styles.tableRow}>
            <span className={styles.rank}>{i + 1}</span>
            <span className={styles.teamCell}><strong>{r.team}</strong></span>
            <span className={styles.mono}>{r.wins}-{r.losses}-{r.ties}</span>
            <span className={styles.mono}>{r.rankingPoints}</span>
            <span className={styles.mono} style={{ color: 'var(--accent)' }}>
              {stats ? stats.epa.toFixed(1) : '—'}
            </span>
            <span className={styles.mono} style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
              {stats?.uepa_label ?? '—'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Matches tab ───────────────────────────────────────────
function MatchList({ matches, loading, error }) {
  if (loading) return <div className={styles.state}>Loading matches…</div>
  if (error)   return <div className={styles.error}>{error}</div>
  if (!matches.length) return <div className={styles.state}>No matches yet.</div>

  return (
    <div className={styles.matchList}>
      {matches.map(m => {
        const isPlayed = m.scoreRedFinal !== null
        const redTeams  = m.teams?.filter(t => t.station?.startsWith('Red')).map(t => t.teamNumber) ?? []
        const blueTeams = m.teams?.filter(t => t.station?.startsWith('Blue')).map(t => t.teamNumber) ?? []
        return (
          <div key={m.matchNumber} className={`${styles.match} ${!isPlayed ? styles.upcoming : ''}`}>
            <div className={styles.matchNum}>Q{m.matchNumber}</div>
            <div className={styles.alliance} style={{ color: 'var(--red)' }}>
              {redTeams.join(' · ')}
            </div>
            <div className={styles.scores}>
              {isPlayed ? (
                <>
                  <span style={{ color: 'var(--red)', fontWeight: 700 }}>{m.scoreRedFinal}</span>
                  <span style={{ color: 'var(--text-muted)' }}>—</span>
                  <span style={{ color: 'var(--blue)', fontWeight: 700 }}>{m.scoreBlueFinal}</span>
                </>
              ) : (
                <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>UPCOMING</span>
              )}
            </div>
            <div className={styles.alliance} style={{ color: 'var(--blue)', textAlign: 'right' }}>
              {blueTeams.join(' · ')}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Predictions tab ───────────────────────────────────────
function PredictionList({ upcoming, epa }) {
  if (!upcoming.length) return <div className={styles.state}>No upcoming matches to predict.</div>

  const hasEpa = !!epa?.state
  if (!hasEpa) {
    return (
      <div className={styles.state}>
        Load global EPA data first to see win probabilities.
      </div>
    )
  }

  return (
    <div className={styles.matchList}>
      {upcoming.map(m => {
        const redTeams  = m.teams?.filter(t => t.station?.startsWith('Red')).map(t => t.teamNumber)  ?? []
        const blueTeams = m.teams?.filter(t => t.station?.startsWith('Blue')).map(t => t.teamNumber) ?? []

        const redWinProb  = epaWinProb(redTeams, blueTeams, epa.state)
        const blueWinProb = 1 - redWinProb
        const redEPA  = redTeams.reduce((s, t)  => s + (epa.state.ratings[t]  ?? epa.state.seasonAvg * 0.88), 0)
        const blueEPA = blueTeams.reduce((s, t) => s + (epa.state.ratings[t]  ?? epa.state.seasonAvg * 0.88), 0)

        return (
          <div key={m.matchNumber} className={styles.prediction}>
            <div className={styles.matchNum}>Q{m.matchNumber}</div>

            <div className={styles.predTeams}>
              <span style={{ color: 'var(--red)' }}>{redTeams.join(' · ')}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>vs</span>
              <span style={{ color: 'var(--blue)' }}>{blueTeams.join(' · ')}</span>
            </div>

            <div className={styles.predBar}>
              <div className={styles.redBar} style={{ width: `${(redWinProb * 100).toFixed(0)}%` }}>
                {(redWinProb * 100).toFixed(0)}%
              </div>
              <div className={styles.blueBar} style={{ width: `${(blueWinProb * 100).toFixed(0)}%` }}>
                {(blueWinProb * 100).toFixed(0)}%
              </div>
            </div>

            <div className={styles.predEPA}>
              <span style={{ color: 'var(--red)' }}>{redEPA.toFixed(1)}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>EPA</span>
              <span style={{ color: 'var(--blue)' }}>{blueEPA.toFixed(1)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
