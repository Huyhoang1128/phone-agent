import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ExternalLink, X, Loader2, Trash2, Send, CheckSquare, FileBarChart2, ScanSearch,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { facebookPostsApi, profilesApi, devicesApi, tasksApi } from '@/lib/api'
import type { FacebookCommentedInteraction } from '@/lib/types'
import FacebookCommentReportModal from '@/components/FacebookCommentReportModal'

function formatDateTime(value: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })
}

// ── Replay modal ──────────────────────────────────────────────────────────────

function ReplayModal({ item, onClose, onDone }: { item: FacebookCommentedInteraction; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const { showToast } = useToast()
  const [profileId, setProfileId] = useState<string>(item.profile ? String(item.profile) : '')
  const [deviceId, setDeviceId] = useState<string>(item.device ? String(item.device) : '')
  const [sending, setSending] = useState(false)

  const { data: profiles } = useQuery({ queryKey: ['profiles'], queryFn: () => profilesApi.list() })
  const { data: devices } = useQuery({ queryKey: ['devices'], queryFn: () => devicesApi.list() })

  async function handleSend() {
    if (!profileId || !deviceId) {
      showToast(t('facebook.interactions.replaySelectRequired'), 'error')
      return
    }
    setSending(true)
    try {
      const task = await tasksApi.create({
        name: `Facebook replay #${item.id}`,
        description: `Hãy mở Facebook và bình luận vào bài đăng ${item.post_url} với nội dung ${item.comment_content}`,
        task_type: 'generic',
        status: 'pending',
        payload: {
          app: 'facebook',
          source: 'facebook-comment-replay',
          interaction_id: item.id,
          comment_plan_id: item.comment_plan_id,
          post_url: item.post_url,
          comment_content: item.comment_content,
        },
      })
      await tasksApi.run(task.id, [Number(deviceId)], Number(profileId))
      await facebookPostsApi.markReplayDispatched([item.id])
      showToast(t('facebook.interactions.replaySuccess'), 'success')
      onDone()
      onClose()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('facebook.interactions.replayError'), 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{t('facebook.interactions.replayTitle')}</h2>
            <p className="text-xs text-muted-foreground">{t('facebook.interactions.replaySubtitle')}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
        </div>
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t('facebook.interactions.replayProfile')}</label>
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
              <option value="">—</option>
              {(profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t('facebook.interactions.replayDevice')}</label>
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
              <option value="">—</option>
              {(devices ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          <Button variant="outline" onClick={onClose} disabled={sending}>{t('common.cancel')}</Button>
          <Button onClick={handleSend} disabled={sending}>
            <Send className="mr-1.5 size-3.5" />
            {sending ? t('common.saving') : t('facebook.interactions.replaySend')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Interactions tab ──────────────────────────────────────────────────────────

export default function FacebookInteractionsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [applied, setApplied] = useState<{ date_from?: string; date_to?: string }>({})
  const [profileFilter, setProfileFilter] = useState('')
  const [deviceFilter, setDeviceFilter] = useState('')
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [replayItem, setReplayItem] = useState<FacebookCommentedInteraction | null>(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [diggingId, setDiggingId] = useState<number | null>(null)

  const { data: interactions, isLoading, refetch } = useQuery({
    queryKey: ['facebook-commented-interactions', applied],
    queryFn: () => facebookPostsApi.listCommentedInteractions(applied),
  })

  const profileNames = useMemo(
    () => [...new Set((interactions ?? []).map((i) => i.profile_name).filter(Boolean))] as string[],
    [interactions],
  )
  const deviceNames = useMemo(
    () => [...new Set((interactions ?? []).map((i) => i.device_name).filter(Boolean))] as string[],
    [interactions],
  )

  const filtered = useMemo(() => (interactions ?? []).filter((i) => {
    if (profileFilter && i.profile_name !== profileFilter) return false
    if (deviceFilter && i.device_name !== deviceFilter) return false
    return true
  }), [interactions, profileFilter, deviceFilter])

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => facebookPostsApi.deleteCommentedInteractions(ids),
    onSuccess: (res) => {
      showToast(t('facebook.interactions.deleteSuccess', { count: res.deleted }), 'success')
      setSelectedIds(new Set())
      setSelectionMode(false)
      qc.invalidateQueries({ queryKey: ['facebook-commented-interactions'] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.interactions.deleteError'), 'error'),
  })

  function toggleRow(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function handleDig(item: FacebookCommentedInteraction) {
    if (diggingId !== null) return
    setDiggingId(item.id)
    try {
      const res = await facebookPostsApi.digComment(item.post_id, item.id, item.comment_plan_id)
      if (res.matched && res.comment_link) showToast(t('facebook.interactions.digSuccess'), 'success')
      else if (res.matched) showToast(t('facebook.interactions.digNoLink'), 'info')
      else showToast(t('facebook.interactions.digNoMatch'), 'info')
      refetch()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('facebook.interactions.digError'), 'error')
    } finally {
      setDiggingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('facebook.interactions.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('facebook.interactions.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setReportOpen(true)}>
            <FileBarChart2 className="mr-1.5 size-3.5" />{t('facebook.interactions.report')}
          </Button>
          {selectionMode ? (
            <>
              <Button variant="outline" size="sm" onClick={() => { setSelectionMode(false); setSelectedIds(new Set()) }}>
                {t('facebook.interactions.cancelSelect')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  if (selectedIds.size === 0) return
                  if (confirm(t('facebook.interactions.deleteConfirm', { count: selectedIds.size }))) {
                    deleteMutation.mutate([...selectedIds])
                  }
                }}
                disabled={selectedIds.size === 0 || deleteMutation.isPending}
              >
                <Trash2 className="mr-1.5 size-3.5" />
                {t('facebook.interactions.deleteSelected', { count: selectedIds.size })}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setSelectionMode(true)}>
              <CheckSquare className="mr-1.5 size-3.5" />{t('facebook.interactions.selectMode')}
            </Button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">{t('facebook.filterFrom')}</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">{t('facebook.filterTo')}</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <Button size="sm" variant="outline" onClick={() => setApplied({ date_from: dateFrom || undefined, date_to: dateTo || undefined })}>
          {t('facebook.report.apply')}
        </Button>
        <select value={profileFilter} onChange={(e) => setProfileFilter(e.target.value)}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring">
          <option value="">{t('facebook.interactions.filterProfile')}</option>
          {profileNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <select value={deviceFilter} onChange={(e) => setDeviceFilter(e.target.value)}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring">
          <option value="">{t('facebook.interactions.filterDevice')}</option>
          {deviceNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <Button size="sm" variant="ghost" onClick={() => { setProfileFilter(''); setDeviceFilter(''); setDateFrom(''); setDateTo(''); setApplied({}) }}>
          {t('facebook.clearFilters')}
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('common.loading')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('facebook.interactions.empty')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {selectionMode && <th className="px-4 py-2.5" />}
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.interactions.colPage')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.interactions.colPost')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.interactions.colContent')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.interactions.colProfile')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.interactions.colDevice')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.interactions.colLink')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.interactions.colCreated')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.interactions.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((item) => (
                <tr key={item.id} className={`transition-colors ${
                  selectionMode && selectedIds.has(item.id)
                    ? 'bg-primary/5'
                    : item.replay_task_dispatched || item.dig_comment_dispatched ? 'bg-red-100 dark:bg-red-950/40' : 'hover:bg-muted/30'
                }`}>
                  {selectionMode && (
                    <td className="px-4 py-2.5">
                      <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleRow(item.id)}
                        className="size-4 cursor-pointer accent-primary" />
                    </td>
                  )}
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{item.page_name || '—'}</td>
                  <td className="px-4 py-2.5 max-w-[220px]">
                    {item.post_url ? (
                      <a href={item.post_url} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground">
                        <ExternalLink className="size-3 shrink-0" /><span className="truncate">{item.post_url}</span>
                      </a>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2.5 max-w-[280px] text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span className="line-clamp-2 flex-1">{item.comment_content || '—'}</span>
                      {item.comment_content && (
                        <button onClick={() => setPreview(item.comment_content)}
                          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
                          {t('facebook.interactions.viewFull')}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{item.profile_name || '—'}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{item.device_name || '—'}</td>
                  <td className="px-4 py-2.5 max-w-[200px]">
                    {item.comment_link ? (
                      <a href={item.comment_link} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground">
                        <ExternalLink className="size-3 shrink-0" /><span className="truncate">{item.comment_link}</span>
                      </a>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(item.created_at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => setReplayItem(item)}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                        <Send className="size-3" /><span>{t('facebook.interactions.replay')}</span>
                      </button>
                      <button onClick={() => handleDig(item)} disabled={diggingId === item.id}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50">
                        {diggingId === item.id ? <Loader2 className="size-3 animate-spin" /> : <ScanSearch className="size-3" />}
                        <span>{diggingId === item.id ? t('facebook.interactions.digging') : t('facebook.interactions.dig')}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {preview && (
        <div onClick={() => setPreview(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{t('facebook.interactions.colContent')}</h2>
              <button onClick={() => setPreview(null)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-5"><p className="whitespace-pre-wrap text-sm text-foreground">{preview}</p></div>
          </div>
        </div>
      )}

      {replayItem && <ReplayModal item={replayItem} onClose={() => setReplayItem(null)} onDone={() => refetch()} />}
      {reportOpen && <FacebookCommentReportModal onClose={() => setReportOpen(false)} />}
    </div>
  )
}
