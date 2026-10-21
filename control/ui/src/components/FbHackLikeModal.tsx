/**
 * FB reaction-boost (🚀) modal for a scheduled-post row. The user picks a stored
 * "Key Hack Facebook" (hacklike17 token), a target url (prefilled with the post
 * link, editable — any link works), count, speed and one OR MORE reactions
 * (multiple emotions per order — only applies on server 1/3/7/10). The order is
 * proxied through the backend (token never leaves the server). On success the
 * service returns {status:1, order_id, ...} → we toast it.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Rocket, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { fbHackKeysApi } from '@/lib/api'
import type { FacebookProfileScheduledPost, FacebookScheduledPost, FbHackKey } from '@/lib/types'

const REACTIONS = ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry'] as const

interface Props {
  // Works for both personal-profile and page scheduled posts — only fb_post_id is read.
  post: FacebookProfileScheduledPost | FacebookScheduledPost
  // Which post model this is, so the backend records the buff against the right row.
  postKind: 'profile' | 'page'
  onClose: () => void
}

export function FbHackLikeModal({ post, postKind, onClose }: Props) {
  const { showToast } = useToast()
  const qc = useQueryClient()
  const [hackKeyId, setHackKeyId] = useState<number | null>(null)
  const [url, setUrl] = useState(post.fb_post_id || '')
  const [count, setCount] = useState('100')
  const [reactions, setReactions] = useState<string[]>(['like'])
  const [speed, setSpeed] = useState('0')
  const [submitting, setSubmitting] = useState(false)

  const { data: keys = [], isLoading } = useQuery<FbHackKey[]>({
    queryKey: ['fb-hack-keys'],
    queryFn: fbHackKeysApi.list,
  })
  const effectiveKeyId = hackKeyId ?? (keys.find((k) => k.is_active)?.id ?? keys[0]?.id ?? null)

  function toggleReaction(r: string) {
    setReactions((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]))
  }

  async function submit() {
    if (!effectiveKeyId) { showToast('Hãy tạo / chọn key bên thứ 3 (vào tab API Keys).', 'error'); return }
    if (!url.trim()) { showToast('Nhập URL.', 'error'); return }
    if (reactions.length === 0) { showToast('Chọn ít nhất một cảm xúc.', 'error'); return }
    const n = parseInt(count, 10)
    if (!Number.isFinite(n) || n <= 0) { showToast('Số lượng không hợp lệ.', 'error'); return }
    setSubmitting(true)
    try {
      const res = await fbHackKeysApi.like({
        hack_key: effectiveKeyId,
        url: url.trim(),
        count: n,
        reactions,
        speed: speed.trim() || '0',
        scheduled_post_id: post.id,
        scheduled_post_kind: postKind,
      })
      if (res.status === 1) {
        showToast(`${res.msg || 'Mua dịch vụ thành công'}${res.order_id ? ` · order #${res.order_id}` : ''}`, 'success')
        // Refresh whichever scheduled-post list is open so the "đã buff" badge updates.
        qc.invalidateQueries({ predicate: (q) => q.queryKey.some((k) => typeof k === 'string' && k.includes('scheduled')) })
        onClose()
      } else {
        showToast(res.msg || 'Dịch vụ trả về lỗi.', 'error')
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Gọi dịch vụ thất bại.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-xl border border-border bg-card shadow-xl">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Rocket className="size-4 text-primary" /> Tăng cảm xúc (hacklike)
          </h2>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        {/* Body (scrolls if tall) */}
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
          {/* Hack key */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Key Hack Facebook</label>
            {isLoading ? (
              <p className="text-xs text-muted-foreground">Đang tải…</p>
            ) : keys.length === 0 ? (
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                Chưa có key nào. Vào tab <b>API Keys</b> → "Tạo Key Hack Facebook" để thêm trước.
              </p>
            ) : (
              <select
                value={effectiveKeyId ?? ''}
                onChange={(e) => setHackKeyId(Number(e.target.value))}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                {keys.map((k) => (
                  <option key={k.id} value={k.id} disabled={!k.is_active}>
                    {k.name} ({k.key_masked}){k.is_active ? '' : ' — tắt'}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* URL */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">URL</label>
            <input
              type="text" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.facebook.com/..."
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Count + Speed */}
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <label className="text-sm font-medium">Số lượng</label>
                <input
                  type="number" min={1} value={count} onChange={(e) => setCount(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <label className="text-sm font-medium">Speed</label>
                <input
                  type="number" min={0} value={speed} onChange={(e) => setSpeed(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <span className="text-[11px] text-muted-foreground">Speed: 0 / 15 / 50 = nhanh / bình thường / chậm</span>
          </div>

          {/* Reactions (multi-select) */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Cảm xúc <span className="font-normal text-muted-foreground">(chọn nhiều được — chỉ áp dụng server 1/3/7/10)</span></label>
            <div className="flex flex-wrap gap-1.5">
              {REACTIONS.map((r) => {
                const active = reactions.includes(r)
                return (
                  <button
                    key={r} type="button" onClick={() => toggleReaction(r)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition ${
                      active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {r}
                  </button>
                )
              })}
            </div>
            {reactions.length > 0 && (
              <span className="text-[11px] text-muted-foreground">Đã chọn: {reactions.join(', ')}</span>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={submitting}>Hủy</Button>
          <Button onClick={submit} disabled={submitting || keys.length === 0} className="gap-1.5">
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
            Gửi
          </Button>
        </div>
      </div>
    </div>
  )
}
