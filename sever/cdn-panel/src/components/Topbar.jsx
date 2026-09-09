import { useEffect, useState } from 'react'
import { Globe, Zap, LogOut } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'
import { api } from '../api/client'
import './Topbar.css'

const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'pt', label: 'Português' },
]

export default function Topbar({ title, userEmail, onLogout }) {
  const { lang, setLanguage, t } = useI18n()
  const [balance, setBalance] = useState(null)

  useEffect(() => {
    api.billingBalance().then((r) => setBalance(r.balance)).catch(() => setBalance(null))
  }, [])

  return (
    <header className="topbar">
      <div className="topbar-title">{title}</div>
      <div className="topbar-right">
        <div className="credit-pill" title={t.overview.credits}>
          <Zap size={14} />
          <span>{balance === null ? '—' : `$${balance}`}</span>
        </div>
        {userEmail && (
          <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }} title={userEmail}>
            {userEmail}
          </span>
        )}
        <div className="lang-select">
          <Globe size={15} />
          <select value={lang} onChange={(e) => setLanguage(e.target.value)} aria-label={t.common.language}>
            {LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>
        {onLogout && (
          <button className="icon-btn" title="Sair" onClick={onLogout}>
            <LogOut size={16} />
          </button>
        )}
      </div>
    </header>
  )
}
