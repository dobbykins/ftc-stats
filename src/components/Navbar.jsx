import { Link, useLocation } from 'react-router-dom'
import styles from './Navbar.module.css'

const links = [
  { to: '/', label: 'Home' },
  { to: '/rankings', label: 'Rankings' },
  { to: '/events', label: 'Events' },
  { to: '/teams', label: 'Teams' },
]

export default function Navbar({ onCredentials, epaLoaded, onRefresh }) {
  const { pathname } = useLocation()
  return (
    <nav className={styles.nav}>
      <Link to="/" className={styles.logo}>
        FTC<span>Stats</span>
      </Link>
      <div className={styles.links}>
        {links.map(l => (
          <Link
            key={l.to}
            to={l.to}
            className={`${styles.link} ${pathname === l.to ? styles.active : ''}`}
          >
            {l.label}
          </Link>
        ))}
      </div>
      <div className={styles.right}>
        {epaLoaded && (
          <button className={styles.refreshBtn} onClick={onRefresh} title="Force refresh data">
            ↺
          </button>
        )}
        <button className={styles.credsBtn} onClick={onCredentials}>
          API Key
        </button>
      </div>
    </nav>
  )
}
