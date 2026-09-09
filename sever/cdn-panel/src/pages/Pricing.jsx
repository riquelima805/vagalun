import { useState, useMemo } from 'react'
import { Calculator } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'

export default function Pricing() {
  const { t } = useI18n()
  const p = t.pricing
  const [viewers, setViewers] = useState(100)
  const [minutes, setMinutes] = useState(1000)

  const cost = useMemo(() => {
    const v = Number(viewers) || 0
    const m = Number(minutes) || 0
    return (m / 1000) * v * 0.5
  }, [viewers, minutes])

  return (
    <div>
      <h1 className="section-title">{p.title}</h1>
      <p className="section-sub">{p.subtitle}</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 20 }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center', gap: 10, background: 'var(--dev-bg)', color: 'var(--dev-text)' }}>
          <div style={{ fontSize: 42, fontWeight: 800, color: 'var(--dev-accent)' }} className="mono">{p.price}</div>
          <div style={{ color: 'var(--dev-text-dim)', fontSize: 13, maxWidth: 260 }}>{p.unit}</div>
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--dev-text-dim)' }}>{p.relay}: {p.relayPrice}</div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <Calculator size={17} color="var(--primary)" />
            <h3 style={{ fontSize: 14.5 }}>{p.calcTitle}</h3>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
            <div>
              <label className="field-label">{p.viewers}</label>
              <input type="number" value={viewers} onChange={e => setViewers(e.target.value)} />
            </div>
            <div>
              <label className="field-label">{p.minutes}</label>
              <input type="number" value={minutes} onChange={e => setMinutes(e.target.value)} />
            </div>
          </div>
          <div className="code-panel" style={{ marginBottom: 12 }}>
            <span className="dim">cost</span> = (minutes ÷ 1000) × viewers × <span className="accent">$0.50</span><br />
            <span className="dim">cost</span> = ({minutes} ÷ 1000) × {viewers} × 0.50 = <span className="green">${cost.toFixed(2)}</span>
          </div>
          <div style={{ fontSize: 26, fontWeight: 800 }} className="mono">${cost.toFixed(2)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>{p.estCost}</div>
          <p style={{ fontSize: 12.5, marginTop: 14 }}>{p.note}</p>
        </div>
      </div>
    </div>
  )
}
