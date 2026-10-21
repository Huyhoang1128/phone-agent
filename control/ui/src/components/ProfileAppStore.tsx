import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Trash2,
  Download,
  Smartphone,
  X,
} from 'lucide-react'
import { profilesApi, mobileAppsApi } from '@/lib/api'
import { useToast } from '@/context/ToastContext'
import type { MobileApp, ProfileAppInstallation } from '@/lib/types'

/**
 * CHPlay — a self-contained mini app store for one profile.
 *
 * Everything (the app list, an app's detail page and the install queue) lives
 * inside a single card. The install/uninstall state is per-profile because the
 * `installations` endpoint is scoped to `profileId`.
 *
 * Backend already enforces the rules (EDIT permission, anti-IDOR, the sequential
 * queue is the deferred worker-dispatch step) — this component only drives the
 * `install-app` / `uninstall-app` endpoints and renders their state.
 */

// An app is considered "on the device or heading there" only in these states.
// uninstall_pending / uninstalling / uninstalled / failed all mean the app is
// effectively gone and can be installed again.
type Simple = 'installed' | 'installing' | 'pending' | 'none'

function simpleStatus(inst?: ProfileAppInstallation): Simple {
  if (!inst) return 'none'
  if (inst.status === 'installed') return 'installed'
  if (inst.status === 'installing') return 'installing'
  if (inst.status === 'pending') return 'pending'
  return 'none'
}

export default function ProfileAppStore({
  profileId,
  hasDevice,
}: {
  profileId: number
  hasDevice: boolean
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [tab, setTab] = useState<'store' | 'queue'>('store')
  const [detailAppId, setDetailAppId] = useState<number | null>(null)
  const [search, setSearch] = useState('')

  const { data: allApps = [] } = useQuery<MobileApp[]>({
    queryKey: ['apps'],
    queryFn: mobileAppsApi.list,
  })
  const { data: installations = [] } = useQuery<ProfileAppInstallation[]>({
    queryKey: ['installations', profileId],
    queryFn: () => profilesApi.listInstallations(profileId),
  })

  // One installation row per app (unique together: profile + app).
  const instByApp = new Map<number, ProfileAppInstallation>()
  installations.forEach((i) => instByApp.set(i.app, i))

  const onMutated = (data: ProfileAppInstallation[]) => {
    qc.setQueryData(['installations', profileId], data)
    qc.invalidateQueries({ queryKey: ['profiles'] })
  }
  const installMut = useMutation({
    mutationFn: (appId: number) => profilesApi.installApp(profileId, appId),
    onSuccess: onMutated,
    onError: (e: Error) => showToast(e.message || t('common.saveError'), 'error'),
  })
  const uninstallMut = useMutation({
    mutationFn: (appId: number) => profilesApi.uninstallApp(profileId, appId),
    onSuccess: onMutated,
    onError: (e: Error) => showToast(e.message || t('common.saveError'), 'error'),
  })
  const busy = installMut.isPending || uninstallMut.isPending

  // Queue: installing first, then pending in request order (oldest first).
  const queue = installations
    .filter((i) => i.status === 'pending' || i.status === 'installing')
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'installing' ? -1 : 1
      return a.created_at.localeCompare(b.created_at)
    })

  const storeApps = allApps.filter((a) =>
    a.name.toLowerCase().includes(search.trim().toLowerCase()),
  )
  const detailApp =
    detailAppId != null ? allApps.find((a) => a.id === detailAppId) ?? null : null

  // ── Status badge ────────────────────────────────────────────────────────
  function StatusBadge({ status }: { status: Simple }) {
    if (status === 'none') return null
    const map: Record<Exclude<Simple, 'none'>, { label: string; cls: string }> = {
      installed: {
        label: t('profiles.statusInstalled'),
        cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
      },
      installing: {
        label: t('profiles.statusInstalling'),
        cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
      },
      pending: {
        label: t('profiles.statusPending'),
        cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      },
    }
    const { label, cls } = map[status]
    return (
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>
    )
  }

  function AppIcon() {
    return (
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Smartphone className="size-5 text-muted-foreground" />
      </div>
    )
  }

  // ── A clickable app row (used by the store list and the queue) ──────────
  function AppRow({
    app,
    status,
    divider,
  }: {
    app: MobileApp
    status: Simple
    divider: boolean
  }) {
    return (
      <button
        type="button"
        onClick={() => setDetailAppId(app.id)}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted ${
          divider ? 'border-b border-border' : ''
        }`}
      >
        <AppIcon />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{app.name}</p>
          {app.package_name && (
            <p className="truncate font-mono text-xs text-muted-foreground">
              {app.package_name}
            </p>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <StatusBadge status={status} />
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              app.platform === 'android'
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
            }`}
          >
            {app.platform}
          </span>
          <ChevronRight className="size-4 text-muted-foreground" />
        </div>
      </button>
    )
  }

  // ── App detail page ─────────────────────────────────────────────────────
  function Detail({ app }: { app: MobileApp }) {
    const status = simpleStatus(instByApp.get(app.id))
    const queueIndex = queue.findIndex((q) => q.app === app.id)

    return (
      <div className="p-4">
        <button
          type="button"
          onClick={() => setDetailAppId(null)}
          className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          {t('common.back')}
        </button>

        <div className="flex items-start gap-4">
          <div className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-muted">
            <Smartphone className="size-8 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold">{app.name}</h3>
            <span
              className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                app.platform === 'android'
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
              }`}
            >
              {app.platform}
            </span>
          </div>
        </div>

        {/* Action area — depends on the current install state */}
        <div className="mt-4">
          {status === 'installed' && (
            <button
              type="button"
              onClick={() => uninstallMut.mutate(app.id)}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              <Trash2 className="size-4" />
              {t('profiles.uninstallAction')}
            </button>
          )}

          {status === 'installing' && (
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('profiles.installingProgress')}
            </div>
          )}

          {status === 'pending' && (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-muted-foreground">
                {t('profiles.queuePosition', { n: queueIndex + 1 })}
              </span>
              <button
                type="button"
                onClick={() => uninstallMut.mutate(app.id)}
                disabled={busy}
                className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                <X className="size-3.5" />
                {t('profiles.cancelQueueAction')}
              </button>
            </div>
          )}

          {status === 'none' && (
            <button
              type="button"
              onClick={() => installMut.mutate(app.id)}
              disabled={busy || !hasDevice}
              title={!hasDevice ? t('profiles.appsNoDeviceWarning') : undefined}
              className="flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              <Download className="size-4" />
              {t('profiles.installAppAction')}
            </button>
          )}
        </div>

        {/* Metadata */}
        <dl className="mt-6 space-y-3 text-sm">
          {app.package_name && (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                {t('profiles.appDetailPackage')}
              </dt>
              <dd className="font-mono">{app.package_name}</dd>
            </div>
          )}
          {app.version && (
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                {t('profiles.appDetailVersion')}
              </dt>
              <dd>{app.version}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs font-medium text-muted-foreground">
              {t('profiles.appDetailDescription')}
            </dt>
            <dd className="whitespace-pre-wrap">
              {app.description || (
                <span className="text-muted-foreground">
                  {t('profiles.appDetailNoDescription')}
                </span>
              )}
            </dd>
          </div>
        </dl>
      </div>
    )
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {/* Header: tabs */}
      <div className="flex items-center gap-1 border-b border-border bg-muted/40 px-2">
        {(['store', 'queue'] as const).map((key) => {
          const label =
            key === 'store' ? t('profiles.storeTab') : t('profiles.queueTab')
          const active = tab === key && detailAppId == null
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key)
                setDetailAppId(null)
              }}
              className={`border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
              {key === 'queue' && queue.length > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  {queue.length}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Body */}
      {detailApp ? (
        <Detail app={detailApp} />
      ) : tab === 'store' ? (
        <div>
          {/* Search */}
          <div className="border-b border-border p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('profiles.appSearchPlaceholder')}
                className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          {/* App list */}
          {storeApps.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {search.trim()
                ? t('profiles.noStoreSearchResults')
                : t('profiles.noStoreApps')}
            </p>
          ) : (
            <div className="max-h-[26rem] overflow-y-auto">
              {storeApps.map((app, i) => (
                <AppRow
                  key={app.id}
                  app={app}
                  status={simpleStatus(instByApp.get(app.id))}
                  divider={i < storeApps.length - 1}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        // Queue tab
        <div>
          {queue.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('profiles.noQueuedApps')}
            </p>
          ) : (
            <div className="max-h-[26rem] overflow-y-auto">
              {queue.map((inst, i) => (
                <AppRow
                  key={inst.id}
                  app={inst.app_detail}
                  status={inst.status === 'installing' ? 'installing' : 'pending'}
                  divider={i < queue.length - 1}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
