import { useState } from 'react'
import { Copy, Check, RefreshCw, Info } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'
import { md5 } from '../utils/md5'

const NODE_HOST = 'live.vagalun.net'
const RTMP_PORT = 1935
const HTTP_PORT = 8000
// secret ilustrativo — em produção isso NUNCA fica no cliente, só no
// backend (media.js), igual o publish_secret aparece mascarado na
// página de API Keys.
const DEMO_SECRET = 'demo-secret-not-real'

function CodePanel({ children }) {
  return <div className="code-panel">{children}</div>
}

function CopyRow({ value }) {
  const [copied, setCopied] = useState(false)
  const { t } = useI18n()
  const doCopy = () => {
    navigator.clipboard?.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="copy-row">
      <div className="code-panel mono" style={{ wordBreak: 'break-all' }}>{value}</div>
      <button className="icon-btn" onClick={doCopy} title={copied ? t.streams.copied : t.streams.copy}>
        {copied ? <Check size={16} color="var(--success)" /> : <Copy size={16} />}
      </button>
    </div>
  )
}

export default function Streams() {
  const { t } = useI18n()
  const s = t.streams
  const [streamPath, setStreamPath] = useState('/live/ch_9f2a')
  const [ttl, setTtl] = useState(3600)
  const [signed, setSigned] = useState(null)

  const generate = () => {
    const exp = Math.floor(Date.now() / 1000) + Number(ttl || 3600)
    const hash = md5(`${streamPath}-${exp}-${DEMO_SECRET}`)
    const sign = `${exp}-${hash}`
    setSigned({
      push: `rtmp://${NODE_HOST}:${RTMP_PORT}${streamPath}?sign=${sign}`,
      play: `http://${NODE_HOST}:${HTTP_PORT}${streamPath}.flv?sign=${sign}`,
    })
  }

  const health = [
    { path: '/live/ch_9f2a', kbps: 2140 },
    { path: '/live/ch_a01c', kbps: 980 },
  ]

  return (
    <div>
      <h1 className="section-title">{s.title}</h1>
      <p className="section-sub">{s.subtitle}</p>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 12, alignItems: 'end', marginBottom: 20 }}>
          <div>
            <label className="field-label">{s.streamPath}</label>
            <input className="mono" value={streamPath} onChange={e => setStreamPath(e.target.value)} placeholder="/live/ch_xxxx" />
          </div>
          <div>
            <label className="field-label">{s.ttl}</label>
            <input type="number" className="mono" value={ttl} onChange={e => setTtl(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={generate}>
            <RefreshCw size={15} /> {s.generate}
          </button>
        </div>

        {signed && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label className="field-label">{s.ingestUrl}</label>
              <CopyRow value={signed.push} />
            </div>
            <div>
              <label className="field-label">{s.playUrl}</label>
              <CopyRow value={signed.play} />
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 20 }}>
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Info size={16} color="var(--secondary)" />
            <h3 style={{ fontSize: 14.5 }}>{s.howItWorks}</h3>
          </div>
          <p style={{ fontSize: 13, marginBottom: 12 }}>{s.howItWorksBody}</p>
          <CodePanel>
            <span className="dim">// media.js</span><br />
            <span className="accent">sign</span> = md5(streamPath + <span className="green">"-"</span> + exp + <span className="green">"-"</span> + secret)<br />
            <span className="accent">url</span> = `${'{'}proto{'}'}://{'{'}host{'}'}:{'{'}port{'}'}{'{'}streamPath{'}'}?sign=${'{'}exp{'}'}-${'{'}hash{'}'}`
          </CodePanel>

          <h4 style={{ fontSize: 13.5, margin: '18px 0 8px' }}>{s.obs}</h4>
          <div style={{ display: 'grid', gap: 8 }}>
            <div>
              <label className="field-label">{s.obsServer}</label>
              <div className="code-panel mono">rtmp://{NODE_HOST}:{RTMP_PORT}/live</div>
            </div>
            <div>
              <label className="field-label">{s.obsKey}</label>
              <div className="code-panel mono">ch_9f2a?sign=1735999999-8f2a...</div>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 style={{ fontSize: 14.5, marginBottom: 12 }}>{s.health}</h3>
          {health.map((h, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: i < health.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
              <div>
                <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{h.path}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{s.activeLives}</div>
              </div>
              <div className="badge badge-live"><span className="dot" />{h.kbps} {s.kbps}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
