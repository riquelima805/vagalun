import { createContext, useContext, useEffect, useState } from 'react'
import { api } from '../api/client'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = api.getToken()
    if (!token) { setLoading(false); return }
    api.me()
      .then((r) => setUser({ userId: r.userId, email: r.email }))
      .catch(() => api.setToken(null))
      .finally(() => setLoading(false))
  }, [])

  async function login(email, password) {
    const r = await api.login(email, password)
    api.setToken(r.token)
    setUser({ userId: r.userId, email: r.email })
  }

  async function register(email, password) {
    const r = await api.register(email, password)
    api.setToken(r.token)
    setUser({ userId: r.userId, email: r.email })
  }

  function logout() {
    api.setToken(null)
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth precisa estar dentro de <AuthProvider>')
  return ctx
}
