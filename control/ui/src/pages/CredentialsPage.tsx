import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Wallet, X, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { credentialsApi } from '@/lib/api'
import type { Credential, CredentialCreate } from '@/lib/types'

const DEFAULT_FORM: CredentialCreate = {
  app_name: '',
  username: '',
  password: '',
  notes: '',
}

export default function CredentialsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState<CredentialCreate>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const { data: credentials = [], isLoading } = useQuery<Credential[]>({
    queryKey: ['credentials'],
    queryFn: credentialsApi.list,
    refetchInterval: 30_000,
  })

  const createMutation = useMutation({
    mutationFn: credentialsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credentials'] })
      setModalOpen(false)
      setForm(DEFAULT_FORM)
      setFormError('')
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message || t('common.createError'), 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: credentialsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.app_name.trim()) {
      setFormError(t('credentials.appNameRequired'))
      return
    }
    if (!form.username.trim()) {
      setFormError(t('credentials.usernameRequired'))
      return
    }
    if (!form.password.trim()) {
      setFormError(t('credentials.passwordRequired'))
      return
    }
    createMutation.mutate(form)
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('credentials.heading')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('credentials.description')}</p>
        </div>
        <Button onClick={() => setModalOpen(true)} size="sm">
          <Plus className="mr-1.5 size-4" />
          {t('credentials.addButton')}
        </Button>
      </div>

      {/* Live-Updates indicator */}
      <div className="flex justify-end">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t('common.liveUpdates')}
          <span className="inline-block size-2 rounded-full bg-green-500" />
        </span>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
      ) : credentials.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border py-16">
          <div className="flex size-16 items-center justify-center rounded-full bg-muted">
            <Wallet className="size-8 text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">{t('credentials.noCredentials')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('credentials.noCredentialsHint')}</p>
          </div>
          <Button onClick={() => setModalOpen(true)} size="sm">
            <Plus className="mr-1.5 size-4" />
            {t('credentials.addButton')}
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {credentials.map((cred) => (
            <div
              key={cred.id}
              className="relative flex flex-col gap-2 rounded-lg border border-border bg-background p-4 shadow-sm"
            >
              <button
                onClick={() => deleteMutation.mutate(cred.id)}
                className="absolute right-3 top-3 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                aria-label={t('credentials.deleteCredential')}
              >
                <X className="size-3.5" />
              </button>
              <div className="flex items-center gap-2">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Wallet className="size-5 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{cred.app_name}</p>
                  <p className="truncate text-xs text-muted-foreground">{cred.username}</p>
                </div>
              </div>
              {cred.notes && (
                <p className="text-xs text-muted-foreground line-clamp-2">{cred.notes}</p>
              )}
              <p className="text-[11px] text-muted-foreground/60">
                {new Date(cred.created_at).toLocaleDateString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Add Credential Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('credentials.modalTitle')}</h2>
              <button
                onClick={() => { setModalOpen(false); setForm(DEFAULT_FORM); setFormError('') }}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {/* App Name */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('credentials.fieldAppName')}</label>
                <input
                  type="text"
                  value={form.app_name}
                  onChange={(e) => setForm({ ...form, app_name: e.target.value })}
                  className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder={t('credentials.fieldAppNamePlaceholder')}
                />
              </div>

              {/* Username */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('credentials.fieldUsername')}</label>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder={t('credentials.fieldUsernamePlaceholder')}
                />
              </div>

              {/* Password */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('credentials.fieldPassword')}</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="h-9 w-full rounded-lg border border-border bg-background px-3 pr-9 text-sm outline-none focus:ring-2 focus:ring-ring"
                    placeholder={t('credentials.fieldPasswordPlaceholder')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              {/* Notes */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('credentials.fieldNotes')}</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={3}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
                  placeholder={t('credentials.fieldNotesPlaceholder')}
                />
              </div>

              {formError && (
                <p className="text-xs text-destructive">{formError}</p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => { setModalOpen(false); setForm(DEFAULT_FORM); setFormError('') }}
                >
                  {t('common.cancel')}
                </Button>
                <Button type="submit" size="sm" disabled={createMutation.isPending}>
                  {createMutation.isPending ? t('common.saving') : t('common.save')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
