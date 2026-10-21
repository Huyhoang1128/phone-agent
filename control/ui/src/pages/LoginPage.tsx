import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { useTranslation } from 'react-i18next'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [usernameOrEmail, setUsernameOrEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(usernameOrEmail, password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.loginFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-2">
          <span className="flex size-10 items-center justify-center rounded-xl bg-foreground text-background text-lg font-bold">
            M
          </span>
          <h1 className="text-xl font-semibold tracking-tight">PhoneAgent</h1>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <h2 className="mb-1 text-lg font-semibold">{t('auth.signIn')}</h2>
          <p className="mb-5 text-sm text-muted-foreground">{t('auth.signInDesc')}</p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('auth.usernameOrEmail')}</label>
              <input
                type="text"
                autoComplete="username"
                value={usernameOrEmail}
                onChange={(e) => setUsernameOrEmail(e.target.value)}
                required
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
                placeholder="username or email@example.com"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('auth.password')}</label>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {loading ? t('common.loading') : t('auth.signIn')}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t('auth.noAccount')}{' '}
          <Link to="/register" className="font-medium text-foreground hover:underline">
            {t('auth.register')}
          </Link>
        </p>
      </div>
    </div>
  )
}
