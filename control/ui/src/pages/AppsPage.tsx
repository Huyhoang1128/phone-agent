import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Package,
  Search,
  Upload,
  ChevronDown,
  ChevronUp,
  X,
  Filter,
  ArrowUpDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { mobileAppsApi } from '@/lib/api'
import type { MobileApp, AppPlatform } from '@/lib/types'

const DEFAULT_FORM = {
  name: '',
  package_name: '',
  platform: 'android' as AppPlatform,
  version: '',
  description: '',
  apk_file: null as File | null,
}

export default function AppsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadOpen, setUploadOpen] = useState(true)
  const [search, setSearch] = useState('')
  const [form, setForm] = useState({ ...DEFAULT_FORM })
  const [formError, setFormError] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const { data: apps = [], isLoading } = useQuery<MobileApp[]>({
    queryKey: ['apps'],
    queryFn: mobileAppsApi.list,
    refetchInterval: 30_000,
  })

  const createMutation = useMutation({
    mutationFn: mobileAppsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apps'] })
      setForm({ ...DEFAULT_FORM })
      setFormError('')
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message || t('common.createError'), 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: mobileAppsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['apps'] }),
  })

  const filtered = apps.filter(
    (a) =>
      !search ||
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.package_name.toLowerCase().includes(search.toLowerCase()),
  )

  function handleFileSelect(file: File) {
    setForm((f) => ({
      ...f,
      apk_file: file,
      name: f.name.trim() ? f.name : file.name.replace(/\.(apk|xapk|apkm|zip)$/i, ''),
    }))
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelect(file)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) {
      setFormError(t('apps.nameRequired'))
      return
    }
    createMutation.mutate(form)
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── Upload Section ── */}
      <div className="rounded-lg border border-border bg-background">
        {/* Collapsible header */}
        <button
          onClick={() => setUploadOpen((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div>
            <span className="text-sm font-semibold">{t('apps.uploadTitle')}</span>
            {!uploadOpen && (
              <p className="mt-0.5 text-xs text-muted-foreground">{t('apps.uploadDescription')}</p>
            )}
          </div>
          {uploadOpen ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </button>

        {uploadOpen && (
          <div className="border-t border-border px-4 pb-4 pt-3">
            <p className="mb-4 text-sm text-muted-foreground">{t('apps.uploadDescription')}</p>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {/* Drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={
                  `flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed py-8 transition-colors ` +
                  (dragOver
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-muted/30 hover:border-primary/50 hover:bg-muted/50')
                }
              >
                <Upload className="size-8 text-muted-foreground" />
                {form.apk_file ? (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-foreground">{form.apk_file.name}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setForm((f) => ({ ...f, apk_file: null })) }}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm font-medium text-foreground">{t('apps.dropZoneTitle')}</p>
                    <p className="text-xs text-muted-foreground">{t('apps.dropZoneHint')}</p>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".apk,.xapk,.apkm,.zip"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleFileSelect(file)
                  }}
                />
              </div>

              {/* App fields */}
              <div className="grid gap-4 sm:grid-cols-2">
                {/* App Name */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('apps.fieldName')}</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    placeholder={t('apps.fieldNamePlaceholder')}
                  />
                </div>

                {/* Package Name */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">
                    {t('apps.fieldPackageName')}{' '}
                    <span className="text-xs font-normal text-muted-foreground">({t('apps.optional')})</span>
                  </label>
                  <input
                    type="text"
                    value={form.package_name}
                    onChange={(e) => setForm({ ...form, package_name: e.target.value })}
                    className="h-9 rounded-lg border border-border bg-background px-3 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
                    placeholder={t('apps.fieldPackageNamePlaceholder')}
                  />
                </div>

                {/* Platform */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('apps.fieldPlatform')}</label>
                  <div className="relative">
                    <select
                      value={form.platform}
                      onChange={(e) => setForm({ ...form, platform: e.target.value as AppPlatform })}
                      className="h-9 w-full appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="android">{t('apps.platformAndroid')}</option>
                      <option value="ios">{t('apps.platformIos')}</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </div>

                {/* Version */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">
                    {t('apps.fieldVersion')}{' '}
                    <span className="text-xs font-normal text-muted-foreground">({t('apps.optional')})</span>
                  </label>
                  <input
                    type="text"
                    value={form.version}
                    onChange={(e) => setForm({ ...form, version: e.target.value })}
                    className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    placeholder={t('apps.fieldVersionPlaceholder')}
                  />
                </div>
              </div>

              {/* Description */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">
                  {t('apps.fieldDescription')}{' '}
                  <span className="text-xs font-normal text-muted-foreground">({t('apps.optional')})</span>
                </label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
                  placeholder={t('apps.fieldDescriptionPlaceholder')}
                />
              </div>

              {formError && (
                <p className="text-xs text-destructive">{formError}</p>
              )}

              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={createMutation.isPending}>
                  {createMutation.isPending ? t('common.saving') : t('apps.submitButton')}
                </Button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* ── Apps Listing ── */}
      <div className="flex flex-col gap-3">
        {/* Section header */}
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('apps.listTitle')}</h2>
          <div className="flex items-center gap-2">
            <button className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted">
              <Filter className="size-3.5" />
            </button>
            <button className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted">
              <ArrowUpDown className="size-3.5" />
            </button>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder={t('apps.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-52 rounded-lg border border-border bg-background pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>
          </div>
        </div>

        {/* List */}
        <div className="overflow-hidden rounded-lg border border-border">
          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 py-16">
              <div className="flex size-16 items-center justify-center rounded-full bg-muted">
                <Package className="size-8 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">{t('apps.noApps')}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('apps.colName')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('apps.colPackage')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('apps.colPlatform')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('apps.colVersion')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((app) => (
                  <tr key={app.id} className="border-t border-border hover:bg-muted/40">
                    <td className="px-4 py-3 font-medium">{app.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{app.package_name || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={
                        app.platform === 'android'
                          ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : 'rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                      }>
                        {app.platform}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{app.version || '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => deleteMutation.mutate(app.id)}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                        aria-label={t('apps.deleteApp')}
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
      </div>
    </div>
  )
}
