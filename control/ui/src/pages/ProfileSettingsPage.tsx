import { useState, useEffect, type FormEvent } from 'react'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { authApi } from '@/lib/api'
import { useTranslation } from 'react-i18next'

export default function ProfileSettingsPage() {
  const { user, updateUser } = useAuth()
  const { t } = useTranslation()
  const { showToast } = useToast()
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    display_name: '',
    avatar_url: '',
  })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (user) {
      setForm({
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      })
    }
  }, [user])

  function update(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const updated = await authApi.updateMe(form)
      updateUser(updated)
      showToast(t('common.saveSuccess'), 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('common.saveError'), 'error')
    } finally {
      setLoading(false)
    }
  }

  const initials = user
    ? ((user.display_name || user.first_name || user.username) || '?').charAt(0).toUpperCase()
    : '?'

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-6 text-xl font-semibold">{t('auth.profileSettings')}</h1>

      <div className="rounded-xl border border-border bg-card p-6">
        {/* Avatar preview */}
        <div className="mb-6 flex items-center gap-4">
          <div className="flex size-16 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground">
            {form.avatar_url ? (
              <img
                src={form.avatar_url}
                alt="avatar"
                className="size-16 rounded-full object-cover"
              />
            ) : (
              initials
            )}
          </div>
          <div>
            <p className="font-medium">{user?.username}</p>
            <p className="text-sm text-muted-foreground">{user?.email}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('auth.firstName')}</label>
              <input
                type="text"
                value={form.first_name}
                onChange={update('first_name')}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('auth.lastName')}</label>
              <input
                type="text"
                value={form.last_name}
                onChange={update('last_name')}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t('auth.displayName')}</label>
            <input
              type="text"
              value={form.display_name}
              onChange={update('display_name')}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder={t('auth.displayNamePlaceholder')}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t('auth.email')}</label>
            <input
              type="email"
              value={form.email}
              onChange={update('email')}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t('auth.avatarUrl')}</label>
            <input
              type="url"
              value={form.avatar_url}
              onChange={update('avatar_url')}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="https://example.com/avatar.png"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {loading ? t('common.saving') : t('common.save')}
          </button>
        </form>
      </div>
    </div>
  )
}
