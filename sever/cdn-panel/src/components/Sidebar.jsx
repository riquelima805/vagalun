import { LayoutGrid, Radio, KeyRound, CreditCard, Tags, BookOpen, Film } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'
import './Sidebar.css'

function FireflyIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9.5 10c-2.5-1.5-5-1-6 .5s0 3.5 2 3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.75" />
      <path d="M14.5 10c2.5-1.5 5-1 6 .5s0 3.5-2 3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.75" />
      <ellipse cx="12" cy="12.5" rx="3.1" ry="4.2" fill="currentColor" />
      <circle cx="12" cy="7.4" r="1.9" fill="currentColor" />
      <path d="M11 6.2c-.6-1-1.6-1.5-2.4-1.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M13 6.2c.6-1 1.6-1.5 2.4-1.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="12" cy="17.4" r="2.1" fill="#ffd166" />
      <circle cx="12" cy="17.4" r="3.4" fill="#ffd166" opacity="0.35" />
    </svg>
  )
}

export default function Sidebar({ page, setPage }) {
  const { t } = useI18n()
  const items = [
    { id: 'overview', icon: LayoutGrid, label: t.nav.overview },
    { id: 'videos', icon: Film, label: t.nav.videos },
    { id: 'streams', icon: Radio, label: t.nav.streams },
    { id: 'apiKeys', icon: KeyRound, label: t.nav.apiKeys },
    { id: 'billing', icon: CreditCard, label: t.nav.billing },
    { id: 'pricing', icon: Tags, label: t.nav.pricing },
    { id: 'docs', icon: BookOpen, label: t.nav.docs },
  ]
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo"><FireflyIcon size={18} /></span>
        <span>{t.brand}</span>
      </div>
      <nav className="sidebar-nav">
        {items.map(item => {
          const Icon = item.icon
          const active = page === item.id
          return (
            <button key={item.id} className={`sidebar-link ${active ? 'active' : ''}`} onClick={() => setPage(item.id)}>
              <Icon size={17} />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>
      <div className="sidebar-footer">
        <span className="dim">node-media-server</span>
        <span className="dim">RTMP · HTTP-FLV</span>
      </div>
    </aside>
  )
}
