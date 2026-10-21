/**
 * Lists the queued (and recent) scheduled photo-posts of a character, with a
 * cancel action for pending ones. Reads /character-scheduled-posts/?character=
 * and cancels via the /cancel/ action.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Loader2, X } from 'lucide-react'
import { useToast } from '@/context/ToastContext'
import { characterScheduledPostsApi } from '@/lib/api'
import type { CharacterScheduledPost } from '@/lib/types'

const PLATFORM_LABEL: Record<CharacterScheduledPost['platform'], string> = {
  tiktok: 'TikTok',
  facebook_profile: 'Facebook cá nhân',
  facebook_page: 'Facebook Page',
  facebook_group: 'Facebook Group',
}

const STATUS_STYLE: Record<CharacterScheduledPost['status'], string> = {
  pending: 'bg-amber-500/15 text-amber-600',
  publishing: 'bg-blue-500/15 text-blue-600',
  published: 'bg-emerald-500/15 text-emerald-600',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
}

const STATUS_LABEL: Record<CharacterScheduledPost['status'], string> = {
  pending: 'Đang chờ',
  publishing: 'Đang đăng',
  published: 'Đã đăng',
  failed: 'Thất bại',
  cancelled: 'Đã huỷ',
}

function targetName(p: CharacterScheduledPost): string {
  return (
    p.fb_profile_name || p.fb_page_name || p.fb_group_name ||
    p.profile_name || p.device_name || '—'
  )
}

export default function CharacterScheduledPosts({ characterId }: { characterId: number }) {
  const { showToast } = useToast()
  const qc = useQueryClient()

  const { data: posts = [], isLoading } = useQuery<CharacterScheduledPost[]>({
    queryKey: ['character-scheduled-posts', characterId],
    queryFn: () => characterScheduledPostsApi.list({ character: characterId }),
    // Pending posts fire from a 30s backend poller — keep the panel roughly fresh.
    refetchInterval: 30_000,
  })

  const cancelMut = useMutation({
    mutationFn: (id: number) => characterScheduledPostsApi.cancel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['character-scheduled-posts', characterId] })
      showToast('Đã huỷ bài lên lịch.', 'success')
    },
    onError: (err) => showToast(err instanceof Error ? err.message : 'Huỷ thất bại.', 'error'),
  })

  if (isLoading) {
    return (
      <div className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Đang tải lịch đăng…
      </div>
    )
  }
  if (posts.length === 0) return null

  return (
    <>
      <p className="mb-2 mt-6 flex items-center gap-1.5 text-sm font-medium">
        <CalendarClock className="size-4" />
        Lịch đăng bài ({posts.length})
      </p>
      <div className="flex flex-col gap-2">
        {posts.map((p) => (
          <div key={p.id} className="flex items-center gap-3 rounded-lg border border-border p-2.5">
            {p.image_urls[0] && (
              <img src={p.image_urls[0]} alt="" className="size-10 shrink-0 rounded object-cover" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{PLATFORM_LABEL[p.platform]}</span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[p.status]}`}>
                  {STATUS_LABEL[p.status]}
                </span>
                <span className="text-[11px] text-muted-foreground">· {targetName(p)}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {new Date(p.scheduled_at).toLocaleString()} · {p.image_urls.length} ảnh
              </p>
              {p.status === 'failed' && p.error_msg && (
                <p className="mt-0.5 truncate text-[11px] text-destructive" title={p.error_msg}>{p.error_msg}</p>
              )}
            </div>
            {p.status === 'pending' && (
              <button
                type="button"
                onClick={() => cancelMut.mutate(p.id)}
                disabled={cancelMut.isPending}
                title="Huỷ"
                className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
