import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { useTranslation } from 'react-i18next'

export default function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [form, setForm] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    display_name: '',
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function update(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (form.password !== form.confirmPassword) {
      setError(t('auth.passwordMismatch'))
      return
    }
    setLoading(true)
    try {
      await register({
        username: form.username,
        email: form.email,
        password: form.password,
        display_name: form.display_name,
      })
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.registerFailed'))
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
          <h1 className="text-xl font-semibold tracking-tight">mobilerun</h1>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <h2 className="mb-1 text-lg font-semibold">{t('auth.createAccount')}</h2>
          <p className="mb-5 text-sm text-muted-foreground">{t('auth.createAccountDesc')}</p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('auth.displayName')}</label>
              <input
                type="text"
                value={form.display_name}
                onChange={update('display_name')}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
                placeholder={t('auth.displayNamePlaceholder')}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('auth.username')} *</label>
              <input
                type="text"
                autoComplete="username"
                value={form.username}
                onChange={update('username')}
                required
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
                placeholder="johndoe"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('auth.email')} *</label>
              <input
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={update('email')}
                required
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
                placeholder="john@example.com"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('auth.password')} *</label>
              <input
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={update('password')}
                required
                minLength={6}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
                placeholder="••••••••"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('auth.confirmPassword')} *</label>
              <input
                type="password"
                autoComplete="new-password"
                value={form.confirmPassword}
                onChange={update('confirmPassword')}
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
              {loading ? t('common.creating') : t('auth.createAccount')}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t('auth.hasAccount')}{' '}
          <Link to="/login" className="font-medium text-foreground hover:underline">
            {t('auth.signIn')}
          </Link>
        </p>
      </div>
    </div>
  )
}
