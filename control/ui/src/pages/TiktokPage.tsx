import { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Plus, Trash2, Pencil, RefreshCw, ExternalLink, X, Music2,
  Search, Hash, BarChart2, Sparkles, ChevronDown, ChevronUp, Save, PlayCircle,
  Send, Wand2, Eye, Copy, MessageCircle, ScanLine, BotMessageSquare, CheckCircle2, Loader2, Info, FileBarChart2, ScanSearch,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { tiktokApi, keywordListsApi, agentGroupsApi, tasksApi, profilesApi, devicesApi } from '@/lib/api'
import type { TiktokVideo, TiktokVideoCreate, TiktokVideoStatus, KeywordList, AgentGroup, TiktokCommentPlan, TiktokCommentedInteraction, Profile, Device, TaskCreate } from '@/lib/types'
import TiktokCommentReportModal from '@/components/TiktokCommentReportModal'

const STATUS_OPTIONS: TiktokVideoStatus[] = ['pending', 'liked', 'commented', 'shared', 'reposted']

const DEFAULT_FORM: TiktokVideoCreate = {
  keywords: [],
  video_url: '',
  caption: null,
  content: '',
  status: 'pending',
  team_id: null,
}

const TIKTOK_TABS = ['videos', 'keywords', 'stats', 'comments'] as const
type Tab = (typeof TIKTOK_TABS)[number]
type TiktokPageLocationState = { tab?: Tab }

function StatusBadge({ status, label }: { status: TiktokVideoStatus; label: string }) {
  const colorMap: Record<TiktokVideoStatus, string> = {
    pending: 'bg-muted text-muted-foreground',
    liked: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
    commented: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    shared: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    reposted: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${colorMap[status]}`}>
      {label}
    </span>
  )
}

// ─── Videos Tab ───────────────────────────────────────────────────────────────

function VideosTab({ statusLabel }: { statusLabel: (s: TiktokVideoStatus) => string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const navigate = useNavigate()

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TiktokVideo | null>(null)
  const [form, setForm] = useState<TiktokVideoCreate>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')
  const [keywordInput, setKeywordInput] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [contentPreview, setContentPreview] = useState<{ title: string; text: string } | null>(null)
  const [videoDispatch, setVideoDispatch] = useState<TiktokVideo | null>(null)
  const [videoSignalDispatch, setVideoSignalDispatch] = useState<TiktokVideo | null>(null)
  const [copiedTaskId, setCopiedTaskId] = useState<number | null>(null)

  const { data: videos = [], isLoading, refetch } = useQuery<TiktokVideo[]>({
    queryKey: ['tiktok', dateFrom, dateTo, filterStatus],
    queryFn: () => tiktokApi.list({
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      status: filterStatus || undefined,
    }),
  })

  const createMutation = useMutation({
    mutationFn: tiktokApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tiktok'] }); closeModal(); showToast(t('common.createSuccess'), 'success') },
    onError: (err: Error) => { setFormError(err.message); showToast(err.message || t('common.createError'), 'error') },
  })
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<TiktokVideoCreate> }) => tiktokApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tiktok'] }); closeModal(); showToast(t('common.saveSuccess'), 'success') },
    onError: (err: Error) => { setFormError(err.message); showToast(err.message || t('common.saveError'), 'error') },
  })
  const deleteMutation = useMutation({
    mutationFn: tiktokApi.delete,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tiktok'] }); showToast(t('tiktok.deleteSuccess'), 'success') },
    onError: (err: Error) => showToast(err.message, 'error'),
  })
  const processVideoMutation = useMutation({
    mutationFn: (id: number) => tiktokApi.processVideo(id),
    onSuccess: (data) => { qc.invalidateQueries({ queryKey: ['tiktok'] }); showToast(t('tiktok.processVideoSuccess', { taskId: data.task_id }), 'success') },
    onError: (err: Error) => showToast(err.message || t('tiktok.processVideoError'), 'error'),
  })

  function openCreate() { setEditing(null); setForm(DEFAULT_FORM); setKeywordInput(''); setFormError(''); setModalOpen(true) }
  function openEdit(v: TiktokVideo) {
    setEditing(v)
    setForm({ keywords: v.keywords, video_url: v.video_url, caption: v.caption, content: v.content, status: v.status, team_id: v.team_id })
    setKeywordInput(''); setFormError(''); setModalOpen(true)
  }
  function closeModal() { setModalOpen(false); setEditing(null); setForm(DEFAULT_FORM); setKeywordInput(''); setFormError('') }
  function addKeyword() {
    const kw = keywordInput.trim()
    if (!kw) return
    if (!form.keywords.includes(kw)) setForm((p) => ({ ...p, keywords: [...p.keywords, kw] }))
    setKeywordInput('')
  }
  function removeKeyword(kw: string) { setForm((p) => ({ ...p, keywords: p.keywords.filter((k) => k !== kw) })) }
  function handleSubmit() {
    if (form.keywords.length === 0) { setFormError(t('tiktok.keywordsRequired')); return }
    if (editing) updateMutation.mutate({ id: editing.id, data: form })
    else createMutation.mutate(form)
  }
  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' })
  }
  function copyTaskId(v: TiktokVideo) {
    if (!v.video_process_task_id) return
    navigator.clipboard.writeText(String(v.video_process_task_id))
    setCopiedTaskId(v.id)
    setTimeout(() => setCopiedTaskId(null), 1500)
  }
  const isPending = createMutation.isPending || updateMutation.isPending

  return (
    <div className="flex flex-col gap-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">{t('tiktok.filterFrom')}</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">{t('tiktok.filterTo')}</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
            className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring">
            <option value="">{t('tiktok.filterStatus')}</option>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
          {(dateFrom || dateTo || filterStatus) && (
            <button onClick={() => { setDateFrom(''); setDateTo(''); setFilterStatus('') }}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted">
              <X className="size-3" />{t('common.cancel')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
            aria-label={t('common.refresh')}>
            <RefreshCw className="size-3.5" />
          </button>
          <Button onClick={openCreate} size="sm">
            <Plus className="mr-1 size-4" />{t('tiktok.newVideo')}
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : videos.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <Music2 className="size-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t('tiktok.noVideos')}</p>
            <Button onClick={openCreate} size="sm" variant="outline">
              <Plus className="mr-1 size-4" />{t('tiktok.newVideo')}
            </Button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colId')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colKeywords')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colVideoUrl')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colCaption')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colContent')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colTaskId')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colStatus')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colTeamId')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colCreated')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colUpdated')}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {videos.map((v) => (
                <tr key={v.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 text-xs text-muted-foreground font-mono">{v.id}</td>
                  <td className="px-4 py-2.5 max-w-[180px]">
                    <div className="flex flex-wrap gap-1">
                      {v.keywords.map((kw) => (
                        <span key={kw} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{kw}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 max-w-[180px]">
                    {v.video_url ? (
                      <a href={v.video_url} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground">
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{v.video_url}</span>
                      </a>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2.5 max-w-[200px]">
                    <div className="flex items-start gap-1 group">
                      <span className="line-clamp-2 text-xs text-muted-foreground flex-1">{v.caption ?? '—'}</span>
                      {v.caption && (
                        <button
                          onClick={() => setContentPreview({ title: t('tiktok.colCaption'), text: v.caption! })}
                          className="shrink-0 mt-0.5 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted"
                          aria-label={t('tiktok.viewFull')}
                        >
                          <Eye className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 max-w-[200px]">
                    <div className="flex items-start gap-1 group">
                      <span className="line-clamp-2 text-xs text-muted-foreground flex-1">{v.content || '—'}</span>
                      {v.content && (
                        <button
                          onClick={() => setContentPreview({ title: t('tiktok.colContent'), text: v.content })}
                          className="shrink-0 mt-0.5 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted"
                          aria-label={t('tiktok.viewFull')}
                        >
                          <Eye className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 max-w-[120px]">
                    {v.video_process_task_id ? (
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-[10px] text-muted-foreground" title={String(v.video_process_task_id)}>
                          {String(v.video_process_task_id).slice(0, 5)}…
                        </span>
                        <button
                          onClick={() => copyTaskId(v)}
                          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          aria-label={t('tiktok.taskIdCopy')}
                        >
                          {copiedTaskId === v.id
                            ? <span className="text-[9px] text-green-600 font-semibold">✓</span>
                            : <Copy className="size-3" />
                          }
                        </button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <StatusBadge status={v.status} label={statusLabel(v.status)} />
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{v.team_id ?? '—'}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{formatDate(v.created_at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{formatDate(v.updated_at)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEdit(v)}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={t('common.edit')}>
                        <Pencil className="size-4" />
                      </button>
                      <button
                        onClick={() => navigate(`/tiktok/${v.id}`)}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                        aria-label={t('tiktok.viewInteractions')}>
                        <Eye className="size-4" />
                      </button>
                      <button
                        onClick={() => processVideoMutation.mutate(v.id)}
                        disabled={processVideoMutation.isPending}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary disabled:opacity-50"
                        aria-label={t('tiktok.processVideo')}>
                        <PlayCircle className="size-4" />
                      </button>
                      <button
                        onClick={() => setVideoDispatch(v)}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                        aria-label={t('tiktok.videoDispatchOpen')}>
                        <MessageCircle className="size-4" />
                      </button>
                      <button
                        onClick={() => setVideoSignalDispatch(v)}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                        aria-label={t('tiktok.videoSignalDispatchOpen')}>
                        <BotMessageSquare className="size-4" />
                      </button>
                      <button onClick={() => { if (confirm(t('tiktok.deleteConfirm'))) deleteMutation.mutate(v.id) }}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                        aria-label={t('tiktok.deleteVideo')}>
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Content preview modal */}
      {contentPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{contentPreview.title}</h2>
              <button onClick={() => setContentPreview(null)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <div className="p-5 max-h-[60vh] overflow-y-auto">
              <p className="whitespace-pre-wrap text-sm text-foreground">{contentPreview.text}</p>
            </div>
          </div>
        </div>
      )}

      {/* Video dispatch modal */}
      {videoDispatch && (
        <VideoDispatchModal video={videoDispatch} onClose={() => setVideoDispatch(null)} />
      )}

      {/* Video signal dispatch modal */}
      {videoSignalDispatch && (
        <VideoSignalDispatchModal video={videoSignalDispatch} onClose={() => setVideoSignalDispatch(null)} />
      )}

      {/* Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">
                {editing ? t('tiktok.editTitle') : t('tiktok.createTitle')}
              </h2>
              <button onClick={closeModal} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-col gap-4 p-5 max-h-[80vh] overflow-y-auto">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('tiktok.fieldKeywords')}</label>
                <div className="flex gap-2">
                  <input type="text" value={keywordInput}
                    onChange={(e) => setKeywordInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword() } }}
                    placeholder={t('tiktok.keywordsPlaceholder')}
                    className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
                  <Button type="button" size="sm" variant="outline" onClick={addKeyword}><Plus className="size-4" /></Button>
                </div>
                {form.keywords.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {form.keywords.map((kw) => (
                      <span key={kw} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                        {kw}
                        <button type="button" onClick={() => removeKeyword(kw)} className="text-muted-foreground hover:text-foreground">
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('tiktok.fieldVideoUrl')}</label>
                <input type="url" value={form.video_url ?? ''} onChange={(e) => setForm((p) => ({ ...p, video_url: e.target.value }))}
                  placeholder={t('tiktok.videoUrlPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('tiktok.fieldCaption')}</label>
                <textarea rows={2} value={form.caption ?? ''} onChange={(e) => setForm((p) => ({ ...p, caption: e.target.value.trim() || null }))}
                  placeholder={t('tiktok.captionPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('tiktok.fieldContent')}</label>
                <textarea rows={3} value={form.content ?? ''} onChange={(e) => setForm((p) => ({ ...p, content: e.target.value }))}
                  placeholder={t('tiktok.contentPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('tiktok.fieldStatus')}</label>
                <select value={form.status ?? 'pending'} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value as TiktokVideoStatus }))}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('tiktok.fieldTeamId')}</label>
                <input type="number" value={form.team_id ?? ''}
                  onChange={(e) => setForm((p) => ({ ...p, team_id: e.target.value ? Number(e.target.value) : null }))}
                  placeholder={t('tiktok.teamIdPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
              </div>
              {formError && <p className="text-xs text-destructive">{formError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={closeModal}>{t('common.cancel')}</Button>
                <Button onClick={handleSubmit} disabled={isPending}>
                  {isPending ? (editing ? t('common.saving') : t('common.creating')) : (editing ? t('common.save') : t('common.create'))}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Dispatch Tasks Modal ─────────────────────────────────────────────────────

const DEFAULT_TASK_TEMPLATE = 'mở tiktok, tìm video với keyword {keyword} rồi lưu link lại'
const KEYWORD_PLACEHOLDER_RE = /\{keyword\}/g

interface DispatchTasksModalProps {
  list: KeywordList
  onClose: () => void
}

function DispatchTasksModal({ list, onClose }: DispatchTasksModalProps) {
  const { t } = useTranslation()
  const { showToast } = useToast()
  const qc = useQueryClient()

  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [taskTemplate, setTaskTemplate] = useState(DEFAULT_TASK_TEMPLATE)
  const [sending, setSending] = useState(false)

  const { data: groups = [], isLoading: groupsLoading } = useQuery<AgentGroup[]>({
    queryKey: ['agent-groups'],
    queryFn: agentGroupsApi.list,
  })

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null

  // Keywords that haven't been dispatched yet
  const dispatchedSet = useMemo(
    () => new Set(list.dispatched_keywords ?? []),
    [list.dispatched_keywords],
  )
  const unsentKeywords = useMemo(
    () => list.keywords.filter((kw) => !dispatchedSet.has(kw)),
    [list.keywords, dispatchedSet],
  )

  // Build preview: limit to first N unsent keywords (N = device count), one per device
  const preview = useMemo(() => {
    if (!selectedGroup || selectedGroup.members.length === 0) return []
    const candidates = unsentKeywords.slice(0, selectedGroup.members.length)
    return candidates.map((kw, idx) => {
      const member = selectedGroup.members[idx]
      const taskMsg = taskTemplate.replace(KEYWORD_PLACEHOLDER_RE, kw)
      return { keyword: kw, deviceId: member.device, deviceName: member.device_name, taskMsg }
    })
  }, [unsentKeywords, selectedGroup, taskTemplate])

  const keywordsLimitedWarning =
    selectedGroup &&
    selectedGroup.members.length > 0 &&
    unsentKeywords.length > selectedGroup.members.length

  async function handleSend() {
    if (!selectedGroup) return
    if (preview.length === 0) return
    setSending(true)
    let successCount = 0
    let failCount = 0
    const sentKeywords: string[] = []
    for (const item of preview) {
      try {
        const task = await tasksApi.create({
          name: `TikTok: ${item.keyword}`,
          description: item.taskMsg,
          task_type: 'generic',
          status: 'pending',
          payload: { keyword: item.keyword, source: 'tiktok-keyword-list', list_id: list.id, agent: 'tiktok' },
        })
        await tasksApi.run(task.id, [item.deviceId])
        sentKeywords.push(item.keyword)
        successCount++
      } catch (err) {
        console.error(`Failed to dispatch task for keyword "${item.keyword}":`, err)
        failCount++
      }
    }
    // Mark successfully dispatched keywords on the list
    if (sentKeywords.length > 0) {
      try {
        await keywordListsApi.update(list.id, {
          dispatched_keywords: [...(list.dispatched_keywords ?? []), ...sentKeywords],
        })
        qc.invalidateQueries({ queryKey: ['tiktok-keyword-lists'] })
      } catch (err) {
        console.error('Failed to update dispatched_keywords:', err)
      }
    }
    setSending(false)
    if (failCount === 0) {
      showToast(t('tiktok.dispatchSuccess', { count: successCount }), 'success')
      onClose()
    } else {
      showToast(t('tiktok.dispatchPartial', { success: successCount, fail: failCount }), 'error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
          <div>
            <h2 className="text-base font-semibold">{t('tiktok.dispatchTitle')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('tiktok.dispatchSubtitle', { name: list.name, count: list.keywords.length })}
              {dispatchedSet.size > 0 && (
                <span className="ml-1.5 text-green-600 dark:text-green-400">
                  · {t('tiktok.dispatchAlreadySent', { count: dispatchedSet.size })}
                </span>
              )}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-5 p-5 overflow-y-auto flex-1">
          {/* Select agent group */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t('tiktok.dispatchSelectGroup')}</label>
            {groupsLoading ? (
              <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
            ) : (
              <select
                value={selectedGroupId ?? ''}
                onChange={(e) => setSelectedGroupId(e.target.value ? Number(e.target.value) : null)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">{t('tiktok.dispatchGroupPlaceholder')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.member_count} {t('tiktok.dispatchMembers')})
                  </option>
                ))}
              </select>
            )}
            {selectedGroup && (
              <p className="text-xs text-muted-foreground">
                {t('tiktok.dispatchGroupDevices', { count: selectedGroup.members.length })}
              </p>
            )}
          </div>

          {/* Warning: more unsent keywords than devices */}
          {keywordsLimitedWarning && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {t('tiktok.dispatchKeywordsLimited', {
                  total: unsentKeywords.length,
                  devices: selectedGroup?.members.length,
                })}
              </span>
            </div>
          )}

          {/* No unsent keywords */}
          {selectedGroup && selectedGroup.members.length > 0 && unsentKeywords.length === 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-4 py-3 text-xs text-green-700 dark:text-green-400">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>{t('tiktok.dispatchAllSent')}</span>
            </div>
          )}

          {/* Task template */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('tiktok.dispatchTemplate')}</label>
              <button
                type="button"
                onClick={() => setTaskTemplate(DEFAULT_TASK_TEMPLATE)}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-primary hover:bg-primary/10"
              >
                <Wand2 className="size-3" />
                {t('tiktok.dispatchFillTemplate')}
              </button>
            </div>
            <textarea
              rows={3}
              value={taskTemplate}
              onChange={(e) => setTaskTemplate(e.target.value)}
              placeholder={t('tiktok.dispatchTemplatePlaceholder')}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none font-mono"
            />
            <p className="text-xs text-muted-foreground">{t('tiktok.dispatchTemplateHint')}</p>
          </div>

          {/* Task preview */}
          {selectedGroup && preview.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('tiktok.dispatchPreviewTitle', { count: preview.length })}</h3>
              <div className="rounded-xl border border-border bg-card overflow-x-auto max-h-64">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground text-xs">{t('tiktok.dispatchColKeyword')}</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground text-xs">{t('tiktok.dispatchColDevice')}</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground text-xs">{t('tiktok.dispatchColTask')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {preview.map((item, idx) => (
                      <tr key={`${item.keyword}-${idx}`} className="hover:bg-muted/30 transition-colors">
                        <td className="px-3 py-2">
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary">
                            {item.keyword}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{item.deviceName}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate">{item.taskMsg}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {selectedGroup && selectedGroup.members.length === 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>{t('tiktok.dispatchNoMembers')}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-4 shrink-0">
          <p className="text-xs text-muted-foreground">
            {selectedGroup && preview.length > 0
              ? t('tiktok.dispatchSummary', { tasks: preview.length, devices: selectedGroup.members.length })
              : t('tiktok.dispatchSummaryEmpty')}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={sending}>{t('common.cancel')}</Button>
            <Button
              onClick={handleSend}
              disabled={!selectedGroup || preview.length === 0 || sending}
            >
              <Send className="mr-1.5 size-3.5" />
              {sending ? t('tiktok.dispatchSending') : t('tiktok.dispatchSend', { count: preview.length })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}


// ─── Video Dispatch Modal ─────────────────────────────────────────────────────

// Default template is provided via i18n key 'tiktok.videoDispatchTemplateDefault'
const VIDEO_URL_RE = /\{video_url\}/g
const VIDEO_CAPTION_RE = /\{caption\}/g
const VIDEO_CONTENT_RE = /\{content\}/g

interface VideoDispatchModalProps {
  video: TiktokVideo
  onClose: () => void
}

function VideoDispatchModal({ video, onClose }: VideoDispatchModalProps) {
  const { t } = useTranslation()
  const { showToast } = useToast()

  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [taskTemplate, setTaskTemplate] = useState(() => t('tiktok.videoDispatchTemplateDefault'))
  const [commentContent, setCommentContent] = useState('')
  const [generatingComment, setGeneratingComment] = useState(false)
  const [sending, setSending] = useState(false)

  const { data: groups = [], isLoading: groupsLoading } = useQuery<AgentGroup[]>({
    queryKey: ['agent-groups'],
    queryFn: agentGroupsApi.list,
  })

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null

  const preview = useMemo(() => {
    if (!selectedGroup || selectedGroup.members.length === 0) return []
    const msg = taskTemplate
      .replace(VIDEO_URL_RE, video.video_url ?? '')
      .replace(VIDEO_CAPTION_RE, video.caption ?? '')
      .replace(VIDEO_CONTENT_RE, video.content ?? '')
    return selectedGroup.members.map((member) => ({
      deviceId: member.device,
      deviceName: member.device_name,
      taskMsg: msg,
    }))
  }, [selectedGroup, taskTemplate, video])

  async function handleGenerateComment() {
    setGeneratingComment(true)
    try {
      const result = await tiktokApi.generateComment(
        [video.caption, video.content].filter(Boolean).join('\n'),
        video.existing_comments ?? [],
      )
      setCommentContent(result.comment)
    } catch (err) {
      showToast(t('tiktok.videoDispatchCommentGenerateError'), 'error')
      console.error('Failed to generate comment:', err)
    } finally {
      setGeneratingComment(false)
    }
  }

  async function handleSend() {
    if (!selectedGroup || preview.length === 0) return
    setSending(true)
    let successCount = 0
    let failCount = 0
    for (const item of preview) {
      try {
        const task = await tasksApi.create({
          name: t('tiktok.videoDispatchTaskName', { url: video.video_url ?? `#${video.id}` }),
          description: item.taskMsg,
          task_type: 'generic',
          status: 'pending',
          payload: {
            video_id: video.id,
            video_url: video.video_url,
            video_link: video.video_url,
            keywords: video.keywords,
            source: 'tiktok-video',
            comment_content: commentContent,
          },
        })
        await tasksApi.run(task.id, [item.deviceId])
        successCount++
      } catch (err) {
        console.error(`Failed to dispatch task for device ${item.deviceId}:`, err)
        failCount++
      }
    }
    setSending(false)
    if (failCount === 0) {
      showToast(t('tiktok.videoDispatchSuccess', { count: successCount }), 'success')
      onClose()
    } else {
      showToast(t('tiktok.videoDispatchPartial', { success: successCount, fail: failCount }), 'error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
          <div className="min-w-0 flex-1 pr-4">
            <h2 className="text-base font-semibold">{t('tiktok.videoDispatchTitle')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {t('tiktok.videoDispatchSubtitle', { url: video.video_url ?? `#${video.id}` })}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted shrink-0">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-5 p-5 overflow-y-auto flex-1">
          {/* Select agent group */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t('tiktok.dispatchSelectGroup')}</label>
            {groupsLoading ? (
              <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
            ) : (
              <select
                value={selectedGroupId ?? ''}
                onChange={(e) => setSelectedGroupId(e.target.value ? Number(e.target.value) : null)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">{t('tiktok.dispatchGroupPlaceholder')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.member_count} {t('tiktok.dispatchMembers')})
                  </option>
                ))}
              </select>
            )}
            {selectedGroup && (
              <p className="text-xs text-muted-foreground">
                {t('tiktok.dispatchGroupDevices', { count: selectedGroup.members.length })}
              </p>
            )}
          </div>

          {selectedGroup && selectedGroup.members.length === 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>{t('tiktok.videoDispatchNoMembers')}</span>
            </div>
          )}

          {/* Task template */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('tiktok.videoDispatchTemplate')}</label>
              <button
                type="button"
                onClick={() => setTaskTemplate(t('tiktok.videoDispatchTemplateDefault'))}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-primary hover:bg-primary/10"
              >
                <Wand2 className="size-3" />
                {t('tiktok.videoDispatchFillTemplate')}
              </button>
            </div>
            <textarea
              rows={3}
              value={taskTemplate}
              onChange={(e) => setTaskTemplate(e.target.value)}
              placeholder={t('tiktok.videoDispatchTemplate')}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none font-mono"
            />
            <p className="text-xs text-muted-foreground">{t('tiktok.videoDispatchTemplateHint')}</p>
          </div>

          {/* Comment content */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('tiktok.videoDispatchCommentContent')}</label>
              <button
                type="button"
                onClick={handleGenerateComment}
                disabled={generatingComment}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                <Wand2 className="size-3" />
                {generatingComment ? t('tiktok.videoDispatchCommentGenerating') : t('tiktok.videoDispatchFillComment')}
              </button>
            </div>
            <textarea
              rows={2}
              value={commentContent}
              onChange={(e) => setCommentContent(e.target.value)}
              placeholder={t('tiktok.videoDispatchCommentContentPlaceholder')}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>

          {/* Task preview */}
          {selectedGroup && preview.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('tiktok.videoDispatchPreviewTitle', { count: preview.length })}</h3>
              <div className="rounded-xl border border-border bg-card overflow-x-auto max-h-64">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground text-xs">{t('tiktok.videoDispatchColDevice')}</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground text-xs">{t('tiktok.videoDispatchColTask')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {preview.map((item, idx) => (
                      <tr key={`${item.deviceId}-${idx}`} className="hover:bg-muted/30 transition-colors">
                        <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{item.deviceName}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate">{item.taskMsg}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-4 shrink-0">
          <p className="text-xs text-muted-foreground">
            {selectedGroup && preview.length > 0
              ? t('tiktok.videoDispatchSummary', { count: preview.length, devices: selectedGroup.members.length })
              : t('tiktok.videoDispatchSummaryEmpty')}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={sending}>{t('common.cancel')}</Button>
            <Button
              onClick={handleSend}
              disabled={!selectedGroup || preview.length === 0 || sending}
            >
              <Send className="mr-1.5 size-3.5" />
              {sending ? t('tiktok.videoDispatchSending') : t('tiktok.videoDispatchSend', { count: preview.length })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Video Signal Dispatch Modal ──────────────────────────────────────────────

interface VideoSignalDispatchModalProps {
  video: TiktokVideo
  onClose: () => void
}

function VideoSignalDispatchModal({ video, onClose }: VideoSignalDispatchModalProps) {
  const { t } = useTranslation()
  const { showToast } = useToast()

  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)

  const { data: groups = [], isLoading: groupsLoading } = useQuery<AgentGroup[]>({
    queryKey: ['agent-groups'],
    queryFn: agentGroupsApi.list,
  })

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null

  async function handleSend() {
    if (!selectedGroup || selectedGroup.members.length === 0) return
    setSending(true)
    try {
      const result = await tiktokApi.dispatchSingleComment(video.id, {
        video_url: video.video_url ?? '',
        content: video.content ?? '',
        keywords: video.keywords ?? [],
        agent_group: selectedGroup.id,
        devices: selectedGroup.members.map((m) => m.device),
      })
      const commentPlansCount = result.comment_plans?.length ?? 0
      showToast(
        commentPlansCount > 0
          ? t('tiktok.videoSignalDispatchSuccess', { count: commentPlansCount })
          : t('tiktok.videoSignalDispatchSuccessEmpty'),
        'success',
      )
      onClose()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('tiktok.videoSignalDispatchError'), 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
          <div className="min-w-0 flex-1 pr-4">
            <h2 className="text-base font-semibold">{t('tiktok.videoSignalDispatchTitle')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {t('tiktok.videoDispatchSubtitle', { url: video.video_url ?? `#${video.id}` })}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted shrink-0">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-5">
          {/* Select agent group */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t('tiktok.dispatchSelectGroup')}</label>
            {groupsLoading ? (
              <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
            ) : (
              <select
                value={selectedGroupId ?? ''}
                onChange={(e) => setSelectedGroupId(e.target.value ? Number(e.target.value) : null)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">{t('tiktok.dispatchGroupPlaceholder')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.member_count} {t('tiktok.dispatchMembers')})
                  </option>
                ))}
              </select>
            )}
            {selectedGroup && (
              <p className="text-xs text-muted-foreground">
                {t('tiktok.dispatchGroupDevices', { count: selectedGroup.members.length })}
              </p>
            )}
          </div>

          {selectedGroup && selectedGroup.members.length === 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>{t('tiktok.videoDispatchNoMembers')}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4 shrink-0">
          <Button variant="outline" onClick={onClose} disabled={sending}>{t('common.cancel')}</Button>
          <Button
            onClick={handleSend}
            disabled={!selectedGroup || selectedGroup.members.length === 0 || sending}
          >
            <Send className="mr-1.5 size-3.5" />
            {sending ? t('tiktok.videoSignalDispatchSending') : t('tiktok.videoSignalDispatchSend')}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface KeywordVideoSearchModalProps {
  list: KeywordList
  keyword: string
  onClose: () => void
  onSaved: () => void
}

function KeywordVideoSearchModal({ list, keyword, onClose, onSaved }: KeywordVideoSearchModalProps) {
  const { t } = useTranslation()
  const { showToast } = useToast()

  const [searchKeyword, setSearchKeyword] = useState(keyword)
  // Start empty so opening the modal does NOT auto-fire the (slow, external) search.
  // User must explicitly press the Search button to begin.
  const [submittedKeyword, setSubmittedKeyword] = useState('')
  const [saving, setSaving] = useState(false)
  const [removedVideoIds, setRemovedVideoIds] = useState<string[]>([])

  const {
    data: searchResult,
    isLoading: searching,
    isFetching: searchingNext,
    error: searchError,
  } = useQuery({
    queryKey: ['tiktok-keyword-search-videos', list.id, submittedKeyword],
    queryFn: () =>
      keywordListsApi.searchVideos(list.id, {
        keyword: submittedKeyword,
        count: 20,
        cursor: 0,
        num_sessions: 1,
      }),
    enabled: submittedKeyword.length > 0,
    // The TikTok search is an expensive external call. Preserve the result
    // once fetched and only re-run when the user explicitly presses the
    // Search button (which mutates `submittedKeyword` → new queryKey).
    // Without these flags, switching browser tabs/apps and returning would
    // refire the query on window focus and blank the UI with a loading state.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  })

  const videos = searchResult?.videos
  const filteredVideos = useMemo(
    () => (videos ?? []).filter((video) => !removedVideoIds.includes(video.video_id)),
    [videos, removedVideoIds],
  )
  const totalCount = searchResult?.count ?? 0
  const partial = Boolean(searchResult?.partial)
  const searchingNow = searching || searchingNext
  const errorMessage = searchError instanceof Error ? searchError.message : ''

  function handleRemoveVideo(videoId: string) {
    setRemovedVideoIds((prev) => (prev.includes(videoId) ? prev : [...prev, videoId]))
  }

  async function handleSaveAll() {
    const kw = searchKeyword.trim()
    if (!kw || filteredVideos.length === 0) return
    setSaving(true)
    try {
      const result = await keywordListsApi.saveSearchVideos(list.id, { keyword: kw, videos: filteredVideos })
      showToast(
        t('tiktok.kwSearchSaveSuccess', {
          saved: result.saved,
          existing: result.existing,
          total: result.total,
        }),
        'success',
      )
      onSaved()
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast(msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-5xl rounded-xl border border-border bg-card shadow-xl flex max-h-[90vh] flex-col">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t('tiktok.kwSearchModalTitle')}</h2>
            <p className="text-xs text-muted-foreground truncate">
              {t('tiktok.kwSearchModalSubtitle', { list: list.name })}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-5 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const kw = searchKeyword.trim()
                  if (kw) {
                    setRemovedVideoIds([])
                    setSubmittedKeyword(kw)
                  }
                }
              }}
              placeholder={t('tiktok.kwSearchModalKeywordPlaceholder')}
              className="min-w-[220px] flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
            <Button
              size="sm"
              onClick={() => {
                const kw = searchKeyword.trim()
                if (kw) {
                  setRemovedVideoIds([])
                  setSubmittedKeyword(kw)
                }
              }}
              disabled={searchingNow}
            >
              <Search className="mr-1.5 size-3.5" />
              {searchingNow ? t('tiktok.kwSearchModalSearching') : t('tiktok.kwSearchModalSearchBtn')}
            </Button>
          </div>

          {submittedKeyword.length > 0 && (
            <div className="text-xs text-muted-foreground">
              {t('tiktok.kwSearchModalResultMeta', { shown: filteredVideos.length, total: totalCount })}
              {partial ? ` · ${t('tiktok.kwSearchModalPartial')}` : ''}
            </div>
          )}

          {errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}

          <div className="rounded-xl border border-border bg-card overflow-x-auto">
            {searchingNow ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 px-4">
                <Loader2 className="size-6 animate-spin text-muted-foreground/60" />
                <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
                <p className="text-xs text-muted-foreground/70 text-center max-w-md">
                  {t('tiktok.kwSearchModalSearchingHint')}
                </p>
              </div>
            ) : submittedKeyword.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 px-4">
                <Search className="size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground text-center max-w-md">
                  {t('tiktok.kwSearchModalIdle')}
                </p>
              </div>
            ) : filteredVideos.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10">
                <Search className="size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">{t('tiktok.kwSearchModalEmpty')}</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwSearchModalColVideo')}</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwSearchModalColAuthor')}</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwSearchModalColDesc')}</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwSearchModalColViews')}</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwSearchModalColStatus')}</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwSearchModalColActions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredVideos.map((video) => (
                    <tr key={video.video_id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5 max-w-[220px]">
                        <a
                          href={video.video_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="size-3 shrink-0" />
                          <span className="truncate">{video.video_url}</span>
                        </a>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{video.author?.nickname || video.author?.unique_id || '—'}</td>
                      <td className="px-4 py-2.5 max-w-[380px] text-xs text-muted-foreground">
                        <span className="line-clamp-2">{video.desc || '—'}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">{video.stats?.playCount || '—'}</td>
                      <td className="px-4 py-2.5">
                        {video.is_existing ? (
                          <span className="rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
                            {t('tiktok.kwSearchModalStatusExisting')}
                          </span>
                        ) : (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                            {t('tiktok.kwSearchModalStatusNew')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRemoveVideo(video.video_id)}
                        >
                          <Trash2 className="mr-1.5 size-3.5" />
                          {t('common.delete')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border px-5 py-4">
          <p className="text-xs text-muted-foreground">{t('tiktok.kwSearchModalSaveHint')}</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
            <Button onClick={handleSaveAll} disabled={saving || searchingNow || filteredVideos.length === 0}>
              <Save className="mr-1.5 size-3.5" />
              {saving ? t('common.saving') : t('tiktok.kwSearchModalSaveAll')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Keywords Tab ─────────────────────────────────────────────────────────────

function KeywordsTab({ statusLabel }: { statusLabel: (s: TiktokVideoStatus) => string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()

  // ── AI Generator state ──────────────────────────────────────────────────────
  const [genTopic, setGenTopic] = useState('')
  const [genCount, setGenCount] = useState(20)
  const [genLoading, setGenLoading] = useState(false)
  const [genError, setGenError] = useState('')
  const [generatedKws, setGeneratedKws] = useState<string[]>([])

  // Save-list modal state
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [listName, setListName] = useState('')
  const [saveError, setSaveError] = useState('')

  // ── Saved lists state ───────────────────────────────────────────────────────
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [search, setSearch] = useState('')

  // ── Dispatch tasks modal state ───────────────────────────────────────────────
  const [dispatchList, setDispatchList] = useState<KeywordList | null>(null)
  const [searchModal, setSearchModal] = useState<{ list: KeywordList; keyword: string } | null>(null)

  // ── Scan dispatched keywords state ───────────────────────────────────────────
  const [scanning, setScanning] = useState(false)

  // ── Search keywords state ──────────────────────────────────────────────────────
  const [searchKeywordsModalOpen, setSearchKeywordsModalOpen] = useState(false)
  const [searchKeywordsInput, setSearchKeywordsInput] = useState('')
  const [searchKeywordsLoading, setSearchKeywordsLoading] = useState(false)
  const [searchKeywordsError, setSearchKeywordsError] = useState('')
  const [searchKeywordsResults, setSearchKeywordsResults] = useState<string[]>([])
  const [searchKeywordsForList, setSearchKeywordsForList] = useState<KeywordList | null>(null)

  async function handleSearchKeywords() {
    const input = searchKeywordsInput.trim()
    if (!input) {
      setSearchKeywordsError(t('tiktok.kwSearchKeywordsEmpty'))
      return
    }

    setSearchKeywordsError('')
    setSearchKeywordsLoading(true)
    try {
      const keywords = input.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      if (keywords.length === 0) {
        setSearchKeywordsError(t('tiktok.kwSearchKeywordsEmpty'))
        setSearchKeywordsLoading(false)
        return
      }

      const res = await keywordListsApi.searchKeywords(keywords)
      const resultKeywords: string[] = []
      for (const item of res.keywords ?? []) {
        if (typeof item === 'string') {
          const value = item.trim()
          if (value) resultKeywords.push(value)
          continue
        }
        if (!item || typeof item !== 'object') continue

        if (typeof item.keyword === 'string' && item.keyword.trim()) {
          resultKeywords.push(item.keyword.trim())
        }

        if (Array.isArray(item.keywords)) {
          for (const nested of item.keywords) {
            if (typeof nested === 'string' && nested.trim()) {
              resultKeywords.push(nested.trim())
            }
          }
        }
      }

      const seen = new Set<string>()
      const normalizedKeywords = resultKeywords.filter((kw) => {
        const lowered = kw.toLowerCase()
        if (seen.has(lowered)) return false
        seen.add(lowered)
        return true
      })
      
      // Filter out duplicates from current list
      const existingLower = new Set((searchKeywordsForList?.keywords ?? []).map((k) => k.toLowerCase()))
      const newKeywords = normalizedKeywords.filter((kw) => !existingLower.has(kw.toLowerCase()))
      
      setSearchKeywordsResults(newKeywords)
      if (newKeywords.length === 0) {
        showToast(t('tiktok.kwSearchKeywordsNoDuplicates'), 'info')
      } else {
        showToast(t('tiktok.kwSearchKeywordsFound', { count: newKeywords.length }), 'success')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setSearchKeywordsError(msg)
      showToast(msg, 'error')
    } finally {
      setSearchKeywordsLoading(false)
    }
  }

  function handleAddSearchResults() {
    if (!searchKeywordsForList) return
    
    // Add new keywords to the list
    const existingLower = new Set((searchKeywordsForList.keywords ?? []).map((k) => k.toLowerCase()))
    const newKeywords = searchKeywordsResults.filter((kw) => !existingLower.has(kw.toLowerCase()))
    
    if (newKeywords.length > 0) {
      keywordListsApi.update(searchKeywordsForList.id, {
        keywords: [...(searchKeywordsForList.keywords ?? []), ...newKeywords],
      }).then(() => {
        qc.invalidateQueries({ queryKey: ['tiktok-keyword-lists'] })
        showToast(t('tiktok.kwSearchKeywordsAdded', { count: newKeywords.length }), 'success')
        setSearchKeywordsModalOpen(false)
        setSearchKeywordsInput('')
        setSearchKeywordsResults([])
        setSearchKeywordsForList(null)
      }).catch((err) => {
        showToast(err instanceof Error ? err.message : t('tiktok.kwSearchKeywordsAddError'), 'error')
      })
    }
  }

  function handleOpenSearchKeywordsModal(list: KeywordList) {
    setSearchKeywordsForList(list)
    setSearchKeywordsModalOpen(true)
    setSearchKeywordsError('')
    setSearchKeywordsInput('')
    setSearchKeywordsResults([])
  }

  async function handleScanDispatched() {
    setScanning(true)
    try {
      const res = await keywordListsApi.scanDispatched()
      qc.invalidateQueries({ queryKey: ['tiktok-keyword-lists'] })
      if (res.keywords_removed > 0) {
        showToast(t('tiktok.kwScanSuccess', { removed: res.keywords_removed, lists: res.detail.length }), 'success')
      } else {
        showToast(t('tiktok.kwScanNothingRemoved'), 'success')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast(msg, 'error')
    } finally {
      setScanning(false)
    }
  }

  // ── Video keyword stats state ───────────────────────────────────────────────
  const [kwSearch, setKwSearch] = useState('')

  // ── Queries & mutations ─────────────────────────────────────────────────────
  const { data: videos = [], isLoading: videosLoading } = useQuery<TiktokVideo[]>({
    queryKey: ['tiktok'],
    queryFn: () => tiktokApi.list(),
  })

  const { data: savedLists = [], isLoading: listsLoading, refetch: refetchLists } = useQuery<KeywordList[]>({
    queryKey: ['tiktok-keyword-lists'],
    queryFn: () => keywordListsApi.list(),
  })

  const createListMutation = useMutation({
    mutationFn: keywordListsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tiktok-keyword-lists'] })
      setSaveModalOpen(false)
      setListName('')
      setSaveError('')
      showToast(t('tiktok.kwListSaved'), 'success')
    },
    onError: (err: Error) => setSaveError(err.message),
  })

  const deleteListMutation = useMutation({
    mutationFn: keywordListsApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tiktok-keyword-lists'] })
      showToast(t('tiktok.kwListDeleted'), 'success')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  // ── Generator handlers ──────────────────────────────────────────────────────
  async function handleGenerate() {
    const topic = genTopic.trim()
    if (!topic) { setGenError(t('tiktok.kwGenTopicRequired')); return }
    setGenError('')
    setGenLoading(true)
    try {
      const res = await keywordListsApi.generate(topic, genCount, generatedKws)
      setGeneratedKws((prev) => {
        const existingLower = new Set(prev.map((k) => k.toLowerCase()))
        const newKws = res.keywords.filter((k) => !existingLower.has(k.toLowerCase()))
        return [...prev, ...newKws]
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setGenError(msg)
      showToast(msg, 'error')
    } finally {
      setGenLoading(false)
    }
  }

  function removeGenKw(kw: string) {
    setGeneratedKws((prev) => prev.filter((k) => k !== kw))
  }

  function handleSaveList() {
    const name = listName.trim()
    if (!name) { setSaveError(t('tiktok.kwListNameRequired')); return }
    if (generatedKws.length === 0) { setSaveError(t('tiktok.kwListEmpty')); return }
    createListMutation.mutate({ name, topic: genTopic.trim(), keywords: generatedKws })
  }

  // ── Video keyword stats ─────────────────────────────────────────────────────
  const keywordStats = useMemo(() => {
    const map = new Map<string, { count: number; statuses: TiktokVideoStatus[] }>()
    for (const v of videos) {
      for (const kw of v.keywords) {
        const entry = map.get(kw) ?? { count: 0, statuses: [] }
        entry.count += 1
        entry.statuses.push(v.status)
        map.set(kw, entry)
      }
    }
    return Array.from(map.entries())
      .map(([kw, { count, statuses }]) => {
        const freq: Record<string, number> = {}
        for (const s of statuses) freq[s] = (freq[s] ?? 0) + 1
        const topStatus = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] as TiktokVideoStatus | undefined
        return { kw, count, topStatus }
      })
      .sort((a, b) => b.count - a.count)
  }, [videos])

  const filteredStats = useMemo(() =>
    keywordStats.filter((r) => r.kw.toLowerCase().includes(kwSearch.toLowerCase())),
    [keywordStats, kwSearch])

  const filteredLists = useMemo(() =>
    savedLists.filter(
      (l) =>
        l.name.toLowerCase().includes(search.toLowerCase()) ||
        l.topic.toLowerCase().includes(search.toLowerCase()),
    ),
    [savedLists, search])

  const mostUsed = keywordStats[0]?.kw ?? '—'

  return (
    <div className="flex flex-col gap-6">
      {/* ── AI Generator ──────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">{t('tiktok.kwGenTitle')}</h3>
        </div>

        {/* Inputs */}
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            value={genTopic}
            onChange={(e) => setGenTopic(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleGenerate() } }}
            placeholder={t('tiktok.kwGenTopicPlaceholder')}
            className="flex-1 min-w-[180px] rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground shrink-0">{t('tiktok.kwGenCount')}</label>
            <input
              type="number"
              min={1}
              max={100}
              value={genCount}
              onChange={(e) => setGenCount(Math.max(1, Math.min(100, Number(e.target.value))))}
              className="w-20 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <Button onClick={handleGenerate} disabled={genLoading} size="sm">
            <Sparkles className="mr-1.5 size-3.5" />
            {genLoading ? t('tiktok.kwGenGenerating') : t('tiktok.kwGenGenerate')}
          </Button>
          <Button onClick={() => { setSearchKeywordsModalOpen(true); setSearchKeywordsError(''); setSearchKeywordsInput(''); setSearchKeywordsResults([]) }} variant="outline" size="sm">
            <Search className="mr-1.5 size-3.5" />
            {t('tiktok.kwSearchKeywords')}
          </Button>
        </div>

        {genError && <p className="text-xs text-destructive">{genError}</p>}

        {/* Generated keyword chips */}
        {generatedKws.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {generatedKws.map((kw) => (
                <span key={kw} className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  {kw}
                  <button type="button" onClick={() => removeGenKw(kw)} className="text-primary/60 hover:text-primary">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{generatedKws.length} {t('tiktok.kwGenChipsCount')}</span>
              <button
                type="button"
                onClick={() => setGeneratedKws([])}
                className="text-xs text-muted-foreground hover:text-destructive"
              >
                {t('tiktok.kwGenClearAll')}
              </button>
              <div className="flex-1" />
              <Button size="sm" variant="outline" onClick={() => { setSaveModalOpen(true); setSaveError('') }}>
                <Save className="mr-1.5 size-3.5" />
                {t('tiktok.kwGenSaveList')}
              </Button>
            </div>
          </div>
        )}

        {generatedKws.length === 0 && !genLoading && (
          <div className="flex items-start gap-2 rounded-lg bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>{t('tiktok.kwGenHint')}</span>
          </div>
        )}
      </div>

      {/* ── Saved Keyword Lists ────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('tiktok.kwSavedTitle')}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('tiktok.kwSavedSearch')}
                className="w-36 rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              onClick={() => refetchLists()}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
              aria-label={t('common.refresh')}
            >
              <RefreshCw className="size-3.5" />
            </button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleScanDispatched}
              disabled={scanning}
              title={t('tiktok.kwScanBtn')}
            >
              <ScanLine className="mr-1.5 size-3.5" />
              {scanning ? t('tiktok.kwScanScanning') : t('tiktok.kwScanBtn')}
            </Button>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          {listsLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : filteredLists.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12">
              <Hash className="size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('tiktok.kwSavedEmpty')}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwSavedColName')}</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwSavedColTopic')}</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwSavedColKeywords')}</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwSavedColTeam')}</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwSavedColCreated')}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredLists.map((list) => (
                  <>
                    <tr
                      key={list.id}
                      className="hover:bg-muted/30 transition-colors cursor-pointer"
                      onClick={() => setExpandedId(expandedId === list.id ? null : list.id)}
                    >
                      <td className="px-4 py-2.5 font-medium">{list.name}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-[160px] truncate">{list.topic || '—'}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            {list.keywords.length}
                          </span>
                          {(list.dispatched_keywords ?? []).length > 0 && (
                            <span className="rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
                              {t('tiktok.kwSentCount', { count: (list.dispatched_keywords ?? []).length })}
                            </span>
                          )}
                            {list.keywords.slice(0, 3).map((kw) => (
                            <button
                              key={kw}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setSearchModal({ list, keyword: kw })
                              }}
                              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary"
                            >
                              {kw}
                            </button>
                          ))}
                          {list.keywords.length > 3 && (
                            <span className="text-[10px] text-muted-foreground">+{list.keywords.length - 3}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{list.team_name ?? '—'}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(list.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' })}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); setDispatchList(list) }}
                            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                            aria-label={t('tiktok.dispatchOpen')}
                          >
                            <PlayCircle className="size-4" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleOpenSearchKeywordsModal(list) }}
                            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                            aria-label={t('tiktok.kwSearchListKeywords')}
                          >
                            <Search className="size-4" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setExpandedId(expandedId === list.id ? null : list.id) }}
                            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label={expandedId === list.id ? t('tiktok.kwCollapse') : t('tiktok.kwExpand')}
                          >
                            {expandedId === list.id ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (confirm(t('tiktok.kwListDeleteConfirm'))) deleteListMutation.mutate(list.id)
                            }}
                            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                            aria-label={t('tiktok.kwListDelete')}
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedId === list.id && (
                      <tr key={`${list.id}-expanded`}>
                        <td colSpan={6} className="bg-muted/20 px-4 py-3">
                          <div className="flex flex-wrap gap-1.5">
                            {list.keywords.map((kw) => {
                              const sent =
                                (list.dispatched_keywords ?? []).includes(kw) ||
                                (list.saved_keywords ?? []).includes(kw)
                              return (
                                <span
                                  key={kw}
                                  title={sent ? t('tiktok.kwStatusSent') : t('tiktok.kwStatusUnsent')}
                                  onClick={() => setSearchModal({ list, keyword: kw })}
                                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium cursor-pointer transition-colors ${
                                    sent
                                      ? 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/40'
                                      : 'bg-primary/10 text-primary hover:bg-primary/20'
                                  }`}
                                >
                                  {kw}
                                </span>
                              )
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Video keyword stats ────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{t('tiktok.kwStatsTitle')}</h3>

        {/* Summary cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-card px-5 py-4">
            <p className="text-xs text-muted-foreground">{t('tiktok.kwTotalUnique')}</p>
            <p className="mt-1 text-2xl font-semibold">{videosLoading ? '—' : keywordStats.length}</p>
          </div>
          <div className="rounded-xl border border-border bg-card px-5 py-4">
            <p className="text-xs text-muted-foreground">{t('tiktok.kwTotalVideos')}</p>
            <p className="mt-1 text-2xl font-semibold">{videosLoading ? '—' : videos.length}</p>
          </div>
          <div className="rounded-xl border border-border bg-card px-5 py-4">
            <p className="text-xs text-muted-foreground">{t('tiktok.kwMostUsed')}</p>
            <p className="mt-1 text-2xl font-semibold truncate">{videosLoading ? '—' : mostUsed}</p>
          </div>
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            value={kwSearch}
            onChange={(e) => setKwSearch(e.target.value)}
            placeholder={t('tiktok.kwSearch')}
            className="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('tiktok.kwHint')}</span>
        </div>

        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          {videosLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : filteredStats.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16">
              <Hash className="size-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('tiktok.kwNoResults')}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwColKeyword')}</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwColVideos')}</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.kwColStatus')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredStats.map(({ kw, count, topStatus }) => (
                  <tr key={kw} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2.5">
                      <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{kw}</span>
                    </td>
                    <td className="px-4 py-2.5 text-sm tabular-nums">{count}</td>
                    <td className="px-4 py-2.5">
                      {topStatus
                        ? <StatusBadge status={topStatus} label={statusLabel(topStatus)} />
                        : <span className="text-muted-foreground/40">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Save List Modal ────────────────────────────────────────────────── */}
      {saveModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{t('tiktok.kwGenSaveModalTitle')}</h2>
              <button onClick={() => setSaveModalOpen(false)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-col gap-4 p-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('tiktok.kwGenSaveListName')}</label>
                <input
                  type="text"
                  value={listName}
                  onChange={(e) => setListName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveList() } }}
                  placeholder={t('tiktok.kwGenSaveListNamePlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  autoFocus
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {generatedKws.length} {t('tiktok.kwGenChipsCount')} · {t('tiktok.kwGenTopicLabel')}: {genTopic || '—'}
              </p>
              {saveError && <p className="text-xs text-destructive">{saveError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setSaveModalOpen(false)}>{t('common.cancel')}</Button>
                <Button onClick={handleSaveList} disabled={createListMutation.isPending}>
                  {createListMutation.isPending ? t('common.saving') : t('common.save')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Search Keywords Modal ───────────────────────────────────────────────── */}
      {searchKeywordsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold">{t('tiktok.kwSearchKeywordsTitle')}</h2>
                {searchKeywordsForList && (
                  <p className="text-xs text-muted-foreground mt-0.5">{t('tiktok.kwForList', { name: searchKeywordsForList.name })}</p>
                )}
              </div>
              <button onClick={() => { setSearchKeywordsModalOpen(false); setSearchKeywordsForList(null) }} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-col gap-4 p-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('tiktok.kwSearchKeywordsInput')}</label>
                <textarea
                  rows={4}
                  value={searchKeywordsInput}
                  onChange={(e) => setSearchKeywordsInput(e.target.value)}
                  placeholder={t('tiktok.kwSearchKeywordsInputPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none font-mono"
                />
                <p className="text-xs text-muted-foreground">{t('tiktok.kwSearchKeywordsInputHint')}</p>
              </div>
              {searchKeywordsError && <p className="text-xs text-destructive">{searchKeywordsError}</p>}
              {searchKeywordsResults.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{t('tiktok.kwSearchKeywordsResults', { count: searchKeywordsResults.length })}</p>
                  <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 max-h-48 overflow-y-auto">
                    <div className="flex flex-wrap gap-1">
                      {searchKeywordsResults.map((kw) => (
                        <span key={kw} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                          {kw}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setSearchKeywordsModalOpen(false); setSearchKeywordsForList(null) }} disabled={searchKeywordsLoading}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleSearchKeywords} disabled={searchKeywordsLoading}>
                  <Search className="mr-1.5 size-3.5" />
                  {searchKeywordsLoading ? t('tiktok.kwSearchKeywordsSearching') : t('tiktok.kwSearchKeywordsSearch')}
                </Button>
                {searchKeywordsResults.length > 0 && (
                  <Button onClick={() => {
                    if (searchKeywordsForList) {
                      handleAddSearchResults()
                    } else {
                      // Add to generated keywords (AI generator mode)
                      setGeneratedKws((prev) => {
                        const existingLower = new Set(prev.map((k) => k.toLowerCase()))
                        const newKws = searchKeywordsResults.filter((kw) => !existingLower.has(kw.toLowerCase()))
                        return [...prev, ...newKws]
                      })
                      setSearchKeywordsModalOpen(false)
                      setSearchKeywordsInput('')
                      setSearchKeywordsResults([])
                      showToast(t('tiktok.kwSearchKeywordsAdded', { count: searchKeywordsResults.length }), 'success')
                    }
                  }}>
                    <Plus className="mr-1.5 size-3.5" />
                    {t('tiktok.kwSearchKeywordsAdd')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Dispatch Tasks Modal ───────────────────────────────────────────── */}
      {dispatchList && (
        <DispatchTasksModal list={dispatchList} onClose={() => setDispatchList(null)} />
      )}

      {searchModal && (
        <KeywordVideoSearchModal
          list={searchModal.list}
          keyword={searchModal.keyword}
          onClose={() => setSearchModal(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['tiktok'] })
            qc.invalidateQueries({ queryKey: ['tiktok-keyword-lists'] })
          }}
        />
      )}
    </div>
  )
}

function StatsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [approvalStatus, setApprovalStatus] = useState<'approved' | 'pending' | 'all'>('all')
  const [approvingPlanId, setApprovingPlanId] = useState<number | null>(null)
  const [replayDispatchPlan, setReplayDispatchPlan] = useState<TiktokCommentPlan | null>(null)

  const { data: commentPlans = [], isLoading, refetch } = useQuery<TiktokCommentPlan[]>({
    queryKey: ['tiktok-approved-comments', dateFrom, dateTo, approvalStatus],
    queryFn: () => tiktokApi.listApprovedCommentPlans({
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      approval_status: approvalStatus,
    }),
  })

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' })
  }

  function statusLabel(plan: TiktokCommentPlan) {
    if (!plan.is_approved) return t('tiktok.commentPlanStatusPending')
    return plan.is_commented ? t('tiktok.commentPlanCommented') : t('tiktok.commentPlanApproved')
  }

  function resetFilters() {
    setDateFrom('')
    setDateTo('')
    setApprovalStatus('all')
  }

  async function handleApproveCommentPlan(plan: TiktokCommentPlan) {
    if (approvingPlanId !== null || plan.is_approved) return
    setApprovingPlanId(plan.id)
    try {
      await tiktokApi.updateCommentPlan(plan.video, plan.id, { is_approved: true })
      qc.invalidateQueries({ queryKey: ['tiktok-approved-comments'] })
      qc.invalidateQueries({ queryKey: ['tiktok-comment-plans', plan.video] })
      showToast(t('tiktok.commentPlanApproveSuccess'), 'success')
    } catch {
      showToast(t('tiktok.commentPlanApproveError'), 'error')
    } finally {
      setApprovingPlanId(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">{t('tiktok.filterFrom')}</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">{t('tiktok.filterTo')}</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">{t('tiktok.filterApprovalStatus')}</label>
            <select
              value={approvalStatus}
              onChange={(e) => setApprovalStatus(e.target.value as 'approved' | 'pending' | 'all')}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t('tiktok.filterApprovalAll')}</option>
              <option value="approved">{t('tiktok.filterApprovalApproved')}</option>
              <option value="pending">{t('tiktok.filterApprovalPending')}</option>
            </select>
          </div>
          {(dateFrom || dateTo || approvalStatus !== 'all') && (
            <button
              onClick={resetFilters}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
            >
              <X className="size-3" />{t('common.cancel')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
            aria-label={t('common.refresh')}
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : commentPlans.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8">
            <BarChart2 className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t('tiktok.commentPlanTableEmpty')}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colId')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colVideoUrl')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.commentPlanCommentContent')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.commentPlanProfile')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colStatus')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colCreated')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {commentPlans.map((plan) => (
                <tr key={plan.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 text-xs text-muted-foreground font-mono">{plan.id}</td>
                  <td className="px-4 py-2.5 max-w-[280px]">
                    {plan.video_link ? (
                      <a
                        href={plan.video_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{plan.video_link}</span>
                      </a>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2.5 max-w-[420px] text-xs text-muted-foreground">
                    <span className="line-clamp-2">{plan.comment_content || '—'}</span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                    {plan.profile_name || '—'}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${!plan.is_approved ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' : plan.is_commented ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'}`}>
                      {statusLabel(plan)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{formatDate(plan.created_at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      {!plan.is_approved && (
                        <button
                          onClick={() => handleApproveCommentPlan(plan)}
                          disabled={approvingPlanId === plan.id}
                          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {approvingPlanId === plan.id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="size-3" />
                          )}
                          <span>{t('tiktok.commentPlanApprove')}</span>
                        </button>
                      )}
                      <button
                        onClick={() => setReplayDispatchPlan(plan)}
                        aria-label={t('tiktok.commentReplayTitle')}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Send className="size-3" />
                        <span>{t('tiktok.commentReplayOpen')}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {replayDispatchPlan && (
        <CommentReplayDispatchModal plan={replayDispatchPlan} onClose={() => setReplayDispatchPlan(null)} />
      )}
    </div>
  )
}

interface CommentReplayDispatchModalProps {
  plan: TiktokCommentPlan
  onClose: () => void
  /** Called once the replay task has been dispatched successfully. */
  onDispatched?: () => void
}

function CommentReplayDispatchModal({ plan, onClose, onDispatched }: CommentReplayDispatchModalProps) {
  const { t } = useTranslation()
  const { showToast } = useToast()

  const [selectedProfileId, setSelectedProfileId] = useState<string>(plan.profile ? String(plan.profile) : '')
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(plan.device ? String(plan.device) : '')
  const [sending, setSending] = useState(false)

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ['profiles'],
    queryFn: profilesApi.list,
  })
  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list(),
  })
  const { data: videoCommentPlans = [] } = useQuery<TiktokCommentPlan[]>({
    queryKey: ['tiktok-comment-plans', plan.video],
    queryFn: () => tiktokApi.listCommentPlans(plan.video),
  })

  const tagName = useMemo(() => {
    const currentPlanProfileName = plan.profile_name || '—'
    const rootCommentContent = plan.reply_to.trim()
    if (!rootCommentContent) return currentPlanProfileName

    const currentPlanTime = new Date(plan.created_at).getTime()
    const matchingRootPlans = videoCommentPlans.filter((candidate) => (
      candidate.reply_to.trim() === ''
      && candidate.comment_content.trim() === rootCommentContent
    ))
    const closestPriorRootMatch = matchingRootPlans.reduce<{ plan: TiktokCommentPlan; timestamp: number } | null>((closestMatch, candidate) => {
      const candidateTime = new Date(candidate.created_at).getTime()
      if (candidateTime > currentPlanTime) return closestMatch
      return !closestMatch || candidateTime > closestMatch.timestamp
        ? { plan: candidate, timestamp: candidateTime }
        : closestMatch
    }, null)

    return closestPriorRootMatch?.plan.profile_name || currentPlanProfileName
  }, [plan.created_at, plan.profile_name, plan.reply_to, videoCommentPlans])
  const taskDescription = t('tiktok.commentReplayTaskTemplate', {
    videoLink: plan.video_link || '—',
    commentContent: plan.comment_content || '—',
    tagName,
  })

  function handleProfileChange(nextProfileId: string) {
    setSelectedProfileId(nextProfileId)
    if (!nextProfileId) {
      setSelectedDeviceId('')
      return
    }

    const selectedProfile = profiles.find((profile) => String(profile.id) === nextProfileId)
    if (selectedProfile?.device) {
      setSelectedDeviceId(String(selectedProfile.device))
      return
    }

    const linkedDevice = devices.find((device) => device.profiles.some((profile) => String(profile.id) === nextProfileId))
    setSelectedDeviceId(linkedDevice ? String(linkedDevice.id) : '')
  }

  function handleDeviceChange(nextDeviceId: string) {
    setSelectedDeviceId(nextDeviceId)
    if (!nextDeviceId) {
      setSelectedProfileId('')
      return
    }

    const selectedDevice = devices.find((device) => String(device.id) === nextDeviceId)
    if (!selectedDevice) {
      setSelectedProfileId('')
      return
    }

    const currentProfileIsLinked = selectedProfileId
      && selectedDevice.profiles.some((profile) => String(profile.id) === selectedProfileId)
    if (currentProfileIsLinked) return

    const linkedProfileId = selectedDevice.profiles[0]?.id
      ?? profiles.find((profile) => String(profile.device ?? '') === nextDeviceId)?.id
    setSelectedProfileId(linkedProfileId ? String(linkedProfileId) : '')
  }

  async function handleSend() {
    if (!selectedProfileId) {
      showToast(t('tiktok.commentReplaySelectProfileRequired'), 'error')
      return
    }
    if (!selectedDeviceId) {
      showToast(t('tiktok.commentReplaySelectDeviceRequired'), 'error')
      return
    }

    setSending(true)
    try {
      const taskData: TaskCreate = {
        name: t('tiktok.commentReplayTaskName', { id: plan.id }),
        description: taskDescription,
        task_type: 'generic',
        status: 'pending',
        payload: {
          app: 'tiktok',
          source: 'tiktok-comment-replay',
          comment_plan_id: plan.id,
          video_id: plan.video,
          video_link: plan.video_link,
          comment_content: plan.comment_content,
          tag_name: tagName,
        },
      }
      // Reuse the existing replay task for this comment plan instead of creating a
      // new one on every replay, so replay tasks don't pile up in the task list.
      const existingReplayTask = (await tasksApi.list({ page_size: 100, ordering: '-created_at' })).results.find(
        (item) =>
          item.payload?.source === 'tiktok-comment-replay' &&
          item.payload?.comment_plan_id === plan.id,
      )
      const task = existingReplayTask
        ? await tasksApi.update(existingReplayTask.id, taskData)
        : await tasksApi.create(taskData)
      await tasksApi.run(task.id, [Number(selectedDeviceId)], Number(selectedProfileId))
      showToast(t('tiktok.commentReplaySendSuccess'), 'success')
      onDispatched?.()
      onClose()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('tiktok.commentReplaySendError'), 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-xl border border-border bg-card shadow-xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
          <div className="min-w-0 flex-1 pr-4">
            <h2 className="text-base font-semibold">{t('tiktok.commentReplayTitle')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {t('tiktok.commentReplaySubtitle', { id: plan.id })}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted shrink-0">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-5 overflow-y-auto flex-1">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t('tiktok.commentReplaySelectProfile')}</label>
            <select
              value={selectedProfileId}
              onChange={(e) => handleProfileChange(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">{t('tiktok.commentReplaySelectProfilePlaceholder')}</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={String(profile.id)}>{profile.name}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t('tiktok.commentReplaySelectDevice')}</label>
            <select
              value={selectedDeviceId}
              onChange={(e) => handleDeviceChange(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">{t('tiktok.commentReplaySelectDevicePlaceholder')}</option>
              {devices.map((device) => (
                <option key={device.id} value={String(device.id)}>{device.name}</option>
              ))}
            </select>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
            <p className="text-xs font-medium text-muted-foreground">{t('tiktok.commentReplayTaskPreview')}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{taskDescription}</p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4 shrink-0">
          <Button variant="outline" onClick={onClose} disabled={sending}>{t('common.cancel')}</Button>
          <Button onClick={handleSend} disabled={sending}>
            <Send className="mr-1.5 size-3.5" />
            {sending ? t('tiktok.commentReplaySending') : t('tiktok.commentReplaySend')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Comments Tab ─────────────────────────────────────────────────────────────

function CommentsTab() {
  const { t } = useTranslation()
  const { showToast } = useToast()
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [profileId, setProfileId] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [reportOpen, setReportOpen] = useState(false)
  const [commentPreview, setCommentPreview] = useState<{ title: string; text: string } | null>(null)
  const commentPreviewModalRef = useRef<HTMLDivElement | null>(null)
  const commentPreviewCloseButtonRef = useRef<HTMLButtonElement | null>(null)
  const [replayDispatchPlan, setReplayDispatchPlan] = useState<TiktokCommentPlan | null>(null)
  // Interaction row a replay task is currently being dispatched for.
  const [replayDispatchItemId, setReplayDispatchItemId] = useState<number | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [diggingCommentId, setDiggingCommentId] = useState<number | null>(null)

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ['profiles'],
    queryFn: profilesApi.list,
  })
  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list(),
  })

  const { data: interactions = [], isLoading, refetch } = useQuery<TiktokCommentedInteraction[]>({
    queryKey: ['tiktok-commented-interactions', dateFrom, dateTo, profileId, deviceId],
    queryFn: () => tiktokApi.listCommentedInteractions({
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      profile_id: profileId || undefined,
      device_id: deviceId || undefined,
    }),
  })

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' })
  }

  const videoUrl = (item: TiktokCommentedInteraction) => item.video_link || item.video_url
  const toReplayPlan = (item: TiktokCommentedInteraction): TiktokCommentPlan => ({
    id: item.comment_plan_id ?? item.id,
    video: item.video_id,
    video_link: videoUrl(item),
    agent_group: null,
    agent_group_name: null,
    profile: item.profile,
    profile_name: item.profile_name,
    device: item.device,
    device_name: item.device_name,
    comment_content: item.comment_content || '',
    comment_link: item.comment_link || '',
    reply_to: '',
    is_approved: true,
    is_commented: true,
    execution_status: 'completed',
    execution_retry_count: 0,
    execution_last_error: '',
    created_at: item.created_at,
    updated_at: item.interacted_at || item.created_at,
  })

  const allSelected = interactions.length > 0 && interactions.every((item) => selectedIds.has(item.id))

  // Reset selection whenever the filtered result set changes.
  useEffect(() => {
    setSelectedIds(new Set())
  }, [dateFrom, dateTo, profileId, deviceId])

  function toggleSelectionMode() {
    setSelectionMode((prev) => {
      if (prev) setSelectedIds(new Set())
      return !prev
    })
  }

  function toggleRow(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (
      interactions.length > 0 && interactions.every((item) => prev.has(item.id))
        ? new Set()
        : new Set(interactions.map((item) => item.id))
    ))
  }

  async function handleDeleteSelected() {
    if (selectedIds.size === 0) {
      showToast(t('tiktok.commentDeleteNoneSelected'), 'error')
      return
    }
    if (!window.confirm(t('tiktok.commentDeleteConfirm', { count: selectedIds.size }))) return
    setDeleting(true)
    try {
      const result = await tiktokApi.deleteCommentedInteractions(Array.from(selectedIds))
      showToast(t('tiktok.commentDeleteSuccess', { count: result.deleted }), 'success')
      setSelectedIds(new Set())
      setSelectionMode(false)
      refetch()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('tiktok.commentDeleteError'), 'error')
    } finally {
      setDeleting(false)
    }
  }

  async function handleDigComment(item: TiktokCommentedInteraction) {
    if (diggingCommentId !== null) return
    setDiggingCommentId(item.id)
    try {
      const result = await tiktokApi.digComment(item.video_id, item.id, item.comment_plan_id)
      if (result.matched && result.comment_link) {
        showToast(t('tiktok.commentDigSuccess'), 'success')
      } else if (result.matched) {
        showToast(t('tiktok.commentDigNoLink'), 'info')
      } else {
        showToast(t('tiktok.commentDigNotFound'), 'info')
      }
      // The dig ran (HTTP 200) → backend flagged the interaction as dug.
      // Refetch in all cases so the row highlight updates immediately.
      refetch()
    } catch {
      showToast(t('tiktok.commentDigError'), 'error')
    } finally {
      setDiggingCommentId(null)
    }
  }

  useEffect(() => {
    if (!commentPreview) return
    const previousActiveElement = document.activeElement as HTMLElement | null
    commentPreviewCloseButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCommentPreview(null)
        return
      }
      if (event.key !== 'Tab') return

      const modalNode = commentPreviewModalRef.current
      if (!modalNode) return

      const focusableElements = Array.from(
        modalNode.querySelectorAll<HTMLElement>(
          'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true')

      if (focusableElements.length === 0) {
        event.preventDefault()
        return
      }

      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]
      const currentElement = document.activeElement as HTMLElement | null
      if (event.shiftKey) {
        if (currentElement === firstElement || !modalNode.contains(currentElement)) {
          event.preventDefault()
          lastElement.focus()
        }
      } else if (currentElement === lastElement) {
        event.preventDefault()
        firstElement.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      previousActiveElement?.focus()
    }
  }, [commentPreview])

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">{t('tiktok.filterFrom')}</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">{t('tiktok.filterTo')}</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">{t('tiktok.filterProfile')}</label>
            <select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">{t('tiktok.filterProfileAll')}</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={String(profile.id)}>{profile.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">{t('tiktok.filterDevice')}</label>
            <select
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">{t('tiktok.filterDeviceAll')}</option>
              {devices.map((device) => (
                <option key={device.id} value={String(device.id)}>{device.name}</option>
              ))}
            </select>
          </div>
          {(dateFrom || dateTo || profileId || deviceId) && (
            <button
              onClick={() => { setDateFrom(''); setDateTo(''); setProfileId(''); setDeviceId('') }}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
            >
              <X className="size-3" />{t('common.cancel')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
            aria-label={t('common.refresh')}
          >
            <RefreshCw className="size-3.5" />
          </button>
          {selectionMode && (
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDeleteSelected}
              disabled={selectedIds.size === 0 || deleting}
            >
              <Trash2 className="mr-1.5 size-3.5" />
              {t('tiktok.commentDeleteButton', { count: selectedIds.size })}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={toggleSelectionMode}>
            <CheckCircle2 className="mr-1.5 size-3.5" />
            {selectionMode ? t('tiktok.commentSelectCancel') : t('tiktok.commentSelectButton')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setReportOpen(true)}>
            <FileBarChart2 className="mr-1.5 size-3.5" />
            {t('tiktok.reportTitle')}
          </Button>
        </div>
      </div>

      {reportOpen && <TiktokCommentReportModal onClose={() => setReportOpen(false)} />}

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : interactions.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10">
            <MessageCircle className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t('tiktok.commentPlanTableEmpty')}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {selectionMode && (
                  <th className="w-10 px-4 py-2.5 text-left">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      aria-label={t('tiktok.commentSelectAll')}
                      className="size-4 cursor-pointer accent-primary"
                    />
                  </th>
                )}
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colId')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colVideoUrl')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.commentPlanCommentContent')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.commentPlanProfile')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.commentPlanDevice')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.commentPlanLink')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colStatus')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colCreated')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('tiktok.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {interactions.map((item) => (
                <tr
                  key={item.id}
                  className={`transition-colors ${
                    selectionMode && selectedIds.has(item.id)
                      ? 'bg-primary/5'
                      : item.replay_task_dispatched || item.dig_comment_dispatched
                        ? 'bg-red-100 dark:bg-red-950/40'
                        : 'hover:bg-muted/30'
                  }`}
                >
                  {selectionMode && (
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleRow(item.id)}
                        aria-label={t('tiktok.commentSelectButton')}
                        className="size-4 cursor-pointer accent-primary"
                      />
                    </td>
                  )}
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                    {item.comment_plan_id ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 max-w-[280px]">
                    {videoUrl(item) ? (
                      <a
                        href={videoUrl(item)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{videoUrl(item)}</span>
                      </a>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2.5 max-w-[320px] text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span className="line-clamp-2 flex-1">{item.comment_content || '—'}</span>
                      {item.comment_content && (
                        <button
                          onClick={() => setCommentPreview({ title: t('tiktok.commentPlanCommentContent'), text: item.comment_content })}
                          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {t('tiktok.viewFull')}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                    {item.profile_name || '—'}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                    {item.device_name || '—'}
                  </td>
                  <td className="px-4 py-2.5 max-w-[280px]">
                    {item.comment_link ? (
                      <a
                        href={item.comment_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{item.comment_link}</span>
                      </a>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                      {t('tiktok.commentPlanCommented')}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{formatDate(item.created_at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => { setReplayDispatchPlan(toReplayPlan(item)); setReplayDispatchItemId(item.id) }}
                        aria-label={t('tiktok.commentReplayTitle')}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Send className="size-3" />
                        <span>{t('tiktok.commentReplayOpen')}</span>
                      </button>
                      <button
                        onClick={() => handleDigComment(item)}
                        disabled={diggingCommentId === item.id}
                        aria-label={t('tiktok.commentDigOpen')}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {diggingCommentId === item.id ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <ScanSearch className="size-3" />
                        )}
                        <span>{diggingCommentId === item.id ? t('tiktok.commentDigging') : t('tiktok.commentDigOpen')}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {commentPreview && (
        <div
          onClick={() => setCommentPreview(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div
            ref={commentPreviewModalRef}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="comment-preview-title"
            className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 id="comment-preview-title" className="text-base font-semibold">{commentPreview.title}</h2>
              <button
                ref={commentPreviewCloseButtonRef}
                aria-label={t('common.close')}
                onClick={() => setCommentPreview(null)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="px-5 py-4">
              <p className="whitespace-pre-wrap text-sm text-foreground">{commentPreview.text}</p>
            </div>
          </div>
        </div>
      )}

      {replayDispatchPlan && (
        <CommentReplayDispatchModal
          plan={replayDispatchPlan}
          onClose={() => { setReplayDispatchPlan(null); setReplayDispatchItemId(null) }}
          onDispatched={async () => {
            if (replayDispatchItemId == null) return
            try {
              await tiktokApi.markReplayDispatched([replayDispatchItemId])
            } catch (err) {
              console.error('Failed to mark replay task dispatched:', err)
            }
            refetch()
          }}
        />
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TiktokPage() {
  const { t } = useTranslation()
  const location = useLocation()
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const stateTab = (location.state as TiktokPageLocationState | null)?.tab
    return stateTab && TIKTOK_TABS.includes(stateTab) ? stateTab : 'videos'
  })

  function statusLabel(s: TiktokVideoStatus) {
    const map: Record<TiktokVideoStatus, string> = {
      pending: t('tiktok.statusPending'),
      liked: t('tiktok.statusLiked'),
      commented: t('tiktok.statusCommented'),
      shared: t('tiktok.statusShared'),
      reposted: t('tiktok.statusReposted'),
    }
    return map[s]
  }

  const tabs: { id: Tab; label: string; Icon: React.ElementType }[] = [
    { id: 'videos', label: t('tiktok.tabVideos'), Icon: Music2 },
    { id: 'keywords', label: t('tiktok.tabKeywords'), Icon: Hash },
    { id: 'stats', label: t('tiktok.tabApprovals'), Icon: BarChart2 },
    { id: 'comments', label: t('tiktok.tabComments'), Icon: MessageCircle },
  ]

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold">{t('tiktok.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('tiktok.description')}</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-xl border border-border bg-muted/40 p-1">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={[
              'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              activeTab === id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            <Icon className="size-4 shrink-0" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'videos' && <VideosTab statusLabel={statusLabel} />}
      {activeTab === 'keywords' && <KeywordsTab statusLabel={statusLabel} />}
      {activeTab === 'stats' && <StatsTab />}
      {activeTab === 'comments' && <CommentsTab />}
    </div>
  )
}
