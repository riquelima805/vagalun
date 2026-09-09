import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  ChevronLeft,
  UploadCloud,
  Copy,
  Check,
  Globe,
  HardDrive,
  ShieldCheck,
  CalendarDays,
  ExternalLink,
  FileArchive,
  FolderOpen,
  RefreshCw,
  Link2,
  Megaphone,
  Loader2
} from 'lucide-react'
import FileExplorer from '../components/FileExplorer'
import { useTranslation } from '../i18n/LanguageContext'
import './SiteDetail.css'

function SiteDetail({ token }) {
  const { siteId } = useParams()
  const navigate = useNavigate()
  const { t, lang } = useTranslation()

  const [site, setSite] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [copied, setCopied] = useState(false)

  // Domínio próprio / DNS
  const [customDomain, setCustomDomain] = useState('')
  const [dnsInfo, setDnsInfo] = useState(null)
  const [dnsLoading, setDnsLoading] = useState(false)
  const [domainSaving, setDomainSaving] = useState(false)
  const [domainError, setDomainError] = useState('')

  // Anúncios (tag VAST do dono do site)
  const [ads, setAds] = useState({
    enabled: false,
    vastUrl: '',
    preroll: true,
    midroll: false,
    midrollInterval: 300,
    banner: false
  })
  const [adsLoading, setAdsLoading] = useState(false)
  const [adsSaving, setAdsSaving] = useState(false)
  const [adsSaved, setAdsSaved] = useState(false)
  const [adsError, setAdsError] = useState('')

  useEffect(() => {
    fetchSite()
    fetchDnsInfo()
    fetchAds()
  }, [siteId])

  const fetchSite = async () => {
    try {
      const response = await axios.get(`/api/sites/${siteId}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      })

      setSite(response.data)
    } catch (error) {
      alert(t('siteDetail.error.load'))
      navigate('/sites')
    } finally {
      setLoading(false)
    }
  }

  const handleUpload = async (e) => {
    const file = e.target.files?.[0]

    if (!file) return

    setUploading(true)

    const formData = new FormData()
    formData.append('file', file)

    try {
      const response = await axios.post(
        `/api/sites/${siteId}/upload`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'multipart/form-data'
          }
        }
      )

      setSite(response.data.site)

      alert(t('siteDetail.success.deploy'))
    } catch (error) {
      alert(
        t('siteDetail.error.generic') + ': ' +
        (error.response?.data?.error || t('siteDetail.error.upload'))
      )
    } finally {
      setUploading(false)

      // Permite selecionar o mesmo arquivo novamente
      e.target.value = ''
    }
  }

  const fetchDnsInfo = async () => {
    setDnsLoading(true)
    try {
      const response = await axios.get(`/api/sites/${siteId}/dns`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      setDnsInfo(response.data)
    } catch (error) {
      // Endpoint pode não existir em ambientes antigos — não bloqueia a tela
      setDnsInfo(null)
    } finally {
      setDnsLoading(false)
    }
  }

  const handleSaveDomain = async (e) => {
    e.preventDefault()
    setDomainError('')

    if (!customDomain.trim()) return

    setDomainSaving(true)

    try {
      const response = await axios.post(
        `/api/sites/${siteId}/domain`,
        { domain: customDomain.trim() },
        { headers: { Authorization: `Bearer ${token}` } }
      )
      setSite(response.data.site)
      setCustomDomain('')
    } catch (error) {
      setDomainError(
        error.response?.data?.error ||
        t('siteDetail.error.domain')
      )
    } finally {
      setDomainSaving(false)
    }
  }

  const fetchAds = async () => {
    setAdsLoading(true)
    try {
      const response = await axios.get(`/api/sites/${siteId}/ads`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (response.data.adsConfig) {
        setAds((prev) => ({ ...prev, ...response.data.adsConfig }))
      }
    } catch (error) {
      // sem config salva ainda / endpoint indisponível — mantém o padrão
    } finally {
      setAdsLoading(false)
    }
  }

  const handleSaveAds = async (e) => {
    e.preventDefault()
    setAdsError('')
    setAdsSaved(false)

    if (ads.enabled && !ads.vastUrl.trim()) {
      setAdsError(t('siteDetail.error.adsVastRequired'))
      return
    }

    setAdsSaving(true)

    try {
      const response = await axios.post(
        `/api/sites/${siteId}/ads`,
        ads,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      setAds((prev) => ({ ...prev, ...response.data.adsConfig }))
      setAdsSaved(true)
      setTimeout(() => setAdsSaved(false), 2200)
    } catch (error) {
      setAdsError(
        error.response?.data?.error || t('siteDetail.error.adsSave')
      )
    } finally {
      setAdsSaving(false)
    }
  }

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text)

      setCopied(true)

      setTimeout(() => {
        setCopied(false)
      }, 1800)
    } catch (error) {
      alert(t('siteDetail.error.copy'))
    }
  }

  if (loading) {
    return (
      <main className="site-detail">
        <div className="site-loading">
          <div className="loading-spinner"></div>
          <span>{t('siteDetail.loading')}</span>
        </div>
      </main>
    )
  }

  if (!site) {
    return (
      <main className="site-detail">
        <div className="site-not-found">
          <Globe size={36} />
          <h2>{t('siteDetail.notFound')}</h2>
          <button
            className="btn-primary"
            onClick={() => navigate('/sites')}
          >
            {t('siteDetail.backToSites')}
          </button>
        </div>
      </main>
    )
  }

  const storageMB = site.storageUsed / 1024 / 1024

  return (
    <main className="site-detail">

      <div className="site-detail-container">

        {/* =========================================
            CABEÇALHO
        ========================================= */}

        <div className="site-detail-header">

          <button
            className="btn-back"
            onClick={() => navigate('/sites')}
            title={t('siteDetail.backToSites')}
          >
            <ChevronLeft size={20} />
          </button>

          <div className="site-heading">

            <div className="site-heading-icon">
              <Globe size={23} />
            </div>

            <div>
              <div className="site-title-row">

                <h1>{site.name}</h1>

                <span className="site-status">
                  <span className="status-dot"></span>
                  {t('siteDetail.active')}
                </span>

              </div>

              <a
                href={site.url}
                target="_blank"
                rel="noopener noreferrer"
                className="site-domain-link"
              >
                {site.domain}
                <ExternalLink size={13} />
              </a>
            </div>

          </div>

          <a
            href={site.url}
            target="_blank"
            rel="noopener noreferrer"
            className="open-site-button"
          >
            {t('siteDetail.openSite')}
            <ExternalLink size={16} />
          </a>

        </div>


        {/* =========================================
            RESUMO
        ========================================= */}

        <div className="site-summary">

          <div className="summary-item">

            <div className="summary-icon">
              <HardDrive size={19} />
            </div>

            <div>
              <span>{t('siteDetail.storage')}</span>
              <strong>
                {storageMB.toFixed(2)} MB
              </strong>
            </div>

          </div>


          <div className="summary-item">

            <div className="summary-icon">
              <ShieldCheck size={19} />
            </div>

            <div>
              <span>{t('siteDetail.security')}</span>
              <strong>{t('siteDetail.protected')}</strong>
            </div>

          </div>


          <div className="summary-item">

            <div className="summary-icon">
              <CalendarDays size={19} />
            </div>

            <div>
              <span>{t('siteDetail.createdAt')}</span>
              <strong>
                {new Date(site.createdAt).toLocaleDateString(
                  lang === 'en' ? 'en-US' : 'pt-BR'
                )}
              </strong>
            </div>

          </div>

        </div>


        {/* =========================================
            GRID PRINCIPAL
        ========================================= */}

        <div className="detail-grid">

          {/* INFORMAÇÕES */}

          <div className="card">

            <div className="card-heading">

              <div className="card-heading-icon">
                <Globe size={18} />
              </div>

              <div>
                <h3>{t('siteDetail.info.title')}</h3>
                <p>{t('siteDetail.info.subtitle')}</p>
              </div>

            </div>


            <div className="info-list">

              <div className="info-row">
                <span className="info-label">
                  {t('siteDetail.info.name')}
                </span>

                <strong>
                  {site.name}
                </strong>
              </div>


              <div className="info-row">
                <span className="info-label">
                  {t('siteDetail.info.domain')}
                </span>

                <strong className="domain-value">
                  {site.domain}
                </strong>
              </div>


              <div className="info-row">
                <span className="info-label">
                  {t('siteDetail.info.status')}
                </span>

                <span className="status-badge">
                  <span></span>
                  {site.status?.toUpperCase() || 'ATIVO'}
                </span>
              </div>


              <div className="info-row">
                <span className="info-label">
                  {t('siteDetail.createdAt')}
                </span>

                <strong>
                  {new Date(
                    site.createdAt
                  ).toLocaleDateString(lang === 'en' ? 'en-US' : 'pt-BR')}
                </strong>
              </div>

            </div>

          </div>


          {/* URL */}

          <div className="card">

            <div className="card-heading">

              <div className="card-heading-icon">
                <Globe size={18} />
              </div>

              <div>
                <h3>{t('siteDetail.url.title')}</h3>
                <p>{t('siteDetail.url.subtitle')}</p>
              </div>

            </div>


            <div className="url-display">

              <Globe
                className="url-icon"
                size={18}
              />

              <input
                type="text"
                value={site.url}
                readOnly
              />

              <button
                className={`btn-copy-large ${
                  copied ? 'copied' : ''
                }`}
                onClick={() =>
                  copyToClipboard(site.url)
                }
                title={t('siteDetail.url.copy')}
              >
                {copied ? (
                  <Check size={18} />
                ) : (
                  <Copy size={18} />
                )}
              </button>

            </div>

            <div className="url-footer">

              <span>
                {t('siteDetail.url.share')}
              </span>

              <a
                href={site.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('siteDetail.url.open')}
                <ExternalLink size={13} />
              </a>

            </div>

          </div>


          {/* STORAGE */}

          <div className="card">

            <div className="card-heading">

              <div className="card-heading-icon">
                <HardDrive size={18} />
              </div>

              <div>
                <h3>{t('siteDetail.storageCard.title')}</h3>
                <p>{t('siteDetail.storageCard.subtitle')}</p>
              </div>

            </div>


            <div className="storage-info">

              <div className="storage-top">

                <div>
                  <span>{t('siteDetail.storageCard.used')}</span>

                  <strong>
                    {storageMB.toFixed(2)} MB
                  </strong>
                </div>

                <div className="storage-percent">
                  35%
                </div>

              </div>


              <div className="storage-bar">

                <div
                  className="storage-used"
                  style={{
                    width: '35%'
                  }}
                ></div>

              </div>


              <div className="storage-bottom">
                <span>{t('siteDetail.storageCard.spaceUsed')}</span>
                <span>{t('siteDetail.storageCard.hostingActive')}</span>
              </div>

            </div>

          </div>


          {/* DEPLOY */}

          <div className="card upload-card">

            <div className="card-heading">

              <div className="card-heading-icon">
                <UploadCloud size={18} />
              </div>

              <div>
                <h3>{t('siteDetail.deploy.title')}</h3>
                <p>{t('siteDetail.deploy.subtitle')}</p>
              </div>

            </div>


            <label
              className={`upload-label ${
                uploading ? 'uploading' : ''
              }`}
            >

              <div className="upload-content">

                <div className="upload-icon">
                  {uploading ? (
                    <RefreshCw
                      size={29}
                      className="upload-spinner"
                    />
                  ) : (
                    <FileArchive size={29} />
                  )}
                </div>

                <strong>
                  {uploading
                    ? t('siteDetail.deploy.sending')
                    : t('siteDetail.deploy.sendNew')}
                </strong>

                <span>
                  {uploading
                    ? t('siteDetail.deploy.wait')
                    : t('siteDetail.deploy.selectZip')}
                </span>

                {!uploading && (
                  <div className="upload-button">
                    <UploadCloud size={16} />
                    {t('siteDetail.deploy.selectZipBtn')}
                  </div>
                )}

                {!uploading && (
                  <small>
                    {t('siteDetail.deploy.autoExtract')}
                  </small>
                )}

              </div>

              <input
                type="file"
                accept=".zip"
                onChange={handleUpload}
                disabled={uploading}
                style={{ display: 'none' }}
              />

            </label>

          </div>

          {/* DOMÍNIO PRÓPRIO / DNS */}

          <div className="card full-width">

            <div className="card-heading">

              <div className="card-heading-icon">
                <Link2 size={18} />
              </div>

              <div>
                <h3>{t('siteDetail.domain.title')}</h3>
                <p>{t('siteDetail.domain.subtitle')}</p>
              </div>

            </div>

            {dnsLoading ? (
              <div className="inline-loading">
                <Loader2 size={16} className="spin" />
                <span>{t('siteDetail.domain.loadingDns')}</span>
              </div>
            ) : dnsInfo ? (
              <>
                <div className="dns-table">

                  <div className="dns-row">
                    <span className="dns-type">{dnsInfo.aRecord?.type}</span>
                    <span className="dns-host">{dnsInfo.aRecord?.host}</span>
                    <span className="dns-value">{dnsInfo.aRecord?.value}</span>
                  </div>

                  <div className="dns-row">
                    <span className="dns-type">{dnsInfo.cnameRecord?.type}</span>
                    <span className="dns-host">{dnsInfo.cnameRecord?.host}</span>
                    <span className="dns-value">{dnsInfo.cnameRecord?.value}</span>
                  </div>

                  <div className="dns-row">
                    <span className="dns-type">{dnsInfo.verificationTxt?.type}</span>
                    <span className="dns-host">{dnsInfo.verificationTxt?.host}</span>
                    <span className="dns-value">{dnsInfo.verificationTxt?.value}</span>
                  </div>

                </div>

                <p className="dns-instructions">{dnsInfo.instructions}</p>

                <form className="domain-form" onSubmit={handleSaveDomain}>

                  <input
                    type="text"
                    placeholder={t('siteDetail.domain.placeholder')}
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value)}
                  />

                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={domainSaving || !customDomain.trim()}
                  >
                    {domainSaving ? (
                      <Loader2 size={15} className="spin" />
                    ) : (
                      <Link2 size={15} />
                    )}
                    {domainSaving ? t('siteDetail.domain.verifying') : t('siteDetail.domain.confirm')}
                  </button>

                </form>

                {domainError && <p className="form-error">{domainError}</p>}

                <p className="dns-footnote">
                  {t('siteDetail.domain.footnote')}
                </p>
              </>
            ) : (
              <p className="dns-footnote">
                {t('siteDetail.domain.dnsUnavailable')}
              </p>
            )}

          </div>


          {/* ANÚNCIOS */}

          <div className="card full-width">

            <div className="card-heading">

              <div className="card-heading-icon">
                <Megaphone size={18} />
              </div>

              <div>
                <h3>{t('siteDetail.ads.title')}</h3>
                <p>{t('siteDetail.ads.subtitle')}</p>
              </div>

            </div>

            {adsLoading ? (
              <div className="inline-loading">
                <Loader2 size={16} className="spin" />
                <span>{t('siteDetail.ads.loading')}</span>
              </div>
            ) : (
              <form className="ads-form" onSubmit={handleSaveAds}>

                <label className="ads-toggle-row">
                  <input
                    type="checkbox"
                    checked={ads.enabled}
                    onChange={(e) => setAds((prev) => ({ ...prev, enabled: e.target.checked }))}
                  />
                  <span>{t('siteDetail.ads.toggleLabel')}</span>
                </label>

                <div className="info-row">
                  <span className="info-label">{t('siteDetail.ads.vastTag')}</span>
                </div>

                <input
                  type="text"
                  className="ads-input"
                  placeholder="https://seu-ad-server.com/vast?..."
                  value={ads.vastUrl}
                  onChange={(e) => setAds((prev) => ({ ...prev, vastUrl: e.target.value }))}
                  disabled={!ads.enabled}
                />

                <div className="ads-options">

                  <label className="ads-toggle-row">
                    <input
                      type="checkbox"
                      checked={ads.preroll}
                      disabled={!ads.enabled}
                      onChange={(e) => setAds((prev) => ({ ...prev, preroll: e.target.checked }))}
                    />
                    <span>{t('siteDetail.ads.preroll')}</span>
                  </label>

                  <label className="ads-toggle-row">
                    <input
                      type="checkbox"
                      checked={ads.midroll}
                      disabled={!ads.enabled}
                      onChange={(e) => setAds((prev) => ({ ...prev, midroll: e.target.checked }))}
                    />
                    <span>{t('siteDetail.ads.midroll')}</span>
                  </label>

                  {ads.midroll && (
                    <div className="midroll-interval">
                      <span>{t('siteDetail.ads.every')}</span>
                      <input
                        type="number"
                        min="30"
                        value={ads.midrollInterval}
                        disabled={!ads.enabled}
                        onChange={(e) =>
                          setAds((prev) => ({ ...prev, midrollInterval: Number(e.target.value) }))
                        }
                      />
                      <span>{t('siteDetail.ads.seconds')}</span>
                    </div>
                  )}

                  <label className="ads-toggle-row">
                    <input
                      type="checkbox"
                      checked={ads.banner}
                      disabled={!ads.enabled}
                      onChange={(e) => setAds((prev) => ({ ...prev, banner: e.target.checked }))}
                    />
                    <span>{t('siteDetail.ads.banner')}</span>
                  </label>

                </div>

                {adsError && <p className="form-error">{adsError}</p>}

                <button type="submit" className="btn-primary" disabled={adsSaving}>
                  {adsSaving ? (
                    <Loader2 size={15} className="spin" />
                  ) : adsSaved ? (
                    <Check size={15} />
                  ) : (
                    <Megaphone size={15} />
                  )}
                  {adsSaving ? t('siteDetail.ads.saving') : adsSaved ? t('siteDetail.ads.saved') : t('siteDetail.ads.save')}
                </button>

              </form>
            )}

          </div>

        </div>


        {/* =========================================
            ARQUIVOS
        ========================================= */}

        <div className="card full-width">

          <div className="card-heading explorer-heading">

            <div className="card-heading-icon">
              <FolderOpen size={18} />
            </div>

            <div>
              <h3>{t('siteDetail.files.title')}</h3>

              <p>
                {t('siteDetail.files.subtitle')}
              </p>
            </div>

          </div>


          <div className="explorer-info">

            <FolderOpen size={15} />

            <span>
              {t('siteDetail.files.info')}
            </span>

          </div>


          <FileExplorer
            siteId={siteId}
            token={token}
            onChanged={fetchSite}
          />

        </div>

      </div>

    </main>
  )
}

export default SiteDetail