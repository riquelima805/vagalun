import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import {
  HardDrive,
  Zap,
  Crown,
  Activity,
  Globe,
  ExternalLink,
  Plus,
  ArrowRight,
  Rocket,
  Database,
  CreditCard
} from 'lucide-react'
import { useTranslation } from '../i18n/LanguageContext'
import './Dashboard.css'

function Dashboard({ user, token }) {
  const { t } = useTranslation()
  const [usage, setUsage] = useState(null)
  const [sites, setSites] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      const [usageRes, sitesRes] = await Promise.all([
        axios.get('/api/usage', {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get('/api/sites', {
          headers: { Authorization: `Bearer ${token}` }
        })
      ])

      setUsage(usageRes.data)
      setSites(sitesRes.data)
    } catch (error) {
      console.error('Erro ao carregar dados:', error)

      setUsage({
        plan: 'free',
        storage: {
          used: '0',
          limit: 1,
          unit: 'MB'
        },
        traffic: {
          used: '0',
          limit: 30,
          unit: 'MB'
        },
        balance: 0,
        status: 'ok'
      })
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <main className="dashboard">
        <div className="loading">
          <div className="loading-spinner"></div>
          <span>{t('dashboard.loading')}</span>
        </div>
      </main>
    )
  }

  // A API (/api/usage) sempre manda os números em MB (usage.storage.unit ===
  // 'MB'), pra bater exatamente com storageMB/trafficMB de PLANS no server.
  // Formatamos pra GB só na exibição quando o valor for grande — antes o
  // rótulo "GB" estava fixo no JSX mesmo com o valor em MB (ex: plano de
  // 500 MB aparecia como "500 GB"), daí os planos "não batiam" com a
  // página de billing/inicial.
  const formatStorage = (value) => {
    const n = parseFloat(value || 0);
    if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`;
    return `${n.toFixed(n < 10 ? 2 : 0)} MB`;
  };

  const storagePercent = Math.min(
    (parseFloat(usage?.storage?.used || 0) /
      (usage?.storage?.limit || 1)) *
      100,
    100
  )

  const trafficPercent = Math.min(
    (parseFloat(usage?.traffic?.used || 0) /
      (usage?.traffic?.limit || 1)) *
      100,
    100
  )

  return (
    <main className="dashboard">
      <div className="dashboard-container">

        {/* HEADER */}
        <div className="dashboard-header">
          <div>
            <div className="dashboard-title-row">
              <h1>
                {t('dashboard.welcome', { name: user?.name || t('dashboard.defaultUser') })}
              </h1>

              <span className="welcome-icon">👋</span>
            </div>

            <p>
              {t('dashboard.subtitle')}
            </p>
          </div>

          <Link to="/sites" className="new-site-button">
            <Plus size={18} />
            {t('dashboard.newSite')}
          </Link>
        </div>


        {/* STATS */}
        <div className="stats">

          {/* STORAGE */}
          <div className="stat-box">

            <div className="stat-top">
              <div className="stat-icon">
                <HardDrive size={23} strokeWidth={1.8} />
              </div>

              <span className="stat-action">
                <Database size={15} />
              </span>
            </div>

            <div className="stat-label">
              {t('dashboard.storage')}
            </div>

            <div className="stat-value">
              {formatStorage(usage?.storage?.used)}
              <span className="stat-unit">
                / {formatStorage(usage?.storage?.limit)}
              </span>
            </div>

            <div className="progress-info">
              <span>{t('dashboard.usage')}</span>
              <span>{storagePercent.toFixed(0)}%</span>
            </div>

            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${storagePercent}%`
                }}
              ></div>
            </div>

          </div>


          {/* TRÁFEGO */}
          <div className="stat-box">

            <div className="stat-top">
              <div className="stat-icon">
                <Zap size={23} strokeWidth={1.8} />
              </div>

              <span className="stat-action">
                <Activity size={15} />
              </span>
            </div>

            <div className="stat-label">
              {t('dashboard.traffic')}
            </div>

            <div className="stat-value">
              {formatStorage(usage?.traffic?.used)}
              <span className="stat-unit">
                / {formatStorage(usage?.traffic?.limit)}
              </span>
            </div>

            <div className="progress-info">
              <span>{t('dashboard.usage')}</span>
              <span>{trafficPercent.toFixed(0)}%</span>
            </div>

            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${trafficPercent}%`
                }}
              ></div>
            </div>

          </div>


          {/* PLANO */}
          <div className="stat-box">

            <div className="stat-top">
              <div className="stat-icon">
                <Crown size={23} strokeWidth={1.8} />
              </div>

              <span className="stat-action">
                <CreditCard size={15} />
              </span>
            </div>

            <div className="stat-label">
              {t('dashboard.currentPlan')}
            </div>

            <div className="stat-value plan-value">
              {usage?.plan?.toUpperCase() || 'FREE'}
            </div>

            <div className="stat-balance">
              {t('dashboard.availableBalance')}

              <strong>
                {(usage?.balance ?? 0).toFixed(6)} SOL
              </strong>
            </div>

          </div>


          {/* STATUS */}
          <div className="stat-box">

            <div className="stat-top">
              <div className="stat-icon">
                <Activity size={23} strokeWidth={1.8} />
              </div>

              <span
                className={`status-dot ${
                  usage?.status === 'ok'
                    ? 'online'
                    : 'offline'
                }`}
              ></span>
            </div>

            <div className="stat-label">
              {t('dashboard.accountStatus')}
            </div>

            <div className="status-value">
              <span
                className={`badge ${
                  usage?.status === 'ok'
                    ? 'badge-success'
                    : 'badge-warning'
                }`}
              >
                <span className="badge-dot"></span>

                {usage?.status === 'ok'
                  ? t('dashboard.statusActive')
                  : t('dashboard.statusLimited')}
              </span>
            </div>

            <div className="stat-description">
              {t('dashboard.statusDescription')}
            </div>

          </div>

        </div>


        {/* SITES */}
        <div className="card sites-card">

          <div className="card-header">

            <div className="card-title">

              <div className="card-title-icon">
                <Globe size={19} />
              </div>

              <div>
                <h2>{t('dashboard.mySites')}</h2>

                <span>
                  {sites.length}{' '}
                  {sites.length === 1
                    ? t('dashboard.sitePublished')
                    : t('dashboard.sitesPublished')}
                </span>
              </div>

            </div>

            <Link to="/sites" className="view-all">
              {t('dashboard.viewAll')}
              <ArrowRight size={16} />
            </Link>

          </div>


          {sites.length === 0 ? (

            <div className="empty-state">

              <div className="empty-icon">
                <Globe size={30} />
              </div>

              <h3>{t('dashboard.noSites')}</h3>

              <p>
                {t('dashboard.noSitesHelper')}
              </p>

              <Link to="/sites" className="btn-primary">
                <Plus size={17} />
                {t('dashboard.createFirstSite')}
              </Link>

            </div>

          ) : (

            <div className="sites-table-wrapper">

              <table className="table">

                <thead>
                  <tr>
                    <th>{t('dashboard.table.site')}</th>
                    <th>{t('dashboard.table.domain')}</th>
                    <th>{t('dashboard.table.storage')}</th>
                    <th>{t('dashboard.table.status')}</th>
                    <th></th>
                  </tr>
                </thead>

                <tbody>

                  {sites.slice(0, 5).map(site => (

                    <tr key={site.siteId}>

                      <td>
                        <div className="site-name">
                          <div className="site-icon">
                            <Globe size={17} />
                          </div>

                          <strong>
                            {site.name}
                          </strong>
                        </div>
                      </td>

                      <td>
                        <span className="domain">
                          {site.domain}
                        </span>
                      </td>

                      <td>
                        {(site.storageUsed / 1024 / 1024).toFixed(2)} MB
                      </td>

                      <td>
                        <span className="site-status">
                          <span></span>
                          {t('dashboard.online')}
                        </span>
                      </td>

                      <td>
                        <Link
                          to={`/sites/${site.siteId}`}
                          className="manage-button"
                        >
                          {t('dashboard.manage')}
                          <ExternalLink size={14} />
                        </Link>
                      </td>

                    </tr>

                  ))}

                </tbody>

              </table>

            </div>

          )}

        </div>


        {/* CTA */}
        <div className="cta-card">

          <div className="cta-icon">
            <Rocket size={28} />
          </div>

          <div className="cta-content">

            <h3>
              {t('dashboard.cta.title')}
            </h3>

            <p>
              {t('dashboard.cta.subtitle')}
            </p>

          </div>

          <Link
            to="/billing"
            className="btn-primary btn-large"
          >
            {t('dashboard.cta.viewPlans')}
            <ArrowRight size={18} />
          </Link>

        </div>

      </div>
    </main>
  )
}

export default Dashboard