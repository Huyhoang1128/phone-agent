/**
 * "Bình luận trên bài" — real (scraped) comments on a Facebook post + "Phân tích"
 * (semantic clustering, like the TikTok comment analysis). Reusable across the
 * Facebook page-post and scheduled-post surfaces: pass the matching api funcs.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BarChart3, Eye, EyeOff, Loader2, MessagesSquare, RefreshCw } from 'lucide-react'
import { useToast } from '@/context/ToastContext'
import type { FacebookPostUserComment, FacebookCommentClusterResponse, FacebookFetchCommentsResponse } from '@/lib/types'

interface Props {
  postId: number
  api: {
    list: (id: number) => Promise<FacebookPostUserComment[]>
    fetch: (id: number) => Promise<FacebookFetchCommentsResponse>
    cluster: (id: number) => Promise<FacebookCommentClusterResponse>
  }
}

export default function CommentInsightsPanel({ postId, api }: Props) {
  const { showToast } = useToast()
  const qc = useQueryClient()
  const [show, setShow] = useState(true)
  const [clusters, setClusters] = useState<FacebookCommentClusterResponse | null>(null)

  const { data: comments = [], isLoading } = useQuery<FacebookPostUserComment[]>({
    queryKey: ['fb-post-comments', postId],
    queryFn: () => api.list(postId),
  })

  const fetchMut = useMutation({
    mutationFn: () => api.fetch(postId),
    onSuccess: (r) => {
      qc.setQueryData(['fb-post-comments', postId], r.comments)
      showToast(`Đã lấy ${r.total} bình luận (mới ${r.saved}).`, 'success')
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Lấy bình luận thất bại.', 'error'),
  })

  const clusterMut = useMutation({
    mutationFn: () => api.cluster(postId),
    onSuccess: (r) => { setClusters(r); showToast(`Đã phân ${r.n_clusters} cụm từ ${r.source_comments} bình luận.`, 'success') },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Phân tích thất bại.', 'error'),
  })

  // Group cluster points by cluster id, ordered by size; -1 = noise/khác.
  const grouped = clusters
    ? (() => {
        const m = new Map<number, string[]>()
        for (const p of clusters.points) {
          const c = typeof p.cluster === 'number' ? p.cluster : -1
          if (!m.has(c)) m.set(c, [])
          m.get(c)!.push(p.text)
        }
        return [...m.entries()].sort((a, b) => (a[0] < 0 ? 1 : b[0] < 0 ? -1 : b[1].length - a[1].length))
      })()
    : []

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><MessagesSquare className="size-4" /> Bình luận trên bài {comments.length > 0 && <span className="text-xs font-normal text-muted-foreground">({comments.length})</span>}</h3>
        <div className="flex items-center gap-1.5">
          <button onClick={() => fetchMut.mutate()} disabled={fetchMut.isPending} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60">
            {fetchMut.isPending ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} Lấy bình luận
          </button>
          <button onClick={() => clusterMut.mutate()} disabled={clusterMut.isPending || comments.length === 0} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60">
            {clusterMut.isPending ? <Loader2 className="size-3 animate-spin" /> : <BarChart3 className="size-3" />} Phân tích
          </button>
          <button onClick={() => setShow((s) => !s)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted">
            {show ? <EyeOff className="size-3" /> : <Eye className="size-3" />} {show ? 'Ẩn' : 'Hiện'}
          </button>
        </div>
      </div>

      {show && (
        <div className="flex flex-col gap-4 p-4">
          {/* Clusters ("Phân tích") */}
          {clusters && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">Phân cụm: {clusters.n_clusters} cụm / {clusters.source_comments} bình luận</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {grouped.map(([cid, texts]) => (
                  <div key={cid} className="rounded-lg border border-border bg-muted/20 p-2.5">
                    <p className="mb-1 text-xs font-semibold">
                      {cid < 0 ? 'Khác / nhiễu' : (clusters.cluster_labels?.[String(cid)] || `Cụm ${cid + 1}`)}
                      <span className="ml-1 font-normal text-muted-foreground">({texts.length})</span>
                    </p>
                    <ul className="flex flex-col gap-1">
                      {texts.slice(0, 5).map((t, i) => <li key={i} className="line-clamp-2 text-xs text-muted-foreground">• {t}</li>)}
                      {texts.length > 5 && <li className="text-[11px] text-muted-foreground/70">… và {texts.length - 5} bình luận nữa</li>}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Real comment list */}
          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
          ) : comments.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Chưa có bình luận. Bấm “Lấy bình luận” để cào từ Facebook.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {comments.map((c) => (
                <div key={c.id} className={`rounded-lg border border-border bg-muted/30 p-3 ${c.parent_cid ? 'ml-6' : ''}`}>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{c.nickname || c.user_id || 'Ẩn danh'}</span>
                    {c.parent_cid && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">Trả lời</span>}
                    {c.create_time && <span>{new Date(c.create_time).toLocaleString()}</span>}
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-foreground">{c.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
