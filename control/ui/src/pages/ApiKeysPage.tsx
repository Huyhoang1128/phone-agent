import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Key, Plus, Trash2, Copy, Check, RefreshCw, Eye, EyeOff, BookOpen, Rocket } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { apiKeysApi, fbHackKeysApi } from '@/lib/api'
import type { ApiKey, FbHackKey } from '@/lib/types'

export default function ApiKeysPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const navigate = useNavigate()

  const [modalOpen, setModalOpen] = useState(false)
  const [name, setName] = useState('')
  const [formError, setFormError] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revealedIds, setRevealedIds] = useState<Set<number>>(new Set())

  const { data: apiKeys = [], isLoading, refetch } = useQuery<ApiKey[]>({
    queryKey: ['api-keys'],
    queryFn: apiKeysApi.list,
  })

  const createMutation = useMutation({
    mutationFn: apiKeysApi.create,
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['api-keys'] })
      setNewKey(created.full_key)
      setName('')
      setFormError('')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message || t('common.createError'), 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: apiKeysApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api-keys'] })
      showToast(t('apiKeys.deleteSuccess'), 'success')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  // ── Key bên thứ 3 (hacklike17 token) ────────────────────────────────────
  const [hackModalOpen, setHackModalOpen] = useState(false)
  const [hackName, setHackName] = useState('')
  const [hackToken, setHackToken] = useState('')
  const [hackError, setHackError] = useState('')

  const { data: hackKeys = [] } = useQuery<FbHackKey[]>({
    queryKey: ['fb-hack-keys'],
    queryFn: fbHackKeysApi.list,
  })
  const createHackMutation = useMutation({
    mutationFn: fbHackKeysApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fb-hack-keys'] })
      setHackModalOpen(false)
      setHackName(''); setHackToken(''); setHackError('')
      showToast('Đã tạo Key bên thứ 3.', 'success')
    },
    onError: (err: Error) => { setHackError(err.message); showToast(err.message, 'error') },
  })
  const deleteHackMutation = useMutation({
    mutationFn: fbHackKeysApi.delete,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['fb-hack-keys'] }); showToast('Đã xoá key.', 'success') },
    onError: (err: Error) => showToast(err.message, 'error'),
  })
  function handleCreateHack() {
    if (!hackName.trim()) { setHackError('Nhập tên key.'); return }
    if (!hackToken.trim()) { setHackError('Dán token hacklike vào.'); return }
    createHackMutation.mutate({ name: hackName.trim(), token: hackToken.trim() })
  }

  function openModal() {
    setModalOpen(true)
    setName('')
    setFormError('')
    setNewKey(null)
    setCopied(false)
  }

  function closeModal() {
    setModalOpen(false)
    setNewKey(null)
    setCopied(false)
  }

  function handleCreate() {
    if (!name.trim()) {
      setFormError(t('apiKeys.nameRequired'))
      return
    }
    createMutation.mutate({ name: name.trim() })
  }

  async function copyKey(key: string) {
    await navigator.clipboard.writeText(key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function toggleReveal(id: number) {
    setRevealedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
          <h1 className="text-xl font-semibold">{t('apiKeys.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('apiKeys.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/api-docs')}
          >
            <BookOpen className="mr-1 size-4" />
            {t('apiKeys.viewDocs')}
          </Button>
          <button
            onClick={() => refetch()}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
            aria-label={t('common.refresh')}
          >
            <RefreshCw className="size-3.5" />
          </button>
          <Button variant="outline" size="sm" onClick={() => { setHackModalOpen(true); setHackName(''); setHackToken(''); setHackError('') }}>
            <Rocket className="mr-1 size-4" />
            Tạo key bên thứ 3
          </Button>
          <Button onClick={openModal} size="sm">
            <Plus className="mr-1 size-4" />
            {t('apiKeys.newKey')}
          </Button>
        </div>
      </div>

      {/* Keys list */}
      <div className="rounded-xl border border-border bg-card">
        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : apiKeys.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <Key className="size-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t('apiKeys.noKeys')}</p>
            <Button onClick={openModal} size="sm" variant="outline">
              <Plus className="mr-1 size-4" />
              {t('apiKeys.newKey')}
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {apiKeys.map((k) => (
              <div key={k.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{k.name}</span>
                  <div className="flex items-center gap-1.5">
                    <code className="text-xs text-muted-foreground font-mono">
                      {revealedIds.has(k.id) ? k.key_prefix : `${k.key_prefix.slice(0, 5)}••••••••`}
                    </code>
                    <button
                      onClick={() => toggleReveal(k.id)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={revealedIds.has(k.id) ? t('apiKeys.hide') : t('apiKeys.reveal')}
                    >
                      {revealedIds.has(k.id)
                        ? <EyeOff className="size-3.5" />
                        : <Eye className="size-3.5" />}
                    </button>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t('apiKeys.created')} {formatDate(k.created_at)}
                    {k.last_used_at && ` · ${t('apiKeys.lastUsed')} ${formatDate(k.last_used_at)}`}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${k.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}>
                    {k.is_active ? t('apiKeys.active') : t('apiKeys.inactive')}
                  </span>
                  <button
                    onClick={() => {
                      if (confirm(t('apiKeys.deleteConfirm'))) {
                        deleteMutation.mutate(k.id)
                      }
                    }}
                    className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    aria-label={t('apiKeys.deleteKey')}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Key bên thứ 3 list */}
      <div className="flex flex-col gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Rocket className="size-4 text-primary" /> Key bên thứ 3
          <span className="font-normal text-muted-foreground">— token dịch vụ bên thứ 3 dùng cho nút 🚀 ở Lịch đăng bài</span>
        </h2>
        <div className="rounded-xl border border-border bg-card">
          {hackKeys.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Chưa có key. Bấm "Tạo key bên thứ 3" để dán token.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {hackKeys.map((k) => (
                <div key={k.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{k.name}</span>
                    <code className="font-mono text-xs text-muted-foreground">{k.key_masked}</code>
                    <span className="text-xs text-muted-foreground">
                      {t('apiKeys.created')} {formatDate(k.created_at)}
                      {k.last_used_at && ` · ${t('apiKeys.lastUsed')} ${formatDate(k.last_used_at)}`}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${k.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}>
                      {k.is_active ? t('apiKeys.active') : t('apiKeys.inactive')}
                    </span>
                    <button
                      onClick={() => { if (confirm('Xoá key hack này?')) deleteHackMutation.mutate(k.id) }}
                      className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                      aria-label="Xoá key"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create hack key modal */}
      {hackModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl">
            <div className="border-b border-border px-5 py-4">
              <h2 className="flex items-center gap-2 text-base font-semibold"><Rocket className="size-4 text-primary" /> Tạo key bên thứ 3</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">Dán token từ hacklike17. Token chỉ lưu ở server, hiển thị che bớt.</p>
            </div>
            <div className="flex flex-col gap-4 p-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Tên</label>
                <input
                  type="text" value={hackName} onChange={(e) => setHackName(e.target.value)}
                  placeholder="vd: hacklike chính"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Token</label>
                <input
                  type="password" value={hackToken} onChange={(e) => setHackToken(e.target.value)}
                  placeholder="dán token hacklike17 vào đây"
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateHack()}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                {hackError && <p className="text-xs text-destructive">{hackError}</p>}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setHackModalOpen(false)}>{t('common.cancel')}</Button>
                <Button onClick={handleCreateHack} disabled={createHackMutation.isPending}>
                  {createHackMutation.isPending ? t('common.creating') : t('common.create')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{t('apiKeys.createTitle')}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{t('apiKeys.createDesc')}</p>
            </div>

            {newKey ? (
              <div className="flex flex-col gap-4 p-5">
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
                  {t('apiKeys.copyWarning')}
                </div>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2">
                  <code className="flex-1 break-all font-mono text-xs">{newKey}</code>
                  <button
                    onClick={() => copyKey(newKey)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={t('apiKeys.copyKey')}
                  >
                    {copied ? <Check className="size-4 text-green-500" /> : <Copy className="size-4" />}
                  </button>
                </div>
                <Button onClick={closeModal} className="w-full">{t('apiKeys.done')}</Button>
              </div>
            ) : (
              <div className="flex flex-col gap-4 p-5">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('apiKeys.fieldName')}</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('apiKeys.namePlaceholder')}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  {formError && <p className="text-xs text-destructive">{formError}</p>}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={closeModal}>{t('common.cancel')}</Button>
                  <Button onClick={handleCreate} disabled={createMutation.isPending}>
                    {createMutation.isPending ? t('common.creating') : t('common.create')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
