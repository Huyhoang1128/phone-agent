import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  BotMessageSquare,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Clock,
  Heart,
  Loader2,
  MessageCircle,
  Trash2,
  Users,
  Play,
  Pencil,
  Save,
  X,
  Eye,
  Maximize2,
  Minimize2,
} from 'lucide-react'
import { agentGroupsApi, tiktokApi } from '@/lib/api'
import { useToast } from '@/context/ToastContext'
import type {
  AgentGroup,
  TiktokCommentClusterResponse,
  TiktokVideo,
  TiktokVideoInteraction,
  TiktokCommentPlan,
  TiktokVideoUserComment,
} from '@/lib/types'

type InteractionTab = 'all' | 'like' | 'comment'

function getCommentReplyTo(plan: TiktokCommentPlan) {
  return (plan.reply_to ?? '').trim()
}

function getCommentContent(plan: TiktokCommentPlan) {
  return (plan.comment_content ?? '').trim()
}

function getExecutionStatusI18nKey(status: TiktokCommentPlan['execution_status']) {
  switch (status) {
    case 'scheduled':
      return 'tiktok.commentPlanExecutionStatusScheduled'
    case 'running':
      return 'tiktok.commentPlanExecutionStatusRunning'
    case 'completed':
      return 'tiktok.commentPlanExecutionStatusCompleted'
    case 'failed':
      return 'tiktok.commentPlanExecutionStatusFailed'
    default:
      return 'tiktok.commentPlanExecutionStatusIdle'
  }
}

export default function TiktokVideoDetailPage() {
  const { t } = useTranslation()
  const { showToast } = useToast()
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const videoId = Number(params.id)
  const queryClient = useQueryClient()

  // Go back to the previous page (POP) so ScrollRestoration restores its
  // scroll position; fall back to the TikTok list on a direct deep-link.
  function handleBack() {
    if (window.history.length > 1) navigate(-1)
    else navigate('/tiktok')
  }

  const [activeTab, setActiveTab] = useState<InteractionTab>('all')
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [groupSelectorOpen, setGroupSelectorOpen] = useState(false)
  const [isDispatchingComments, setIsDispatchingComments] = useState(false)
  const [isDispatchingSingleComment, setIsDispatchingSingleComment] = useState(false)
  const [approvingPlanId, setApprovingPlanId] = useState<number | null>(null)
  const [isApprovingAll, setIsApprovingAll] = useState(false)
  const [editingPlanId, setEditingPlanId] = useState<number | null>(null)
  const [editCommentContent, setEditCommentContent] = useState('')
  const [savingEditPlanId, setSavingEditPlanId] = useState<number | null>(null)
  const [deletingPlanId, setDeletingPlanId] = useState<number | null>(null)
  const [deletingClusterPlanId, setDeletingClusterPlanId] = useState<number | null>(null)
  const [executingClusterPlanId, setExecutingClusterPlanId] = useState<number | null>(null)
  const [isDeletingPendingPlans, setIsDeletingPendingPlans] = useState(false)
  const [contentModalOpen, setContentModalOpen] = useState(false)
  const [showVideoComments, setShowVideoComments] = useState(false)
  const [isFetchingVideoComments, setIsFetchingVideoComments] = useState(false)
  const [isAnalyzingVideoComments, setIsAnalyzingVideoComments] = useState(false)
  const [commentClusterResult, setCommentClusterResult] = useState<TiktokCommentClusterResponse | null>(null)
  const [hoveredPointIdx, setHoveredPointIdx] = useState<number | null>(null)
  const [isChartExpanded, setIsChartExpanded] = useState(false)

  const clusterPalette = ['#58a6ff', '#f78166', '#3fb950', '#d2a8ff', '#ffa657', '#79c0ff', '#ff7b72', '#7ee787']

  const { data: video } = useQuery<TiktokVideo>({
    queryKey: ['tiktok-video', videoId],
    queryFn: () => tiktokApi.get(videoId),
    enabled: Number.isFinite(videoId),
  })

  const { data: interactions = [], isLoading: interactionsLoading } = useQuery<TiktokVideoInteraction[]>({
    queryKey: ['tiktok-interactions', videoId],
    queryFn: () => tiktokApi.listInteractions(videoId),
    enabled: Number.isFinite(videoId),
  })

  const { data: groups = [], isLoading: groupsLoading } = useQuery<AgentGroup[]>({
    queryKey: ['agent-groups'],
    queryFn: agentGroupsApi.list,
  })

  const { data: commentPlans = [], isLoading: commentPlansLoading } = useQuery<TiktokCommentPlan[]>({
    queryKey: ['tiktok-comment-plans', videoId],
    queryFn: () => tiktokApi.listCommentPlans(videoId),
    enabled: Number.isFinite(videoId),
  })

  const { data: videoComments = [], isLoading: videoCommentsLoading } = useQuery<TiktokVideoUserComment[]>({
    queryKey: ['tiktok-video-comments', videoId],
    queryFn: () => tiktokApi.listVideoComments(videoId),
    enabled: Number.isFinite(videoId) && showVideoComments,
  })

  const filteredInteractions = useMemo(() => {
    if (activeTab === 'all') return interactions
    return interactions.filter((item) => item.interaction_type === activeTab)
  }, [activeTab, interactions])

  const orderedCommentPlans = useMemo(
    () =>
      [...commentPlans].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ),
    [commentPlans],
  )
  const pendingCommentPlans = useMemo(
    () => orderedCommentPlans.filter((plan) => !plan.is_approved),
    [orderedCommentPlans],
  )

  const commentPlanClusterSizes = useMemo(() => {
    const clusterSizes = new Map<number, number>()
    for (const plan of orderedCommentPlans) {
      if (getCommentReplyTo(plan)) continue
      const rootContent = getCommentContent(plan)
      const replyCount = rootContent
        ? orderedCommentPlans.filter((item) => getCommentReplyTo(item) === rootContent).length
        : 0
      clusterSizes.set(plan.id, 1 + replyCount)
    }
    return clusterSizes
  }, [orderedCommentPlans])
  const commentPlanClusterFailures = useMemo(() => {
    const failures = new Map<number, boolean>()
    for (const plan of orderedCommentPlans) {
      if (getCommentReplyTo(plan)) continue
      const rootContent = getCommentContent(plan)
      const hasFailedReply = rootContent
        ? orderedCommentPlans.some((item) => getCommentReplyTo(item) === rootContent && item.execution_status === 'failed')
        : false
      failures.set(plan.id, plan.execution_status === 'failed' || hasFailedReply)
    }
    return failures
  }, [orderedCommentPlans])

  const likeCount = interactions.filter((item) => item.interaction_type === 'like').length
  const commentCount = interactions.filter((item) => item.interaction_type === 'comment').length
  const hasExplicitGroupSelection = selectedGroupId !== null
  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? (groups.length > 0 ? groups[0] : null)
  const availableCount = selectedGroup
    ? selectedGroup.members.filter(
        (m) => m.device_status === 'online' || m.device_status === 'connected',
      ).length
    : 0
  const videoContent = (video?.content ?? '').trim()
  const hasVideoContent = videoContent.length > 0

  useEffect(() => {
    if (!contentModalOpen && !isChartExpanded) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContentModalOpen(false)
        setIsChartExpanded(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [contentModalOpen, isChartExpanded])

  async function handleDispatchComments(type: 'cluster' | 'single') {
    if (!video || !selectedGroup || !hasExplicitGroupSelection) return
    if (type === 'cluster' && isDispatchingComments) return
    if (type === 'single' && isDispatchingSingleComment) return
    if (selectedGroup.members.length === 0) {
      showToast(t('tiktok.detailDispatchNoDevices'), 'error')
      return
    }

    if (type === 'cluster') {
      setIsDispatchingComments(true)
    } else {
      setIsDispatchingSingleComment(true)
    }
    try {
      const dispatcher = type === 'cluster' ? tiktokApi.dispatchComments : tiktokApi.dispatchSingleComment
      const result = await dispatcher(video.id, {
        video_url: video.video_url ?? '',
        content: video.content ?? '',
        keywords: video.keywords ?? [],
        agent_group: selectedGroup.id,
        devices: selectedGroup.members.map((member) => member.device),
      })
      const count = result.comment_plans?.length ?? 0
      if (count > 0) {
        showToast(
          type === 'cluster'
            ? t('tiktok.detailDispatchSuccess', { count })
            : t('tiktok.detailDispatchSingleSuccess', { count }),
          'success',
        )
        queryClient.invalidateQueries({ queryKey: ['tiktok-comment-plans', video.id] })
      } else {
        showToast(
          type === 'cluster' ? t('tiktok.detailDispatchSuccessEmpty') : t('tiktok.detailDispatchSingleSuccessEmpty'),
          'success',
        )
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : type === 'cluster'
          ? t('tiktok.detailDispatchError')
          : t('tiktok.detailDispatchSingleError')
      showToast(message, 'error')
    } finally {
      if (type === 'cluster') {
        setIsDispatchingComments(false)
      } else {
        setIsDispatchingSingleComment(false)
      }
    }
  }

  async function handleApproveCommentPlan(planId: number) {
    if (approvingPlanId !== null) return
    setApprovingPlanId(planId)
    try {
      await tiktokApi.updateCommentPlan(videoId, planId, { is_approved: true })
      queryClient.invalidateQueries({ queryKey: ['tiktok-comment-plans', videoId] })
      showToast(t('tiktok.commentPlanApproveSuccess'), 'success')
    } catch {
      showToast(t('tiktok.commentPlanApproveError'), 'error')
    } finally {
      setApprovingPlanId(null)
    }
  }

  async function handleApproveAllCommentPlans() {
    if (isApprovingAll) return
    setIsApprovingAll(true)
    try {
      const result = await tiktokApi.approveAllCommentPlans(videoId)
      queryClient.invalidateQueries({ queryKey: ['tiktok-comment-plans', videoId] })
      showToast(t('tiktok.commentPlanApproveAllSuccess', { count: result.approved }), 'success')
    } catch {
      showToast(t('tiktok.commentPlanApproveAllError'), 'error')
    } finally {
      setIsApprovingAll(false)
    }
  }

  async function handleDeletePendingCommentPlans() {
    if (isDeletingPendingPlans || isMutatingCommentPlan) return
    if (pendingCommentPlans.length === 0) return
    if (!window.confirm(t('tiktok.commentPlanDeletePendingConfirm', { count: pendingCommentPlans.length }))) return

    setIsDeletingPendingPlans(true)
    const pendingIds = pendingCommentPlans.map((plan) => plan.id)
    try {
      const results = await Promise.allSettled(pendingIds.map((id) => tiktokApi.deleteCommentPlan(videoId, id)))
      const deletedCount = results.filter((result) => result.status === 'fulfilled').length
      const failedCount = results.length - deletedCount
      queryClient.invalidateQueries({ queryKey: ['tiktok-comment-plans', videoId] })
      if (editingPlanId !== null && pendingIds.includes(editingPlanId)) {
        setEditingPlanId(null)
        setEditCommentContent('')
      }
      if (failedCount > 0) {
        showToast(t('tiktok.commentPlanDeletePendingPartialError', { deleted: deletedCount, failed: failedCount }), 'error')
      } else {
        showToast(t('tiktok.commentPlanDeletePendingSuccess', { count: deletedCount }), 'success')
      }
    } finally {
      setIsDeletingPendingPlans(false)
    }
  }

  const isMutatingCommentPlan =
    savingEditPlanId !== null || deletingPlanId !== null || deletingClusterPlanId !== null || isDeletingPendingPlans

  async function handleExecuteCommentPlanCluster(plan: TiktokCommentPlan, forceRestart = false) {
    if (executingClusterPlanId !== null) return
    setExecutingClusterPlanId(plan.id)
    try {
      await tiktokApi.executeCommentPlanCluster(videoId, plan.id, forceRestart)
      queryClient.invalidateQueries({ queryKey: ['tiktok-comment-plans', videoId] })
      showToast(
        forceRestart ? t('tiktok.commentPlanRetryClusterSuccess') : t('tiktok.commentPlanExecuteClusterSuccess'),
        'success',
      )
    } catch {
      showToast(
        forceRestart ? t('tiktok.commentPlanRetryClusterError') : t('tiktok.commentPlanExecuteClusterError'),
        'error',
      )
    } finally {
      setExecutingClusterPlanId(null)
    }
  }

  function handleStartEditCommentPlan(plan: TiktokCommentPlan) {
    if (isMutatingCommentPlan) return
    setEditingPlanId(plan.id)
    setEditCommentContent(plan.comment_content)
  }

  function handleCancelEditCommentPlan() {
    if (savingEditPlanId !== null) return
    setEditingPlanId(null)
    setEditCommentContent('')
  }

  async function handleSaveEditCommentPlan(plan: TiktokCommentPlan) {
    if (savingEditPlanId !== null) return
    const nextContent = editCommentContent.trim()
    if (!nextContent) {
      showToast(t('tiktok.commentPlanEditRequired'), 'error')
      return
    }
    if (nextContent === plan.comment_content) {
      handleCancelEditCommentPlan()
      return
    }

    setSavingEditPlanId(plan.id)
    try {
      await tiktokApi.updateCommentPlan(videoId, plan.id, { comment_content: nextContent })
      queryClient.invalidateQueries({ queryKey: ['tiktok-comment-plans', videoId] })
      showToast(t('tiktok.commentPlanEditSuccess'), 'success')
      setEditingPlanId(null)
      setEditCommentContent('')
    } catch {
      showToast(t('tiktok.commentPlanEditError'), 'error')
    } finally {
      setSavingEditPlanId(null)
    }
  }

  async function handleDeleteCommentPlan(planId: number) {
    if (isMutatingCommentPlan) return
    if (!window.confirm(t('tiktok.commentPlanDeleteConfirm'))) return
    setDeletingPlanId(planId)
    try {
      await tiktokApi.deleteCommentPlan(videoId, planId)
      queryClient.invalidateQueries({ queryKey: ['tiktok-comment-plans', videoId] })
      if (editingPlanId === planId) {
        setEditingPlanId(null)
        setEditCommentContent('')
      }
      showToast(t('tiktok.commentPlanDeleteSuccess'), 'success')
    } catch {
      showToast(t('tiktok.commentPlanDeleteError'), 'error')
    } finally {
      setDeletingPlanId(null)
    }
  }

  async function handleDeleteCommentPlanCluster(plan: TiktokCommentPlan) {
    if (isMutatingCommentPlan) return
    const rootContent = getCommentContent(plan)
    if (getCommentReplyTo(plan) || !rootContent) {
      await handleDeleteCommentPlan(plan.id)
      return
    }

    const ids = [
      plan.id,
      ...orderedCommentPlans
        .filter((item) => item.id !== plan.id && getCommentReplyTo(item) === rootContent)
        .map((item) => item.id),
    ]

    if (ids.length <= 1) {
      await handleDeleteCommentPlan(plan.id)
      return
    }

    if (!window.confirm(t('tiktok.commentPlanDeleteClusterConfirm', { count: ids.length }))) return

    setDeletingClusterPlanId(plan.id)
    try {
      const results = await Promise.allSettled(ids.map((id) => tiktokApi.deleteCommentPlan(videoId, id)))
      const deletedCount = results.filter((result) => result.status === 'fulfilled').length
      const failedCount = results.length - deletedCount
      queryClient.invalidateQueries({ queryKey: ['tiktok-comment-plans', videoId] })
      if (editingPlanId !== null && ids.includes(editingPlanId)) {
        setEditingPlanId(null)
        setEditCommentContent('')
      }
      if (failedCount > 0) {
        showToast(t('tiktok.commentPlanDeleteClusterPartialError', { deleted: deletedCount, failed: failedCount }), 'error')
      } else {
        showToast(t('tiktok.commentPlanDeleteClusterSuccess', { count: deletedCount }), 'success')
      }
    } catch {
      showToast(t('tiktok.commentPlanDeleteClusterError'), 'error')
    } finally {
      setDeletingClusterPlanId(null)
    }
  }

  async function handleFetchVideoComments() {
    if (isFetchingVideoComments) return
    setIsFetchingVideoComments(true)
    try {
      const result = await tiktokApi.fetchVideoComments(videoId)
      queryClient.invalidateQueries({ queryKey: ['tiktok-video-comments', videoId] })
      showToast(t('tiktok.videoCommentsFetchSuccess', { saved: result.saved, total: result.total }), 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : t('tiktok.videoCommentsFetchError')
      showToast(message, 'error')
    } finally {
      setIsFetchingVideoComments(false)
    }
  }

  async function handleAnalyzeVideoComments() {
    if (isAnalyzingVideoComments) return
    setIsAnalyzingVideoComments(true)
    try {
      const result = await tiktokApi.clusterVideoComments(videoId)
      setCommentClusterResult(result)
      showToast(t('tiktok.videoCommentsAnalyzeSuccess', { count: result.count, clusters: result.n_clusters }), 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : t('tiktok.videoCommentsAnalyzeError')
      showToast(message, 'error')
    } finally {
      setIsAnalyzingVideoComments(false)
    }
  }

  const clusterPlotPoints = useMemo(() => {
    if (!commentClusterResult) return []
    const points = commentClusterResult.points
      .map((point, index) => ({ point, index }))
      .filter(({ point }) => typeof point.x === 'number' && typeof point.y === 'number')

    if (points.length === 0) return []

    const xs = points.map(({ point }) => point.x as number)
    const ys = points.map(({ point }) => point.y as number)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const spanX = Math.max(maxX - minX, 1e-9)
    const spanY = Math.max(maxY - minY, 1e-9)

    return points.map(({ point, index }) => {
      const cluster = typeof point.cluster === 'number' ? point.cluster : -1
      const color = cluster < 0 ? '#6b7280' : clusterPalette[cluster % clusterPalette.length]
      const leftPct = 5 + (((point.x as number) - minX) / spanX) * 90
      const topPct = 95 - ((((point.y as number) - minY) / spanY) * 90)
      return {
        index,
        point,
        cluster,
        color,
        leftPct,
        topPct,
      }
    })
  }, [commentClusterResult])

  const clusterLegend = useMemo(() => {
    const seen = new Set<number>()
    for (const { cluster } of clusterPlotPoints) seen.add(cluster)
    return Array.from(seen).sort((a, b) => a - b)
  }, [clusterPlotPoints])

  const clusterCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const { cluster } of clusterPlotPoints) {
      counts.set(cluster, (counts.get(cluster) ?? 0) + 1)
    }
    return counts
  }, [clusterPlotPoints])

  if (!Number.isFinite(videoId)) {
    return <div className="text-sm text-destructive">{t('tiktok.detailInvalidVideoId')}</div>
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <button
            onClick={handleBack}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {t('tiktok.detailBack')}
          </button>
          <h1 className="mt-1 text-lg font-semibold">{t('tiktok.detailTitle')}</h1>
          {video?.video_url ? (
            <a
              href={video.video_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {video.video_url}
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">{`#${videoId}`}</p>
          )}
        </div>
        <button
          onClick={() => setContentModalOpen(true)}
          disabled={!hasVideoContent}
          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Eye className="size-3.5" />
          <span>{t('tiktok.detailViewContent')}</span>
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="overflow-visible rounded-xl border border-border bg-card p-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="relative">
                <button
                  onClick={() => setGroupSelectorOpen((v) => !v)}
                  className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
                >
                  <BotMessageSquare className="size-4 text-primary" />
                  {groupsLoading ? (
                    <span className="text-muted-foreground">{t('common.loading')}</span>
                  ) : selectedGroup ? (
                    <span>{selectedGroup.name}</span>
                  ) : (
                    <span className="text-muted-foreground">{t('agentGroupChat.selectGroup')}</span>
                  )}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </button>

                {groupSelectorOpen && (
                  <div className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-xl border border-border bg-popover shadow-lg">
                    <div className="p-1">
                      {groups.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-muted-foreground">{t('agentGroupChat.noGroups')}</p>
                      ) : (
                        groups.map((g) => (
                          <button
                            key={g.id}
                            onClick={() => {
                              setSelectedGroupId(g.id)
                              setGroupSelectorOpen(false)
                            }}
                            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
                              g.id === selectedGroup?.id ? 'bg-muted font-medium' : ''
                            }`}
                          >
                            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                              {g.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <p className="truncate">{g.name}</p>
                              <p className="text-xs text-muted-foreground">{g.member_count} {t('agentGroupChat.devices')}</p>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              {selectedGroup && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="size-3.5" />
                  <span>
                    {availableCount}/{selectedGroup.member_count} {t('agentGroupChat.online')}
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => handleDispatchComments('cluster')}
                disabled={!selectedGroup || !hasExplicitGroupSelection || isDispatchingComments}
                className="flex items-center gap-1.5 rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  hasExplicitGroupSelection && selectedGroup
                    ? t('tiktok.detailDispatchComments')
                    : t('tiktok.detailDispatchSelectGroupFirst')
                }
              >
                {isDispatchingComments ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                <span>{t('tiktok.detailDispatchComments')}</span>
              </button>
              <button
                onClick={() => handleDispatchComments('single')}
                disabled={!selectedGroup || !hasExplicitGroupSelection || isDispatchingSingleComment}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  hasExplicitGroupSelection && selectedGroup
                    ? t('tiktok.detailDispatchSingleComment')
                    : t('tiktok.detailDispatchSelectGroupFirst')
                }
              >
                {isDispatchingSingleComment ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                <span>{t('tiktok.detailDispatchSingleComment')}</span>
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t('tiktok.interactionsTitle')}</h2>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5">
                <Heart className="size-3" />
                <span>{likeCount}</span>
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5">
                <MessageCircle className="size-3" />
                <span>{commentCount}</span>
              </span>
            </div>
          </div>

          <div className="mb-3 flex items-center gap-1">
            {(['all', 'like', 'comment'] as InteractionTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`rounded-lg px-2.5 py-1 text-xs ${activeTab === tab ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}
              >
                {tab === 'all' ? t('tiktok.interactionsTabAll') : tab === 'like' ? t('tiktok.interactionsTabLikes') : t('tiktok.interactionsTabComments')}
              </button>
            ))}
          </div>

          <div className="max-h-[50vh] overflow-y-auto">
            {interactionsLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
            ) : filteredInteractions.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('tiktok.interactionsEmpty')}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {filteredInteractions.map((item) => (
                  <div key={item.id} className="rounded-lg border border-border bg-muted/30 p-3">
                    <div className="flex items-center gap-2 text-xs">
                      {item.interaction_type === 'like' ? <Heart className="size-3 text-pink-500" /> : <MessageCircle className="size-3 text-blue-500" />}
                      <span className="font-medium">{item.profile_username || '—'}</span>
                    </div>
                    {item.comment_content && <p className="mt-1 text-xs whitespace-pre-wrap">{item.comment_content}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Comment Plans Section */}
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t('tiktok.commentPlanTableTitle')}</h2>
          {pendingCommentPlans.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                onClick={handleDeletePendingCommentPlans}
                disabled={isDeletingPendingPlans || isMutatingCommentPlan || isApprovingAll}
                className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-2.5 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDeletingPendingPlans ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                <span>{t('tiktok.commentPlanDeletePending')}</span>
              </button>
              <button
                onClick={handleApproveAllCommentPlans}
                disabled={isApprovingAll || isDeletingPendingPlans}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isApprovingAll ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <CheckCheck className="size-3.5" />
                )}
                <span>{t('tiktok.commentPlanApproveAll')}</span>
              </button>
            </div>
          )}
        </div>

        {commentPlansLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : commentPlans.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('tiktok.commentPlanTableEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {orderedCommentPlans.map((plan, index) => {
              const isReply = Boolean(getCommentReplyTo(plan))
              const clusterCount = isReply ? 1 : (commentPlanClusterSizes.get(plan.id) ?? 1)
              const isEditing = editingPlanId === plan.id
              const isSavingEdit = savingEditPlanId === plan.id
              const isDeletingSingle = deletingPlanId === plan.id
              const isDeletingCluster = deletingClusterPlanId === plan.id
              const isExecutingCluster = executingClusterPlanId === plan.id
              const isBusy = isSavingEdit || isDeletingSingle || isDeletingCluster || isExecutingCluster
              const isClusterFailed = !isReply && (commentPlanClusterFailures.get(plan.id) ?? false)
              return (
              <div
                key={plan.id}
                className={`rounded-lg border border-border bg-muted/30 p-3 ${isReply ? 'ml-6 border-l-4 border-l-primary/40' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <MessageCircle className="size-3 shrink-0" />
                      <span className="font-semibold text-foreground">#{index + 1}</span>
                      {plan.device_name && <span className="font-medium text-foreground">{plan.device_name}</span>}
                      {plan.is_approved ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          <CheckCircle2 className="size-3" />
                          {t('tiktok.commentPlanApproved')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                          <Clock className="size-3" />
                          {t('tiktok.commentPlanStatusPending')}
                        </span>
                      )}
                      {plan.is_commented ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          <CheckCircle2 className="size-3" />
                          {t('tiktok.commentPlanCommented')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium">
                          {t(getExecutionStatusI18nKey(plan.execution_status))}
                        </span>
                      )}
                      {plan.execution_retry_count > 0 && (
                        <span className="text-[10px]">{t('tiktok.commentPlanRetryCount', { count: plan.execution_retry_count })}</span>
                      )}
                    </div>
                    {isEditing ? (
                      <textarea
                        value={editCommentContent}
                        onChange={(e) => setEditCommentContent(e.target.value)}
                        rows={3}
                        className="w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                      />
                    ) : (
                      <p className="whitespace-pre-wrap text-sm text-foreground">{plan.comment_content}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {!plan.is_approved && !isEditing && (
                      <button
                        onClick={() => handleApproveCommentPlan(plan.id)}
                        disabled={approvingPlanId === plan.id || isBusy}
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
                    {isEditing ? (
                      <>
                        <button
                          onClick={() => handleSaveEditCommentPlan(plan)}
                          disabled={isSavingEdit || isDeletingSingle || isDeletingCluster}
                          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isSavingEdit ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                          <span>{t('common.save')}</span>
                        </button>
                        <button
                          onClick={handleCancelEditCommentPlan}
                          disabled={isBusy}
                          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <X className="size-3" />
                          <span>{t('common.cancel')}</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => handleStartEditCommentPlan(plan)}
                          disabled={isBusy}
                          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Pencil className="size-3" />
                          <span>{t('common.edit')}</span>
                        </button>
                        {!isReply && (
                          <button
                            onClick={() => handleExecuteCommentPlanCluster(plan)}
                            disabled={isBusy}
                            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {isExecutingCluster ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                            <span>{t('tiktok.commentPlanExecuteCluster')}</span>
                          </button>
                        )}
                        {!isReply && isClusterFailed && (
                          <button
                            onClick={() => handleExecuteCommentPlanCluster(plan, true)}
                            disabled={isBusy}
                            className="flex items-center gap-1 rounded-lg border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {isExecutingCluster ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                            <span>{t('common.retry')}</span>
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteCommentPlan(plan.id)}
                          disabled={isBusy}
                          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isDeletingSingle ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                          <span>{t('common.delete')}</span>
                        </button>
                        {!isReply && clusterCount > 1 && (
                          <button
                            onClick={() => handleDeleteCommentPlanCluster(plan)}
                            disabled={isBusy}
                            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {isDeletingCluster ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                            <span>{t('tiktok.commentPlanDeleteCluster')}</span>
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )})}
          </div>
        )}
      </section>

      {/* Video User Comments Section */}
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t('tiktok.videoCommentsTitle')}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleFetchVideoComments}
              disabled={isFetchingVideoComments}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isFetchingVideoComments ? <Loader2 className="size-3.5 animate-spin" /> : <MessageCircle className="size-3.5" />}
              <span>{isFetchingVideoComments ? t('tiktok.videoCommentsFetching') : t('tiktok.videoCommentsFetch')}</span>
            </button>
            <button
              onClick={handleAnalyzeVideoComments}
              disabled={isAnalyzingVideoComments}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isAnalyzingVideoComments ? <Loader2 className="size-3.5 animate-spin" /> : <BotMessageSquare className="size-3.5" />}
              <span>{isAnalyzingVideoComments ? t('tiktok.videoCommentsAnalyzing') : t('tiktok.videoCommentsAnalyze')}</span>
            </button>
            <button
              onClick={() => setShowVideoComments((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <Eye className="size-3.5" />
              <span>{showVideoComments ? t('tiktok.videoCommentsHide') : t('tiktok.videoCommentsShow')}</span>
            </button>
          </div>
        </div>

        {commentClusterResult && (
          <div className="mb-4 rounded-xl border border-border bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('tiktok.videoCommentsAnalyzeTitle')}</span>
              <div className="flex items-center gap-2">
                <span>{t('tiktok.videoCommentsAnalyzeMeta', { points: commentClusterResult.count, clusters: commentClusterResult.n_clusters })}</span>
                {clusterPlotPoints.length > 0 && (
                  <button
                    onClick={() => setIsChartExpanded(true)}
                    title="Mở rộng toàn màn hình"
                    className="rounded p-0.5 hover:bg-muted hover:text-foreground"
                  >
                    <Maximize2 className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
            {clusterPlotPoints.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('tiktok.videoCommentsAnalyzeEmpty')}</p>
            ) : (
              <>
                <div
                  className="relative h-72 w-full rounded-lg border border-border bg-background"
                  style={{
                    backgroundImage: 'radial-gradient(circle, rgba(128,128,128,0.12) 1px, transparent 1px)',
                    backgroundSize: '24px 24px',
                  }}
                >
                  {clusterPlotPoints.map(({ index, point, color, leftPct, topPct }) => {
                    const isHovered = hoveredPointIdx === index
                    return (
                      <span
                        key={`${point.cid ?? index}-${index}`}
                        onMouseEnter={() => setHoveredPointIdx(index)}
                        onMouseLeave={() => setHoveredPointIdx(null)}
                        className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full cursor-pointer transition-all duration-100"
                        style={{
                          left: `${leftPct}%`,
                          top: `${topPct}%`,
                          backgroundColor: color,
                          width: isHovered ? '14px' : '9px',
                          height: isHovered ? '14px' : '9px',
                          boxShadow: isHovered ? `0 0 0 3px ${color}40, 0 2px 8px rgba(0,0,0,0.3)` : undefined,
                          zIndex: isHovered ? 10 : 1,
                        }}
                      />
                    )
                  })}
                  {hoveredPointIdx !== null && (() => {
                    const hovered = clusterPlotPoints.find((p: (typeof clusterPlotPoints)[number]) => p.index === hoveredPointIdx)
                    if (!hovered) return null
                    const text = hovered.point.normalized_text || hovered.point.text || ''
                    if (!text) return null
                    const toLeft = hovered.leftPct > 60
                    const toTop = hovered.topPct > 60
                    const clusterLabel = hovered.cluster >= 0
                      ? commentClusterResult?.cluster_labels?.[String(hovered.cluster)]
                      : undefined
                    return (
                      <div
                        className="absolute z-20 max-w-[240px] rounded-lg border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg pointer-events-none whitespace-normal break-words"
                        style={{
                          left: `${hovered.leftPct}%`,
                          top: `${hovered.topPct}%`,
                          transform: `translate(${toLeft ? 'calc(-100% - 10px)' : '10px'}, ${toTop ? 'calc(-100% - 10px)' : '10px'})`,
                        }}
                      >
                        {clusterLabel && (
                          <div
                            className="mb-1 font-semibold"
                            style={{ color: clusterPalette[hovered.cluster % clusterPalette.length] }}
                          >
                            {clusterLabel}
                          </div>
                        )}
                        {text}
                      </div>
                    )
                  })()}
                </div>
                {clusterLegend.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {clusterLegend.map((cluster: number) => {
                      const label = cluster >= 0
                        ? (commentClusterResult?.cluster_labels?.[String(cluster)] ?? `Cụm ${cluster + 1}`)
                        : 'Khác'
                      return (
                        <span key={cluster} className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={label}>
                          <span
                            className="inline-block size-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: cluster < 0 ? '#6b7280' : clusterPalette[cluster % clusterPalette.length] }}
                          />
                          <span className="max-w-[140px] truncate">{label}</span>
                        </span>
                      )
                    })}
                  </div>
                )}
                <p className="mt-1.5 text-[11px] text-muted-foreground">{t('tiktok.videoCommentsAnalyzeHint')}</p>
              </>
            )}
          </div>
        )}

        {showVideoComments && (
          videoCommentsLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : videoComments.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('tiktok.videoCommentsEmpty')}</p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <div className="flex flex-col gap-2">
                {videoComments.map((comment) => (
                  <div
                    key={comment.id}
                    className={`rounded-lg border border-border bg-muted/30 p-3 ${comment.parent_cid ? 'ml-6 border-l-4 border-l-primary/40' : ''}`}
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{comment.nickname || comment.user_id}</span>
                      {comment.parent_cid && (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {t('tiktok.videoCommentsReplyLabel')}
                        </span>
                      )}
                      {comment.create_time && (
                        <span>{new Date(comment.create_time).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}</span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-foreground">{comment.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )
        )}
      </section>

      {isChartExpanded && commentClusterResult && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold">{t('tiktok.videoCommentsAnalyzeTitle')}</span>
              <span className="text-xs text-muted-foreground">
                {t('tiktok.videoCommentsAnalyzeMeta', { points: commentClusterResult.count, clusters: commentClusterResult.n_clusters })}
              </span>
            </div>
            <button
              onClick={() => setIsChartExpanded(false)}
              title="Thu nhỏ"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Minimize2 className="size-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex min-h-0 flex-1">
            {/* Chart area */}
            <div className="relative min-w-0 flex-1 p-4">
              <div
                className="relative h-full w-full rounded-xl border border-border bg-background"
                style={{
                  backgroundImage: 'radial-gradient(circle, rgba(128,128,128,0.12) 1px, transparent 1px)',
                  backgroundSize: '28px 28px',
                }}
              >
                {clusterPlotPoints.map(({ index, point, color, leftPct, topPct }) => {
                  const isHovered = hoveredPointIdx === index
                  return (
                    <span
                      key={`exp-${point.cid ?? index}-${index}`}
                      onMouseEnter={() => setHoveredPointIdx(index)}
                      onMouseLeave={() => setHoveredPointIdx(null)}
                      className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full cursor-pointer transition-all duration-100"
                      style={{
                        left: `${leftPct}%`,
                        top: `${topPct}%`,
                        backgroundColor: color,
                        width: isHovered ? '16px' : '10px',
                        height: isHovered ? '16px' : '10px',
                        boxShadow: isHovered ? `0 0 0 4px ${color}40, 0 2px 10px rgba(0,0,0,0.35)` : undefined,
                        zIndex: isHovered ? 10 : 1,
                      }}
                    />
                  )
                })}
                {hoveredPointIdx !== null && (() => {
                  const hovered = clusterPlotPoints.find((p: (typeof clusterPlotPoints)[number]) => p.index === hoveredPointIdx)
                  if (!hovered) return null
                  const text = hovered.point.normalized_text || hovered.point.text || ''
                  if (!text) return null
                  const toLeft = hovered.leftPct > 60
                  const toTop = hovered.topPct > 60
                  const clusterLabel = hovered.cluster >= 0
                    ? commentClusterResult.cluster_labels?.[String(hovered.cluster)]
                    : undefined
                  return (
                    <div
                      className="absolute z-20 max-w-[260px] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg pointer-events-none whitespace-normal break-words"
                      style={{
                        left: `${hovered.leftPct}%`,
                        top: `${hovered.topPct}%`,
                        transform: `translate(${toLeft ? 'calc(-100% - 12px)' : '12px'}, ${toTop ? 'calc(-100% - 12px)' : '12px'})`,
                      }}
                    >
                      {clusterLabel && (
                        <div
                          className="mb-1 font-semibold"
                          style={{ color: clusterPalette[hovered.cluster % clusterPalette.length] }}
                        >
                          {clusterLabel}
                        </div>
                      )}
                      {text}
                    </div>
                  )
                })()}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">{t('tiktok.videoCommentsAnalyzeHint')}</p>
            </div>

            {/* Sidebar: cluster list */}
            <div className="flex w-64 shrink-0 flex-col border-l border-border">
              <div className="shrink-0 border-b border-border px-4 py-3">
                <h3 className="text-xs font-semibold text-foreground">Các cụm bình luận</h3>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-3">
                <div className="flex flex-col gap-2">
                  {clusterLegend.map((cluster: number) => {
                    const color = cluster < 0 ? '#6b7280' : clusterPalette[cluster % clusterPalette.length]
                    const label = cluster >= 0
                      ? (commentClusterResult.cluster_labels?.[String(cluster)] ?? `Cụm ${cluster + 1}`)
                      : 'Khác'
                    const count = clusterCounts.get(cluster) ?? 0
                    return (
                      <div
                        key={cluster}
                        className="rounded-lg border border-border bg-muted/30 px-3 py-2.5"
                      >
                        <div className="flex items-start gap-2.5">
                          <span
                            className="mt-0.5 inline-block size-3 shrink-0 rounded-full"
                            style={{ backgroundColor: color }}
                          />
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-foreground leading-snug">{label}</p>
                            <p className="mt-0.5 text-[10px] text-muted-foreground">{count} bình luận</p>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {contentModalOpen && (
        <div
          onClick={() => setContentModalOpen(false)}
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="video-content-modal-title"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 id="video-content-modal-title" className="text-base font-semibold">{t('tiktok.detailContentTitle')}</h2>
              <button
                onClick={() => setContentModalOpen(false)}
                aria-label={t('tiktok.detailCloseContent')}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-5">
              <p className="whitespace-pre-wrap text-sm text-foreground">{videoContent}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
