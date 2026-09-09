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
import { useTranslation } from '../i18n/LanguageContext'
import './Consumption.css'

// Formata um valor MB pra exibição amigável (GB quando grande).
function formatMB(n) {
  const v = Number(n || 0)
  if (v >= 1024) return `${(v / 1024).toFixed(1)} GB`
  return `${v.toFixed(2)} MB`
}

function statusLabel(status, t) {
  switch (status) {
    case 'ok': return { text: t('consumption.statusOk'), tone: 'ok' }
    case 'insufficient_partial': return { text: t('consumption.statusInsufficient'), tone: 'warning' }
    case 'frozen': return { text: t('consumption.statusFrozen'), tone: 'danger' }
    default: return { text: status || '—', tone: 'ok' }
  }
}

function Consumption({ token }) {
  const { t, lang } = useTranslation()
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
      setError(err.response?.data?.error || t('consumption.error.generic'))
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <main className="consumption">
        <div className="consumption-loading">
          <div className="loading-spinner"></div>
          <span>{t('consumption.loading')}</span>
        </div>
      </main>
    )
  }

  if (error || !data) {
    return (
      <main className="consumption">
        <div className="consumption-error card">
          <AlertTriangle size={22} />
          <p>{error || t('consumption.error.noData')}</p>
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
            <h1>{t('consumption.title')}</h1>
            <p>{t('consumption.subtitle')}</p>
          </div>

          <Link to="/billing" className="btn-secondary">
            {t('consumption.viewPlans')}
            <ArrowRight size={16} />
          </Link>
        </div>

        {/* RESUMO */}
        <div className="consumption-summary">

          <div className="summary-card">
            <div className="summary-icon"><Wallet size={19} /></div>
            <div>
              <span>{t('consumption.availableBalance')}</span>
              <strong>{(data.balance || 0).toFixed(6)} SOL</strong>
            </div>
          </div>

          <div className="summary-card">
            <div className="summary-icon"><TrendingDown size={19} /></div>
            <div>
              <span>{t('consumption.costToday')}</span>
              <strong>{data.costPerDaySol.toFixed(6)} SOL</strong>
            </div>
          </div>

          <div className="summary-card">
            <div className="summary-icon"><CalendarClock size={19} /></div>
            <div>
              <span>{t('consumption.estimate')}</span>
              <strong>
                {data.daysUntilEmpty === null
                  ? t('consumption.freeNoCost')
                  : data.daysUntilEmpty <= 0
                    ? t('consumption.endsToday')
                    : `${data.daysUntilEmpty} ${t('consumption.days')}`}
              </strong>
            </div>
          </div>

          <div className="summary-card">
            <div className="summary-icon"><Wallet size={19} /></div>
            <div>
              <span>{t('consumption.spent30d')}</span>
              <strong>{totalSpent30d.toFixed(6)} SOL</strong>
            </div>
          </div>

        </div>

        {data.daysUntilEmpty !== null && data.daysUntilEmpty <= 3 && (
          <div className="consumption-alert">
            <AlertTriangle size={17} />
            <span>
              {t('consumption.alert.text', {
                when: data.daysUntilEmpty <= 0 ? t('consumption.lessThanOneDay') : `${data.daysUntilEmpty} ${t('consumption.days')}`,
                count: data.publishedSites
              })}
            </span>
            <Link to="/billing" className="btn-primary">{t('consumption.rechargeNow')}</Link>
          </div>
        )}

        {/* GRÁFICO SIMPLES DE BARRAS */}
        <div className="card full-width">
          <div className="card-heading">
            <div>
              <h3>{t('consumption.lastDays', { n: history.length })}</h3>
              <p>{t('consumption.chartDesc')}</p>
            </div>
          </div>

          {history.length === 0 ? (
            <p className="consumption-empty">
              {t('consumption.emptyChart')}
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
              <h3>{t('consumption.details')}</h3>
              <p>{t('consumption.detailsDesc')}</p>
            </div>
          </div>

          {history.length === 0 ? (
            <p className="consumption-empty">{t('consumption.noRecords')}</p>
          ) : (
            <div className="consumption-table-wrapper">
              <table className="consumption-table">
                <thead>
                  <tr>
                    <th>{t('consumption.table.date')}</th>
                    <th>{t('consumption.table.plan')}</th>
                    <th>{t('consumption.table.sites')}</th>
                    <th>{t('consumption.table.debited')}</th>
                    <th>{t('consumption.table.balanceAfter')}</th>
                    <th>{t('consumption.table.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    const st = statusLabel(h.status, t)
                    return (
                      <tr key={h.date}>
                        <td>{new Date(h.date + 'T00:00:00').toLocaleDateString(lang === 'en' ? 'en-US' : 'pt-BR')}</td>
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
