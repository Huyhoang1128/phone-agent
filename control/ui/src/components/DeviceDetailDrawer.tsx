import { useState, useCallback, useEffect, Fragment, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  X,
  Smartphone,
  Monitor,
  Cpu,
  User,
  MonitorPlay,
  Bell,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Check,
} from 'lucide-react'
import type { Device, DeviceNotification, PaginatedResponse } from '@/lib/types'
import { devicesApi } from '@/lib/api'
import DeviceStream from '@/components/DeviceStream'

interface DeviceDetailDrawerProps {
  device: Device
  onClose: () => void
}

export default function DeviceDetailDrawer({ device, onClose }: DeviceDetailDrawerProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [streamModalOpen, setStreamModalOpen] = useState(false)

  // ── Rename state ─────────────────────────────────────────────────────────
  const [editingName, setEditingName] = useState(false)
  const [editNameValue, setEditNameValue] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      devicesApi.update(device.id, {
        name,
        device_type: device.device_type,
        status: device.status,
        device_serial_id: device.device_serial_id,
        identifier: device.identifier,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      setEditingName(false)
    },
  })

  const startEditing = useCallback(() => {
    setEditNameValue(device.name)
    setEditingName(true)
  }, [device.name])

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus()
  }, [editingName])

  const handleRenameSave = useCallback(() => {
    const trimmed = editNameValue.trim()
    if (trimmed && trimmed !== device.name) {
      renameMutation.mutate(trimmed)
    } else {
      setEditingName(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editNameValue, device.name, renameMutation.mutate])

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleRenameSave()
      if (e.key === 'Escape') setEditingName(false)
    },
    [handleRenameSave],
  )

  // ── Notifications state ──────────────────────────────────────────────────
  const PAGE_SIZE = 10
  const [notifPage, setNotifPage] = useState(1)
  const [notifData, setNotifData] = useState<PaginatedResponse<DeviceNotification> | null>(null)
  const [notifLoading, setNotifLoading] = useState(false)
  const [notifError, setNotifError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setNotifLoading(true)
    setNotifError(false)
    devicesApi.notifications(device.id, notifPage, PAGE_SIZE).then((data) => {
      if (!cancelled) {
        setNotifData(data)
        setNotifLoading(false)
      }
    }).catch((err) => {
      if (!cancelled) {
        console.error('Failed to load device notifications:', err)
        setNotifError(true)
        setNotifLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [device.id, notifPage])

  const totalPages = notifData ? Math.max(1, Math.ceil(notifData.count / PAGE_SIZE)) : 1

  const handleStreamStop = useCallback(() => setStreamModalOpen(false), [])

  const hasHardwareInfo = Object.keys(device.hardware_info ?? {}).length > 0

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Drawer panel */}
      <div
        className="relative z-10 flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Smartphone className="size-5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              {editingName ? (
                <div className="flex items-center gap-1.5">
                  <input
                    ref={nameInputRef}
                    type="text"
                    value={editNameValue}
                    onChange={(e) => setEditNameValue(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    placeholder={t('deviceDetail.editNamePlaceholder')}
                    className="h-7 min-w-0 w-40 rounded-md border border-border bg-background px-2 text-sm font-semibold leading-tight outline-none ring-1 ring-primary focus:ring-2"
                  />
                  <button
                    onClick={handleRenameSave}
                    disabled={renameMutation.isPending}
                    className="flex items-center justify-center rounded-md p-1 text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
                    aria-label={t('deviceDetail.editNameSave')}
                  >
                    <Check className="size-3.5" />
                  </button>
                  <button
                    onClick={() => setEditingName(false)}
                    disabled={renameMutation.isPending}
                    className="flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40"
                    aria-label={t('deviceDetail.editNameCancel')}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <h2 className="text-base font-semibold leading-tight truncate">{device.name}</h2>
                  <button
                    onClick={startEditing}
                    className="flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={t('deviceDetail.editName')}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                </div>
              )}
              {renameMutation.isError && (
                <p className="text-xs text-destructive">{t('deviceDetail.editNameError')}</p>
              )}
              <p className="text-xs text-muted-foreground">{t(`devices.type${capitalize(device.device_type)}`)}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 pl-3">
            <button
              onClick={() => setStreamModalOpen(true)}
              disabled={!device.identifier}
              className="flex items-center gap-1.5 rounded-lg border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <MonitorPlay className="size-3.5" />
              {t('deviceDetail.startStream')}
            </button>
            <button
              onClick={onClose}
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted"
              aria-label={t('common.cancel')}
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Two-column body */}
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 sm:items-start">

          {/* ── Left column: device info ──────────────────────────────── */}
          <div className="flex flex-col gap-4">

            {/* Status */}
            <section className="rounded-xl border border-border bg-background p-4">
              <div className="mb-3 flex items-center gap-2">
                <Smartphone className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t('deviceDetail.sectionStatus')}</h3>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t('devices.colStatus')}</dt>
                <dd>
                  <span className={statusClass(device.status)}>
                    <span className={dotClass(device.status)} />
                    {device.status}
                  </span>
                </dd>

                <dt className="text-muted-foreground">{t('devices.colIdentifier')}</dt>
                <dd className="font-mono text-xs break-all">{device.device_serial_id || '—'}</dd>

                <dt className="text-muted-foreground">{t('deviceDetail.identifier')}</dt>
                <dd className="font-mono text-xs break-all">{device.identifier || '—'}</dd>

                <dt className="text-muted-foreground">{t('deviceDetail.available')}</dt>
                <dd>
                  {device.available ? (
                    <span className="text-green-600">{t('devices.available')}</span>
                  ) : (
                    <span className="text-muted-foreground">{t('devices.notAvailable')}</span>
                  )}
                </dd>

                <dt className="text-muted-foreground">{t('deviceDetail.createdAt')}</dt>
                <dd>{new Date(device.created_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}</dd>
              </dl>
            </section>

            {/* Screen size */}
            <section className="rounded-xl border border-border bg-background p-4">
              <div className="mb-3 flex items-center gap-2">
                <Monitor className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t('deviceDetail.sectionScreen')}</h3>
              </div>
              {device.screen_width && device.screen_height ? (
                <p className="text-sm font-medium">
                  {device.screen_width} × {device.screen_height} px
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t('deviceDetail.noScreenInfo')}</p>
              )}
            </section>

            {/* Hardware */}
            <section className="rounded-xl border border-border bg-background p-4">
              <div className="mb-3 flex items-center gap-2">
                <Cpu className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t('deviceDetail.sectionHardware')}</h3>
              </div>
              {hasHardwareInfo ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  {Object.entries(device.hardware_info).map(([key, value]) => (
                    <Fragment key={key}>
                      <dt className="text-muted-foreground capitalize">
                        {key.replace(/_/g, ' ')}
                      </dt>
                      <dd className="break-all">
                        {String(value)}
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">{t('deviceDetail.noHardwareInfo')}</p>
              )}
            </section>

            {/* Profiles */}
            <section className="rounded-xl border border-border bg-background p-4">
              <div className="mb-3 flex items-center gap-2">
                <User className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t('deviceDetail.sectionProfiles')}</h3>
              </div>
              {device.profiles && device.profiles.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {device.profiles.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm"
                    >
                      <User className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{p.name}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('deviceDetail.noProfiles')}</p>
              )}
            </section>
          </div>

          {/* ── Right column: notifications ───────────────────────────── */}
          <section className="rounded-xl border border-border bg-background p-4">
            <div className="mb-3 flex items-center gap-2">
              <Bell className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{t('deviceDetail.sectionNotifications')}</h3>
              {notifData && notifData.count > 0 && (
                <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {notifData.count}
                </span>
              )}
            </div>

            {notifLoading ? (
              <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
            ) : notifError ? (
              <p className="text-sm text-destructive">{t('common.saveError')}</p>
            ) : notifData && notifData.results.length > 0 ? (
              <>
                <ul className="flex flex-col divide-y divide-border">
                  {notifData.results.map((n) => (
                    <li key={n.id} className="py-2.5 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium leading-snug break-words min-w-0">
                          {n.title || n.package || '—'}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(n.received_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}
                        </span>
                      </div>
                      {n.text ? (
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{n.text}</p>
                      ) : null}
                      {n.package ? (
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground">{n.package}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>

                {/* Pagination controls */}
                {totalPages > 1 && (
                  <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <button
                      disabled={notifPage <= 1}
                      onClick={() => setNotifPage((p) => p - 1)}
                      className="flex items-center gap-1 rounded px-2 py-1 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ChevronLeft className="size-3.5" />
                      {t('deviceDetail.notifPrev')}
                    </button>
                    <span>
                      {t('deviceDetail.notifPage', { page: notifPage, total: totalPages })}
                    </span>
                    <button
                      disabled={notifPage >= totalPages}
                      onClick={() => setNotifPage((p) => p + 1)}
                      className="flex items-center gap-1 rounded px-2 py-1 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t('deviceDetail.notifNext')}
                      <ChevronRight className="size-3.5" />
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('deviceDetail.noNotifications')}</p>
            )}
          </section>
        </div>
      </div>

      {/* ── Stream Modal (rendered above the drawer via z-index) ─── */}
      {streamModalOpen && device.identifier && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => { e.stopPropagation(); setStreamModalOpen(false) }}
        >
          <div
            className="relative flex w-full max-w-3xl flex-col rounded-2xl border border-border bg-background shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div className="flex items-center gap-2">
                <MonitorPlay className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">{device.name}</span>
                <span className="text-xs text-muted-foreground">— {t('deviceDetail.sectionStream')}</span>
              </div>
              <button
                onClick={() => setStreamModalOpen(false)}
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted"
                aria-label={t('deviceDetail.closeStream')}
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Stream content */}
            <div className="p-4">
              <DeviceStream
                identifier={device.identifier}
                deviceId={device.id}
                onStop={handleStreamStop}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function statusClass(status: string): string {
  if (status === 'online') return 'inline-flex items-center gap-1 text-xs text-green-600'
  if (status === 'connected') return 'inline-flex items-center gap-1 text-xs text-blue-600'
  return 'inline-flex items-center gap-1 text-xs text-muted-foreground'
}

function dotClass(status: string): string {
  if (status === 'online') return 'size-1.5 rounded-full bg-green-500'
  if (status === 'connected') return 'size-1.5 rounded-full bg-blue-500'
  return 'size-1.5 rounded-full bg-muted-foreground'
}
