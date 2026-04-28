import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--bg-3)',
      border: '1px solid var(--border)',
      borderRadius: 4,
      padding: '0.5rem 0.75rem',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.7rem',
      color: 'var(--text)'
    }}>
      <div style={{ color: 'var(--text-muted)' }}>Match {label}</div>
      <div>EPA: <strong>{payload[0].value?.toFixed(2)}</strong></div>
    </div>
  )
}

export default function EPAChart({ data, color = 'var(--accent)' }) {
  if (!data?.length) return (
    <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>
      No data yet
    </div>
  )

  const avg = data.reduce((s, d) => s + d.epa, 0) / data.length

  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <XAxis dataKey="match" tick={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontFamily: 'var(--font-mono)', fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
        <Tooltip content={<CustomTooltip />} />
        <ReferenceLine y={avg} stroke="var(--border)" strokeDasharray="4 4" />
        <Line type="monotone" dataKey="epa" stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4, fill: color }} />
      </LineChart>
    </ResponsiveContainer>
  )
}
