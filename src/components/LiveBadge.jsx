import styles from './LiveBadge.module.css'

export default function LiveBadge({ syncing, lastUpdated }) {
  return (
    <div className={styles.badge}>
      <span className={`${styles.dot} ${syncing ? styles.syncing : styles.live}`} />
      <span className={styles.label}>
        {syncing ? 'Syncing...' : lastUpdated
          ? `Live · ${lastUpdated.toLocaleTimeString()}`
          : 'Live'}
      </span>
    </div>
  )
}
