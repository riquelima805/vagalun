import { useState, useEffect } from 'react'
import axios from 'axios'
import {
  Radio,
  Users,
  Clock,
  History,
  RefreshCw,
  AlertTriangle
} from 'lucide-react'
import { useTranslation } from '../i18n/LanguageContext'
import './NodeMonitor.css'

// URL base do signaling server (sever/server.js) — é um processo/porta
// SEPARADO do painel/hosting (ex: ws://signal.vagalun.shop, porta 8787).
// Configurável via .env do client: VITE_SIGNALING_HTTP_URL.
const SIGNALING_HTTP_URL = import.meta.env.VITE_SIGNALING_HTTP_URL || 'http://localhost:8787'
const ADMIN_TOKEN = import.meta.env.VITE_SIGNALING_ADMIN_TOKEN || ''

function formatDuration(sec) {
  const s = Number(sec || 0)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}min`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}h ${m}min`
}

function NodeMonitor() {
  const { t, lang } = useTranslation()
  const [active, setActive] = useState([])
  const [history, setHistory] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, 15000) // atualiza sozinho a cada 15s
    return () => clearInterval(interval)
  }, [])

  const headers = ADMIN_TOKEN ? { 'X-Admin-Token': ADMIN_TOKEN } : {}

  const fetchAll = async () => {
    setError('')
    try {
      const [nodesRes, historyRes, statsRes] = await Promise.all([
        axios.get(`${SIGNALING_HTTP_URL}/nodes`, { headers }),
        axios.get(`${SIGNALING_HTTP_URL}/nodes/history?limit=50`, { headers }),
        axios.get(`${SIGNALING_HTTP_URL}/nodes/stats`, { headers })
      ])
      setActive(nodesRes.data.active || [])
      setHistory(historyRes.data.history || [])
      setStats(statsRes.data)
    } catch (err) {
      setError(
        err.response?.status === 401
          ? t('nodes.error.unauthorized')
          : t('nodes.error.connection')
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="node-monitor">
      <div className="node-monitor-container">

        <div className="node-monitor-header">
          <div>
            <h1>{t('nodes.title')}</h1>
            <p>{t('nodes.subtitle')}</p>
          </div>
          <button className="btn-secondary" onClick={fetchAll}>
            <RefreshCw size={15} />
            {t('nodes.refresh')}
          </button>
        </div>

        {error && (
          <div className="node-monitor-alert">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="node-monitor-loading">
            <div className="loading-spinner"></div>
            <span>{t('nodes.loading')}</span>
          </div>
        ) : (
          <>
            {/* RESUMO */}
            <div className="node-summary">

              <div className="summary-card">
                <div className="summary-icon tone-ok"><Radio size={19} /></div>
                <div>
                  <span>{t('nodes.activeNow')}</span>
                  <strong>{stats?.activeCount ?? active.length}</strong>
                </div>
              </div>

              <div className="summary-card">
                <div className="summary-icon"><Users size={19} /></div>
                <div>
                  <span>{t('nodes.everSeen')}</span>
                  <strong>{stats?.totalKnownNodes ?? '—'}</strong>
                </div>
              </div>

              <div className="summary-card">
                <div className="summary-icon"><Clock size={19} /></div>
                <div>
                  <span>{t('nodes.avgOnline')}</span>
                  <strong>{stats ? formatDuration(stats.avgSessionSec) : '—'}</strong>
                </div>
              </div>

              <div className="summary-card">
                <div className="summary-icon"><History size={19} /></div>
                <div>
                  <span>{t('nodes.closedSessions')}</span>
                  <strong>{stats?.closedSessionsCount ?? '—'}</strong>
                </div>
              </div>

            </div>

            {/* NÓS ATIVOS */}
            <div className="card full-width">
              <div className="card-heading">
                <div>
                  <h3>{t('nodes.activeNowCount', { n: active.length })}</h3>
                  <p>{t('nodes.activeNowDesc')}</p>
                </div>
              </div>

              {active.length === 0 ? (
                <p className="node-monitor-empty">{t('nodes.noneConnected')}</p>
              ) : (
                <div className="node-table-wrapper">
                  <table className="node-table">
                    <thead>
                      <tr>
                        <th>{t('nodes.table.node')}</th>
                        <th>{t('nodes.table.connectedSince')}</th>
                        <th>{t('nodes.table.timeOnline')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {active.map((n) => (
                        <tr key={n.nodeId}>
                          <td className="cell-mono">{n.nodeId}</td>
                          <td>{n.connectedAt ? new Date(n.connectedAt).toLocaleString(lang === 'en' ? 'en-US' : 'pt-BR') : '—'}</td>
                          <td>
                            <span className="node-badge tone-ok">{formatDuration(n.uptimeSec)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* HISTÓRICO / ENCERRADOS */}
            <div className="card full-width">
              <div className="card-heading">
                <div>
                  <h3>{t('nodes.closedSessionsCount', { n: history.length })}</h3>
                  <p>{t('nodes.closedSessionsDesc')}</p>
                </div>
              </div>

              {history.length === 0 ? (
                <p className="node-monitor-empty">{t('nodes.noClosedSessions')}</p>
              ) : (
                <div className="node-table-wrapper">
                  <table className="node-table">
                    <thead>
                      <tr>
                        <th>{t('nodes.table.node')}</th>
                        <th>{t('nodes.table.connected')}</th>
                        <th>{t('nodes.table.disconnected')}</th>
                        <th>{t('nodes.table.duration')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((s, i) => (
                        <tr key={`${s.nodeId}-${s.disconnectedAt}-${i}`}>
                          <td className="cell-mono">{s.nodeId}</td>
                          <td>{new Date(s.connectedAt).toLocaleString(lang === 'en' ? 'en-US' : 'pt-BR')}</td>
                          <td>{new Date(s.disconnectedAt).toLocaleString(lang === 'en' ? 'en-US' : 'pt-BR')}</td>
                          <td>
                            <span className="node-badge tone-muted">{formatDuration(s.durationSec)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

      </div>
    </main>
  )
}

export default NodeMonitor
