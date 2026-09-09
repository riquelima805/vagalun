import { useEffect, useRef, useState } from 'react'
import { UploadCloud, Trash2, Copy, Film } from 'lucide-react'
import { api } from '../api/client'

function formatBytes(n) {
  if (!n && n !== 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(1)} ${units[i]}`
}

// Lê a duração real do vídeo no navegador antes de subir — usada pelo
// backend pra converter bytes entregues em minutos com precisão (sem isso,
// ele cai num bitrate aproximado, ver vod-api/billing.js).
function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(v.duration || null) }
    v.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    v.src = url
  })
}

export default function Videos() {
  const [videos, setVideos] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [progressMsg, setProgressMsg] = useState('')
  const fileInputRef = useRef(null)

  async function reload() {
    setLoading(true)
    try {
      const r = await api.videos()
      setVideos(r.videos)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [])

  async function handleFiles(fileList) {
    const files = Array.from(fileList)
    if (files.length === 0) return
    setError('')
    setUploading(true)
    try {
      setProgressMsg('lendo duração dos vídeos...')
      const durations = await Promise.all(files.map(readDuration))
      setProgressMsg(`enviando ${files.length} arquivo(s)...`)
      const r = await api.uploadVideos(files, durations)
      const failed = r.results.filter((x) => !x.ok)
      if (failed.length) setError(failed.map((f) => `${f.fileName}: ${f.error}`).join(' · '))
      await reload()
    } catch (e) {
      setError(e.message)
    } finally {
      setUploading(false)
      setProgressMsg('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleDelete(fileId) {
    if (!confirm('Apagar este vídeo? Isso remove os shards de todos os nós.')) return
    await api.deleteVideo(fileId)
    reload()
  }

  return (
    <div>
      <h1 className="section-title">Vídeos</h1>
      <p className="section-sub">Upload direto pra rede distribuída (qualquer formato de vídeo, sem limite de arquivos). Cobrança: entrega $0,50/1000min + storage residual.</p>

      <div className="card" style={{ marginBottom: 20 }}>
        <label
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            border: '2px dashed var(--border-subtle)', borderRadius: 10, padding: '32px 20px',
            cursor: 'pointer', textAlign: 'center',
          }}
        >
          <UploadCloud size={28} color="var(--primary)" />
          <span style={{ fontSize: 13.5 }}>
            {uploading ? progressMsg || 'enviando...' : 'Clique ou arraste vídeos aqui (qualquer formato, quantos quiser)'}
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,.mkv,.ts,.flv"
            multiple
            style={{ display: 'none' }}
            disabled={uploading}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </label>
        {error && <div style={{ color: 'var(--danger, #f87171)', fontSize: 13, marginTop: 10 }}>{error}</div>}
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Film size={17} color="var(--primary)" />
          <h3 style={{ fontSize: 15 }}>Seus vídeos {loading ? '' : `(${videos.length})`}</h3>
        </div>

        {loading ? (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>carregando...</div>
        ) : videos.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>nenhum vídeo publicado ainda.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Tamanho</th>
                <th>Duração</th>
                <th>Min. entregues</th>
                <th>URL de play</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {videos.map((v) => (
                <tr key={v.fileId}>
                  <td>{v.fileName}</td>
                  <td className="mono">{formatBytes(v.sizeBytes)}</td>
                  <td className="mono">{v.durationSeconds ? `${Math.round(v.durationSeconds)}s` : '—'}</td>
                  <td className="mono">{v.minutesDelivered}</td>
                  <td>
                    <div className="copy-row">
                      <div className="code-panel mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                        {api.BASE_URL}{v.playUrl}
                      </div>
                      <button className="icon-btn" onClick={() => navigator.clipboard?.writeText(`${api.BASE_URL}${v.playUrl}`)}>
                        <Copy size={14} />
                      </button>
                    </div>
                  </td>
                  <td>
                    <button className="icon-btn" onClick={() => handleDelete(v.fileId)} title="Apagar">
                      <Trash2 size={15} color="var(--danger, #f87171)" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
