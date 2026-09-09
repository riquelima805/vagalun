import { useEffect, useRef, useState } from 'react'
import { CreditCard, Coins, Download, Loader2, CheckCircle2 } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'
import { api } from '../api/client'

export default function Billing() {
  const { t } = useI18n()
  const b = t.billing
  const [amount, setAmount] = useState(20)
  const [balance, setBalance] = useState(null)
  const [history, setHistory] = useState([])
  const [methods, setMethods] = useState(null)
  const [error, setError] = useState('')

  // estado do pagamento Solana em andamento (QR aberto, aguardando confirmação on-chain)
  const [solPayment, setSolPayment] = useState(null) // { paymentId, solAmount, recipientWallet, reference, qrCodeImage }
  const [solStatus, setSolStatus] = useState('idle') // idle | creating | waiting | confirmed
  const pollRef = useRef(null)

  const [stripeLoading, setStripeLoading] = useState(false)

  async function reload() {
    try {
      const [bal, hist] = await Promise.all([api.billingBalance(), api.billingHistory()])
      setBalance(bal.balance)
      setHistory(hist.history)
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => {
    reload()
    api.billingMethods().then(setMethods).catch(() => setMethods({ stripe: false, solana: false }))
    return () => clearInterval(pollRef.current)
  }, [])

  async function startSolanaRecharge() {
    setError('')
    setSolStatus('creating')
    try {
      const r = await api.solanaRecharge(Number(amount))
      setSolPayment(r)
      setSolStatus('waiting')
      pollRef.current = setInterval(async () => {
        try {
          const check = await api.solanaPaymentStatus(r.paymentId)
          if (check.confirmed) {
            clearInterval(pollRef.current)
            setSolStatus('confirmed')
            reload()
          }
        } catch (e) { /* segue tentando no próximo ciclo */ }
      }, 4000)
    } catch (e) {
      setError(e.message)
      setSolStatus('idle')
    }
  }

  async function startStripeCheckout() {
    setError('')
    setStripeLoading(true)
    try {
      const r = await api.stripeCheckout(Number(amount))
      window.location.href = r.checkoutUrl
    } catch (e) {
      setError(e.message)
      setStripeLoading(false)
    }
  }

  return (
    <div>
      <h1 className="section-title">{b.title}</h1>
      <p className="section-sub">{b.subtitle}</p>

      {error && <div className="card" style={{ marginBottom: 20, color: 'var(--danger, #f87171)' }}>{error}</div>}

      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">{b.balance}</div>
          <div className="stat-value mono">{balance === null ? '—' : `$${balance}`}</div>
          <div className="stat-sub">entrega $0,50/1000min + storage residual (só vídeo estático)</div>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label className="field-label">{b.amount} (USD)</label>
        <input type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} style={{ width: 160 }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <CreditCard size={17} color="var(--secondary)" />
            <h3 style={{ fontSize: 14.5 }}>{b.payWithCard}</h3>
          </div>
          {methods && !methods.stripe ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              Cartão desativado neste ambiente — falta configurar <code>VOD_STRIPE_SECRET_KEY</code> no backend.
            </div>
          ) : (
            <>
              <button className="btn btn-primary" style={{ width: '100%' }} disabled={stripeLoading} onClick={startStripeCheckout}>
                {stripeLoading ? <Loader2 size={15} className="spin" /> : <CreditCard size={15} />}
                {stripeLoading ? 'redirecionando...' : `${b.payWithCard} — $${Number(amount || 0).toFixed(2)}`}
              </button>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8 }}>
                Você vai pro checkout seguro do Stripe; o crédito cai aqui assim que o pagamento é confirmado (webhook).
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <Coins size={17} color="#9945FF" />
            <h3 style={{ fontSize: 14.5 }}>{b.payWithSol}</h3>
          </div>
          {methods && !methods.solana ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              Solana Pay desativado neste ambiente — falta configurar <code>VOD_SOLANA_TREASURY_WALLET</code> no backend.
            </div>
          ) : solStatus === 'idle' ? (
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={startSolanaRecharge}>
              <Coins size={15} /> Gerar QR Solana Pay — ${Number(amount || 0).toFixed(2)}
            </button>
          ) : solStatus === 'creating' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}><Loader2 size={15} className="spin" /> gerando cobrança...</div>
          ) : solStatus === 'confirmed' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--success)' }}>
              <CheckCircle2 size={16} /> pagamento confirmado on-chain, saldo atualizado!
            </div>
          ) : (
            <div style={{ textAlign: 'center' }}>
              <img src={solPayment.qrCodeImage} alt="QR Solana Pay" style={{ width: 160, height: 160, borderRadius: 8 }} />
              <div className="mono" style={{ fontSize: 12, marginTop: 8 }}>{solPayment.solAmount} SOL</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, color: 'var(--text-tertiary)', marginTop: 6 }}>
                <Loader2 size={13} className="spin" /> aguardando confirmação on-chain...
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 14.5 }}>{b.history}</h3>
          <button className="btn btn-secondary btn-sm"><Download size={13} /> {b.invoices}</button>
        </div>
        {history.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>sem lançamentos ainda.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{b.date}</th>
                <th>{b.method}</th>
                <th>{b.desc}</th>
                <th>{b.value}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i}>
                  <td className="mono">{new Date(h.date).toLocaleString()}</td>
                  <td>{h.method}</td>
                  <td>{h.desc}</td>
                  <td className="mono" style={{ color: h.value.startsWith('+') ? 'var(--success)' : 'var(--text-primary)' }}>{h.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
