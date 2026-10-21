import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft, Plus, Trash2, Pencil, ExternalLink, X, Search, Loader2, Users, MessageCircle,
  Upload, Calendar, CheckCircle2, XCircle, Clock, Image, Video, List, Send, WandSparkles, Sparkles,
} from 'lucide-react'
import FacebookSeedingPanel from '@/components/FacebookSeedingPanel'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import {
  facebookGroupsApi,
  facebookGroupPostsApi,
  facebookGroupPendingMemberPostsApi,
  facebookGroupScheduledPostsApi,
} from '@/lib/api'
import { formatDate, formatDateTime, fromLocalInputValue, toLocalInputValue } from '@/lib/dates'
import { SSEChatService } from '@/services/sseChat'
import type {
  FacebookGroupPost, FacebookGroupPostCreate, FacebookPostStatus,
  FacebookGroupScheduledPost, FacebookGroupScheduledPostCreate, FacebookScheduledPostStatus,
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

function makeDefaultForm(groupId: number): FacebookGroupPostCreate {
  return { group: groupId, post_url: '', image_url: '', image_urls: [], caption: '', content: '', keywords: [], status: 'pending' }
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

export default function FacebookGroupDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const groupId = Number(id)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { showToast } = useToast()

  // ── Tab ──────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'posts' | 'schedule' | 'pending'>('posts')

  // ── Posts state ──────────────────────────────────────────────────────────
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<FacebookGroupPost | null>(null)
  const [seedingForPost, setSeedingForPost] = useState<FacebookGroupPost | null>(null)
  const [form, setForm] = useState<FacebookGroupPostCreate>(makeDefaultForm(groupId))
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
  const [sheetUrl, setSheetUrl] = useState('')
  const [csvUploading, setCsvUploading] = useState(false)
  const [scheduleStatusFilter, setScheduleStatusFilter] = useState<FacebookScheduledPostStatus | ''>('')
  const [editingSchedule, setEditingSchedule] = useState<FacebookGroupScheduledPost | null>(null)
  const [scheduleForm, setScheduleForm] = useState<Partial<FacebookGroupScheduledPostCreate>>({})
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

  const { data: group, isLoading: groupLoading } = useQuery({
    queryKey: ['facebook-group', groupId],
    queryFn: () => facebookGroupsApi.get(groupId),
    enabled: Number.isFinite(groupId),
  })

  const { data: posts, isLoading: postsLoading } = useQuery({
    queryKey: ['facebook-group-posts', groupId, appliedDates],
    queryFn: () => facebookGroupPostsApi.list({ group: groupId, ...appliedDates }),
    enabled: Number.isFinite(groupId),
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
    mutationFn: (data: FacebookGroupPostCreate) =>
      editing ? facebookGroupPostsApi.update(editing.id, data) : facebookGroupPostsApi.create(data),
    onSuccess: () => {
      showToast(editing ? t('facebook.detail.postSaveSuccess') : t('facebook.detail.postCreateSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-group-posts', groupId] })
      closeModal()
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.detail.postSaveError'), 'error'),
  })

  const deleteMutation = useMutation({
    mutationFn: (postId: number) => facebookGroupPostsApi.delete(postId),
    onSuccess: () => {
      showToast(t('facebook.detail.postDeleteSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-group-posts', groupId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.detail.postDeleteError'), 'error'),
  })

  const publishNowMutation = useMutation({
    mutationFn: (postId: number) => {
      setPublishingPostId(postId)
      return facebookGroupPostsApi.publishNow(postId)
    },
    onSuccess: () => {
      showToast(t('facebook.detail.postPublishNowSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-group-posts', groupId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.detail.postPublishNowError'), 'error'),
    onSettled: () => setPublishingPostId(null),
  })

  // ── Scheduled-posts queries & mutations ──────────────────────────────────
  const { data: scheduledPosts, isLoading: scheduledLoading, refetch: refetchScheduled } = useQuery({
    queryKey: ['facebook-group-scheduled-posts', groupId],
    queryFn: () => facebookGroupScheduledPostsApi.list({ group: groupId }),
    enabled: Number.isFinite(groupId),
  })

  const filteredScheduled = useMemo(() => {
    return (scheduledPosts ?? []).filter((p) =>
      !scheduleStatusFilter || p.status === scheduleStatusFilter,
    )
  }, [scheduledPosts, scheduleStatusFilter])

  const saveScheduleMutation = useMutation({
    mutationFn: (data: Partial<FacebookGroupScheduledPostCreate>) =>
      facebookGroupScheduledPostsApi.update(editingSchedule!.id, data),
    onSuccess: () => {
      showToast(t('facebook.schedule.saveSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-group-scheduled-posts', groupId] })
      setEditingSchedule(null)
      setScheduleForm({})
      setScheduleFormError('')
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.schedule.saveError'), 'error'),
  })

  const deleteScheduleMutation = useMutation({
    mutationFn: (schedId: number) => facebookGroupScheduledPostsApi.delete(schedId),
    onSuccess: () => {
      showToast(t('facebook.schedule.deleteSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-group-scheduled-posts', groupId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.schedule.deleteError'), 'error'),
  })

  const publishScheduleNowMutation = useMutation({
    mutationFn: (schedId: number) => {
      setPublishingScheduledId(schedId)
      return facebookGroupScheduledPostsApi.publishNow(schedId)
    },
    onSuccess: () => {
      showToast(t('facebook.schedule.publishNowSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-group-scheduled-posts', groupId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.schedule.publishNowError'), 'error'),
    onSettled: () => setPublishingScheduledId(null),
  })

  const approveScheduleMutation = useMutation({
    mutationFn: (schedId: number) => facebookGroupScheduledPostsApi.approve(schedId),
    onSuccess: () => {
      showToast(t('facebook.groupSchedule.approveSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-group-scheduled-posts', groupId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.groupSchedule.approveError'), 'error'),
  })

  const rejectScheduleMutation = useMutation({
    mutationFn: (schedId: number) => facebookGroupScheduledPostsApi.reject(schedId),
    onSuccess: () => {
      showToast(t('facebook.groupSchedule.rejectSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-group-scheduled-posts', groupId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.groupSchedule.rejectError'), 'error'),
  })

  // ── Pending member posts ────────────────────────────────────────────────
  const {
    data: pendingMemberPosts,
    isLoading: pendingLoading,
    refetch: refetchPending,
  } = useQuery({
    queryKey: ['facebook-group-pending-member-posts', groupId],
    queryFn: () => facebookGroupPendingMemberPostsApi.list({ group: groupId }),
    enabled: Number.isFinite(groupId),
  })

  const syncPendingMutation = useMutation({
    mutationFn: () => facebookGroupsApi.syncPendingMemberPosts(groupId),
    onSuccess: (res) => {
      showToast(res.detail, 'success')
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.pendingMember.syncError'), 'error'),
  })

  const approvePendingMutation = useMutation({
    mutationFn: (id: number) => facebookGroupPendingMemberPostsApi.approve(id),
    onSuccess: () => {
      showToast(t('facebook.pendingMember.approveSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-group-pending-member-posts', groupId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.pendingMember.approveError'), 'error'),
  })

  const rejectPendingMutation = useMutation({
    mutationFn: (id: number) => facebookGroupPendingMemberPostsApi.reject(id),
    onSuccess: () => {
      showToast(t('facebook.pendingMember.rejectSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-group-pending-member-posts', groupId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.pendingMember.rejectError'), 'error'),
  })

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
      const result = await facebookGroupsApi.uploadCsv(groupId, url)
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
      qc.invalidateQueries({ queryKey: ['facebook-group-scheduled-posts', groupId] })
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('facebook.schedule.csvError'), 'error')
    } finally {
      setCsvUploading(false)
    }
  }

  async function handlePublishDue() {
    setPublishingDue(true)
    try {
      const result = await facebookGroupScheduledPostsApi.publishDue()
      showToast(
        t('facebook.schedule.publishDueSuccess', { published: result.published, failed: result.failed }),
        result.failed > 0 ? 'error' : 'success',
      )
      qc.invalidateQueries({ queryKey: ['facebook-group-scheduled-posts', groupId] })
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
      const result = await facebookGroupScheduledPostsApi.deletePending(groupId)
      showToast(t('facebook.schedule.deletePendingSuccess', { count: result.deleted }), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-group-scheduled-posts', groupId] })
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
        `Group name: ${group?.name ?? `Group #${groupId}`}`,
        `Group id: ${groupId}`,
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
        await facebookGroupScheduledPostsApi.create({
          group: groupId,
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
    qc.invalidateQueries({ queryKey: ['facebook-group-scheduled-posts', groupId] })

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

  function openEditSchedule(sp: FacebookGroupScheduledPost) {
    setEditingSchedule(sp)
    setScheduleForm({
      content: sp.content,
      image_urls: sp.image_urls,
      image_description: sp.image_description,
      scheduled_at: toLocalInputValue(sp.scheduled_at), // datetime-local in Vietnam time
      status: sp.status,
    })
    setScheduleFormError('')
  }

  function openCreate() {
    setEditing(null)
    setForm(makeDefaultForm(groupId))
    setKeywordInput('')
    setFormError('')
    setModalOpen(true)
  }

  function openEdit(post: FacebookGroupPost) {
    setEditing(post)
    setForm({
      group: groupId,
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
    setForm(makeDefaultForm(groupId))
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
      const { image_url } = await facebookGroupPostsApi.uploadImage(file)
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
        await facebookGroupPostsApi.create({ group: groupId, content: row.content, caption: row.caption, image_url: row.imageUrl, keywords: [], status: 'pending' })
        created++
      } catch { /* continue */ }
    }
    setBulkSaving(false)
    showToast(t('facebook.detail.bulkSaveSuccess', { count: created }), 'success')
    qc.invalidateQueries({ queryKey: ['facebook-group-posts', groupId] })
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
        const { image_url } = await facebookGroupPostsApi.uploadImage(file)
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

  if (Number.isFinite(groupId) === false) {
    return <div className="p-6 text-sm text-muted-foreground">{t('facebook.detail.pageNotFound')}</div>
  }

  return (
    <div className="flex flex-col gap-6">
      <button
        onClick={() => navigate('/facebook?tab=groups')}
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t('facebook.detail.back')}
      </button>

      {/* Page header */}
      {groupLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('common.loading')}
        </div>
      ) : group ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">{group.name}</h1>
              {group.group_url && (
                <a
                  href={group.group_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-3.5 shrink-0" />
                  <span className="truncate">{group.group_url}</span>
                </a>
              )}
              {group.description && <p className="mt-2 text-sm text-muted-foreground">{group.description}</p>}
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="size-4" />
              <span className="tabular-nums">{group.member_count.toLocaleString()}</span>
              <span>{t('facebook.detail.followers')}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">{t('facebook.detail.pageNotFound')}</div>
      )}

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-xl border border-border bg-muted/40 p-1">
        {(['posts', 'schedule', 'pending'] as const).map((tab) => (
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
            {tab === 'posts'
              ? t('facebook.detail.postsTitle')
              : tab === 'schedule'
                ? t('facebook.schedule.tabLabel')
                : t('facebook.pendingMember.tabLabel')}
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
              <FacebookSeedingPanel postId={seedingForPost.id} surface="group" />
            </div>
          </div>
        </div>
      )}

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
          {(['pending', 'published', 'failed', 'cancelled'] as FacebookScheduledPostStatus[]).map((s) => (
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
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Poster</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.schedule.colStatus')}</th>
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
                    {sp.poster_fb_profile_name ? (
                      <span className="inline-flex items-center rounded bg-sky-500/10 px-1.5 py-0.5 font-medium text-sky-600">
                        {sp.poster_fb_profile_name}
                      </span>
                    ) : (
                      <span className="text-destructive">— chưa gán —</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-col items-start gap-1">
                      <ScheduledPostStatusBadge status={sp.status} />
                      {sp.status === 'pending' && !sp.is_approved && (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600">
                          {t('facebook.groupSchedule.awaitingApproval')}
                        </span>
                      )}
                      {sp.status === 'pending' && sp.is_approved && (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-600">
                          {t('facebook.groupSchedule.approved')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      {sp.status === 'pending' && !sp.is_approved && (
                        <>
                          <button
                            onClick={() => approveScheduleMutation.mutate(sp.id)}
                            aria-label={t('facebook.groupSchedule.approveBtn')}
                            disabled={approveScheduleMutation.isPending}
                            className="flex items-center gap-1 rounded-lg border border-emerald-500/40 px-2 py-1 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <CheckCircle2 className="size-3.5" />
                            <span>{t('facebook.groupSchedule.approveBtn')}</span>
                          </button>
                          <button
                            onClick={() => {
                              if (!confirm(t('facebook.groupSchedule.rejectConfirm'))) return
                              rejectScheduleMutation.mutate(sp.id)
                            }}
                            aria-label={t('facebook.groupSchedule.rejectBtn')}
                            disabled={rejectScheduleMutation.isPending}
                            className="flex items-center gap-1 rounded-lg border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <XCircle className="size-3.5" />
                            <span>{t('facebook.groupSchedule.rejectBtn')}</span>
                          </button>
                        </>
                      )}
                      {sp.status !== 'published' && sp.status !== 'cancelled' && sp.is_approved && (
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
                      {sp.status === 'pending' && (
                        <button
                          onClick={() => openEditSchedule(sp)}
                          aria-label={t('common.edit')}
                          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <Pencil className="size-4" />
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
              {group?.default_poster_fb_profile ? (
                <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs">
                  <p className="text-sky-700">
                    Bài đăng sẽ do <strong>{group.default_poster_fb_profile_name}</strong> tap nút Đăng (ẩn danh).
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                  <p className="font-medium text-amber-700">⚠ Group chưa cấu hình Poster mặc định.</p>
                  <p className="mt-0.5 text-amber-700/80">
                    Bài import vẫn được tạo nhưng sẽ FAIL khi cron fire. Vào Sửa
                    group để chọn FB profile làm poster, hoặc gán thủ công từng
                    row.
                  </p>
                </div>
              )}
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
            </div>
            <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-4">
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

  {activeTab === 'pending' && (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('facebook.pendingMember.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('facebook.pendingMember.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetchPending()}
            disabled={pendingLoading}
          >
            {pendingLoading ? <Loader2 className="size-3.5 animate-spin" /> : t('common.refresh')}
          </Button>
          <Button
            size="sm"
            onClick={() => syncPendingMutation.mutate()}
            disabled={syncPendingMutation.isPending}
          >
            {syncPendingMutation.isPending
              ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />{t('facebook.pendingMember.syncing')}</>
              : <><Upload className="mr-1.5 size-3.5" />{t('facebook.pendingMember.syncBtn')}</>}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {pendingLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('common.loading')}
          </div>
        ) : (pendingMemberPosts ?? []).length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t('facebook.pendingMember.empty')}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pendingMember.colPostedAt')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pendingMember.colAuthor')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pendingMember.colContent')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pendingMember.colStatus')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pendingMember.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(pendingMemberPosts ?? []).map((pp) => {
                const statusColors: Record<typeof pp.status, string> = {
                  queued: 'bg-amber-500/10 text-amber-600',
                  processing: 'bg-blue-500/10 text-blue-600',
                  approved: 'bg-emerald-500/10 text-emerald-600',
                  rejected: 'bg-muted text-muted-foreground',
                  failed: 'bg-destructive/10 text-destructive',
                }
                return (
                  <tr key={pp.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                      {pp.posted_at ? formatDateTime(pp.posted_at) : '—'}
                    </td>
                    <td className="px-4 py-2.5 max-w-[160px] text-xs">
                      <p className="line-clamp-1">{pp.author_name || '—'}</p>
                      {pp.pending_tab === 'maybe_spam' ? (
                        <span className="mt-0.5 inline-flex items-center rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-600">
                          Có thể là spam
                        </span>
                      ) : (
                        <span className="mt-0.5 inline-flex items-center rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-600">
                          Chờ duyệt
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 max-w-[320px]">
                      {pp.post_url && (
                        <a
                          href={pp.post_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-600 hover:underline"
                        >
                          {t('facebook.pendingMember.viewOnFb')} <ExternalLink className="inline size-3" />
                        </a>
                      )}
                      <p className="line-clamp-2 text-xs text-foreground">{pp.content || '—'}</p>
                      {pp.error_msg && (
                        <p className="mt-0.5 line-clamp-1 text-[10px] text-destructive">{pp.error_msg}</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${statusColors[pp.status]}`}>
                        {t(`facebook.pendingMember.status_${pp.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        {pp.status === 'queued' && (
                          <>
                            <button
                              onClick={() => approvePendingMutation.mutate(pp.id)}
                              aria-label={t('facebook.pendingMember.approveBtn')}
                              disabled={approvePendingMutation.isPending}
                              className="flex items-center gap-1 rounded-lg border border-emerald-500/40 px-2 py-1 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <CheckCircle2 className="size-3.5" />
                              <span>{t('facebook.pendingMember.approveBtn')}</span>
                            </button>
                            <button
                              onClick={() => {
                                if (!confirm(t('facebook.pendingMember.rejectConfirm'))) return
                                rejectPendingMutation.mutate(pp.id)
                              }}
                              aria-label={t('facebook.pendingMember.rejectBtn')}
                              disabled={rejectPendingMutation.isPending}
                              className="flex items-center gap-1 rounded-lg border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <XCircle className="size-3.5" />
                              <span>{t('facebook.pendingMember.rejectBtn')}</span>
                            </button>
                          </>
                        )}
                        {pp.status === 'failed' && (
                          <button
                            onClick={() => approvePendingMutation.mutate(pp.id)}
                            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
                          >
                            <Send className="size-3.5" />
                            <span>{t('facebook.pendingMember.retryBtn')}</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  )}
  </div>
  )
}
