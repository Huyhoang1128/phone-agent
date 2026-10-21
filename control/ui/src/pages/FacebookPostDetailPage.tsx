import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft, Plus, Trash2, Pencil, ExternalLink, X, Loader2, CheckCircle2, Send, Sparkles, Rocket, Download, BarChart3,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { facebookPostsApi, agentGroupsApi, profilesApi, devicesApi } from '@/lib/api'
import type {
  FacebookCommentPlan, FacebookCommentPlanCreate, FacebookPostInteraction, FacebookInteractionType,
} from '@/lib/types'

interface PlanForm {
  comment_content: string
  agent_group: number | null
  profile: number | null
  device: number | null
}

const DEFAULT_PLAN_FORM: PlanForm = { comment_content: '', agent_group: null, profile: null, device: null }

function formatDateTime(value: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })
}

function PlanStatusBadge({ plan }: { plan: FacebookCommentPlan }) {
  const { t } = useTranslation()
  if (plan.is_commented) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <CheckCircle2 className="size-3" /> {t('facebook.postDetail.statusCommented')}
      </span>
    )
  }
  if (plan.is_approved) {
    return (
      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
        {t('facebook.postDetail.statusApproved')}
      </span>
    )
  }
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {t('facebook.postDetail.statusPending')}
    </span>
  )
}

export default function FacebookPostDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const postId = Number(id)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<FacebookCommentPlan | null>(null)
  const [form, setForm] = useState<PlanForm>(DEFAULT_PLAN_FORM)
  const [formError, setFormError] = useState('')
  const [generating, setGenerating] = useState(false)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [dispatchContent, setDispatchContent] = useState('')
  const [dispatchAgentGroup, setDispatchAgentGroup] = useState<number | null>(null)
  const [dispatchDevices, setDispatchDevices] = useState<Set<number>>(new Set())
  const [dispatchAutoApprove, setDispatchAutoApprove] = useState(true)
  const [dispatching, setDispatching] = useState(false)

  const { data: post, isLoading: postLoading } = useQuery({
    queryKey: ['facebook-post', postId],
    queryFn: () => facebookPostsApi.get(postId),
    enabled: Number.isFinite(postId),
  })

  const { data: plans, isLoading: plansLoading } = useQuery({
    queryKey: ['facebook-comment-plans', postId],
    queryFn: () => facebookPostsApi.listCommentPlans(postId),
    enabled: Number.isFinite(postId),
  })

  const { data: interactions, isLoading: interactionsLoading } = useQuery({
    queryKey: ['facebook-post-interactions', postId],
    queryFn: () => facebookPostsApi.listInteractions(postId),
    enabled: Number.isFinite(postId),
  })

  const { data: agentGroups } = useQuery({ queryKey: ['agent-groups'], queryFn: () => agentGroupsApi.list() })
  const { data: profiles } = useQuery({ queryKey: ['profiles'], queryFn: () => profilesApi.list() })
  const { data: devices } = useQuery({ queryKey: ['devices'], queryFn: () => devicesApi.list() })

  const { data: scrapedComments } = useQuery({
    queryKey: ['facebook-post-comments', postId],
    queryFn: () => facebookPostsApi.listPostComments(postId),
    enabled: Number.isFinite(postId),
  })

  const fetchCommentsMutation = useMutation({
    mutationFn: () => facebookPostsApi.fetchComments(postId),
    onSuccess: (res) => {
      showToast(t('facebook.postDetail.fetchSuccess', { saved: res.saved, total: res.total }), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-post-comments', postId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.postDetail.fetchError'), 'error'),
  })

  const [clusters, setClusters] = useState<import('@/lib/types').FacebookCommentClusterResponse | null>(null)
  const clusterMutation = useMutation({
    mutationFn: () => facebookPostsApi.clusterComments(postId),
    onSuccess: (r) => { setClusters(r); showToast(`Đã phân ${r.n_clusters} cụm từ ${r.source_comments} bình luận.`, 'success') },
    onError: (err) => showToast(err instanceof Error ? err.message : 'Phân tích thất bại.', 'error'),
  })
  const clusterGroups = useMemo(() => {
    if (!clusters) return [] as [number, string[]][]
    const m = new Map<number, string[]>()
    for (const p of clusters.points) {
      const c = typeof p.cluster === 'number' ? p.cluster : -1
      if (!m.has(c)) m.set(c, [])
      m.get(c)!.push(p.text)
    }
    return [...m.entries()].sort((a, b) => (a[0] < 0 ? 1 : b[0] < 0 ? -1 : b[1].length - a[1].length))
  }, [clusters])

  const pendingCount = useMemo(() => (plans ?? []).filter((p) => !p.is_approved).length, [plans])

  const saveMutation = useMutation({
    mutationFn: (data: FacebookCommentPlanCreate) =>
      editing
        ? facebookPostsApi.updateCommentPlan(postId, editing.id, data)
        : facebookPostsApi.createCommentPlan(postId, data),
    onSuccess: () => {
      showToast(editing ? t('facebook.postDetail.planSaveSuccess') : t('facebook.postDetail.planCreateSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-comment-plans', postId] })
      closeModal()
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.postDetail.planSaveError'), 'error'),
  })

  const deleteMutation = useMutation({
    mutationFn: (planId: number) => facebookPostsApi.deleteCommentPlan(postId, planId),
    onSuccess: () => {
      showToast(t('facebook.postDetail.planDeleteSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-comment-plans', postId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.postDetail.planDeleteError'), 'error'),
  })

  const approveMutation = useMutation({
    mutationFn: (planId: number) => facebookPostsApi.updateCommentPlan(postId, planId, { is_approved: true }),
    onSuccess: () => {
      showToast(t('facebook.postDetail.approveSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-comment-plans', postId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.postDetail.planSaveError'), 'error'),
  })

  const approveAllMutation = useMutation({
    mutationFn: () => facebookPostsApi.approveAllCommentPlans(postId),
    onSuccess: (res) => {
      showToast(t('facebook.postDetail.approveAllSuccess', { count: res.approved }), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-comment-plans', postId] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.postDetail.planSaveError'), 'error'),
  })

  function openCreate() {
    setEditing(null)
    setForm(DEFAULT_PLAN_FORM)
    setFormError('')
    setModalOpen(true)
  }

  function openEdit(plan: FacebookCommentPlan) {
    setEditing(plan)
    setForm({
      comment_content: plan.comment_content,
      agent_group: plan.agent_group,
      profile: plan.profile,
      device: plan.device,
    })
    setFormError('')
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setEditing(null)
    setForm(DEFAULT_PLAN_FORM)
    setFormError('')
  }

  async function handleGenerate() {
    if (generating) return
    setGenerating(true)
    try {
      const res = await facebookPostsApi.generateComment(post?.content || post?.caption || '', [])
      setForm((p) => ({ ...p, comment_content: res.comment }))
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'AI error', 'error')
    } finally {
      setGenerating(false)
    }
  }

  function handleSubmit() {
    if (!form.comment_content.trim()) {
      setFormError(t('facebook.postDetail.commentRequired'))
      return
    }
    saveMutation.mutate({
      comment_content: form.comment_content.trim(),
      agent_group: form.agent_group,
      profile: form.profile,
      device: form.device,
    })
  }

  function toggleDispatchDevice(deviceId: number) {
    setDispatchDevices((prev) => {
      const next = new Set(prev)
      if (next.has(deviceId)) next.delete(deviceId); else next.add(deviceId)
      return next
    })
  }

  async function handleDispatch() {
    if (!dispatchContent.trim()) {
      showToast(t('facebook.postDetail.commentRequired'), 'error')
      return
    }
    setDispatching(true)
    try {
      const res = await facebookPostsApi.dispatchComments(postId, {
        comment_content: dispatchContent.trim(),
        agent_group: dispatchAgentGroup,
        devices: [...dispatchDevices],
        auto_approve: dispatchAutoApprove,
      })
      showToast(t('facebook.postDetail.dispatchSuccess', { count: res.comment_plans.length }), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-comment-plans', postId] })
      setDispatchOpen(false)
      setDispatchContent('')
      setDispatchDevices(new Set())
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('facebook.postDetail.dispatchError'), 'error')
    } finally {
      setDispatching(false)
    }
  }

  const typeLabel: Record<FacebookInteractionType, string> = {
    like: t('facebook.postDetail.typeLike'),
    comment: t('facebook.postDetail.typeComment'),
    share: t('facebook.postDetail.typeShare'),
    reply: t('facebook.postDetail.typeReply'),
  }

  if (!Number.isFinite(postId)) {
    return <div className="p-6 text-sm text-muted-foreground">{t('facebook.postDetail.postNotFound')}</div>
  }

  return (
    <div className="flex flex-col gap-6">
      <button
        onClick={() => post ? navigate(`/facebook/pages/${post.page}`) : navigate('/facebook?tab=pages')}
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t('facebook.postDetail.back')}
      </button>

      {/* Post header */}
      {postLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('common.loading')}
        </div>
      ) : post ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground">{post.page_name}</p>
          {post.post_url && (
            <a
              href={post.post_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5 shrink-0" />
              <span className="truncate">{post.post_url}</span>
            </a>
          )}
          {(post.content || post.caption) && (
            <p className="mt-2 text-sm text-foreground">{post.content || post.caption}</p>
          )}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">{t('facebook.postDetail.postNotFound')}</div>
      )}

      {/* Comment plans */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('facebook.postDetail.plansTitle')}</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { setDispatchContent(post?.content || ''); setDispatchOpen(true) }}>
            <Rocket className="mr-1.5 size-3.5" />
            {t('facebook.postDetail.dispatch')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => approveAllMutation.mutate()}
            disabled={approveAllMutation.isPending || pendingCount === 0}
          >
            <Send className="mr-1.5 size-3.5" />
            {t('facebook.postDetail.approveAll')}
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1.5 size-3.5" />
            {t('facebook.postDetail.addPlan')}
          </Button>
        </div>
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">{t('facebook.postDetail.dispatchHint')}</p>

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {plansLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('common.loading')}
          </div>
        ) : (plans ?? []).length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('facebook.postDetail.emptyPlans')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colComment')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colProfile')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colDevice')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colPlanStatus')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colLink')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(plans ?? []).map((plan) => (
                <tr key={plan.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 max-w-[320px] text-xs text-muted-foreground">
                    <span className="line-clamp-2">{plan.comment_content || '—'}</span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{plan.profile_name || '—'}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{plan.device_name || '—'}</td>
                  <td className="px-4 py-2.5"><PlanStatusBadge plan={plan} /></td>
                  <td className="px-4 py-2.5 max-w-[200px]">
                    {plan.comment_link ? (
                      <a
                        href={plan.comment_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{plan.comment_link}</span>
                      </a>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      {!plan.is_approved && (
                        <button
                          onClick={() => approveMutation.mutate(plan.id)}
                          disabled={approveMutation.isPending}
                          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <Send className="size-3" /> {t('facebook.postDetail.approve')}
                        </button>
                      )}
                      <button
                        onClick={() => openEdit(plan)}
                        aria-label={t('common.edit')}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        onClick={() => { if (confirm(t('facebook.postDetail.planDeleteConfirm'))) deleteMutation.mutate(plan.id) }}
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

      {/* Interactions */}
      <h2 className="text-lg font-semibold">{t('facebook.postDetail.interactionsTitle')}</h2>
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {interactionsLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('common.loading')}
          </div>
        ) : (interactions ?? []).length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('facebook.postDetail.emptyInteractions')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colType')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colInteractionProfile')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colContent')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colLink')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colCreated')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(interactions ?? []).map((it: FacebookPostInteraction) => (
                <tr key={it.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{typeLabel[it.interaction_type]}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{it.profile_username || '—'}</td>
                  <td className="px-4 py-2.5 max-w-[320px] text-xs text-muted-foreground">
                    <span className="line-clamp-2">{it.comment_content || '—'}</span>
                  </td>
                  <td className="px-4 py-2.5 max-w-[200px]">
                    {it.comment_link ? (
                      <a href={it.comment_link} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground">
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{it.comment_link}</span>
                      </a>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(it.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Scraped comments */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('facebook.postDetail.commentsTitle')}</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => fetchCommentsMutation.mutate()} disabled={fetchCommentsMutation.isPending}>
            {fetchCommentsMutation.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Download className="mr-1.5 size-3.5" />}
            {fetchCommentsMutation.isPending ? t('facebook.postDetail.fetching') : t('facebook.postDetail.fetchComments')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => clusterMutation.mutate()} disabled={clusterMutation.isPending || (scrapedComments ?? []).length === 0}>
            {clusterMutation.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <BarChart3 className="mr-1.5 size-3.5" />}
            Phân tích
          </Button>
        </div>
      </div>

      {clusters && (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Phân cụm: {clusters.n_clusters} cụm / {clusters.source_comments} bình luận</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {clusterGroups.map(([cid, texts]) => (
              <div key={cid} className="rounded-lg border border-border bg-muted/20 p-2.5">
                <p className="mb-1 text-xs font-semibold">
                  {cid < 0 ? 'Khác / nhiễu' : (clusters.cluster_labels?.[String(cid)] || `Cụm ${cid + 1}`)}
                  <span className="ml-1 font-normal text-muted-foreground">({texts.length})</span>
                </p>
                <ul className="flex flex-col gap-1">
                  {texts.slice(0, 5).map((tx, i) => <li key={i} className="line-clamp-2 text-xs text-muted-foreground">• {tx}</li>)}
                  {texts.length > 5 && <li className="text-[11px] text-muted-foreground/70">… và {texts.length - 5} bình luận nữa</li>}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {(scrapedComments ?? []).length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('facebook.postDetail.emptyComments')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colCommentUser')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colCommentText')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.postDetail.colCommentLink')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(scrapedComments ?? []).map((c) => (
                <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{c.nickname || c.user_id || '—'}</td>
                  <td className="px-4 py-2.5 max-w-[420px] text-xs text-muted-foreground"><span className="line-clamp-2">{c.text || '—'}</span></td>
                  <td className="px-4 py-2.5 max-w-[200px]">
                    {c.comment_link ? (
                      <a href={c.comment_link} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground">
                        <ExternalLink className="size-3 shrink-0" /><span className="truncate">{c.comment_link}</span>
                      </a>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Dispatch modal */}
      {dispatchOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl flex max-h-[90vh] flex-col">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold">{t('facebook.postDetail.dispatchTitle')}</h2>
                <p className="text-xs text-muted-foreground">{t('facebook.postDetail.dispatchSubtitle')}</p>
              </div>
              <button onClick={() => setDispatchOpen(false)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-4 overflow-y-auto p-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.postDetail.fieldComment')}</label>
                <textarea
                  value={dispatchContent}
                  onChange={(e) => setDispatchContent(e.target.value)}
                  placeholder={t('facebook.postDetail.fieldCommentPlaceholder')}
                  rows={3}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.postDetail.fieldAgentGroup')}</label>
                <select
                  value={dispatchAgentGroup ?? ''}
                  onChange={(e) => setDispatchAgentGroup(e.target.value ? Number(e.target.value) : null)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t('facebook.postDetail.none')}</option>
                  {(agentGroups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.postDetail.dispatchDevices')}</label>
                {(devices ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('facebook.postDetail.dispatchNoDevices')}</p>
                ) : (
                  <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-2">
                    {(devices ?? []).map((d) => (
                      <label key={d.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={dispatchDevices.has(d.id)}
                          onChange={() => toggleDispatchDevice(d.id)}
                          className="size-4 cursor-pointer accent-primary"
                        />
                        <span>{d.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={dispatchAutoApprove}
                  onChange={(e) => setDispatchAutoApprove(e.target.checked)}
                  className="size-4 cursor-pointer accent-primary"
                />
                <span>{t('facebook.postDetail.dispatchAutoApprove')}</span>
              </label>
              <p className="text-xs text-muted-foreground">{t('facebook.postDetail.dispatchHint')}</p>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" onClick={() => setDispatchOpen(false)} disabled={dispatching}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleDispatch} disabled={dispatching}>
                <Rocket className="mr-1.5 size-3.5" />
                {dispatching ? t('common.saving') : t('facebook.postDetail.dispatchSend')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit plan modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl flex max-h-[90vh] flex-col">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">
                {editing ? t('facebook.postDetail.editPlanTitle') : t('facebook.postDetail.createPlanTitle')}
              </h2>
              <button onClick={closeModal} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-4 overflow-y-auto p-5">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">{t('facebook.postDetail.fieldComment')}</label>
                  <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={generating}
                    className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                  >
                    {generating ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                    {generating ? t('facebook.postDetail.aiGenerating') : t('facebook.postDetail.aiGenerate')}
                  </button>
                </div>
                <textarea
                  value={form.comment_content}
                  onChange={(e) => setForm((p) => ({ ...p, comment_content: e.target.value }))}
                  placeholder={t('facebook.postDetail.fieldCommentPlaceholder')}
                  rows={3}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.postDetail.fieldAgentGroup')}</label>
                <select
                  value={form.agent_group ?? ''}
                  onChange={(e) => setForm((p) => ({ ...p, agent_group: e.target.value ? Number(e.target.value) : null }))}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t('facebook.postDetail.none')}</option>
                  {(agentGroups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.postDetail.fieldProfile')}</label>
                  <select
                    value={form.profile ?? ''}
                    onChange={(e) => setForm((p) => ({ ...p, profile: e.target.value ? Number(e.target.value) : null }))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">{t('facebook.postDetail.none')}</option>
                    {(profiles ?? []).map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.postDetail.fieldDevice')}</label>
                  <select
                    value={form.device ?? ''}
                    onChange={(e) => setForm((p) => ({ ...p, device: e.target.value ? Number(e.target.value) : null }))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">{t('facebook.postDetail.none')}</option>
                    {(devices ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
              </div>

              {formError && <p className="text-xs text-destructive">{formError}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" onClick={closeModal} disabled={saveMutation.isPending}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSubmit} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
