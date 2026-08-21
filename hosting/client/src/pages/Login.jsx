import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import axios from 'axios'
import {
  LogIn,
  Mail,
  LockKeyhole,
  Eye,
  EyeOff
} from 'lucide-react'
import './Auth.css'

function Login({ onLogin }) {
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await axios.post('/api/auth/login', {
        email,
        password
      })

      onLogin(response.data.token)
      navigate('/dashboard')
    } catch (err) {
      setError(err.response?.data?.error || 'Erro ao fazer login')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card">

        {/* Cabeçalho */}
        <div className="auth-header">
          <div className="auth-icon">
            <LogIn size={30} strokeWidth={2} />
          </div>

          <h1>Entrar</h1>
          <p>Acesse sua conta para continuar</p>
        </div>

        {error && (
          <div className="alert alert-error">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>

          {/* EMAIL */}
          <div className="form-group">
            <label>Email</label>

            <div className="input-wrapper">
              <Mail
                className="input-icon"
                size={19}
                strokeWidth={1.8}
              />

              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="seu@email.com"
                required
              />
            </div>
          </div>

          {/* SENHA */}
          <div className="form-group">
            <label>Senha</label>

            <div className="input-wrapper">
              <LockKeyhole
                className="input-icon"
                size={19}
                strokeWidth={1.8}
              />

              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Sua senha"
                required
              />

              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={
                  showPassword
                    ? 'Ocultar senha'
                    : 'Mostrar senha'
                }
              >
                {showPassword ? (
                  <EyeOff size={19} />
                ) : (
                  <Eye size={19} />
                )}
              </button>
            </div>
          </div>

          {/* BOTÃO */}
          <button
            type="submit"
            className="btn-primary"
            disabled={loading}
          >
            {loading ? (
              'Entrando...'
            ) : (
              <>
                <LogIn size={18} />
                Entrar
              </>
            )}
          </button>

        </form>

        <p className="auth-footer">
          Não tem conta?{' '}
          <Link to="/register">
            Criar conta
          </Link>
        </p>

      </div>
    </div>
  )
}

export default Login