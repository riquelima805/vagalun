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
import { useTranslation } from '../i18n/LanguageContext'
import './Auth.css'

function Login({ onLogin }) {
  const navigate = useNavigate()
  const { t } = useTranslation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [emailNotVerified, setEmailNotVerified] = useState(false)
  const [resendMsg, setResendMsg] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setEmailNotVerified(false)
    setResendMsg('')
    setLoading(true)

    try {
      const response = await axios.post('/api/auth/login', {
        email,
        password
      })

      onLogin(response.data.token)
      navigate('/dashboard')
    } catch (err) {
      setError(err.response?.data?.error || t('auth.login.error'))
      if (err.response?.data?.emailNotVerified) setEmailNotVerified(true)
    } finally {
      setLoading(false)
    }
  }

  const handleResend = async () => {
    setResendMsg('')
    try {
      const response = await axios.post('/api/auth/resend-verification', { email })
      setResendMsg(response.data.message)
    } catch {
      setResendMsg(t('auth.login.resendFailed'))
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

          <h1>{t('auth.login.title')}</h1>
          <p>{t('auth.login.subtitle')}</p>
        </div>

        {error && (
          <div className="alert alert-error">
            {error}
            {emailNotVerified && (
              <>
                {' '}
                <button type="button" className="link-btn" onClick={handleResend}>
                  {t('auth.login.resend')}
                </button>
              </>
            )}
          </div>
        )}
        {resendMsg && <div className="alert alert-success">{resendMsg}</div>}

        <form onSubmit={handleSubmit}>

          {/* EMAIL */}
          <div className="form-group">
            <label>{t('auth.login.email')}</label>

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
                placeholder={t('auth.login.emailPlaceholder')}
                required
              />
            </div>
          </div>

          {/* SENHA */}
          <div className="form-group">
            <label>{t('auth.login.password')}</label>

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
                placeholder={t('auth.login.passwordPlaceholder')}
                required
              />

              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={
                  showPassword
                    ? t('auth.login.hidePassword')
                    : t('auth.login.showPassword')
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
              t('auth.login.submitting')
            ) : (
              <>
                <LogIn size={18} />
                {t('auth.login.submit')}
              </>
            )}
          </button>

        </form>

        <p className="auth-footer">
          {t('auth.login.noAccount')}{' '}
          <Link to="/register">
            {t('auth.login.createAccount')}
          </Link>
        </p>

      </div>
    </div>
  )
}

export default Login