/**
 * "Đăng lại video" — schedule a character's generated video to TikTok.
 * Reuses tiktokApi.scheduleTiktokVideo (link_download + profile + run time).
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { profilesApi, tiktokApi } from '@/lib/api'
import type { Profile } from '@/lib/types'

interface Props {
  videoUrl: string
  onClose: () => void
}

export default function PostVideoModal({ videoUrl, onClose }: Props) {
  const { showToast } = useToast()
  const [profileId, setProfileId] = useState<number | null>(null)
  const [scheduledAt, setScheduledAt] = useState('') // empty = now
  const [caption, setCaption] = useState('')
  const [hashtags, setHashtags] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const { data: profiles = [] } = useQuery<Profile[]>({ queryKey: ['profiles'], queryFn: () => profilesApi.list() })

  async function handlePost() {
    if (!profileId) { setError('Hãy chọn kênh (profile) để đăng.'); return }
    setError('')
    setLoading(true)
    try {
      // Split on spaces/commas/newlines, strip leading '#', drop blanks.
      const hashtagList = hashtags.split(/[\s,]+/).map((t) => t.trim().replace(/^#+/, '')).filter(Boolean)
      await tiktokApi.scheduleTiktokVideo({
        profile_id: profileId,
        link_download: videoUrl,
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : new Date().toISOString(),
        caption: caption.trim(),
        hashtags: hashtagList,
      })
      showToast(scheduledAt ? 'Đã lên lịch đăng video.' : 'Đã gửi lệnh đăng video lên TikTok.', 'success')
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Đăng video thất bại.'
      setError(message)
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div className="flex w-full max-w-md flex-col rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Đăng lại video</h2>
            <p className="mt-1 text-xs text-muted-foreground">Đăng video này lên TikTok qua kênh đã chọn.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <video src={videoUrl} controls className="max-h-56 w-full rounded-lg border border-border bg-black" />

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Caption <span className="font-normal text-muted-foreground">(tuỳ chọn)</span></label>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={3}
              placeholder="Nội dung mô tả cho video…"
              className="resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Hashtag <span className="font-normal text-muted-foreground">(cách nhau bởi dấu cách hoặc phẩy)</span></label>
            <input
              type="text"
              value={hashtags}
              onChange={(e) => setHashtags(e.target.value)}
              placeholder="review lamdep xuhuong"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Chọn kênh (profile)</label>
            <select
              value={profileId ?? ''}
              onChange={(e) => { setError(''); setProfileId(e.target.value ? Number(e.target.value) : null) }}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">— Chọn profile —</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Thời gian đăng <span className="font-normal text-muted-foreground">(để trống = đăng ngay)</span></label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={onClose}>Hủy</Button>
          <Button onClick={handlePost} disabled={loading} className="gap-1.5">
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Đăng lại
          </Button>
        </div>
      </div>
    </div>
  )
}
