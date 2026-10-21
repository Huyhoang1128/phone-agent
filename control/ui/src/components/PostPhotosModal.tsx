/**
 * "Đăng bài" — post a character's photos to a social platform.
 * Supports TikTok (device automation), Facebook cá nhân (device automation),
 * Facebook Page and Facebook Group (Graph API). Lets the user pick images from
 * the character's media store and/or upload local files, add a caption +
 * hashtags, choose the platform + target, optionally schedule a time, then
 * dispatches via charactersApi.postPhotos.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, ImagePlus, Loader2, Send, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import {
  charactersApi,
  contentsApi,
  devicesApi,
  profilesApi,
  facebookProfilesApi,
  facebookPagesApi,
  facebookGroupsApi,
  type CharacterPostPlatform,
} from '@/lib/api'
import type {
  Character,
  Device,
  Profile,
  FacebookProfile,
  FacebookPage,
  FacebookGroup,
} from '@/lib/types'

interface Props {
  character: Character
  onClose: () => void
}

const PLATFORMS: { value: CharacterPostPlatform; label: string }[] = [
  { value: 'tiktok', label: 'TikTok' },
  { value: 'facebook_profile', label: 'Facebook cá nhân' },
  { value: 'facebook_page', label: 'Facebook Page' },
  { value: 'facebook_group', label: 'Facebook Group' },
]

export default function PostPhotosModal({ character, onClose }: Props) {
  const { showToast } = useToast()
  const qc = useQueryClient()

  const [platform, setPlatform] = useState<CharacterPostPlatform>('tiktok')
  const [caption, setCaption] = useState('')
  const [hashtagText, setHashtagText] = useState('')
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set())
  const [uploads, setUploads] = useState<File[]>([])
  const [scheduledAt, setScheduledAt] = useState('')
  // Per-platform targets
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const [profileId, setProfileId] = useState<number | null>(null)
  const [fbProfileId, setFbProfileId] = useState<number | null>(null)
  const [fbPageId, setFbPageId] = useState<number | null>(null)
  const [fbGroupId, setFbGroupId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [genCaption, setGenCaption] = useState(false)
  const [error, setError] = useState('')

  const { data: devices = [] } = useQuery<Device[]>({ queryKey: ['devices'], queryFn: () => devicesApi.list() })
  const { data: profiles = [] } = useQuery<Profile[]>({ queryKey: ['profiles'], queryFn: () => profilesApi.list() })
  const { data: fbProfiles = [] } = useQuery<FacebookProfile[]>({
    queryKey: ['facebook-profiles'],
    queryFn: () => facebookProfilesApi.list(),
    enabled: platform === 'facebook_profile',
  })
  const { data: fbPages = [] } = useQuery<FacebookPage[]>({
    queryKey: ['facebook-pages'],
    queryFn: () => facebookPagesApi.list(),
    enabled: platform === 'facebook_page',
  })
  const { data: fbGroups = [] } = useQuery<FacebookGroup[]>({
    queryKey: ['facebook-groups'],
    queryFn: () => facebookGroupsApi.list(),
    enabled: platform === 'facebook_group',
  })

  function toggleUrl(url: string) {
    setError('')
    setSelectedUrls((prev) => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }

  const hashtags = hashtagText
    .split(/[\s,]+/)
    .map((h) => h.trim().replace(/^#+/, ''))
    .filter(Boolean)

  const totalImages = selectedUrls.size + uploads.length
  const isFacebook = platform !== 'tiktok'
  // Any character image is postable: original source + swapped media + raw
  // scenes (source first, deduped by URL).
  const pickableImages = [
    ...(character.source_image_url ? [{ url: character.source_image_url, created_at: '' }] : []),
    ...character.media,
    ...character.scenes,
  ].filter((m, i, arr) => arr.findIndex((x) => x.url === m.url) === i)

  function hasTarget(): boolean {
    switch (platform) {
      case 'tiktok':
        return !!deviceId || !!profileId
      case 'facebook_profile':
        return !!fbProfileId
      case 'facebook_page':
        return !!fbPageId
      case 'facebook_group':
        return !!fbGroupId
    }
  }

  async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  // AI writes a caption + hashtags by looking at the first chosen image.
  async function handleGenCaption() {
    setError('')
    let url = Array.from(selectedUrls)[0] || pickableImages[0]?.url || ''
    if (!url && uploads[0]) {
      try { url = await fileToDataUrl(uploads[0]) } catch { /* ignore */ }
    }
    if (!url) { setError('Hãy chọn (hoặc upload) ít nhất 1 ảnh để AI xem.'); return }
    setGenCaption(true)
    try {
      const r = await contentsApi.captionFromImage(url, platform)
      if (r.caption) setCaption(r.caption)
      if (r.hashtags?.length) setHashtagText(r.hashtags.join(' '))
      showToast('Đã tạo caption từ ảnh.', 'success')
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Tạo caption thất bại.'
      setError(m); showToast(m, 'error')
    } finally { setGenCaption(false) }
  }

  async function handleSubmit() {
    if (totalImages === 0) { setError('Hãy chọn ít nhất 1 ảnh để đăng.'); return }
    if (!hasTarget()) { setError('Hãy chọn nơi đăng (thiết bị / profile / page / group).'); return }
    if (isFacebook && !caption.trim() && hashtags.length === 0) {
      setError('Facebook yêu cầu nội dung — hãy nhập caption hoặc hashtag.')
      return
    }
    setError('')
    setLoading(true)
    try {
      await charactersApi.postPhotos({
        platform,
        media_urls: Array.from(selectedUrls),
        images: uploads,
        caption: caption.trim(),
        hashtags,
        character_id: character.id,
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        device_id: platform === 'tiktok' ? deviceId : null,
        profile_id: platform === 'tiktok' ? profileId : null,
        fb_profile_id: platform === 'facebook_profile' ? fbProfileId : null,
        fb_page_id: platform === 'facebook_page' ? fbPageId : null,
        fb_group_id: platform === 'facebook_group' ? fbGroupId : null,
      })
      if (scheduledAt) {
        qc.invalidateQueries({ queryKey: ['character-scheduled-posts', character.id] })
      }
      showToast(
        scheduledAt ? 'Đã lên lịch đăng bài.' : 'Đã gửi lệnh đăng ảnh.',
        'success',
      )
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Đăng bài thất bại.'
      setError(message)
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Đăng bài</h2>
            <p className="mt-1 text-xs text-muted-foreground">Đăng ảnh của “{character.name || 'nhân vật'}” lên nền tảng bạn chọn.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 overflow-auto p-5">
          {/* Platform selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Nền tảng</label>
            <div className="flex flex-wrap gap-1.5">
              {PLATFORMS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => { setError(''); setPlatform(p.value) }}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                    platform === p.value
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border hover:bg-muted'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Caption */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Caption</label>
              <button
                type="button"
                onClick={handleGenCaption}
                disabled={genCaption}
                title="AI nhìn ảnh đã chọn và tự viết caption + hashtag"
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-60"
              >
                {genCaption ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />} Tạo caption
              </button>
            </div>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={3}
              placeholder="Nội dung bài đăng..."
              className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Hashtags */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Hashtag</label>
            <input
              type="text"
              value={hashtagText}
              onChange={(e) => setHashtagText(e.target.value)}
              placeholder="review lamdep xuhuong (cách nhau bởi dấu cách hoặc phẩy)"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            {hashtags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {hashtags.map((h, i) => (
                  <span key={i} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">#{h}</span>
                ))}
              </div>
            )}
            {isFacebook && (
              <p className="text-[11px] text-muted-foreground">Trên Facebook, hashtag được gộp vào cuối nội dung bài đăng.</p>
            )}
          </div>

          {/* Image picker */}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Ảnh ({totalImages} đã chọn)</label>
            {pickableImages.length > 0 ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {pickableImages.map((m, i) => {
                  const sel = selectedUrls.has(m.url)
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => toggleUrl(m.url)}
                      className={`relative aspect-square overflow-hidden rounded-lg border-2 transition ${sel ? 'border-primary' : 'border-transparent hover:border-border'}`}
                    >
                      <img src={m.url} alt="" className="h-full w-full object-cover" />
                      {sel && (
                        <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                          {Array.from(selectedUrls).indexOf(m.url) + 1}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Nhân vật chưa có ảnh media — hãy upload ảnh bên dưới.</p>
            )}

            <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted">
              <ImagePlus className="size-3.5" />
              Upload ảnh từ máy
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => { setError(''); setUploads((prev) => [...prev, ...Array.from(e.target.files ?? [])]) }}
              />
            </label>
            {uploads.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {uploads.map((f, i) => (
                  <div key={i} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                    <span className="max-w-[140px] truncate">{f.name}</span>
                    <button type="button" onClick={() => setUploads((prev) => prev.filter((_, k) => k !== i))} className="text-muted-foreground hover:text-destructive">
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Target — per platform */}
          {platform === 'tiktok' && (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Thiết bị</label>
                  <select
                    value={deviceId ?? ''}
                    onChange={(e) => {
                      setError('')
                      const id = e.target.value ? Number(e.target.value) : null
                      setDeviceId(id)
                      if (id != null) {
                        const match = profiles.find((p) => p.device === id)
                        if (match) setProfileId(match.id)
                      }
                    }}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">— Chọn thiết bị —</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>{d.name || d.device_serial_id}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Hoặc Profile</label>
                  <select
                    value={profileId ?? ''}
                    onChange={(e) => {
                      setError('')
                      const id = e.target.value ? Number(e.target.value) : null
                      setProfileId(id)
                      if (id != null) {
                        const p = profiles.find((x) => x.id === id)
                        if (p?.device != null) setDeviceId(p.device)
                      }
                    }}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">— Chọn profile —</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">Chỉ cần chọn 1 trong 2 — hệ thống tự khớp thiết bị ↔ profile tương ứng.</p>
            </>
          )}

          {platform === 'facebook_profile' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Facebook cá nhân</label>
              <select
                value={fbProfileId ?? ''}
                onChange={(e) => { setError(''); setFbProfileId(e.target.value ? Number(e.target.value) : null) }}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">— Chọn Facebook cá nhân —</option>
                {fbProfiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.account_name ? ` (${p.account_name})` : ''}</option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">Đăng qua thiết bị đã gắn với profile (đã đăng nhập FB).</p>
            </div>
          )}

          {platform === 'facebook_page' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Facebook Page</label>
              <select
                value={fbPageId ?? ''}
                onChange={(e) => { setError(''); setFbPageId(e.target.value ? Number(e.target.value) : null) }}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">— Chọn Page —</option>
                {fbPages.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">Đăng qua Graph API bằng page token đã cấu hình.</p>
            </div>
          )}

          {platform === 'facebook_group' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Facebook Group</label>
              <select
                value={fbGroupId ?? ''}
                onChange={(e) => { setError(''); setFbGroupId(e.target.value ? Number(e.target.value) : null) }}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">— Chọn Group —</option>
                {fbGroups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">Đăng qua Graph API bằng group token đã cấu hình.</p>
            </div>
          )}

          {/* Schedule */}
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-1.5 text-sm font-medium">
              <CalendarClock className="size-3.5" />
              Lên lịch (tùy chọn)
            </label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => { setError(''); setScheduledAt(e.target.value) }}
              className="w-fit rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-[11px] text-muted-foreground">Để trống = đăng ngay. Chọn thời gian = tự động đăng đúng giờ.</p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={onClose}>Hủy</Button>
          <Button onClick={handleSubmit} disabled={loading} className="gap-1.5">
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : scheduledAt ? <CalendarClock className="size-3.5" /> : <Send className="size-3.5" />}
            {scheduledAt ? 'Lên lịch' : 'Đăng bài'}
          </Button>
        </div>
      </div>
    </div>
  )
}
