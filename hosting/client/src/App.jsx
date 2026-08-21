import { useState, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import axios from 'axios'
import Layout from './components/Layout'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Sites from './pages/Sites'
import SiteDetail from './pages/SiteDetail'
import Billing from './pages/Billing'
import Consumption from './pages/Consumption'
import NodeMonitor from './pages/NodeMonitor'
import './App.css'

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState(localStorage.getItem('token'))

  useEffect(() => {
    if (token) {
      fetchUser()
    } else {
      setLoading(false)
    }
  }, [token])

  const fetchUser = async () => {
    try {
      const response = await axios.get('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` }
      })
      setUser(response.data)
    } catch (error) {
      console.error('Erro ao carregar usuário:', error)
      setToken(null)
      localStorage.removeItem('token')
    } finally {
      setLoading(false)
    }
  }

  const handleLogin = (newToken) => {
    setToken(newToken)
    localStorage.setItem('token', newToken)
  }

  const handleLogout = () => {
    setUser(null)
    setToken(null)
    localStorage.removeItem('token')
  }

  if (loading) {
    return <div className="loading-screen">
      <div className="spinner"></div>
      <p>Carregando...</p>
    </div>
  }

  return (
    <Router basename="/app">
      <Layout user={user} onLogout={handleLogout}>
        <Routes>
          <Route path="/login" element={!token ? <Login onLogin={handleLogin} /> : <Navigate to="/dashboard" />} />
          <Route path="/register" element={!token ? <Register onLogin={handleLogin} /> : <Navigate to="/dashboard" />} />
          <Route path="/" element={!token ? <Navigate to="/login" /> : <Navigate to="/dashboard" />} />
          <Route path="/dashboard" element={token ? <Dashboard user={user} token={token} /> : <Navigate to="/login" />} />
          <Route path="/sites" element={token ? <Sites token={token} /> : <Navigate to="/login" />} />
          <Route path="/sites/:siteId" element={token ? <SiteDetail token={token} /> : <Navigate to="/login" />} />
          <Route path="/billing" element={token ? <Billing user={user} token={token} onPlanChange={fetchUser} /> : <Navigate to="/login" />} />
          <Route path="/consumo" element={token ? <Consumption token={token} /> : <Navigate to="/login" />} />
          <Route path="/nos" element={token ? <NodeMonitor /> : <Navigate to="/login" />} />
        </Routes>
      </Layout>
    </Router>
  )
}

export default App
