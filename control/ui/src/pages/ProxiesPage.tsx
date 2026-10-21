import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Globe,
  Search,
  Plus,
  X,
  Pencil,
  RefreshCw,
  ChevronDown,
  Link2,
  SlidersHorizontal,
  Filter,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { proxiesApi } from '@/lib/api'
import type { Proxy, ProxyCreate, ProxyProtocol } from '@/lib/types'

type InputMode = 'url' | 'form'

const DEFAULT_FORM = {
  name: '',
  host: '',
  port: '' as string,
  username: '',
  password: '',
}

function parseProxyUrl(raw: string): { host: string; port: string; username: string; password: string } {
  const cleaned = raw.trim().replace(/^[a-z]+:\/\//i, '')
  const atIdx = cleaned.lastIndexOf('@')
  let credentials = ''
  let hostPart = cleaned
  if (atIdx !== -1) {
    credentials = cleaned.slice(0, atIdx)
    hostPart = cleaned.slice(atIdx + 1)
  } else {
    // Alternative format used in this project: host:port:username:password
    const chunks = cleaned.split(':')
    if (chunks.length >= 4) {
      const [host, port, ...rest] = chunks
      const username = rest[0] ?? ''
      const password = rest.slice(1).join(':')
      return { host, port, username, password }
    }
  }
  const colonCredsIdx = credentials.indexOf(':')
  const username = colonCredsIdx !== -1 ? credentials.slice(0, colonCredsIdx) : credentials
  const password = colonCredsIdx !== -1 ? credentials.slice(colonCredsIdx + 1) : ''
  const colonHostIdx = hostPart.lastIndexOf(':')
  const host = colonHostIdx !== -1 ? hostPart.slice(0, colonHostIdx) : hostPart
  const port = colonHostIdx !== -1 ? hostPart.slice(colonHostIdx + 1) : ''
  return { host, port, username, password }
}

export default function ProxiesPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [protocol, setProtocol] = useState<ProxyProtocol>('socks5')
  const [inputMode, setInputMode] = useState<InputMode>('url')
  const [editingProxy, setEditingProxy] = useState<Proxy | null>(null)
  const [proxyName, setProxyName] = useState('')
  const [urlValue, setUrlValue] = useState('')
  const [form, setForm] = useState(DEFAULT_FORM)
  const [formError, setFormError] = useState('')

  // Pagination
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const [page, setPage] = useState(1)

  const { data: proxies = [], isLoading, refetch } = useQuery<Proxy[]>({
    queryKey: ['proxies'],
    queryFn: proxiesApi.list,
    refetchInterval: 30_000,
  })

  const createMutation = useMutation({
    mutationFn: proxiesApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['proxies'] })
      closeModal()
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message || t('common.createError'), 'error')
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: ProxyCreate }) => proxiesApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['proxies'] })
      closeModal()
      showToast(t('common.saveSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message || t('common.saveError'), 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: proxiesApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proxies'] }),
  })

  function closeModal() {
    setModalOpen(false)
    setEditingProxy(null)
    setProtocol('socks5')
    setInputMode('url')
    setProxyName('')
    setUrlValue('')
    setForm(DEFAULT_FORM)
    setFormError('')
  }

  function openCreateModal() {
    setEditingProxy(null)
    setProtocol('socks5')
    setInputMode('url')
    setProxyName('')
    setUrlValue('')
    setForm(DEFAULT_FORM)
    setFormError('')
    setModalOpen(true)
  }

  function openEditModal(proxy: Proxy) {
    setEditingProxy(proxy)
    setModalOpen(true)
    setInputMode('url')
    setProtocol(proxy.protocol)
    setProxyName(proxy.name)
    const port = proxy.port ? String(proxy.port) : ''
    const password = proxy.password || ''
    setForm({
      name: proxy.name,
      host: proxy.host,
      port,
      username: proxy.username || '',
      password,
    })
    if ((proxy.username || '') || password) {
      setUrlValue(`${proxy.host}:${port}:${proxy.username || ''}:${password}`)
    } else if (port) {
      setUrlValue(`${proxy.host}:${port}`)
    } else {
      setUrlValue(proxy.host)
    }
    setFormError('')
  }

  function handleSave() {
    if (!proxyName.trim()) {
      setFormError(t('proxies.nameRequired'))
      return
    }

    let payload: ProxyCreate
    if (inputMode === 'url') {
      const { host, port, username, password } = parseProxyUrl(urlValue)
      if (!host) {
        setFormError(t('proxies.hostRequired'))
        return
      }
      payload = {
        name: proxyName.trim(),
        protocol,
        host,
        port: port && !isNaN(Number(port)) ? Number(port) : null,
        username,
        password,
      }
    } else {
      if (!form.host.trim()) {
        setFormError(t('proxies.hostRequired'))
        return
      }
      payload = {
        name: proxyName.trim(),
        protocol,
        host: form.host.trim(),
        port: form.port && !isNaN(Number(form.port)) ? Number(form.port) : null,
        username: form.username,
        password: form.password,
      }
    }

    if (editingProxy) {
      updateMutation.mutate({ id: editingProxy.id, data: payload })
      return
    }
    createMutation.mutate(payload)
  }

  const filtered = proxies.filter((p) =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()),
  )

  const totalPages = Math.max(1, Math.ceil(filtered.length / rowsPerPage))
  const paginated = filtered.slice((page - 1) * rowsPerPage, page * rowsPerPage)

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder={t('proxies.searchPlaceholder')}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            className="h-8 w-48 sm:w-60 rounded-lg border border-border bg-background pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
          />
          <button className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-label={t('proxies.filterLabel')}>
            <Filter className="size-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Columns */}
          <button
            disabled
            aria-label={t('proxies.columnsLabel')}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <SlidersHorizontal className="size-3.5" />
            {t('proxies.columns')}
            <ChevronDown className="size-3" />
          </button>

          {/* Refresh */}
          <button
            onClick={() => refetch()}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
            aria-label={t('common.refresh')}
          >
            <RefreshCw className="size-3.5" />
          </button>

          {/* New Proxy */}
          <Button onClick={openCreateModal} size="sm">
            <Plus className="mr-1 size-4" />
            {t('proxies.newProxy')}
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-16">
            <div className="flex size-16 items-center justify-center rounded-full bg-muted">
              <Globe className="size-8 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">{t('proxies.noProxies')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('proxies.noProxiesHint')}</p>
            </div>
            <Button onClick={openCreateModal} size="sm">
              <Plus className="mr-1.5 size-4" />
              {t('proxies.newProxy')}
            </Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('proxies.colProtocol')}</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('proxies.colName')}</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('proxies.colHost')}</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('proxies.colPort')}</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('proxies.colCreated')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {paginated.map((proxy) => (
                <tr key={proxy.id} className="border-t border-border hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      <Link2 className="size-3" />
                      {proxy.protocol.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium">{proxy.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{proxy.host}</td>
                  <td className="px-4 py-3 text-muted-foreground">{proxy.port ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{new Date(proxy.created_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openEditModal(proxy)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label={t('common.edit')}
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      onClick={() => deleteMutation.mutate(proxy.id)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                      aria-label={t('proxies.deleteProxy')}
                    >
                      <X className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>{t('common.rowsPerPage')}</span>
            <div className="relative">
              <select
                value={rowsPerPage}
                onChange={(e) => { setRowsPerPage(Number(e.target.value)); setPage(1) }}
                className="h-7 appearance-none rounded border border-border bg-background pl-2 pr-6 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                {[10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2" />
            </div>
          </div>
          <div className="flex items-center gap-1">
            <span>{t('common.page')} {page} {t('common.of')} {totalPages}</span>
            <button
              onClick={() => setPage(1)}
              disabled={page === 1}
              className="flex h-6 w-6 items-center justify-center rounded border border-border disabled:opacity-40 hover:bg-muted"
            >«</button>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="flex h-6 w-6 items-center justify-center rounded border border-border disabled:opacity-40 hover:bg-muted"
            >‹</button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="flex h-6 w-6 items-center justify-center rounded border border-border disabled:opacity-40 hover:bg-muted"
            >›</button>
            <button
              onClick={() => setPage(totalPages)}
              disabled={page === totalPages}
              className="flex h-6 w-6 items-center justify-center rounded border border-border disabled:opacity-40 hover:bg-muted"
            >»</button>
          </div>
        </div>
      )}

      {/* Create Proxy Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-[480px] rounded-xl border border-border bg-background shadow-xl">
            {/* Header */}
            <div className="flex items-start justify-between px-6 pt-6 pb-1">
              <div>
                <h2 className="text-base font-semibold">
                  {editingProxy ? t('proxies.editModalTitle') : t('proxies.modalTitle')}
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {editingProxy ? t('proxies.editModalSubtitle') : t('proxies.modalSubtitle')}
                </p>
              </div>
              <button
                onClick={closeModal}
                className="mt-0.5 rounded p-1 text-muted-foreground transition-colors hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="px-6 py-4 flex flex-col gap-5">
              {/* Protocol */}
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">{t('proxies.protocol')}</label>
                <div className="grid grid-cols-2 gap-2 rounded-lg border border-border p-1">
                  <button
                    type="button"
                    onClick={() => setProtocol('socks5')}
                    className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      protocol === 'socks5'
                        ? 'bg-background shadow-sm text-foreground border border-border'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Link2 className="size-4" />
                    SOCKS5
                  </button>
                  <button
                    type="button"
                    onClick={() => setProtocol('http')}
                    className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      protocol === 'http'
                        ? 'bg-background shadow-sm text-foreground border border-border'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Link2 className="size-4" />
                    HTTP
                  </button>
                </div>
              </div>

              {/* Proxy Name */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('proxies.proxyName')}</label>
                <input
                  type="text"
                  value={proxyName}
                  onChange={(e) => setProxyName(e.target.value)}
                  placeholder={t('proxies.proxyNamePlaceholder')}
                  className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                />
              </div>

              {/* URL / Form tab toggle */}
              <div className="grid grid-cols-2 rounded-lg border border-border p-1">
                <button
                  type="button"
                  onClick={() => setInputMode('url')}
                  className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    inputMode === 'url'
                      ? 'bg-background shadow-sm text-foreground border border-border'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Link2 className="size-4" />
                  {t('proxies.tabUrl')}
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('form')}
                  className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    inputMode === 'form'
                      ? 'bg-background shadow-sm text-foreground border border-border'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <SlidersHorizontal className="size-4" />
                  {t('proxies.tabForm')}
                </button>
              </div>

              {/* URL mode */}
              {inputMode === 'url' && (
                <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4">
                  <label className="mb-2 block text-xs font-medium text-muted-foreground">{t('proxies.proxyUrl')}</label>
                  <div className="flex overflow-hidden rounded-lg border border-border">
                    <span className="flex items-center bg-muted px-3 text-sm text-muted-foreground font-mono border-r border-border shrink-0">
                      {protocol}://
                    </span>
                    <input
                      type="text"
                      value={urlValue}
                      onChange={(e) => setUrlValue(e.target.value)}
                      placeholder={t('proxies.urlPlaceholder')}
                      className="flex-1 bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground font-mono min-w-0"
                    />
                  </div>
                </div>
              )}

              {/* Form mode */}
              {inputMode === 'form' && (
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-sm font-medium">{t('proxies.fieldHost')}</label>
                      <input
                        type="text"
                        value={form.host}
                        onChange={(e) => setForm({ ...form, host: e.target.value })}
                        placeholder={t('proxies.fieldHostPlaceholder')}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-sm font-medium">{t('proxies.fieldPort')}</label>
                      <input
                        type="number"
                        value={form.port}
                        onChange={(e) => setForm({ ...form, port: e.target.value })}
                        placeholder={t('proxies.fieldPortPlaceholder')}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-sm font-medium">{t('proxies.fieldUsername')}</label>
                      <input
                        type="text"
                        value={form.username}
                        onChange={(e) => setForm({ ...form, username: e.target.value })}
                        placeholder={t('proxies.fieldUsernamePlaceholder')}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-sm font-medium">{t('proxies.fieldPassword')}</label>
                      <input
                        type="password"
                        value={form.password}
                        onChange={(e) => setForm({ ...form, password: e.target.value })}
                        placeholder={t('proxies.fieldPasswordPlaceholder')}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                      />
                    </div>
                  </div>
                </div>
              )}

              {formError && (
                <p className="text-xs text-destructive">{formError}</p>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end px-6 pb-6">
              <Button
                onClick={handleSave}
                disabled={createMutation.isPending || updateMutation.isPending}
              >
                {(createMutation.isPending || updateMutation.isPending)
                  ? t('common.saving')
                  : editingProxy
                    ? t('common.save')
                    : t('common.create')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
