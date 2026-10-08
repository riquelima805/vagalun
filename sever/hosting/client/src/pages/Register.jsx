import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import axios from 'axios'
import { UserPlus } from 'lucide-react'
import { useTranslation } from '../i18n/LanguageContext'
import './Auth.css'

function Register({ onLogin }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [pendingVerification, setPendingVerification] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError(t('auth.register.passwordMismatch'))
      return
    }

    if (password.length < 6) {
      setError(t('auth.register.passwordTooShort'))
      return
    }

    setLoading(true)

    try {
      const response = await axios.post('/api/auth/register', {
        name,
        email,
        password
      })

      if (response.data.requiresEmailVerification) {
        setPendingVerification(true)
        return
      }

      onLogin(response.data.token)
      navigate('/dashboard')
    } catch (err) {
      setError(err.response?.data?.error || t('auth.register.error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <UserPlus size={40} />
          <h1>{t('auth.register.title')}</h1>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {pendingVerification ? (
          <div className="alert alert-success">
            {t('auth.register.pendingVerification')} <strong>{email}</strong>.
            {' '}{t('auth.register.pendingVerificationTail')}
          </div>
        ) : (
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{t('auth.register.name')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('auth.register.namePlaceholder')}
              required
            />
          </div>

          <div className="form-group">
            <label>{t('auth.register.email')}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('auth.login.emailPlaceholder')}
              required
            />
          </div>

          <div className="form-group">
            <label>{t('auth.register.password')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <div className="form-group">
            <label>{t('auth.register.confirmPassword')}</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <button 
            type="submit" 
            className="btn-primary"
            disabled={loading}
          >
            {loading ? t('auth.register.submitting') : t('auth.register.submit')}
          </button>
        </form>
        )}

        <p className="auth-footer">
          {t('auth.register.haveAccount')} <Link to="/login">{t('auth.register.doLogin')}</Link>
        </p>
      </div>
    </div>
  )
}

export default Register
