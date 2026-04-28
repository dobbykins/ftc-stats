import { useState } from 'react'
import { useLiveData } from '../hooks/useLiveData'
import { ftcApi } from '../api/ftc'
import EPAChart from '../components/EPAChart'
import StatCard from '../components/StatCard'
import styles from './Teams.module.css'

import { getStats } from '../utils/epa'
export default function Teams({ epa }) {
  const [teamNumber, setTeamNumber] = useState('')
  const [submitted, setSubmitted] = useState(null)

  const { data, loading, error } = useLiveData(
    () => submitted ? ftcApi.getTeam(submitted) : Promise.resolve(null),
    [submitted],
    0 // no polling for team lookup
  )

  const team = data?.teams?.[0]

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Team Lookup</h1>

      <div className={styles.searchRow}>
        <input
          className={styles.input}
          placeholder="Enter team number..."
          value={teamNumber}
          onChange={e => setTeamNumber(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && setSubmitted(teamNumber)}
        />
        <button className={styles.btn} onClick={() => setSubmitted(teamNumber)}>
          Search
        </button>
      </div>

      {loading && <div className={styles.state}>Loading team data...</div>}
      {error && <div className={styles.error}>{error}</div>}

      {team && (
        <div className={styles.profile}>
          <div className={styles.profileHeader}>
            <div>
              <div className={styles.teamNum}>#{team.teamNumber}</div>
              <h2 className={styles.teamName}>{team.nameShort || team.nameFull}</h2>
              <div className={styles.teamMeta}>{team.city}, {team.stateProv} · {team.schoolName}</div>
            </div>
          </div>

          <div className={styles.cards}>
            <StatCard label="Rookie Year" value={team.rookieYear} />
            <StatCard label="Location" value={`${team.city}, ${team.stateProv}`} />
            <StatCard label="Country" value={team.country} />
          </div>

          <div className={styles.chartSection}>
            <div className={styles.chartLabel}>EPA History (current season)</div>
            <EPAChart data={(team && epa?.state ? (getStats(team.teamNumber, epa.state)?.epa_history ?? []) : [])} />
            <div className={styles.chartNote}>
              EPA history populates after the team plays matches at a tracked event.
            </div>
          </div>
        </div>
      )}

      {submitted && !loading && !team && !error && (
        <div className={styles.state}>Team {submitted} not found.</div>
      )}
    </div>
  )
}
