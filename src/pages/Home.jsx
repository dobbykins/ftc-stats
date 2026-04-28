import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { hasCredentials } from '../api/ftc'
import styles from './Home.module.css'

export default function Home({ epa, onSetCredentials }) {
  const { state, loading, load } = epa

  // Auto-load on first visit if credentials are already saved
  useEffect(() => {
    if (!state?.loaded && !loading && hasCredentials()) {
      load()
    }
  }, [])

  const loaded = state?.loaded
  const acc    = state?.seasonAccuracy

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.tag}>2025–26 · Decode Season</div>
        <h1 className={styles.title}>FTC<br /><span>Stats</span></h1>
        <p className={styles.sub}>
          Live EPA ratings, match predictions, and team analytics
          <br />for the FIRST Tech Challenge.
        </p>
        <div className={styles.actions}>
          {loaded
            ? <Link to="/rankings" className={styles.btn}>View Rankings →</Link>
            : <button className={styles.btn} onClick={onSetCredentials}>Connect API →</button>
          }
          <Link to="/events" className={styles.btnGhost}>Browse Events</Link>
        </div>
        {loaded && acc && (
          <div className={styles.accPill}>
            🎯 Season accuracy: <strong>{acc.pct}%</strong>
            <span> ({acc.correct}/{acc.total} matches · excl. cold starts)</span>
          </div>
        )}
      </div>

      <div className={styles.grid}>
        {[
          { label: 'EPA Ratings',       desc: 'Expected Points Added per robot — Statbotics methodology adapted for FTC\'s 2v2 format and short seasons.' },
          { label: 'Live Sync',         desc: 'Auto-polls the FTC Events API every 30s via your Cloudflare Worker. No manual refresh needed.' },
          { label: 'Win Predictions',   desc: 'Momentum-blended EPA with auto-stability correction and a calibrated Elo scale derived from actual match margins.' },
          { label: 'Sub-EPA Breakdown', desc: 'Auto, teleop, pattern, and park sub-EPAs plus trend and UEPA tier for every team.' },
        ].map(f => (
          <div key={f.label} className={styles.feature}>
            <div className={styles.featureLabel}>{f.label}</div>
            <div className={styles.featureDesc}>{f.desc}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
