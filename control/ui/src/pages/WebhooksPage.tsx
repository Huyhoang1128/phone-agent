import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Zap, Plus, Trash2, Pencil, RefreshCw, ExternalLink, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { webhooksApi } from '@/lib/api'
import type { Webhook, WebhookCreate } from '@/lib/types'

const AVAILABLE_EVENTS = [
  'task.started',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'device.online',
  'device.offline',
  'schedule.triggered',
  'schedule.failed',
]

const DEFAULT_FORM: WebhookCreate = {
  name: '',
  url: '',
  secret: '',
  events: [],
  is_active: true,
}

export default function WebhooksPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Webhook | null>(null)
  const [form, setForm] = useState<WebhookCreate>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')

  const { data: webhooks = [], isLoading, refetch } = useQuery<Webhook[]>({
    queryKey: ['webhooks'],
    queryFn: webhooksApi.list,
  })

  const createMutation = useMutation({
    mutationFn: webhooksApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks'] })
      closeModal()
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message || t('common.createError'), 'error')
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<WebhookCreate> }) =>
      webhooksApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks'] })
      closeModal()
      showToast(t('common.saveSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message || t('common.saveError'), 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: webhooksApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks'] })
      showToast(t('webhooks.deleteSuccess'), 'success')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  function openCreate() {
    setEditing(null)
    setForm(DEFAULT_FORM)
    setFormError('')
    setModalOpen(true)
  }

  function openEdit(wh: Webhook) {
    setEditing(wh)
    setForm({ name: wh.name, url: wh.url, secret: '', events: wh.events, is_active: wh.is_active })
    setFormError('')
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setEditing(null)
    setForm(DEFAULT_FORM)
    setFormError('')
  }

  function toggleEvent(event: string) {
    setForm((prev) => ({
      ...prev,
      events: prev.events?.includes(event)
        ? prev.events.filter((e) => e !== event)
        : [...(prev.events ?? []), event],
    }))
  }

  function handleSubmit() {
    if (!form.name.trim()) {
      setFormError(t('webhooks.nameRequired'))
      return
    }
    if (!form.url.trim()) {
      setFormError(t('webhooks.urlRequired'))
      return
    }
    if (editing) {
      updateMutation.mutate({ id: editing.id, data: form })
    } else {
      createMutation.mutate(form)
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'Asia/Ho_Chi_Minh',
    })
  }

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('webhooks.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('webhooks.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
            aria-label={t('common.refresh')}
          >
            <RefreshCw className="size-3.5" />
          </button>
          <Button onClick={openCreate} size="sm">
            <Plus className="mr-1 size-4" />
            {t('webhooks.newWebhook')}
          </Button>
        </div>
      </div>

      {/* Webhooks list */}
      <div className="rounded-xl border border-border bg-card">
        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : webhooks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <Zap className="size-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t('webhooks.noWebhooks')}</p>
            <Button onClick={openCreate} size="sm" variant="outline">
              <Plus className="mr-1 size-4" />
              {t('webhooks.newWebhook')}
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {webhooks.map((wh) => (
              <div key={wh.id} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{wh.name}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${wh.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}>
                      {wh.is_active ? t('webhooks.active') : t('webhooks.inactive')}
                    </span>
                  </div>
                  <a
                    href={wh.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="size-3 shrink-0" />
                    <span className="truncate">{wh.url}</span>
                  </a>
                  {wh.events.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {wh.events.map((ev) => (
                        <span key={ev} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {ev}
                        </span>
                      ))}
                    </div>
                  )}
                  <span className="text-xs text-muted-foreground">{t('webhooks.created')} {formatDate(wh.created_at)}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => openEdit(wh)}
                    className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={t('common.edit')}
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(t('webhooks.deleteConfirm'))) {
                        deleteMutation.mutate(wh.id)
                      }
                    }}
                    className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    aria-label={t('webhooks.deleteWebhook')}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold">
                  {editing ? t('webhooks.editTitle') : t('webhooks.createTitle')}
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">{t('webhooks.createDesc')}</p>
              </div>
              <button onClick={closeModal} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-4 p-5">
              {/* Name */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('webhooks.fieldName')}</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder={t('webhooks.namePlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {/* URL */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('webhooks.fieldUrl')}</label>
                <input
                  type="url"
                  value={form.url}
                  onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))}
                  placeholder="https://your-server.com/webhook"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {/* Secret */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">
                  {t('webhooks.fieldSecret')}
                  <span className="ml-1 text-muted-foreground font-normal">({t('webhooks.optional')})</span>
                </label>
                <input
                  type="password"
                  value={form.secret ?? ''}
                  onChange={(e) => setForm((p) => ({ ...p, secret: e.target.value }))}
                  placeholder="••••••••"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">{t('webhooks.secretHint')}</p>
              </div>

              {/* Events */}
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">{t('webhooks.fieldEvents')}</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {AVAILABLE_EVENTS.map((ev) => (
                    <label key={ev} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted">
                      <input
                        type="checkbox"
                        checked={form.events?.includes(ev) ?? false}
                        onChange={() => toggleEvent(ev)}
                        className="accent-primary"
                      />
                      <span className="font-mono">{ev}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Active toggle */}
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.is_active ?? true}
                  onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
                  className="accent-primary"
                />
                {t('webhooks.active')}
              </label>

              {formError && <p className="text-xs text-destructive">{formError}</p>}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={closeModal}>{t('common.cancel')}</Button>
                <Button onClick={handleSubmit} disabled={isPending}>
                  {isPending
                    ? (editing ? t('common.saving') : t('common.creating'))
                    : (editing ? t('common.save') : t('common.create'))}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
