import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft, Plus, Trash2, Pencil, ExternalLink, X, Search, Loader2, Users, MessageCircle,
  Upload, Calendar, CheckCircle2, XCircle, Clock, Image, Video, List, Send, WandSparkles, Download,
  Eye, Sparkles, MessageSquare, Rocket, HardDrive,
} from 'lucide-react'
import FacebookSeedingPanel from '@/components/FacebookSeedingPanel'
import { FbHackLikeModal } from '@/components/FbHackLikeModal'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import {
  facebookCleanupApi,
  facebookProfilesApi,
  facebookProfilePostsApi,
  facebookProfileScheduledMediaActionsApi,
  facebookProfileScheduledPostsApi,
  facebookGroupsApi,
} from '@/lib/api'
import { formatDate, formatDateTime, fromLocalInputValue, toLocalInputValue } from '@/lib/dates'
import { SSEChatService } from '@/services/sseChat'
import type {
  FacebookProfilePost, FacebookProfilePostCreate, FacebookPostStatus,
  FacebookProfileScheduledMediaAction, FacebookProfileMediaActionType,
  FacebookProfileScheduledPost, FacebookProfileScheduledPostCreate, FacebookScheduledPostStatus,
  FacebookGroup,
} from '@/lib/types'

const POST_STATUSES: FacebookPostStatus[] = ['pending', 'liked', 'commented', 'shared']
const AGENT_TEAMS_URL =
  (import.meta.env.VITE_AGENT_TEAMS_URL as string | undefined)?.trim() ||
  'http://localhost:7777'

interface PlannerChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status?: 'streaming' | 'ready' | 'failed'
}

interface AiSchedulePlanItem {
  content: string
  scheduled_at: string
  image_urls: string[]
  image_description: string
}

function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

type BulkRow = { id: string; content: string; caption: string; imageUrl: string; uploadingImage: boolean }
function makeBulkRow(): BulkRow {
  return { id: Math.random().toString(36).slice(2), content: '', caption: '', imageUrl: '', uploadingImage: false }
}

function makeDefaultForm(profileId: number): FacebookProfilePostCreate {
  return { profile: profileId, post_url: '', image_url: '', image_urls: [], caption: '', content: '', keywords: [], status: 'pending' }
}

function isVideoUrl(url: string) {
  return /\.(mp4|mov|webm|m4v|avi|mkv)(\?|$)/i.test(url)
}

function MediaCounts({ urls }: { urls: string[] }) {
  if (!urls?.length) return <span className="text-muted-foreground/40 text-xs">—</span>
  const videos = urls.filter(isVideoUrl).length
  const images = urls.length - videos
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      {images > 0 && (
        <span className="flex items-center gap-1"><Image className="size-3.5" />{images}</span>
      )}
      {videos > 0 && (
        <span className="flex items-center gap-1"><Video className="size-3.5" />{videos}</span>
      )}
    </span>
  )
}

function PostStatusBadge({ status }: { status: FacebookPostStatus }) {
  const { t } = useTranslation()
  const colorMap: Record<FacebookPostStatus, string> = {
    pending: 'bg-muted text-muted-foreground',
    liked: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
    commented: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    shared: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  }
  const labelMap: Record<FacebookPostStatus, string> = {
    pending: t('facebook.detail.statusPending'),
    liked: t('facebook.detail.statusLiked'),
    commented: t('facebook.detail.statusCommented'),
    shared: t('facebook.detail.statusShared'),
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${colorMap[status]}`}>
      {labelMap[status]}
    </span>
  )
}

function ScheduledPostStatusBadge({ status }: { status: FacebookScheduledPostStatus }) {
  const { t } = useTranslation()
  const map: Record<FacebookScheduledPostStatus, { cls: string; icon: React.ReactNode }> = {
    pending: { cls: 'bg-muted text-muted-foreground', icon: <Clock className="size-3" /> },
    publishing: { cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', icon: <Loader2 className="size-3 animate-spin" /> },
    published: { cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400', icon: <CheckCircle2 className="size-3" /> },
    failed: { cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', icon: <XCircle className="size-3" /> },
    cancelled: { cls: 'bg-muted text-muted-foreground/60', icon: <XCircle className="size-3" /> },
  }
  const { cls, icon } = map[status] ?? map.pending
  return (
    <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {icon}
      {t(`facebook.schedule.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}
    </span>
  )
}

export default function FacebookProfileDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const profileId = Number(id)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { showToast } = useToast()

  // ── Tab ──────────────────────────────────────────────────────────────────
  const [searchParams] = useSearchParams()
  // Initialise from ?tab= so returning from the comment page restores the tab.
  const [activeTab, setActiveTab] = useState<'posts' | 'schedule'>(
    searchParams.get('tab') === 'schedule' ? 'schedule' : 'posts',
  )

  // ── Posts state ──────────────────────────────────────────────────────────
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<FacebookProfilePost | null>(null)
  const [form, setForm] = useState<FacebookProfilePostCreate>(makeDefaultForm(profileId))
  const [formError, setFormError] = useState('')
  const [keywordInput, setKeywordInput] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<FacebookPostStatus | ''>('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [appliedDates, setAppliedDates] = useState<{ date_from?: string; date_to?: string }>({})
  const [preview, setPreview] = useState<string | null>(null)
  const [uploadingPostImage, setUploadingPostImage] = useState(false)
  const [publishingPostId, setPublishingPostId] = useState<number | null>(null)

  // ── Bulk post state ───────────────────────────────────────────────────────
  const [bulkModalOpen, setBulkModalOpen] = useState(false)
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([])
  const [bulkSaving, setBulkSaving] = useState(false)

  // ── Schedule state ────────────────────────────────────────────────────────
  const [csvModalOpen, setCsvModalOpen] = useState(false)
  const [cleaningS3, setCleaningS3] = useState(false)
  // Schedule row preview modal: shows full content + media before publishing.
  const [detailPost, setDetailPost] = useState<FacebookProfileScheduledPost | null>(null)
  // When set, the FB reaction-boost (🚀 hacklike) modal opens for this post.
  const [hackPost, setHackPost] = useState<FacebookProfileScheduledPost | null>(null)
  const [seedingForPost, setSeedingForPost] = useState<FacebookProfilePost | null>(null)
  const [sheetUrl, setSheetUrl] = useState('')
  const [csvUploading, setCsvUploading] = useState(false)
  const [csvAiEnabled, setCsvAiEnabled] = useState(false)
  const [csvAiPrompt, setCsvAiPrompt] = useState('')
  // Optional batch-level redirect: all imported rows post into this group
  // (anonymously, using the current profile as poster) instead of timeline.
  const [csvTargetGroupId, setCsvTargetGroupId] = useState<number | ''>('')

  const [aiRewriteModalPost, setAiRewriteModalPost] = useState<FacebookProfileScheduledPost | null>(null)
  const [aiRewritePromptOverride, setAiRewritePromptOverride] = useState('')
  const [aiRewriteDraft, setAiRewriteDraft] = useState('')
  const [aiRewriteOriginal, setAiRewriteOriginal] = useState('')
  const [aiRewriteLoading, setAiRewriteLoading] = useState(false)
  const [aiRewriteAccepting, setAiRewriteAccepting] = useState(false)

  const [scheduleStatusFilter, setScheduleStatusFilter] = useState<FacebookScheduledPostStatus | ''>('')
  const [editingSchedule, setEditingSchedule] = useState<FacebookProfileScheduledPost | null>(null)
  const [scheduleForm, setScheduleForm] = useState<Partial<FacebookProfileScheduledPostCreate>>({})
  const [scheduleFormError, setScheduleFormError] = useState('')
  const [publishingDue, setPublishingDue] = useState(false)
  const [deletingPending, setDeletingPending] = useState(false)
  const [publishingScheduledId, setPublishingScheduledId] = useState<number | null>(null)

  // ── AI schedule planner state ─────────────────────────────────────────────
  const [plannerModalOpen, setPlannerModalOpen] = useState(false)
  const [plannerInput, setPlannerInput] = useState('')
  const [plannerMessages, setPlannerMessages] = useState<PlannerChatMessage[]>([])
  const [plannerPlan, setPlannerPlan] = useState<AiSchedulePlanItem[]>([])
  const [plannerSessionId, setPlannerSessionId] = useState<string | null>(null)
  const [plannerStreaming, setPlannerStreaming] = useState(false)
  const [plannerApproving, setPlannerApproving] = useState(false)
  const plannerMessagesEndRef = useRef<HTMLDivElement>(null)
  const plannerSseRef = useRef<SSEChatService | null>(null)

  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['facebook-profile', profileId],
    queryFn: () => facebookProfilesApi.get(profileId),
    enabled: Number.isFinite(profileId),
  })

  const { data: posts, isLoading: postsLoading } = useQuery({
    queryKey: ['facebook-profile-posts', profileId, appliedDates],
    queryFn: () => facebookProfilePostsApi.list({ profile: profileId, ...appliedDates }),
    enabled: Number.isFinite(profileId),
  })

  const filteredPosts = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (posts ?? []).filter((p) => {
      if (statusFilter && p.status !== statusFilter) return false
      if (!q) return true
      return (
        p.content.toLowerCase().includes(q) ||
        p.post_url.toLowerCase().includes(q) ||
        (p.caption ?? '').toLowerCase().includes(q) ||
        p.keywords.some((k) => k.toLowerCase().includes(q))
      )
    })
  }, [posts, search, statusFilter])

  const saveMutation = useMutation({
    mutationFn: (data: FacebookProfilePostCreate) =>
      editing ? facebookProfilePostsApi.update(editing.id, data) : facebookProfilePostsApi.create(data),
    onSuccess: () => {
      showToast(editing ? t('facebook.detail.postSaveSuccess') : t('facebook.detail.postCreateSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-profile-posts', profileId] })
      closeModal()
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.detail.postSaveError'), 'error'),
  })

  const deleteMutation = useMutation({
    mutationFn: (postId: number) => facebookProfilePostsApi.delete(postId),
    onSuccess: () => {
      showToast(t('facebook.detail.postDeleteSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-profile-posts', profileId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.detail.postDeleteError'), 'error'),
  })

  const publishNowMutation = useMutation({
    mutationFn: (postId: number) => {
      setPublishingPostId(postId)
      return facebookProfilePostsApi.publishNow(postId)
    },
    onSuccess: () => {
      showToast(t('facebook.detail.postPublishNowSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-profile-posts', profileId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.detail.postPublishNowError'), 'error'),
    onSettled: () => setPublishingPostId(null),
  })

  // ── Scheduled-posts queries & mutations ──────────────────────────────────
  const { data: scheduledPosts, isLoading: scheduledLoading, refetch: refetchScheduled } = useQuery({
    queryKey: ['facebook-profile-scheduled-posts', profileId],
    queryFn: () => facebookProfileScheduledPostsApi.list({ profile: profileId }),
    enabled: Number.isFinite(profileId),
  })

  // Groups the current user owns or shares — used for the CSV "Đăng vào"
  // dropdown so users can re-route an import batch into a group.
  const { data: availableGroups } = useQuery({
    queryKey: ['facebook-groups-for-profile-target'],
    queryFn: () => facebookGroupsApi.list(),
  })

  const filteredScheduled = useMemo(() => {
    return (scheduledPosts ?? []).filter((p) =>
      !scheduleStatusFilter || p.status === scheduleStatusFilter,
    )
  }, [scheduledPosts, scheduleStatusFilter])

  // ── Scheduled media actions (avatar / cover / story imported from sheet) ─
  // Used by the 3 header buttons to decide enable/disable and to pop+fire the
  // oldest pending action when the user clicks. We don't render this list in
  // the schedule table — the buttons are the only UI surface.
  const { data: scheduledMediaActions } = useQuery({
    queryKey: ['facebook-profile-scheduled-media-actions', profileId],
    queryFn: () => facebookProfileScheduledMediaActionsApi.list({ profile: profileId, status: 'pending' }),
    enabled: Number.isFinite(profileId),
  })

  // Map each action type to its oldest pending row (FIFO). Empty → button disabled.
  const pendingMediaActionByType = useMemo(() => {
    const out: Partial<Record<FacebookProfileMediaActionType, FacebookProfileScheduledMediaAction>> = {}
    const sorted = [...(scheduledMediaActions ?? [])].sort(
      (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
    )
    for (const a of sorted) {
      if (!out[a.action_type]) out[a.action_type] = a
    }
    return out
  }, [scheduledMediaActions])

  const publishMediaActionNowMutation = useMutation({
    mutationFn: (id: number) => facebookProfileScheduledMediaActionsApi.publishNow(id),
    onSuccess: () => {
      showToast(t('facebook.schedule.publishNowSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-media-actions', profileId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.schedule.publishNowError'), 'error'),
  })

  const saveScheduleMutation = useMutation({
    mutationFn: (data: Partial<FacebookProfileScheduledPostCreate>) =>
      facebookProfileScheduledPostsApi.update(editingSchedule!.id, data),
    onSuccess: () => {
      showToast(t('facebook.schedule.saveSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-posts', profileId] })
      setEditingSchedule(null)
      setScheduleForm({})
      setScheduleFormError('')
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.schedule.saveError'), 'error'),
  })

  const deleteScheduleMutation = useMutation({
    mutationFn: (schedId: number) => facebookProfileScheduledPostsApi.delete(schedId),
    onSuccess: () => {
      showToast(t('facebook.schedule.deleteSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-posts', profileId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.schedule.deleteError'), 'error'),
  })

  const publishScheduleNowMutation = useMutation({
    mutationFn: (schedId: number) => {
      setPublishingScheduledId(schedId)
      return facebookProfileScheduledPostsApi.publishNow(schedId)
    },
    onSuccess: (data) => {
      // Server returns a queued/dispatched message in `detail` — show it so the
      // user knows when a click was queued behind a busy device.
      showToast(data?.detail || t('facebook.schedule.publishNowSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-posts', profileId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.schedule.publishNowError'), 'error'),
    onSettled: () => setPublishingScheduledId(null),
  })

  // Ask the device worker to find a published post's link on Facebook and sync
  // it back (worker calls update-link). One task per scheduled post.
  const findLinkMutation = useMutation({
    mutationFn: (schedId: number) => facebookProfileScheduledPostsApi.findLink(schedId),
    onSuccess: () => {
      showToast(t('facebook.schedule.findLinkSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-posts', profileId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.schedule.findLinkError'), 'error'),
  })

  async function handleDownloadTemplate() {
    try {
      const blob = await facebookProfileScheduledPostsApi.downloadTemplate()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = 'fb-profile-import-template.xlsx'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(blobUrl)
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('facebook.schedule.csvError'), 'error')
    }
  }

  async function handleCsvUpload() {
    const url = sheetUrl.trim()
    if (!url) {
      showToast(t('facebook.schedule.sheetUrlRequired'), 'error')
      return
    }
    if (!/docs\.google\.com\/spreadsheets\/d\//.test(url)) {
      showToast(t('facebook.schedule.sheetUrlInvalid'), 'error')
      return
    }
    setCsvUploading(true)
    try {
      const result = await facebookProfilesApi.uploadCsv(profileId, url, {
        aiPrompt: csvAiEnabled ? csvAiPrompt : '',
        aiRewriteEnabled: csvAiEnabled,
        targetGroupId: csvTargetGroupId === '' ? null : csvTargetGroupId,
      })
      showToast(t('facebook.schedule.csvSuccess', { count: result.created }), 'success')
      if (result.skipped?.length) {
        showToast(t('facebook.schedule.csvSkipped', { count: result.skipped.length }), 'info')
      }
      if (result.errors?.length) {
        showToast(
          `${result.errors.length} ${t('facebook.schedule.csvErrors')}: ${result.errors[0].error}`,
          'error',
        )
      }
      setCsvModalOpen(false)
      setSheetUrl('')
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-posts', profileId] })
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-media-actions', profileId] })
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('facebook.schedule.csvError'), 'error')
    } finally {
      setCsvUploading(false)
    }
  }

  async function cleanupPublishedMedia() {
    const ok = window.confirm(
      'Xoá media S3 của TẤT CẢ bài đã đăng (page/profile/group/avatar/cover/story) thuộc user hiện tại?\n\nLưu ý: bài đăng vẫn còn trên Facebook — chỉ xoá file media gốc trên Cloudfly để giải phóng dung lượng. Hành động này KHÔNG thể undo.'
    )
    if (!ok) return
    setCleaningS3(true)
    try {
      const res = await facebookCleanupApi.cleanupPublishedMedia()
      showToast(
        `Cleanup xong: quét ${res.scanned} row, xoá ${res.deleted} file S3.`,
        'success',
      )
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Cleanup S3 thất bại', 'error')
    } finally {
      setCleaningS3(false)
    }
  }

  async function openAiRewriteModal(sp: FacebookProfileScheduledPost) {
    setAiRewriteModalPost(sp)
    setAiRewritePromptOverride(sp.ai_prompt || '')
    setAiRewriteOriginal(sp.content || '')
    setAiRewriteDraft(sp.ai_rewritten_content || '')
    if (!sp.ai_rewritten_content) {
      await runAiRewrite(sp.id, sp.ai_prompt || '')
    }
  }

  async function runAiRewrite(postId: number, prompt: string) {
    setAiRewriteLoading(true)
    try {
      const res = await facebookProfileScheduledPostsApi.aiRewrite(postId, prompt)
      setAiRewriteOriginal(res.original_content)
      setAiRewriteDraft(res.ai_rewritten_content)
      setAiRewritePromptOverride(res.ai_prompt)
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('facebook.schedule.aiRewriteError'), 'error')
    } finally {
      setAiRewriteLoading(false)
    }
  }

  async function acceptAiRewrite() {
    if (!aiRewriteModalPost) return
    const content = aiRewriteDraft.trim()
    if (!content) {
      showToast(t('facebook.schedule.aiRewriteEmpty'), 'error')
      return
    }
    setAiRewriteAccepting(true)
    try {
      await facebookProfileScheduledPostsApi.aiAccept(aiRewriteModalPost.id, content)
      showToast(t('facebook.schedule.aiRewriteAccepted'), 'success')
      setAiRewriteModalPost(null)
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-posts', profileId] })
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('facebook.schedule.aiRewriteAcceptError'), 'error')
    } finally {
      setAiRewriteAccepting(false)
    }
  }

  async function handlePublishDue() {
    setPublishingDue(true)
    try {
      // publishDue endpoint fires both posts and media actions in one call.
      const result = await facebookProfileScheduledPostsApi.publishDue()
      showToast(
        t('facebook.schedule.publishDueSuccess', { published: result.published, failed: result.failed }),
        result.failed > 0 ? 'error' : 'success',
      )
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-posts', profileId] })
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-media-actions', profileId] })
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('facebook.schedule.publishDueError'), 'error')
    } finally {
      setPublishingDue(false)
    }
  }

  async function handleDeletePendingSchedules() {
    if (!confirm(t('facebook.schedule.deletePendingConfirm'))) return
    setDeletingPending(true)
    try {
      const [postsRes, actionsRes] = await Promise.all([
        facebookProfileScheduledPostsApi.deletePending(profileId),
        facebookProfileScheduledMediaActionsApi.deletePending(profileId),
      ])
      showToast(
        t('facebook.schedule.deletePendingSuccess', { count: postsRes.deleted + actionsRes.deleted }),
        'success',
      )
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-posts', profileId] })
      qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-media-actions', profileId] })
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('facebook.schedule.deletePendingError'), 'error')
    } finally {
      setDeletingPending(false)
    }
  }

  useEffect(() => {
    return () => {
      plannerSseRef.current?.close()
      plannerSseRef.current = null
    }
  }, [])

  useEffect(() => {
    plannerMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [plannerMessages])

  function closePlannerModal() {
    plannerSseRef.current?.close()
    plannerSseRef.current = null
    setPlannerStreaming(false)
    setPlannerModalOpen(false)
  }

  function stripMarkdownFences(text: string) {
    const trimmed = text.trim()
    if (!trimmed.startsWith('```')) return trimmed
    const lines = trimmed.split('\n')
    if (lines.length < 2) return trimmed
    const inner = lines[lines.length - 1].trim() === '```' ? lines.slice(1, -1) : lines.slice(1)
    return inner.join('\n').trim()
  }

  function normalizePlan(raw: unknown): AiSchedulePlanItem[] {
    if (!raw || typeof raw !== 'object') return []
    const planRaw = (raw as { plan?: unknown }).plan
    if (!Array.isArray(planRaw)) return []

    return planRaw
      .map((entry, index) => {
        if (!entry || typeof entry !== 'object') return null
        const obj = entry as {
          content?: unknown
          scheduled_at?: unknown
          image_urls?: unknown
          image_description?: unknown
        }
        const content = typeof obj.content === 'string' ? obj.content.trim() : ''
        if (!content) return null

        const parsedDate = typeof obj.scheduled_at === 'string' ? new Date(obj.scheduled_at) : null
        const fallbackDate = new Date(Date.now() + (index + 1) * 24 * 60 * 60 * 1000)
        fallbackDate.setHours(9, 0, 0, 0)
        const scheduledAt = parsedDate && !Number.isNaN(parsedDate.getTime())
          ? parsedDate.toISOString()
          : fallbackDate.toISOString()

        const image_urls = Array.isArray(obj.image_urls)
          ? obj.image_urls.filter((url): url is string => typeof url === 'string' && !!url.trim()).map((url) => url.trim())
          : []

        const image_description = typeof obj.image_description === 'string' ? obj.image_description.trim() : ''

        return {
          content,
          scheduled_at: scheduledAt,
          image_urls,
          image_description,
        }
      })
      .filter((item): item is AiSchedulePlanItem => item !== null)
  }

  async function handleSendPlannerMessage() {
    const trimmed = plannerInput.trim()
    if (!trimmed || plannerStreaming) return
    if (!AGENT_TEAMS_URL) {
      showToast('VITE_AGENT_TEAMS_URL chưa được cấu hình.', 'error')
      return
    }

    const token = localStorage.getItem('access_token') ?? ''
    const userId = String(localStorage.getItem('user_id') ?? '')
    const nextSessionId = plannerSessionId ?? generateUUID()
    if (!plannerSessionId) {
      setPlannerSessionId(nextSessionId)
    }

    const userMsgId = `planner-user-${generateUUID()}`
    const assistantMsgId = `planner-assistant-${generateUUID()}`

    setPlannerInput('')
    setPlannerStreaming(true)
    setPlannerMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: trimmed },
      { id: assistantMsgId, role: 'assistant', content: '', status: 'streaming' },
    ])

    const contextHeader = plannerMessages.length === 0
      ? [
        `Profile name: ${profile?.name ?? `Profile #${profileId}`}`,
        `Profile id: ${profileId}`,
        'Create a posting schedule plan that can be saved directly to the backend schema.',
      ].join('\n')
      : `Current plan JSON:\n${JSON.stringify({ plan: plannerPlan }, null, 2)}`

    const payloadMessage = `${contextHeader}\n\nUser request:\n${trimmed}`

    let accumulatedContent = ''
    const svc = new SSEChatService()
    plannerSseRef.current?.close()
    plannerSseRef.current = svc

    svc
      .onEvent((event) => {
        if (event.event === 'TeamRunContent' && typeof event.content === 'string') {
          accumulatedContent += event.content
          setPlannerMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? { ...msg, content: accumulatedContent, status: 'streaming' }
                : msg,
            ),
          )
        }
      })
      .onComplete(() => {
        plannerSseRef.current = null
        setPlannerStreaming(false)

        const raw = stripMarkdownFences(accumulatedContent)
        try {
          const parsed = JSON.parse(raw) as unknown
          const normalizedPlan = normalizePlan(parsed)
          if (normalizedPlan.length === 0) {
            throw new Error('AI không trả về kế hoạch hợp lệ.')
          }
          setPlannerPlan(normalizedPlan)
          setPlannerMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                  ...msg,
                  content: `Đã cập nhật kế hoạch ${normalizedPlan.length} bài đăng. Bạn có thể tiếp tục chat để chỉnh sửa hoặc bấm Duyệt kế hoạch.`,
                  status: 'ready',
                }
                : msg,
            ),
          )
        } catch {
          setPlannerMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                  ...msg,
                  content: raw || 'Không đọc được phản hồi từ AI.',
                  status: 'failed',
                }
                : msg,
            ),
          )
          showToast('Không parse được JSON kế hoạch từ AI.', 'error')
        }
      })
      .onError((err) => {
        plannerSseRef.current = null
        setPlannerStreaming(false)
        setPlannerMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? { ...msg, content: err.message, status: 'failed' }
              : msg,
          ),
        )
        showToast(err.message, 'error')
      })

    svc.sendMessage({
      url: `${AGENT_TEAMS_URL}/agents/facebookpostplanner/runs`,
      message: payloadMessage,
      token,
      userId,
      sessionId: nextSessionId,
    })
  }

  async function handleApprovePlannerPlan() {
    if (plannerPlan.length === 0 || plannerApproving) return
    setPlannerApproving(true)
    let created = 0
    let failed = 0

    for (const item of plannerPlan) {
      try {
        await facebookProfileScheduledPostsApi.create({
          profile: profileId,
          content: item.content,
          image_urls: item.image_urls,
          image_description: item.image_description,
          scheduled_at: item.scheduled_at,
          status: 'pending',
        })
        created += 1
      } catch {
        failed += 1
      }
    }

    setPlannerApproving(false)
    qc.invalidateQueries({ queryKey: ['facebook-profile-scheduled-posts', profileId] })

    if (created > 0 && failed === 0) {
      showToast(`Đã duyệt và tạo ${created} bài lên lịch.`, 'success')
      closePlannerModal()
      return
    }

    if (created > 0) {
      showToast(`Đã tạo ${created} bài, ${failed} bài lỗi.`, 'error')
      return
    }

    showToast('Không thể tạo bài lên lịch từ kế hoạch.', 'error')
  }

  function openEditSchedule(sp: FacebookProfileScheduledPost) {
    setEditingSchedule(sp)
    setScheduleForm({
      content: sp.content,
      image_urls: sp.image_urls,
      image_description: sp.image_description,
      scheduled_at: toLocalInputValue(sp.scheduled_at), // datetime-local in Vietnam time
      status: sp.status,
      target_group: sp.target_group,
    })
    setScheduleFormError('')
  }

  function openCreate() {
    setEditing(null)
    setForm(makeDefaultForm(profileId))
    setKeywordInput('')
    setFormError('')
    setModalOpen(true)
  }

  function openEdit(post: FacebookProfilePost) {
    setEditing(post)
    setForm({
      profile: profileId,
      post_url: post.post_url,
      image_url: post.image_url,
      image_urls: post.image_urls?.length ? post.image_urls : (post.image_url ? [post.image_url] : []),
      caption: post.caption,
      content: post.content,
      keywords: post.keywords,
      status: post.status,
    })
    setKeywordInput('')
    setFormError('')
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setEditing(null)
    setForm(makeDefaultForm(profileId))
    setKeywordInput('')
    setFormError('')
  }

  function addKeyword() {
    const kw = keywordInput.trim()
    if (!kw) return
    if (!(form.keywords ?? []).includes(kw)) {
      setForm((p) => ({ ...p, keywords: [...(p.keywords ?? []), kw] }))
    }
    setKeywordInput('')
  }

  function removeKeyword(kw: string) {
    setForm((p) => ({ ...p, keywords: (p.keywords ?? []).filter((k) => k !== kw) }))
  }


  function addBulkRow() { setBulkRows(p => [...p, makeBulkRow()]) }
  function removeBulkRow(id: string) { setBulkRows(p => p.filter(r => r.id !== id)) }
  function updateBulkRow(id: string, patch: Partial<Omit<BulkRow, 'id'>>) {
    setBulkRows(p => p.map(r => r.id === id ? { ...r, ...patch } : r))
  }
  async function handleBulkImageUpload(id: string, file: File) {
    updateBulkRow(id, { uploadingImage: true })
    try {
      const { image_url } = await facebookProfilePostsApi.uploadImage(file)
      updateBulkRow(id, { imageUrl: image_url, uploadingImage: false })
    } catch {
      showToast(t('facebook.detail.postImageUploadError'), 'error')
      updateBulkRow(id, { uploadingImage: false })
    }
  }
  async function handleBulkSave() {
    const valid = bulkRows.filter(r => r.content.trim())
    if (!valid.length) { showToast(t('facebook.detail.bulkEmptyError'), 'error'); return }
    setBulkSaving(true)
    let created = 0
    for (const row of valid) {
      try {
        await facebookProfilePostsApi.create({ profile: profileId, content: row.content, caption: row.caption, image_url: row.imageUrl, keywords: [], status: 'pending' })
        created++
      } catch { /* continue */ }
    }
    setBulkSaving(false)
    showToast(t('facebook.detail.bulkSaveSuccess', { count: created }), 'success')
    qc.invalidateQueries({ queryKey: ['facebook-profile-posts', profileId] })
    setBulkModalOpen(false)
    setBulkRows([])
  }

  function handleSubmit() {
    if (!form.content?.trim()) {
      setFormError(t('facebook.detail.contentRequired'))
      return
    }
    const imageUrls = form.image_urls ?? []
    saveMutation.mutate({
      ...form,
      post_url: form.post_url?.trim() ?? '',
      image_urls: imageUrls,
      // Keep the legacy single field in sync (first image) for list display.
      image_url: imageUrls[0] ?? '',
    })
  }

  async function handlePostImageFilesChange(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploadingPostImage(true)
    try {
      const uploaded: string[] = []
      for (const file of Array.from(files)) {
        const { image_url } = await facebookProfilePostsApi.uploadImage(file)
        uploaded.push(image_url)
      }
      setForm((p) => ({ ...p, image_urls: [...(p.image_urls ?? []), ...uploaded] }))
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('facebook.detail.postImageUploadError'), 'error')
    } finally {
      setUploadingPostImage(false)
    }
  }

  function removePostImage(url: string) {
    setForm((p) => ({ ...p, image_urls: (p.image_urls ?? []).filter((u) => u !== url) }))
  }

  if (Number.isFinite(profileId) === false) {
    return <div className="p-6 text-sm text-muted-foreground">{t('facebook.detail.pageNotFound')}</div>
  }

  return (
    <div className="flex flex-col gap-6">
      <button
        onClick={() => navigate('/facebook?tab=profiles')}
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t('facebook.detail.back')}
      </button>

      {/* Page header */}
      {profileLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('common.loading')}
        </div>
      ) : profile ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">{profile.name}</h1>
              {profile.profile_url && (
                <a
                  href={profile.profile_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-3.5 shrink-0" />
                  <span className="truncate">{profile.profile_url}</span>
                </a>
              )}
              {profile.description && <p className="mt-2 text-sm text-muted-foreground">{profile.description}</p>}
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="size-4" />
              <span className="tabular-nums">{profile.friend_count.toLocaleString()}</span>
              <span>{t('facebook.detail.followers')}</span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
            {(['change_avatar', 'change_cover', 'post_story'] as const).map((action) => {
              const pending = pendingMediaActionByType[action]
              const labelKey = action === 'change_avatar'
                ? 'changeAvatarBtn'
                : action === 'change_cover' ? 'changeCoverBtn' : 'postStoryBtn'
              const disabled = !pending || publishMediaActionNowMutation.isPending
              const tooltip = pending
                ? t('facebook.profile.mediaActionReady')
                : t('facebook.profile.mediaActionNoData')
              return (
                <Button
                  key={action}
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  title={tooltip}
                  onClick={() => pending && publishMediaActionNowMutation.mutate(pending.id)}
                >
                  <Image className="mr-1.5 size-3.5" />
                  {t(`facebook.profile.${labelKey}`)}
                </Button>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">{t('facebook.detail.pageNotFound')}</div>
      )}

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-xl border border-border bg-muted/40 p-1">
        {(['posts', 'schedule'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === tab
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab === 'posts' ? t('facebook.detail.postsTitle') : t('facebook.schedule.tabLabel')}
          </button>
        ))}
      </div>

      {activeTab === 'posts' && (
        <>
          {/* Posts toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{t('facebook.detail.postsTitle')}</h2>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => { setBulkRows([makeBulkRow()]); setBulkModalOpen(true) }}>
                <List className="mr-1.5 size-3.5" />
                {t('facebook.detail.addBulkPosts')}
              </Button>
              <Button size="sm" onClick={openCreate}>
                <Plus className="mr-1.5 size-3.5" />
                {t('facebook.detail.addPost')}
              </Button>
            </div>
          </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('facebook.detail.searchPlaceholder')}
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as FacebookPostStatus | '')}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t('facebook.pagesTab.filterAllStatus')}</option>
          {POST_STATUSES.map((s) => (
            <option key={s} value={s}>{t(`facebook.detail.status${s.charAt(0).toUpperCase()}${s.slice(1)}`)}</option>
          ))}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label={t('facebook.filterFrom')}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label={t('facebook.filterTo')}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        <Button size="sm" variant="outline" onClick={() => setAppliedDates({ date_from: dateFrom || undefined, date_to: dateTo || undefined })}>
          {t('facebook.report.apply')}
        </Button>
        {(appliedDates.date_from || appliedDates.date_to) && (
          <Button size="sm" variant="ghost" onClick={() => { setDateFrom(''); setDateTo(''); setAppliedDates({}) }}>
            {t('facebook.clearFilters')}
          </Button>
        )}
      </div>

      {/* Posts table */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {postsLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('common.loading')}
          </div>
        ) : filteredPosts.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('facebook.detail.emptyPosts')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.detail.colPost')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.detail.colContent')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.detail.colKeywords')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.detail.colStatus')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.detail.colCreated')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.detail.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredPosts.map((post) => (
                <tr key={post.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 max-w-[240px]">
                    {post.post_url ? (
                      <a
                        href={post.post_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{post.post_url}</span>
                      </a>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2.5 max-w-[320px] text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span className="line-clamp-2 flex-1">{post.content || post.caption || '—'}</span>
                      {(post.content || post.caption) && (
                        <button onClick={() => setPreview(post.content || post.caption || '')}
                          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
                          {t('facebook.viewFull')}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 max-w-[200px]">
                    <div className="flex flex-wrap gap-1">
                      {post.keywords.length === 0 ? (
                        <span className="text-muted-foreground/40 text-xs">—</span>
                      ) : (
                        post.keywords.map((kw) => (
                          <span key={kw} className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                            {kw}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5"><PostStatusBadge status={post.status} /></td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{formatDate(post.created_at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => publishNowMutation.mutate(post.id)}
                        aria-label={t('facebook.detail.publishNow')}
                        disabled={publishingPostId === post.id}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {publishingPostId === post.id ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                        <span>{t('facebook.detail.publishNow')}</span>
                      </button>
                      <button
                        onClick={() => navigate(`/facebook/posts/${post.id}`)}
                        aria-label={t('facebook.detail.openPost')}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <MessageCircle className="size-3.5" />
                        <span>{t('facebook.detail.openPost')}</span>
                      </button>
                      <button
                        onClick={() => setSeedingForPost(post)}
                        disabled={!post.post_url}
                        title={post.post_url ? 'Seeding (like / comment / reply)' : 'Bài chưa có URL — chưa thể seed'}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                      >
                        <Sparkles className="size-3.5 text-amber-500" />
                        <span>Seeding</span>
                      </button>
                      <button
                        onClick={() => openEdit(post)}
                        aria-label={t('common.edit')}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        onClick={() => { if (confirm(t('facebook.detail.postDeleteConfirm'))) deleteMutation.mutate(post.id) }}
                        aria-label={t('common.delete')}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                      >
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
      {preview !== null && (
        <div onClick={() => setPreview(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{t('facebook.detail.colContent')}</h2>
              <button onClick={() => setPreview(null)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-5"><p className="whitespace-pre-wrap text-sm text-foreground">{preview}</p></div>
          </div>
        </div>
      )}

      {/* Create / Edit modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl flex max-h-[90vh] flex-col">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">
                {editing ? t('facebook.detail.editPostTitle') : t('facebook.detail.createPostTitle')}
              </h2>
              <button onClick={closeModal} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-4 overflow-y-auto p-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">
                  {t('facebook.detail.fieldContent')}
                  <span className="ml-1 text-destructive">*</span>
                </label>
                <textarea
                  value={form.content ?? ''}
                  onChange={(e) => setForm((p) => ({ ...p, content: e.target.value }))}
                  placeholder={t('facebook.detail.fieldContentPlaceholder')}
                  rows={4}
                  autoFocus
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-muted-foreground">
                  {t('facebook.detail.fieldPostUrl')}
                  <span className="ml-1 text-xs font-normal">({t('common.optional')})</span>
                </label>
                <input
                  type="url"
                  value={form.post_url ?? ''}
                  onChange={(e) => setForm((p) => ({ ...p, post_url: e.target.value }))}
                  placeholder={t('facebook.detail.fieldPostUrlPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-muted-foreground">
                  {t('facebook.detail.fieldImage')}
                  <span className="ml-1 text-xs font-normal">({t('common.optional')})</span>
                </label>
                <input
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={(e) => { handlePostImageFilesChange(e.target.files); e.target.value = '' }}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium"
                />
                {uploadingPostImage && (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> {t('facebook.detail.postImageUploading')}
                  </p>
                )}
                {(form.image_urls ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {(form.image_urls ?? []).map((url) => (
                      <div key={url} className="relative">
                        {isVideoUrl(url) ? (
                          <a href={url} target="_blank" rel="noopener noreferrer"
                            className="flex size-16 items-center justify-center rounded-lg border border-border bg-muted text-[10px] text-muted-foreground">
                            video
                          </a>
                        ) : (
                          <img src={url} alt="" className="size-16 rounded-lg border border-border object-cover" />
                        )}
                        <button
                          type="button"
                          onClick={() => removePostImage(url)}
                          className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground hover:text-destructive"
                          aria-label={t('common.delete')}
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.detail.fieldCaption')}</label>
                <input
                  type="text"
                  value={form.caption ?? ''}
                  onChange={(e) => setForm((p) => ({ ...p, caption: e.target.value }))}
                  placeholder={t('facebook.detail.fieldCaptionPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.detail.fieldKeywords')}</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={keywordInput}
                    onChange={(e) => setKeywordInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword() } }}
                    placeholder={t('facebook.detail.fieldKeywordsPlaceholder')}
                    className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <Button type="button" size="sm" variant="outline" onClick={addKeyword}><Plus className="size-4" /></Button>
                </div>
                {(form.keywords ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {(form.keywords ?? []).map((kw) => (
                      <span key={kw} className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {kw}
                        <button type="button" onClick={() => removeKeyword(kw)} className="text-primary/60 hover:text-primary">
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.detail.fieldStatus')}</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm((p) => ({ ...p, status: e.target.value as FacebookPostStatus }))}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  {POST_STATUSES.map((s) => (
                    <option key={s} value={s}>{t(`facebook.detail.status${s.charAt(0).toUpperCase()}${s.slice(1)}`)}</option>
                  ))}
                </select>
              </div>

              {formError && <p className="text-xs text-destructive">{formError}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" onClick={closeModal} disabled={saveMutation.isPending}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSubmit} disabled={saveMutation.isPending || uploadingPostImage}>
                {saveMutation.isPending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk post entry modal */}
      {bulkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-xl flex max-h-[90vh] flex-col">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{t('facebook.detail.addBulkPosts')}</h2>
              <button onClick={() => setBulkModalOpen(false)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-col gap-3 overflow-y-auto p-5">
              {bulkRows.map((row, idx) => (
                <div key={row.id} className="rounded-lg border border-border bg-muted/20 p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">{t('facebook.detail.bulkRowLabel', { n: idx + 1 })}</span>
                    {bulkRows.length > 1 && (
                      <button onClick={() => removeBulkRow(row.id)} className="rounded p-1 text-muted-foreground hover:text-destructive">
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <textarea
                    value={row.content}
                    onChange={e => updateBulkRow(row.id, { content: e.target.value })}
                    placeholder={t('facebook.detail.fieldContentPlaceholder')}
                    rows={3}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <input
                    type="text"
                    value={row.caption}
                    onChange={e => updateBulkRow(row.id, { caption: e.target.value })}
                    placeholder={t('facebook.detail.fieldCaptionPlaceholder')}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <div className="flex items-center gap-3">
                    <label className="flex-1 cursor-pointer">
                      <span className="sr-only">{t('facebook.detail.fieldImage')}</span>
                      <input
                        type="file"
                        accept="image/*,video/*"
                        disabled={row.uploadingImage}
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleBulkImageUpload(row.id, f); e.target.value = '' }}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium"
                      />
                    </label>
                    {row.uploadingImage && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
                    {row.imageUrl && !row.uploadingImage && (
                      <a href={row.imageUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
                        <Image className="size-5 text-primary" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={addBulkRow}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="size-4" />
                {t('facebook.detail.bulkAddRow')}
              </button>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" onClick={() => setBulkModalOpen(false)} disabled={bulkSaving}>{t('common.cancel')}</Button>
              <Button onClick={handleBulkSave} disabled={bulkSaving || bulkRows.some(r => r.uploadingImage)}>
                {bulkSaving ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />{t('common.saving')}</> : <><Send className="mr-1.5 size-3.5" />{t('facebook.detail.bulkSaveBtn')}</>}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )}

  {/* ── Schedule tab ─────────────────────────────────────────────────────── */}
  {activeTab === 'schedule' && (
    <>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('facebook.schedule.tabLabel')}</h2>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPlannerModalOpen(true)}
          >
            <WandSparkles className="mr-1.5 size-3.5" />
            {t('facebook.schedule.aiPlanBtn')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handlePublishDue}
            disabled={publishingDue}
          >
            {publishingDue
              ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />{t('common.loading')}</>
              : <><Calendar className="mr-1.5 size-3.5" />{t('facebook.schedule.publishDueBtn')}</>}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleDeletePendingSchedules}
            disabled={deletingPending}
            className="text-destructive hover:text-destructive"
          >
            {deletingPending
              ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />{t('common.loading')}</>
              : <><Trash2 className="mr-1.5 size-3.5" />{t('facebook.schedule.deletePendingBtn')}</>}
          </Button>
          <Button size="sm" onClick={() => { setSheetUrl(''); setCsvModalOpen(true) }}>
            <Upload className="mr-1.5 size-3.5" />
            {t('facebook.schedule.uploadCsvBtn')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={cleanupPublishedMedia}
            disabled={cleaningS3}
            title="Xoá media S3 của các bài Đã đăng để giải phóng Cloudfly"
          >
            {cleaningS3
              ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Đang dọn S3…</>
              : <><HardDrive className="mr-1.5 size-3.5" />Dọn S3 (bài đã đăng)</>}
          </Button>
        </div>
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-2">
        <select
          value={scheduleStatusFilter}
          onChange={(e) => setScheduleStatusFilter(e.target.value as FacebookScheduledPostStatus | '')}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t('facebook.pagesTab.filterAllStatus')}</option>
          {(['pending', 'publishing', 'published', 'failed', 'cancelled'] as FacebookScheduledPostStatus[]).map((s) => (
            <option key={s} value={s}>
              {t(`facebook.schedule.status${s.charAt(0).toUpperCase()}${s.slice(1)}`)}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={() => refetchScheduled()} disabled={scheduledLoading}>
          {scheduledLoading ? <Loader2 className="size-3.5 animate-spin" /> : t('common.refresh')}
        </Button>
      </div>

      {/* Scheduled posts table */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {scheduledLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('common.loading')}
          </div>
        ) : filteredScheduled.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t('facebook.schedule.emptyScheduled')}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.schedule.colScheduledAt')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.schedule.colContent')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.schedule.colImages')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Đăng vào</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.schedule.colStatus')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Link bài</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.schedule.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredScheduled.map((sp) => (
                <tr key={sp.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(sp.scheduled_at)}
                  </td>
                  <td className="px-4 py-2.5 max-w-[320px]">
                    {sp.topic && (
                      <span className="mb-1 inline-block rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                        {sp.topic}
                      </span>
                    )}
                    <p className="line-clamp-2 text-xs text-foreground">{sp.content || '—'}</p>
                    {sp.image_description && (
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">🖼 {sp.image_description}</p>
                    )}
                    {sp.error_msg && (
                      <p className="mt-0.5 line-clamp-1 text-[10px] text-destructive">{sp.error_msg}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <MediaCounts urls={sp.image_urls} />
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs">
                    {sp.target_group_name ? (
                      <span className="inline-flex items-center rounded bg-violet-500/10 px-1.5 py-0.5 font-medium text-violet-600">
                        Group: {sp.target_group_name}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Trang cá nhân</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <ScheduledPostStatusBadge status={sp.status} />
                  </td>
                  <td className="px-4 py-2.5 max-w-[180px]">
                    {sp.fb_post_id ? (
                      <a
                        href={sp.fb_post_id}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={sp.fb_post_id}
                        className="inline-flex items-center gap-1 text-xs text-primary underline decoration-dotted hover:decoration-solid"
                      >
                        <ExternalLink className="size-3.5" />
                        <span className="truncate">Mở bài</span>
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setDetailPost(sp)}
                        aria-label="Xem chi tiết"
                        title="Xem chi tiết"
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Eye className="size-4" />
                      </button>
                      <button
                        onClick={() => navigate(`/facebook/scheduled-posts/${sp.id}/comments`)}
                        aria-label="Tạo comment"
                        title="Tạo comment"
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <MessageSquare className="size-3.5" />
                        <span>Tạo comment</span>
                      </button>
                      <button
                        onClick={() => setHackPost(sp)}
                        aria-label="Tăng cảm xúc (hacklike)"
                        title="Tăng cảm xúc (hacklike)"
                        className="rounded-lg p-1.5 text-violet-500 transition-colors hover:bg-violet-500/10"
                      >
                        <Rocket className="size-4" />
                      </button>
                      {sp.buffed_like_total > 0 && (
                        <span
                          title={`Đã buff ${sp.buffed_like_total.toLocaleString()} cảm xúc`}
                          className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"
                        >
                          🚀 {sp.buffed_like_total.toLocaleString()}
                        </span>
                      )}
                      {sp.status !== 'published' && sp.status !== 'cancelled' && (
                        <button
                          onClick={() => publishScheduleNowMutation.mutate(sp.id)}
                          aria-label={t('facebook.schedule.publishNowBtn')}
                          disabled={publishingScheduledId === sp.id}
                          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {publishingScheduledId === sp.id ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                          <span>{t('facebook.schedule.publishNowBtn')}</span>
                        </button>
                      )}
                      {!sp.fb_post_id && sp.status !== 'pending' && sp.status !== 'cancelled' && (
                        <button
                          onClick={() => findLinkMutation.mutate(sp.id)}
                          aria-label={t('facebook.schedule.findLinkBtn')}
                          title={t('facebook.schedule.findLinkBtn')}
                          disabled={findLinkMutation.isPending && findLinkMutation.variables === sp.id}
                          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {findLinkMutation.isPending && findLinkMutation.variables === sp.id ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                          <span>{t('facebook.schedule.findLinkBtn')}</span>
                        </button>
                      )}
                      {sp.status === 'pending' && (
                        <button
                          onClick={() => openEditSchedule(sp)}
                          aria-label={t('common.edit')}
                          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <Pencil className="size-4" />
                        </button>
                      )}
                      {sp.ai_prompt && (sp.status === 'pending' || sp.status === 'failed') && (
                        <button
                          onClick={() => openAiRewriteModal(sp)}
                          aria-label={t('facebook.schedule.aiRewriteBtn')}
                          title={t('facebook.schedule.aiRewriteBtn')}
                          className="rounded-lg p-1.5 text-violet-500 transition-colors hover:bg-violet-500/10"
                        >
                          <WandSparkles className="size-4" />
                        </button>
                      )}
                      <button
                        onClick={() => { if (confirm(t('facebook.schedule.deleteConfirm'))) deleteScheduleMutation.mutate(sp.id) }}
                        aria-label={t('common.delete')}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                      >
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

      {/* CSV upload modal */}
      {csvModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
            <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{t('facebook.schedule.csvModalTitle')}</h2>
              <button onClick={() => setCsvModalOpen(false)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
              <p className="text-sm text-muted-foreground">{t('facebook.schedule.csvModalDesc')}</p>
              <pre className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap">
                {t('facebook.schedule.csvFormatHint')}
              </pre>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.schedule.sheetUrlLabel')}</label>
                <input
                  type="url"
                  value={sheetUrl}
                  onChange={(e) => setSheetUrl(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/.../edit"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">{t('facebook.schedule.sheetUrlHint')}</p>
              </div>

              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
                <label className="text-sm font-medium">Đăng vào (mặc định cho mọi row)</label>
                <select
                  value={csvTargetGroupId}
                  onChange={(e) => setCsvTargetGroupId(e.target.value ? Number(e.target.value) : '')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Trang cá nhân (mặc định)</option>
                  {(availableGroups ?? []).map((g: FacebookGroup) => (
                    <option key={g.id} value={g.id}>Group: {g.name}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Áp dụng cho row không có cột <strong>Group</strong> trong sheet.
                  Nếu row có cột Group (URL/UID của group) thì giá trị row sẽ
                  override mặc định này. Bài đăng vào group: ẩn danh, dùng chính
                  account này làm poster; nếu group bật chế độ duyệt, bài rơi
                  vào pending queue cho admin duyệt sau.
                </p>
              </div>

              <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
                <label className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={csvAiEnabled}
                    onChange={(e) => setCsvAiEnabled(e.target.checked)}
                    className="size-4 rounded border-border"
                  />
                  {t('facebook.schedule.aiRewriteEnableLabel')}
                </label>
                {csvAiEnabled && (
                  <>
                    <textarea
                      value={csvAiPrompt}
                      onChange={(e) => setCsvAiPrompt(e.target.value)}
                      rows={3}
                      placeholder={t('facebook.schedule.aiRewritePromptPlaceholder')}
                      className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('facebook.schedule.aiRewritePromptHint')}
                    </p>
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>
                <Download className="mr-1.5 size-3.5" />
                {t('facebook.schedule.downloadTemplateBtn')}
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => setCsvModalOpen(false)} disabled={csvUploading}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleCsvUpload} disabled={csvUploading || !sheetUrl.trim()}>
                  {csvUploading
                    ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />{t('facebook.schedule.csvUploading')}</>
                    : t('facebook.schedule.csvUploadBtn')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Scheduled-post detail preview modal */}
      {hackPost && (
        <FbHackLikeModal post={hackPost} postKind="profile" onClose={() => setHackPost(null)} />
      )}

      {detailPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
            <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-2">
                <Eye className="size-5 text-muted-foreground" />
                <h2 className="text-base font-semibold">Chi tiết bài đăng</h2>
              </div>
              <button
                onClick={() => setDetailPost(null)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
              <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Lịch đăng</p>
                  <p className="font-medium">{formatDateTime(detailPost.scheduled_at)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Trạng thái</p>
                  <div className="mt-0.5"><ScheduledPostStatusBadge status={detailPost.status} /></div>
                </div>
                <div>
                  <p className="text-muted-foreground">Đăng vào</p>
                  <p className="font-medium">
                    {detailPost.target_group_name
                      ? <>Group: <span className="text-violet-600">{detailPost.target_group_name}</span></>
                      : 'Trang cá nhân'}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Poster</p>
                  <p className="font-medium">{detailPost.profile_name}</p>
                </div>
                {detailPost.topic && (
                  <div className="col-span-2">
                    <p className="text-muted-foreground">Chủ đề</p>
                    <span className="mt-0.5 inline-block rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                      {detailPost.topic}
                    </span>
                  </div>
                )}
                {detailPost.fb_post_id && (
                  <div className="col-span-2">
                    <p className="text-muted-foreground">Link bài đã đăng</p>
                    <a
                      href={detailPost.fb_post_id}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 break-all text-xs text-primary underline decoration-dotted hover:decoration-solid"
                    >
                      <ExternalLink className="size-3" />
                      {detailPost.fb_post_id}
                    </a>
                  </div>
                )}
              </div>

              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Nội dung</p>
                <div className="whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-sm">
                  {detailPost.content || <span className="text-muted-foreground">— Rỗng —</span>}
                </div>
              </div>

              {detailPost.ai_rewritten_content && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-violet-500">Bản AI viết lại (chưa accept)</p>
                  <div className="whitespace-pre-wrap rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 text-sm">
                    {detailPost.ai_rewritten_content}
                  </div>
                </div>
              )}

              {detailPost.image_description && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Mô tả ảnh / prompt</p>
                  <p className="rounded-lg border border-border bg-background p-3 text-sm text-muted-foreground">
                    {detailPost.image_description}
                  </p>
                </div>
              )}

              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  Media ({detailPost.image_urls?.length ?? 0})
                </p>
                {(detailPost.image_urls?.length ?? 0) === 0 ? (
                  <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                    Không có ảnh/video
                  </p>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {detailPost.image_urls.map((url, i) => {
                      const isVideo = /\.(mp4|mov|webm|m4v|avi|mkv)(\?|$)/i.test(url)
                      return (
                        <a
                          key={i}
                          href={url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-muted"
                          title={url}
                        >
                          {isVideo ? (
                            <div className="flex h-full w-full items-center justify-center bg-black/80 text-white">
                              <Video className="size-8" />
                            </div>
                          ) : (
                            <img
                              src={url}
                              alt={`media ${i + 1}`}
                              className="size-full object-cover transition-transform group-hover:scale-105"
                              loading="lazy"
                            />
                          )}
                          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 py-0.5 text-[10px] font-medium text-white">
                            {isVideo ? 'Video' : `Ảnh ${i + 1}`}
                          </span>
                        </a>
                      )
                    })}
                  </div>
                )}
              </div>

              {detailPost.error_msg && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-destructive">Lỗi</p>
                  <p className="whitespace-pre-wrap rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                    {detailPost.error_msg}
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" onClick={() => setDetailPost(null)}>Đóng</Button>
            </div>
          </div>
        </div>
      )}

      {/* Seeding panel modal (Phase 3) */}
      {seedingForPost && (
        <div
          onClick={() => setSeedingForPost(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold">Seeding tương tác</h2>
                <p className="text-xs text-muted-foreground">
                  Post #{seedingForPost.id} · {seedingForPost.post_url ? <a href={seedingForPost.post_url} target="_blank" rel="noreferrer" className="text-blue-600 underline">{seedingForPost.post_url}</a> : '—'}
                </p>
              </div>
              <button onClick={() => setSeedingForPost(null)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <div className="overflow-y-auto p-5">
              <FacebookSeedingPanel postId={seedingForPost.id} surface="profile" />
            </div>
          </div>
        </div>
      )}

      {/* AI rewrite compare modal */}
      {aiRewriteModalPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-2">
                <WandSparkles className="size-5 text-violet-500" />
                <h2 className="text-base font-semibold">{t('facebook.schedule.aiRewriteModalTitle')}</h2>
              </div>
              <button onClick={() => setAiRewriteModalPost(null)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-3 px-5 py-3 border-b border-border">
              <label className="text-xs font-medium text-muted-foreground">
                {t('facebook.schedule.aiRewritePromptLabel')}
              </label>
              <div className="flex gap-2">
                <textarea
                  value={aiRewritePromptOverride}
                  onChange={(e) => setAiRewritePromptOverride(e.target.value)}
                  rows={2}
                  placeholder={t('facebook.schedule.aiRewritePromptPlaceholder')}
                  className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => aiRewriteModalPost && runAiRewrite(aiRewriteModalPost.id, aiRewritePromptOverride)}
                  disabled={aiRewriteLoading}
                  className="self-start"
                >
                  {aiRewriteLoading
                    ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />{t('facebook.schedule.aiRewriteRegenerating')}</>
                    : t('facebook.schedule.aiRewriteRegenerate')}
                </Button>
              </div>
            </div>

            <div className="grid flex-1 min-h-0 grid-cols-1 gap-0 md:grid-cols-2">
              <div className="flex min-h-0 flex-col border-r border-border">
                <div className="border-b border-border px-5 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('facebook.schedule.aiRewriteOriginal')}
                </div>
                <div className="flex-1 overflow-auto px-5 py-3 text-sm whitespace-pre-wrap">
                  {aiRewriteOriginal}
                </div>
              </div>
              <div className="flex min-h-0 flex-col">
                <div className="border-b border-border px-5 py-2 text-xs font-semibold uppercase tracking-wide text-violet-500">
                  {t('facebook.schedule.aiRewriteSuggested')}
                </div>
                <div className="flex-1 overflow-auto p-3">
                  {aiRewriteLoading && !aiRewriteDraft ? (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      {t('facebook.schedule.aiRewriteGenerating')}
                    </div>
                  ) : (
                    <textarea
                      value={aiRewriteDraft}
                      onChange={(e) => setAiRewriteDraft(e.target.value)}
                      className="h-full w-full resize-none rounded-lg border border-border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                      placeholder={t('facebook.schedule.aiRewriteSuggestedPlaceholder')}
                    />
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" onClick={() => setAiRewriteModalPost(null)} disabled={aiRewriteAccepting}>
                {t('common.cancel')}
              </Button>
              <Button onClick={acceptAiRewrite} disabled={aiRewriteAccepting || aiRewriteLoading || !aiRewriteDraft.trim()}>
                {aiRewriteAccepting
                  ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />{t('facebook.schedule.aiRewriteAccepting')}</>
                  : t('facebook.schedule.aiRewriteAccept')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* AI planner modal */}
      {plannerModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="grid h-[88vh] w-full max-w-6xl grid-cols-1 overflow-hidden rounded-xl border border-border bg-card shadow-xl lg:grid-cols-[1.25fr_1fr]">
            <div className="flex min-h-0 flex-col border-r border-border">
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <div>
                  <h2 className="text-base font-semibold">{t('facebook.schedule.aiModalTitle')}</h2>
                  <p className="text-xs text-muted-foreground">{t('facebook.schedule.aiModalDesc')}</p>
                </div>
                <button onClick={closePlannerModal} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                  <X className="size-4" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {plannerMessages.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
                    {t('facebook.schedule.aiEmptyHint')}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {plannerMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`max-w-[92%] rounded-xl px-3 py-2 text-sm ${
                          msg.role === 'user'
                            ? 'ml-auto bg-foreground text-background'
                            : msg.status === 'failed'
                              ? 'border border-destructive/30 bg-destructive/10 text-destructive'
                              : 'border border-border bg-background text-foreground'
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                        {msg.status === 'streaming' && (
                          <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                            <Loader2 className="size-3 animate-spin" />
                            <span>{t('facebook.schedule.aiStreaming')}</span>
                          </div>
                        )}
                      </div>
                    ))}
                    <div ref={plannerMessagesEndRef} />
                  </div>
                )}
              </div>

              <div className="border-t border-border p-4">
                <div className="flex items-end gap-2 rounded-xl border border-border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
                  <textarea
                    value={plannerInput}
                    onChange={(e) => setPlannerInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleSendPlannerMessage()
                      }
                    }}
                    rows={2}
                    disabled={plannerStreaming}
                    placeholder={t('facebook.schedule.aiInputPlaceholder')}
                    className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <button
                    onClick={handleSendPlannerMessage}
                    disabled={!plannerInput.trim() || plannerStreaming}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {plannerStreaming ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-col">
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <h3 className="text-sm font-semibold">{t('facebook.schedule.aiPlanPreviewTitle')}</h3>
                <Button
                  size="sm"
                  onClick={handleApprovePlannerPlan}
                  disabled={plannerPlan.length === 0 || plannerApproving || plannerStreaming}
                >
                  {plannerApproving
                    ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />{t('common.saving')}</>
                    : t('facebook.schedule.aiApproveBtn')}
                </Button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {plannerPlan.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
                    {t('facebook.schedule.aiPlanEmpty')}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {plannerPlan.map((item, idx) => (
                      <div key={`${item.scheduled_at}-${idx}`} className="rounded-lg border border-border bg-background p-3">
                        <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                          {t('facebook.schedule.colScheduledAt')}: {formatDateTime(item.scheduled_at)}
                        </p>
                        <p className="text-sm whitespace-pre-wrap">{item.content}</p>
                        {item.image_urls.length > 0 && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t('facebook.schedule.colImages')}: {item.image_urls.length}
                          </p>
                        )}
                        {item.image_description && (
                          <p className="mt-1 text-xs text-muted-foreground">🖼 {item.image_description}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit schedule modal */}
      {editingSchedule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl flex max-h-[90vh] flex-col">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{t('facebook.schedule.editScheduleTitle')}</h2>
              <button onClick={() => setEditingSchedule(null)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-col gap-4 overflow-y-auto p-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.schedule.fieldScheduledAt')}</label>
                <input
                  type="datetime-local"
                  value={scheduleForm.scheduled_at ?? ''}
                  onChange={(e) => setScheduleForm((p) => ({ ...p, scheduled_at: e.target.value }))}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.schedule.fieldContent')}</label>
                <textarea
                  value={scheduleForm.content ?? ''}
                  onChange={(e) => setScheduleForm((p) => ({ ...p, content: e.target.value }))}
                  rows={4}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.schedule.fieldImageUrls')}</label>
                <textarea
                  value={(scheduleForm.image_urls ?? []).join('\n')}
                  onChange={(e) =>
                    setScheduleForm((p) => ({
                      ...p,
                      image_urls: e.target.value.split('\n').map((u) => u.trim()).filter(Boolean),
                    }))
                  }
                  rows={3}
                  placeholder="https://..."
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.schedule.fieldImageDescription')}</label>
                <textarea
                  value={scheduleForm.image_description ?? ''}
                  onChange={(e) => setScheduleForm((p) => ({ ...p, image_description: e.target.value }))}
                  rows={2}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Đăng vào</label>
                <select
                  value={scheduleForm.target_group ?? ''}
                  onChange={(e) =>
                    setScheduleForm((p) => ({
                      ...p,
                      target_group: e.target.value ? Number(e.target.value) : null,
                    }))
                  }
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Trang cá nhân (mặc định)</option>
                  {(availableGroups ?? []).map((g) => (
                    <option key={g.id} value={g.id}>Group: {g.name}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Bài chuyển sang group sẽ rơi vào pending queue của group đó.
                  Admin group duyệt qua mục "Bài chờ duyệt" để bài public.
                </p>
              </div>
              {scheduleFormError && <p className="text-xs text-destructive">{scheduleFormError}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" onClick={() => setEditingSchedule(null)} disabled={saveScheduleMutation.isPending}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => {
                  if (!scheduleForm.scheduled_at) { setScheduleFormError(t('facebook.schedule.fieldScheduledAt')); return }
                  // Interpret the input as Vietnam time → UTC ISO for the backend.
                  saveScheduleMutation.mutate({
                    ...scheduleForm,
                    scheduled_at: fromLocalInputValue(scheduleForm.scheduled_at),
                  })
                }}
                disabled={saveScheduleMutation.isPending}
              >
                {saveScheduleMutation.isPending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )}

  </div>
  )
}
