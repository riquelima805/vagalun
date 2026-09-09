import { useState } from 'react'
import { LogIn, UserPlus } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'

export default function Login() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'register'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'login') await login(email, password)
      else await register(email, password)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base, #0d0d10)' }}>
      <form onSubmit={handleSubmit} className="card" style={{ width: 360, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h1 className="section-title" style={{ marginBottom: 0 }}>vagalun</h1>
        <p className="section-sub" style={{ marginTop: -6 }}>
          {mode === 'login' ? 'Entrar no painel de CDN' : 'Criar conta no painel de CDN'}
        </p>

        <div>
          <label className="field-label">E-mail</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@empresa.com" />
        </div>
        <div>
          <label className="field-label">Senha</label>
          <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="mínimo 8 caracteres" />
        </div>

        {error && <div style={{ color: 'var(--danger, #f87171)', fontSize: 13 }}>{error}</div>}

        <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
          {mode === 'login' ? <LogIn size={15} /> : <UserPlus size={15} />}
          {loading ? 'Aguarda...' : mode === 'login' ? 'Entrar' : 'Criar conta'}
        </button>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}
        >
          {mode === 'login' ? 'Não tem conta? Criar uma' : 'Já tem conta? Entrar'}
        </button>
      </form>
    </div>
  )
}
