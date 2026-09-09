import { useEffect, useState } from 'react'
import { Radio, Clock, DollarSign, Server, Film } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'
import { api } from '../api/client'

export default function Overview() {
  const { t } = useI18n()
  const o = t.overview
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.overview().then(setData).catch((e) => setError(e.message))
  }, [])

  const stats = data ? [
    { label: 'Vídeos publicados', value: String(data.videosCount), sub: 'sua conta', icon: Film, color: 'var(--primary)' },
    { label: o.minutesMonth, value: data.minutesDeliveredTotal.toLocaleString(), sub: 'minutos entregues (VOD)', icon: Clock, color: 'var(--secondary)' },
    { label: o.spendMonth, value: `$${data.balance}`, sub: Number(data.balance) < 0 ? 'saldo devedor' : 'saldo disponível', icon: DollarSign, color: 'var(--success)' },
    { label: o.nodesOnline, value: data.nodesOnline === null ? '—' : String(data.nodesOnline), sub: data.nodesOnline === null ? 'signaling não configurado' : 'celulares conectados agora', icon: Server, color: 'var(--warning)' },
  ] : []

  return (
    <div>
      <h1 className="section-title">{o.title}</h1>
      <p className="section-sub">{o.subtitle}</p>

      {error && <div className="card" style={{ marginBottom: 20, color: 'var(--danger, #f87171)' }}>Não consegui carregar dados do backend: {error}</div>}

      {!data && !error && <div className="card">carregando...</div>}

      {data && (
        <div className="stat-grid" style={{ marginBottom: 28 }}>
          {stats.map((s, i) => {
            const Icon = s.icon
            return (
              <div className="stat-card" key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div className="stat-label">{s.label}</div>
                  <Icon size={16} color={s.color} />
                </div>
                <div className="stat-value">{s.value}</div>
                <div className="stat-sub">{s.sub}</div>
              </div>
            )
          })}
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <Radio size={17} color="var(--primary)" />
          <h3 style={{ fontSize: 15 }}>Lives ativas</h3>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
          Streams ao vivo rodam pelo pc-node (RTMP/HTTP-FLV) — gere e monitore em <b>{t.nav.streams}</b>. Vídeo estático (upload) fica em <b>Vídeos</b>.
        </p>
      </div>
    </div>
  )
}
