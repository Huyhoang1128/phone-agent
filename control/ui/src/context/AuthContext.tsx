import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AuthUser } from '@/lib/types'

interface AuthContextValue {
  user: AuthUser | null
  accessToken: string | null
  isLoading: boolean
  login: (usernameOrEmail: string, password: string) => Promise<void>
  register: (data: {
    username: string
    email: string
    password: string
    first_name?: string
    last_name?: string
    display_name?: string
  }) => Promise<void>
  logout: () => void
  updateUser: (user: AuthUser) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

const ACCESS_KEY = 'access_token'
const REFRESH_KEY = 'refresh_token'

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? ''
const isAuthFailureStatus = (status: number) => status === 401

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(() => localStorage.getItem(ACCESS_KEY))
  const [isLoading, setIsLoading] = useState(true)

  // On mount, try to load the current user using stored access token (or refresh)
  useEffect(() => {
    const init = async () => {
      const token = localStorage.getItem(ACCESS_KEY)
      if (!token) {
        setIsLoading(false)
        return
      }
      try {
        const res = await fetch(`${BASE}/api/auth/me/`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = await res.json()
          setUser(data)
          setAccessToken(token)
        } else if (isAuthFailureStatus(res.status)) {
          // Try refresh
          await tryRefresh()
        }
      } catch {
        // Keep tokens on transient network/server failures.
      } finally {
        setIsLoading(false)
      }
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function tryRefresh(): Promise<boolean> {
    const refresh = localStorage.getItem(REFRESH_KEY)
    if (!refresh) return false
    try {
      const res = await fetch(`${BASE}/api/auth/refresh/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh }),
      })
      if (!res.ok) {
        if (isAuthFailureStatus(res.status)) clearTokens()
        return false
      }
      const { access, refresh: newRefresh } = await res.json()
      localStorage.setItem(ACCESS_KEY, access)
      if (newRefresh) localStorage.setItem(REFRESH_KEY, newRefresh)
      setAccessToken(access)
      // Fetch user
      const meRes = await fetch(`${BASE}/api/auth/me/`, {
        headers: { Authorization: `Bearer ${access}` },
      })
      if (meRes.ok) {
        setUser(await meRes.json())
      } else if (isAuthFailureStatus(meRes.status)) {
        clearTokens()
        return false
      }
      return true
    } catch {
      // Keep tokens on transient network/server failures.
      return false
    }
  }

  function clearTokens() {
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
    setAccessToken(null)
    setUser(null)
  }

  async function login(usernameOrEmail: string, password: string) {
    const res = await fetch(`${BASE}/api/auth/login/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameOrEmail, password }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || 'Login failed.')
    }
    const data = await res.json()
    localStorage.setItem(ACCESS_KEY, data.access)
    localStorage.setItem(REFRESH_KEY, data.refresh)
    setAccessToken(data.access)
    setUser(data.user)
  }

  async function register(payload: {
    username: string
    email: string
    password: string
    first_name?: string
    last_name?: string
    display_name?: string
  }) {
    const res = await fetch(`${BASE}/api/auth/register/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      const msg = Object.values(data).flat().join(' ') || 'Registration failed.'
      throw new Error(msg)
    }
    const data = await res.json()
    localStorage.setItem(ACCESS_KEY, data.access)
    localStorage.setItem(REFRESH_KEY, data.refresh)
    setAccessToken(data.access)
    setUser(data.user)
  }

  function logout() {
    clearTokens()
  }

  function updateUser(updated: AuthUser) {
    setUser(updated)
  }

  return (
    <AuthContext.Provider value={{ user, accessToken, isLoading, login, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
