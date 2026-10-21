/**
 * "Đổi Avatar" — set a Facebook Page's profile picture (avatar) and/or cover
 * photo using the character's own images (source / media / scenes). Pick a Page,
 * pick an image for the avatar slot and/or the cover slot, FRAME each image with
 * the crop tool (avatar 1:1, cover ≈ 2.63:1), then apply via
 * charactersApi.changePageImage (Graph API: POST /{page}/picture + cover).
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Crop, Image as ImageIcon, Images, Loader2, UserRound, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { charactersApi, facebookPagesApi } from '@/lib/api'
import type { Character, FacebookPage } from '@/lib/types'
import ImageCropper, { type CropRect } from '@/components/ImageCropper'

interface Props {
  character: Character
  onClose: () => void
}

const AVATAR_ASPECT = 1
const COVER_ASPECT = 820 / 312 // Facebook page cover ratio ≈ 2.63

export default function ChangeAvatarModal({ character, onClose }: Props) {
  const { showToast } = useToast()
  const [fbPageId, setFbPageId] = useState<number | null>(null)
  const [avatar, setAvatar] = useState<{ url: string; crop: CropRect } | null>(null)
  const [cover, setCover] = useState<{ url: string; crop: CropRect } | null>(null)
  const [assign, setAssign] = useState<'avatar' | 'cover'>('avatar')
  const [cropEditing, setCropEditing] = useState<{ slot: 'avatar' | 'cover'; src: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const { data: fbPages = [] } = useQuery<FacebookPage[]>({
    queryKey: ['facebook-pages'],
    queryFn: () => facebookPagesApi.list(),
  })

  // All character images, original FIRST, then swapped media + raw scenes (deduped).
  const gallery = useMemo(() => {
    const urls: string[] = []
    if (character.source_image_url) urls.push(character.source_image_url)
    for (const m of [...character.media, ...character.scenes]) if (m?.url) urls.push(m.url)
    return urls.filter((u, i, arr) => arr.indexOf(u) === i)
  }, [character])

  // Picking an image assigns it to the active slot and opens the crop tool.
  function pick(url: string) {
    setError('')
    setCropEditing({ slot: assign, src: url })
  }

  function onCropDone(rect: CropRect) {
    if (!cropEditing) return
    if (cropEditing.slot === 'avatar') setAvatar({ url: cropEditing.src, crop: rect })
    else setCover({ url: cropEditing.src, crop: rect })
    setCropEditing(null)
  }

  async function handleApply() {
    if (!fbPageId) { setError('Hãy chọn Facebook Page.'); return }
    if (!avatar && !cover) { setError('Hãy chọn ảnh đại diện hoặc ảnh bìa.'); return }
    setError('')
    setLoading(true)
    try {
      const { results } = await charactersApi.changePageImage({
        fb_page_id: fbPageId,
        avatar_url: avatar?.url,
        avatar_crop: avatar?.crop,
        cover_url: cover?.url,
        cover_crop: cover?.crop,
      })
      const ok: string[] = []
      const err: string[] = []
      if (results.avatar) (results.avatar.ok ? ok.push('ảnh đại diện') : err.push(`ảnh đại diện: ${results.avatar.error || 'lỗi'}`))
      if (results.cover) (results.cover.ok ? ok.push('ảnh bìa') : err.push(`ảnh bìa: ${results.cover.error || 'lỗi'}`))
      if (ok.length) showToast(`Đã đổi ${ok.join(' + ')}.`, 'success')
      if (err.length) { setError(err.join(' • ')); showToast(err.join(' • '), 'error') }
      if (ok.length && !err.length) onClose()
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Đổi ảnh thất bại.'
      setError(m); showToast(m, 'error')
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
            <h2 className="text-base font-semibold">Đổi ảnh đại diện / ảnh bìa Page</h2>
            <p className="mt-1 text-xs text-muted-foreground">Chọn ảnh của “{character.name || 'nhân vật'}”, căn khung rồi áp dụng cho 1 Facebook Page.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 overflow-auto p-5">
          {/* Page selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Facebook Page</label>
            <select
              value={fbPageId ?? ''}
              onChange={(e) => { setError(''); setFbPageId(e.target.value ? Number(e.target.value) : null) }}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">— Chọn Page —</option>
              {fbPages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <p className="text-[11px] text-muted-foreground">Cần page token có quyền đổi ảnh (avatar: pages_read_engagement + pages_show_list; ảnh bìa: pages_manage_metadata).</p>
          </div>

          {/* Selected slots (framed preview) */}
          <div className="grid grid-cols-2 gap-3">
            <Slot label="Ảnh đại diện" icon={<UserRound className="size-4" />} item={avatar} aspect={AVATAR_ASPECT} active={assign === 'avatar'} onActivate={() => setAssign('avatar')} onClear={() => setAvatar(null)} onEdit={() => avatar && setCropEditing({ slot: 'avatar', src: avatar.url })} />
            <Slot label="Ảnh bìa" icon={<ImageIcon className="size-4" />} item={cover} aspect={COVER_ASPECT} active={assign === 'cover'} onActivate={() => setAssign('cover')} onClear={() => setCover(null)} onEdit={() => cover && setCropEditing({ slot: 'cover', src: cover.url })} />
          </div>

          {/* Gallery */}
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-1.5 text-sm font-medium">
              <Images className="size-4" /> Ảnh của nhân vật — bấm để gán cho <b>{assign === 'avatar' ? 'ảnh đại diện' : 'ảnh bìa'}</b>
            </label>
            {gallery.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nhân vật chưa có ảnh nào.</p>
            ) : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                {gallery.map((url, i) => {
                  const used = avatar?.url === url || cover?.url === url
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => pick(url)}
                      className={`relative aspect-square overflow-hidden rounded-lg border-2 transition ${used ? 'border-primary' : 'border-transparent hover:border-border'}`}
                    >
                      <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
                    </button>
                  )
                })}
              </div>
            )}
            {character.source_image_url && <p className="text-[11px] text-muted-foreground">Ảnh đầu tiên là ảnh nhân vật gốc.</p>}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={onClose}>Hủy</Button>
          <Button onClick={handleApply} disabled={loading} className="gap-1.5">
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <UserRound className="size-3.5" />}
            Áp dụng
          </Button>
        </div>
      </div>

      {cropEditing && (
        <ImageCropper
          src={cropEditing.src}
          aspect={cropEditing.slot === 'avatar' ? AVATAR_ASPECT : COVER_ASPECT}
          title={cropEditing.slot === 'avatar' ? 'Căn khung ảnh đại diện' : 'Căn khung ảnh bìa'}
          onCancel={() => setCropEditing(null)}
          onConfirm={onCropDone}
        />
      )}
    </div>
  )
}

function Slot({ label, icon, item, aspect, active, onActivate, onClear, onEdit }: {
  label: string
  icon: React.ReactNode
  item: { url: string; crop: CropRect } | null
  aspect: number
  active: boolean
  onActivate: () => void
  onClear: () => void
  onEdit: () => void
}) {
  // Render the cropped region by scaling the image so the crop fills the box.
  const bg = item
    ? {
        backgroundImage: `url("${item.url}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${100 / item.crop.w}% ${100 / item.crop.h}%`,
        backgroundPosition: `${item.crop.w < 1 ? (item.crop.x / (1 - item.crop.w)) * 100 : 0}% ${item.crop.h < 1 ? (item.crop.y / (1 - item.crop.h)) * 100 : 0}%`,
      }
    : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onActivate}
        className={`flex items-center gap-1.5 self-start rounded-md border px-2 py-1 text-xs font-medium transition ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}
      >
        {icon} {label}
      </button>
      <div className="relative w-full overflow-hidden rounded-lg border border-border bg-muted/30" style={{ aspectRatio: String(aspect) }}>
        {item ? (
          <>
            <div className="absolute inset-0" style={bg} />
            <div className="absolute right-1.5 top-1.5 flex gap-1">
              <button type="button" onClick={onEdit} title="Căn lại khung" className="rounded-full bg-black/60 p-1 text-white hover:bg-black/80"><Crop className="size-3" /></button>
              <button type="button" onClick={onClear} title="Bỏ" className="rounded-full bg-black/60 p-1 text-white hover:bg-black/80"><X className="size-3" /></button>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Chưa chọn</div>
        )}
      </div>
    </div>
  )
}
