import { useState, useEffect } from 'react'
import axios from 'axios'
import { useTranslation } from '../i18n/LanguageContext'
import './Billing.css'

import {
  Zap,
  Loader,
  CheckCircle,
  XCircle,
  Receipt,
  BadgeCheck,
  Star,
  Gift,
  Rocket,
  Globe,
  HardDrive,
  Gauge,
  ShieldCheck,
  Wallet,
  QrCode
} from 'lucide-react'

function Billing({ user, token, onPlanChange }) {
  const { t } = useTranslation()
  const [plans, setPlans] = useState(null)
  const [usdRate, setUsdRate] = useState(null)
  const [selectedPlan, setSelectedPlan] = useState(null)
  const [loading, setLoading] = useState(false)
  const [solanaPayment, setSolanaPayment] = useState(null)
  const [confirmMsg, setConfirmMsg] = useState(null)

  const [rechargeAmount, setRechargeAmount] = useState(20)
  const [rechargePayment, setRechargePayment] = useState(null)
  const [rechargeLoading, setRechargeLoading] = useState(false)

  const currentPlan = user?.plan || 'free'

  const formatUsd = (brl) => {
    if (!usdRate) return null
    return (brl * usdRate).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  }

  useEffect(() => {
    fetchPlans()
  }, [])

  // Pré-seleciona um plano pago diferente do atual assim que os planos chegam
  useEffect(() => {
    if (plans && !selectedPlan) {
      const firstUpgrade = Object.keys(plans).find(k => k !== currentPlan && k !== 'free')
      setSelectedPlan(firstUpgrade || currentPlan)
    }
  }, [plans])

  // Se trocar de plano selecionado, descarta um QR pendente de outro plano
  useEffect(() => {
    setSolanaPayment(null)
  }, [selectedPlan])

  const fetchPlans = async () => {
    try {
      const response = await axios.get('/api/billing/plans')
      setPlans(response.data.plans)
      setUsdRate(response.data.brlToUsdRate)
    } catch (error) {
      console.error('Erro ao carregar planos:', error)
    }
  }

  const handleSolanaPayment = async () => {
    setLoading(true)
    setConfirmMsg(null)
    try {
      const response = await axios.post('/api/billing/solana',
        { plan: selectedPlan },
        { headers: { Authorization: `Bearer ${token}` } }
      )
      setSolanaPayment(response.data)
      pollSolanaStatus(response.data.paymentId)
    } catch (error) {
      alert(t('billing.error.generic') + ': ' + (error.response?.data?.error || error.message))
    } finally {
      setLoading(false)
    }
  }

  // Confirmação é 100% on-chain: o backend procura, pela reference key, uma
  // transação confirmada na devnet que pagou o valor certo pro treasury
  // wallet. Sem isso o plano nunca é ativado.
  const pollSolanaStatus = (paymentId) => {
    const interval = setInterval(async () => {
      try {
        const response = await axios.get(`/api/billing/solana/${paymentId}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (response.data.confirmed) {
          clearInterval(interval)
          setConfirmMsg({ ok: true, text: `✅ ${t('billing.confirm.planActivated', { plan: response.data.plan })}` })
          setSolanaPayment(null)
          onPlanChange?.()
        }
      } catch {
        clearInterval(interval)
      }
    }, 3000)
  }

  const handleRecharge = async () => {
    if (!rechargeAmount || rechargeAmount <= 0) {
      alert(t('billing.error.invalidRecharge'))
      return
    }
    setRechargeLoading(true)
    setConfirmMsg(null)
    try {
      const response = await axios.post('/api/billing/solana/recharge',
        { amountBRL: Number(rechargeAmount) },
        { headers: { Authorization: `Bearer ${token}` } }
      )
      setRechargePayment(response.data)
      pollRechargeStatus(response.data.paymentId)
    } catch (error) {
      alert(t('billing.error.generic') + ': ' + (error.response?.data?.error || error.message))
    } finally {
      setRechargeLoading(false)
    }
  }

  const pollRechargeStatus = (paymentId) => {
    const interval = setInterval(async () => {
      try {
        const response = await axios.get(`/api/billing/solana/${paymentId}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (response.data.confirmed) {
          clearInterval(interval)
          setConfirmMsg({ ok: true, text: `✅ ${t('billing.confirm.rechargeDone', { amount: response.data.amountBRL })}` })
          setRechargePayment(null)
          onPlanChange?.()
        }
      } catch {
        clearInterval(interval)
      }
    }, 3000)
  }

  if (!plans || !selectedPlan) {
    return (
      <main>
        <div className="loading">
          {t('billing.loadingPlans')}
        </div>
      </main>
    )
  }

  return (
    <main>
      <div className="container">

        <div className="billing-header">
          <h1>
            <Receipt size={28} />
            {t('billing.title')}
          </h1>
          <p>{t('billing.subtitle')}</p>
        </div>

        {confirmMsg && (
          <div className={`confirm-banner ${confirmMsg.ok ? 'ok' : 'warn'}`}>
            {confirmMsg.ok ? <CheckCircle size={18} /> : <XCircle size={18} />}
            <span>{confirmMsg.text}</span>
          </div>
        )}

        <div className="payment-section recharge-section">
          <h2><Wallet size={19} /> {t('billing.recharge.title')}</h2>
          <p className="method-desc">
            {t('billing.recharge.balanceLabel')}: <strong>{(user?.balance || 0).toFixed(6)} SOL</strong>
            {' '}— {t('billing.recharge.helper')}
          </p>

          <div className="method-form solana-form">
            <div className="recharge-input-row">
              <label>
                {t('billing.recharge.amount')}
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={rechargeAmount}
                  onChange={(e) => { setRechargeAmount(e.target.value); setRechargePayment(null) }}
                />
              </label>
              {usdRate && rechargeAmount > 0 && (
                <span className="exchange-rate">≈ {formatUsd(Number(rechargeAmount))}</span>
              )}
            </div>

            {rechargePayment && (
              <div className="payment-qr">
                <h4><QrCode size={16} /> {t('billing.recharge.scanQr')}</h4>
                <div className="qr-code-box">
                  <img src={rechargePayment.qrCodeImage} alt="Solana Pay QR" />
                </div>
                <div className="solana-address-box">
                  <span className="info-label">{t('billing.recharge.sendAddress')}</span>
                  <p><code>{rechargePayment.recipientWallet}</code></p>
                  <p><code>{rechargePayment.solanaAmount} SOL</code></p>
                </div>
                <div className="solana-address-box warn">
                  <span className="info-label">{t('billing.recharge.noSendWarning')}</span>
                  <p>{t('billing.recharge.reference')}: <code>{rechargePayment.reference}</code></p>
                </div>
              </div>
            )}

            <button
              className="btn-primary btn-pay"
              onClick={handleRecharge}
              disabled={rechargeLoading}
            >
              {rechargeLoading ? (
                <><Loader size={17} className="spin" /> {t('billing.recharge.generating')}</>
              ) : (
                <><Zap size={17} /> {rechargePayment ? t('billing.recharge.newQr') : t('billing.recharge.submit')}</>
              )}
            </button>
          </div>
        </div>

        <div className="plans-grid">
          {Object.entries(plans).map(([key, plan]) => (
            <div
              key={key}
              className={`plan-card ${selectedPlan === key ? 'selected' : ''} ${currentPlan === key ? 'current' : ''}`}
              onClick={() => setSelectedPlan(key)}
            >
              <div className="plan-badge">
                {currentPlan === key && (<><BadgeCheck size={12} /> {t('billing.plan.current')}</>)}
                {currentPlan !== key && key === 'pro' && (<><Star size={12} /> {t('billing.plan.popular')}</>)}
                {currentPlan !== key && key === 'free' && (<><Gift size={12} /> {t('billing.plan.free')}</>)}
                {currentPlan !== key && key === 'basic' && (<><Rocket size={12} /> {t('billing.plan.recommended')}</>)}
              </div>

              <h3>{plan.name}</h3>

              <div className="plan-price">
                {plan.price === 0 ? (
                  <span>{t('billing.plan.free.price')}</span>
                ) : (
                  <>
                    R$<span>{plan.price}</span>
                    <span className="plan-period">{t('billing.plan.perMonth')}</span>
                    {usdRate && <span className="plan-usd">≈ {formatUsd(plan.price)}</span>}
                  </>
                )}
              </div>

              <div className="plan-features">
                <div className="feature">
                  <span className="check"><Globe size={11} /></span>
                  <span>{plan.maxSites} {t('billing.plan.sites')}{plan.maxSites > 1 ? 's' : ''}</span>
                </div>
                <div className="feature">
                  <span className="check"><HardDrive size={11} /></span>
                  <span>
                    {plan.storageMB >= 1024 ? `${(plan.storageMB / 1024).toFixed(1)} GB` : `${plan.storageMB} MB`}
                    {' '}{t('billing.plan.storage')}
                  </span>
                </div>
                <div className="feature">
                  <span className="check"><Gauge size={11} /></span>
                  <span>
                    {plan.trafficMB >= 1024 ? `${(plan.trafficMB / 1024).toFixed(1)} GB` : `${plan.trafficMB} MB`}
                    {' '}{t('billing.plan.traffic')}
                  </span>
                </div>
                <div className="feature">
                  <span className="check"><ShieldCheck size={11} /></span>
                  <span>{t('billing.plan.ssl')}</span>
                </div>
              </div>

              <button className={`btn-select ${selectedPlan === key ? 'active' : ''}`} disabled={currentPlan === key}>
                {currentPlan === key ? (<><BadgeCheck size={14} /> {t('billing.plan.selectCurrent')}</>) : selectedPlan === key ? (<><CheckCircle size={14} /> {t('billing.plan.selected')}</>) : (<>{t('billing.plan.select')} <Rocket size={13} /></>)}
              </button>
            </div>
          ))}
        </div>

        {selectedPlan === 'free' ? (
          <div className="payment-section">
            <div className="payment-notice free-notice">
              <Gift size={18} />
              <p>{t('billing.payment.free.notice')}</p>
            </div>
          </div>
        ) : currentPlan === selectedPlan ? (
          <div className="payment-section">
            <div className="payment-notice">
              <BadgeCheck size={18} />
              <p>{t('billing.payment.current.notice')}</p>
            </div>
          </div>
        ) : (
          <div className="payment-section">
            <h2><Wallet size={19} /> {t('billing.payment.title')}</h2>

            <div className="payment-method-group solana-highlight">
              <div className="method-header">
                <span className="payment-title solana-title"><Zap size={17} /> SOLANA</span>
                <p className="method-desc">{t('billing.payment.methodDesc')}</p>
              </div>

              <div className="method-form solana-form">
                <div className="solana-info">
                  <div className="info-box">
                    <span className="info-label">{t('billing.payment.youPay')}</span>
                    <span className="info-value">{(plans[selectedPlan].price / 500).toFixed(6)} SOL</span>
                    <span className="exchange-rate">
                      ≈ R$ {plans[selectedPlan].price}
                      {usdRate && ` (${formatUsd(plans[selectedPlan].price)})`}
                    </span>
                  </div>
                </div>

                {solanaPayment && (
                  <div className="payment-qr">
                    <h4><QrCode size={16} /> {t('billing.payment.scanQr')}</h4>
                    <div className="qr-code-box">
                      <img src={solanaPayment.qrCodeImage} alt="Solana Pay QR" />
                    </div>
                    <p className="small-text" style={{ fontWeight: 600 }}>
                      {t('billing.payment.walletTip')}
                    </p>

                    <div className="solana-address-box">
                      <span className="info-label">{t('billing.payment.sendAddress')}</span>
                      <p><code>{solanaPayment.recipientWallet}</code></p>
                      <p><code>{solanaPayment.solanaAmount} SOL</code></p>
                    </div>

                    <div className="solana-address-box warn">
                      <span className="info-label">{t('billing.payment.notAnAddressWarning')}</span>
                      <p>
                        {t('billing.payment.reference')}: <code>{solanaPayment.reference}</code>
                      </p>
                      <p className="small-text">
                        {t('billing.payment.referenceExplain')}
                      </p>
                    </div>
                    <p className="small-text">
                      {t('billing.payment.supportedWallets')}
                    </p>
                  </div>
                )}

                <button
                  className="btn-primary btn-pay"
                  onClick={handleSolanaPayment}
                  disabled={loading}
                >
                  {loading ? (
                    <><Loader size={17} className="spin" /> {t('billing.payment.generating')}</>
                  ) : (
                    <><Zap size={17} /> {solanaPayment ? t('billing.payment.newQr') : t('billing.payment.pay')}</>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="billing-info">
          <div className="info-box">
            <h3><Receipt size={16} /> {t('billing.info.billing.title')}</h3>
            <ul>
              <li><CheckCircle size={13} /> {t('billing.info.billing.item1')}</li>
              <li><CheckCircle size={13} /> {t('billing.info.billing.item2')}</li>
              <li><CheckCircle size={13} /> {t('billing.info.billing.item3')}</li>
              <li><CheckCircle size={13} /> {t('billing.info.billing.item4')}</li>
            </ul>
          </div>
          <div className="info-box">
            <h3><Zap size={16} /> {t('billing.info.solana.title')}</h3>
            <ul>
              <li><CheckCircle size={13} /> {t('billing.info.solana.item1')}</li>
              <li><CheckCircle size={13} /> {t('billing.info.solana.item2')}</li>
              <li><CheckCircle size={13} /> {t('billing.info.solana.item3')}</li>
            </ul>
          </div>
        </div>

      </div>
    </main>
  )
}
export default Billing
