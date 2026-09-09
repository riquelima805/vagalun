import { useState } from 'react'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import { useI18n } from './i18n/I18nContext'
import { AuthProvider, useAuth } from './auth/AuthContext'
import Login from './pages/Login'
import Overview from './pages/Overview'
import Videos from './pages/Videos'
import Streams from './pages/Streams'
import ApiKeys from './pages/ApiKeys'
import Billing from './pages/Billing'
import Pricing from './pages/Pricing'
import Docs from './pages/Docs'
import './App.css'

const PAGES = {
  overview: Overview,
  videos: Videos,
  streams: Streams,
  apiKeys: ApiKeys,
  billing: Billing,
  pricing: Pricing,
  docs: Docs,
}

function Shell() {
  const [page, setPage] = useState('overview')
  const { t } = useI18n()
  const { user, logout } = useAuth()
  const Page = PAGES[page]
  const navLabel = page === 'videos' ? (t.nav.videos || 'Vídeos') : t.nav[page]

  return (
    <div className="app-shell">
      <Sidebar page={page} setPage={setPage} />
      <div className="app-main-col">
        <Topbar title={navLabel} userEmail={user?.email} onLogout={logout} />
        <main className="app-content">
          <div className="container" style={{ padding: '28px 32px', maxWidth: 1200 }}>
            <Page />
          </div>
        </main>
      </div>
    </div>
  )
}

function Gate() {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ padding: 40 }}>carregando...</div>
  if (!user) return <Login />
  return <Shell />
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
