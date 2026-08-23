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
import './Dashboard.css'

function Dashboard({ user, token }) {
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
          <span>Carregando dashboard...</span>
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
                Bem-vindo, {user?.name || 'usuário'}!
              </h1>

              <span className="welcome-icon">👋</span>
            </div>

            <p>
              Gerencie seus sites e hospedagem aqui
            </p>
          </div>

          <Link to="/sites" className="new-site-button">
            <Plus size={18} />
            Novo site
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
              Armazenamento
            </div>

            <div className="stat-value">
              {formatStorage(usage?.storage?.used)}
              <span className="stat-unit">
                / {formatStorage(usage?.storage?.limit)}
              </span>
            </div>

            <div className="progress-info">
              <span>Uso</span>
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
              Tráfego
            </div>

            <div className="stat-value">
              {formatStorage(usage?.traffic?.used)}
              <span className="stat-unit">
                / {formatStorage(usage?.traffic?.limit)}
              </span>
            </div>

            <div className="progress-info">
              <span>Uso</span>
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
              Plano atual
            </div>

            <div className="stat-value plan-value">
              {usage?.plan?.toUpperCase() || 'FREE'}
            </div>

            <div className="stat-balance">
              Saldo disponível

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
              Status da conta
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
                  ? 'Ativo'
                  : 'Limitado'}
              </span>
            </div>

            <div className="stat-description">
              Sua hospedagem está funcionando normalmente
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
                <h2>Meus Sites</h2>

                <span>
                  {sites.length}{' '}
                  {sites.length === 1
                    ? 'site publicado'
                    : 'sites publicados'}
                </span>
              </div>

            </div>

            <Link to="/sites" className="view-all">
              Ver todos
              <ArrowRight size={16} />
            </Link>

          </div>


          {sites.length === 0 ? (

            <div className="empty-state">

              <div className="empty-icon">
                <Globe size={30} />
              </div>

              <h3>Nenhum site criado ainda</h3>

              <p>
                Crie seu primeiro site e comece sua hospedagem.
              </p>

              <Link to="/sites" className="btn-primary">
                <Plus size={17} />
                Criar primeiro site
              </Link>

            </div>

          ) : (

            <div className="sites-table-wrapper">

              <table className="table">

                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Domínio</th>
                    <th>Storage</th>
                    <th>Status</th>
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
                          Online
                        </span>
                      </td>

                      <td>
                        <Link
                          to={`/sites/${site.siteId}`}
                          className="manage-button"
                        >
                          Gerenciar
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
              Pronto para turbinar sua hospedagem?
            </h3>

            <p>
              Faça upgrade do seu plano e tenha mais
              armazenamento, tráfego e recursos.
            </p>

          </div>

          <Link
            to="/billing"
            className="btn-primary btn-large"
          >
            Ver planos
            <ArrowRight size={18} />
          </Link>

        </div>

      </div>
    </main>
  )
}

export default Dashboard