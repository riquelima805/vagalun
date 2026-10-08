import { useEffect, useState } from 'react'
import { useSearchParams, Link, useNavigate } from 'react-router-dom'
import axios from 'axios'
import { CheckCircle, XCircle, Loader } from 'lucide-react'
import { useTranslation } from '../i18n/LanguageContext'
import './Auth.css'

function VerifyEmail({ onLogin }) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [status, setStatus] = useState('loading') // loading | ok | error
  const [message, setMessage] = useState('')

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token) {
      setStatus('error')
      setMessage(t('auth.verify.invalidLink'))
      return
    }

    axios.get(`/api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then((response) => {
        setStatus('ok')
        onLogin(response.data.token)
        setTimeout(() => navigate('/dashboard'), 1500)
      })
      .catch((err) => {
        setStatus('error')
        setMessage(err.response?.data?.error || t('auth.verify.genericError'))
      })
  }, [])

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          {status === 'loading' && <Loader size={40} className="spin" />}
          {status === 'ok' && <CheckCircle size={40} />}
          {status === 'error' && <XCircle size={40} />}
          <h1>{t('auth.verify.title')}</h1>
        </div>

        {status === 'loading' && <p>{t('auth.verify.loading')}</p>}
        {status === 'ok' && (
          <div className="alert alert-success">
            {t('auth.verify.success')}
          </div>
        )}
        {status === 'error' && (
          <>
            <div className="alert alert-error">{message}</div>
            <p className="auth-footer">
              <Link to="/login">{t('auth.verify.backToLogin')}</Link>
            </p>
          </>
        )}
      </div>
    </div>
  )
}

export default VerifyEmail
