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
          ? 'Token de admin do signaling server inválido ou ausente (VITE_SIGNALING_ADMIN_TOKEN).'
          : 'Não foi possível conectar ao signaling server. Confira VITE_SIGNALING_HTTP_URL.'
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
            <h1>Nós da rede</h1>
            <p>Nós P2P (app Android) conectados ao signaling server, em tempo real.</p>
          </div>
          <button className="btn-secondary" onClick={fetchAll}>
            <RefreshCw size={15} />
            Atualizar
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
            <span>Carregando...</span>
          </div>
        ) : (
          <>
            {/* RESUMO */}
            <div className="node-summary">

              <div className="summary-card">
                <div className="summary-icon tone-ok"><Radio size={19} /></div>
                <div>
                  <span>Nós ativos agora</span>
                  <strong>{stats?.activeCount ?? active.length}</strong>
                </div>
              </div>

              <div className="summary-card">
                <div className="summary-icon"><Users size={19} /></div>
                <div>
                  <span>Nós já vistos na rede</span>
                  <strong>{stats?.totalKnownNodes ?? '—'}</strong>
                </div>
              </div>

              <div className="summary-card">
                <div className="summary-icon"><Clock size={19} /></div>
                <div>
                  <span>Tempo médio online</span>
                  <strong>{stats ? formatDuration(stats.avgSessionSec) : '—'}</strong>
                </div>
              </div>

              <div className="summary-card">
                <div className="summary-icon"><History size={19} /></div>
                <div>
                  <span>Sessões encerradas (total)</span>
                  <strong>{stats?.closedSessionsCount ?? '—'}</strong>
                </div>
              </div>

            </div>

            {/* NÓS ATIVOS */}
            <div className="card full-width">
              <div className="card-heading">
                <div>
                  <h3>Ativos agora ({active.length})</h3>
                  <p>Conectados neste momento ao signaling server</p>
                </div>
              </div>

              {active.length === 0 ? (
                <p className="node-monitor-empty">Nenhum nó conectado agora.</p>
              ) : (
                <div className="node-table-wrapper">
                  <table className="node-table">
                    <thead>
                      <tr>
                        <th>Nó (ID)</th>
                        <th>Conectado desde</th>
                        <th>Tempo online</th>
                      </tr>
                    </thead>
                    <tbody>
                      {active.map((n) => (
                        <tr key={n.nodeId}>
                          <td className="cell-mono">{n.nodeId}</td>
                          <td>{n.connectedAt ? new Date(n.connectedAt).toLocaleString('pt-BR') : '—'}</td>
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
                  <h3>Sessões encerradas (últimas {history.length})</h3>
                  <p>Nós que já desconectaram, com o tempo que ficaram online</p>
                </div>
              </div>

              {history.length === 0 ? (
                <p className="node-monitor-empty">Nenhuma sessão encerrada ainda.</p>
              ) : (
                <div className="node-table-wrapper">
                  <table className="node-table">
                    <thead>
                      <tr>
                        <th>Nó (ID)</th>
                        <th>Conectou</th>
                        <th>Desconectou</th>
                        <th>Duração</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((s, i) => (
                        <tr key={`${s.nodeId}-${s.disconnectedAt}-${i}`}>
                          <td className="cell-mono">{s.nodeId}</td>
                          <td>{new Date(s.connectedAt).toLocaleString('pt-BR')}</td>
                          <td>{new Date(s.disconnectedAt).toLocaleString('pt-BR')}</td>
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
