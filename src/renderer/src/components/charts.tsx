export function WinChart({ points }: { points: { day: string; success: number; failure: number; paused: number }[] }) {
  const rows = points.slice(-14)
  const max = Math.max(1, ...rows.map((point) => point.success))
  const width = 520
  const height = 140
  const step = rows.length > 1 ? width / (rows.length - 1) : width
  const line = rows.map((point, index) => `${index * step},${height - (point.success / max) * (height - 16)}`).join(" ")
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Wins over time">
      <polyline fill="none" stroke="var(--ok)" strokeWidth="3" points={line || `0,${height}`} />
      {rows.map((point, index) => (
        <g key={point.day}>
          <circle cx={index * step} cy={height - (point.success / max) * (height - 16)} r="3.5" fill="var(--ok)" />
          <text x={index * step} y={height} fill="var(--muted)" fontSize="11" textAnchor="middle">{point.day.slice(5)}</text>
        </g>
      ))}
    </svg>
  )
}

export function SpendChart({ rows }: { rows: { name: string; spend: number }[] }) {
  const max = Math.max(1, ...rows.map((row) => row.spend))
  return (
    <div className="hbar-list" aria-label="Spend per store">
      {rows.length === 0 ? <p className="hint">No spend recorded yet.</p> : rows.map((row) => (
        <div key={row.name} className="hbar-row">
          <span>{row.name}</span>
          <div className="hbar-track"><div className="hbar-fill" style={{ width: `${Math.max(4, (row.spend / max) * 100)}%` }} /></div>
          <strong>${row.spend.toFixed(0)}</strong>
        </div>
      ))}
    </div>
  )
}

export function SpeedChart({ rows }: { rows: { name: string; ms: number }[] }) {
  const max = Math.max(1, ...rows.map((row) => row.ms))
  return (
    <div className="hbar-list" aria-label="Monitor speed by store">
      {rows.length === 0 ? <p className="hint">Monitor times show up after stock checks.</p> : rows.map((row) => (
        <div key={row.name} className="hbar-row">
          <span>{row.name}</span>
          <div className="hbar-track"><div className="hbar-fill speed" style={{ width: `${Math.max(4, (row.ms / max) * 100)}%` }} /></div>
          <strong>{row.ms} ms</strong>
        </div>
      ))}
    </div>
  )
}
