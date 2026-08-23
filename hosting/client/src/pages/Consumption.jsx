import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import {
  Wallet,
  TrendingDown,
  CalendarClock,
  AlertTriangle,
  Snowflake,
  CheckCircle2,
  ArrowRight
} from 'lucide-react'
import './Consumption.css'

// Formata um valor MB pra exibição amigável (GB quando grande).
function formatMB(n) {
  const v = Number(n || 0)
  if (v >= 1024) return `${(v / 1024).toFixed(1)} GB`
  return `${v.toFixed(2)} MB`
}

function statusLabel(status) {
  switch (status) {
    case 'ok': return { text: 'Cobrado normalmente', tone: 'ok' }
    case 'insufficient_partial': return { text: 'Saldo zerou nesse dia', tone: 'warning' }
    case 'frozen': return { text: 'Sites congelados', tone: 'danger' }
    default: return { text: status || '—', tone: 'ok' }
  }
}

function Consumption({ token }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchHistory()
  }, [])

  const fetchHistory = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await axios.get('/api/billing/history?days=30', {
        headers: { Authorization: `Bearer ${token}` }
      })
      setData(response.data)
    } catch (err) {
      setError(err.response?.data?.error || 'Não foi possível carregar o histórico de consumo.')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <main className="consumption">
        <div className="consumption-loading">
          <div className="loading-spinner"></div>
          <span>Carregando consumo...</span>
        </div>
      </main>
    )
  }

  if (error || !data) {
    return (
      <main className="consumption">
        <div className="consumption-error card">
          <AlertTriangle size={22} />
          <p>{error || 'Sem dados de consumo.'}</p>
        </div>
      </main>
    )
  }

  const history = [...(data.history || [])].reverse() // mais recente primeiro
  const maxCost = Math.max(...history.map((h) => h.costSol), data.costPerDaySol, 0.000001)
  const totalSpent30d = history.reduce((sum, h) => sum + (h.costSol || 0), 0)

  return (
    <main className="consumption">
      <div className="consumption-container">

        <div className="consumption-header">
          <div>
            <h1>Consumo diário</h1>
            <p>Veja exatamente como seu saldo é descontado, dia a dia.</p>
          </div>

          <Link to="/billing" className="btn-secondary">
            Ver planos / recarregar
            <ArrowRight size={16} />
          </Link>
        </div>

        {/* RESUMO */}
        <div className="consumption-summary">

          <div className="summary-card">
            <div className="summary-icon"><Wallet size={19} /></div>
            <div>
              <span>Saldo disponível</span>
              <strong>{(data.balance || 0).toFixed(6)} SOL</strong>
            </div>
          </div>

          <div className="summary-card">
            <div className="summary-icon"><TrendingDown size={19} /></div>
            <div>
              <span>Custo por dia (hoje)</span>
              <strong>{data.costPerDaySol.toFixed(6)} SOL</strong>
            </div>
          </div>

          <div className="summary-card">
            <div className="summary-icon"><CalendarClock size={19} /></div>
            <div>
              <span>Estimativa de saldo</span>
              <strong>
                {data.daysUntilEmpty === null
                  ? 'Sem custo (Free)'
                  : data.daysUntilEmpty <= 0
                    ? 'Acaba hoje'
                    : `${data.daysUntilEmpty} dia(s)`}
              </strong>
            </div>
          </div>

          <div className="summary-card">
            <div className="summary-icon"><Wallet size={19} /></div>
            <div>
              <span>Gasto nos últimos 30 dias</span>
              <strong>{totalSpent30d.toFixed(6)} SOL</strong>
            </div>
          </div>

        </div>

        {data.daysUntilEmpty !== null && data.daysUntilEmpty <= 3 && (
          <div className="consumption-alert">
            <AlertTriangle size={17} />
            <span>
              Seu saldo deve acabar em {data.daysUntilEmpty <= 0 ? 'menos de 1 dia' : `${data.daysUntilEmpty} dia(s)`}.
              Sem saldo, seus sites publicados ({data.publishedSites}) ficam congelados até você recarregar.
            </span>
            <Link to="/billing" className="btn-primary">Recarregar agora</Link>
          </div>
        )}

        {/* GRÁFICO SIMPLES DE BARRAS */}
        <div className="card full-width">
          <div className="card-heading">
            <div>
              <h3>Últimos {history.length} dia(s)</h3>
              <p>Quanto foi debitado do seu saldo em cada dia</p>
            </div>
          </div>

          {history.length === 0 ? (
            <p className="consumption-empty">
              Ainda não há histórico de cobrança — ele aparece a partir do primeiro
              dia com um site publicado num plano pago.
            </p>
          ) : (
            <div className="consumption-chart">
              {[...history].reverse().map((h) => (
                <div className="chart-bar-wrap" key={h.date} title={`${h.date}: ${h.costSol.toFixed(6)} SOL`}>
                  <div
                    className={`chart-bar ${h.status !== 'ok' ? 'chart-bar-alert' : ''}`}
                    style={{ height: `${Math.max((h.costSol / maxCost) * 100, h.costSol > 0 ? 4 : 1)}%` }}
                  ></div>
                  <span className="chart-bar-label">{h.date.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* TABELA DETALHADA */}
        <div className="card full-width">
          <div className="card-heading">
            <div>
              <h3>Detalhamento</h3>
              <p>Um registro por dia: plano, sites publicados e saldo restante</p>
            </div>
          </div>

          {history.length === 0 ? (
            <p className="consumption-empty">Nenhum registro ainda.</p>
          ) : (
            <div className="consumption-table-wrapper">
              <table className="consumption-table">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Plano</th>
                    <th>Sites publicados</th>
                    <th>Debitado</th>
                    <th>Saldo após</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    const st = statusLabel(h.status)
                    return (
                      <tr key={h.date}>
                        <td>{new Date(h.date + 'T00:00:00').toLocaleDateString('pt-BR')}</td>
                        <td className="cell-plan">{h.plan}</td>
                        <td>{h.sitesCount}</td>
                        <td>{h.costSol > 0 ? `${h.costSol.toFixed(6)} SOL` : '—'}</td>
                        <td>{h.balanceAfter.toFixed(6)} SOL</td>
                        <td>
                          <span className={`consumption-badge tone-${st.tone}`}>
                            {st.tone === 'danger' ? <Snowflake size={13} /> : st.tone === 'ok' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                            {st.text}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </main>
  )
}

export default Consumption
