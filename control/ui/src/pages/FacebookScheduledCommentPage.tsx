/**
 * Dedicated comment-plan page for a published Facebook scheduled post — a port of
 * the TikTok video detail comment UI (TiktokVideoDetailPage), reusing its exact
 * layout/styling. The user picks an agent group, generates a comment plan via the
 * SAME N8N webhook (one comment per device), reviews/edits/approves, then each
 * plan is posted by the FB account logged in on that device.
 *
 * Route: /facebook/scheduled-posts/:postId/comments
 */
import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft, BotMessageSquare, CheckCheck, CheckCircle2, ChevronDown, Clock, ExternalLink,
  Loader2, MessageCircle, Pencil, Play, Save, Trash2, Users, X,
} from 'lucide-react'
import { useToast } from '@/context/ToastContext'
import { agentGroupsApi, facebookProfileScheduledPostsApi } from '@/lib/api'
import CommentInsightsPanel from '@/components/CommentInsightsPanel'
import type { AgentGroup, FacebookProfileScheduledPost, FacebookScheduledCommentPlan } from '@/lib/types'

const EXEC_STATUS_LABEL: Record<string, string> = {
  idle: 'Chưa chạy',
  scheduled: 'Đã lên lịch',
  running: 'Đang chạy',
  completed: 'Hoàn tất',
  failed: 'Lỗi',
}

export default function FacebookScheduledCommentPage() {
  const { postId: postIdParam } = useParams<{ postId: string }>()
  const postId = Number(postIdParam)
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [groupSelectorOpen, setGroupSelectorOpen] = useState(false)
  const [dispatching, setDispatching] = useState<'cluster' | 'single' | null>(null)
  const [busyPlanId, setBusyPlanId] = useState<number | null>(null)
  const [approvingAll, setApprovingAll] = useState(false)
  const [deletingPending, setDeletingPending] = useState(false)
  const [executingCluster, setExecutingCluster] = useState(false)
  const [editingPlanId, setEditingPlanId] = useState<number | null>(null)
  const [editContent, setEditContent] = useState('')

  const { data: post } = useQuery<FacebookProfileScheduledPost>({
    queryKey: ['fb-scheduled-post', postId],
    queryFn: () => facebookProfileScheduledPostsApi.get(postId),
    enabled: Number.isFinite(postId),
  })
  const { data: groups = [], isLoading: groupsLoading } = useQuery<AgentGroup[]>({
    queryKey: ['agent-groups'],
    queryFn: agentGroupsApi.list,
  })
  const { data: plans = [], isLoading: plansLoading, refetch } = useQuery<FacebookScheduledCommentPlan[]>({
    queryKey: ['fb-comment-plans', postId],
    queryFn: () => facebookProfileScheduledPostsApi.listCommentPlans(postId),
    enabled: Number.isFinite(postId),
  })

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) || null
  const pendingPlans = plans.filter((p) => !p.is_approved)
  const hasLink = Boolean(post?.fb_post_id)

  function err(error: unknown, fallback: string) {
    showToast(error instanceof Error ? error.message : fallback, 'error')
  }

  // Return to the profile's schedule tab; fall back to browser history.
  function goBack() {
    if (post?.profile) navigate(`/facebook/profiles/${post.profile}?tab=schedule`)
    else navigate(-1)
  }

  async function dispatch(type: 'cluster' | 'single') {
    if (!selectedGroup) { showToast('Hãy chọn nhóm thiết bị.', 'error'); return }
    if (!hasLink) { showToast('Bài chưa có link (fb_post_id). Hãy đăng / tìm link trước.', 'error'); return }
    setDispatching(type)
    try {
      const fn = type === 'cluster'
        ? facebookProfileScheduledPostsApi.dispatchComments
        : facebookProfileScheduledPostsApi.dispatchSingleComment
      const res = await fn(postId, { agent_group: selectedGroup.id, content: post?.content || '' })
      showToast(res.detail || 'Đã tạo kế hoạch comment.', 'success')
      refetch()
    } catch (error) { err(error, 'Tạo comment thất bại.') } finally { setDispatching(null) }
  }

  async function approve(plan: FacebookScheduledCommentPlan) {
    setBusyPlanId(plan.id)
    try {
      await facebookProfileScheduledPostsApi.updateCommentPlan(postId, plan.id, { is_approved: true })
      showToast('Đã duyệt. Bấm "Thực thi cụm" / "Duyệt tất cả" để đăng theo thứ tự.', 'success'); refetch()
    } catch (error) { err(error, 'Duyệt thất bại.') } finally { setBusyPlanId(null) }
  }

  async function approveAll() {
    setApprovingAll(true)
    try {
      const res = await facebookProfileScheduledPostsApi.approveAllCommentPlans(postId)
      showToast(`Đã duyệt ${res.approved} comment.`, 'success'); refetch()
    } catch (error) { err(error, 'Duyệt tất cả thất bại.') } finally { setApprovingAll(false) }
  }

  // Delete every not-yet-approved plan in one go.
  async function deletePending() {
    if (!pendingPlans.length) return
    if (!confirm(`Xóa ${pendingPlans.length} comment chưa duyệt?`)) return
    setDeletingPending(true)
    try {
      await Promise.all(pendingPlans.map((p) => facebookProfileScheduledPostsApi.deleteCommentPlan(postId, p.id)))
      showToast('Đã xóa comment chưa duyệt.', 'success'); refetch()
    } catch (error) { err(error, 'Xóa thất bại.') } finally { setDeletingPending(false) }
  }

  // "Thực thi cụm" = approve the whole cluster at once (same effect as approving
  // every pending plan; kept as a separate affordance alongside "Duyệt tất cả").
  async function executeCluster() {
    if (!pendingPlans.length) { showToast('Cụm đã được duyệt hết.', 'info'); return }
    if (!confirm(`Duyệt cả cụm (${pendingPlans.length} comment)?`)) return
    setExecutingCluster(true)
    try {
      const res = await facebookProfileScheduledPostsApi.approveAllCommentPlans(postId)
      showToast(`Đã duyệt cả cụm (${res.approved} comment).`, 'success'); refetch()
    } catch (error) { err(error, 'Duyệt cụm thất bại.') } finally { setExecutingCluster(false) }
  }

  async function execute(plan: FacebookScheduledCommentPlan) {
    setBusyPlanId(plan.id)
    try {
      await facebookProfileScheduledPostsApi.executeCommentPlan(postId, plan.id)
      showToast('Đã lên lịch chạy comment.', 'success'); refetch()
    } catch (error) { err(error, 'Thực thi thất bại.') } finally { setBusyPlanId(null) }
  }

  async function saveEdit(plan: FacebookScheduledCommentPlan) {
    const next = editContent.trim()
    if (!next) return
    setBusyPlanId(plan.id)
    try {
      await facebookProfileScheduledPostsApi.updateCommentPlan(postId, plan.id, { comment_content: next })
      setEditingPlanId(null); refetch()
    } catch (error) { err(error, 'Lưu thất bại.') } finally { setBusyPlanId(null) }
  }

  async function remove(plan: FacebookScheduledCommentPlan) {
    setBusyPlanId(plan.id)
    try {
      await facebookProfileScheduledPostsApi.deleteCommentPlan(postId, plan.id); refetch()
    } catch (error) { err(error, 'Xóa thất bại.') } finally { setBusyPlanId(null) }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            onClick={goBack}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Quay lại
          </button>
          <h1 className="mt-1 text-lg font-semibold">Tạo comment cho bài đăng</h1>
          <p className="line-clamp-1 text-xs text-muted-foreground">{post?.content || `#${postId}`}</p>
          {post?.fb_post_id && (
            <a href={post.fb_post_id} target="_blank" rel="noopener noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 text-xs text-primary hover:underline">
              <ExternalLink className="size-3" /> Mở bài
            </a>
          )}
        </div>
      </div>

      {!hasLink && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
          Bài chưa có link (fb_post_id). Hãy bấm "Đăng bài" / "Find link" ở dòng bài đăng để có link trước khi comment.
        </p>
      )}

      {/* Group selector + dispatch */}
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
                  <span className="text-muted-foreground">Đang tải…</span>
                ) : selectedGroup ? (
                  <span>{selectedGroup.name}</span>
                ) : (
                  <span className="text-muted-foreground">Chọn nhóm thiết bị</span>
                )}
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </button>
              {groupSelectorOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-xl border border-border bg-popover shadow-lg">
                  <div className="p-1">
                    {groups.length === 0 ? (
                      <p className="px-3 py-2 text-sm text-muted-foreground">Chưa có nhóm thiết bị nào.</p>
                    ) : (
                      groups.map((g) => (
                        <button
                          key={g.id}
                          onClick={() => { setSelectedGroupId(g.id); setGroupSelectorOpen(false) }}
                          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${g.id === selectedGroup?.id ? 'bg-muted font-medium' : ''}`}
                        >
                          <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                            {g.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate">{g.name}</p>
                            <p className="text-xs text-muted-foreground">{g.member_count} thiết bị</p>
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
                <span>{selectedGroup.member_count} thiết bị</span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => dispatch('cluster')}
              disabled={!selectedGroup || dispatching !== null}
              className="flex items-center gap-1.5 rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {dispatching === 'cluster' ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              <span>Tạo comment</span>
            </button>
            <button
              onClick={() => dispatch('single')}
              disabled={!selectedGroup || dispatching !== null}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              {dispatching === 'single' ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              <span>Tạo comment đơn</span>
            </button>
          </div>
        </div>
      </section>

      {/* Comment plans */}
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Kế hoạch comment ({plans.length})</h2>
          {plans.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={executeCluster}
                disabled={executingCluster}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {executingCluster ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                <span>Thực thi cụm</span>
              </button>
              {pendingPlans.length > 0 && (
                <button
                  onClick={deletePending}
                  disabled={deletingPending}
                  className="flex items-center gap-1.5 rounded-lg border border-destructive/40 px-2.5 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deletingPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  <span>Xóa chưa duyệt</span>
                </button>
              )}
              {pendingPlans.length > 0 && (
                <button
                  onClick={approveAll}
                  disabled={approvingAll}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {approvingAll ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCheck className="size-3.5" />}
                  <span>Duyệt tất cả</span>
                </button>
              )}
            </div>
          )}
        </div>

        {plansLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Đang tải…</p>
        ) : plans.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Chưa có comment nào. Chọn nhóm thiết bị rồi bấm "Tạo comment".</p>
        ) : (
          <div className="flex flex-col gap-2">
            {plans.map((plan, index) => {
              const isReply = Boolean(plan.reply_to)
              const isEditing = editingPlanId === plan.id
              const isBusy = busyPlanId === plan.id
              return (
                <div key={plan.id} className={`rounded-lg border border-border bg-muted/30 p-3 ${isReply ? 'ml-6 border-l-4 border-l-primary/40' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <MessageCircle className="size-3 shrink-0" />
                        <span className="font-semibold text-foreground">#{index + 1}</span>
                        {(plan.actor_name || plan.device_name) && (
                          <span className="font-medium text-foreground">{plan.actor_name || plan.device_name}</span>
                        )}
                        {plan.is_approved ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                            <CheckCircle2 className="size-3" /> Đã duyệt
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                            <Clock className="size-3" /> Chờ duyệt
                          </span>
                        )}
                        {plan.is_commented ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                            <CheckCircle2 className="size-3" /> Đã comment
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium">
                            {EXEC_STATUS_LABEL[plan.execution_status] || plan.execution_status}
                          </span>
                        )}
                        {plan.comment_link && (
                          <a href={plan.comment_link} target="_blank" rel="noreferrer" className="text-primary underline">Xem comment</a>
                        )}
                      </div>
                      {isEditing ? (
                        <textarea
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          rows={3}
                          className="w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                          autoFocus
                        />
                      ) : (
                        <p className="whitespace-pre-wrap text-sm text-foreground">{plan.comment_content}</p>
                      )}
                      {plan.reply_to && !isEditing && (
                        <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">↳ trả lời: {plan.reply_to}</p>
                      )}
                      {plan.execution_last_error && (
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-destructive">{plan.execution_last_error}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      {isEditing ? (
                        <>
                          <button onClick={() => saveEdit(plan)} disabled={isBusy}
                            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50">
                            {isBusy ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                            <span>Lưu</span>
                          </button>
                          <button onClick={() => setEditingPlanId(null)}
                            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                            <X className="size-3" /> <span>Hủy</span>
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => { if (!plan.is_approved && !isBusy) approve(plan) }}
                            disabled={isBusy}
                            title={plan.is_approved ? 'Đã duyệt' : 'Bấm để duyệt'}
                            className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                              plan.is_approved
                                ? 'cursor-default border-green-500/40 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                            }`}
                          >
                            {isBusy ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
                            <span>{plan.is_approved ? 'Duyệt' : 'Chưa duyệt'}</span>
                          </button>
                          <button onClick={() => { setEditingPlanId(plan.id); setEditContent(plan.comment_content) }} disabled={isBusy}
                            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50">
                            <Pencil className="size-3" /> <span>Sửa</span>
                          </button>
                          <button onClick={() => execute(plan)} disabled={isBusy}
                            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50">
                            {isBusy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                            <span>Thực thi</span>
                          </button>
                          <button onClick={() => remove(plan)} disabled={isBusy}
                            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50">
                            {isBusy ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                            <span>Xóa</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Comment của mình (đã đăng bởi thiết bị) — bảng riêng */}
      {plans.some((p) => p.is_commented) && (
        <section className="mt-4 rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Comment của mình (đã đăng) <span className="text-xs font-normal text-muted-foreground">({plans.filter((p) => p.is_commented).length})</span></h3>
          </div>
          <div className="flex flex-col gap-2 p-4">
            {plans.filter((p) => p.is_commented).map((p) => (
              <div key={p.id} className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{p.actor_name || p.device_name || 'Tài khoản'}</span>
                  {p.reply_to && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">Trả lời</span>}
                  {p.comment_link && <a href={p.comment_link} target="_blank" rel="noreferrer" className="text-primary underline">Xem comment</a>}
                </div>
                <p className="whitespace-pre-wrap text-sm text-foreground">{p.comment_content}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {Number.isFinite(postId) && (
        <section className="mt-4">
          <CommentInsightsPanel
            postId={postId}
            api={{
              list: facebookProfileScheduledPostsApi.listPostComments,
              fetch: (id) => facebookProfileScheduledPostsApi.fetchComments(id),
              cluster: facebookProfileScheduledPostsApi.clusterComments,
            }}
          />
        </section>
      )}
    </div>
  )
}
