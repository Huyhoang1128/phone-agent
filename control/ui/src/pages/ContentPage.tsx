import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowDownWideNarrow,
  Bot,
  CalendarClock,
  Clapperboard,
  Clock3,
  Database,
  Eye,
  ExternalLink,
  FileText,
  Globe,
  Heart,
  Link2,
  MessageCircle,
  Share2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Smartphone,
  Trash2,
  Users,
  X,
  Sparkles,
  ClipboardCheck,
} from 'lucide-react'
import ScenarioGenerateModal from '@/components/scenario/ScenarioGenerateModal'
import { Button } from '@/components/ui/button'
import { ShareButton } from '@/components/ShareResourceDialog'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { contentsApi, contentScenariosApi, crawlSourcesApi, devicesApi, facebookPagesApi, facebookScheduledPostsApi, profilesApi, schedulesApi, tasksApi, teamsApi, tiktokApi } from '@/lib/api'
import type { ContentListParams } from '@/lib/api'
import type {
  ContentItem,
  ContentItemCreate,
  ContentScenarioItem,
  FacebookPage,
  GeneratedScript,
  CrawlSource,
  CrawlSourceCreate,
  CrawlSourceType,
  PaginatedResponse,
  Profile,
  Schedule,
  Task,
  TeamPermission,
  TiktokChannelResearchVideo,
  TiktokChannelResearchResponse,
} from '@/lib/types'

// 'YYYY-MM-DD' in the browser's local timezone — matches the date inputs and
// the date filter applied by the backend.
function todayLocalISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type DateFilterMode = 'today' | 'range' | 'all'

const PAGE_SIZE = 20
const SETTINGS_STORAGE_KEY = 'content-sharing-settings'
const SHORT_VIDEO_MAX_DURATION_SECONDS = 30
const MEDIUM_VIDEO_MAX_DURATION_SECONDS = 90
// Hard cap aligned with the BE: keep the FE from accepting files the
// generate-scripts proxy will reject anyway.
const MAX_SCENARIO_BYTES = 10 * 1024 * 1024 // 10 MB
const REPOST_AI_FEATURE_ID = 'content_repost_ai'

const DEFAULT_FORM: ContentItemCreate = {
  title: '',
  video_url: '',
  image_urls: [],
  text_content: '',
  file_url: '',
  script: '',
}

const SOCIAL_SOURCE_TYPES: CrawlSourceType[] = ['facebook', 'tiktok', 'youtube', 'threads']

const DEFAULT_CRAWL_FORM: CrawlSourceCreate = {
  url: '',
  source_type: 'web',
  device_id: null,
  crawl_frequency_minutes: 60,
  is_active: true,
}

function formatFrequency(minutes: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (minutes < 60) return t('content.crawl.freqMinutes', { count: minutes })
  const hours = minutes / 60
  if (Number.isInteger(hours)) return t('content.crawl.freqHours', { count: hours })
  return t('content.crawl.freqMinutesWithHours', { minutes, hours: (hours).toFixed(1) })
}

type ContentSharingSettings = {
  autoShare: boolean
  teamId: number | ''
  permission: TeamPermission
}

const DEFAULT_SETTINGS: ContentSharingSettings = {
  autoShare: false,
  teamId: '',
  permission: 'view',
}

function parseSharingSettings(raw: string | null): ContentSharingSettings {
  if (!raw) return DEFAULT_SETTINGS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS
    const obj = parsed as Record<string, unknown>
    return {
      autoShare: obj.autoShare === true,
      teamId: typeof obj.teamId === 'number' ? obj.teamId : '',
      permission: obj.permission === 'edit' ? 'edit' : 'view',
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function readFromLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeToLocalStorage(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

type Tab = 'edit' | 'source' | 'research' | 'publish' | 'scenario' | 'approval'
type PublishPlatform = 'tiktok' | 'facebook' | 'youtube'

type PublishScheduleItem = {
  id: number
  contentTitle: string
  platform: PublishPlatform
  publishAt: string | null
  profileName: string | null
  status: Schedule['status']
}

type ResearchChannelComparison = {
  channelUrl: string
  videoCount: number
  averageEngagementRate: number
  averageViews: number
  averageLikes: number
  averageComments: number
  averageShares: number
}

type CreatePublishScheduleInput = {
  content: ContentItem
  platform: PublishPlatform
  profile: Profile | null
  publishAt: string
}


function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
}

function toDateTimeLocalInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function buildQuickScheduleDate(base: Date, dayOffset: number, hour: number, minute = 0, keepFuture = false): Date {
  const next = new Date(base)
  next.setDate(next.getDate() + dayOffset)
  next.setHours(hour, minute, 0, 0)
  if (keepFuture && next.getTime() <= base.getTime()) {
    next.setDate(next.getDate() + 1)
  }
  return next
}

function parseImageUrls(input: string) {
  const urls = input
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
  return urls.length > 0 ? urls : []
}

function clampNumberInput(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function calculateVideoMetrics(video: TiktokChannelResearchVideo) {
  const views = Number(video.view_count) || 0
  const likes = Number(video.like_count) || 0
  const comments = Number(video.comment_count) || 0
  const shares = Number(video.share_count) || 0
  const engagementRate = views > 0 ? (likes + comments + shares) / views : 0
  const lengthBucket =
    video.duration < SHORT_VIDEO_MAX_DURATION_SECONDS
      ? 'short'
      : video.duration <= MEDIUM_VIDEO_MAX_DURATION_SECONDS
        ? 'medium'
        : 'long'
  const publishedAt = video.published_at ? new Date(video.published_at) : null
  const elapsedHours =
    publishedAt && Number.isFinite(publishedAt.getTime())
      ? Math.max((Date.now() - publishedAt.getTime()) / (1000 * 60 * 60), 0)
      : null
  const viewVelocity = elapsedHours && elapsedHours > 0 ? views / elapsedHours : null
  return { engagementRate, lengthBucket, viewVelocity }
}

function calculateResearchChannelComparison(result: TiktokChannelResearchResponse): ResearchChannelComparison {
  const videoCount = result.videos.length
  if (videoCount === 0) {
    return {
      channelUrl: result.channel_url,
      videoCount,
      averageEngagementRate: 0,
      averageViews: 0,
      averageLikes: 0,
      averageComments: 0,
      averageShares: 0,
    }
  }
  const totals = result.videos.reduce(
    (acc, video) => {
      const metrics = calculateVideoMetrics(video)
      acc.engagementRate += metrics.engagementRate
      acc.views += Number(video.view_count) || 0
      acc.likes += Number(video.like_count) || 0
      acc.comments += Number(video.comment_count) || 0
      acc.shares += Number(video.share_count) || 0
      return acc
    },
    { engagementRate: 0, views: 0, likes: 0, comments: 0, shares: 0 },
  )
  return {
    channelUrl: result.channel_url,
    videoCount,
    averageEngagementRate: totals.engagementRate / videoCount,
    averageViews: totals.views / videoCount,
    averageLikes: totals.likes / videoCount,
    averageComments: totals.comments / videoCount,
    averageShares: totals.shares / videoCount,
  }
}

function compareVideosByMetricsDescending(left: TiktokChannelResearchVideo, right: TiktokChannelResearchVideo) {
  const leftMetrics = calculateVideoMetrics(left)
  const rightMetrics = calculateVideoMetrics(right)

  const leftEngagementRate = leftMetrics.engagementRate ?? -1
  const rightEngagementRate = rightMetrics.engagementRate ?? -1
  if (leftEngagementRate !== rightEngagementRate) {
    return rightEngagementRate - leftEngagementRate
  }

  const leftVelocity = leftMetrics.viewVelocity ?? -1
  const rightVelocity = rightMetrics.viewVelocity ?? -1
  if (leftVelocity !== rightVelocity) {
    return rightVelocity - leftVelocity
  }

  if (left.view_count !== right.view_count) {
    return right.view_count - left.view_count
  }
  if (left.like_count !== right.like_count) {
    return right.like_count - left.like_count
  }
  return right.comment_count - left.comment_count
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

function getResearchCompareRankClassName(index: number) {
  if (index === 0) return 'border-amber-400/50 bg-amber-500/10'
  if (index === 1) return 'border-slate-300/70 bg-slate-500/10'
  return 'border-violet-300/60 bg-background/80'
}

function readPublishPayload(schedule: Schedule): Record<string, unknown> | null {
  const payload = schedule.task.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  return payload
}

function toPublishScheduleItem(schedule: Schedule): PublishScheduleItem | null {
  const payload = readPublishPayload(schedule)
  if (!payload) {
    return null
  }
  const isPublish = payload.source === 'content-publish'
  const isTiktokRepost = payload.agent === 'tiktok' && payload.link_download
  
  if (!isPublish && !isTiktokRepost) {
    return null
  }
  
  const platform = isPublish ? (payload.platform as PublishPlatform) : 'tiktok'
  if (platform !== 'tiktok' && platform !== 'facebook' && platform !== 'youtube') {
    return null
  }
  const contentTitle =
    isPublish && typeof payload.content_title === 'string' && payload.content_title.trim()
      ? payload.content_title
      : schedule.task.name
  return {
    id: schedule.id,
    contentTitle,
    platform,
    publishAt:
      schedule.status === 'completed'
        ? schedule.last_run_at ?? schedule.run_at ?? schedule.next_run_at ?? null
        : schedule.run_at ?? schedule.next_run_at ?? null,
    profileName: schedule.profile_name ?? null,
    status: schedule.status,
  }
}

async function createContentPublishSchedule({
  content,
  platform,
  profile,
  publishAt,
}: CreatePublishScheduleInput) {
  const publishAtIso = new Date(publishAt).toISOString()
  let taskId: number | null = null
  try {
    const task = await tasksApi.create({
      name: `${content.title} • ${profile?.name ?? platform}`,
      description: `Scheduled ${platform} publish for ${content.title}`,
      task_type: 'generic',
      status: 'pending',
      payload: {
        agent: platform,
        source: 'content-publish',
        content_id: content.id,
        content_title: content.title,
        platform,
        publish_at: publishAtIso,
        video_url: content.video_url,
        image_urls: content.image_urls ?? [],
        text_content: content.text_content ?? '',
        file_url: content.file_url ?? '',
        script: content.script,
      },
    })
    taskId = task.id
    if (typeof content.team_id === 'number') {
      await tasksApi.share(task.id, content.team_id, content.team_permission)
    }
    return schedulesApi.create({
      task: task.id,
      profile: profile?.id ?? null,
      schedule_type: 'once',
      run_at: publishAtIso,
      max_retries: 0,
      retry_delay_seconds: 60,
    })
  } catch (err) {
    if (taskId !== null) {
      try {
        await tasksApi.delete(taskId)
      } catch (cleanupErr) {
        console.error('Failed to clean up publish task after schedule creation error:', cleanupErr)
        const message = err instanceof Error ? err.message : 'Failed to create publish schedule'
        const cleanupMessage =
          cleanupErr instanceof Error ? cleanupErr.message : 'Failed to clean up temporary publish task'
        throw new Error(`${message}. ${cleanupMessage}`)
      }
    }
    throw err
  }
}

export default function ContentPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const { user } = useAuth()

  const [activeTab, setActiveTab] = useState<Tab>(() => {
    // v3.2.1 — cho phép navigate('/content', { state: { tab: 'scenario' } }) hoặc
    // dùng query param ?tab=scenario (cho link sidebar / redirect /content-scenarios/).
    const stateTab = (location.state as { tab?: Tab } | null)?.tab
    const params = new URLSearchParams(location.search)
    const queryTab = params.get('tab') as Tab | null
    const initTab = stateTab || queryTab
    return initTab && ['edit', 'source', 'research', 'publish', 'scenario', 'approval'].includes(initTab) ? initTab : 'edit'
  })
  const [editedCaptions, setEditedCaptions] = useState<Record<number, string>>({})
  const [editedHashtags, setEditedHashtags] = useState<Record<number, string>>({})
  const [modalOpen, setModalOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [genModalOpen, setGenModalOpen] = useState(false)
  const [aiScenarioOpen, setAiScenarioOpen] = useState(false)
  const [editing, setEditing] = useState<ContentItem | null>(null)
  const [form, setForm] = useState<ContentItemCreate>(DEFAULT_FORM)
  const [imageUrlsInput, setImageUrlsInput] = useState('')
  const [formError, setFormError] = useState('')
  // ── Gen Content (AI) state ──────────────────────────────────────────────
  // Form inputs for the n8n-backed flow:
  const [genOrderDescription, setGenOrderDescription] = useState('')
  const [genFile, setGenFile] = useState<File | null>(null)
  const [genMode, setGenMode] = useState<'real_footage' | 'ai_video'>('real_footage')
  const [genError, setGenError] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  // Response from POST /api/contents/generate-scripts/ :
  const [generatedScripts, setGeneratedScripts] = useState<GeneratedScript[]>([])
  const [parentScenarioFilename, setParentScenarioFilename] = useState('')
  // Per-KB checkbox state — the user picks which ones to persist.
  const [selectedKbIndexes, setSelectedKbIndexes] = useState<Set<number>>(new Set())
  const [isSavingGenerated, setIsSavingGenerated] = useState(false)
  // Which KB is currently open in the detail popup (null = list view).
  const [detailScriptIndex, setDetailScriptIndex] = useState<number | null>(null)
  const [sharingSettings, setSharingSettings] = useState<ContentSharingSettings>(() =>
    parseSharingSettings(readFromLocalStorage(SETTINGS_STORAGE_KEY)),
  )
  const [settingsError, setSettingsError] = useState('')
  const [researchUrl, setResearchUrl] = useState('')
  const [researchCompareChannelsInput, setResearchCompareChannelsInput] = useState('')
  const [researchMaxVideos, setResearchMaxVideos] = useState(100)
  const [researchNoCache, setResearchNoCache] = useState(false)
  const [researchLoading, setResearchLoading] = useState(false)
  const [researchCompareLoading, setResearchCompareLoading] = useState(false)
  const [researchKeywordExtractLoading, setResearchKeywordExtractLoading] = useState(false)
  const [researchMetricsReady, setResearchMetricsReady] = useState(false)
  const [researchProcessingVideoIds, setResearchProcessingVideoIds] = useState<Set<number>>(new Set())
  const [researchResult, setResearchResult] = useState<TiktokChannelResearchResponse | null>(null)
  const [researchVideoLanguage, setResearchVideoLanguage] = useState('vi')

  // ── Repost state ──────────────────────────────────────────────────────
  const [repostModalVideo, setRepostModalVideo] = useState<TiktokChannelResearchVideo | null>(null)
  const [repostPlatform, setRepostPlatform] = useState<'facebook' | 'youtube' | 'tiktok'>('facebook')
  const [repostFbPageId, setRepostFbPageId] = useState<number | null>(null)
  const [repostYoutubeProfileId, setRepostYoutubeProfileId] = useState<number | null>(null)
  const [repostContent, setRepostContent] = useState('')
  const [repostAiLoading, setRepostAiLoading] = useState(false)
  const [repostAiSettingsOpen, setRepostAiSettingsOpen] = useState(false)
  const [repostAiSystemPrompt, setRepostAiSystemPrompt] = useState('')
  const [repostAiSettingsLoading, setRepostAiSettingsLoading] = useState(false)
  const [repostAiSettingsSaving, setRepostAiSettingsSaving] = useState(false)
  const [repostAiSettingsError, setRepostAiSettingsError] = useState('')
  const [repostScheduledAt, setRepostScheduledAt] = useState('')
  const [repostLoading, setRepostLoading] = useState(false)
  const [repostLoadingStep, setRepostLoadingStep] = useState('')
  const [repostError, setRepostError] = useState('')
  const [repostAllModalOpen, setRepostAllModalOpen] = useState(false)
  const [repostAllPlatform, setRepostAllPlatform] = useState<'facebook' | 'tiktok'>('facebook')
  const [repostAllFbPageId, setRepostAllFbPageId] = useState<number | null>(null)
  const [repostAllTiktokProfileId, setRepostAllTiktokProfileId] = useState<number | null>(null)
  const [repostAllScheduleMode, setRepostAllScheduleMode] = useState<'every30' | 'interval'>('every30')
  const [repostAllInterval, setRepostAllInterval] = useState(30)
  const [repostAllScheduledAt, setRepostAllScheduledAt] = useState('')
  const [repostAllCount, setRepostAllCount] = useState<number | ''>(10)
  const [repostAllLoading, setRepostAllLoading] = useState(false)
  const [repostAllError, setRepostAllError] = useState('')
  const [processAllLoading, setProcessAllLoading] = useState(false)
  const [processAllProgress, setProcessAllProgress] = useState<{ current: number; total: number } | null>(null)
  // TikTok repost state
  const [repostTiktokProfileId, setRepostTiktokProfileId] = useState<number | null>(null)
  const [repostTiktokContentText, setRepostTiktokContentText] = useState('')
  const [repostTiktokBackground, setRepostTiktokBackground] = useState('')
  const [repostTiktokMusicType, setRepostTiktokMusicType] = useState<'default' | 'custom'>('default')
  const [repostTiktokMusicPath, setRepostTiktokMusicPath] = useState('')
  const [repostTiktokMusicFile, setRepostTiktokMusicFile] = useState<File | null>(null)
  const [repostTiktokRefImage, setRepostTiktokRefImage] = useState<File | null>(null)
  const [repostTiktokStyle, setRepostTiktokStyle] = useState('healing')
  const [repostTiktokDuration, setRepostTiktokDuration] = useState<number | ''>('')
  const [repostTiktokScheduledAt, setRepostTiktokScheduledAt] = useState('')
  const [repostTiktokAnimation, setRepostTiktokAnimation] = useState(false)
  const fbModalOpen = repostModalVideo !== null || repostAllModalOpen
  const [researchKeywordResult, setResearchKeywordResult] = useState<string[]>([])
  const [researchCompareResults, setResearchCompareResults] = useState<ResearchChannelComparison[]>([])
  const [researchError, setResearchError] = useState('')
  const [selectedPublishContentId, setSelectedPublishContentId] = useState<number | null>(null)
  const [publishPlatform, setPublishPlatform] = useState<PublishPlatform>('tiktok')
  const [publishAt, setPublishAt] = useState('')
  const [publishProfileId, setPublishProfileId] = useState<number | null>(null)
  const [publishFormError, setPublishFormError] = useState('')

  // Crawl source state
  const [crawlModalOpen, setCrawlModalOpen] = useState(false)
  const [editingCrawl, setEditingCrawl] = useState<CrawlSource | null>(null)
  const [crawlForm, setCrawlForm] = useState<CrawlSourceCreate>(DEFAULT_CRAWL_FORM)
  const [crawlFormError, setCrawlFormError] = useState('')

  // ── List filter state ──────────────────────────────────────────────────
  // Backend does the filtering & pagination so the FE only mirrors the user's
  // choices into query params. Default is "today" — matches the old behaviour.
  const [dateMode, setDateMode] = useState<DateFilterMode>('today')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [page, setPage] = useState(1)

  const listParams = useMemo<ContentListParams>(() => {
    const p: ContentListParams = { page, page_size: PAGE_SIZE }
    if (dateMode === 'today') {
      const today = todayLocalISO()
      p.date_from = today
      p.date_to = today
    } else if (dateMode === 'range') {
      if (dateFrom) p.date_from = dateFrom
      if (dateTo) p.date_to = dateTo
    }
    // 'all' → no date filter at all
    if (appliedSearch) p.search = appliedSearch
    return p
  }, [dateMode, dateFrom, dateTo, appliedSearch, page])

  const { data: paginated, isLoading, refetch } = useQuery<PaginatedResponse<ContentItem>>({
    queryKey: ['contents', listParams],
    queryFn: () => contentsApi.list(listParams),
  })
  const items: ContentItem[] = paginated?.results ?? []
  const totalCount = paginated?.count ?? 0
  const hasPrevPage = Boolean(paginated?.previous)
  const hasNextPage = Boolean(paginated?.next)
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: teamsApi.list,
    enabled: settingsOpen,
  })

  const { data: crawlSources = [], isLoading: crawlLoading, refetch: refetchCrawl } = useQuery<CrawlSource[]>({
    queryKey: ['crawl-sources'],
    queryFn: crawlSourcesApi.list,
    enabled: activeTab === 'source',
  })

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list(),
    enabled: crawlModalOpen,
  })

  // v3.2.1 — AI Scenario list (tab thứ 5). BE trả array trần (không paginated),
  // FE handle bằng cách annotate response type là `ContentScenarioItem[] | PaginatedResponse<>`.
  const { data: scenarioListRaw, isLoading: scenariosLoading } = useQuery<
    ContentScenarioItem[] | PaginatedResponse<ContentScenarioItem>
  >({
    queryKey: ['content-scenarios-list'],
    queryFn: () => contentScenariosApi.list() as Promise<any>,
    enabled: activeTab === 'scenario',
  })
  const scenariosList: ContentScenarioItem[] = Array.isArray(scenarioListRaw)
    ? scenarioListRaw
    : (scenarioListRaw?.results || [])

  const deleteScenarioMutation = useMutation({
    mutationFn: (id: number) => contentScenariosApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['content-scenarios-list'] })
      showToast(t('content.aiScenario.deleteSuccess', { defaultValue: 'Đã xoá kịch bản' }), 'success')
    },
    onError: (e: Error) => showToast(e.message || 'Delete failed', 'error'),
  })

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ['profiles'],
    queryFn: profilesApi.list,
    enabled: activeTab === 'publish' || activeTab === 'approval' || (repostModalVideo !== null && (repostPlatform === 'tiktok' || repostPlatform === 'youtube')) || (repostAllModalOpen && repostAllPlatform === 'tiktok'),
  })

  const { data: pendingApprovalTasksData, isLoading: pendingApprovalLoading, refetch: refetchPendingApproval } = useQuery<PaginatedResponse<Task>>({
    queryKey: ['pending-approval-tasks'],
    queryFn: () => tasksApi.list({ status: 'pending_approval,pending' }),
    enabled: activeTab === 'approval',
  })
  const pendingApprovalTasks = useMemo(() => {
    const rawList = pendingApprovalTasksData?.results ?? []
    return rawList.filter((task) => {
      const payload = (task.payload || {}) as Record<string, any>
      return payload.agent === 'tiktok' && payload.link_download
    })
  }, [pendingApprovalTasksData])

  const approveTaskMutation = useMutation({
    mutationFn: ({ id, caption, hashtags }: { id: number; caption?: string; hashtags?: string[] }) =>
      tasksApi.approve(id, { caption, hashtags }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending-approval-tasks'] })
      showToast(t('content.approvalCardApproveSuccess'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('content.approvalCardApproveError'), 'error'),
  })

  const rejectTaskMutation = useMutation({
    mutationFn: (id: number) => tasksApi.reject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending-approval-tasks'] })
      showToast(t('content.approvalCardRejectSuccess'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('content.approvalCardRejectError'), 'error'),
  })

  const updateScheduleTimeMutation = useMutation({
    mutationFn: ({ id, scheduledAt }: { id: number; scheduledAt: string }) =>
      tasksApi.updateScheduleTime(id, scheduledAt),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending-approval-tasks'] })
      showToast(t('content.approvalCardUpdateScheduleSuccess'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('content.approvalCardUpdateScheduleError'), 'error'),
  })

  const updateTaskProfileMutation = useMutation({
    mutationFn: ({ id, profileId }: { id: number; profileId: number | null }) =>
      tasksApi.updateTaskProfile(id, profileId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending-approval-tasks'] })
      showToast(t('content.approvalCardUpdateProfileSuccess'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('content.approvalCardUpdateProfileError'), 'error'),
  })

  const deleteApprovalTaskMutation = useMutation({
    mutationFn: (id: number) => tasksApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending-approval-tasks'] })
      showToast(t('content.approvalCardDeleteSuccess'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('content.approvalCardDeleteError'), 'error'),
  })

  const { data: schedules = [], isLoading: publishSchedulesLoading } = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: schedulesApi.list,
    enabled: activeTab === 'publish',
  })

  const { data: facebookPages = [] } = useQuery<FacebookPage[]>({
    queryKey: ['facebook-pages'],
    queryFn: () => facebookPagesApi.list(),
    enabled: fbModalOpen,
  })

  const researchInsightCards = useMemo(() => {
    if (!researchResult) return []

    const comparison = calculateResearchChannelComparison(researchResult)
    const velocityValues = researchResult.videos
      .map((video) => calculateVideoMetrics(video).viewVelocity)
      .filter((value): value is number => value !== null)
    const averageVelocity =
      velocityValues.length > 0
        ? velocityValues.reduce((sum, value) => sum + value, 0) / velocityValues.length
        : null
    const lengthCounts = researchResult.videos.reduce<Record<'short' | 'medium' | 'long', number>>(
      (acc, video) => {
        const lengthBucket = calculateVideoMetrics(video).lengthBucket as 'short' | 'medium' | 'long'
        acc[lengthBucket] += 1
        return acc
      },
      { short: 0, medium: 0, long: 0 },
    )
    const dominantLengthBucket = (Object.entries(lengthCounts).sort((left, right) => right[1] - left[1])[0]?.[0] ??
      'short') as 'short' | 'medium' | 'long'

    return [
      {
        label: t('content.researchTotalVideos'),
        value: String(researchResult.count),
        helper: researchResult.cache_hit ? t('content.researchSourceCache') : t('content.researchSourceFresh'),
        Icon: Clapperboard,
        className:
          'border-sky-400/40 bg-[linear-gradient(135deg,rgba(14,165,233,0.14),rgba(59,130,246,0.08))]',
      },
      {
        label: t('content.researchEngagementRate'),
        value: `${(comparison.averageEngagementRate * 100).toFixed(2)}%`,
        helper: `${t('content.researchAverageViews')}: ${formatCompactNumber(comparison.averageViews)}`,
        Icon: Heart,
        className:
          'border-violet-400/40 bg-[linear-gradient(135deg,rgba(168,85,247,0.14),rgba(99,102,241,0.08))]',
      },
      {
        label: t('content.researchViewVelocity'),
        value: averageVelocity === null ? '—' : formatCompactNumber(averageVelocity),
        helper: `${t('content.researchAverageComments')}: ${formatCompactNumber(comparison.averageComments)}`,
        Icon: ArrowDownWideNarrow,
        className:
          'border-emerald-400/40 bg-[linear-gradient(135deg,rgba(16,185,129,0.14),rgba(34,197,94,0.08))]',
      },
      {
        label: t('content.researchLengthBucket'),
        value: t(`content.researchLengthBucketValue.${dominantLengthBucket}`),
        helper:
          researchResult.last_crawled_at
            ? `${t('content.researchLastCrawledAt')}: ${formatDateTime(researchResult.last_crawled_at)}`
            : t('content.researchDesc'),
        Icon: CalendarClock,
        className:
          'border-amber-400/40 bg-[linear-gradient(135deg,rgba(251,191,36,0.16),rgba(249,115,22,0.08))]',
      },
    ]
  }, [researchResult, t])

  const researchKeywordPalette = [
    'border-sky-400/40 bg-sky-500/10 text-sky-700 dark:text-sky-200',
    'border-violet-400/40 bg-violet-500/10 text-violet-700 dark:text-violet-200',
    'border-emerald-400/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200',
    'border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-200',
  ]

  const repostQuickScheduleOptions = useMemo(() => {
    const now = new Date()
    return [
      {
        key: 'tonight-20',
        label: t('content.repostQuickTimeTonight'),
        value: toDateTimeLocalInputValue(buildQuickScheduleDate(now, 0, 20, 0, true)),
      },
      {
        key: 'tomorrow-8',
        label: t('content.repostQuickTimeTomorrowMorning'),
        value: toDateTimeLocalInputValue(buildQuickScheduleDate(now, 1, 8)),
      },
      {
        key: 'tomorrow-12',
        label: t('content.repostQuickTimeTomorrowNoon'),
        value: toDateTimeLocalInputValue(buildQuickScheduleDate(now, 1, 12)),
      },
      {
        key: 'day-after-19',
        label: t('content.repostQuickTimeDayAfterEvening'),
        value: toDateTimeLocalInputValue(buildQuickScheduleDate(now, 2, 19)),
      },
    ]
  }, [t])

  const createMutation = useMutation({
    mutationFn: contentsApi.create,
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<ContentItemCreate> }) =>
      contentsApi.update(id, data),
  })

  const deleteMutation = useMutation({
    mutationFn: contentsApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contents'] })
      showToast(t('content.deleteSuccess'), 'success')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const createCrawlMutation = useMutation({
    mutationFn: crawlSourcesApi.create,
  })

  const updateCrawlMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<CrawlSourceCreate> }) =>
      crawlSourcesApi.update(id, data),
  })

  const deleteCrawlMutation = useMutation({
    mutationFn: crawlSourcesApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crawl-sources'] })
      showToast(t('content.crawl.deleteSuccess'), 'success')
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const createPublishScheduleMutation = useMutation({
    mutationFn: createContentPublishSchedule,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['schedules'] })
      qc.invalidateQueries({ queryKey: ['profile-schedules'] })
      setPublishAt('')
      setPublishFormError('')
      showToast(t('content.publishCreateSuccess'), 'success')
    },
    onError: (err: Error) => {
      setPublishFormError(err.message)
      showToast(err.message, 'error')
    },
  })

  const deletePublishScheduleMutation = useMutation({
    mutationFn: schedulesApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['schedules'] })
      qc.invalidateQueries({ queryKey: ['profile-schedules'] })
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  })

  const selectedPublishContent = useMemo(
    () => items.find((item) => item.id === selectedPublishContentId) ?? null,
    [items, selectedPublishContentId],
  )

  const publishQueue = useMemo(
    () => schedules.map(toPublishScheduleItem).filter((item): item is PublishScheduleItem => item !== null),
    [schedules],
  )

  const pendingPublishQueue = useMemo(
    () => publishQueue.filter((item) => item.status !== 'completed'),
    [publishQueue],
  )

  const publishedQueue = useMemo(
    () => publishQueue.filter((item) => item.status === 'completed'),
    [publishQueue],
  )

  async function handleSubmit() {
    if (!form.title?.trim()) {
      setFormError(t('content.titleRequired'))
      return
    }
    setFormError('')
    const payload: ContentItemCreate = {
      ...form,
      image_urls: parseImageUrls(imageUrlsInput),
    }
    try {
      if (editing) {
        await updateMutation.mutateAsync({ id: editing.id, data: payload })
        showToast(t('common.saveSuccess'), 'success')
      } else {
        const created = await createMutation.mutateAsync(payload)
        if (sharingSettings.autoShare && typeof sharingSettings.teamId === 'number') {
          try {
            await contentsApi.share(created.id, sharingSettings.teamId, sharingSettings.permission)
          } catch (err) {
            const message = err instanceof Error ? err.message : t('common.saveError')
            showToast(t('content.shareAutoFailed', { reason: message }), 'error')
          }
        }
        showToast(t('common.createSuccess'), 'success')
      }
      qc.invalidateQueries({ queryKey: ['contents'] })
      closeModal()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.saveError')
      setFormError(message)
      showToast(message, 'error')
    }
  }

  function openCreate() {
    setEditing(null)
    setForm(DEFAULT_FORM)
    setImageUrlsInput('')
    setFormError('')
    setModalOpen(true)
  }

  function openGenerate() {
    setGenError('')
    setGenOrderDescription('')
    setGenFile(null)
    setGeneratedScripts([])
    setParentScenarioFilename('')
    setSelectedKbIndexes(new Set())
    setDetailScriptIndex(null)
    setGenModalOpen(true)
  }

  function openEdit(item: ContentItem) {
    setEditing(item)
    setForm({
      title: item.title,
      video_url: item.video_url,
      image_urls: item.image_urls ?? [],
      text_content: item.text_content ?? '',
      file_url: item.file_url ?? '',
      script: item.script,
    })
    setImageUrlsInput(Array.isArray(item.image_urls) ? item.image_urls.join('\n') : '')
    setFormError('')
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setEditing(null)
    setForm(DEFAULT_FORM)
    setImageUrlsInput('')
    setFormError('')
  }

  function closeGenerateModal() {
    setIsGenerating(false)
    setIsSavingGenerated(false)
    setGenModalOpen(false)
    setGenError('')
    setGenOrderDescription('')
    setGenFile(null)
    setGeneratedScripts([])
    setParentScenarioFilename('')
    setSelectedKbIndexes(new Set())
    setDetailScriptIndex(null)
  }

  function toggleScriptSelection(index: number) {
    setSelectedKbIndexes((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  async function handleGenerateContent() {
    const order = genOrderDescription.trim()
    if (!order) {
      setGenError(t('content.genOrderRequired'))
      return
    }
    // file is OPTIONAL now — no file means the AI self-authors from the brief.
    if (genFile && genFile.size > MAX_SCENARIO_BYTES) {
      setGenError(t('content.genFileTooLarge'))
      return
    }

    setGenError('')
    setGeneratedScripts([])
    setSelectedKbIndexes(new Set())
    setDetailScriptIndex(null)
    setIsGenerating(true)

    try {
      const resp = await contentsApi.generateScripts(genFile, order, genMode)
      const scripts = Array.isArray(resp.scripts) ? resp.scripts : []
      if (scripts.length === 0) {
        setGenError(t('content.genNoScripts'))
        return
      }
      // Pha 6 — redirect to full-page draft workspace instead of stacking
      // another modal on top of this one (fixes overflow + nested-modal UI
      // bugs). State is passed via React Router + mirrored to
      // sessionStorage on the draft page so reload doesn't lose work.
      const parentFn = resp.parent_scenario_filename || genFile?.name || ''
      setGenModalOpen(false)
      setGenFile(null)
      setGenOrderDescription('')
      setGenError('')
      setIsGenerating(false)
      showToast(t('content.genSuccess'), 'success')
      navigate('/content/draft', {
        state: {
          scripts,
          parent_scenario_filename: parentFn,
          mode: genMode,
        },
      })
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.genParseError')
      setGenError(message)
      showToast(message, 'error')
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleSaveGenerated() {
    if (generatedScripts.length === 0) return
    const chosen = generatedScripts.filter((_, i) => selectedKbIndexes.has(i))
    if (chosen.length === 0) {
      setGenError(t('content.genSaveNothingSelected'))
      return
    }

    setGenError('')
    setIsSavingGenerated(true)
    try {
      await contentsApi.saveGenerated(parentScenarioFilename, chosen)
      // Refresh the content list so the new generated records appear.
      qc.invalidateQueries({ queryKey: ['contents'] })
      showToast(t('content.genSaveSuccess', { count: chosen.length }), 'success')
      closeGenerateModal()
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.genSaveError')
      setGenError(message)
      showToast(message, 'error')
    } finally {
      setIsSavingGenerated(false)
    }
  }

  // ── Settings / Crawl handlers ─────────────────────────────────────────


  function saveSettings() {
    if (sharingSettings.autoShare && !sharingSettings.teamId) {
      setSettingsError(t('content.settingsTeamRequired'))
      return
    }
    if (!writeToLocalStorage(SETTINGS_STORAGE_KEY, JSON.stringify(sharingSettings))) {
      setSettingsError(t('common.saveError'))
      return
    }
    setSettingsError('')
    setSettingsOpen(false)
    showToast(t('common.saveSuccess'), 'success')
  }

  function openCreateCrawl() {
    setEditingCrawl(null)
    setCrawlForm(DEFAULT_CRAWL_FORM)
    setCrawlFormError('')
    setCrawlModalOpen(true)
  }

  function openEditCrawl(source: CrawlSource) {
    setEditingCrawl(source)
    setCrawlForm({
      url: source.url,
      source_type: source.source_type,
      device_id: source.device_id,
      crawl_frequency_minutes: source.crawl_frequency_minutes,
      is_active: source.is_active,
    })
    setCrawlFormError('')
    setCrawlModalOpen(true)
  }

  function closeCrawlModal() {
    setCrawlModalOpen(false)
    setEditingCrawl(null)
    setCrawlForm(DEFAULT_CRAWL_FORM)
    setCrawlFormError('')
  }

  async function handleCrawlSubmit() {
    if (!crawlForm.url?.trim()) {
      setCrawlFormError(t('content.crawl.urlRequired'))
      return
    }
    const isSocial = SOCIAL_SOURCE_TYPES.includes(crawlForm.source_type)
    if (isSocial && !crawlForm.device_id) {
      setCrawlFormError(t('content.crawl.deviceRequired'))
      return
    }
    if (!crawlForm.crawl_frequency_minutes || crawlForm.crawl_frequency_minutes < 1) {
      setCrawlFormError(t('content.crawl.frequencyRequired'))
      return
    }
    setCrawlFormError('')
    const payload: CrawlSourceCreate = {
      ...crawlForm,
      device_id: isSocial ? crawlForm.device_id : null,
    }
    try {
      if (editingCrawl) {
        await updateCrawlMutation.mutateAsync({ id: editingCrawl.id, data: payload })
        showToast(t('common.saveSuccess'), 'success')
      } else {
        await createCrawlMutation.mutateAsync(payload)
        showToast(t('common.createSuccess'), 'success')
      }
      qc.invalidateQueries({ queryKey: ['crawl-sources'] })
      closeCrawlModal()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.saveError')
      setCrawlFormError(message)
      showToast(message, 'error')
    }
  }

  function handleScheduleFromEdit(item: ContentItem) {
    setSelectedPublishContentId(item.id)
    setPublishFormError('')
    setActiveTab('publish')
  }

  function handleAddPublishSchedule() {
    if (!selectedPublishContent) {
      setPublishFormError(t('content.publishValidationContent'))
      return
    }
    if (!publishAt) {
      setPublishFormError(t('content.publishValidationTime'))
      return
    }
    if (!publishProfileId) {
      setPublishFormError(t('content.publishValidationProfile'))
      return
    }
    const profile = profiles.find((item) => item.id === publishProfileId)
    if (!profile) {
      setPublishFormError(t('content.publishValidationProfile'))
      return
    }
    if (Number.isNaN(new Date(publishAt).getTime())) {
      setPublishFormError(t('content.publishValidationTime'))
      return
    }
    setPublishFormError('')
    createPublishScheduleMutation.mutate({
      content: selectedPublishContent,
      platform: publishPlatform,
      profile,
      publishAt,
    })
  }

  function handleRemovePublishSchedule(id: number) {
    deletePublishScheduleMutation.mutate(id)
  }

  async function persistRepostAsPublishSchedule(args: {
    video: TiktokChannelResearchVideo
    platform: PublishPlatform
    publishAt: string
    textContent: string
    profile: Profile | null
  }) {
    const { video, platform, publishAt, textContent, profile } = args
    const fallbackTitle = video.title?.trim() || video.url || `Repost ${video.id}`
    const normalizedText = textContent.trim()
    const createdContent = await contentsApi.create({
      title: fallbackTitle,
      video_url: video.url || '',
      image_urls: [],
      text_content: normalizedText,
      file_url: '',
      script: normalizedText,
    })
    const publishAtIso = new Date(publishAt).toISOString()
    let taskId: number | null = null
    try {
      const task = await tasksApi.create({
        name: `${createdContent.title} • ${profile?.name ?? platform}`,
        description: `Scheduled ${platform} publish for ${createdContent.title}`,
        task_type: 'generic',
        status: 'pending',
        payload: {
          agent: platform,
          source: 'content-publish',
          content_id: createdContent.id,
          content_title: createdContent.title,
          platform,
          publish_at: publishAtIso,
          video_url: createdContent.video_url,
          image_urls: createdContent.image_urls ?? [],
          text_content: createdContent.text_content ?? '',
          file_url: createdContent.file_url ?? '',
          script: createdContent.script,
        },
      })
      taskId = task.id
      if (typeof createdContent.team_id === 'number') {
        await tasksApi.share(task.id, createdContent.team_id, createdContent.team_permission)
      }
      await schedulesApi.create({
        task: task.id,
        profile: profile?.id ?? null,
        schedule_type: 'once',
        run_at: publishAtIso,
        max_retries: 0,
        retry_delay_seconds: 60,
      })
    } catch (err) {
      if (taskId !== null) {
        try { await tasksApi.delete(taskId) } catch {}
      }
      throw err
    }
    qc.invalidateQueries({ queryKey: ['contents'] })
    qc.invalidateQueries({ queryKey: ['tasks'] })
    qc.invalidateQueries({ queryKey: ['schedules'] })
    qc.invalidateQueries({ queryKey: ['profile-schedules'] })
  }

  function handleOpenRepostModal(video: TiktokChannelResearchVideo) {
    const prefilledContent =
      video.analyzed_content ||
      [video.title, video.description, video.hashtags.map((h) => `#${h}`).join(' ')].filter(Boolean).join('\n\n')
    setRepostModalVideo(video)
    setRepostContent(prefilledContent)
    setRepostAiLoading(false)
    setRepostAiSettingsOpen(false)
    setRepostAiSettingsError('')
    setRepostPlatform('facebook')
    setRepostFbPageId(null)
    setRepostYoutubeProfileId(null)
    setRepostScheduledAt('')
    setRepostError('')
    setRepostLoadingStep('')
    // TikTok pre-fill
    setRepostTiktokContentText(video.understand_text_overlay || video.analyzed_content || '')
    setRepostTiktokBackground(video.understand_background_description || '')
    setRepostTiktokProfileId(null)
    setRepostTiktokMusicType('default')
    const savedMusicPath = (() => { try { return localStorage.getItem(`tiktok_music_path_${video.id}`) ?? '' } catch { return '' } })()
    setRepostTiktokMusicPath(video.music_path || savedMusicPath)
    setRepostTiktokMusicFile(null)
    setRepostTiktokRefImage(null)
    setRepostTiktokStyle(video.understand_video_style || 'healing')
    setRepostTiktokDuration(video.duration || '')
    setRepostTiktokScheduledAt('')
    setRepostTiktokAnimation(false)
  }

  function closeRepostModal() {
    setRepostModalVideo(null)
    setRepostAiLoading(false)
    setRepostAiSettingsOpen(false)
    setRepostAiSettingsError('')
    setRepostTiktokAnimation(false)
  }

  async function handleOpenRepostAiSettings() {
    setRepostAiSettingsOpen(true)
    setRepostAiSettingsError('')
    setRepostAiSettingsLoading(true)
    try {
      const response = await contentsApi.getFeatureSystemPrompt(REPOST_AI_FEATURE_ID)
      setRepostAiSystemPrompt(response.system_prompt || '')
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.repostAiPromptLoadFailed')
      setRepostAiSettingsError(message)
      showToast(message, 'error')
    } finally {
      setRepostAiSettingsLoading(false)
    }
  }

  async function handleSaveRepostAiSettings() {
    const prompt = repostAiSystemPrompt.trim()
    if (!prompt) {
      setRepostAiSettingsError(t('content.repostAiPromptRequired'))
      return
    }
    setRepostAiSettingsError('')
    setRepostAiSettingsSaving(true)
    try {
      const response = await contentsApi.saveFeatureSystemPrompt(REPOST_AI_FEATURE_ID, prompt)
      setRepostAiSystemPrompt(response.system_prompt || prompt)
      setRepostAiSettingsOpen(false)
      showToast(t('content.repostAiPromptSaved'), 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.repostAiPromptSaveFailed')
      setRepostAiSettingsError(message)
      showToast(message, 'error')
    } finally {
      setRepostAiSettingsSaving(false)
    }
  }

  async function handleRewriteOrCreateRepostContent(mode: 'rewrite' | 'create') {
    if (!repostModalVideo) return

    const contextText = [
      repostModalVideo.title,
      repostModalVideo.description,
      repostModalVideo.hashtags.map((item) => `#${item}`).join(' '),
      repostModalVideo.analyzed_content,
    ]
      .filter(Boolean)
      .join('\n\n')

    const currentTargetText = repostPlatform === 'tiktok' ? repostTiktokContentText.trim() : repostContent.trim()
    const sourceText = mode === 'rewrite' ? currentTargetText : contextText
    if (mode === 'rewrite' && !sourceText) {
      setRepostError(t('content.repostErrorContent'))
      return
    }

    setRepostError('')
    setRepostAiLoading(true)
    try {
      const response = await contentsApi.aiRewriteRepost({
        feature_id: REPOST_AI_FEATURE_ID,
        mode,
        source_text: sourceText,
      })
      if (repostPlatform === 'tiktok') {
        setRepostTiktokContentText(response.content)
      } else {
        setRepostContent(response.content)
      }
      showToast(
        mode === 'rewrite' ? t('content.repostAiRewriteSuccess') : t('content.repostAiCreateSuccess'),
        'success',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.repostAiGenerateFailed')
      setRepostError(message)
      showToast(message, 'error')
    } finally {
      setRepostAiLoading(false)
    }
  }

  async function handleRepostSubmit() {
    if (!repostModalVideo) return
    if (repostPlatform === 'tiktok') {
      await handleTiktokRepostSubmit()
      return
    }
    if (repostPlatform === 'facebook') {
      if (!repostFbPageId) {
        setRepostError(t('content.repostErrorSelectPage'))
        return
      }
      if (!repostScheduledAt) {
        setRepostError(t('content.repostErrorScheduledAt'))
        return
      }
      if (!repostContent.trim()) {
        setRepostError(t('content.repostErrorContent'))
        return
      }
    }
    if (repostPlatform === 'youtube') {
      if (!repostYoutubeProfileId) {
        setRepostError(t('content.repostErrorSelectProfile'))
        return
      }
      if (!repostScheduledAt) {
        setRepostError(t('content.repostErrorScheduledAt'))
        return
      }
      if (!repostContent.trim()) {
        setRepostError(t('content.repostErrorContent'))
        return
      }
    }
    setRepostError('')
    setRepostLoading(true)
    try {
      if (repostPlatform === 'facebook' && repostFbPageId) {
        await facebookScheduledPostsApi.create({
          page: repostFbPageId,
          content: repostContent.trim(),
          scheduled_at: new Date(repostScheduledAt).toISOString(),
        })

        await persistRepostAsPublishSchedule({
          video: repostModalVideo,
          platform: 'facebook',
          publishAt: repostScheduledAt,
          textContent: repostContent,
          profile: null,
        })
      }
      if (repostPlatform === 'youtube' && repostYoutubeProfileId) {
        const selectedProfile = profiles.find((item) => item.id === repostYoutubeProfileId) ?? null
        await persistRepostAsPublishSchedule({
          video: repostModalVideo,
          platform: 'youtube',
          publishAt: repostScheduledAt,
          textContent: repostContent,
          profile: selectedProfile,
        })
      }
      showToast(t('content.repostSuccess'), 'success')
      closeRepostModal()
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('content.repostFailed')
      setRepostError(msg)
      showToast(msg, 'error')
    } finally {
      setRepostLoading(false)
    }
  }

  async function handleTiktokRepostSubmit() {
    const repostVideo = repostModalVideo
    if (!repostVideo) return
    if (!repostTiktokContentText.trim()) {
      setRepostError(t('content.repostTiktokErrorContentText'))
      return
    }
    setRepostError('')
    setRepostLoading(true)
    try {
      setRepostLoadingStep(t('content.repostTiktokStepGenerating'))
      await tiktokApi.repostChannelVideo(repostVideo.id, {
        content_text: repostTiktokContentText.trim(),
        scheduled_at: repostTiktokScheduledAt ? new Date(repostTiktokScheduledAt).toISOString() : '',
        profile_id: repostTiktokProfileId ?? undefined,
        background_description: repostTiktokBackground.trim() || undefined,
        ref_image: repostTiktokRefImage ?? undefined,
        concept_music: repostTiktokMusicType === 'default' && repostTiktokMusicPath ? repostTiktokMusicPath : undefined,
        music_file: repostTiktokMusicType === 'custom' && repostTiktokMusicFile ? repostTiktokMusicFile : undefined,
        style: repostTiktokStyle || undefined,
        duration: repostTiktokDuration !== '' ? Number(repostTiktokDuration) : undefined,
        animation: repostTiktokAnimation,
      })
      showToast(t('content.repostTiktokVideoGenStarted', { taskId: '' }), 'success')
      setRepostModalVideo(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('content.repostFailed')
      setRepostError(msg)
      showToast(msg, 'error')
    } finally {
      setRepostLoading(false)
      setRepostLoadingStep('')
    }
  }

  async function handleRepostAll() {
    if (!researchResult) return
    if (repostAllPlatform === 'facebook' && !repostAllFbPageId) {
      setRepostAllError(t('content.repostErrorSelectPage'))
      return
    }
    if (repostAllPlatform === 'tiktok' && !repostAllTiktokProfileId) {
      setRepostAllError('Vui lòng chọn kênh TikTok')
      return
    }
    if (!repostAllScheduledAt) {
      setRepostAllError(t('content.repostErrorScheduledAt'))
      return
    }
    setRepostAllError('')
    setRepostAllLoading(true)
    const interval = repostAllScheduleMode === 'every30' ? 30 : repostAllInterval
    try {
      const baseTime = new Date(repostAllScheduledAt).getTime()
      const videosToPost = repostAllCount === '' ? researchResult.videos : researchResult.videos.slice(0, repostAllCount)
      await Promise.all(
        videosToPost.map((video, index) => {
          const scheduledAtIso = new Date(baseTime + index * interval * 60 * 1000).toISOString()
          if (repostAllPlatform === 'tiktok') {
            return tiktokApi.scheduleTiktokVideo({
              profile_id: repostAllTiktokProfileId,
              link_download: video.url,
              scheduled_at: scheduledAtIso,
            })
          }
          const content =
            video.analyzed_content ||
            [video.title, video.description, video.hashtags.map((h) => `#${h}`).join(' ')].filter(Boolean).join('\n\n')
          return facebookScheduledPostsApi
            .create({
              page: repostAllFbPageId!,
              content: content || video.title || video.url,
              scheduled_at: scheduledAtIso,
            })
            .then(() =>
              persistRepostAsPublishSchedule({
                video,
                platform: 'facebook',
                publishAt: scheduledAtIso,
                textContent: content || video.title || video.url,
                profile: null,
              }),
            )
        }),
      )
      showToast(t('content.repostAllSuccess', { count: videosToPost.length }), 'success')
      setRepostAllModalOpen(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('content.repostAllFailed')
      setRepostAllError(msg)
      showToast(msg, 'error')
    } finally {
      setRepostAllLoading(false)
    }
  }

  async function handleProcessAllVideos() {
    if (!researchResult) return
    const total = researchResult.videos.length
    setProcessAllLoading(true)
    setProcessAllProgress({ current: 0, total })
    await Promise.all(
      researchResult.videos.map(async (video) => {
        try {
          await tiktokApi.processChannelVideoForResearch(video.id, researchVideoLanguage)
        } catch {}
        setProcessAllProgress((prev) => (prev ? { ...prev, current: prev.current + 1 } : null))
      }),
    )
    setProcessAllLoading(false)
    setProcessAllProgress(null)
    showToast(`Đã gửi yêu cầu hiểu ${total} video`, 'success')
  }

  async function handleAnalyzeResearchChannel() {
    const channelUrl = researchUrl.trim()
    if (!channelUrl) {
      setResearchError(t('content.researchUrlRequired'))
      return
    }
    if (!channelUrl.includes('tiktok.com/@')) {
      setResearchError(t('content.researchUrlInvalid'))
      return
    }

    setResearchError('')
    setResearchLoading(true)
    try {
      const response = await tiktokApi.crawlChannelForResearch(channelUrl, {
        max_videos: researchMaxVideos,
        no_cache: researchNoCache,
      })
      setResearchResult(response)
      setResearchKeywordResult([])
      setResearchMetricsReady(true)
      showToast(
        response.cache_hit
          ? t('content.researchLoadedFromCache')
          : t('content.researchCrawlSuccess'),
        'success',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.researchFailed')
      setResearchError(message)
      showToast(message, 'error')
    } finally {
      setResearchLoading(false)
    }
  }

  function handleSortResearchByMetrics() {
    if (!researchResult) return
    setResearchResult((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        videos: [...prev.videos].sort(compareVideosByMetricsDescending),
      }
    })
  }

  async function handleProcessResearchVideo(videoId: number) {
    setResearchProcessingVideoIds((prev) => new Set(prev).add(videoId))
    try {
      const response = await tiktokApi.processChannelVideoForResearch(videoId, researchVideoLanguage)
      setResearchResult((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          videos: prev.videos.map((video) => (video.id === videoId ? response.video : video)),
        }
      })
      showToast(t('content.researchVideoProcessStarted', { taskId: response.task_id }), 'success')

      // Poll genvideo task until finished, then refresh video from DB
      for (let i = 0; i < 60; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 4000))
        const taskData = await tiktokApi.getTextVideoTask(response.task_id)
        if (taskData.status === 'finished' || taskData.status === 'succeeded') {
          const updatedVideo = await tiktokApi.getChannelVideoForResearch(videoId)
          const musicPath = taskData.result?.music_path ?? ''
          if (musicPath) {
            updatedVideo.music_path = musicPath
            try { localStorage.setItem(`tiktok_music_path_${videoId}`, musicPath) } catch {}
          }
          setResearchResult((prev: TiktokChannelResearchResponse | null) => {
            if (!prev) return prev
            return {
              ...prev,
              videos: prev.videos.map((v: TiktokChannelResearchVideo) => (v.id === videoId ? updatedVideo : v)),
            }
          })
          showToast(t('content.researchVideoProcessDone'), 'success')
          break
        }
        if (taskData.status === 'failed' || taskData.status === 'error') {
          showToast(t('content.researchVideoProcessFailed'), 'error')
          break
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.researchFailed')
      showToast(message, 'error')
    } finally {
      setResearchProcessingVideoIds((prev) => {
        const next = new Set(prev)
        next.delete(videoId)
        return next
      })
    }
  }

  async function handleCompareResearchChannels() {
    const rawChannels = researchCompareChannelsInput
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter((value) => value.includes('tiktok.com/@'))
    const channels = Array.from(new Set(rawChannels))
    if (channels.length < 2) {
      setResearchError(t('content.researchCompareNeedTwoChannels'))
      return
    }

    setResearchError('')
    setResearchCompareLoading(true)
    try {
      const responses = await Promise.all(
        channels.map((channelUrl) =>
          tiktokApi.crawlChannelForResearch(channelUrl, {
            max_videos: researchMaxVideos,
            no_cache: researchNoCache,
          }),
        ),
      )
      const comparison = responses
        .map(calculateResearchChannelComparison)
        .sort((left, right) => {
          if (left.averageEngagementRate !== right.averageEngagementRate) {
            return right.averageEngagementRate - left.averageEngagementRate
          }
          return right.averageViews - left.averageViews
        })
      setResearchCompareResults(comparison)
      showToast(t('content.researchCompareSuccess', { count: comparison.length }), 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.researchCompareFailed')
      setResearchError(message)
      showToast(message, 'error')
    } finally {
      setResearchCompareLoading(false)
    }
  }

  async function handleExtractResearchKeywords() {
    if (!researchResult) {
      setResearchError(t('content.researchExtractRequireChannel'))
      return
    }
    setResearchError('')
    setResearchKeywordExtractLoading(true)
    try {
      const response = await tiktokApi.extractChannelKeywordsForResearch(researchResult.channel_url, {
        max_videos: researchMaxVideos,
      })
      setResearchKeywordResult(response.keywords)
      showToast(t('content.researchExtractSuccess', { count: response.keywords.length }), 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.researchExtractFailed')
      setResearchError(message)
      showToast(message, 'error')
    } finally {
      setResearchKeywordExtractLoading(false)
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending
  const isCrawlPending = createCrawlMutation.isPending || updateCrawlMutation.isPending

  const tabs: { id: Tab; label: string; Icon: React.ElementType }[] = [
    { id: 'edit', label: t('content.tabEdit'), Icon: Pencil },
    { id: 'source', label: t('content.tabSource'), Icon: Database },
    { id: 'research', label: t('content.tabResearch'), Icon: Search },
    { id: 'publish', label: t('content.tabPublish'), Icon: CalendarClock },
    // v3.2.1 — Tab AI Scenario (theo yêu cầu user merge UX vào ContentPage)
    { id: 'scenario', label: t('content.tabScenario', { defaultValue: 'AI Scenario' }), Icon: Sparkles },
    { id: 'approval', label: t('content.tabApproval', { defaultValue: 'Duyệt Video' }), Icon: ClipboardCheck },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('content.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('content.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/content/video-samples">
              <Clapperboard className="mr-1.5 size-4" />
              {t('nav.contentSamples')}
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings className="mr-1.5 size-4" />
            {t('content.settings')}
          </Button>
        </div>
      </div>

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

      {activeTab === 'edit' && (
        <div className="flex flex-col gap-4">
          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
            <form
              className="flex flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                setAppliedSearch(searchInput.trim())
                setPage(1)
              }}
            >
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={t('content.searchPlaceholder')}
                className="h-9 flex-1 min-w-[180px] rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <Button type="submit" size="sm" variant="outline">
                {t('content.searchAction')}
              </Button>
            </form>

            <div className="flex items-center gap-1.5">
              <label className="text-xs text-muted-foreground">{t('content.dateFromLabel')}</label>
              <input
                type="date"
                value={dateMode === 'range' ? dateFrom : ''}
                onChange={(e) => {
                  setDateFrom(e.target.value)
                  setDateMode('range')
                  setPage(1)
                }}
                className="h-9 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <label className="text-xs text-muted-foreground">{t('content.dateToLabel')}</label>
              <input
                type="date"
                value={dateMode === 'range' ? dateTo : ''}
                onChange={(e) => {
                  setDateTo(e.target.value)
                  setDateMode('range')
                  setPage(1)
                }}
                className="h-9 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setDateMode('today')
                  setDateFrom('')
                  setDateTo('')
                  setPage(1)
                }}
                className={`h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${
                  dateMode === 'today'
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-background hover:bg-muted'
                }`}
              >
                {t('content.filterToday')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDateMode('all')
                  setDateFrom('')
                  setDateTo('')
                  setPage(1)
                }}
                className={`h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${
                  dateMode === 'all'
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-background hover:bg-muted'
                }`}
              >
                {t('content.filterAll')}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => refetch()}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
                aria-label={t('common.refresh')}
              >
                <RefreshCw className="size-3.5" />
              </button>
              <Button onClick={openCreate} size="sm">
                <Plus className="mr-1 size-4" />
                {t('content.newContent')}
              </Button>
              <Button onClick={() => setAiScenarioOpen(true)} size="sm" variant="outline"
                className="border-violet-400/60 text-violet-700 hover:bg-violet-500/10 dark:text-violet-200">
                <Sparkles className="mr-1 size-4" />
                {t('content.aiScenario.action')}
              </Button>
              <Button onClick={openGenerate} size="sm" variant="outline">
                <FileText className="mr-1 size-4" />
                {t('content.genContent')}
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {dateMode === 'today'
              ? t('content.filterLabelToday', { count: totalCount })
              : dateMode === 'all'
                ? t('content.filterLabelAll', { count: totalCount })
                : t('content.filterLabelRange', {
                    count: totalCount,
                    from: dateFrom || '—',
                    to: dateTo || '—',
                  })}
            {appliedSearch && ` · "${appliedSearch}"`}
          </p>

          <div className="rounded-xl border border-border bg-card">
            {isLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16">
                <Clapperboard className="size-10 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {dateMode === 'today' ? t('content.todayEmpty') : t('content.filterEmpty')}
                </p>
                <Button onClick={openCreate} size="sm" variant="outline">
                  <Plus className="mr-1 size-4" />
                  {t('content.newContent')}
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {items.map((item) => {
                  const isOwner = item.owner_id === user?.id
                  return (
                    <div key={item.id} className="flex items-start justify-between gap-4 px-4 py-3">
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/content/${item.id}`)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            navigate(`/content/${item.id}`)
                          }
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="truncate text-sm font-medium">{item.title}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {t('content.createdAt')}: {formatDateTime(item.created_at)}
                          </span>
                          {isOwner && (
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                              {t('content.ownerLabel')}
                            </span>
                          )}
                          {item.team_name && (
                            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                              <Users className="mr-1 inline size-3" />
                              {t('content.teamLabel', { name: item.team_name })}
                            </span>
                          )}
                        </div>
                        {item.video_url ? (
                          <a
                            href={item.video_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            className="mt-1.5 flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="size-3 shrink-0" />
                            <span className="truncate">{item.video_url}</span>
                          </a>
                        ) : (
                          <p className="mt-1.5 text-xs text-muted-foreground">{t('content.noVideo')}</p>
                        )}
                        <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                          {item.text_content || item.script || t('content.noTextContent')}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        {isOwner && (
                          <ShareButton
                            currentTeamId={item.team_id}
                            currentTeamName={item.team_name}
                            currentPermission={item.team_permission}
                            onShare={(teamId, permission) =>
                              contentsApi.share(item.id, teamId, permission)
                            }
                            onUnshare={() => contentsApi.unshare(item.id)}
                            invalidateKey={['contents']}
                          />
                        )}
                        <button
                          onClick={() => openEdit(item)}
                          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          aria-label={t('common.edit')}
                        >
                          <Pencil className="size-4" />
                        </button>
                        <Button size="sm" variant="outline" onClick={() => handleScheduleFromEdit(item)}>
                          <CalendarClock className="size-3.5" />
                          {t('content.schedulePublishAction')}
                        </Button>
                        <button
                          onClick={() => {
                            if (confirm(t('content.deleteConfirm'))) {
                              deleteMutation.mutate(item.id)
                            }
                          }}
                          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                          aria-label={t('common.delete')}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Pagination — only shown when there are multiple pages. */}
          {totalCount > 0 && totalPages > 1 && (
            <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-2">
              <p className="text-xs text-muted-foreground">
                {t('content.paginationRange', {
                  from: (page - 1) * PAGE_SIZE + 1,
                  to: Math.min(page * PAGE_SIZE, totalCount),
                  total: totalCount,
                })}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => hasPrevPage && setPage((p) => Math.max(1, p - 1))}
                  disabled={!hasPrevPage}
                  className="h-8 rounded-lg border border-border bg-background px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('content.paginationPrev')}
                </button>
                <span className="text-xs text-muted-foreground">
                  {t('content.paginationPageOf', { page, total: totalPages })}
                </span>
                <button
                  type="button"
                  onClick={() => hasNextPage && setPage((p) => p + 1)}
                  disabled={!hasNextPage}
                  className="h-8 rounded-lg border border-border bg-background px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('content.paginationNext')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'source' && (
        <div className="flex flex-col gap-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">{t('content.crawl.title')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('content.crawl.description')}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => refetchCrawl()}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
                aria-label={t('common.refresh')}
              >
                <RefreshCw className="size-3.5" />
              </button>
              <Button onClick={openCreateCrawl} size="sm">
                <Plus className="mr-1 size-4" />
                {t('content.crawl.addLink')}
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card">
            {crawlLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
            ) : crawlSources.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16">
                <Link2 className="size-10 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">{t('content.crawl.empty')}</p>
                <Button onClick={openCreateCrawl} size="sm" variant="outline">
                  <Plus className="mr-1 size-4" />
                  {t('content.crawl.addLink')}
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {crawlSources.map((source) => {
                  const isSocial = SOCIAL_SOURCE_TYPES.includes(source.source_type)
                  return (
                    <div key={source.id} className="flex items-start justify-between gap-4 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => navigate(`/content/crawl-sources/${source.id}`)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={[
                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase',
                            isSocial
                              ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                              : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
                          ].join(' ')}>
                            {isSocial
                              ? <Smartphone className="size-3" />
                              : <Globe className="size-3" />
                            }
                            {t(`content.crawl.sourceType.${source.source_type}`)}
                          </span>
                          <span className={[
                            'rounded-full px-2 py-0.5 text-[10px] font-medium',
                            source.is_active
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : 'bg-muted text-muted-foreground',
                          ].join(' ')}>
                            {source.is_active ? t('content.crawl.active') : t('content.crawl.inactive')}
                          </span>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {formatFrequency(source.crawl_frequency_minutes, t as (key: string, opts?: Record<string, unknown>) => string)}
                          </span>
                          {source.latest_run_status && (
                            <span className={[
                              'rounded-full px-2 py-0.5 text-[10px] font-medium',
                              source.latest_run_status === 'success'
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                : source.latest_run_status === 'failed'
                                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                  : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
                            ].join(' ')}>
                              {t('content.crawl.latestRunLabel')}: {source.latest_run_status}
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 text-sm font-medium text-foreground hover:underline">
                          {source.url}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="rounded-full bg-muted px-2 py-0.5">
                            {t('content.crawl.totalSnapshots')}: {source.snapshot_count}
                          </span>
                          <span className="rounded-full bg-muted px-2 py-0.5">
                            {t('content.crawl.totalRuns')}: {source.run_count}
                          </span>
                          <span className="rounded-full bg-muted px-2 py-0.5">
                            {t('content.crawl.latestItemsLabel')}: {source.latest_run_item_count}
                          </span>
                        </div>
                        {source.device_name && (
                          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                            <Smartphone className="size-3 shrink-0" />
                            {source.device_name}
                          </p>
                        )}
                      </button>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button asChild size="sm" variant="outline">
                          <a href={source.url} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="size-3.5" />
                            {t('content.crawl.viewWeb')}
                          </a>
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => navigate(`/content/crawl-sources/${source.id}`)}>
                          <FileText className="size-3.5" />
                          {t('content.crawl.viewDetail')}
                        </Button>
                        <button
                          onClick={() => openEditCrawl(source)}
                          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          aria-label={t('common.edit')}
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(t('content.crawl.deleteConfirm'))) {
                              deleteCrawlMutation.mutate(source.id)
                            }
                          }}
                          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                          aria-label={t('common.delete')}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'research' && (
        <div className="rounded-2xl border border-sky-200/70 bg-[linear-gradient(135deg,rgba(14,165,233,0.12),rgba(168,85,247,0.1),rgba(34,197,94,0.08))] p-5 shadow-sm dark:border-sky-500/20">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <span className="inline-flex items-center rounded-full border border-white/60 bg-background/80 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-700 shadow-sm backdrop-blur dark:text-sky-200">
                {t('content.tabResearch')}
              </span>
              <h3 className="mt-3 text-sm font-semibold">{t('content.researchTitle')}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t('content.researchDesc')}</p>
            </div>
            <div className="rounded-xl border border-white/60 bg-background/75 px-3 py-2 text-right text-[11px] text-muted-foreground shadow-sm backdrop-blur">
              <p className="font-medium text-foreground">{t('content.researchDataSource')}</p>
              <p>{t('content.researchCompareResultTitle')}</p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5 rounded-2xl border border-white/60 bg-background/80 p-4 shadow-sm backdrop-blur">
              <label className="text-sm font-medium">{t('content.researchUrlLabel')}</label>
              <input
                type="url"
                value={researchUrl}
                onChange={(e) => setResearchUrl(e.target.value)}
                placeholder={t('content.researchUrlPlaceholder')}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground">{t('content.researchMaxVideosLabel')}</label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={researchMaxVideos}
                    onChange={(e) => setResearchMaxVideos(clampNumberInput(e.target.value, 1, 500, 1))}
                    className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={researchNoCache}
                    onChange={(e) => setResearchNoCache(e.target.checked)}
                  />
                  <span>{t('content.researchNoCache')}</span>
                </label>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleAnalyzeResearchChannel}
                disabled={researchLoading || researchCompareLoading}
              >
                {researchLoading ? t('common.loading') : t('content.researchAnalyze')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleSortResearchByMetrics}
                disabled={!researchResult || researchLoading || researchCompareLoading}
              >
                <ArrowDownWideNarrow className="mr-1 size-4" />
                {t('content.researchSortByMetricsDesc')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleExtractResearchKeywords}
                disabled={!researchResult || researchLoading || researchKeywordExtractLoading || researchCompareLoading}
              >
                {researchKeywordExtractLoading ? t('common.loading') : t('content.researchExtractKeywords')}
              </Button>
              {researchError && <p className="text-xs text-destructive">{researchError}</p>}
            </div>
            <div className="flex flex-col gap-1.5 rounded-2xl border border-white/60 bg-background/80 p-4 shadow-sm backdrop-blur">
              <label className="text-sm font-medium">{t('content.researchCompareChannelsLabel')}</label>
              <textarea
                value={researchCompareChannelsInput}
                onChange={(e) => setResearchCompareChannelsInput(e.target.value)}
                placeholder={t('content.researchCompareChannelsPlaceholder')}
                rows={5}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleCompareResearchChannels}
                disabled={researchLoading || researchCompareLoading}
              >
                {researchCompareLoading ? t('common.loading') : t('content.researchCompareChannels')}
              </Button>
              {researchCompareResults.length > 0 && (
                <div className="rounded-xl border border-violet-300/60 bg-[linear-gradient(135deg,rgba(168,85,247,0.12),rgba(59,130,246,0.06))] p-3 text-xs text-muted-foreground shadow-sm">
                  <p className="font-medium text-foreground">{t('content.researchCompareResultTitle')}</p>
                  <div className="mt-2 space-y-2">
                    {researchCompareResults.map((item, index) => (
                      <div
                        key={item.channelUrl}
                        className={`rounded-xl border p-3 ${getResearchCompareRankClassName(index)}`}
                      >
                        <p className="font-medium text-foreground">
                          #{index + 1} · {item.channelUrl}
                        </p>
                        <p>{t('content.researchTotalVideos')}: {item.videoCount}</p>
                        <p>{t('content.researchEngagementRate')}: {(item.averageEngagementRate * 100).toFixed(2)}%</p>
                        <p>{t('content.researchAverageViews')}: {item.averageViews.toFixed(2)}</p>
                        <p>{t('content.researchAverageLikes')}: {item.averageLikes.toFixed(2)}</p>
                        <p>{t('content.researchAverageComments')}: {item.averageComments.toFixed(2)}</p>
                        <p>{t('content.researchAverageShares')}: {item.averageShares.toFixed(2)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {researchKeywordResult.length > 0 && (
                <div className="rounded-xl border border-emerald-300/60 bg-[linear-gradient(135deg,rgba(16,185,129,0.12),rgba(14,165,233,0.06))] p-3 text-xs text-muted-foreground shadow-sm">
                  <p className="font-medium text-foreground">{t('content.researchExtractResultTitle')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {researchKeywordResult.map((keyword, index) => (
                      <span
                        key={keyword}
                        className={`rounded-full border px-2.5 py-1 font-medium shadow-sm ${
                          researchKeywordPalette[index % researchKeywordPalette.length]
                        }`}
                      >
                        {keyword}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          {researchInsightCards.length > 0 && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {researchInsightCards.map(({ label, value, helper, Icon, className }) => (
                <div key={label} className={`rounded-2xl border p-4 shadow-sm ${className}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                      <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
                    </div>
                    <span className="rounded-full border border-white/60 bg-background/70 p-2 text-foreground shadow-sm">
                      <Icon className="size-4" />
                    </span>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">{helper}</p>
                </div>
              ))}
            </div>
          )}
          {researchResult && (
            <div className="mt-5 space-y-3">
              <div className="rounded-2xl border border-sky-300/60 bg-background/85 p-4 text-xs text-muted-foreground shadow-sm backdrop-blur">
                <p><span className="font-medium text-foreground">{t('content.researchChannelLabel')}:</span> {researchResult.channel_url}</p>
                <p className="mt-1">
                  <span className="font-medium text-foreground">{t('content.researchTotalVideos')}:</span> {researchResult.count}
                </p>
                <p className="mt-1">
                  <span className="font-medium text-foreground">{t('content.researchLastCrawledAt')}:</span>{' '}
                  {researchResult.last_crawled_at ? formatDateTime(researchResult.last_crawled_at) : '—'}
                </p>
                <p className="mt-1">
                  <span className="font-medium text-foreground">{t('content.researchDataSource')}:</span>{' '}
                  {researchResult.cache_hit ? t('content.researchSourceCache') : t('content.researchSourceFresh')}
                </p>
              </div>

              <div className="mb-3 flex items-center justify-between">
                <p className="text-xs text-muted-foreground">{t('content.researchVideosCount', { count: researchResult.videos.length })}</p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={processAllLoading}
                    onClick={handleProcessAllVideos}
                  >
                    {processAllLoading && processAllProgress
                      ? `Đang hiểu ${processAllProgress.current}/${processAllProgress.total}...`
                      : 'Hiểu tất cả video'}
                  </Button>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => {
                      setRepostAllPlatform('facebook')
                      setRepostAllFbPageId(null)
                      setRepostAllTiktokProfileId(null)
                      setRepostAllScheduleMode('every30')
                      setRepostAllInterval(30)
                      setRepostAllCount(10)
                      setRepostAllScheduledAt('')
                      setRepostAllError('')
                      setRepostAllModalOpen(true)
                    }}
                  >
                    {t('content.repostAll')}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                {researchResult.videos.map((video) => {
                  const { engagementRate, lengthBucket, viewVelocity } = calculateVideoMetrics(video)
                  return (
                    <div key={video.url} className="rounded-2xl border border-white/70 bg-background/90 p-4 shadow-sm backdrop-blur">
                      <a
                        href={video.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-foreground hover:underline"
                      >
                        {video.title || video.url}
                      </a>
                      {video.description && (
                        <p className="mt-1 text-xs text-muted-foreground">{video.description}</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                          <Clock3 className="size-3" />
                          {video.duration}s
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                          <Eye className="size-3" />
                          {video.view_count}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                          <Heart className="size-3" />
                          {video.like_count}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                          <MessageCircle className="size-3" />
                          {video.comment_count}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                          <Share2 className="size-3" />
                          {video.share_count}
                        </span>
                      </div>
                      {video.hashtags.length > 0 && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          {video.hashtags.map((tag) => `#${tag}`).join(' ')}
                        </p>
                      )}
                      {researchMetricsReady && (
                        <div className="mt-3 grid gap-2 sm:grid-cols-3">
                          <div className="rounded-xl border border-violet-300/60 bg-violet-500/10 p-3 text-xs text-muted-foreground">
                            <p className="font-medium text-foreground">{t('content.researchEngagementRate')}</p>
                            <p className="mt-1 text-lg font-semibold text-foreground">{(engagementRate * 100).toFixed(2)}%</p>
                          </div>
                          <div className="rounded-xl border border-emerald-300/60 bg-emerald-500/10 p-3 text-xs text-muted-foreground">
                            <p className="font-medium text-foreground">{t('content.researchViewVelocity')}</p>
                            <p className="mt-1 text-lg font-semibold text-foreground">
                              {viewVelocity === null ? '—' : formatCompactNumber(viewVelocity)}
                            </p>
                          </div>
                          <div className="rounded-xl border border-amber-300/60 bg-amber-500/10 p-3 text-xs text-muted-foreground">
                            <p className="font-medium text-foreground">{t('content.researchLengthBucket')}</p>
                            <p className="mt-1 text-lg font-semibold text-foreground">
                              {t(`content.researchLengthBucketValue.${lengthBucket}`)}
                            </p>
                          </div>
                        </div>
                      )}
                      {video.analyzed_content && (
                        <div className="mt-3 rounded-xl border border-sky-300/50 bg-sky-500/5 p-3 text-xs text-muted-foreground">
                          <p className="font-medium text-foreground">{t('content.researchUnderstoodContent')}:</p>
                          <p className="mt-1 whitespace-pre-wrap">{video.analyzed_content}</p>
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <select
                          value={researchVideoLanguage}
                          onChange={(e: { target: HTMLSelectElement }) => setResearchVideoLanguage(e.target.value)}
                          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                          disabled={researchProcessingVideoIds.has(video.id)}
                        >
                          <option value="vi">Tiếng Việt</option>
                          <option value="en">Tiếng Anh (English)</option>
                          <option value="ko">Tiếng Hàn (Korean)</option>
                          <option value="ja">Tiếng Nhật (Japanese)</option>
                          <option value="zh">Tiếng Trung (Chinese)</option>
                          <option value="th">Tiếng Thái (Thai)</option>
                          <option value="id">Tiếng Indonesia (Indonesian)</option>
                          <option value="philipin">Tiếng Tagalog (Filipino)</option>
                        </select>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleProcessResearchVideo(video.id)}
                          disabled={researchProcessingVideoIds.has(video.id)}
                        >
                          {researchProcessingVideoIds.has(video.id)
                            ? t('common.loading')
                            : t('content.researchCreateFromVideo')}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleOpenRepostModal(video)}
                        >
                          {t('content.repostVideo')}
                        </Button>
                        {video.video_process_task_id && (
                          <p className="text-[11px] text-muted-foreground">
                            {t('content.researchVideoTaskId', { taskId: video.video_process_task_id })}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'publish' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold">{t('content.publishPlannerTitle')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('content.publishPlannerDesc')}</p>

            {selectedPublishContent && (
              <p className="mt-3 rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary">
                {t('content.publishSelectedFromEdit', { title: selectedPublishContent.title })}
              </p>
            )}

            <div className="mt-4 flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.publishContentLabel')}</label>
                <select
                  value={selectedPublishContentId ?? ''}
                  onChange={(event) => setSelectedPublishContentId(Number(event.target.value) || null)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t('content.publishChooseContent')}</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>{item.title}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.publishPlatformLabel')}</label>
                <select
                  value={publishPlatform}
                  onChange={(event) => setPublishPlatform(event.target.value as PublishPlatform)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="tiktok">{t('content.publishPlatform.tiktok')}</option>
                  <option value="facebook">{t('content.publishPlatform.facebook')}</option>
                  <option value="youtube">{t('content.publishPlatform.youtube')}</option>
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.publishTimeLabel')}</label>
                <input
                  type="datetime-local"
                  value={publishAt}
                  onChange={(event) => setPublishAt(event.target.value)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.publishProfileLabel')}</label>
                <select
                  value={publishProfileId ?? ''}
                  onChange={(event) => setPublishProfileId(Number(event.target.value) || null)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t('content.publishChooseProfile')}</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {publishFormError && <p className="mt-3 text-xs text-destructive">{publishFormError}</p>}

            <div className="mt-4 flex justify-end">
              <Button size="sm" onClick={handleAddPublishSchedule} disabled={createPublishScheduleMutation.isPending}>
                <Plus className="mr-1 size-4" />
                {t('content.publishAddSchedule')}
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold">{t('content.publishQueueTitle')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t('content.publishQueueDesc')}</p>

            <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('content.publishPendingSectionTitle')}
            </h4>

            {pendingPublishQueue.length === 0 ? (
              publishSchedulesLoading
                ? <p className="mt-4 text-sm text-muted-foreground">{t('common.loading')}</p>
                : <p className="mt-4 text-sm text-muted-foreground">{t('content.publishQueueEmpty')}</p>
            ) : (
              <div className="mt-4 divide-y divide-border rounded-lg border border-border">
                {pendingPublishQueue.map((item) => (
                  <div key={item.id} className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 space-y-1">
                      <p className="truncate text-sm font-medium">{item.contentTitle}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('content.publishQueueItemPlatform')}: {t(`content.publishPlatform.${item.platform}`)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('content.publishQueueItemTime')}: {item.publishAt ? formatDateTime(item.publishAt) : '—'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('content.publishQueueItemProfile')}: {item.profileName || '—'}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRemovePublishSchedule(item.id)}
                      className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <h4 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('content.publishPublishedSectionTitle')}
            </h4>

            {publishedQueue.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">{t('content.publishPublishedEmpty')}</p>
            ) : (
              <div className="mt-3 divide-y divide-border rounded-lg border border-border">
                {publishedQueue.map((item) => (
                  <div key={item.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 space-y-1">
                      <p className="truncate text-sm font-medium">{item.contentTitle}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('content.publishQueueItemPlatform')}: {t(`content.publishPlatform.${item.platform}`)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('content.publishQueueItemPublishedAt')}: {item.publishAt ? formatDateTime(item.publishAt) : '—'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('content.publishQueueItemProfile')}: {item.profileName || '—'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* v3.2.1 — Tab AI Scenario (kịch bản phân tầng) */}
      {activeTab === 'scenario' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">
                {t('content.aiScenario.listTitle', { defaultValue: 'Danh sách AI Scenario' })}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t('content.aiScenario.listSubtitle', { defaultValue: 'Quản lý kịch bản phân tầng v3 — Dr Đình Khanh seeding' })} ·{' '}
                {scenariosList.length} {t('content.aiScenario.totalItems', { defaultValue: 'kịch bản' })}
              </p>
            </div>
            <Button onClick={() => setAiScenarioOpen(true)} size="sm">
              <Plus className="mr-1 size-4" />
              {t('content.aiScenario.createNew', { defaultValue: 'Tạo kịch bản mới' })}
            </Button>
          </div>

          {scenariosLoading && (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <RefreshCw className="mr-2 size-4 animate-spin" /> {t('common.loading', { defaultValue: 'Đang tải...' })}
            </div>
          )}

          {!scenariosLoading && scenariosList.length === 0 && (
            <div className="rounded-lg border border-dashed border-border bg-muted/20 p-12 text-center">
              <FileText className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">
                {t('content.aiScenario.listEmpty', { defaultValue: 'Chưa có kịch bản nào. Bắt đầu sinh kịch bản đầu tiên!' })}
              </p>
              <Button onClick={() => setAiScenarioOpen(true)} size="sm" className="mt-4">
                <Plus className="mr-1 size-4" /> {t('content.aiScenario.createNew', { defaultValue: 'Tạo kịch bản mới' })}
              </Button>
            </div>
          )}

          {!scenariosLoading && scenariosList.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {scenariosList.map((sc) => (
                <div
                  key={sc.id}
                  onClick={() => navigate(`/content-scenarios/${sc.id}`)}
                  className="cursor-pointer rounded-lg border border-border bg-card p-3 transition hover:border-violet-400 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="line-clamp-2 flex-1 text-sm font-semibold">{sc.title || '(Không tên)'}</h3>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(t('content.aiScenario.deleteConfirm', { defaultValue: 'Xoá kịch bản này?' }))) {
                          deleteScenarioMutation.mutate(sc.id)
                        }
                      }}
                      disabled={deleteScenarioMutation.isPending}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-600"
                      aria-label="Delete"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  {sc.brief && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{sc.brief}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-700 dark:text-violet-200">
                      {sc.genre}
                    </span>
                    <span className="inline-flex items-center gap-0.5">
                      <Clock3 className="size-3" /> {sc.duration_target_seconds}s
                    </span>
                    <span className="inline-flex items-center gap-0.5">
                      <Clapperboard className="size-3" /> {sc.shot_count ?? sc.shot_count_target} shots
                    </span>
                    {sc.character_registry?.length > 0 && (
                      <span className="inline-flex items-center gap-0.5">
                        <Users className="size-3" /> {sc.character_registry.length}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 text-[10px] text-muted-foreground">
                    {new Date(sc.updated_at).toLocaleString('vi-VN')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'approval' && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-sky-300/60 bg-[linear-gradient(135deg,rgba(14,165,233,0.12),rgba(168,85,247,0.1),rgba(34,197,94,0.08))] p-6 shadow-sm backdrop-blur dark:border-sky-500/20">
            <div>
              <span className="inline-flex items-center rounded-full border border-white/60 bg-background/80 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-700 shadow-sm backdrop-blur dark:text-sky-200">
                Phê duyệt nội dung
              </span>
              <h2 className="mt-3 text-lg font-semibold">Danh sách Video chờ duyệt</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Xem trước các video AI đã sinh thành công. Phê duyệt để lên lịch đăng bài lên thiết bị, hoặc Từ chối để hủy bỏ.
              </p>
            </div>
            <button
              onClick={() => refetchPendingApproval()}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
              aria-label={t('common.refresh')}
              disabled={pendingApprovalLoading}
            >
              <RefreshCw className={`size-4 ${pendingApprovalLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {pendingApprovalLoading ? (
            <div className="py-20 text-center text-sm text-muted-foreground flex flex-col items-center justify-center gap-3">
              <RefreshCw className="size-8 animate-spin text-primary" />
              <span>Đang tải danh sách video...</span>
            </div>
          ) : pendingApprovalTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 py-24 rounded-2xl border border-dashed border-border bg-card/40">
              <div className="rounded-full bg-emerald-500/10 p-3 text-emerald-600 dark:text-emerald-400">
                <ClipboardCheck className="size-10" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-foreground">{t('content.approvalNoTasksText')}</p>
                <p className="text-xs text-muted-foreground mt-1">{t('content.approvalNoTasksHint')}</p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {pendingApprovalTasks.map((task) => {
                const payload = (task.payload || {}) as Record<string, any>
                const linkDownload = payload.link_download || ''
                const profileId = payload.profile_id
                const contentText = payload.content_text || ''
                const scheduledAt = payload.scheduled_at || ''
                
                const initialCaption = payload.caption || ''
                const initialHashtags = payload.hashtags ? payload.hashtags.map((h: string) => `#${h}`).join(' ') : ''
                const currentCaption = editedCaptions[task.id] !== undefined ? editedCaptions[task.id] : initialCaption
                const currentHashtags = editedHashtags[task.id] !== undefined ? editedHashtags[task.id] : initialHashtags

                return (
                  <div
                    key={task.id}
                    className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-card/60 shadow-lg backdrop-blur hover:shadow-xl transition-all duration-300 dark:border-white/5"
                  >
                    {/* Video preview container */}
                    <div className="aspect-[9/16] max-h-[400px] w-full bg-black/90 relative flex items-center justify-center group">
                      {linkDownload ? (
                        <video
                          src={linkDownload}
                          controls
                          className="h-full w-full object-contain"
                          preload="metadata"
                        />
                      ) : (
                        <div className="text-center p-4">
                          <Clapperboard className="size-10 text-muted-foreground/40 mx-auto mb-2" />
                          <p className="text-xs text-muted-foreground">Không tìm thấy link video</p>
                        </div>
                      )}
                    </div>

                    {/* Task details */}
                    <div className="flex flex-col flex-1 p-4 gap-3">
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-sky-700 dark:text-sky-300">
                            TikTok Repost
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            ID: {task.id}
                          </span>
                        </div>
                         <div className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
                          <span>{t('content.approvalCardAccountLabel')}</span>
                          <select
                            value={profileId ?? ''}
                            onChange={(e) => {
                              const val = e.target.value
                              const parsed = val ? Number(val) : null
                              updateTaskProfileMutation.mutate({ id: task.id, profileId: parsed })
                            }}
                            className="bg-transparent text-sky-600 dark:text-sky-400 font-semibold focus:outline-none border-b border-dashed border-sky-500/50 hover:border-sky-500 hover:text-sky-500 transition-colors cursor-pointer select-none"
                            disabled={updateTaskProfileMutation.isPending}
                          >
                            <option value="" className="text-foreground bg-card">{t('content.approvalCardChooseProfile')}</option>
                            {profiles.map((p) => (
                              <option key={p.id} value={p.id} className="text-foreground bg-card">
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {contentText && (
                        <div className="rounded-xl bg-muted/40 p-2.5 text-xs text-muted-foreground border border-border/40">
                          <p className="font-semibold text-[10px] uppercase text-foreground mb-1">{t('content.approvalCardContentLabel')}</p>
                          <p className="line-clamp-2 whitespace-pre-wrap">{contentText}</p>
                        </div>
                      )}

                      {/* Caption Input */}
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-semibold uppercase text-foreground">
                          {t('content.approvalCardCaptionLabel', { defaultValue: 'Caption đăng bài' })}
                        </label>
                        <textarea
                          rows={2}
                          value={currentCaption}
                          onChange={(e) => setEditedCaptions(prev => ({ ...prev, [task.id]: e.target.value }))}
                          className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary text-foreground resize-none"
                          placeholder={t('content.approvalCardCaptionPlaceholder', { defaultValue: 'Nhập caption...' })}
                        />
                      </div>

                      {/* Hashtags Input */}
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-semibold uppercase text-foreground">
                          {t('content.approvalCardHashtagsLabel', { defaultValue: 'Hashtags' })}
                        </label>
                        <input
                          type="text"
                          value={currentHashtags}
                          onChange={(e) => setEditedHashtags(prev => ({ ...prev, [task.id]: e.target.value }))}
                          className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary text-foreground"
                          placeholder="#tiktok #repost..."
                        />
                      </div>

                      <div className="mt-auto flex flex-col gap-3 pt-2 border-t border-border/30">
                        <div className="flex flex-col gap-1.5 rounded-xl bg-muted/20 p-2 border border-border/40">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-semibold uppercase text-muted-foreground flex items-center gap-1">
                              <Clock3 className="size-3" />
                              {t('content.approvalCardScheduleLabel')}
                            </span>
                            {task.status === 'pending' ? (
                              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 dark:text-emerald-400">
                                {t('content.approvalCardStatusApproved')}
                              </span>
                            ) : (
                              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 dark:text-amber-400">
                                {t('content.approvalCardStatusPending')}
                              </span>
                            )}
                          </div>
                          <input
                            type="datetime-local"
                            defaultValue={scheduledAt ? toDateTimeLocalInputValue(new Date(scheduledAt)) : ''}
                            onBlur={(e) => {
                              const val = e.target.value
                              if (val) {
                                const newIso = new Date(val).toISOString()
                                if (newIso !== scheduledAt) {
                                  updateScheduleTimeMutation.mutate({ id: task.id, scheduledAt: newIso })
                                }
                              }
                            }}
                            className="w-full rounded-lg border border-border bg-background px-2.5 py-1 text-xs outline-none focus:ring-1 focus:ring-primary text-foreground"
                          />
                        </div>
                        
                        {task.status === 'pending_approval' ? (
                          <div className="grid grid-cols-2 gap-2 mt-1">
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => {
                                if (confirm(t('content.approvalCardRejectConfirm'))) {
                                  rejectTaskMutation.mutate(task.id)
                                }
                              }}
                              disabled={approveTaskMutation.isPending || rejectTaskMutation.isPending}
                            >
                              {t('content.approvalCardRejectBtn')}
                            </Button>
                            <Button
                              size="sm"
                              className="bg-emerald-600 hover:bg-emerald-700 text-white"
                              onClick={() => {
                                const parsedTags = currentHashtags
                                  .split(/[\s,]+/)
                                  .map((tag: string) => tag.trim().replace(/^#+/, ''))
                                  .filter((tag: string) => tag.length > 0)
                                
                                approveTaskMutation.mutate({
                                  id: task.id,
                                  caption: currentCaption,
                                  hashtags: parsedTags,
                                })
                              }}
                              disabled={approveTaskMutation.isPending || rejectTaskMutation.isPending}
                            >
                              {approveTaskMutation.isPending ? t('content.approvalCardApprovePending') : t('content.approvalCardApproveBtn')}
                            </Button>
                          </div>
                        ) : (
                          <div className="mt-1">
                            <Button
                              size="sm"
                              variant="destructive"
                              className="w-full bg-red-600 hover:bg-red-700 text-white"
                              onClick={() => {
                                if (confirm(t('content.approvalCardDeleteConfirm'))) {
                                  deleteApprovalTaskMutation.mutate(task.id)
                                }
                              }}
                              disabled={deleteApprovalTaskMutation.isPending}
                            >
                              {deleteApprovalTaskMutation.isPending ? t('content.approvalCardDeletePending') : t('content.approvalCardDeleteBtn')}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <ScenarioGenerateModal open={aiScenarioOpen} onClose={() => setAiScenarioOpen(false)} />

      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{t('content.settingsTitle')}</h2>
              <button onClick={() => setSettingsOpen(false)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-col gap-4 p-5">
              <p className="text-xs text-muted-foreground">{t('content.settingsDescription')}</p>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={sharingSettings.autoShare}
                  onChange={(e) =>
                    setSharingSettings((prev) => ({ ...prev, autoShare: e.target.checked }))
                  }
                />
                <span>{t('content.settingsAutoShare')}</span>
              </label>

              {sharingSettings.autoShare && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium">{t('sharing.selectTeam')}</label>
                    <select
                      value={sharingSettings.teamId}
                      onChange={(e) =>
                        setSharingSettings((prev) => ({
                          ...prev,
                          teamId: Number(e.target.value) || '',
                        }))
                      }
                      className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="">{t('sharing.chooseTeam')}</option>
                      {teams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium">{t('sharing.permission')}</label>
                    <select
                      value={sharingSettings.permission}
                      onChange={(e) =>
                        setSharingSettings((prev) => ({
                          ...prev,
                          permission: e.target.value as TeamPermission,
                        }))
                      }
                      className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="view">{t('sharing.permissionView')}</option>
                      <option value="edit">{t('sharing.permissionEdit')}</option>
                    </select>
                  </div>
                </>
              )}

              {settingsError && <p className="text-xs text-destructive">{settingsError}</p>}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setSettingsOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={saveSettings}>{t('common.save')}</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-xl rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">
                {editing ? t('content.editTitle') : t('content.createTitle')}
              </h2>
              <button onClick={closeModal} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-col gap-4 p-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.fieldTitle')}</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                  placeholder={t('content.titlePlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.fieldVideoUrl')}</label>
                <input
                  type="url"
                  value={form.video_url ?? ''}
                  onChange={(e) => setForm((prev) => ({ ...prev, video_url: e.target.value }))}
                  placeholder={t('content.videoUrlPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.fieldImageUrls')}</label>
                <textarea
                  value={imageUrlsInput}
                  onChange={(e) => setImageUrlsInput(e.target.value)}
                  rows={3}
                  placeholder={t('content.imageUrlsPlaceholder')}
                  className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.fieldTextContent')}</label>
                <textarea
                  value={form.text_content ?? ''}
                  onChange={(e) => setForm((prev) => ({ ...prev, text_content: e.target.value }))}
                  rows={4}
                  placeholder={t('content.textContentPlaceholder')}
                  className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.fieldFileUrl')}</label>
                <input
                  type="url"
                  value={form.file_url ?? ''}
                  onChange={(e) => setForm((prev) => ({ ...prev, file_url: e.target.value }))}
                  placeholder={t('content.fileUrlPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.fieldScript')}</label>
                <textarea
                  value={form.script ?? ''}
                  onChange={(e) => setForm((prev) => ({ ...prev, script: e.target.value }))}
                  rows={8}
                  placeholder={t('content.scriptPlaceholder')}
                  className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {formError && <p className="text-xs text-destructive">{formError}</p>}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={closeModal}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleSubmit} disabled={isPending}>
                  {isPending ? t('common.saving') : editing ? t('common.update') : t('common.create')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {genModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold">{t('content.genTitle')}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{t('content.genDescription')}</p>
              </div>
              <button onClick={closeGenerateModal} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-4 overflow-auto p-5">
              {/* ── Step 1: form ───────────────────────────────────────── */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.genOrderLabel')}</label>
                <textarea
                  value={genOrderDescription}
                  onChange={(e) => setGenOrderDescription(e.target.value)}
                  rows={3}
                  placeholder={t('content.genOrderPlaceholder')}
                  className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {/* Mode selector — real_footage (anchor to clip library) vs
                  ai_video (free-form for AI-generated video). Drives the
                  edit-lock matrix on Footage/Time/Note in the editor. */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.genModeLabel')}</label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(['real_footage', 'ai_video'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setGenMode(m)}
                      className={`flex flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition ${
                        genMode === m
                          ? 'border-foreground bg-muted/40'
                          : 'border-border hover:bg-muted/20'
                      }`}
                    >
                      <span className="text-sm font-medium">{t(`content.genMode_${m}`)}</span>
                      <span className="text-[11px] text-muted-foreground">{t(`content.genMode_${m}_desc`)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.genFileLabel')}</label>
                <input
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null
                    setGenFile(f)
                    setGenError('')
                  }}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium hover:file:bg-muted/80"
                />
                {genFile && (
                  <p className="text-xs text-muted-foreground">
                    {genFile.name} · {(genFile.size / 1024).toFixed(1)} KB
                  </p>
                )}
              </div>

              {genError && <p className="text-xs text-destructive">{genError}</p>}

              {/* ── Step 2: result list (after gen succeeds) ───────────── */}
              {generatedScripts.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">
                      {t('content.genResultTitle', { count: generatedScripts.length })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('content.genSelectedCount', { count: selectedKbIndexes.size })}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    {generatedScripts.map((s, i) => {
                      const checked = selectedKbIndexes.has(i)
                      const firstVoice =
                        s.frames.find((f) => typeof f.Voice === 'string' && f.Voice)?.Voice || ''
                      return (
                        <div
                          key={i}
                          className={`flex items-start gap-3 rounded-lg border px-4 py-3 transition-colors ${
                            checked ? 'border-foreground/40 bg-muted/40' : 'border-border'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleScriptSelection(i)}
                            className="mt-1 size-4 shrink-0 rounded"
                          />
                          <button
                            type="button"
                            onClick={() => setDetailScriptIndex(i)}
                            className="flex-1 text-left"
                          >
                            <p className="text-sm font-medium">
                              {[s.kb_name, s.od_number].filter(Boolean).join(' — ') ||
                                t('content.genUntitledScenario')}
                              <span className="ml-2 text-xs font-normal text-muted-foreground">
                                · {s.frames.length} frame
                              </span>
                            </p>
                            {firstVoice && (
                              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                {firstVoice}
                              </p>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDetailScriptIndex(i)}
                            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
                          >
                            {t('content.genViewDetail')}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
              <Button variant="outline" onClick={closeGenerateModal}>
                {t('common.cancel')}
              </Button>
              {generatedScripts.length > 0 && (
                <Button
                  onClick={handleSaveGenerated}
                  disabled={isSavingGenerated || selectedKbIndexes.size === 0}
                  className="gap-1.5"
                >
                  {isSavingGenerated
                    ? t('content.genSaving')
                    : t('content.genSaveAction', { count: selectedKbIndexes.size })}
                </Button>
              )}
              <Button onClick={handleGenerateContent} disabled={isGenerating}>
                {isGenerating
                  ? t('content.genGenerating')
                  : generatedScripts.length > 0
                    ? t('content.genRegenerate')
                    : t('content.genStart')}
              </Button>
            </div>
          </div>
        </div>
      )}


      {/* Detail popup — shown on top of the gen modal when a KB is opened */}
      {detailScriptIndex !== null && generatedScripts[detailScriptIndex] && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold">
                  {[
                    generatedScripts[detailScriptIndex].kb_name,
                    generatedScripts[detailScriptIndex].od_number,
                  ]
                    .filter(Boolean)
                    .join(' — ') || t('content.genUntitledScenario')}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {generatedScripts[detailScriptIndex].frames.length} frame
                </p>
              </div>
              <button
                onClick={() => setDetailScriptIndex(null)}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="overflow-auto p-5">
              <div className="flex flex-col gap-3">
                {generatedScripts[detailScriptIndex].frames.map((frame, i) => (
                  <div key={i} className="rounded-lg border border-border bg-background p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                        Frame {String(frame.Frame ?? i + 1)}
                      </span>
                      {frame['Phần'] && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                          {String(frame['Phần'])}
                        </span>
                      )}
                    </div>
                    {frame.Voice && (
                      <p className="mb-1 text-sm">
                        <span className="font-medium">Voice: </span>
                        {String(frame.Voice)}
                      </p>
                    )}
                    {frame.Footage && (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium">Footage: </span>
                        {String(frame.Footage)}
                      </p>
                    )}
                    {frame.Time && (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium">Time: </span>
                        {String(frame.Time)}
                      </p>
                    )}
                    {frame.Note && (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium">Note: </span>
                        {String(frame.Note)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Repost single video modal ────────────────────────────────── */}
      {repostModalVideo !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold">{t('content.repostModalTitle')}</h3>
              <button
                className="rounded p-1 hover:bg-muted"
                onClick={closeRepostModal}
              >
                <X className="size-4" />
              </button>
            </div>

            <p className="mb-3 text-xs text-muted-foreground line-clamp-2">
              {repostModalVideo.title || repostModalVideo.url}
            </p>

            <div className="mb-4 rounded-xl border border-sky-300/50 bg-sky-500/5 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Bot className="size-4 text-sky-600" />
                    {t('content.repostAiSectionTitle')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('content.repostAiHint')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleRewriteOrCreateRepostContent('rewrite')}
                    disabled={repostAiLoading || repostLoading}
                  >
                    <Bot className="mr-1 size-4" />
                    {t('content.repostAiRewrite')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleRewriteOrCreateRepostContent('create')}
                    disabled={repostAiLoading || repostLoading}
                  >
                    <Bot className="mr-1 size-4" />
                    {t('content.repostAiCreate')}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={handleOpenRepostAiSettings}
                    disabled={repostAiLoading || repostLoading}
                    aria-label={t('content.repostAiSettings')}
                  >
                    <Settings className="size-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Platform selector */}
            <div className="mb-3 flex gap-2">
              {(['facebook', 'youtube', 'tiktok'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setRepostPlatform(p)}
                  className={`flex-1 rounded-xl border py-2 text-sm font-medium capitalize transition ${
                    repostPlatform === p
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {p === 'facebook' ? 'Facebook' : p === 'youtube' ? 'YouTube' : 'TikTok'}
                </button>
              ))}
            </div>

            {/* Facebook / YouTube fields */}
            {repostPlatform !== 'tiktok' && (
              <>
                {repostPlatform === 'facebook' && (
                  <div className="mb-3 flex flex-col gap-1.5">
                    <label className="text-xs font-medium">{t('content.repostSelectPage')}</label>
                    <select
                      className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      value={repostFbPageId ?? ''}
                      onChange={(e) => setRepostFbPageId(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">{t('content.repostPagePlaceholder')}</option>
                      {facebookPages.map((page) => (
                        <option key={page.id} value={page.id}>
                          {page.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {repostPlatform === 'youtube' && (
                  <div className="mb-3 flex flex-col gap-1.5">
                    <label className="text-xs font-medium">{t('content.repostSelectProfile')}</label>
                    <select
                      className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      value={repostYoutubeProfileId ?? ''}
                      onChange={(e) => setRepostYoutubeProfileId(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">{t('content.repostProfilePlaceholder')}</option>
                      {profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="mb-3 flex flex-col gap-1.5">
                  <label className="text-xs font-medium">{t('content.repostContentLabel')}</label>
                  <textarea
                    className="min-h-[120px] w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-y"
                    value={repostContent}
                    onChange={(e) => setRepostContent(e.target.value)}
                    placeholder={t('content.repostContentPlaceholder')}
                  />
                </div>
                <div className="mb-4 flex flex-col gap-1.5">
                  <label className="text-xs font-medium">{t('content.repostScheduledAt')}</label>
                  <input
                    type="datetime-local"
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    value={repostScheduledAt}
                    onChange={(e) => setRepostScheduledAt(e.target.value)}
                  />
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">{t('content.repostQuickTimeLabel')}</span>
                    {repostQuickScheduleOptions.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        onClick={() => setRepostScheduledAt(option.value)}
                        className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* TikTok fields */}
            {repostPlatform === 'tiktok' && (
              <>
                {/* Channel (profile) */}
                <div className="mb-3 flex flex-col gap-1.5">
                  <label className="text-xs font-medium">{t('content.repostTiktokSelectChannel')}</label>
                  <select
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    value={repostTiktokProfileId ?? ''}
                    onChange={(e) => setRepostTiktokProfileId(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">{t('content.repostTiktokChannelPlaceholder')}</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>

                {/* Content text */}
                <div className="mb-3 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium">{t('content.repostTiktokContentLabel')}</label>
                    <span className="rounded-full border border-sky-300/50 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                      {t('content.repostAiAvailable')}
                    </span>
                  </div>
                  <textarea
                    className="min-h-[100px] w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-y"
                    value={repostTiktokContentText}
                    onChange={(e) => setRepostTiktokContentText(e.target.value)}
                    placeholder={t('content.repostTiktokContentPlaceholder')}
                  />
                </div>

                {/* Background description */}
                <div className="mb-3 flex flex-col gap-1.5">
                  <label className="text-xs font-medium">{t('content.repostTiktokBackgroundLabel')}</label>
                  <textarea
                    className="min-h-[60px] w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-y"
                    value={repostTiktokBackground}
                    onChange={(e) => setRepostTiktokBackground(e.target.value)}
                    placeholder={t('content.repostTiktokBackgroundPlaceholder')}
                  />
                  <label className="text-xs font-medium">{t('content.repostTiktokRefImageLabel')}</label>
                  <input
                    type="file"
                    accept="image/*"
                    className="block w-full cursor-pointer rounded-lg border border-border bg-background px-3 py-2 text-sm file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
                    onChange={(e) => setRepostTiktokRefImage(e.target.files?.[0] ?? null)}
                  />
                  {repostTiktokRefImage && (
                    <p className="truncate text-xs text-muted-foreground">{repostTiktokRefImage.name}</p>
                  )}
                </div>

                {/* Music */}
                <div className="mb-3 flex flex-col gap-1.5">
                  <label className="text-xs font-medium">{t('content.repostTiktokMusicLabel')}</label>
                  <div className="flex gap-2">
                    {(['default', 'custom'] as const).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setRepostTiktokMusicType(opt)}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                          repostTiktokMusicType === opt
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        {opt === 'default' ? t('content.repostTiktokMusicDefault') : t('content.repostTiktokMusicCustom')}
                      </button>
                    ))}
                  </div>
                  {repostTiktokMusicType === 'default' && (
                    <p className="mt-1 truncate rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      {repostTiktokMusicPath || t('content.repostTiktokMusicNoPath')}
                    </p>
                  )}
                  {repostTiktokMusicType === 'custom' && (
                    <input
                      type="file"
                      accept="audio/*"
                      className="mt-1.5 block w-full cursor-pointer rounded-lg border border-border bg-background px-3 py-2 text-sm file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
                      onChange={(e) => setRepostTiktokMusicFile(e.target.files?.[0] ?? null)}
                    />
                  )}
                </div>

                {/* Style + Duration */}
                <div className="mb-4 grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">Style video</label>
                    <select
                      value={repostTiktokStyle}
                      onChange={(e: { target: HTMLSelectElement }) => setRepostTiktokStyle(e.target.value)}
                      className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    >
                      <option value="healing">Healing</option>
                      <option value="edu">Edu</option>
                      <option value="confession">Confession</option>
                      <option value="vlog">Vlog</option>
                      <option value="luxury">Luxury</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium">Độ dài (giây)</label>
                    <select
                      value={repostTiktokDuration}
                      onChange={(e: { target: HTMLSelectElement }) => setRepostTiktokDuration(e.target.value === '' ? '' : Number(e.target.value))}
                      className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    >
                      <option value="">Tự động</option>
                      <option value={5}>5s</option>
                      <option value={10}>10s</option>
                      <option value={15}>15s</option>
                      <option value={30}>30s</option>
                      <option value={60}>60s</option>
                      <option value={90}>90s</option>
                    </select>
                  </div>
                </div>

                {/* Animation Toggle */}
                <div className="mb-4 flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="repostTiktokAnimation"
                    checked={repostTiktokAnimation}
                    onChange={(e) => setRepostTiktokAnimation(e.target.checked)}
                    className="size-4 rounded border-border text-primary focus:ring-primary"
                  />
                  <label htmlFor="repostTiktokAnimation" className="text-xs font-medium cursor-pointer select-none">
                    Kích hoạt Animation (Hoạt cảnh video)
                  </label>
                </div>
              </>
            )}

            {repostError && <p className="mb-3 text-xs text-destructive">{repostError}</p>}
            {repostLoading && repostLoadingStep && (
              <p className="mb-3 text-xs text-muted-foreground">{repostLoadingStep}</p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeRepostModal} disabled={repostLoading || repostAiLoading}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleRepostSubmit} disabled={repostLoading || repostAiLoading}>
                {repostLoading ? t('common.saving') : repostAiLoading ? t('common.loading') : t('content.repostSubmit')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {repostAiSettingsOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">{t('content.repostAiSettingsTitle')}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{t('content.repostAiSettingsDesc')}</p>
              </div>
              <button
                className="rounded p-1 hover:bg-muted"
                onClick={() => setRepostAiSettingsOpen(false)}
                disabled={repostAiSettingsSaving}
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">{t('content.repostAiPromptLabel')}</label>
              <textarea
                className="min-h-[240px] w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-y"
                value={repostAiSystemPrompt}
                onChange={(e) => setRepostAiSystemPrompt(e.target.value)}
                placeholder={t('content.repostAiPromptPlaceholder')}
                disabled={repostAiSettingsLoading || repostAiSettingsSaving}
              />
              {repostAiSettingsError && <p className="text-xs text-destructive">{repostAiSettingsError}</p>}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setRepostAiSettingsOpen(false)}
                disabled={repostAiSettingsSaving}
              >
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSaveRepostAiSettings} disabled={repostAiSettingsLoading || repostAiSettingsSaving}>
                {repostAiSettingsSaving ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Repost All modal ─────────────────────────────────────────────── */}
      {repostAllModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold">{t('content.repostAllModalTitle')}</h3>
              <button className="rounded p-1 hover:bg-muted" onClick={() => setRepostAllModalOpen(false)}>
                <X className="size-4" />
              </button>
            </div>

            <p className="mb-4 text-xs text-muted-foreground">
              {t('content.repostAllModalDesc', { count: researchResult?.videos.length ?? 0 })}
            </p>

            {/* Video count */}
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="text-xs font-medium">Số lượng video muốn đăng</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={researchResult?.videos.length ?? 100}
                  className="w-24 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                  value={repostAllCount}
                  onChange={(e) => setRepostAllCount(e.target.value === '' ? '' : Math.min(Math.max(1, Number(e.target.value)), researchResult?.videos.length ?? 100))}
                  placeholder="Tất cả"
                />
                <span className="text-xs text-muted-foreground">
                  / {researchResult?.videos.length ?? 0} video
                </span>
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => setRepostAllCount(researchResult?.videos.length ?? '')}
                >
                  Tất cả
                </button>
              </div>
            </div>

            {/* Platform selector */}
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="text-xs font-medium">Nền tảng</label>
              <div className="flex gap-2">
                {(['facebook', 'tiktok'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setRepostAllPlatform(p)}
                    className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition ${repostAllPlatform === p ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:border-primary/50'}`}
                  >
                    {p === 'facebook' ? 'Facebook' : 'TikTok'}
                  </button>
                ))}
              </div>
            </div>

            {/* Channel / page selector */}
            {repostAllPlatform === 'facebook' ? (
              <div className="mb-3 flex flex-col gap-1.5">
                <label className="text-xs font-medium">{t('content.repostSelectPage')}</label>
                <select
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  value={repostAllFbPageId ?? ''}
                  onChange={(e) => setRepostAllFbPageId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">{t('content.repostPagePlaceholder')}</option>
                  {facebookPages.map((page) => (
                    <option key={page.id} value={page.id}>{page.name}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="mb-3 flex flex-col gap-1.5">
                <label className="text-xs font-medium">Kênh TikTok</label>
                <select
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  value={repostAllTiktokProfileId ?? ''}
                  onChange={(e) => setRepostAllTiktokProfileId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Chọn kênh...</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Schedule mode */}
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="text-xs font-medium">Lịch đăng</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setRepostAllScheduleMode('every30')}
                  className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition ${repostAllScheduleMode === 'every30' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:border-primary/50'}`}
                >
                  Cách 30 phút / video
                </button>
                <button
                  type="button"
                  onClick={() => setRepostAllScheduleMode('interval')}
                  className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition ${repostAllScheduleMode === 'interval' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:border-primary/50'}`}
                >
                  Tùy chỉnh khoảng cách
                </button>
              </div>
              {repostAllScheduleMode === 'interval' && (
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="number"
                    min={1}
                    className="w-20 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                    value={repostAllInterval}
                    onChange={(e) => setRepostAllInterval(Math.max(1, Number(e.target.value)))}
                  />
                  <span className="text-xs text-muted-foreground">phút giữa mỗi video</span>
                </div>
              )}
            </div>

            {/* Base scheduled time */}
            <div className="mb-4 flex flex-col gap-1.5">
              <label className="text-xs font-medium">{t('content.repostAllScheduledAtLabel')}</label>
              <p className="text-[11px] text-muted-foreground">{t('content.repostAllScheduledAtHint')}</p>
              <input
                type="datetime-local"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={repostAllScheduledAt}
                onChange={(e) => setRepostAllScheduledAt(e.target.value)}
              />
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-muted-foreground">{t('content.repostQuickTimeLabel')}</span>
                {repostQuickScheduleOptions.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setRepostAllScheduledAt(option.value)}
                    className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {repostAllError && <p className="mb-3 text-xs text-destructive">{repostAllError}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRepostAllModalOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleRepostAll} disabled={repostAllLoading}>
                {repostAllLoading ? t('common.saving') : t('content.repostAllSubmit')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {crawlModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">
                {editingCrawl ? t('content.crawl.editTitle') : t('content.crawl.createTitle')}
              </h2>
              <button onClick={closeCrawlModal} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-col gap-4 p-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.crawl.fieldUrl')}</label>
                <input
                  type="url"
                  value={crawlForm.url}
                  onChange={(e) => setCrawlForm((prev) => ({ ...prev, url: e.target.value }))}
                  placeholder={t('content.crawl.urlPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.crawl.fieldSourceType')}</label>
                <select
                  value={crawlForm.source_type}
                  onChange={(e) => setCrawlForm((prev) => ({
                    ...prev,
                    source_type: e.target.value as CrawlSourceType,
                    device_id: SOCIAL_SOURCE_TYPES.includes(e.target.value as CrawlSourceType) ? prev.device_id : null,
                  }))}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="web">{t('content.crawl.sourceType.web')}</option>
                  <option value="facebook">{t('content.crawl.sourceType.facebook')}</option>
                  <option value="tiktok">{t('content.crawl.sourceType.tiktok')}</option>
                  <option value="youtube">{t('content.crawl.sourceType.youtube')}</option>
                  <option value="threads">{t('content.crawl.sourceType.threads')}</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  {SOCIAL_SOURCE_TYPES.includes(crawlForm.source_type)
                    ? t('content.crawl.sourceTypeHintSocial')
                    : t('content.crawl.sourceTypeHintWeb')}
                </p>
              </div>

              {SOCIAL_SOURCE_TYPES.includes(crawlForm.source_type) && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('content.crawl.fieldDevice')}</label>
                  <select
                    value={crawlForm.device_id ?? ''}
                    onChange={(e) => setCrawlForm((prev) => ({
                      ...prev,
                      device_id: Number(e.target.value) || null,
                    }))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">{t('content.crawl.chooseDevice')}</option>
                    {devices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name} ({device.status})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.crawl.fieldFrequency')}</label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={1}
                    value={crawlForm.crawl_frequency_minutes}
                    onChange={(e) => setCrawlForm((prev) => ({
                      ...prev,
                      crawl_frequency_minutes: Math.max(1, parseInt(e.target.value) || 1),
                    }))}
                    className="w-28 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <span className="text-sm text-muted-foreground">
                    {t('content.crawl.freqUnit')}
                    {crawlForm.crawl_frequency_minutes >= 60 && (
                      <span className="ml-2 text-xs text-muted-foreground/70">
                        (≈ {(crawlForm.crawl_frequency_minutes / 60).toFixed(1)} {t('content.crawl.freqHoursUnit')})
                      </span>
                    )}
                  </span>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={crawlForm.is_active ?? true}
                  onChange={(e) => setCrawlForm((prev) => ({ ...prev, is_active: e.target.checked }))}
                />
                <span>{t('content.crawl.fieldActive')}</span>
              </label>

              {crawlFormError && <p className="text-xs text-destructive">{crawlFormError}</p>}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={closeCrawlModal}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleCrawlSubmit} disabled={isCrawlPending}>
                  {isCrawlPending ? t('common.saving') : editingCrawl ? t('common.update') : t('common.create')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
