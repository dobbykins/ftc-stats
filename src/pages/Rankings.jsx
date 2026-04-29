import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { getStats, epaWinProb, uepaLabel, mean, toU } from '../utils/epa'
import styles from './Rankings.module.css'

const TIER_COLORS = {
  '99-100':     '#fbbf24', '79-70':    '#a78bfa',
  '90-90': '#3b82f6', '69-60':   '#22c55e',
  '89-80': '#fb923c', '59-0':'#6b7280',
}

export default function Rankings({ epa }) {
  const { state, loading, message, error } = epa
  const [search, setSearch]   = useState('')
  const [sortCol, setSortCol] = useState('epa')
  const [sortDir, setSortDir] = useState(-1)
  const [tierFilter, setTierFilter] = useState('')

  const ranked = useMemo(() => {
    if (!state?.ratings) return []
    return Object.keys(state.ratings)
      .map(t => getStats(+t, state))
      .filter(Boolean)
      .sort((a, b) => b.epa - a.epa)
      .map((t, i) => ({ ...t, rank: i + 1 }))
  }, [state])

  const displayed = useMemo(() => {
    let rows = [...ranked]
    if (search) rows = rows.filter(t => String(t.team).includes(search))
    if (tierFilter) rows = rows.filter(t => t.uepa_label === tierFilter)
    rows.sort((a, b) => sortDir * (b[sortCol] - a[sortCol]))
    return rows
  }, [ranked, search, tierFilter, sortCol, sortDir])

  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => -d)
    else { setSortCol(col); setSortDir(-1) }
  }

  const epas = ranked.map(t => t.epa)
  const avgE = mean(epas).toFixed(1)
  const maxE = Math.max(...epas, 0).toFixed(1)
  const acc = state?.seasonAccuracy

  if (!state?.loaded && !loading) {
    {error && <div style={{color:'red',padding:'1rem'}}>{error}</div>}
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>No data loaded</div>
          <div className={styles.emptyDesc}>Set your API credentials to load rankings.</div>
        </div>
      </div>
    )
  }

  if (loading && !state?.loaded) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <div className={styles.spinner} />
          <div className={styles.emptyDesc}>{message || 'Loading…'}</div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Team Rankings</h1>
          <p className={styles.desc}>EPA · Decode 2025–26</p>
        </div>
      </div>

      <div className={styles.stats}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Teams</div>
          <div className={styles.statVal} style={{ color: 'var(--blue)' }}>{ranked.length}</div>
          <div className={styles.statSub}>{state?.rows?.length ?? 0} matches</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Avg EPA</div>
          <div className={styles.statVal}>{avgE}</div>
          <div className={styles.statSub}>per robot · foul-adjusted</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Peak EPA</div>
          <div className={styles.statVal} style={{ color: 'var(--green)' }}>{maxE}</div>
          <div className={styles.statSub}>top performer</div>
        </div>
        {acc && (
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Season Acc.</div>
            <div className={styles.statVal} style={{ color: acc.pct >= 73 ? 'var(--green)' : acc.pct >= 68 ? 'var(--blue)' : 'var(--accent-2)' }}>
              {acc.pct}%
            </div>
            <div className={styles.statSub}>{acc.correct}/{acc.total} · excl. cold starts</div>
          </div>
        )}
        </div>

      <div className={styles.filters}>
        <input
          className={styles.search}
          placeholder="Search team #…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className={styles.tierPills}>
          {['', '99-100', '90-99', '75-90', '50-75', '25-50', '0-25'].map(tier => (
            <button
              key={tier}
              className={`${styles.pill} ${tierFilter === tier ? styles.pillActive : ''}`}
              onClick={() => setTierFilter(tier)}
              style={tier && tierFilter === tier ? { borderColor: TIER_COLORS[tier], color: TIER_COLORS[tier] } : {}}
            >
              {tier || 'All'}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {[
                { k: 'rank', l: '#' }, { k: 'team', l: 'Team' },
                { k: 'epa', l: 'Net EPA' }, { k: 'uepa', l: 'UEPA' },
                { k: 'uepa_label', l: 'Tier' }, { k: 'auto_epa', l: 'Auto EPA' },
                { k: 'teleop_epa', l: 'Teleop' }, 
              ].map(col => (
                <th key={col.k} onClick={() => toggleSort(col.k)}
                  className={sortCol === col.k ? styles.sorted : ''}>
                  {col.l} {sortCol === col.k ? (sortDir < 0 ? '↓' : '↑') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayed.map(t => (
              <tr key={t.team}>
                <td className={styles.mono} style={{ color: 'var(--text-muted)' }}>{t.rank}</td>
                <td><strong>{t.team}</strong></td>
                <td className={styles.mono}>
                  {t.epa.toFixed(2)}
                  <span className={styles.epaBar}>
                    <span className={styles.epaFill} style={{ width: `${Math.min(100, (t.epa / (epas[0] || 1)) * 100)}%` }} />
                  </span>
                </td>
                <td className={styles.mono}>{t.uepa.toFixed(2)}</td>
                <td>
                  <span className={styles.tier} style={{ color: TIER_COLORS[t.uepa_label], borderColor: TIER_COLORS[t.uepa_label] + '40', background: TIER_COLORS[t.uepa_label] + '15' }}>
                    {t.uepa_label}
                  </span>
                </td>
                <td className={styles.mono}>{t.auto_epa.toFixed(2)}</td>
                <td className={styles.mono}>{t.teleop_epa.toFixed(2)}</td>
                <td className={styles.mono} style={{ color: 'var(--text-muted)' }}>{t.matches}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {displayed.length === 0 && (
          <div className={styles.emptyTable}>No teams match the current filter.</div>
        )}
      </div>
    </div>
  )
}
