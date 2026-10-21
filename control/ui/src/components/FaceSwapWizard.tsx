/**
 * Self-contained face-swap wizard — all state, handlers, and UI in one place.
 * Renders as a fixed overlay; parent controls visibility by mounting/unmounting.
 *
 * Props:
 *   onClose  — called when user clicks "Đóng" or the × button
 *   onSaved  — called after a character is successfully saved to the server,
 *              so the parent can refresh its character list
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Bookmark,
  Check,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Shuffle,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { charactersApi, contentsApi } from '@/lib/api'
import type { Character } from '@/lib/types'
import { InpaintCanvas } from './InpaintCanvas'
import { FilterPicker } from './FilterPicker'
import FaceSwapPanel from './FaceSwapPanel'
import { IMPERFECT } from '@/lib/quickPrompt'

// ── Constants (mirror BE caps in content/views.py) ────────────────────────────
const MAX_FACE_SWAP_IMAGE_BYTES = 15 * 1024 * 1024
// Images are saved to the server in batches of this many per request — a single
// giant base64 POST (10–30MB for a full session) hits reverse-proxy body/time
// limits (413/504) and loses the entire save at once.
const SAVE_CHUNK_SIZE = 3
// Save chunks run concurrently (bounded) instead of one-at-a-time. Safe against
// lost updates because the backend add-media locks the row (select_for_update);
// most images now save by pre-uploaded URL so each request is a fast DB append.
const SAVE_CONCURRENCY = 4
const PEXELS_KEY = (import.meta as { env?: Record<string, string> }).env?.VITE_PEXELS_API_KEY || ''

// "Tạo Media" presets — non-person filler images (scenery, sky, animals,
// objects, food, cozy corners…) for a believable profile. Each item has a
// short Vietnamese button label + a detailed English image prompt. The prompt
// is rich on its own; handleGenerateMedia only appends a light "no people /
// no text" guard. Grouped loosely (nature → sky → animals → food → cozy/urban).
const MEDIA_PRESETS: { label: string; prompt: string }[] = [
  { label: 'Đồng cỏ', prompt: 'Endless green meadow under blue sky, gentle wind moving the grass, scattered wildflowers, natural daylight, realistic landscape photography, ultra detailed, peaceful atmosphere' },
  { label: 'Biển vắng', prompt: 'Quiet tropical beach at golden hour, calm turquoise water, soft waves on white sand, palm trees swaying, warm sunlight, realistic seascape photography, serene and relaxing mood' },
  { label: 'Núi sương mù', prompt: 'Layered mountain ranges wrapped in morning mist, soft fog drifting between peaks, cool blue tones, distant pine forest, atmospheric landscape photography, calm and majestic' },
  { label: 'Rừng thông', prompt: 'Sunlight streaming through a tall pine forest, light rays piercing the morning mist, soft green moss on the ground, fresh and tranquil atmosphere, realistic nature photography, ultra detailed' },
  { label: 'Thác nước', prompt: 'A powerful waterfall cascading into a clear emerald pool, lush green rainforest around, fine water mist in the air, long exposure smooth water, vivid realistic nature photography' },
  { label: 'Cánh đồng hoa', prompt: 'Vast field of blooming lavender stretching to the horizon, rolling purple rows under a soft sunset sky, gentle warm light, dreamy realistic landscape photography, peaceful countryside mood' },
  { label: 'Hoàng hôn', prompt: 'Dramatic sunset sky with orange, pink and purple gradients, soft clouds glowing, calm silhouette horizon, warm golden light, realistic sky photography, romantic peaceful atmosphere' },
  { label: 'Trời sao', prompt: 'Clear night sky full of stars, the Milky Way arching overhead, deep blue and violet tones, faint silhouette of distant hills, long exposure astrophotography, quiet and awe-inspiring mood' },
  { label: 'Cửa sổ mưa', prompt: 'Raindrops running down a window glass, blurred city lights bokeh in the background, cozy moody atmosphere, soft warm interior light, shallow depth of field, realistic photography' },
  { label: 'Mèo cưng', prompt: 'An adorable fluffy orange cat curled up sleeping on a soft blanket, warm window light, cozy home atmosphere, shallow depth of field, ultra detailed realistic pet photography' },
  { label: 'Chú cún', prompt: 'A happy golden retriever puppy sitting on green grass in a sunny park, tongue out, soft natural daylight, joyful mood, sharp detailed realistic pet photography' },
  { label: 'Chú chim', prompt: 'A small colorful bird perched on a blossoming branch, soft blurred garden background, gentle morning light, fine feather detail, realistic wildlife photography' },
  { label: 'Cà phê', prompt: 'A cup of hot latte with leaf latte art on a rustic wooden table, soft morning light through a window, cozy cafe atmosphere, steam rising, shallow depth of field, realistic food photography' },
  { label: 'Bữa sáng', prompt: 'A cozy brunch flat lay on a wooden table, pancakes with berries, fresh orange juice, coffee, soft natural daylight, warm inviting mood, top-down realistic food photography, ultra detailed' },
  { label: 'Trái cây', prompt: 'Fresh colorful fruits arranged on a marble countertop, strawberries, oranges, grapes and kiwi, water droplets, bright natural light, vivid realistic food photography' },
  { label: 'Góc đọc sách', prompt: 'A cozy reading corner with an open book, a lit candle and a warm cup of tea on a wooden table, soft warm lamplight, blanket and cushions, intimate calm atmosphere, realistic photography' },
  { label: 'Bàn làm việc', prompt: 'A minimalist tidy desk setup near a window, laptop, notebook, a small potted plant and a coffee mug, soft daylight, clean aesthetic, shallow depth of field, realistic lifestyle photography' },
  { label: 'Phố đêm', prompt: 'A rainy city street at night, glowing neon signs reflecting on wet asphalt, blurred car light trails, moody cinematic atmosphere, vibrant colors, realistic urban photography' },
  { label: 'Quán cafe', prompt: 'A charming corner cafe exterior with warm window lights, small outdoor tables, potted plants and string lights at dusk, cozy inviting street atmosphere, realistic photography' },
  { label: 'Bó hoa', prompt: 'A delicate bouquet of pastel roses and eucalyptus on a soft linen background, gentle natural light, dreamy soft focus, elegant minimalist composition, realistic still life photography' },
  { label: 'Lá thu', prompt: 'A path covered in golden autumn leaves under maple trees, warm amber and red tones, soft afternoon sunlight filtering through branches, nostalgic cozy atmosphere, realistic seasonal photography' },
  { label: 'Tuyết rơi', prompt: 'A quiet snowy village street at dusk, soft snowflakes falling, warm glowing windows, pine trees dusted with snow, cool blue and warm light contrast, peaceful winter atmosphere, realistic photography' },
]

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

// Downscale + re-encode an image File to a JPEG data URI whose longest edge is at
// most `maxEdge`, so a big phone photo (up to 15 MB) is shrunk in the browser
// before upload instead of shipping the full base64 over the wire. Falls back to
// the raw file (via fileToDataUri) if the canvas pipeline fails for any reason.
async function fileToDownscaledDataUri(file: File, maxEdge = 1600, quality = 0.85): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    if (scale >= 1) { bitmap.close(); return await fileToDataUri(file) }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) { bitmap.close(); return await fileToDataUri(file) }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return fileToDataUri(file)
  }
}

// Run async `worker` over `items` with at most `concurrency` promises in flight.
// Rejects on the first worker error (like the old sequential loop) — already-
// completed items stay done, so a retry resumes from the rest.
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  let firstError: unknown = null
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    // Stop pulling NEW items once any worker has failed. Runners swallow their
    // error into firstError instead of rejecting, so Promise.all only resolves
    // after every in-flight worker has settled — the caller can then clean up
    // (e.g. clear a progress bar) knowing no late worker will fire state after.
    while (cursor < items.length && firstError === null) {
      const item = items[cursor++]
      try {
        await worker(item)
      } catch (err) {
        if (firstError === null) firstError = err
      }
    }
  })
  await Promise.all(runners)
  if (firstError !== null) throw firstError
}

// ── Component ─────────────────────────────────────────────────────────────────
interface Props {
  onClose: () => void
  onSaved: () => void
  // When set, the wizard runs in "add more images" mode: it reuses this
  // character's source face and appends new media/scenes to it instead of
  // creating a new character.
  targetCharacter?: Character | null
}

export default function FaceSwapWizard({ onClose, onSaved, targetCharacter }: Props) {
  const { t } = useTranslation()
  const { showToast } = useToast()

  // Luồng 'prompt' (tạo nhân vật → cảnh) ĐÃ CHUYỂN sang trang "Tạo ảnh nhanh" (QuickImage).
  // Wizard này giờ chỉ còn là công cụ: Media / Ghép mặt / Pinterest / Chỉnh sửa. Mode 'prompt'
  // vẫn còn trong union + nhánh render (dead, không truy cập được) để không phải gỡ ~1000 dòng
  // đan xen ngay — sẽ dọn ở bước riêng. Mặc định mở tab Media.
  const [faceSwapMode, setFaceSwapMode] = useState<'prompt' | 'edit' | 'media' | 'pinterest' | 'faceswap'>('media')
  
  // Pinterest/Pexels integration states
  const [pinterestQuery, setPinterestQuery] = useState('')
  const [pinterestPhotos, setPinterestPhotos] = useState<any[]>([])
  const [pinterestLoading, setPinterestLoading] = useState(false)
  const [pinterestPage, setPinterestPage] = useState(1)
  const [hasMorePinterest, setHasMorePinterest] = useState(true)

  const [faceSwapSource, setFaceSwapSource] = useState<File | null>(null)
  const [faceSwapSourcePreview, setFaceSwapSourcePreview] = useState<string | null>(null)
  const [faceSwapSourceData, setFaceSwapSourceData] = useState<string | null>(null)
  const [faceSwapTargetPrompt, setFaceSwapTargetPrompt] = useState('')
  // Add-more mode: reuse the character's saved identity prompt so new scenes
  // keep the same person (and skip the generic fallback).
  const [faceSwapFacePrompt] = useState(targetCharacter?.face_prompt ?? '')
  // Rehydrate the saved character's country when adding scenes to it, so scene
  // localisation still knows where the person is from (append mode has no nation
  // input; without this the scenes would drift to a wrong/default country).
  const [faceNation] = useState(targetCharacter?.nation ?? '')
  const [faceSwapCharacterImage, setFaceSwapCharacterImage] = useState<string | null>(null)
  const [faceSwapSceneImages, setFaceSwapSceneImages] = useState<(string | null)[]>([null])
  // Open the colour-filter picker for a specific image. kind tells onApply where
  // to write the filtered result back (the character ref vs. a scene by index).
  const [filterTarget, setFilterTarget] = useState<
    { kind: 'character' } | { kind: 'scene'; index: number } | null
  >(null)
  const [faceSwapResults, setFaceSwapResults] = useState<string[]>([])
  const [faceSwapLoading, setFaceSwapLoading] = useState(false)
  const [faceSwapError, setFaceSwapError] = useState('')

  // Images the "Ghép mặt" tab can pick as source/target: the character built this
  // session (ref + scenes + results) plus, in add-more mode, the target character's
  // saved media. Deduped; empty for a brand-new character with nothing generated yet.
  const availableMedia = useMemo(() => {
    const urls: string[] = []
    if (faceSwapCharacterImage) urls.push(faceSwapCharacterImage)
    faceSwapSceneImages.forEach((u) => { if (u) urls.push(u) })
    faceSwapResults.forEach((u) => urls.push(u))
    if (targetCharacter) {
      if (targetCharacter.source_image_url) urls.push(targetCharacter.source_image_url)
      targetCharacter.media?.forEach((m) => { if (m.url) urls.push(m.url) })
      targetCharacter.scenes?.forEach((m) => { if (m.url) urls.push(m.url) })
    }
    return Array.from(new Set(urls.filter(Boolean)))
  }, [faceSwapCharacterImage, faceSwapSceneImages, faceSwapResults, targetCharacter])

  const [saveCharLoading, setSaveCharLoading] = useState(false)
  // Chunked-save progress ("Đang lưu 4/12 ảnh…") shown while persist() runs.
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null)
  const [loadingSource, setLoadingSource] = useState(false)
  const [savedSceneUrls, setSavedSceneUrls] = useState<Set<string>>(new Set())
  // "Tạo Media" tab: generate non-person images (nature, sky, animals, objects…)
  // with GPT and save them straight into the character's media.
  const [mediaPrompt, setMediaPrompt] = useState('')
  const [mediaGenerating, setMediaGenerating] = useState(false)
  const [mediaImages, setMediaImages] = useState<string[]>([])
  const [mediaCount, setMediaCount] = useState(2)
  const [savedMediaUrls, setSavedMediaUrls] = useState<Set<string>>(new Set())
  const [savingMedia, setSavingMedia] = useState<string | null>(null)
  // "Kho ảnh Pinterest" tab: upload a local file straight into the character's
  // media (converted client-side to a data URI, then saved the same way as any
  // other media image — the backend already accepts base64/data-URI payloads).
  const [uploadingLocalMedia, setUploadingLocalMedia] = useState(false)

  const qc = useQueryClient()
  const isAppend = !!targetCharacter
  // Scrollable modal body (holds every tab's content) — the IntersectionObserver
  // root for the Pexels tab's infinite scroll below, since this div (not the
  // window) is what actually scrolls inside the fixed-overlay wizard.
  const modalBodyRef = useRef<HTMLDivElement>(null)
  // Sentinel placed after the last Pexels photo row: once it enters view we fetch
  // the next page automatically, so the tab never needs a manual "Xem thêm" button.
  const pinterestSentinelRef = useRef<HTMLDivElement>(null)
  // Tracks whether the work has already been persisted (explicit save or a
  // previous auto-save) so closing doesn't create a duplicate.
  const savedRef = useRef(false)
  // The character this wizard session writes to: the target (add-more mode), or
  // a draft we create on the first per-scene/auto save (so everything lands on
  // ONE character instead of duplicating).
  const draftIdRef = useRef<number | null>(targetCharacter?.id ?? null)
  // In-flight draft-creation promise, shared by ALL save paths (persist,
  // handleSaveScene, handleSaveMedia). Without it, two saves that both see
  // draftIdRef.current === null before either resolves would each POST a create
  // and spawn TWO character rows. Reset to null on failure so a later save retries.
  const draftCreatePromiseRef = useRef<Promise<number> | null>(null)
  // Maps a generated image's data URI → the storage URL the backend pre-uploaded
  // it to. At save time we send the URL instead of the full base64 (the backend
  // passes an http URL straight through — no re-decode/re-upload), which is what
  // makes saving fast. Images without an entry (local uploads, edited results)
  // fall back to saving their base64 as before. See genImage() / saveRef().
  const genUrlMapRef = useRef<Map<string, string>>(new Map())


  // Wrapper around contentsApi.generateImage that records the data-URI → storage
  // URL mapping for every generated image, so saveRef() can later save by URL.
  async function genImage(prompt: string, referenceImage?: string | string[], noFallback?: boolean, explainErrors?: boolean) {
    const res = await contentsApi.generateImage(prompt, referenceImage, noFallback, explainErrors)
    if (res.url) genUrlMapRef.current.set(res.image, res.url)
    return res
  }

  // Translate a media/scene image to what should be sent to the backend on save:
  // its pre-uploaded storage URL when known, else the base64 data URI itself.
  const saveRef = (image: string): string => genUrlMapRef.current.get(image) ?? image

  // Get the session's draft character id, creating it exactly once even when
  // several save paths race. Returns { id, seeded } — `seeded` is true only for
  // the caller that actually created the row (its `makePayload()` images went
  // into the create); concurrent callers get seeded=false and must add-media
  // their own images afterwards. The shared promise is set synchronously (no
  // await between the null-check and the assignment), so only the first caller
  // creates. On failure the ref resets so a later save can retry.
  async function ensureDraft(makePayload: () => Parameters<typeof charactersApi.create>[0]): Promise<{ id: number; seeded: boolean }> {
    if (draftIdRef.current != null) return { id: draftIdRef.current, seeded: false }
    if (!draftCreatePromiseRef.current) {
      draftCreatePromiseRef.current = charactersApi.create(makePayload())
        .then((c) => { draftIdRef.current = c.id; return c.id })
        .catch((err) => { draftCreatePromiseRef.current = null; throw err })
      return { id: await draftCreatePromiseRef.current, seeded: true }
    }
    return { id: await draftCreatePromiseRef.current, seeded: false }
  }

  // Add-more mode: pull the existing character's face server-side (private
  // bucket → data URI, no CORS) and reuse it as the swap source.
  useEffect(() => {
    if (!targetCharacter) return
    let cancelled = false
    setLoadingSource(true)
    charactersApi.getSourceImage(targetCharacter.id)
      .then((res) => { if (!cancelled) setFaceSwapCharacterImage(res.image) })
      .catch(() => { if (!cancelled) showToast(t('content.faceSwap.sourceLoadFailed'), 'error') })
      .finally(() => { if (!cancelled) setLoadingSource(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchPinterestPhotos = async (queryStr?: string, pageNum = 1) => {
    if (!PEXELS_KEY) return
    setPinterestLoading(true)
    setFaceSwapError('')
    try {
      const page = pageNum
      const url = queryStr?.trim()
        ? `https://api.pexels.com/v1/search?per_page=30&page=${page}&query=${encodeURIComponent(queryStr.trim())}`
        : `https://api.pexels.com/v1/curated?per_page=30&page=${page}`
      const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } })
      const data = await res.json()
      const newPhotos = data.photos || []
      
      if (page === 1) {
        setPinterestPhotos(newPhotos)
      } else {
        setPinterestPhotos(prev => {
          const existingIds = new Set(prev.map((p: any) => p.id))
          const filteredNew = newPhotos.filter((p: any) => !existingIds.has(p.id))
          return [...prev, ...filteredNew]
        })
      }
      
      setHasMorePinterest(newPhotos.length === 30)
      setPinterestPage(page)
    } catch {
      if (pageNum === 1) setPinterestPhotos([])
      showToast('Không thể tải ảnh từ kho ảnh.', 'error')
    } finally {
      setPinterestLoading(false)
    }
  }

  useEffect(() => {
    if (faceSwapMode === 'pinterest' && pinterestPhotos.length === 0) {
      fetchPinterestPhotos()
    }
  }, [faceSwapMode, pinterestPhotos.length])

  // Infinite scroll for the Pexels tab: observe the sentinel below the last row
  // of photos (root = the modal's own scroll container, not the window) and load
  // the next page as soon as it comes into view — no "Xem thêm" button needed.
  // Re-created whenever page/loading state changes so the callback always closes
  // over the latest values instead of the ones from when the observer was built.
  useEffect(() => {
    if (faceSwapMode !== 'pinterest' || !hasMorePinterest) return
    const sentinel = pinterestSentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !pinterestLoading) {
          fetchPinterestPhotos(pinterestQuery, pinterestPage + 1)
        }
      },
      { root: modalBodyRef.current, rootMargin: '400px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [faceSwapMode, hasMorePinterest, pinterestLoading, pinterestPage, pinterestQuery])

  // Warn before F5/tab-close while a save is running or images are unsaved —
  // navigating away cancels the in-flight request and loses the session's work.
  // No dep array: re-registers each render so the closure always sees fresh state.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      const hasUnsaved =
        saveCharLoading ||
        [...faceSwapResults, ...mediaImages].some((url) => !savedMediaUrls.has(url)) ||
        faceSwapSceneImages.some((url) => url && !savedSceneUrls.has(url)) ||
        (draftIdRef.current == null && !!faceSwapCharacterImage)
      if (!hasUnsaved) return
      e.preventDefault()
      // Chrome still requires returnValue for the prompt to appear.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  })

  function revokeIfSet(url: string | null) {
    if (url) URL.revokeObjectURL(url)
  }

  // Download an image as JPEG, re-encoded through a canvas so any provenance
  // metadata the generator embeds (C2PA / EXIF / XMP) is stripped — the wizard
  // previews are raw `data:image/png` from OpenAI (still carry C2PA), unlike the
  // saved S3 copies which are already sanitized server-side. Cross-origin URLs
  // that taint the canvas fall back to a plain (un-re-encoded) download.
  async function downloadImageAsJpeg(src: string, filename: string) {
    try {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('image load failed'))
        image.src = src
      })
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no canvas context')
      ctx.fillStyle = '#ffffff' // JPEG has no alpha — flatten transparency to white
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, 0, 0)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95))
      if (!blob) throw new Error('jpeg encode failed')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      const a = document.createElement('a')
      a.href = src
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  }

  // Two separate stores: media = face-swapped results; scenes = the raw
  // AI-generated scenes (+ an AI target from upload mode).
  function collectSwappedMedia(): string[] {
    return [...faceSwapResults]
  }
  function collectScenes(): string[] {
    return faceSwapSceneImages.filter((img): img is string => Boolean(img))
  }

  // Persist whatever was generated to ONE character (draftIdRef): create it the
  // first time, append after that. Everything already saved one-by-one (scenes
  // AND media) is skipped so nothing is duplicated, and unsaved "Tạo Media"
  // images ride along instead of being silently dropped. Images go up in small
  // batches (SAVE_CHUNK_SIZE per request) rather than one giant base64 POST;
  // each finished batch is marked saved, so a retry after a failure resumes
  // from where it stopped instead of re-uploading (or losing) everything.
  async function persist(name: string): Promise<boolean> {
    const media = [...collectSwappedMedia(), ...mediaImages].filter((url) => !savedMediaUrls.has(url))
    const scenes = collectScenes().filter((url) => !savedSceneUrls.has(url))
    let id = draftIdRef.current
    if (id == null && !faceSwapCharacterImage && media.length === 0 && scenes.length === 0) return false
    if (id != null && media.length === 0 && scenes.length === 0 && (isAppend || !name)) return false

    const total = media.length + scenes.length
    let done = 0
    if (total) setSaveProgress({ done, total })
    try {
      if (id == null) {
        // Create the row first so the character exists even if a later batch
        // fails. A fully empty create is rejected by the backend, so without a
        // source image the first batch of images rides along.
        let seedMedia: string[] = []
        let seedScenes: string[] = []
        if (!faceSwapCharacterImage) {
          if (scenes.length) seedScenes = scenes.slice(0, SAVE_CHUNK_SIZE)
          else seedMedia = media.slice(0, SAVE_CHUNK_SIZE)
        }
        // ensureDraft() creates the row once even if another save path races us;
        // saveRef() sends each image's pre-uploaded URL so the backend passes it
        // straight through instead of re-decoding base64.
        const { id: draftId, seeded } = await ensureDraft(() => ({ name, source_image: faceSwapCharacterImage ?? undefined, face_prompt: faceSwapFacePrompt.trim() || undefined, nation: faceNation.trim() || undefined, media: seedMedia.map(saveRef), scenes: seedScenes.map(saveRef) }))
        id = draftId
        if (seeded) {
          // Our seed images went into the create → consume them so they aren't
          // re-saved as chunks below, and mark them done.
          if (seedScenes.length) { scenes.splice(0, seedScenes.length); setSavedSceneUrls((prev) => new Set([...prev, ...seedScenes])) }
          if (seedMedia.length) { media.splice(0, seedMedia.length); setSavedMediaUrls((prev) => new Set([...prev, ...seedMedia])) }
          savedRef.current = true
          done += seedMedia.length + seedScenes.length
          if (total) setSaveProgress({ done, total })
        } else if (name && !isAppend) {
          // A concurrent saver created the draft WITHOUT our seed/name — keep the
          // seed images in the arrays (saved as chunks below) and apply the name.
          await charactersApi.update(id, { name })
        }
      } else if (name && !isAppend) {
        await charactersApi.update(id, { name })
      }
      // Remaining images go up as bounded-concurrent chunks (SAVE_CONCURRENCY in
      // flight) instead of strictly one after another — the row lock keeps the
      // appends correct and most requests are near-instant URL saves now.
      const cid = id
      const chunks: { kind: 'scenes' | 'media'; items: string[] }[] = []
      for (let i = 0; i < scenes.length; i += SAVE_CHUNK_SIZE) chunks.push({ kind: 'scenes', items: scenes.slice(i, i + SAVE_CHUNK_SIZE) })
      for (let i = 0; i < media.length; i += SAVE_CHUNK_SIZE) chunks.push({ kind: 'media', items: media.slice(i, i + SAVE_CHUNK_SIZE) })
      await runPool(chunks, SAVE_CONCURRENCY, async (chunk) => {
        const payload = chunk.items.map(saveRef)
        await charactersApi.addMedia(cid, chunk.kind === 'scenes' ? { scenes: payload } : { media: payload })
        savedRef.current = true
        if (chunk.kind === 'scenes') setSavedSceneUrls((prev) => new Set([...prev, ...chunk.items]))
        else setSavedMediaUrls((prev) => new Set([...prev, ...chunk.items]))
        done += chunk.items.length
        setSaveProgress({ done, total })
      })
      return true
    } finally {
      setSaveProgress(null)
    }
  }

  // ── "Tạo Media" tab — generate non-person images with GPT ─────────────────
  // Fill the prompt box with a random preset (quick variety for filler images).
  function handleRandomMedia() {
    const pick = MEDIA_PRESETS[Math.floor(Math.random() * MEDIA_PRESETS.length)]
    setMediaPrompt(pick.prompt)
  }

  async function handleGenerateMedia() {
    const prompt = mediaPrompt.trim()
    if (!prompt || mediaGenerating) return
    setMediaGenerating(true)
    setFaceSwapError('')
    try {
      // Pure text-to-image (no reference face) — these are scenery/objects, not
      // the character. A light suffix keeps results photo-realistic & person-free
      // (the preset prompts are already detailed; this only guards short typed ones).
      const full = `${prompt}, photorealistic, ultra detailed, natural lighting, no people, no text, no watermark\n\n${IMPERFECT}`
      // Generate `mediaCount` images in parallel; keep whatever succeeds.
      const results = await Promise.allSettled(
        Array.from({ length: mediaCount }, () => genImage(full, undefined, undefined, true)),
      )
      const images = results
        .filter((r): r is PromiseFulfilledResult<{ image: string }> => r.status === 'fulfilled')
        .map((r) => r.value.image)
      if (images.length === 0) {
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
        throw rejected?.reason instanceof Error ? rejected.reason : new Error(t('content.faceSwap.generateFailed'))
      }
      setMediaImages((prev) => [...images, ...prev])
      if (images.length < mediaCount) {
        showToast(`Đã tạo ${images.length}/${mediaCount} ảnh (một số ảnh lỗi).`, 'info')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('content.faceSwap.generateFailed')
      setFaceSwapError(message)
      showToast(message, 'error')
    } finally {
      setMediaGenerating(false)
    }
  }

  // Save a generated media image into the character's `media` (so it counts
  // toward media_count and is postable), creating a draft on first use.
  // `silent` skips the per-image toast/refetch — used by the "save all" callers
  // below so saving N images triggers one refetch instead of N (each refetch is
  // an immediate network call since CharactersPage never unmounts behind the
  // wizard, so doing it per-image turns a bulk save into a request storm).
  // Returns true only when the image was actually saved (false if skipped by the
  // in-flight guard or the save errored) so "save all" can count real successes.
  async function handleSaveMedia(url: string, opts?: { silent?: boolean }): Promise<boolean> {
    if (savedMediaUrls.has(url) || savingMedia) return false
    setSavingMedia(url)
    try {
      // ensureDraft prevents a duplicate character when saves race (see ensureDraft).
      const { seeded, id } = await ensureDraft(() => ({
        name: '',
        source_image: faceSwapCharacterImage ?? undefined,
        face_prompt: faceSwapFacePrompt.trim() || undefined,
        nation: faceNation.trim() || undefined,
        media: [saveRef(url)],
      }))
      if (!seeded) await charactersApi.addMedia(id, { media: [saveRef(url)] })
      savedRef.current = true
      setSavedMediaUrls((prev) => new Set(prev).add(url))
      if (!opts?.silent) {
        qc.invalidateQueries({ queryKey: ['characters'] })
        showToast('Đã lưu ảnh vào nhân vật.', 'success')
      }
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : t('content.faceSwap.saveFailed')
      showToast(message, 'error')
      return false
    } finally {
      setSavingMedia(null)
    }
  }

  async function handleSaveAllMedia() {
    let count = 0
    for (const url of mediaImages) {
      if (!savedMediaUrls.has(url) && await handleSaveMedia(url, { silent: true })) count++
    }
    if (count > 0) {
      qc.invalidateQueries({ queryKey: ['characters'] })
      showToast(`Đã lưu ${count} ảnh vào nhân vật.`, 'success')
    }
  }

  // Upload a local image file and save it straight into the character's media —
  // same validation (extension/size) as the face-swap "Upload mode" tab, reusing
  // handleSaveMedia so a draft character is created on first use just like every
  // other media source (generated / Pexels).
  async function handleUploadLocalMedia(file: File | null) {
    if (!file || uploadingLocalMedia) return
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      showToast('Định dạng ảnh không được hỗ trợ (chỉ jpg, jpeg, png, webp).', 'error')
      return
    }
    if (file.size > MAX_FACE_SWAP_IMAGE_BYTES) {
      showToast('Ảnh quá lớn (tối đa 15MB).', 'error')
      return
    }
    setUploadingLocalMedia(true)
    try {
      // Shrink the photo in the browser first (phone shots can be 4000px/15MB) so
      // the upload payload is small; the BE downscales too but this cuts the wire.
      const dataUri = await fileToDownscaledDataUri(file)
      await handleSaveMedia(dataUri)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('content.faceSwap.saveFailed')
      showToast(message, 'error')
    } finally {
      setUploadingLocalMedia(false)
    }
  }

  // Edit-mode results are standalone images → save into the character's media,
  // reusing the same per-image saver as the "Tạo Media" tab.
  async function handleSaveAllEdited() {
    let count = 0
    for (const url of faceSwapResults) {
      if (!savedMediaUrls.has(url) && await handleSaveMedia(url, { silent: true })) count++
    }
    if (count > 0) {
      qc.invalidateQueries({ queryKey: ['characters'] })
      showToast(`Đã lưu ${count} ảnh vào nhân vật.`, 'success')
    }
  }

  async function handleClose() {
    // A save is already in flight (explicit save or a previous close click) —
    // closing now would silently drop its outcome, so ask first.
    if (saveCharLoading) {
      if (window.confirm(t('content.faceSwap.closeWhileSaving'))) {
        revokeIfSet(faceSwapSourcePreview)
        onClose()
      }
      return
    }
    // Auto-save unsaved work as a draft (create: un-named; append: append) so
    // nothing is lost if the user closes without an explicit save. persist()
    // skips everything already saved, so re-running it never duplicates.
    try {
      setSaveCharLoading(true)
      const saved = await persist('')
      if (saved) showToast(isAppend ? t('content.faceSwap.imagesAdded') : t('content.faceSwap.characterSaved'), 'success')
      // Refresh the characters list whenever this session persisted anything —
      // also for earlier per-image saves — so the character shows up right
      // away instead of only after a page reload.
      if (saved || savedRef.current) onSaved()
    } catch {
      // Auto-save failed: give the user the choice to stay and retry
      // (finished batches are kept) instead of silently losing the images.
      if (!window.confirm(t('content.faceSwap.closeSaveFailed'))) return
    } finally {
      setSaveCharLoading(false)
    }
    revokeIfSet(faceSwapSourcePreview)
    onClose()
  }

  function handleFaceSwapSourceChange(file: File | null) {
    setFaceSwapError('')
    setFaceSwapSource(file)
    setFaceSwapSourcePreview((prev) => { revokeIfSet(prev); return file ? URL.createObjectURL(file) : null })
    // Data URI needed for the inpaint canvas (display + OCR/remove-text API).
    if (file) fileToDataUri(file).then(setFaceSwapSourceData).catch(() => setFaceSwapSourceData(null))
    else setFaceSwapSourceData(null)
  }

  // Edit-image mode: send the uploaded original + the user's prompt to OpenAI
  // (images.edit via generateImage's reference param) and show the edited result.
  async function handleEditImage() {
    if (!faceSwapSource) { setFaceSwapError(t('content.faceSwap.editSourceRequired')); return }
    if (faceSwapSource.size > MAX_FACE_SWAP_IMAGE_BYTES) { setFaceSwapError(t('content.faceSwap.fileTooLarge')); return }
    const prompt = faceSwapTargetPrompt.trim()
    if (!prompt) { setFaceSwapError(t('content.faceSwap.editPromptRequired')); return }
    setFaceSwapError('')
    setFaceSwapLoading(true)
    try {
      const sourceDataUri = await fileToDataUri(faceSwapSource)
      // Keep the uploaded image as the character portrait (source_image) so the
      // saved character shows a thumbnail, mirroring the prompt flow.
      setFaceSwapCharacterImage(sourceDataUri)
      // no_fallback: an edit that fails (e.g. moderation) must surface the error,
      // not silently text-generate an unrelated image.
      const { image } = await genImage(prompt, sourceDataUri, true, true)
      setFaceSwapResults([image])
      showToast(t('content.faceSwap.success'), 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : t('content.faceSwap.genFailed')
      setFaceSwapError(message)
      showToast(message, 'error')
    } finally {
      setFaceSwapLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">
              {isAppend ? t('content.faceSwap.addImagesTitle') : t('content.faceSwap.title')}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {isAppend ? t('content.faceSwap.addImagesDesc') : t('content.faceSwap.description')}
            </p>
          </div>
          <button onClick={handleClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div ref={modalBodyRef} className="flex flex-col gap-4 overflow-auto p-5">
          {/* Responsible-use / privacy warning */}
          <div className="flex items-start gap-2.5 rounded-lg border border-red-300 bg-gradient-to-r from-red-50 via-rose-50 to-red-50 px-3 py-2.5 dark:border-red-500/40 dark:from-red-950/40 dark:via-rose-950/30 dark:to-red-950/30">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
            <p className="text-xs leading-relaxed text-red-700/90 dark:text-red-200/80">
              <span className="font-semibold text-red-800 dark:text-red-300">⚠️ {t('characters.refWarningTitle')}. </span>
              {t('characters.refWarningBody')}
            </p>
          </div>

          {/* Tab công cụ — luồng tạo-nhân-vật ('prompt') đã bỏ, chuyển sang QuickImage. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            {(['media', 'faceswap', 'pinterest', 'edit'] as const).map((m) => {
              const label = m === 'media'
                ? 'Tạo Media'
                : m === 'pinterest'
                ? 'Kho ảnh Pinterest'
                : m === 'faceswap'
                ? 'Ghép mặt'
                : t(`content.faceSwap.mode_${m}`)
              const desc = m === 'media'
                ? 'Sinh ảnh thiên nhiên, đồ vật, con vật… bằng AI'
                : m === 'pinterest'
                ? 'Tìm kiếm và tải ảnh chất lượng cao từ Pexels'
                : m === 'faceswap'
                ? 'Ghép khuôn mặt (FaceFusion): nguồn + đích'
                : t(`content.faceSwap.mode_${m}_desc`)
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setFaceSwapMode(m); setFaceSwapResults([]); setFaceSwapError('') }}
                  className={`flex flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition ${
                    faceSwapMode === m ? 'border-foreground bg-muted/40' : 'border-border hover:bg-muted/20'
                  }`}
                >
                  <span className="text-sm font-medium">{label}</span>
                  <span className="text-[11px] text-muted-foreground">{desc}</span>
                </button>
              )
            })}
          </div>

          {isAppend && loadingSource && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('content.faceSwap.loadingSource')}
            </div>
          )}

          {faceSwapMode === 'media' ? (
            <>
              {/* Tạo Media — generate non-person images with GPT */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Mô tả ảnh muốn tạo</label>
                <textarea
                  value={mediaPrompt}
                  onChange={(e) => setMediaPrompt(e.target.value)}
                  rows={2}
                  placeholder="Chọn chủ đề bên dưới để điền prompt chi tiết, hoặc tự mô tả… VD: Endless green meadow under blue sky, scattered wildflowers, realistic landscape photography"
                  className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={handleRandomMedia}
                    className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/20"
                  >
                    <Shuffle className="size-3" />
                    Ngẫu nhiên
                  </button>
                  {MEDIA_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setMediaPrompt(p.prompt)}
                      title={p.prompt}
                      className="rounded-full border border-border px-2.5 py-1 text-[11px] hover:bg-muted"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={handleGenerateMedia} disabled={mediaGenerating || !mediaPrompt.trim()} size="sm" className="gap-1.5">
                    {mediaGenerating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    Tạo {mediaCount} ảnh
                  </Button>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">Số lượng</span>
                    {[1, 2, 4].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setMediaCount(n)}
                        className={`size-7 rounded-md border text-xs transition ${
                          mediaCount === n ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {mediaImages.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">Ảnh đã tạo ({mediaImages.length})</label>
                    <button
                      type="button"
                      onClick={handleSaveAllMedia}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Lưu tất cả vào nhân vật
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {mediaImages.map((img, i) => {
                      const saved = savedMediaUrls.has(img)
                      return (
                        <div key={i} className="relative aspect-square overflow-hidden rounded-lg border border-border">
                          <img src={img} alt="" className="h-full w-full object-cover" />
                          <button
                            type="button"
                            onClick={() => handleSaveMedia(img)}
                            disabled={saved || savingMedia === img}
                            title="Lưu vào nhân vật"
                            className={`absolute inset-x-1 bottom-1 flex items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-semibold transition ${
                              saved ? 'bg-emerald-600 text-white' : 'bg-foreground/80 text-background hover:bg-foreground'
                            }`}
                          >
                            {savingMedia === img ? <Loader2 className="size-3 animate-spin" /> : saved ? 'Đã lưu' : 'Lưu'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          ) : faceSwapMode === 'pinterest' ? (
            <>
              {/* Kho ảnh Pinterest (Pexels API) */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      value={pinterestQuery}
                      onChange={(e) => setPinterestQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && fetchPinterestPhotos(pinterestQuery, 1)}
                      placeholder="Tìm kiếm ảnh đẹp..."
                      className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <Button
                    onClick={() => fetchPinterestPhotos(pinterestQuery, 1)}
                    disabled={pinterestLoading}
                    size="sm"
                    className="gap-1.5"
                  >
                    {pinterestLoading && pinterestPhotos.length === 0 ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                    Tìm kiếm
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadingLocalMedia}
                    className="gap-1.5"
                    onClick={() => document.getElementById('face-swap-upload-local-media')?.click()}
                  >
                    {uploadingLocalMedia ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                    Tải ảnh từ máy
                  </Button>
                  <input
                    id="face-swap-upload-local-media"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => { handleUploadLocalMedia(e.target.files?.[0] ?? null); e.target.value = '' }}
                  />
                </div>

                {!PEXELS_KEY ? (
                  <p className="rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-200">
                    Kho ảnh chưa được kích hoạt. Vui lòng thêm <code className="rounded bg-black/30 px-1">VITE_PEXELS_API_KEY</code> vào file <code className="rounded bg-black/30 px-1">.env</code> rồi khởi động lại hệ thống.
                  </p>
                ) : (
                  <>
                    {pinterestPhotos.length > 0 ? (
                      <div className="flex flex-col gap-3">
                        <label className="text-sm font-medium">Ảnh gợi ý / Kết quả tìm kiếm ({pinterestPhotos.length})</label>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                          {pinterestPhotos.map((p) => (
                            <div key={p.id} className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-border bg-muted/20">
                              <img
                                src={p.src.medium}
                                alt={p.alt || 'Pinterest Photo'}
                                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                                loading="lazy"
                              />
                              <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/80 via-black/20 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                                <p className="mb-1.5 truncate text-[10px] text-white/90 font-medium">
                                  {p.photographer || 'Pinterest'}
                                </p>
                                <div className="flex flex-col gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleSaveMedia(p.src.original)}
                                    disabled={savedMediaUrls.has(p.src.original) || savingMedia === p.src.original}
                                    title="Dùng ảnh này làm media của nhân vật"
                                    className={`flex w-full items-center justify-center gap-1 rounded py-1 text-[10px] font-semibold transition ${
                                      savedMediaUrls.has(p.src.original)
                                        ? 'bg-emerald-600 text-white'
                                        : 'bg-primary text-primary-foreground hover:bg-primary/95'
                                    }`}
                                  >
                                    {savingMedia === p.src.original ? (
                                      <Loader2 className="size-3 animate-spin" />
                                    ) : savedMediaUrls.has(p.src.original) ? (
                                      <Check className="size-3" />
                                    ) : (
                                      <Plus className="size-3" />
                                    )}
                                    {savedMediaUrls.has(p.src.original) ? 'Đã lưu' : 'Dùng làm ảnh media'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => downloadImageAsJpeg(p.src.original, `pinterest-${p.id}.jpg`)}
                                    title="Tải ảnh về máy"
                                    className="flex w-full items-center justify-center gap-1 rounded bg-white/20 py-1 text-[10px] font-semibold text-white transition hover:bg-white/30"
                                  >
                                    <Download className="size-3" />
                                    Tải về máy
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>

                        {hasMorePinterest && (
                          <div ref={pinterestSentinelRef} className="mt-2 flex justify-center py-2">
                            {pinterestLoading && (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Loader2 className="size-3.5 animate-spin" />
                                Đang tải thêm...
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : pinterestLoading ? (
                      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                        <Loader2 className="size-8 animate-spin mb-2" />
                        <p className="text-xs">Đang tải hình ảnh...</p>
                      </div>
                    ) : (
                      <div className="py-12 text-center text-xs text-muted-foreground">
                        Không tìm thấy hình ảnh nào. Hãy thử nhập từ khóa khác.
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          ) : faceSwapMode === 'faceswap' ? (
            <FaceSwapPanel
              availableMedia={availableMedia}
              onSaveMedia={handleSaveMedia}
              savedMediaUrls={savedMediaUrls}
              savingMedia={savingMedia}
              download={downloadImageAsJpeg}
            />
          ) : (
            <>
              {/* Upload mode */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.faceSwap.editSourceLabel')}</label>
                <input type="file" accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => handleFaceSwapSourceChange(e.target.files?.[0] ?? null)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium hover:file:bg-muted/80" />
                {faceSwapSourcePreview && !faceSwapSourceData && (
                  <img src={faceSwapSourcePreview} alt="source"
                    className="mt-1 h-56 w-full rounded-lg border border-border bg-muted/30 object-contain" />
                )}
              </div>

              {faceSwapSourceData && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 p-3">
                  <label className="text-sm font-medium">Xóa chữ / vật (inpaint — dùng được cả ảnh OpenAI từ chối)</label>
                  <InpaintCanvas image={faceSwapSourceData} onResult={(img) => setFaceSwapResults((prev) => [img, ...prev])} />
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('content.faceSwap.editPromptLabel')} (AI sinh lại theo mô tả)</label>
                <textarea value={faceSwapTargetPrompt}
                  onChange={(e) => { setFaceSwapTargetPrompt(e.target.value); setFaceSwapError('') }}
                  rows={5} placeholder={t('content.faceSwap.editPromptPlaceholder')}
                  className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
              </div>

              <Button onClick={handleEditImage} disabled={faceSwapLoading} className="w-fit gap-1.5">
                <Sparkles className="size-3.5" />
                {faceSwapLoading ? t('content.faceSwap.generating') : faceSwapResults.length > 0 ? t('content.faceSwap.regenerate') : t('content.faceSwap.editSubmit')}
              </Button>

              {faceSwapResults.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{t('content.faceSwap.resultTitle', { count: faceSwapResults.length })}</p>
                    <button type="button" onClick={handleSaveAllEdited}
                      className="text-xs font-medium text-primary hover:underline">
                      Lưu tất cả vào nhân vật
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {faceSwapResults.map((img, i) => {
                      const saved = savedMediaUrls.has(img)
                      return (
                        <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
                          <img src={img} alt={`edit-${i + 1}`}
                            className="aspect-square w-full rounded-md bg-muted/30 object-contain" />
                          <div className="flex gap-1.5">
                            <button type="button" onClick={() => handleSaveMedia(img)}
                              disabled={saved || savingMedia === img}
                              title="Lưu vào nhân vật"
                              className="flex-1 inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40">
                              {savingMedia === img
                                ? <RefreshCw className="size-3.5 animate-spin" />
                                : saved
                                  ? <Check className="size-3.5 text-green-600" />
                                  : <Bookmark className="size-3.5" />}
                              {saved ? 'Đã lưu' : 'Lưu vào nhân vật'}
                            </button>
                            <button type="button" onClick={() => downloadImageAsJpeg(img, `anh-${i + 1}.jpg`)}
                              className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted">
                              <Download className="size-3.5" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {faceSwapError && <p className="text-xs text-destructive">{faceSwapError}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={handleClose} className="gap-1.5">
            {saveCharLoading && <Loader2 className="size-3.5 animate-spin" />}
            {saveCharLoading && saveProgress
              ? t('content.faceSwap.savingProgress', saveProgress)
              : t('common.close')}
          </Button>
        </div>
      </div>

      {/* Colour-filter picker — overlays the wizard for the character ref or a scene. */}
      {filterTarget && (
        <FilterPicker
          image={filterTarget.kind === 'character'
            ? (faceSwapCharacterImage || '')
            : (faceSwapSceneImages[filterTarget.index] || '')}
          onClose={() => setFilterTarget(null)}
          onApply={(out) => {
            if (filterTarget.kind === 'character') {
              setFaceSwapCharacterImage(out)
            } else {
              const idx = filterTarget.index
              setFaceSwapSceneImages((prev) => prev.map((img, i) => (i === idx ? out : img)))
            }
            setFilterTarget(null)
          }}
        />
      )}
    </div>
  )
}
