import styles from './StatCard.module.css'

export default function StatCard({ label, value, sub, accent }) {
  return (
    <div className={styles.card} style={accent ? { '--card-accent': accent } : {}}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value ?? '—'}</div>
      {sub && <div className={styles.sub}>{sub}</div>}
    </div>
  )
}
