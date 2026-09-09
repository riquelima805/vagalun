import { useState, useRef, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Menu, LogOut, Globe, CreditCard,
  LayoutDashboard, ChevronDown, Languages
} from 'lucide-react'
import { useTranslation } from '../i18n/LanguageContext'
import './Header.css'


function FireflyIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* asa esquerda */}
      <path
        d="M9.5 10c-2.5-1.5-5-1-6 .5s0 3.5 2 3.8"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.75"
      />
      {/* asa direita */}
      <path
        d="M14.5 10c2.5-1.5 5-1 6 .5s0 3.5-2 3.8"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.75"
      />
      {/* corpo */}
      <ellipse cx="12" cy="12.5" rx="3.1" ry="4.2" fill="currentColor" />
      {/* cabeça */}
      <circle cx="12" cy="7.4" r="1.9" fill="currentColor" />
      {/* antenas */}
      <path d="M11 6.2c-.6-1-1.6-1.5-2.4-1.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M13 6.2c.6-1 1.6-1.5 2.4-1.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      {/* brilho da cauda (glow) */}
      <circle cx="12" cy="17.4" r="2.1" fill="#ffd166" />
      <circle cx="12" cy="17.4" r="3.4" fill="#ffd166" opacity="0.35" />
    </svg>
  )
}

// Itens do mega-menu "Produto" — ícone com cor própria + título + descrição
// curta. Título/descrição são traduzidos no componente via chave i18n.
const productItems = [
  {
    to: '/dashboard',
    icon: LayoutDashboard,
    color: '#e11d3f',
    bg: '#fdecef',
    titleKey: 'nav.dashboard',
    descKey: 'nav.dashboard.desc'
  },
  {
    to: '/sites',
    icon: Globe,
    color: '#059669',
    bg: '#ecfdf5',
    titleKey: 'nav.sites',
    descKey: 'nav.sites.desc'
  },
  {
    to: '/billing',
    icon: CreditCard,
    color: '#2563eb',
    bg: '#eff4ff',
    titleKey: 'nav.billing',
    descKey: 'nav.billing.desc'
  },
]

function Header({ user, onLogout }) {
  const navigate = useNavigate()
  const { t, lang, setLang } = useTranslation()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleLogout = () => {
    onLogout()
    navigate('/login')
  }

  return (
    <header className="header">
      <div className="container header-content">
        <Link to="/" className="logo">
          <span className="logo-icon"><FireflyIcon size={18} /></span>
          <span className="logo-text">Vagalun</span>
        </Link>

        {user && (
          <nav className={`nav ${mobileMenuOpen ? 'mobile-open' : ''}`}>
            <div className="nav-item mega-trigger" ref={menuRef}>
              <button
                className={`nav-link mega-btn ${menuOpen ? 'active' : ''}`}
                onClick={() => setMenuOpen(o => !o)}
              >
                Produto
                <ChevronDown size={15} className={`chev ${menuOpen ? 'rotated' : ''}`} />
              </button>

              {menuOpen && (
                <div className="mega-menu">
                  {productItems.map(item => {
                    const Icon = item.icon
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        className="mega-item"
                        onClick={() => setMenuOpen(false)}
                      >
                        <span className="mega-icon" style={{ background: item.bg, color: item.color }}>
                          <Icon size={20} strokeWidth={2} />
                        </span>
                        <span className="mega-text">
                          <span className="mega-title">{t(item.titleKey)}</span>
                          <span className="mega-desc">{t(item.descKey)}</span>
                        </span>
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>

            <Link to="/sites" className="nav-link">{t('nav.sites')}</Link>
            <Link to="/consumo" className="nav-link">{t('nav.consumption')}</Link>
            <Link to="/nos" className="nav-link">{t('nav.nodes')}</Link>
            <Link to="/billing" className="nav-link">{t('nav.billing')}</Link>

            <button
              className="btn-lang"
              onClick={() => setLang(lang === 'pt' ? 'en' : 'pt')}
              title={t('nav.language')}
            >
              <Languages size={16} />
              {lang.toUpperCase()}
            </button>

            <div className="user-menu">
              <span className="user-avatar">{user.name?.[0]?.toUpperCase() || 'U'}</span>
              <span className="user-name">{user.name}</span>
              <button className="btn-logout" onClick={handleLogout} title={t('nav.logout')}>
                <LogOut size={17} />
              </button>
            </div>
          </nav>
        )}

        {!user && (
          <nav className="nav nav-guest">
            <button
              className="btn-lang"
              onClick={() => setLang(lang === 'pt' ? 'en' : 'pt')}
              title={t('nav.language')}
            >
              <Languages size={16} />
              {lang.toUpperCase()}
            </button>
            <Link to="/login" className="nav-link">{t('nav.login')}</Link>
            <Link to="/register" className="btn btn-primary btn-sm">{t('nav.register')}</Link>
          </nav>
        )}

        {user && (
          <button
            className="mobile-toggle"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            <Menu size={22} />
          </button>
        )}
      </div>
    </header>
  )
}

export default Header