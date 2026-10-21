import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Smartphone,
  Search,
  Plus,
  ChevronDown,
  X,
  RefreshCw,
  LogIn,
  LogOut,
  RotateCcw,
  Wifi,
  WifiOff,
  Archive,
  Undo2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { useAuth } from '@/context/AuthContext'
import { devicesApi, profilesApi } from '@/lib/api'
import { ShareButton } from '@/components/ShareResourceDialog'
import type {
  Device,
  DeviceCreate,
  DeviceType,
  DeviceStatus,
  Profile,
  ConnectedDevicesResponse,
} from '@/lib/types'

const DEVICE_TYPES: { value: DeviceType; labelKey: string }[] = [
  { value: 'personal', labelKey: 'devices.typePersonal' },
  { value: 'emulator', labelKey: 'devices.typeEmulator' },
  { value: 'agent', labelKey: 'devices.typeAgent' },
  { value: 'mobilerun', labelKey: 'devices.typeMobilerun' },
]

const DEVICE_STATUSES: { value: DeviceStatus; labelKey: string }[] = [
  { value: 'online', labelKey: 'devices.statusOnline' },
  { value: 'offline', labelKey: 'devices.statusOffline' },
  { value: 'connected', labelKey: 'devices.statusConnected' },
]

const TABS = [
  { key: 'streams', labelKey: 'devices.tabStreams' },
  { key: 'devices', labelKey: 'devices.tabDevices' },
]

const DEFAULT_FORM: DeviceCreate = {
  name: '',
  device_type: 'personal',
  status: 'offline',
  device_serial_id: '',
}

export default function DevicesPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('devices')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<DeviceType | 'all'>('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState<DeviceCreate>(DEFAULT_FORM)
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null)
  const [formError, setFormError] = useState('')
  const [manualIdentifier, setManualIdentifier] = useState(false)
  // TCS-v2 Sprint 2 (#2): toggle hiện thiết bị đã soft-delete.
  const [showDeleted, setShowDeleted] = useState(false)

  const { data: devices = [], isLoading, refetch } = useQuery<Device[]>({
    queryKey: ['devices', { includeDeleted: showDeleted }],
    queryFn: () => devicesApi.list({ includeDeleted: showDeleted }),
    refetchInterval: 30_000,
  })

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ['profiles'],
    queryFn: profilesApi.list,
    enabled: modalOpen,
  })

  const {
    data: connectedDevicesData,
    refetch: refetchConnected,
    isFetching: isFetchingConnected,
  } = useQuery<ConnectedDevicesResponse>({
    queryKey: ['devices', 'connected'],
    queryFn: devicesApi.connected,
    // Keep the connected list reasonably fresh both inside and outside the modal,
    // since the rows show an "available" badge driven by the same data.
    refetchInterval: 15_000,
  })
  const connectedDevices = connectedDevicesData?.devices ?? []
  const connectedSerials = connectedDevices.map((d) => d.serial)

  const createMutation = useMutation({
    mutationFn: async ({ device, profileId }: { device: DeviceCreate; profileId: number | null }) => {
      const created = await devicesApi.create(device)
      if (profileId !== null) {
        await profilesApi.update(profileId, { device: created.id })
      }
      return created
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      qc.invalidateQueries({ queryKey: ['profiles'] })
      setModalOpen(false)
      setForm(DEFAULT_FORM)
      setSelectedProfileId(null)
      setFormError('')
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message || t('common.createError'), 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: devicesApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  })

  // TCS-v2 Sprint 2 (#2): khôi phục thiết bị đã soft-delete.
  const restoreMutation = useMutation({
    mutationFn: devicesApi.restore,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      showToast(t('devices.restoreSuccess'), 'success')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const claimMutation = useMutation({
    mutationFn: devicesApi.claim,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      showToast(t('devices.claimSuccess'), 'success')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const releaseMutation = useMutation({
    mutationFn: devicesApi.release,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      showToast(t('devices.releaseSuccess'), 'success')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const reclaimMutation = useMutation({
    mutationFn: devicesApi.reclaim,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      showToast(t('devices.reclaimSuccess'), 'success')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const filtered = devices.filter((d) => {
    const matchType = typeFilter === 'all' || d.device_type === typeFilter
    const matchSearch =
      !search ||
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.device_serial_id.toLowerCase().includes(search.toLowerCase())
    return matchType && matchSearch
  })

  const isSessionPending = claimMutation.isPending || releaseMutation.isPending || reclaimMutation.isPending

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) {
      setFormError(t('devices.nameRequired'))
      return
    }
    if (!form.device_serial_id.trim()) {
      setFormError(t('devices.serialRequired'))
      return
    }
    createMutation.mutate({ device: form, profileId: selectedProfileId })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Live-Updates indicator */}
      <div className="flex justify-end">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t('common.liveUpdates')}
          <span className="inline-block size-2 rounded-full bg-green-500" />
        </span>
      </div>

      {/* Type filter badges */}
      <div className="flex flex-wrap items-center gap-2">
        {DEVICE_TYPES.map(({ value, labelKey }) => (
          <button
            key={value}
            onClick={() => setTypeFilter(typeFilter === value ? 'all' : value)}
            className={
              typeFilter === value
                ? 'rounded-full border border-foreground bg-foreground px-3 py-1 text-xs font-medium text-background'
                : 'rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground hover:text-foreground'
            }
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* Tabs + count + controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          {/* Tabs */}
          <div className="flex items-center rounded-lg border border-border bg-background p-0.5">
            {TABS.map(({ key, labelKey }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={
                  activeTab === key
                    ? 'rounded-md bg-foreground px-3 py-1 text-xs font-semibold text-background'
                    : 'rounded-md px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground'
                }
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
          <span className="text-sm text-muted-foreground">
            {filtered.length} {t('devices.devicesCount')}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* TCS-v2 Sprint 2 (#2): toggle "Hiện đã xóa" */}
          <button
            onClick={() => setShowDeleted((v) => !v)}
            className={
              showDeleted
                ? 'flex items-center gap-1.5 rounded-md border border-orange-500 bg-orange-500/10 px-2.5 py-1 text-xs text-orange-400 transition-colors'
                : 'flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground hover:text-foreground'
            }
            aria-label={t('devices.showDeleted')}
            title={showDeleted ? t('devices.hideDeleted') : t('devices.showDeleted')}
          >
            <Archive className="size-3.5" />
            {showDeleted ? t('devices.hideDeleted') : t('devices.showDeleted')}
          </button>

          <Button variant="outline" size="sm">
            {t('devices.manageSlots')}
          </Button>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder={t('devices.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-40 sm:w-52 rounded-lg border border-border bg-background pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* All types filter */}
          <div className="relative">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as DeviceType | 'all')}
              className="h-8 appearance-none rounded-lg border border-border bg-background pl-3 pr-7 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t('devices.allTypes')}</option>
              {DEVICE_TYPES.map(({ value, labelKey }) => (
                <option key={value} value={value}>
                  {t(labelKey)}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          </div>

          {/* View button */}
          <button className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted">
            {t('devices.view')}
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
        </div>
      </div>

      {/* Content */}
      <div className="overflow-x-auto rounded-lg border border-border">
        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-16">
            <div className="flex size-16 items-center justify-center rounded-full bg-muted">
              <Smartphone className="size-8 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">{t('devices.noDevices')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('devices.noDevicesHint')}</p>
            </div>
            <Button onClick={() => setModalOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              {t('devices.addConnect')}
            </Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('devices.colName')}</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('devices.colStatus')}</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('devices.colProfile')}</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('devices.colWorkerId')}</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('devices.colIdentifier')}</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t('devices.colActions')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((device) => {
                const session = device.active_session
                const isOwner = device.owner_id === user?.id
                const isCurrentUserSession = session?.user_id === user?.id

                return (
                  <tr key={device.id} className="border-t border-border hover:bg-muted/40">
                    <td className="px-4 py-3 font-medium">
                      <button
                        onClick={() => navigate(`/devices/${device.id}`)}
                        className="text-left hover:underline focus:outline-none"
                      >
                        {device.name}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={
                          device.status === 'online'
                            ? 'inline-flex items-center gap-1 text-xs text-green-600'
                            : device.status === 'connected'
                              ? 'inline-flex items-center gap-1 text-xs text-blue-600'
                              : 'inline-flex items-center gap-1 text-xs text-muted-foreground'
                        }>
                          <span className={
                            device.status === 'online'
                              ? 'size-1.5 rounded-full bg-green-500'
                              : device.status === 'connected'
                                ? 'size-1.5 rounded-full bg-blue-500'
                                : 'size-1.5 rounded-full bg-muted-foreground'
                          } />
                          {device.status}
                        </span>
                        {/* TCS-v2 Sprint 2 (#2): badge "Đã xóa" cho soft-deleted devices */}
                        {!device.is_active && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                            <Archive className="size-3" />
                            {t('devices.deletedBadge')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {device.profiles[0]?.name ?? ''}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                      {device.worker_id ?? ''}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                      <div className="flex items-center gap-2">
                        {device.available ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400"
                            title={t('devices.available')}
                          >
                            <Wifi className="size-3" />
                            {t('devices.available')}
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                            title={t('devices.notAvailable')}
                          >
                            <WifiOff className="size-3" />
                            {t('devices.notAvailable')}
                          </span>
                        )}
                      <span>{device.device_serial_id}</span>
                      </div>
                    </td>

                    {/* Usage session + share controls */}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {/* Active session badge */}
                        {session && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                            <span className="size-1.5 rounded-full bg-orange-500" />
                            {t('devices.inUseBy', { name: session.display_name || session.username })}
                          </span>
                        )}

                        {/* Claim – shown when nobody is using the device (or owner wants to claim) */}
                        {!session && (
                          <button
                            onClick={() => claimMutation.mutate(device.id)}
                            disabled={isSessionPending}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                            title={t('devices.claimDevice')}
                          >
                            <LogIn className="size-3.5" />
                            {t('devices.claimDevice')}
                          </button>
                        )}

                        {/* Release – shown when the current user holds the session */}
                        {session && isCurrentUserSession && (
                          <button
                            onClick={() => releaseMutation.mutate(device.id)}
                            disabled={isSessionPending}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                            title={t('devices.releaseDevice')}
                          >
                            <LogOut className="size-3.5" />
                            {t('devices.releaseDevice')}
                          </button>
                        )}

                        {/* Reclaim – owner only, when someone else holds the device */}
                        {session && !isCurrentUserSession && isOwner && (
                          <button
                            onClick={() => reclaimMutation.mutate(device.id)}
                            disabled={isSessionPending}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-orange-600 hover:bg-orange-50 hover:text-orange-700 disabled:opacity-50 dark:hover:bg-orange-900/20"
                            title={t('devices.reclaimDevice')}
                          >
                            <RotateCcw className="size-3.5" />
                            {t('devices.reclaimDevice')}
                          </button>
                        )}

                        {/* Share button – owner only */}
                        {isOwner && (
                          <ShareButton
                            currentTeamId={device.team_id}
                            currentTeamName={device.team_name}
                            currentPermission={device.team_permission}
                            onShare={(teamId, permission) =>
                              devicesApi.share(device.id, teamId, permission)
                            }
                            onUnshare={() => devicesApi.unshare(device.id)}
                            invalidateKey={['devices']}
                          />
                        )}
                      </div>
                    </td>

                    <td className="px-4 py-3 text-right">
                      {isOwner && (
                        device.is_active ? (
                          /* Active device → nút xóa (soft-delete) với confirm */
                          <button
                            onClick={() => {
                              if (window.confirm(t('devices.deleteConfirm'))) {
                                deleteMutation.mutate(device.id)
                              }
                            }}
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                            aria-label={t('devices.deleteDevice')}
                            title={t('devices.deleteDevice')}
                          >
                            <X className="size-4" />
                          </button>
                        ) : (
                          /* TCS-v2 Sprint 2 (#2): soft-deleted device → nút khôi phục */
                          <button
                            onClick={() => restoreMutation.mutate(device.id)}
                            disabled={restoreMutation.isPending}
                            className="rounded p-1 text-orange-500 transition-colors hover:bg-orange-500/10 hover:text-orange-400 disabled:opacity-50"
                            aria-label={t('devices.restore')}
                            title={t('devices.restore')}
                          >
                            <Undo2 className="size-4" />
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Device button (when list has items) */}
      {filtered.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={() => setModalOpen(true)} size="sm">
            <Plus className="mr-1.5 size-4" />
            {t('devices.addConnect')}
          </Button>
        </div>
      )}

      {/* Add Device Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4">
          <div className="w-full max-w-md rounded-t-2xl sm:rounded-xl border border-border bg-background p-6 shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('devices.addDeviceTitle')}</h2>
              <button
                onClick={() => { setModalOpen(false); setForm(DEFAULT_FORM); setSelectedProfileId(null); setFormError('') }}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {/* Name */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('devices.fieldName')}</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder={t('devices.fieldNamePlaceholder')}
                />
              </div>

              {/* Device Type */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('devices.fieldType')}</label>
                <div className="relative">
                  <select
                    value={form.device_type}
                    onChange={(e) => setForm({ ...form, device_type: e.target.value as DeviceType })}
                    className="h-9 w-full appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    {DEVICE_TYPES.map(({ value, labelKey }) => (
                      <option key={value} value={value}>{t(labelKey)}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>

              {/* Status */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('devices.fieldStatus')}</label>
                <div className="relative">
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as DeviceStatus })}
                    className="h-9 w-full appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    {DEVICE_STATUSES.map(({ value, labelKey }) => (
                      <option key={value} value={value}>{t(labelKey)}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>

              {/* Identifier */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">{t('devices.fieldDeviceSerial')}</label>
                  <button
                    type="button"
                    onClick={() => setManualIdentifier((v) => !v)}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {manualIdentifier ? t('devices.selectFromConnected') : t('devices.enterManually')}
                  </button>
                </div>

                {!manualIdentifier ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <select
                          value={form.device_serial_id}
                          onChange={(e) => {
                            const serial = e.target.value
                            const matched = connectedDevices.find((d) => d.serial === serial)
                            setForm({ ...form, device_serial_id: serial, identifier: matched?.identifier ?? '' })
                          }}
                          className="h-9 w-full appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
                        >
                          <option value="">{t('devices.selectDeviceSerial')}</option>
                          {connectedDevices.map(({ serial }) => (
                            <option key={serial} value={serial}>
                              {serial}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      </div>
                      <button
                        type="button"
                        onClick={() => refetchConnected()}
                        disabled={isFetchingConnected}
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                        aria-label={t('devices.refreshConnected')}
                        title={t('devices.refreshConnected')}
                      >
                        <RefreshCw className={isFetchingConnected ? 'size-3.5 animate-spin' : 'size-3.5'} />
                      </button>
                    </div>
                    {connectedSerials.length === 0 && (
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <WifiOff className="size-3" />
                        {t('devices.noConnectedDevices')}
                      </p>
                    )}
                    {connectedSerials.length > 0 && form.device_serial_id && (
                      <p className="flex items-center gap-1.5 text-xs text-green-600">
                        <Wifi className="size-3" />
                        {t('devices.available')}
                      </p>
                    )}
                  </>
                ) : (
                  <input
                    type="text"
                    value={form.device_serial_id}
                    onChange={(e) => setForm({ ...form, device_serial_id: e.target.value })}
                    className="h-9 rounded-lg border border-border bg-background px-3 text-sm font-mono outline-none focus:ring-2 focus:ring-ring"
                    placeholder={t('devices.fieldIdentifierPlaceholder')}
                  />
                )}
              </div>

              {/* Profile */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('devices.fieldProfile')}</label>
                <div className="relative">
                  <select
                    value={selectedProfileId ?? ''}
                    onChange={(e) => setSelectedProfileId(e.target.value ? Number(e.target.value) : null)}
                    className="h-9 w-full appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">{t('devices.profileNone')}</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                        {profile.device_detail
                          ? ` (${t('devices.profileLinkedTo', { deviceName: profile.device_detail.name })})`
                          : profile.device
                          ? ` (${t('devices.profileLinkedTo', { deviceName: String(profile.device) })})`
                          : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>

              {formError && (
                <p className="text-xs text-destructive">{formError}</p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => { setModalOpen(false); setForm(DEFAULT_FORM); setSelectedProfileId(null); setFormError('') }}
                >
                  {t('common.cancel')}
                </Button>
                <Button type="submit" size="sm" disabled={createMutation.isPending}>
                  {createMutation.isPending ? t('common.creating') : t('devices.addConnect')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  )
}
