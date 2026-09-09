import { useI18n } from '../i18n/I18nContext'

export default function Docs() {
  const { t } = useI18n()
  const d = t.docs
  return (
    <div>
      <h1 className="section-title">{d.title}</h1>
      <p className="section-sub">{d.subtitle}</p>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 14.5, marginBottom: 10 }}>Endpoints</h3>
        <div className="code-panel">
          <span className="dim">POST</span> /api/streams/sign         <span className="dim">// gera push/play URL assinada</span><br />
          <span className="dim">GET</span>  /api/streams/health        <span className="dim">// snapshot de lives + kbps (media.js)</span><br />
          <span className="dim">POST</span> /api/directory/heartbeat  <span className="dim">{'// bytes relay/live -> pontos (points.js)'}</span><br />
          <span className="dim">GET</span>  /api/billing/balance      <span className="dim">// saldo de créditos</span><br />
          <span className="dim">POST</span> /api/billing/stripe/checkout<br />
          <span className="dim">POST</span> /api/billing/sol/deposit-address
        </div>
      </div>

      <div className="card">
        <h3 style={{ fontSize: 14.5, marginBottom: 10 }}>Node runtime</h3>
        <p style={{ fontSize: 13, marginBottom: 10 }}>
          Cada nó de PC roda a camada de mídia (RTMP ingest + HTTP-FLV egress via node-media-server),
          reporta bitrate real por stream a cada 5s e soma bytes servidos (ingest + egress) no heartbeat
          periódico para o servidor central, que credita pontos/créditos por banda de live e por relay TURN.
        </p>
        <div className="code-panel">
          <span className="dim">// media.js — createMediaLayer(...)</span><br />
          rtmp: {'{'} port, chunk_size, gop_cache, ping {'}'}<br />
          http: {'{'} port, allow_origin: <span className="green">'*'</span> {'}'}<br />
          auth: {'{'} publish: <span className="accent">true</span>, play: <span className="accent">false</span>, secret {'}'}
        </div>
      </div>
    </div>
  )
}
