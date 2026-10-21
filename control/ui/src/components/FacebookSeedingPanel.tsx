import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Sparkles,
  Send,
  Trash2,
  Plus,
  ThumbsUp,
  MessageCircle,
  CornerDownRight,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  facebookGroupPostSeedingActionsApi,
  facebookProfilePostSeedingActionsApi,
  facebookProfilesApi,
} from '@/lib/api'
import type {
  FacebookProfile,
  FacebookGroupPostSeedingAction,
  FacebookProfilePostSeedingAction,
  FacebookSeedingActionStatus,
  FacebookSeedingInteractionType,
} from '@/lib/types'

type SeedingAction =
  | FacebookProfilePostSeedingAction
  | FacebookGroupPostSeedingAction

interface Props {
  postId: number
  surface: 'profile' | 'group'
}

const STATUS_TONE: Record<FacebookSeedingActionStatus, string> = {
  pending: 'bg-slate-100 text-slate-700 border-slate-200',
  dispatched: 'bg-amber-100 text-amber-700 border-amber-200',
  done: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  failed: 'bg-rose-100 text-rose-700 border-rose-200',
}

const STATUS_LABEL: Record<FacebookSeedingActionStatus, string> = {
  pending: 'Chưa chạy',
  dispatched: 'Đang chạy',
  done: 'Đã xong',
  failed: 'Thất bại',
}

const TYPE_LABEL: Record<FacebookSeedingInteractionType, string> = {
  like: 'Thích',
  comment: 'Bình luận',
  reply: 'Trả lời',
}

function TypeIcon({ type }: { type: FacebookSeedingInteractionType }) {
  if (type === 'like') return <ThumbsUp className="size-4 text-blue-600" />
  if (type === 'comment') return <MessageCircle className="size-4 text-indigo-600" />
  return <CornerDownRight className="size-4 text-violet-600" />
}

export default function FacebookSeedingPanel({ postId, surface }: Props) {
  const qc = useQueryClient()
  const api =
    surface === 'profile'
      ? facebookProfilePostSeedingActionsApi
      : facebookGroupPostSeedingActionsApi
  const queryKey = ['fb-seeding-actions', surface, postId]

  const { data: actions, isLoading, refetch, isFetching } = useQuery({
    queryKey,
    queryFn: () => api.list({ post: postId }) as Promise<SeedingAction[]>,
  })

  const { data: profiles } = useQuery({
    queryKey: ['fb-profiles-for-seeding'],
    queryFn: () => facebookProfilesApi.list(),
  })

  const [adding, setAdding] = useState(false)
  const [newType, setNewType] = useState<FacebookSeedingInteractionType>('comment')
  const [newActor, setNewActor] = useState<number | ''>('')
  const [newContent, setNewContent] = useState('')
  const [newReplyUser, setNewReplyUser] = useState('')
  const [newReplySnippet, setNewReplySnippet] = useState('')
  const [newAiPrompt, setNewAiPrompt] = useState('')

  const profileOptions = useMemo<FacebookProfile[]>(
    () => (profiles ?? []).filter((p) => !!p.device),
    [profiles],
  )

  const createMut = useMutation({
    mutationFn: () =>
      api.create({
        post: postId,
        actor_fb_profile: newActor === '' ? undefined : Number(newActor),
        interaction_type: newType,
        comment_content: newType === 'like' ? '' : newContent,
        reply_target_username: newType === 'reply' ? newReplyUser : '',
        reply_target_snippet: newType === 'reply' ? newReplySnippet : '',
        ai_prompt: newAiPrompt,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey })
      setAdding(false)
      setNewContent('')
      setNewReplyUser('')
      setNewReplySnippet('')
      setNewAiPrompt('')
      setNewActor('')
    },
  })

  const dispatchMut = useMutation({
    mutationFn: (id: number) => api.dispatch(id),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  })

  const aiGenMut = useMutation({
    mutationFn: ({ id, prompt }: { id: number; prompt?: string }) =>
      api.aiGenerate(id, prompt),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  })

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-amber-500" />
          <h3 className="text-sm font-semibold">Tương tác seeding</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {actions?.length ?? 0}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
            title="Tải lại"
          >
            <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
          {!adding && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" />
              Thêm
            </Button>
          )}
        </div>
      </div>

      {adding && (
        <div className="space-y-3 border-b border-border bg-muted/30 p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs">
              <span className="font-medium">Loại tương tác</span>
              <select
                value={newType}
                onChange={(e) =>
                  setNewType(e.target.value as FacebookSeedingInteractionType)
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="like">Thích</option>
                <option value="comment">Bình luận</option>
                <option value="reply">Trả lời comment</option>
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-medium">Actor (tài khoản FB thực hiện)</span>
              <select
                value={newActor}
                onChange={(e) =>
                  setNewActor(e.target.value ? Number(e.target.value) : '')
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="">— Chọn actor —</option>
                {profileOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.account_name ? `(${p.account_name})` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {newType === 'reply' && (
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-xs">
                <span className="font-medium">User của comment cần trả lời</span>
                <input
                  value={newReplyUser}
                  onChange={(e) => setNewReplyUser(e.target.value)}
                  placeholder="VD: Nguyễn Văn A"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium">Đoạn text của comment gốc</span>
                <input
                  value={newReplySnippet}
                  onChange={(e) => setNewReplySnippet(e.target.value)}
                  placeholder="VD: bài viết hay quá..."
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                />
              </label>
            </div>
          )}

          {newType !== 'like' && (
            <label className="space-y-1 text-xs">
              <span className="font-medium">Nội dung</span>
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                rows={3}
                placeholder="Có thể nhập tay hoặc để trống và bấm AI generate sau khi tạo."
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              />
            </label>
          )}

          {newType !== 'like' && (
            <label className="space-y-1 text-xs">
              <span className="font-medium">Prompt AI (tuỳ chọn)</span>
              <input
                value={newAiPrompt}
                onChange={(e) => setNewAiPrompt(e.target.value)}
                placeholder="VD: phản hồi tích cực, văn phong tự nhiên..."
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              />
            </label>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAdding(false)}
              disabled={createMut.isPending}
            >
              Huỷ
            </Button>
            <Button
              size="sm"
              onClick={() => createMut.mutate()}
              disabled={
                createMut.isPending ||
                !newActor ||
                (newType !== 'like' && !newContent.trim() && !newAiPrompt.trim()) ||
                (newType === 'reply' && (!newReplyUser.trim() || !newReplySnippet.trim()))
              }
            >
              {createMut.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Tạo
            </Button>
          </div>
          {createMut.error ? (
            <p className="text-xs text-rose-600">{String(createMut.error)}</p>
          ) : null}
        </div>
      )}

      <div className="divide-y divide-border">
        {isLoading && (
          <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-3.5 animate-spin" />
            Đang tải…
          </div>
        )}
        {!isLoading && (actions ?? []).length === 0 && (
          <div className="py-6 text-center text-xs text-muted-foreground">
            Chưa có action seeding nào. Bấm “Thêm” để tạo.
          </div>
        )}
        {(actions ?? []).map((a) => (
          <div key={a.id} className="space-y-2 px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <TypeIcon type={a.interaction_type} />
                <span className="font-medium">{TYPE_LABEL[a.interaction_type]}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">
                  {a.actor_fb_profile_name ?? '—'}
                </span>
              </div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[a.status]}`}
              >
                {STATUS_LABEL[a.status]}
              </span>
            </div>

            {a.interaction_type === 'reply' && (
              <div className="rounded-md border border-dashed border-border bg-muted/40 p-2 text-xs">
                <div className="font-medium">{a.reply_target_username || '—'}</div>
                <div className="text-muted-foreground">{a.reply_target_snippet || '—'}</div>
              </div>
            )}

            {a.interaction_type !== 'like' && (
              <div className="whitespace-pre-wrap text-sm">
                {a.comment_content || (
                  <span className="text-muted-foreground italic">
                    (chưa có nội dung)
                  </span>
                )}
              </div>
            )}

            {a.fb_comment_id && (
              <a
                href={a.fb_comment_id}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-600 underline"
              >
                Xem comment ↗
              </a>
            )}
            {a.error_msg && (
              <p className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700">
                {a.error_msg}
              </p>
            )}

            <div className="flex items-center justify-end gap-1">
              {a.interaction_type !== 'like' &&
                (a.status === 'pending' || a.status === 'failed') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      aiGenMut.mutate({ id: a.id, prompt: a.ai_prompt })
                    }
                    disabled={aiGenMut.isPending}
                    title="Sinh nội dung bằng AI"
                  >
                    <Sparkles className="size-3.5" />
                    AI
                  </Button>
                )}
              {(a.status === 'pending' || a.status === 'failed') && (
                <Button
                  size="sm"
                  onClick={() => dispatchMut.mutate(a.id)}
                  disabled={dispatchMut.isPending}
                  title="Dispatch task tới worker"
                >
                  <Send className="size-3.5" />
                  Chạy
                </Button>
              )}
              {a.status !== 'dispatched' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm('Xoá action này?')) {
                      deleteMut.mutate(a.id)
                    }
                  }}
                  disabled={deleteMut.isPending}
                  title="Xoá"
                >
                  <Trash2 className="size-3.5 text-rose-600" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
