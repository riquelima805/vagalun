import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { Folder, File, FileArchive, Upload, FolderPlus, Trash2, ChevronRight, Home, MoveRight, Loader, Pencil, X, Save } from 'lucide-react'
import './FileExplorer.css'

const EDITABLE_EXT = new Set(['html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'json', 'md', 'txt', 'svg', 'xml', 'yml', 'yaml', 'env', 'csv'])

function FileExplorer({ siteId, token, onChanged }) {
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef(null)

  const [editing, setEditing] = useState(null) // { path, content, original }
  const [editLoading, setEditLoading] = useState(false)
  const [editSaving, setEditSaving] = useState(false)

  const authHeaders = { Authorization: `Bearer ${token}` }

  useEffect(() => {
    load()
  }, [currentPath])

  const load = async () => {
    setLoading(true)
    try {
      const res = await axios.get(`/api/sites/${siteId}/files`, {
        headers: authHeaders,
        params: { path: currentPath }
      })
      setEntries(res.data.entries)
    } catch (err) {
      alert('Erro ao listar arquivos: ' + (err.response?.data?.error || err.message))
    } finally {
      setLoading(false)
    }
  }

  const notifyChanged = () => {
    if (onChanged) onChanged()
  }

  const openFolder = (name) => {
    setCurrentPath(currentPath ? `${currentPath}/${name}` : name)
  }

  const goToCrumb = (index) => {
    const parts = currentPath.split('/').filter(Boolean)
    setCurrentPath(parts.slice(0, index).join('/'))
  }

  const handleUploadClick = () => fileInputRef.current?.click()

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setBusy(true)
    const formData = new FormData()
    formData.append('file', file)
    formData.append('path', currentPath)

    try {
      await axios.post(`/api/sites/${siteId}/files/upload`, formData, {
        headers: { ...authHeaders, 'Content-Type': 'multipart/form-data' }
      })
      await load()
      notifyChanged()
    } catch (err) {
      alert('Erro no upload: ' + (err.response?.data?.error || err.message))
    } finally {
      setBusy(false)
    }
  }

  const handleExtract = async (entry) => {
    setBusy(true)
    try {
      await axios.post(`/api/sites/${siteId}/files/extract`, { path: entry.path }, { headers: authHeaders })
      await load()
      notifyChanged()
    } catch (err) {
      alert('Erro ao descompactar: ' + (err.response?.data?.error || err.message))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (entry) => {
    if (!confirm(`Apagar "${entry.name}"? Essa ação não pode ser desfeita.`)) return
    setBusy(true)
    try {
      await axios.delete(`/api/sites/${siteId}/files`, { headers: authHeaders, params: { path: entry.path } })
      await load()
      notifyChanged()
    } catch (err) {
      alert('Erro ao apagar: ' + (err.response?.data?.error || err.message))
    } finally {
      setBusy(false)
    }
  }

  const handleRename = async (entry) => {
    const newName = prompt('Novo nome:', entry.name)
    if (!newName || newName === entry.name) return
    const to = currentPath ? `${currentPath}/${newName}` : newName
    setBusy(true)
    try {
      await axios.post(`/api/sites/${siteId}/files/move`, { from: entry.path, to }, { headers: authHeaders })
      await load()
      notifyChanged()
    } catch (err) {
      alert('Erro ao renomear: ' + (err.response?.data?.error || err.message))
    } finally {
      setBusy(false)
    }
  }

  const handleMove = async (entry) => {
    const dest = prompt('Mover para qual pasta? (deixe vazio para raiz do site)', '')
    if (dest === null) return
    const cleanDest = dest.replace(/^\/+|\/+$/g, '')
    const to = cleanDest ? `${cleanDest}/${entry.name}` : entry.name
    setBusy(true)
    try {
      await axios.post(`/api/sites/${siteId}/files/move`, { from: entry.path, to }, { headers: authHeaders })
      await load()
      notifyChanged()
    } catch (err) {
      alert('Erro ao mover: ' + (err.response?.data?.error || err.message))
    } finally {
      setBusy(false)
    }
  }

  const handleNewFolder = async () => {
    const name = prompt('Nome da nova pasta:')
    if (!name) return
    setBusy(true)
    try {
      await axios.post(`/api/sites/${siteId}/files/mkdir`, { path: currentPath, name }, { headers: authHeaders })
      await load()
    } catch (err) {
      alert('Erro ao criar pasta: ' + (err.response?.data?.error || err.message))
    } finally {
      setBusy(false)
    }
  }

  const isEditableEntry = (entry) => {
    if (entry.type !== 'file') return false
    const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : ''
    return EDITABLE_EXT.has(ext)
  }

  const openEditor = async (entry) => {
    setEditLoading(true)
    setEditing({ path: entry.path, content: '', original: '' })
    try {
      const res = await axios.get(`/api/sites/${siteId}/files/content`, {
        headers: authHeaders,
        params: { path: entry.path }
      })
      setEditing({ path: entry.path, content: res.data.content, original: res.data.content })
    } catch (err) {
      alert('Erro ao abrir arquivo: ' + (err.response?.data?.error || err.message))
      setEditing(null)
    } finally {
      setEditLoading(false)
    }
  }

  const closeEditor = () => {
    if (editing && editing.content !== editing.original) {
      if (!confirm('Você tem alterações não salvas. Fechar mesmo assim?')) return
    }
    setEditing(null)
  }

  const saveEditor = async () => {
    if (!editing) return
    setEditSaving(true)
    try {
      await axios.put(`/api/sites/${siteId}/files/content`,
        { path: editing.path, content: editing.content },
        { headers: authHeaders }
      )
      setEditing(null)
      await load()
      notifyChanged()
    } catch (err) {
      alert('Erro ao salvar (e republicar nos nós): ' + (err.response?.data?.error || err.message))
    } finally {
      setEditSaving(false)
    }
  }

  const formatSize = (bytes) => {
    if (bytes === null || bytes === undefined) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  }

  const crumbs = currentPath.split('/').filter(Boolean)

  return (
    <div className="file-explorer">
      <div className="fe-toolbar">
        <div className="fe-breadcrumbs">
          <button className="fe-crumb" onClick={() => setCurrentPath('')}>
            <Home size={14} />
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="fe-crumb-group">
              <ChevronRight size={14} className="fe-crumb-sep" />
              <button className="fe-crumb" onClick={() => goToCrumb(i + 1)}>{c}</button>
            </span>
          ))}
        </div>
        <div className="fe-actions">
          <button className="fe-btn" onClick={handleNewFolder} disabled={busy}>
            <FolderPlus size={16} /> Nova pasta
          </button>
          <button className="fe-btn fe-btn-primary" onClick={handleUploadClick} disabled={busy}>
            <Upload size={16} /> Enviar arquivo
          </button>
          <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileSelected} />
        </div>
      </div>

      {loading ? (
        <div className="fe-loading"><Loader size={20} className="fe-spin" /> Carregando...</div>
      ) : entries.length === 0 ? (
        <div className="fe-empty">Pasta vazia. Envie um arquivo ou um .zip do seu projeto.</div>
      ) : (
        <table className="fe-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Tamanho</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => {
              const isZip = entry.type === 'file' && entry.name.toLowerCase().endsWith('.zip')
              return (
                <tr key={entry.path}>
                  <td>
                    <button
                      className="fe-name"
                      onClick={() => {
                        if (entry.type === 'folder') openFolder(entry.name)
                        else if (isEditableEntry(entry)) openEditor(entry)
                      }}
                      style={{ cursor: (entry.type === 'folder' || isEditableEntry(entry)) ? 'pointer' : 'default' }}
                    >
                      {entry.type === 'folder' ? <Folder size={16} className="fe-icon-folder" /> :
                       isZip ? <FileArchive size={16} className="fe-icon-zip" /> :
                       <File size={16} className="fe-icon-file" />}
                      {entry.name}
                    </button>
                  </td>
                  <td className="fe-size">{formatSize(entry.size)}</td>
                  <td className="fe-row-actions">
                    {isEditableEntry(entry) && (
                      <button className="fe-icon-btn" title="Editar" onClick={() => openEditor(entry)} disabled={busy}>
                        <Pencil size={15} />
                      </button>
                    )}
                    {isZip && (
                      <button className="fe-icon-btn" title="Descompactar aqui" onClick={() => handleExtract(entry)} disabled={busy}>
                        <FileArchive size={15} />
                      </button>
                    )}
                    <button className="fe-icon-btn" title="Mover" onClick={() => handleMove(entry)} disabled={busy}>
                      <MoveRight size={15} />
                    </button>
                    <button className="fe-icon-btn" title="Renomear" onClick={() => handleRename(entry)} disabled={busy}>
                      ✎
                    </button>
                    <button className="fe-icon-btn fe-icon-danger" title="Apagar" onClick={() => handleDelete(entry)} disabled={busy}>
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {editing && (
        <div className="fe-editor-overlay">
          <div className="fe-editor-panel">
            <div className="fe-editor-header">
              <span>{editing.path}</span>
              <div className="fe-editor-actions">
                <button className="fe-btn fe-btn-primary" onClick={saveEditor} disabled={editSaving || editLoading || editing.content === editing.original}>
                  {editSaving ? <><Loader size={14} className="fe-spin" /> Salvando e republicando...</> : <><Save size={14} /> Salvar e republicar</>}
                </button>
                <button className="fe-icon-btn" title="Fechar" onClick={closeEditor} disabled={editSaving}>
                  <X size={16} />
                </button>
              </div>
            </div>
            {editLoading ? (
              <div className="fe-loading"><Loader size={20} className="fe-spin" /> Abrindo...</div>
            ) : (
              <textarea
                className="fe-editor-textarea"
                value={editing.content}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                spellCheck={false}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default FileExplorer
