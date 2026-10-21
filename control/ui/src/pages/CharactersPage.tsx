import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { BarChart3, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, EyeOff, ImageOff, Loader2, Maximize2, Palette, Pencil, Plus, Send, Sparkles, Trash2, UserRound, Video, Wand2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { charactersApi, contentsApi } from '@/lib/api'
import type { Character, PaginatedResponse } from '@/lib/types'
import FaceSwapWizardLegacy from '@/components/FaceSwapWizardLegacy'
import { FilterPicker } from '@/components/FilterPicker'
import { compressForUpload } from '@/lib/image'
import PostPhotosModal from '@/components/PostPhotosModal'
import ChangeAvatarModal from '@/components/ChangeAvatarModal'
import CreateVideoModal from '@/components/CreateVideoModal'
import PostVideoModal from '@/components/PostVideoModal'
import CharacterScheduledPosts from '@/components/CharacterScheduledPosts'
import CanvaEditorModal from '@/components/CanvaEditorModal'

// Real extension of a media URL (path only, query stripped). Character media is
// sanitised to JPEG server-side, so most images are `.jpg` even though the UI
// used to hardcode `.png`. Falls back to `jpg` when the URL has no extension.
function extFromUrl(url: string, fallback = 'jpg'): string {
  const path = url.split('?')[0].split('#')[0]
  const m = path.match(/\.([a-z0-9]{2,4})$/i)
  return m ? m[1].toLowerCase() : fallback
}

// Force a real file download instead of opening the image in a new tab. The
// media lives on Cloudfly (cross-origin presigned URLs, no CORS → a client-side
// fetch is blocked) or SeaweedFS (public, inline by default). The backend
// `download-url` endpoint returns a navigable URL with
// `Content-Disposition: attachment`, so navigating to it downloads the file and
// keeps the page — no CORS, correct extension. `baseName` must NOT include an
// extension; the real one is derived from the URL.
async function downloadFile(url: string, baseName: string) {
  const filename = `${baseName}.${extFromUrl(url)}`
  try {
    const { url: dl } = await contentsApi.downloadUrl(url, filename)
    const a = document.createElement('a')
    a.href = dl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch {
    window.open(url, '_blank', 'noreferrer')
  }
}

// Facebook never enlarges a photo past its native resolution, so a 1024px-wide
// image is shown small in the lightbox no matter how big the screen is — that is
// what users meant by "đăng lên Facebook không full màn hình". ~2048 on the long
// edge fills it. gpt-image tops out at 1536, so anything straight from the model
// is below the bar and has to be upscaled on the way out.
const FB_MIN_LONG_EDGE = 2048
// Matches content.views.MEDIA_MAX_EDGE — the server clamps stored media to this,
// so never promise the user a number the save would not keep.
const MEDIA_MAX_EDGE = 4096

/** Natural size of an image URL. Cross-origin is fine: dimensions are readable
 *  without CORS (only pixel data is tainted), which matters because the media
 *  lives on presigned Cloudfly URLs that send no CORS headers. */
function imageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight })
    im.onerror = () => reject(new Error('không đọc được ảnh'))
    im.src = url
  })
}

/** Push a data URI to disk as a real file. Routed through a Blob because a
 *  multi-megabyte `data:` in `a.href` is refused or truncated by some browsers. */
function downloadDataUri(dataUri: string, filename: string) {
  const [head, b64] = dataUri.split(',', 2)
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'image/jpeg'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  const href = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(href)
}

export default function CharactersPage() {
  const { t } = useTranslation()
  const { showToast } = useToast()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const PAGE_SIZE = 10
  const [page, setPage] = useState(1)
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Character | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  // Post-photos / create-video modals (per character).
  const [postTarget, setPostTarget] = useState<Character | null>(null)
  const [avatarTarget, setAvatarTarget] = useState<Character | null>(null)
  const [videoTarget, setVideoTarget] = useState<Character | null>(null)
  // "Thêm ảnh": mở menu chọn giữa Tạo ảnh nhanh (QuickImage) và luồng cũ (sinh cảnh).
  const [addChoiceTarget, setAddChoiceTarget] = useState<Character | null>(null)
  // Luồng cũ ở chế độ "thêm cảnh cho nhân vật có sẵn" (FaceSwapWizardLegacy + targetCharacter).
  const [legacyTarget, setLegacyTarget] = useState<Character | null>(null)
  const [postVideoUrl, setPostVideoUrl] = useState<string | null>(null)
  // id of the character currently being renamed (in the grid card OR the
  // detail panel — both share this single inline-edit state).
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  // When set, the colour-filter picker opens for a saved image (passed as its
  // presigned URL). Applying saves the filtered result as a NEW item in the same
  // store (media or scenes), keeping the original. characterId/kind tell the save
  // which character + store to append to.
  const [filterMedia, setFilterMedia] = useState<
    { characterId: number; url: string; kind: 'media' | 'scenes' } | null
  >(null)
  const [filterSaving, setFilterSaving] = useState(false)
  // When set, the full-screen image editor (canva-clone iframe) opens for this URL.
  const [editImageUrl, setEditImageUrl] = useState<string | null>(null)
  // Lightbox — URL of the image currently zoomed full-screen (Esc / click nền để đóng).
  const [zoomImageUrl, setZoomImageUrl] = useState<string | null>(null)
  // URL of the media/scene image currently being hidden (disables its button).
  const [hidingUrl, setHidingUrl] = useState<string | null>(null)
  // URL of the image currently being upscaled (disables its button + shows a spinner).
  const [upscalingUrl, setUpscalingUrl] = useState<string | null>(null)
  // Same idea for the download button: it now upscales first, which takes seconds.
  const [downloadingUrl, setDownloadingUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!zoomImageUrl) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomImageUrl(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomImageUrl])

  // Hide (soft, not delete) a single media/scene image: it disappears from the
  // gallery and from post-image pickers but stays in the DB. Mirrors the
  // filter-save flow: hit the API, invalidate the list, refresh the open panel.
  async function hideMediaImage(characterId: number, url: string, kind: 'media' | 'scenes') {
    if (hidingUrl) return
    setHidingUrl(url)
    try {
      const updated = await charactersApi.hideMedia(characterId, { url, kind, hidden: true })
      qc.invalidateQueries({ queryKey: ['characters'] })
      setSelected((prev) => (prev && prev.id === updated.id ? updated : prev))
      showToast(t('characters.mediaHidden'), 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : t('characters.hideFailed')
      showToast(message, 'error')
    } finally {
      setHidingUrl(null)
    }
  }

  // Enlarge one saved image 2x and store the result as a NEW item, keeping the
  // original — same shape as the filter-save flow, and non-destructive for the
  // same reason: the upscale is a judgement call, so the user must be able to
  // fall back to what they had.
  //
  // Only helps images that are genuinely small: scenes generated before the
  // 1024x1536 fix are 1024x1024, and anything the user imported from Pinterest
  // is ~736px. It cannot invent detail that was never captured — a 388px
  // thumbnail comes back sharp but waxy — so this is a rescue tool for old
  // images, not something to run over everything.
  async function upscaleMediaImage(characterId: number, url: string, kind: 'media' | 'scenes') {
    if (upscalingUrl) return
    setUpscalingUrl(url)
    try {
      const { image, width, height } = await contentsApi.upscale(url, 2)
      // Ảnh 2x là PNG rất nặng (2048x3072 ≈ 6 MB, thành ~8 MB khi bọc base64) mà
      // file cuối trong kho vẫn là JPEG q95 — nén ở đây trước khi gửi giúp lượt
      // lưu nhẹ đi khoảng 5 lần, sai khác đo được 0,25% (xem lib/image.ts).
      const body = await compressForUpload(image)
      const payload = kind === 'scenes' ? { scenes: [body] } : { media: [body] }
      const updated = await charactersApi.addMedia(characterId, payload)
      qc.invalidateQueries({ queryKey: ['characters'] })
      setSelected((prev) => (prev && prev.id === updated.id ? updated : prev))
      // Report what was SAVED, not what the GPU returned: the server clamps the long
      // edge to MEDIA_MAX_EDGE, and the old message quoted the pre-save number — which
      // is how "đã làm nét → 2048×3072" ended up on top of a file stored at 1066×1600.
      const k = Math.min(1, MEDIA_MAX_EDGE / Math.max(width, height))
      showToast(
        `Đã làm nét → ${Math.round(width * k)}×${Math.round(height * k)}, lưu thành ảnh mới.`,
        'success',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Làm nét ảnh thất bại.'
      showToast(message, 'error')
    } finally {
      setUpscalingUrl(null)
    }
  }

  // Download an image at a size Facebook will actually show full-size. Anything below
  // FB_MIN_LONG_EDGE is run through the upscaler on the way out, so the user never has
  // to remember to press "Làm nét" first — that was the reported complaint (downloaded
  // image looks broken, and the post does not fill the screen).
  //
  // The upscale is best-effort: the GPU box is a separate machine and has been flaky,
  // so if it is down or refuses, the original still downloads with a warning rather
  // than the button doing nothing at all.
  async function downloadImage(url: string, baseName: string) {
    if (downloadingUrl) return
    setDownloadingUrl(url)
    try {
      let size: { w: number; h: number } | null = null
      try {
        size = await imageSize(url)
      } catch {
        size = null   // unreadable → fall through to a plain download
      }
      const long = size ? Math.max(size.w, size.h) : 0
      if (long >= FB_MIN_LONG_EDGE || long === 0) {
        await downloadFile(url, baseName)
        return
      }
      // scale is an integer 1..4 server-side; pick the smallest that clears the bar.
      const scale = Math.min(4, Math.max(2, Math.ceil(FB_MIN_LONG_EDGE / long)))
      try {
        const { image, width, height } = await contentsApi.upscale(url, scale)
        downloadDataUri(image, `${baseName}-${width}x${height}.jpg`)
        showToast(`Đã làm nét khi tải: ${long}px → ${Math.max(width, height)}px.`, 'success')
      } catch {
        await downloadFile(url, baseName)
        showToast(
          `Không làm nét được (máy GPU bận hoặc lỗi). Đã tải ảnh gốc ${long}px — `
          + 'Facebook sẽ hiện nhỏ. Thử lại sau để có bản nét.',
          'error',
        )
      }
    } finally {
      setDownloadingUrl(null)
    }
  }

  // Save a filtered image as a new item in its store (media/scenes), keeps original.
  async function saveFilteredMedia(dataUri: string) {
    if (!filterMedia) return
    setFilterSaving(true)
    try {
      // Ảnh sau filter đã là JPEG nên compressForUpload thường trả lại nguyên nó;
      // nó chỉ ra tay khi ảnh là PNG hoặc vượt 4096px (vd đã làm nét trước đó).
      const body = await compressForUpload(dataUri)
      const payload = filterMedia.kind === 'scenes' ? { scenes: [body] } : { media: [body] }
      const updated = await charactersApi.addMedia(filterMedia.characterId, payload)
      qc.invalidateQueries({ queryKey: ['characters'] })
      // Refresh the open detail panel so the new image shows immediately.
      setSelected((prev) => (prev && prev.id === updated.id ? updated : prev))
      showToast(t('characters.filterSaved'), 'success')
      setFilterMedia(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : t('characters.filterSaveFailed')
      showToast(message, 'error')
    } finally {
      setFilterSaving(false)
    }
  }

  const { data: characterPage, isLoading, isError } = useQuery<PaginatedResponse<Character>>({
    queryKey: ['characters', page, search],
    queryFn: () => charactersApi.list({ page, page_size: PAGE_SIZE, search }),
  })
  const characters = Array.isArray(characterPage)
    ? characterPage
    : characterPage?.results ?? []
  const totalCount = Array.isArray(characterPage)
    ? characterPage.length
    : characterPage?.count ?? characters.length
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)

  useEffect(() => {
    if (!isLoading && page > totalPages) {
      setPage(totalPages)
    }
  }, [isLoading, page, totalPages])

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setSearch(searchText.trim())
      setPage(1)
    }, 250)
    return () => window.clearTimeout(handle)
  }, [searchText])

  // Today's image-generation usage for the current account.
  const { data: usage } = useQuery({
    queryKey: ['image-usage', 'today'],
    queryFn: () => contentsApi.imageUsage(),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => charactersApi.destroy(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['characters'] })
      showToast(t('characters.deleted'), 'success')
      setSelected(null)
    },
    onError: () => showToast(t('characters.deleteFailed'), 'error'),
  })

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => charactersApi.update(id, { name }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['characters'] })
      // keep the open panel (if any) in sync with the new name
      setSelected((cur) => (cur && cur.id === updated.id ? updated : cur))
      setEditingId(null)
      showToast(t('characters.renamed'), 'success')
    },
    onError: () => showToast(t('characters.renameFailed'), 'error'),
  })

  function startRename(char: Character) {
    setEditName(char.name)
    setEditingId(char.id)
  }

  function submitRename(char: Character) {
    const name = editName.trim()
    if (!name || name === char.name) { setEditingId(null); return }
    renameMutation.mutate({ id: char.id, name })
  }

  return (
    <div className="flex min-h-full flex-col gap-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('characters.title')}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('characters.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-64 max-w-[50vw]">
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder={t('characters.searchPlaceholder')}
              className="h-9 w-full rounded-lg border border-border bg-background px-3 pr-8 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            {searchText && (
              <button
                type="button"
                onClick={() => setSearchText('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('common.close')}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          {/* Nút CHÍNH tạo nhân vật giờ là luồng "Tạo ảnh nhanh" (QuickImage). */}
          <button
            type="button"
            onClick={() => navigate('/characters/quick')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Sparkles className="size-3.5" />
            Tạo nhân vật mới
          </button>
          {/* Wizard cũ không còn tạo nhân vật — chỉ còn là công cụ Chỉnh sửa / Media /
              Pinterest / Ghép mặt (tab tạo-nhân-vật đã bỏ ở G4). */}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="size-3.5" />
            Chỉnh sửa &amp; Media
          </button>
        </div>
      </div>

      {/* Image-generation usage for this account (today + this month) */}
      {usage && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <BarChart3 className="size-4 text-muted-foreground" />
            {t('characters.usageToday')}
          </span>
          <span className="text-muted-foreground">
            {t('characters.usageCalls')}: <span className="font-semibold text-foreground">{usage.calls}</span>
          </span>
          <span className="text-muted-foreground">
            {t('characters.usageImages')}: <span className="font-semibold text-foreground">{usage.images}</span>
          </span>
          <span className="h-4 w-px bg-border" aria-hidden />
          <span className="font-medium">{t('characters.usageMonth')}</span>
          <span className="text-muted-foreground">
            {t('characters.usageCalls')}: <span className="font-semibold text-foreground">{usage.month_calls}</span>
          </span>
          <span className="text-muted-foreground">
            {t('characters.usageImages')}: <span className="font-semibold text-foreground">{usage.month_images}</span>
          </span>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Error state — surface API failures instead of masquerading as empty */}
      {!isLoading && isError && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-destructive">
          <ImageOff className="size-10 opacity-40" />
          <p className="text-sm">{t('characters.loadError')}</p>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && characters.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <ImageOff className="size-10 opacity-40" />
          <p className="text-sm">{search ? t('characters.searchEmpty') : t('characters.empty')}</p>
          <button
            type="button"
            onClick={() => navigate('/characters/quick')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="size-3.5" />
            Tạo nhân vật mới
          </button>
        </div>
      )}

      {/* Grid */}
      {!isLoading && !isError && characters.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {characters.map((char) => {
              const isEditing = editingId === char.id
              const openDetail = () => { setSelected(char); setEditingId(null) }
              return (
                <div
                  key={char.id}
                  className="group relative flex flex-col gap-2 rounded-xl border border-border bg-card p-3 transition-colors hover:border-primary/50 hover:bg-muted/50"
                >
                {/* Rename — hover-revealed pencil, top-right */}
                {!isEditing && (
                  <button
                    type="button"
                    onClick={() => startRename(char)}
                    className="absolute right-2 top-2 z-10 rounded-md border border-border bg-background/90 p-1 text-muted-foreground opacity-60 shadow-sm transition hover:text-foreground group-hover:opacity-100"
                    aria-label={t('characters.rename')}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                )}

                {/* Thumbnail → open detail. Khung 3:4 chứ không vuông: ảnh nhân vật giờ
                    sinh khung dọc 1024x1536 (2:3), ô vuông cắt mất gần nửa khung hình. */}
                <button
                  type="button"
                  onClick={openDetail}
                  className="aspect-[3/4] w-full overflow-hidden rounded-lg bg-muted/40"
                >
                  {char.source_image_url ? (
                    <img
                      src={char.source_image_url}
                      alt={char.name}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <ImageOff className="size-6 text-muted-foreground/40" />
                    </div>
                  )}
                </button>

                {/* Name → inline rename or click-to-open */}
                {isEditing ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename(char)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 text-sm font-medium outline-none focus:ring-2 focus:ring-ring"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => submitRename(char)}
                      disabled={renameMutation.isPending || !editName.trim()}
                      className="shrink-0 rounded-md border border-border p-1 hover:bg-muted disabled:opacity-40"
                    >
                      {renameMutation.isPending
                        ? <Loader2 className="size-3.5 animate-spin" />
                        : <Check className="size-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="shrink-0 rounded-md border border-border p-1 hover:bg-muted"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={openDetail} className="text-left">
                    <p className={`truncate text-sm font-medium ${char.name ? '' : 'italic text-muted-foreground'}`}>
                      {char.name || t('characters.unnamed')}
                    </p>
                  </button>
                )}

                {/* Meta → open detail */}
                <button type="button" onClick={openDetail} className="flex flex-col gap-2 text-left">
                  <p className="text-xs text-muted-foreground">
                    {t('characters.mediaCount', { count: char.media_count + char.scenes_count })}
                  </p>
                  {(char.media.length + char.scenes.length) > 0 && (
                    <div className="flex gap-1 overflow-hidden">
                      {[...char.media, ...char.scenes].slice(0, 3).map((m, i) => (
                        <img
                          key={i}
                          src={m.url}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="size-8 rounded object-cover"
                        />
                      ))}
                      {(char.media.length + char.scenes.length) > 3 && (
                        <div className="flex size-8 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                          +{char.media.length + char.scenes.length - 3}
                        </div>
                      )}
                    </div>
                  )}
                </button>

                {/* Per-character actions */}
                <div className="mt-1 grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setAddChoiceTarget(char)}
                    title={t('characters.addImages')}
                    className="flex flex-col items-center gap-0.5 rounded-md border border-border px-1 py-1.5 text-[11px] font-medium hover:bg-muted"
                  >
                    <Plus className="size-4 shrink-0" />
                    <span className="w-full truncate text-center">Thêm ảnh</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPostTarget(char)}
                    title="Đăng bài"
                    className="flex flex-col items-center gap-0.5 rounded-md border border-border px-1 py-1.5 text-[11px] font-medium hover:bg-muted"
                  >
                    <Send className="size-4 shrink-0" />
                    <span className="w-full truncate text-center">Đăng bài</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setVideoTarget(char)}
                    title="Tạo video"
                    className="flex flex-col items-center gap-0.5 rounded-md border border-border px-1 py-1.5 text-[11px] font-medium hover:bg-muted"
                  >
                    <Video className="size-4 shrink-0" />
                    <span className="w-full truncate text-center">Tạo video</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAvatarTarget(char)}
                    title="Đổi ảnh đại diện / ảnh bìa Facebook Page"
                    className="flex flex-col items-center gap-0.5 rounded-md border border-border px-1 py-1.5 text-[11px] font-medium hover:bg-muted"
                  >
                    <UserRound className="size-4 shrink-0" />
                    <span className="w-full truncate text-center">Đổi Avatar</span>
                  </button>
                </div>
                </div>
              )
            })}
          </div>

          {characters.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {t('characters.paginationRange', {
                  from: totalCount === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1,
                  to: Math.min(safePage * PAGE_SIZE, totalCount),
                  total: totalCount,
                })}
              </span>

              <div className="flex items-center gap-1">
                <span className="mr-2 text-muted-foreground">
                  {t('characters.paginationPageOf', { page: safePage, total: totalPages })}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(1)}
                  disabled={safePage === 1}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background transition-colors hover:bg-muted disabled:opacity-40"
                >
                  <ChevronsLeft className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background transition-colors hover:bg-muted disabled:opacity-40"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background transition-colors hover:bg-muted disabled:opacity-40"
                >
                  <ChevronRight className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setPage(totalPages)}
                  disabled={safePage >= totalPages}
                  className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background transition-colors hover:bg-muted disabled:opacity-40"
                >
                  <ChevronsRight className="size-3.5" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Detail panel */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/40 sm:items-center sm:justify-center">
          <div className="flex h-[90vh] w-full max-w-3xl flex-col rounded-t-2xl bg-background sm:rounded-2xl sm:shadow-2xl">
            {/* Panel header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="min-w-0 flex-1">
                {editingId === selected.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename(selected)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      className="w-full max-w-xs rounded-md border border-border bg-background px-2 py-1 text-sm font-semibold outline-none focus:ring-2 focus:ring-ring"
                      autoFocus
                    />
                    <Button
                      size="sm"
                      onClick={() => submitRename(selected)}
                      disabled={renameMutation.isPending || !editName.trim()}
                    >
                      {renameMutation.isPending
                        ? <Loader2 className="size-3.5 animate-spin" />
                        : <Check className="size-3.5" />}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded-lg p-1.5 hover:bg-muted"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2 className={`truncate font-semibold ${selected.name ? '' : 'italic text-muted-foreground'}`}>
                      {selected.name || t('characters.unnamed')}
                    </h2>
                    <button
                      type="button"
                      onClick={() => startRename(selected)}
                      className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={t('characters.rename')}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {t('characters.mediaCount', { count: selected.media_count + selected.scenes_count })}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setPostTarget(selected)}>
                  <Send className="size-3.5" />
                  Đăng bài
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAvatarTarget(selected)}>
                  <UserRound className="size-3.5" />
                  Đổi Avatar
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setVideoTarget(selected)}>
                  <Video className="size-3.5" />
                  Tạo video
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-destructive hover:bg-destructive/10"
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    if (confirm(t('characters.confirmDelete', { name: selected.name }))) {
                      deleteMutation.mutate(selected.id)
                    }
                  }}
                >
                  {deleteMutation.isPending
                    ? <Loader2 className="size-3.5 animate-spin" />
                    : <Trash2 className="size-3.5" />}
                  {t('characters.delete')}
                </Button>
                <button
                  type="button"
                  onClick={() => { setSelected(null); setEditingId(null) }}
                  className="rounded-lg p-1.5 hover:bg-muted"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Panel body */}
            <div className="flex-1 overflow-y-auto p-5">
              {/* Source image */}
              <p className="mb-2 text-sm font-medium">{t('characters.sourceImage')}</p>
              {selected.source_image_url ? (
                <div className="mb-5 flex flex-col gap-1.5">
                  <img
                    src={selected.source_image_url}
                    alt={selected.name}
                    decoding="async"
                    onClick={() => setZoomImageUrl(selected.source_image_url!)}
                    className="h-80 w-full cursor-zoom-in rounded-xl border border-border bg-muted/30 object-contain"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setZoomImageUrl(selected.source_image_url!)}
                      className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                    >
                      <Maximize2 className="size-3.5" />
                      {t('characters.zoom')}
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadImage(selected.source_image_url!, `${selected.name}-source`)}
                      disabled={downloadingUrl !== null}
                      className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                    >
                      {downloadingUrl === selected.source_image_url ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                      {t('characters.download')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setFilterMedia({ characterId: selected.id, url: selected.source_image_url!, kind: 'media' })}
                      className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                    >
                      <Palette className="size-3.5" />
                      {t('characters.filter')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditImageUrl(selected.source_image_url)}
                      title={t('characters.edit')}
                      className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                    >
                      <Pencil className="size-3.5" />
                      {t('characters.edit')}
                    </button>
                    {/* Kết quả vào kho `media` chứ KHÔNG ghi đè source_image_url: ảnh gốc
                        là ảnh khoá mặt cho mọi lần sinh cảnh sau này, đổi nó đi là đổi
                        luôn nhân vật của mọi ảnh về sau. Nút "Chọn filter màu" ngay bên
                        cạnh cũng lưu vào `media` vì đúng lý do đó. */}
                    <button
                      type="button"
                      onClick={() => upscaleMediaImage(selected.id, selected.source_image_url!, 'media')}
                      disabled={upscalingUrl !== null}
                      title="Làm nét (phóng to 2×) — lưu thành ảnh mới trong Media, giữ nguyên ảnh gốc"
                      className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                    >
                      {upscalingUrl === selected.source_image_url
                        ? <Loader2 className="size-3.5 animate-spin" />
                        : <Wand2 className="size-3.5" />}
                      Làm nét
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mb-5 flex h-24 items-center justify-center rounded-xl bg-muted/30 text-muted-foreground">
                  <ImageOff className="size-6 opacity-40" />
                </div>
              )}

              {/* Media gallery. Ô 2:3 (đúng khung dọc 1024x1536 của ảnh sinh ra từ 07/09):
                  ô vuông + object-contain trước đây chỉ cho ảnh dọc rộng 2/3 ô — ảnh trông nhỏ
                  hẳn đi. Ảnh vuông cũ vẫn hiện đủ, chỉ có thêm dải trống trên/dưới. */}
              {selected.media.length > 0 && (
                <>
                  <p className="mb-2 text-sm font-medium">{t('characters.allMedia')}</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {selected.media.map((m, i) => (
                      <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
                        <img
                          src={m.url}
                          alt={`media-${i + 1}`}
                          loading="lazy"
                          decoding="async"
                          onClick={() => setZoomImageUrl(m.url)}
                          className="aspect-[2/3] w-full cursor-zoom-in rounded-md bg-muted/30 object-contain"
                        />
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => setZoomImageUrl(m.url)}
                            title={t('characters.zoom')}
                            className="inline-flex items-center justify-center rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            <Maximize2 className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadImage(m.url, `${selected.name}-${i + 1}`)}
                            disabled={downloadingUrl !== null}
                            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                          >
                            {downloadingUrl === m.url ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                            {t('characters.download')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setFilterMedia({ characterId: selected.id, url: m.url, kind: 'media' })}
                            title={t('characters.filter')}
                            className="inline-flex items-center justify-center rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            <Palette className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditImageUrl(m.url)}
                            title={t('characters.edit')}
                            className="inline-flex items-center justify-center rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => upscaleMediaImage(selected.id, m.url, 'media')}
                            disabled={upscalingUrl !== null}
                            title="Làm nét (phóng to 2×) — lưu thành ảnh mới, giữ ảnh gốc"
                            className="inline-flex items-center justify-center rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                          >
                            {upscalingUrl === m.url
                              ? <Loader2 className="size-3.5 animate-spin" />
                              : <Wand2 className="size-3.5" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => hideMediaImage(selected.id, m.url, 'media')}
                            disabled={hidingUrl === m.url}
                            title={t('characters.hide')}
                            className="inline-flex items-center justify-center rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                          >
                            {hidingUrl === m.url ? <Loader2 className="size-3.5 animate-spin" /> : <EyeOff className="size-3.5" />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Scenes — separate store of the raw AI-generated scenes (pre-swap) */}
              {selected.scenes.length > 0 && (
                <>
                  <p className="mb-2 mt-6 text-sm font-medium">{t('characters.scenes')}</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {selected.scenes.map((m, i) => (
                      <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
                        <img
                          src={m.url}
                          alt={`scene-${i + 1}`}
                          loading="lazy"
                          decoding="async"
                          onClick={() => setZoomImageUrl(m.url)}
                          className="aspect-[2/3] w-full cursor-zoom-in rounded-md bg-muted/30 object-contain"
                        />
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => setZoomImageUrl(m.url)}
                            title={t('characters.zoom')}
                            className="inline-flex items-center justify-center rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            <Maximize2 className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadImage(m.url, `${selected.name}-scene-${i + 1}`)}
                            disabled={downloadingUrl !== null}
                            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                          >
                            {downloadingUrl === m.url ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                            {t('characters.download')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setFilterMedia({ characterId: selected.id, url: m.url, kind: 'scenes' })}
                            title={t('characters.filter')}
                            className="inline-flex items-center justify-center rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            <Palette className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditImageUrl(m.url)}
                            title={t('characters.edit')}
                            className="inline-flex items-center justify-center rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => upscaleMediaImage(selected.id, m.url, 'scenes')}
                            disabled={upscalingUrl !== null}
                            title="Làm nét (phóng to 2×) — lưu thành ảnh mới, giữ ảnh gốc"
                            className="inline-flex items-center justify-center rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                          >
                            {upscalingUrl === m.url
                              ? <Loader2 className="size-3.5 animate-spin" />
                              : <Wand2 className="size-3.5" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => hideMediaImage(selected.id, m.url, 'scenes')}
                            disabled={hidingUrl === m.url}
                            title={t('characters.hide')}
                            className="inline-flex items-center justify-center rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                          >
                            {hidingUrl === m.url ? <Loader2 className="size-3.5 animate-spin" /> : <EyeOff className="size-3.5" />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Videos — generated videos saved to this character */}
              {selected.videos.length > 0 && (
                <>
                  <p className="mb-2 mt-6 text-sm font-medium">Video</p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {selected.videos.map((v, i) => (
                      <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
                        <video src={v.url} controls preload="metadata" className="w-full rounded-md bg-black" />
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => setPostVideoUrl(v.url)}
                            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            <Send className="size-3.5" />
                            Đăng lại
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadFile(v.url, `${selected.name}-video-${i + 1}`)}
                            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            <Download className="size-3.5" />
                            {t('characters.download')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Scheduled posts — queued auto-posts for this character */}
              <CharacterScheduledPosts characterId={selected.id} />
            </div>
          </div>
        </div>
      )}

      {/* Lightbox — hiển thị ảnh full-screen (click nền hoặc nút × để đóng, Esc cũng đóng). */}
      {zoomImageUrl && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setZoomImageUrl(null)}
        >
          <button
            type="button"
            onClick={() => setZoomImageUrl(null)}
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
          <img
            src={zoomImageUrl}
            alt=""
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
      )}

      {/* Full-screen image editor (canva-clone) for a single image. */}
      {editImageUrl && (
        <CanvaEditorModal
          imageUrl={editImageUrl}
          characterId={selected?.id}
          onClose={() => setEditImageUrl(null)}
          onSaved={(updated) => {
            qc.invalidateQueries({ queryKey: ['characters'] })
            setSelected((prev) => (prev && prev.id === updated.id ? updated : prev))
          }}
        />
      )}

      {/* Colour-filter picker — re-filter a saved media image, save as a new one. */}
      {filterMedia && (
        <FilterPicker
          image={filterMedia.url}
          applyLabel={t('characters.filterSave')}
          applyBusy={filterSaving}
          onApply={saveFilteredMedia}
          onClose={() => { if (!filterSaving) setFilterMedia(null) }}
        />
      )}

      {/* Face-swap wizard — create a new character */}
      {createOpen && (
        <FaceSwapWizardLegacy
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['characters'] })
            // Newest-first ordering — jump back to page 1 so the character the
            // user just saved is actually visible in the grid.
            setPage(1)
            setCreateOpen(false)
          }}
        />
      )}

      {/* "Thêm ảnh": chọn Tạo ảnh nhanh (QuickImage) HOẶC luồng cũ (sinh cảnh). */}
      {addChoiceTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setAddChoiceTarget(null)}
        >
          <div
            className="w-full max-w-xs rounded-xl border border-border bg-background p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-sm font-semibold">
              Thêm ảnh cho «{addChoiceTarget.name || '(chưa đặt tên)'}»
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">Chọn cách tạo ảnh cảnh:</p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  const id = addChoiceTarget.id
                  setAddChoiceTarget(null)
                  navigate(`/characters/quick?characterId=${id}`)
                }}
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
              >
                <Sparkles className="size-4 shrink-0" /> Tạo ảnh nhanh
              </button>
              <button
                type="button"
                onClick={() => { setLegacyTarget(addChoiceTarget); setAddChoiceTarget(null) }}
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
              >
                <Plus className="size-4 shrink-0" /> Luồng cũ (sinh cảnh)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Luồng cũ — thêm cảnh cho nhân vật có sẵn */}
      {legacyTarget && (
        <FaceSwapWizardLegacy
          targetCharacter={legacyTarget}
          onClose={() => setLegacyTarget(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['characters'] })
            setLegacyTarget(null)
          }}
        />
      )}

      {/* Post photos to TikTok */}
      {postTarget && (
        <PostPhotosModal character={postTarget} onClose={() => setPostTarget(null)} />
      )}
      {avatarTarget && (
        <ChangeAvatarModal character={avatarTarget} onClose={() => setAvatarTarget(null)} />
      )}

      {/* Create a video from the character's media */}
      {videoTarget && (
        <CreateVideoModal character={videoTarget} onClose={() => setVideoTarget(null)} />
      )}

      {/* Re-post a saved video to TikTok */}
      {postVideoUrl && (
        <PostVideoModal videoUrl={postVideoUrl} onClose={() => setPostVideoUrl(null)} />
      )}
    </div>
  )
}
