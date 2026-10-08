import Header from './Header'
import './Layout.css'

/**
 * Layout principal da plataforma.
 * Envolve qualquer página autenticada: <Layout user={user} onLogout={...}><Dashboard /></Layout>
 */
function Layout({ user, onLogout, children }) {
  return (
    <div className="app-shell">
      <Header user={user} onLogout={onLogout} />
      <main className="app-main">
        <div className="container">{children}</div>
      </main>
    </div>
  )
}

export default Layout
