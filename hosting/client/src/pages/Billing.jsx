import { useState, useEffect } from 'react'
import axios from 'axios'
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
  const [plans, setPlans] = useState(null)
  const [selectedPlan, setSelectedPlan] = useState(null)
  const [loading, setLoading] = useState(false)
  const [solanaPayment, setSolanaPayment] = useState(null)
  const [confirmMsg, setConfirmMsg] = useState(null)

  const currentPlan = user?.plan || 'free'

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
      setPlans(response.data)
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
      alert('Erro: ' + (error.response?.data?.error || error.message))
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
          setConfirmMsg({ ok: true, text: `✅ Pagamento confirmado on-chain! Plano ${response.data.plan} ativado.` })
          setSolanaPayment(null)
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
          Carregando planos...
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
            Planos e Cobrança
          </h1>
          <p>Escolha o melhor plano para o seu negócio — pago 100% em SOL</p>
        </div>

        {confirmMsg && (
          <div className={`confirm-banner ${confirmMsg.ok ? 'ok' : 'warn'}`}>
            {confirmMsg.ok ? <CheckCircle size={18} /> : <XCircle size={18} />}
            <span>{confirmMsg.text}</span>
          </div>
        )}

        <div className="plans-grid">
          {Object.entries(plans).map(([key, plan]) => (
            <div
              key={key}
              className={`plan-card ${selectedPlan === key ? 'selected' : ''} ${currentPlan === key ? 'current' : ''}`}
              onClick={() => setSelectedPlan(key)}
            >
              <div className="plan-badge">
                {currentPlan === key && (<><BadgeCheck size={12} /> PLANO ATUAL</>)}
                {currentPlan !== key && key === 'pro' && (<><Star size={12} /> POPULAR</>)}
                {currentPlan !== key && key === 'free' && (<><Gift size={12} /> GRÁTIS</>)}
                {currentPlan !== key && key === 'basic' && (<><Rocket size={12} /> RECOMENDADO</>)}
              </div>

              <h3>{plan.name}</h3>

              <div className="plan-price">
                {plan.price === 0 ? (
                  <span>Grátis</span>
                ) : (
                  <>
                    R$<span>{plan.price}</span>
                    <span className="plan-period">/mês</span>
                  </>
                )}
              </div>

              <div className="plan-features">
                <div className="feature">
                  <span className="check"><Globe size={11} /></span>
                  <span>{plan.maxSites} site{plan.maxSites > 1 ? 's' : ''}</span>
                </div>
                <div className="feature">
                  <span className="check"><HardDrive size={11} /></span>
                  <span>
                    {plan.storageMB >= 1024 ? `${(plan.storageMB / 1024).toFixed(1)} GB` : `${plan.storageMB} MB`}
                    {' '}de armazenamento
                  </span>
                </div>
                <div className="feature">
                  <span className="check"><Gauge size={11} /></span>
                  <span>
                    {plan.trafficMB >= 1024 ? `${(plan.trafficMB / 1024).toFixed(1)} GB` : `${plan.trafficMB} MB`}
                    {' '}de tráfego/mês
                  </span>
                </div>
                <div className="feature">
                  <span className="check"><ShieldCheck size={11} /></span>
                  <span>SSL grátis</span>
                </div>
              </div>

              <button className={`btn-select ${selectedPlan === key ? 'active' : ''}`} disabled={currentPlan === key}>
                {currentPlan === key ? (<><BadgeCheck size={14} /> Plano atual</>) : selectedPlan === key ? (<><CheckCircle size={14} /> Selecionado</>) : (<>Selecionar <Rocket size={13} /></>)}
              </button>
            </div>
          ))}
        </div>

        {selectedPlan === 'free' ? (
          <div className="payment-section">
            <div className="payment-notice free-notice">
              <Gift size={18} />
              <p>O plano Free não requer pagamento — é o plano padrão de todo mundo. Selecione um plano pago acima para pagar com Solana.</p>
            </div>
          </div>
        ) : currentPlan === selectedPlan ? (
          <div className="payment-section">
            <div className="payment-notice">
              <BadgeCheck size={18} />
              <p>Esse já é o seu plano atual. Selecione outro plano acima para fazer upgrade ou downgrade.</p>
            </div>
          </div>
        ) : (
          <div className="payment-section">
            <h2><Wallet size={19} /> Pagamento com Solana</h2>

            <div className="payment-method-group solana-highlight">
              <div className="method-header">
                <span className="payment-title solana-title"><Zap size={17} /> SOLANA</span>
                <p className="method-desc">Pagamento em SOL na devnet, verificado on-chain — sem cartão, sem PIX.</p>
              </div>

              <div className="method-form solana-form">
                <div className="solana-info">
                  <div className="info-box">
                    <span className="info-label">Você pagará</span>
                    <span className="info-value">{(plans[selectedPlan].price / 500).toFixed(6)} SOL</span>
                    <span className="exchange-rate">≈ R$ {plans[selectedPlan].price}</span>
                  </div>
                </div>

                {solanaPayment && (
                  <div className="payment-qr">
                    <h4><QrCode size={16} /> Escaneie com sua wallet</h4>
                    <div className="qr-code-box">
                      <img src={solanaPayment.qrCodeImage} alt="Solana Pay QR" />
                    </div>
                    <p className="small-text" style={{ fontWeight: 600 }}>
                      ✅ Prefira escanear o QR code acima com Phantom, Solflare ou Backpack (rede devnet).
                      Isso preenche tudo certo automaticamente.
                    </p>

                    <div className="solana-address-box">
                      <span className="info-label">Endereço para ENVIAR o pagamento (SOL):</span>
                      <p><code>{solanaPayment.recipientWallet}</code></p>
                      <p><code>{solanaPayment.solanaAmount} SOL</code></p>
                    </div>

                    <div className="solana-address-box warn">
                      <span className="info-label">⚠️ Isto NÃO é um endereço para enviar SOL — não copie/envie para cá:</span>
                      <p>
                        Referência: <code>{solanaPayment.reference}</code>
                      </p>
                      <p className="small-text">
                        É só um código de rastreio que precisa ir junto na transação (o app da wallet faz isso
                        sozinho ao ler o QR). Se enviar manualmente sem usar o QR, use exatamente o endereço
                        acima — mas sem o código de referência embutido, a confirmação automática do plano pode
                        não encontrar sua transação. Por isso o QR code é o jeito confiável de pagar.
                      </p>
                    </div>
                    <p className="small-text">
                      Wallets suportadas: Phantom, Solflare, Backpack (devnet). Assim que a transação confirmar
                      on-chain, o plano é ativado automaticamente — sem precisar recarregar a página.
                    </p>
                  </div>
                )}

                <button
                  className="btn-primary btn-pay"
                  onClick={handleSolanaPayment}
                  disabled={loading}
                >
                  {loading ? (
                    <><Loader size={17} className="spin" /> Gerando cobrança...</>
                  ) : (
                    <><Zap size={17} /> {solanaPayment ? 'Gerar novo QR' : 'Pagar com Solana'}</>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="billing-info">
          <div className="info-box">
            <h3><Receipt size={16} /> Cobrança</h3>
            <ul>
              <li><CheckCircle size={13} /> Sem taxas escondidas</li>
              <li><CheckCircle size={13} /> Pagamento único por upgrade, cobrança diária consome o saldo</li>
              <li><CheckCircle size={13} /> Plano Free pra sempre: 1 site, 1 MB, 30 MB de tráfego</li>
              <li><CheckCircle size={13} /> Sem saldo, o site é pausado até você recarregar</li>
            </ul>
          </div>
          <div className="info-box">
            <h3><Zap size={16} /> Solana devnet</h3>
            <ul>
              <li><CheckCircle size={13} /> Verificação 100% on-chain, sem confirmação manual</li>
              <li><CheckCircle size={13} /> Ainda em devnet — não use SOL de mainnet</li>
              <li><CheckCircle size={13} /> O plano ativa assim que a transação confirmar</li>
            </ul>
          </div>
        </div>

      </div>
    </main>
  )
}
export default Billing
