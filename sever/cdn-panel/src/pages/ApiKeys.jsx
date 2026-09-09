import { useState } from 'react'
import { Eye, EyeOff, RefreshCw, Copy } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'

function KeyField({ label, value, sub }) {
  const [visible, setVisible] = useState(false)
  const { t } = useI18n()
  const masked = value.slice(0, 6) + '••••••••••••••••••••••' + value.slice(-4)
  return (
    <div style={{ marginBottom: 18 }}>
      <label className="field-label">{label}</label>
      <div className="copy-row">
        <div className="code-panel mono" style={{ flex: 1 }}>{visible ? value : masked}</div>
        <button className="icon-btn" onClick={() => setVisible(v => !v)}>
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
        <button className="icon-btn" onClick={() => navigator.clipboard?.writeText(value)}>
          <Copy size={16} />
        </button>
        <button className="btn btn-secondary btn-sm"><RefreshCw size={13} /> {t.apiKeys.regenerate}</button>
      </div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

export default function ApiKeys() {
  const { t } = useI18n()
  const k = t.apiKeys
  const [webhook, setWebhook] = useState('https://seusite.com/api/webhooks/vagalun')

  return (
    <div>
      <h1 className="section-title">{k.title}</h1>
      <p className="section-sub">{k.subtitle}</p>

      <div className="card" style={{ marginBottom: 20 }}>
        <KeyField
          label={k.publishSecret}
          value="pub_sk_9f13a7c2e8b04d51af6c3e0d9b7712fa"
          sub={`${k.created}: 2026-04-11 · ${k.lastUsed}: 2026-09-03 21:42 UTC`}
        />
        <KeyField
          label={k.readKey}
          value="read_pk_2b8e4471d0c9a536f7e1908cba4e2201"
          sub={`${k.created}: 2026-04-11 · ${k.lastUsed}: 2026-09-04 08:10 UTC`}
        />

        <label className="field-label">{k.webhook}</label>
        <input className="mono" value={webhook} onChange={e => setWebhook(e.target.value)} />
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', margin: '6px 0 14px' }}>{k.webhookHint}</div>
        <button className="btn btn-primary">{k.save}</button>
      </div>

      <div className="card">
        <h3 style={{ fontSize: 14.5, marginBottom: 10 }}>{k.curlExample}</h3>
        <div className="code-panel">
          <span className="dim">&lt;?php</span><br />
          <span className="accent">function</span> PrivateKey_vagalun($streamPath, $ttl = 3600) {'{'}<br />
          &nbsp;&nbsp;$secret = getenv(<span className="green">'VAGALUN_PUBLISH_SECRET'</span>);<br />
          &nbsp;&nbsp;$exp = time() + $ttl;<br />
          &nbsp;&nbsp;$hash = md5($streamPath . <span className="green">'-'</span> . $exp . <span className="green">'-'</span> . $secret);<br />
          &nbsp;&nbsp;<span className="accent">return</span> $exp . <span className="green">'-'</span> . $hash;<br />
          {'}'}<br /><br />
          <span className="dim">// rtmp://NODE_HOST:1935{'{'}streamPath{'}'}?sign={'{'}PrivateKey_vagalun($streamPath){'}'}</span>
        </div>
      </div>
    </div>
  )
}
