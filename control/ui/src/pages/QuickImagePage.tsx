/**
 * "Tạo ảnh nhanh" — a guided, option-based image flow (no free-text prompt, no LLM).
 *
 * Pick each character trait (tuổi/da/tóc/mắt/mũi/môi…) from a dropdown → generate a
 * portrait → choose one; then pick scene traits → generate scenes that keep that
 * face. A model selector (GPT / Seedream 4.5 / Grok) renders through the shared
 * `/contents/generate-image/` endpoint (`provider` routes GPT→OpenAI, the other two
 * →fal.ai). Self-contained: it doesn't touch the block/LLM brief builder.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowUp, Check, ChevronDown, Copy, Crop, Download, Loader2, MapPin, Pencil, RotateCcw, Save, Shirt, Shuffle, Sparkles, SlidersHorizontal, Trash2, Upload, Wand2, X } from 'lucide-react'
import { FilterPicker } from '@/components/FilterPicker'
import { useToast } from '@/context/ToastContext'
import { charactersApi, contentsApi } from '@/lib/api'
import { prestoreImage, storedRef, waitForPrestore } from '@/lib/imageStore'
import type { ImageProvider, OpenAIImageSize, OpenAIImageQuality } from '@/lib/types'
import {
  QUICK_CHARACTER_FIELDS,
  QUICK_SCENE_FIELDS,
  QUICK_MODELS,
  QUICK_SIZES,
  QUICK_MODEL_OPTIONS,
  quickDefaults,
  quickCharacterDefaults,
  quickModelDefaults,
  beautySkin,
  randomFaceCodes,
  faceMenuCodes,
  buildQuickCharacterPrompt,
  buildQuickScenePrompt,
  buildQuickCharacterPromptVi,
  buildQuickScenePromptVi,
  buildSceneRealismTail,
  buildSceneRealismLead,
  buildOutfitPrompt,
  buildBackgroundPrompt,
  buildOutfitScenePrompt,
  buildRealPhotoScenePrompt,
  buildRealPhotoVariantPrompt,
  buildRealPhotoSceneLead,
  buildRealPhotoSceneTail,
  buildQuickCharacterDescription,
  hasFaceShotConflict,
  hasSelfieBackConflict,
  MAX_IMAGE_PROMPT_LEN,
  type QuickField,
  type QuickSelection,
} from '@/lib/quickPrompt'

// `prompt`/`ref` chỉ được set cho ảnh CẢNH (genScene) — nhân vật/bộ đồ/bối cảnh không cần
// sửa-prompt-riêng-từng-ảnh nên bỏ trống là bình thường. Optional để dùng chung 1 type cho
// cả 4 danh sách (cands/shots/outfitCands/bgCands) như trước giờ, không tách type riêng.
type Shot = { id: number; image: string; label: string; saved?: boolean; prompt?: string; ref?: string | string[] }

// Lưu ảnh hàng loạt theo LÔ NHỎ chạy song song có giới hạn — giống hệt luồng cũ
// (FaceSwapWizard). Backend đã upload song song trong mỗi request; chia lô thêm ở đây
// để một lượt lưu nhiều ảnh nặng không dồn hết vào 1 POST khổng lồ (dễ vượt giới hạn
// body của nginx / timeout). Tốc độ như nhau, bền hơn với lô lớn.
//
// Cỡ lô tách theo việc ảnh đã được cất vào kho chưa (lib/imageStore.ts): ảnh đã cất
// thì payload chỉ là URL vài trăm byte nên gộp lô lớn; ảnh còn phải gửi base64 thì
// mỗi ảnh ~2,25 MB — đi một ảnh một request để không dồn 6,6 MB vào một lượt.
const SAVE_CHUNK_SIZE = 1
const SAVE_URL_CHUNK_SIZE = 8
const SAVE_CONCURRENCY = 4

/** Chia `images` thành lô rồi gửi addMedia(scenes) với tối đa SAVE_CONCURRENCY lô
 *  cùng lúc. Ném lỗi đầu tiên gặp phải (để caller xử như cũ). */
async function saveScenesChunked(charId: number, images: string[]): Promise<void> {
  // Ảnh nào đã cất kho thì gửi URL, chưa thì gửi base64 như cũ.
  const refs = images.map(storedRef)
  const byUrl = refs.filter((u) => !u.startsWith('data:'))
  const byB64 = refs.filter((u) => u.startsWith('data:'))
  const chunks: string[][] = []
  for (let i = 0; i < byUrl.length; i += SAVE_URL_CHUNK_SIZE) chunks.push(byUrl.slice(i, i + SAVE_URL_CHUNK_SIZE))
  for (let i = 0; i < byB64.length; i += SAVE_CHUNK_SIZE) chunks.push(byB64.slice(i, i + SAVE_CHUNK_SIZE))
  let next = 0
  async function worker() {
    while (next < chunks.length) {
      const mine = chunks[next++]
      await charactersApi.addMedia(charId, { scenes: mine })
    }
  }
  await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, chunks.length) }, worker))
}

const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:ring-2 focus:ring-ring'

/** «Đổi cảnh» rerolls the scene dropdowns so a batch of shots isn't stuck in one place.
 *  Outfit and skin are left alone: they belong to the character, not to the location.
 *  Vật che tiền cảnh (foreground) cũng giữ nguyên: mặc định là "không có gì che", đổi cảnh
 *  không được lén nhét vật che vào — muốn có thì người dùng tự chọn. */
const KEEP_ON_SHUFFLE = new Set(['outfit', 'skin_tex', 'foreground'])

/** Mặc định của cảnh, dùng chung cho khởi tạo lẫn resetAll để không lệch nhau. `foreground`
 *  ép về 'none' (không gì che ống kính): mặc định gốc của field là "Tuỳ cảnh (model tự chọn)"
 *  khiến ảnh hay mọc vật che ngoài ý muốn, trong khi đa số muốn ảnh sạch. */
const sceneDefaults = (): QuickSelection => ({ ...quickDefaults(QUICK_SCENE_FIELDS), foreground: 'none' })

/** Nối khối "ảnh thật" (`tail`) — và với prompt cảnh, cả câu neo ảnh tham chiếu (`lead`, xem
 *  buildSceneRealismLead) — vào prompt người dùng tự gõ. Trống thì trả '' (chặn ở nơi gọi).
 *  `lead` mặc định rỗng: chân dung (charOverride) không bao giờ đính ảnh tham chiếu nên không
 *  cần; cảnh (sceneOverride) mới truyền — thiếu nó thì ảnh tham chiếu (mặt/nền) vẫn được đính
 *  kèm (đọc từ state, độc lập với ô prompt — xem genScene()) nhưng model không biết dùng vào
 *  việc gì → hay sinh sai mặt/sai cảnh dù gõ tay đúng ý (bug thật, khách báo "nhét tay prompt
 *  vẫn sinh sai ý ạ"). */
function withRealism(body: string, tail: string, lead = ''): string {
  const text = body.trim()
  if (!text) return ''
  return [lead, text, tail].filter(Boolean).join('\n\n')
}

/** A combobox, not a <select>: the box IS the text input, so clicking it lets you type
 *  anything, and the options drop down underneath as suggestions. No "custom" mode to
 *  switch into — a value matching no option simply IS custom text, used verbatim in the
 *  prompt. Known values display their Vietnamese label; typed ones show as typed. */
function FieldSelect({
  field,
  value,
  onChange,
}: {
  field: QuickField
  value: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const match = field.opts.find(([, en]) => en === value)
  const shown = match ? match[0] : value
  // While the box holds custom text, the list narrows to what that text matches; a picked
  // option shows the full list again (its label is not a search query).
  const q = match ? '' : value.trim().toLowerCase()
  const hits = q
    ? field.opts.filter(([vi, en]) => vi.toLowerCase().includes(q) || en.toLowerCase().includes(q))
    : field.opts

  return (
    <div className="relative flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{field.label}</span>
      <div className="relative">
        <input
          type="text"
          className={`${SELECT_CLASS} pr-7`}
          placeholder={field.key === 'age' ? 'vd: 27 · 25-30' : 'Chọn hoặc gõ mô tả (tiếng Anh)'}
          value={shown}
          title={value}
          // Select-all on focus: a picked option shows its Vietnamese LABEL, and typing
          // must not graft characters onto that label — the first keystroke replaces it
          // with the custom text instead.
          onFocus={(e) => {
            setOpen(true)
            e.target.select()
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          onChange={(e) => onChange(e.target.value)}
        />
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      </div>
      {open && hits.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-background py-1 shadow-lg">
          {hits.map(([vi, en]) => (
            <li key={en}>
              <button
                type="button"
                // Fire before blur closes the list, otherwise the click never lands.
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(en)
                  setOpen(false)
                }}
                className={`w-full px-2.5 py-1.5 text-left text-sm hover:bg-muted ${en === value ? 'bg-muted font-medium' : ''}`}
              >
                {vi}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Nút tải kèm menu độ phân giải. Chỉ liệt kê các mức NHỎ HƠN ảnh gốc — phóng to
 *  một tấm 1024px lên "4K" chỉ là kéo giãn pixel, ảnh không nét thêm được, nên không
 *  bịa ra lựa chọn đó. Kích thước thật của ảnh đọc từ chính file, không đoán. */
const DOWNLOAD_SIZES: [number, string][] = [
  [3840, '4K · 3840px'], [2560, '2K · 2560px'], [1920, 'Full HD · 1920px'],
  [1280, 'HD · 1280px'], [1024, '1K · 1024px'], [640, 'Nhỏ · 640px'],
]

/** Ảnh sinh ra chỉ ở 3 tỉ lệ gốc mà gpt-image hỗ trợ — Vuông 1:1, Dọc 2:3, Ngang
 *  3:2 (xem QUICK_SIZES/quickPrompt.ts) — không tỉ lệ nào khớp khung Facebook thật
 *  (feed ~4:5, story/reels 9:16). Tải "Gốc" rồi tự tay đăng lên FB thì ảnh không lấp
 *  đầy khung, dư viền. Cho tải kèm bản đã crop sẵn về đúng tỉ lệ FB cần, giữ tối đa
 *  độ phân giải gốc (crop-to-fill, không co giãn méo ảnh, không độn viền). */
//
// KHÔNG có ô vuông 1:1 ở đây. Ảnh vuông là tỉ lệ tệ nhất cho khung xem ảnh của
// Facebook: khung đó rộng ngang, ảnh vuông chạm trần chiều cao trước rồi dừng, để
// lại hai dải đen to hai bên — người dùng báo đúng chuyện này ("không full màn
// hình"). Thêm nữa cắt 1:1 từ ảnh dọc 1024x1536 còn vứt luôn 1/3 chiều cao, ra file
// 1024x1024 vừa lệch khung vừa bé. Cần ảnh vuông làm avatar thì cắt ở chỗ khác.
const FB_CROP_PRESETS: [number, string][] = [
  [4 / 5, 'Dọc 4:5 · Bài Feed'],
  [9 / 16, 'Dọc 9:16 · Story/Reels'],
]

// MỌI đường tải ảnh về máy đều phải xuất JPEG, KHÔNG được để PNG lọt ra ngoài: ảnh do
// gpt-image trả về là PNG có nhúng sẵn C2PA (siêu dữ liệu khai báo "ảnh này do AI tạo"), và
// mạng xã hội đọc được nó. Vẽ lại qua canvas rồi mã hoá JPEG sẽ dựng file mới hoàn toàn nên
// không còn C2PA/EXIF/XMP nào bám theo. Luồng cũ (FaceSwapWizardLegacy.downloadImageAsJpeg)
// đã làm đúng việc này từ trước; đây là bản tương đương cho luồng "Tạo ảnh nhanh".
// q0.95 gần như không phân biệt được với ảnh gốc bằng mắt thường.
const DOWNLOAD_JPEG_QUALITY = 0.95

/** Vẽ ảnh ra canvas rồi trả về data URI JPEG (nền trắng vì JPEG không có kênh trong suốt).
 *  Đây là chốt chặn duy nhất: mọi hàm tải bên dưới đều đi qua nó. */
function canvasToJpeg(c: HTMLCanvasElement): string {
  return c.toDataURL('image/jpeg', DOWNLOAD_JPEG_QUALITY)
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const im = new Image()
  im.crossOrigin = 'anonymous'
  await new Promise<void>((ok, err) => {
    im.onload = () => ok()
    im.onerror = () => err(new Error('Không đọc được ảnh.'))
    im.src = src
  })
  return im
}

/** Ảnh gốc → JPEG, giữ nguyên kích thước. Dùng cho lựa chọn «Gốc» ở menu tải. */
async function toJpegDataUri(image: string): Promise<string> {
  const im = await loadImage(image)
  const c = document.createElement('canvas')
  c.width = im.naturalWidth
  c.height = im.naturalHeight
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff' // JPEG không có alpha — dàn nền trắng trước khi vẽ
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(im, 0, 0)
  return canvasToJpeg(c)
}

/** Center-crop ảnh về đúng *ratio* (width/height), trả về data URL JPEG. Cùng ngưỡng
 *  sai số 2% và cùng logic với `_crop_to_aspect` bên mobile-agent-worker/task_executor.py,
 *  để ảnh "full khung" bất kể tải từ đây hay đăng qua automation.
 *
 *  Tỉ lệ đã khớp sẵn thì VẪN phải vẽ lại (trước đây trả thẳng ảnh gốc) — trả nguyên ảnh gốc
 *  nghĩa là trả nguyên PNG kèm C2PA, đúng thứ cần tránh. */
async function cropToAspect(image: string, ratio: number): Promise<string> {
  const im = await loadImage(image)
  const w = im.naturalWidth
  const h = im.naturalHeight
  const current = w / h

  let sx = 0, sy = 0, sw = w, sh = h
  if (Math.abs(current - ratio) / ratio >= 0.02) {
    if (current > ratio) {
      sw = Math.round(h * ratio)
      sx = Math.round((w - sw) / 2)
    } else {
      sh = Math.round(w / ratio)
      sy = Math.round((h - sh) / 2)
    }
  }
  const c = document.createElement('canvas')
  c.width = sw
  c.height = sh
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, sw, sh)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh)
  return canvasToJpeg(c)
}

function DownloadMenu({
  image,
  onFull,
  onResize,
  onCrop,
}: {
  image: string
  onFull: () => void
  onResize: (maxSide: number) => void
  onCrop: (ratio: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const im = new Image()
    im.onload = () => setDim({ w: im.naturalWidth, h: im.naturalHeight })
    im.src = image
  }, [image])

  const long = dim ? Math.max(dim.w, dim.h) : 0
  const smaller = DOWNLOAD_SIZES.filter(([px]) => px < long)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        title="Tải ảnh về (chọn độ phân giải / tỉ lệ)"
        className="inline-flex items-center rounded-md border border-border p-1 hover:bg-muted"
      >
        <Download className="size-3.5" />
      </button>
      {open && (
        <ul className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-background py-1 text-left shadow-lg">
          <li>
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onFull(); setOpen(false) }}
              className="w-full px-2.5 py-1.5 text-left text-xs hover:bg-muted"
            >
              <b>Gốc</b>
              {dim && <span className="text-muted-foreground"> · {dim.w}×{dim.h}</span>}
            </button>
          </li>
          {smaller.map(([px, label]) => (
            <li key={px}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); onResize(px); setOpen(false) }}
                className="w-full px-2.5 py-1.5 text-left text-xs hover:bg-muted"
              >
                {label}
              </button>
            </li>
          ))}
          {dim && smaller.length === 0 && (
            <li className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
              Ảnh chỉ {dim.w}×{dim.h} — không có mức nào nhỏ hơn để chọn.
            </li>
          )}
          <li className="mt-1 border-t border-border px-2.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Cắt sẵn cho Facebook
          </li>
          {FB_CROP_PRESETS.map(([ratio, label]) => (
            <li key={label}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); onCrop(ratio); setOpen(false) }}
                className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs hover:bg-muted"
              >
                <Crop className="size-3 shrink-0 text-muted-foreground" />
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Modal sửa prompt CỦA RIÊNG một ảnh — dùng cho 2 tình huống:
 *  1. Ảnh cảnh ĐÃ sinh (shots): sửa xong «Tạo lại» gọi API ngay, ghi đè ảnh đó tại chỗ.
 *     Trước đây ảnh cảnh sinh xong là chốt luôn, muốn đổi phải sinh lại từ prompt chung ở
 *     trên (mất mọi ảnh khác trong lô).
 *  2. Ô preview CHƯA sinh (scenePreviews, chế độ ghép): sửa xong chỉ LƯU text lại (không
 *     gọi API) — actionLabel/actionIcon đổi thành "Lưu" cho đúng hành vi, khỏi gây hiểu lầm
 *     là bấm xong tốn tiền ngay.
 *  Cùng bố cục overlay như lightbox `zoomImageUrl` phía dưới (fixed inset-0, click nền để
 *  đóng). `prompt` rỗng nghĩa là ảnh này không lưu prompt (chỉ genScene() mới lưu — xem
 *  Shot type) — vẫn cho sửa/tạo lại bình thường, chỉ là ô trống ban đầu. */
/** Tách đoạn văn ĐẦU TIÊN (trước dấu \n\n đầu) khỏi phần còn lại. Mọi prompt cảnh dựng bằng
 *  buildQuickScenePrompt/buildOutfitScenePrompt đều có dạng [lead, scene, tail].join('\n\n'),
 *  nên đoạn đầu tiên luôn đúng là câu neo ảnh tham chiếu ("Image 1 là X, Image 2 là Y…"). */
function splitLead(p: string): { lead: string; body: string } {
  const i = p.indexOf('\n\n')
  return i === -1 ? { lead: '', body: p } : { lead: p.slice(0, i), body: p.slice(i + 2) }
}

function EditPromptModal({
  prompt,
  onClose,
  onRegenerate,
  actionLabel = 'Tạo lại',
  actionIcon = <RotateCcw className="size-3.5" />,
  advanced,
  lockLead = false,
}: {
  prompt: string
  onClose: () => void
  onRegenerate: (newPrompt: string) => Promise<void>
  actionLabel?: string
  actionIcon?: React.ReactNode
  // Chỉnh nhanh qua dropdown Tư thế/Góc khuôn mặt — 2 field DUY NHẤT mà
  // buildOutfitScenePrompt() thật sự đọc ở chế độ ghép (xem quickPrompt.ts), thay vì phải
  // gõ tay prompt tiếng Anh thô. Đổi dropdown thì dựng lại `text` qua `rebuild` ngay —
  // vẫn sửa tay `text` tiếp được sau đó như bình thường.
  advanced?: { pose: string; head: string; rebuild: (pose: string, head: string) => string }
  // Ảnh này có đính kèm ảnh tham chiếu (mặt/nền/đồ — xem genScene()) → khoá đoạn văn ĐẦU
  // TIÊN của prompt (câu neo "Image 1 là X, Image 2 là Y…") khỏi bị sửa/xoá nhầm. Ảnh tham
  // chiếu được gửi ĐỘC LẬP với ô prompt (đọc từ target.ref/preview.ref, không phụ thuộc
  // người dùng gõ gì), nên thiếu câu neo là model không biết dùng ảnh tham chiếu vào việc
  // gì → hay sinh sai mặt/sai cảnh dù gõ tay đúng ý (bug thật: khách báo "nhét tay prompt
  // vẫn sinh sai ý ạ"). Không có ref thì không cần khoá gì — cho sửa tự do như trước.
  lockLead?: boolean
}) {
  const [lead] = useState(() => (lockLead ? splitLead(prompt).lead : ''))
  const [text, setText] = useState(() => (lockLead ? splitLead(prompt).body : prompt))
  const [busy, setBusy] = useState(false)
  // Người dùng đã tự gõ tay bên dưới chưa — nếu rồi thì đổi dropdown Tư thế/Góc mặt KHÔNG
  // được ghi đè `text` nữa (trước đây rebuild() luôn dựng lại toàn bộ, xoá mất phần tự gõ —
  // bug thật, cùng đợt fix "nhét tay prompt vẫn sinh sai ý").
  const [dirty, setDirty] = useState(false)
  const [pose, setPose] = useState(advanced?.pose ?? '')
  const [head, setHead] = useState(advanced?.head ?? '')
  const poseField = QUICK_SCENE_FIELDS.find((f) => f.key === 'pose')
  const headField = QUICK_SCENE_FIELDS.find((f) => f.key === 'head')

  function applyAdvanced(nextPose: string, nextHead: string) {
    setPose(nextPose)
    setHead(nextHead)
    if (!advanced || dirty) return
    const rebuilt = advanced.rebuild(nextPose, nextHead)
    setText(lockLead ? splitLead(rebuilt).body : rebuilt)
  }

  async function handleRegen() {
    if (!text.trim() || busy) return
    const full = lockLead && lead ? `${lead}\n\n${text}` : text
    setBusy(true)
    try {
      await onRegenerate(full)
      onClose()
    } catch {
      // Lỗi đã báo toast ở onRegenerate (nơi gọi có `fail()`) — ở đây chỉ cần đừng đóng
      // modal, để người dùng sửa prompt rồi thử lại ngay tại chỗ.
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex w-full max-w-lg flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Sửa prompt ảnh này</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>
        {advanced && poseField && headField && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <FieldSelect field={poseField} value={pose} onChange={(v) => applyAdvanced(v, head)} />
              <FieldSelect field={headField} value={head} onChange={(v) => applyAdvanced(pose, v)} />
            </div>
            {dirty && (
              <p className="text-[11px] text-muted-foreground">
                Anh đã sửa tay prompt bên dưới — đổi Tư thế/Góc mặt giờ chỉ đổi lựa chọn hiển thị, không tự áp vào
                prompt nữa (khỏi mất phần đã sửa).
              </p>
            )}
          </>
        )}
        {lockLead && lead && (
          <div className="rounded-md border border-dashed border-border bg-muted/50 p-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">🔒 Câu neo ảnh tham chiếu (không sửa được ở đây):</span>
            <p className="mt-1 whitespace-pre-wrap font-mono">{lead}</p>
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setDirty(true) }}
          rows={10}
          spellCheck={false}
          disabled={busy}
          className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
          >
            Huỷ
          </button>
          <button
            type="button"
            onClick={handleRegen}
            disabled={busy || !text.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : actionIcon}
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// The final prompt, editable and copyable. `override` null → shows the prompt built
// from the dropdowns (auto-updates as they change); typing sets `override`, which is
// what gets sent, until «Về khối» resets it to the built prompt.
//
// Two tabs: «Tiếng Việt» is a READ-ONLY translation for the user to check, «English» is
// the text actually sent to the model — that one stays editable. The image is always
// generated from the English text: the models understand it far better, and the whole
// anti-AI vocabulary (light-absorbing skin, off-centre framing, blank signage…) was
// tuned word by word in English. Translating the user's Vietnamese edits back would
// need another model call and could quietly change what gets drawn, so it isn't done.
function PromptBox({
  title,
  built,
  builtVi,
  override,
  setOverride,
  onCopy,
  tail,
  lead = '',
}: {
  title: string
  built: string
  builtVi: string
  override: string | null
  setOverride: (v: string | null) => void
  onCopy: (text: string) => void
  /** Khối "ảnh thật" tự động nối vào lúc gửi khi người dùng tự gõ prompt. */
  tail: string
  /** Câu neo ảnh tham chiếu ("Image 1 là X…", xem buildSceneRealismLead) tự động nối vào
   *  ĐẦU prompt khi người dùng tự gõ — chỉ "Prompt cảnh" mới truyền (nhân vật không có ảnh
   *  tham chiếu). Thiếu câu này thì ảnh tham chiếu vẫn được đính kèm (đọc từ state, không
   *  phụ thuộc ô prompt) nhưng model không biết dùng vào việc gì → hay sinh sai mặt/sai cảnh. */
  lead?: string
}) {
  const [lang, setLang] = useState<'vi' | 'en'>('vi')
  const [showTail, setShowTail] = useState(false)
  const sent = override ?? built
  // Tab VI là bản dịch của prompt DỰNG TỪ KHỐI (builtVi). Khi người dùng tự sửa hoặc bấm
  // «Xóa» (override khác null) thì không có bản dịch riêng — hiển thị đúng nội dung sẽ gửi,
  // để Xóa làm TRỐNG cả tab VI. Trước đây VI luôn hiện builtVi nên xóa xong vẫn thấy chữ,
  // người dùng tưởng còn prompt rồi sinh ảnh với prompt rỗng → "A prompt is required".
  const text = lang === 'vi' ? (override === null ? builtVi : sent) : sent
  // Bộ đếm phải đếm ĐÚNG CHUỖI SẼ GỬI. Khi người dùng tự sửa, cái bay lên server là
  // withRealism(override, tail) — chữ họ gõ CỘNG khối ảnh thật nối thêm. Bản trước đếm
  // mỗi `sent` nên hộp báo "2.257 ký tự" trong khi thực tế gửi 4.626 và bị backend từ
  // chối: người dùng không tài nào hiểu vì sao, vì đuôi có bao giờ hiện ra đâu. Đuôi ăn
  // mất hơn nửa hạn mức (1.998–2.615 ký tự tuỳ ô Chất da / Cỡ cảnh) nên phải tách bạch
  // "anh gõ" với "khối ảnh thật" thì họ mới biết cắt ở đâu.
  const outgoing = override === null ? built : withRealism(override, tail, lead)
  const over = outgoing.length > MAX_IMAGE_PROMPT_LEN
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className={`truncate text-xs font-medium ${over ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
          {title} · {outgoing.length.toLocaleString('vi-VN')}
          {over ? ` / ${MAX_IMAGE_PROMPT_LEN.toLocaleString('vi-VN')}` : ''} ký tự
          {override !== null
            ? (lead || tail)
              ? ` · đã sửa tay (${override.trim().length.toLocaleString('vi-VN')} anh gõ + ` +
                `${(lead.length + tail.length).toLocaleString('vi-VN')} khối tự động)`
              : ` · đã sửa tay (gửi nguyên văn, không tự nối gì thêm)`
            : ''}
          {over ? ' · VƯỢT GIỚI HẠN' : ''}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <div className="inline-flex overflow-hidden rounded-md border border-border text-xs">
            {([['vi', 'Tiếng Việt'], ['en', 'English (gửi đi)']] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setLang(k)}
                className={`px-2 py-0.5 ${lang === k ? 'bg-foreground text-background' : 'hover:bg-muted'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onCopy(text)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
          >
            <Copy className="size-3" /> Copy
          </button>
          <button
            type="button"
            onClick={() => { setOverride(''); setLang('en') }}
            title="Xóa sạch prompt để tự gõ (chuyển sang tab English)"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
          >
            <X className="size-3" /> Xóa
          </button>
          {override !== null && (
            <button
              type="button"
              onClick={() => setOverride(null)}
              title="Về prompt dựng từ khối"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
            >
              <RotateCcw className="size-3" /> Về khối
            </button>
          )}
        </div>
      </div>
      <textarea
        value={text}
        readOnly={lang === 'vi'}
        onChange={(e) => setOverride(e.target.value)}
        rows={7}
        spellCheck={false}
        className={`w-full resize-y rounded-md border border-border p-2 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-ring ${
          lang === 'vi' ? 'bg-muted/50' : 'bg-background'
        }`}
      />
      {/* Vượt trần thì nói thẳng phải cắt bao nhiêu ký tự, đừng bắt người dùng tự trừ. */}
      {over && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive">
          Vượt <b>{(outgoing.length - MAX_IMAGE_PROMPT_LEN).toLocaleString('vi-VN')}</b> ký tự so với giới hạn{' '}
          {MAX_IMAGE_PROMPT_LEN.toLocaleString('vi-VN')} ký tự — nút sinh ảnh đang bị khoá.{' '}
          {override !== null
            ? <>Khối tự động nối thêm đã chiếm <b>{(lead.length + tail.length).toLocaleString('vi-VN')}</b> ký tự, nên
              phần anh gõ chỉ được tối đa{' '}
              <b>{Math.max(0, MAX_IMAGE_PROMPT_LEN - lead.length - tail.length - 4).toLocaleString('vi-VN')}</b> ký tự.</>
            : 'Bớt bằng cách chọn giá trị ngắn hơn ở các ô bên trên.'}
        </p>
      )}
      {/* Prompt tự gõ thì 6 khối chống-AI đã bị xoá theo — báo cho người dùng biết chúng vẫn
          được nối vào lúc gửi, để họ không viết câu đá nhau (vd "xoá phông", "Canon 85mm"
          chọi với khối "no portrait mode"). `lead` (nếu có) là câu neo ảnh tham chiếu — thiếu
          nó thì model không biết ảnh mặt/nền đính kèm dùng vào việc gì, hay sinh sai mặt/sai
          cảnh dù gõ tay đúng ý. Chỉ là 1 dòng chữ, bấm mới bung ra xem. `lead || tail` rỗng
          (ô "Prompt nhân vật" — không còn tự nối gì nữa, xem charSend) thì ẩn hẳn khối này,
          khỏi hiện 1 nút bấm ra hộp trống. */}
      {override !== null && override.trim() !== '' && (lead || tail) && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setShowTail((v) => !v)}
            className="self-start text-left text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            ＋ Tự động kèm{lead ? ' câu neo ảnh tham chiếu +' : ''} khối ảnh thật: máy ảnh, ánh sáng xiên, kết cấu da,
            bố cục lệch, không chữ · <b>{showTail ? 'ẩn' : 'xem'}</b>
          </button>
          {showTail && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/50 p-2 font-mono text-[10px] text-muted-foreground">
              {[lead, tail].filter(Boolean).join('\n\n')}
            </pre>
          )}
        </div>
      )}
      {lang === 'vi' && (
        <p className="text-[11px] text-muted-foreground">
          {override === null ? (
            <>Bản dịch để đọc — ảnh vẫn sinh từ bản <b>English</b>. Muốn sửa prompt thì chuyển sang tab English.</>
          ) : sent.trim() ? (
            <>Anh đã tự sửa prompt — nội dung thật nằm ở tab <b>English</b>. Sang tab đó để xem/sửa.</>
          ) : (
            <>Prompt đang <b>trống</b> — sang tab <b>English</b> gõ nội dung, hoặc bấm «Về khối» để lấy lại prompt mặc định.</>
          )}
        </p>
      )}
    </div>
  )
}

// Model khoá cứng theo luồng (đã bỏ nút chọn 3 model). Chân dung nhân vật: từng đổi
// GPT → Grok (mọi người chê GPT dựng mặt nhân vật) — 04/08/2026, commit 76095a8 — rồi
// giờ đổi lại Grok → GPT (khách hàng chê ảnh Grok "nhựa", xem phân tích trong
// handleEditImage() ở FaceSwapWizardLegacy.tsx: cùng gốc, quality=low + không có góc
// mặt). Ảnh cảnh (giữ nét mặt) vẫn GPT như cũ. Mức chất lượng vẫn chỉnh được ở thanh
// trên; mặc định là mức thấp nhất của mỗi model.
const CHAR_PROVIDER: ImageProvider = 'openai'
// Model ảnh CẢNH chỉ là MẶC ĐỊNH — người dùng đổi được ở ô "Model ảnh cảnh" trên
// thanh cài đặt (state sceneProvider). Lý do phải đổi được: gpt-image chặn ảnh kết
// quả ở stage=output với các bộ đồ hở (log 20/08: áo dài 3/3 ra ảnh, bikini/áo bơi
// 12/12 bị chặn) — mà thông tin bộ đồ nằm trong ẢNH nên sửa prompt không cứu được.
// Grok/Seedream đi qua fal.ai, kiểm duyệt lỏng hơn, là lối thoát duy nhất còn lại
// trong app. Model NHÂN VẬT vẫn cố định GPT (Grok dựng mặt bị bẹt/méo — xem ghi chú
// ở CHAR_PROVIDER).
const SCENE_PROVIDER_DEFAULT: ImageProvider = 'openai'

// NHÃN HIỂN THỊ cho model nhân vật — KHÔNG phải model thật.
//
// Yêu cầu: người dùng thấy phần nhân vật ghi "Grok", còn ảnh cảnh vẫn ghi GPT.
// Model thật vẫn hoàn toàn do CHAR_PROVIDER quyết định (đang là 'openai'); hằng này
// chỉ đổi CÁI TÊN người dùng đọc, ở ô "Model (cố định)" và ở nhãn dưới mỗi ảnh nhân
// vật vừa sinh. Muốn đổi model thật thì sửa CHAR_PROVIDER ở trên — sửa chỗ này
// KHÔNG đổi gì trong request gửi đi. Để chuỗi rỗng thì quay về hiện tên model thật.
const CHAR_MODEL_LABEL_OVERRIDE = 'Grok'

// Nhân vật đơn giản: người dùng CHỈ nhập Quốc tịch + Độ tuổi + Mức nhan sắc; các nét còn
// lại tự random mỗi lần bấm "Sinh nhân vật" (mở "Tuỳ chỉnh nâng cao" để chỉnh tay thì
// không random). Mức nhan sắc nằm ở đây vì nếu giấu nó sau "nâng cao" thì người dùng
// thường không bao giờ chạm tới, mà đó lại là ô DUY NHẤT thực sự đổi được gương mặt —
// xem BEAUTY_FIELD trong quickPrompt.ts và số đo ở docs/test-nhan-sac/.
const BASIC_CHAR_KEYS = new Set(['nation', 'age', 'beauty'])
// Cảnh đơn giản: chỉ cho chọn Trang phục + Bối cảnh; còn lại giấu sau "Tuỳ chỉnh nâng cao".
const SIMPLE_SCENE_KEYS = new Set(['outfit', 'location'])
function randomCharTraits(base: QuickSelection): QuickSelection {
  const next: QuickSelection = { ...base }
  for (const f of QUICK_CHARACTER_FIELDS) {
    if (BASIC_CHAR_KEYS.has(f.key)) continue
    next[f.key] = f.opts[Math.floor(Math.random() * f.opts.length)][1]
  }
  // Màu da đi theo nhan sắc: chỉ mức "Đẹp" mới được da trắng, còn lại ngăm. Random một
  // màu da bất kỳ rồi ghép với "không xinh" cho ra ảnh mâu thuẫn (da trắng nõn + mặt
  // kém sắc), nên ép ở đây — chỉ trong chế độ đơn giản. Mở "Tuỳ chỉnh nâng cao" thì ô
  // Màu da hiện ra và lựa chọn tay của người dùng được tôn trọng.
  const skin = beautySkin(next.beauty || '')
  if (skin) next.skin = skin
  // Bốc luôn một tổ hợp gương mặt từ thực đơn (8 ô, ~846k tổ hợp ở mức kém sắc). Đây là
  // thứ THAY THẾ nguồn đa dạng đã mất khi ô nhan sắc gỡ Mặt/Mắt/Mũi/Môi ra khỏi prompt.
  // Bốc tại chỗ chứ không nhờ GPT: đo 30 ảnh thấy GPT hội tụ, chỉ chạm 18/45 lựa chọn
  // (xem FACE_MENU_KEM trong quickPrompt.ts). Mức "Đẹp" trả về {} nên không đổi gì.
  Object.assign(next, randomFaceCodes(next.beauty || ''))
  return next
}
/** Giá trị ngẫu nhiên của 1 ô cảnh — dùng để đổi dáng/góc từng ảnh khi ghép [nền+đồ+mặt]. */
function randSceneOpt(key: string): string {
  const f = QUICK_SCENE_FIELDS.find((x) => x.key === key)
  return f ? f.opts[Math.floor(Math.random() * f.opts.length)][1] : ''
}

// Bản CÓ SEED của randSceneOpt — cùng seed thì ra CÙNG kết quả (hàm thuần tuý), nên tính
// scenePreviews được bằng useMemo NGAY LÚC RENDER mà không gọi Math.random() (tránh lỗi
// react-hooks/purity), và cũng không cần setState trong effect (tránh lỗi
// react-hooks/set-state-in-effect — cả 2 lỗi này đã gặp thật ở bản trước). hashSeed băm 1
// chuỗi bất kỳ (vd `${outfitRef}|${sceneRef}|${chosenFace}|${i}|pose`) thành số nguyên,
// mulberry32 biến số đó thành 1 số thực [0,1) "trông ngẫu nhiên".
function hashSeed(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  return h
}
function seededRandSceneOpt(key: string, seed: number): string {
  const f = QUICK_SCENE_FIELDS.find((x) => x.key === key)
  if (!f || f.opts.length === 0) return ''
  let t = (seed + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296
  return f.opts[Math.floor(r * f.opts.length)][1]
}

export default function QuickImagePage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [size, setSize] = useState<OpenAIImageSize>('1024x1536')
  // Số ảnh sinh mỗi lần bấm. Model sinh ảnh vốn ngẫu nhiên, nên cùng một prompt vẫn ra
  // các bản khác nhau — sinh 3 rồi chọn cái ưng nhất là cách dùng đúng của nó.
  const [count, setCount] = useState(3)
  // Chế độ nhân vật: đơn giản (chỉ Quốc tịch + Độ tuổi, còn lại random) vs nâng cao (chỉnh tay).
  const [charAdvanced, setCharAdvanced] = useState(false)
  const [sceneAdvanced, setSceneAdvanced] = useState(false)
  // realPhotoMode ẩn hết lưới field cảnh (không còn dáng/góc/ánh sáng gì để chọn), NHƯNG
  // "Trang phục" vẫn cần hiện riêng — khối "Sinh bộ đồ" đọc thẳng sceneSel.outfit.
  const outfitField = QUICK_SCENE_FIELDS.find((f) => f.key === 'outfit')
  const [charSel, setCharSel] = useState<QuickSelection>(() => quickCharacterDefaults())
  const [sceneSel, setSceneSel] = useState<QuickSelection>(sceneDefaults)
  // Each model's own knob (GPT quality / fal resolution), kept per-provider so
  // switching models preserves each one's picks. See QUICK_MODEL_OPTIONS.
  const [modelOpt, setModelOpt] = useState<Record<string, Record<string, string>>>(() => quickModelDefaults())

  const [cands, setCands] = useState<Shot[]>([])
  const [chosenId, setChosenId] = useState<number | null>(null)
  const [shots, setShots] = useState<Shot[]>([])
  // Ảnh đang mở bảng lọc màu. Prompt chỉ đẩy nước ảnh đi đúng hướng chứ không chắc chắn
  // được — filter là bước chỉnh tay, xử lý cục bộ ở backend nên KHÔNG tốn tiền OpenAI.
  // Lọc xong thì ghi đè luôn ảnh trong danh sách, và bỏ cờ `saved` để bản đã lọc còn
  // lưu lại được (bản cũ đã lưu vẫn nằm nguyên trong nhân vật).
  const [filterShotId, setFilterShotId] = useState<number | null>(null)
  // Id của shot đang mở modal "Sửa prompt" (EditPromptModal) — chỉ áp dụng cho `shots`
  // (ảnh cảnh, xem genScene) vì chỉ đó mới lưu `prompt`/`ref` per-ảnh.
  const [editPromptShotId, setEditPromptShotId] = useState<number | null>(null)
  // Index của ô preview (trong scenePreviews) đang mở modal sửa — khác editPromptShotId ở
  // trên: đây là ảnh CHƯA sinh, sửa xong chỉ lưu lại text, không gọi API.
  const [editPreviewIndex, setEditPreviewIndex] = useState<number | null>(null)
  const [busy, setBusy] = useState<null | 'char' | 'scene' | 'details' | 'outfit' | 'bg' | 'face'>(null)
  const idRef = useRef(0)
  // Add-more mode: mở từ nút "Thêm ảnh" của một nhân vật đã lưu (route ?characterId=N).
  // Khi có, ta KHÔNG tạo nhân vật mới — nạp mặt gốc làm ảnh khoá và sinh thêm cảnh, lưu
  // vào đúng nhân vật đó. `addChar` != null báo UI đang ở chế độ này.
  const [searchParams] = useSearchParams()
  const [addChar, setAddChar] = useState<{ id: number; name: string } | null>(null)

  // Save the chosen face as a new Character (reuses charactersApi.create like the
  // brief flow); scene images then save into it via addMedia. savedChar is cleared
  // when the chosen face changes so a new save targets the new face.
  const [savedChar, setSavedChar] = useState<{ id: number; name: string } | null>(null)
  const [charName, setCharName] = useState('')
  const [savingChar, setSavingChar] = useState(false)
  const [savingShotId, setSavingShotId] = useState<number | null>(null)
  const [closing, setClosing] = useState(false)

  // Editable prompts: null = follow the dropdown-built prompt; once the user edits
  // the box it holds their text (what gets sent) until they press «Về khối».
  const [charOverride, setCharOverride] = useState<string | null>(null)
  // Lỗi sinh nhân vật GẦN ĐÂY NHẤT — hiện thành banner đỏ (khác toast, không tự biến mất) vì
  // lý do phổ biến nhất là bị OpenAI kiểm duyệt chặn (prompt tự gõ tay không còn charTail "ảnh
  // đời thường" làm vỏ bọc — xem charSend bên dưới), và người dùng cần thời gian đọc + biết
  // hướng xử lý (tự tạo trên ChatGPT rồi tải ảnh lên), không phải chỉ liếc qua rồi mất.
  const [charGenError, setCharGenError] = useState<string | null>(null)
  // Lỗi sinh ảnh CẢNH gần nhất — banner đỏ không tự tắt như toast. Cần banner vì lỗi
  // hay gặp nhất ở đây là bị kiểm duyệt chặn, mà lối thoát (đổi model) nằm ở tận
  // thanh trên nên người dùng phải còn đọc được thông báo lúc đi tìm ô đó.
  const [sceneGenError, setSceneGenError] = useState<string | null>(null)
  const [sceneOverride, setSceneOverride] = useState<string | null>(null)
  // Lightbox — URL của ảnh đang phóng to (Esc / click nền để đóng). Cùng cơ chế với CharactersPage.
  const [zoomImageUrl, setZoomImageUrl] = useState<string | null>(null)
  // Ảnh bối cảnh CÓ THẬT do người dùng tải lên. Khi có, ta không sinh cảnh nữa mà
  // ghép nhân vật vào đúng tấm ảnh này (xem genScene + buildQuickScenePrompt).
  const [sceneRef, setSceneRef] = useState<string>('')
  // sceneRef là ẢNH THẬT đã có sẵn người tạo dáng (tải lên) hay ẢNH AI SINH TRỐNG NGƯỜI
  // ("Sinh bối cảnh")? Bản chất khác hẳn: ảnh thật thì dáng/góc máy/mọi thứ đã CÓ SẴN — không
  // còn field nào để chọn nữa (chỉ đổi mặt + trang phục), còn ảnh AI trống người thì vẫn cần
  // chọn dáng như cũ (xem buildRealPhotoScenePrompt / realPhotoMode). Mặc định BẬT khi tải ảnh
  // lên (uploadSceneRef) — người dùng tự tắt nếu ảnh tải lên chỉ là bối cảnh trống muốn tự
  // chọn dáng; tự tắt khi nền đổi sang ảnh AI (genBackground / chọn bgCands).
  const [sceneRefIsPhoto, setSceneRefIsPhoto] = useState(false)
  // Khoá đồ + nền: 2 ảnh tham chiếu sinh riêng. Nền dùng chung state sceneRef; đồ riêng.
  const [outfitRef, setOutfitRef] = useState<string>('')
  const [outfitCands, setOutfitCands] = useState<Shot[]>([])
  const [bgCands, setBgCands] = useState<Shot[]>([])

  /** Đọc file ảnh local → data URI (cùng dạng ảnh do model sinh, nên mọi chỗ khác dùng lại được). */
  function readImageFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('Không đọc được file ảnh.'))
      r.readAsDataURL(file)
    })
  }

  /** Tải ảnh nhân vật từ máy: đưa thẳng vào danh sách ứng viên và chọn luôn. */
  async function uploadCharacter(file: File | undefined) {
    if (!file) return
    try {
      const image = await readImageFile(file)
      const id = (idRef.current += 1)
      setCands((prev) => [{ id, image, label: 'Tải lên' }, ...prev].slice(0, 12))
      setChosenId(id)
      setSavedChar(null)
      setCharGenError(null) // đã có ảnh thay thế (vd tự tạo bên ChatGPT) → banner lỗi cũ hết cần
      showToast('Đã tải ảnh nhân vật.', 'success')
    } catch (error) {
      fail(error, 'Tải ảnh thất bại.')
    }
  }

  async function uploadSceneRef(file: File | undefined) {
    if (!file) return
    try {
      setSceneRef(await readImageFile(file))
      setSceneRefIsPhoto(true) // mặc định BẬT — ảnh tải lên coi là đã có sẵn người/dáng
      setSceneOverride(null) // prompt đổi hẳn sang chế độ ghép — bỏ bản sửa tay cũ
      showToast('Đã tải ảnh bối cảnh — sẽ ghép nhân vật vào đúng ảnh này.', 'success')
    } catch (error) {
      fail(error, 'Tải ảnh thất bại.')
    }
  }

  useEffect(() => {
    if (!zoomImageUrl) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomImageUrl(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomImageUrl])

  // Add-more: nạp nhân vật có sẵn từ ?characterId=N. Lấy ảnh gốc làm mặt khoá (đưa vào
  // danh sách ứng viên + chọn luôn), và set savedChar sẵn để mọi lần lưu cảnh gắn vào
  // đúng nhân vật này thay vì tạo mới. Chạy đúng một lần.
  const addLoaded = useRef(false)
  useEffect(() => {
    const idStr = searchParams.get('characterId')
    if (!idStr || addLoaded.current) return
    const id = Number(idStr)
    if (!Number.isFinite(id)) return
    addLoaded.current = true
    ;(async () => {
      try {
        const [char, src] = await Promise.all([charactersApi.get(id), charactersApi.getSourceImage(id)])
        const cid = (idRef.current += 1)
        setCands((prev) => [{ id: cid, image: src.image, label: char.name || 'Nhân vật' }, ...prev])
        setChosenId(cid)
        setAddChar({ id, name: char.name })
        setSavedChar({ id, name: char.name })
        setCharName(char.name)
      } catch (error) {
        fail(error, 'Không nạp được nhân vật để thêm ảnh.')
      }
    })()
  }, [searchParams])

  // Model ảnh cảnh đổi được ngay trên giao diện (xem SCENE_PROVIDER_DEFAULT).
  const [sceneProvider, setSceneProvider] = useState<ImageProvider>(SCENE_PROVIDER_DEFAULT)
  const charProviderLabel = CHAR_MODEL_LABEL_OVERRIDE
    || QUICK_MODELS.find((m) => m.key === CHAR_PROVIDER)?.label
    || CHAR_PROVIDER
  const sceneProviderLabel = QUICK_MODELS.find((m) => m.key === sceneProvider)?.label || sceneProvider
  const charPrompt = useMemo(() => buildQuickCharacterPrompt(charSel, CHAR_PROVIDER), [charSel])
  const charPromptVi = useMemo(() => buildQuickCharacterPromptVi(charSel, CHAR_PROVIDER), [charSel])
  const chosenFace = useMemo(() => cands.find((c) => c.id === chosenId)?.image || '', [cands, chosenId])

  // ── Cất ảnh vào kho ngay khi nó vừa hiện ra ───────────────────────────────
  // Đẩy ngầm ảnh lên kho trong lúc người dùng còn đang ngắm, để lúc lưu chỉ phải
  // gửi URL thay vì ~2,25 MB base64 mỗi ảnh (xem lib/imageStore.ts — đường lưu cũ
  // chở ảnh qua mạng người dùng LẦN THỨ HAI, và lên là chiều chậm nhất).
  //
  // Chỉ cất GƯƠNG MẶT ĐANG CHỌN, không cất cả 12 ứng viên: mỗi lần bấm "Đổi nét"
  // là sinh mới, cất hết thì kho đầy ảnh không ai dùng. Ảnh cảnh thì cất tất vì
  // thoát trang là chúng được lưu tất (xem closePage).
  useEffect(() => { if (chosenFace) prestoreImage(chosenFace, 'source') }, [chosenFace])
  useEffect(() => {
    shots.forEach((sh) => { if (!sh.saved) prestoreImage(sh.image, 'scenes') })
  }, [shots])
  useEffect(() => {
    if (outfitRef) prestoreImage(outfitRef, 'scenes')
    if (sceneRef) prestoreImage(sceneRef, 'scenes')
  }, [outfitRef, sceneRef])
  // Chế độ ẢNH THẬT: nền là ảnh tải lên đã có sẵn người/dáng (sceneRefIsPhoto) + đã chọn mặt →
  // giữ NGUYÊN mọi thứ trong ảnh gốc, chỉ đổi mặt (và đồ, nếu đã "Sinh bộ đồ" — outfitRef ở
  // đây KHÔNG bắt buộc như composing). Loại trừ khỏi `composing` bên dưới vì bản chất khác hẳn:
  // ảnh thật không có dáng nào để "chọn" hay random nữa (xem buildRealPhotoScenePrompt).
  const realPhotoMode = sceneRefIsPhoto && !!sceneRef && !!chosenFace
  // Chế độ GHÉP: đã có cả đồ + nền + mặt (nền là ẢNH AI TRỐNG NGƯỜI, không phải ảnh thật) → ghép
  // 3 ref, giữ y đồ+nền, chỉ đổi dáng.
  const composing = !realPhotoMode && !!(outfitRef && sceneRef && chosenFace)
  const scenePrompt = useMemo(
    () => realPhotoMode
      ? buildRealPhotoScenePrompt(!!outfitRef)
      : composing
        ? buildOutfitScenePrompt(sceneSel)
        : buildQuickScenePrompt(sceneSel, !!chosenFace, !!sceneRef, sceneProvider),
    [realPhotoMode, composing, sceneSel, chosenFace, sceneRef, outfitRef, sceneProvider])
  const scenePromptVi = useMemo(
    () => buildQuickScenePromptVi(sceneSel, !!chosenFace, !!sceneRef, sceneProvider),
    [sceneSel, chosenFace, sceneRef, sceneProvider])

  // Xem trước prompt của TỪNG ảnh cảnh SẼ sinh ở chế độ ghép (composing) — mỗi ảnh tự
  // random pose/head RIÊNG lúc sinh thật (xem genScene), nên `scenePrompt` ở trên (dựng từ
  // sceneSel.pose/head cố định) chỉ là 1 bản mẫu chung, không đại diện đúng cho `count` ảnh
  // sẽ ra.
  //
  // Bản đầu tiên build mảng này bằng cách nối tay vào từng handler đổi outfitRef/sceneRef/
  // chosenFace (đúng nơi các state đó đổi) — nhưng genOutfit()/genBackground() còn TỰ chọn
  // luôn ảnh đầu tiên (`cur || fresh[0].image`) mà không qua tay người dùng, nên bị sót →
  // preview không hiện dù đã khoá đủ đồ+nền+mặt. Sửa triệt để bằng useMemo THUẦN TUÝ (seed
  // từ chính outfitRef/sceneRef/chosenFace/count/reshuffleNonce, dùng seededRandSceneOpt
  // thay Math.random() trực tiếp) — tự đúng theo MỌI nơi các giá trị đó đổi, không cần nối
  // tay ở bất kỳ handler nào nữa, và vẫn không vi phạm react-hooks/purity (hàm thuần tuý,
  // không phải Math.random) lẫn react-hooks/set-state-in-effect (không dùng effect).
  const [reshuffleNonce, setReshuffleNonce] = useState(0)
  // Sửa tay 1 ô qua EditPromptModal → lưu đè vào đây, key theo đúng "đời" của seed hiện tại
  // (baseSeed + index) nên khi đồ/nền/mặt/count/reshuffle đổi, override CŨ tự "hết hạn"
  // (không khớp key mới) thay vì phải dọn tay.
  const [previewOverrides, setPreviewOverrides] = useState<Record<string, string>>({})
  const scenePreviews = useMemo(() => {
    if (!composing) return []
    const baseSeed = `${outfitRef}|${sceneRef}|${chosenFace}|${count}|${reshuffleNonce}`
    return Array.from({ length: count }, (_, i) => {
      const key = `${baseSeed}|${i}`
      const pose = seededRandSceneOpt('pose', hashSeed(`${key}|pose`))
      const head = seededRandSceneOpt('head', hashSeed(`${key}|head`))
      return {
        key,
        pose,
        head,
        prompt: previewOverrides[key] ?? buildOutfitScenePrompt({ ...sceneSel, pose, head }),
        ref: [sceneRef, outfitRef, chosenFace],
      }
    })
  }, [composing, sceneSel, sceneRef, outfitRef, chosenFace, count, reshuffleNonce, previewOverrides])
  const sceneTail = useMemo(
    () => realPhotoMode ? buildRealPhotoSceneTail() : buildSceneRealismTail(sceneSel, !!sceneRef, sceneProvider),
    [realPhotoMode, sceneSel, sceneRef, sceneProvider])
  // Câu neo ảnh tham chiếu ("Image 1 là X…") — PHẢI nối vào prompt tự gõ giống hệt tail, không
  // thì ảnh tham chiếu (chosenFace/sceneRef, đính kèm độc lập với ô prompt — xem genScene())
  // gửi đi mà model không biết dùng vào việc gì → hay sinh sai mặt/sai cảnh dù gõ tay đúng ý
  // (bug thật: khách báo "nhét tay prompt vẫn sinh sai ý ạ" — trước đây chỗ này chỉ có tail,
  // thiếu hẳn lead). Nhân vật không có ảnh tham chiếu (genCharacter() luôn ref=undefined) nên
  // không cần — charSend giữ nguyên không lead.
  const sceneLead = useMemo(
    () => realPhotoMode ? buildRealPhotoSceneLead(!!outfitRef) : buildSceneRealismLead(sceneSel, !!chosenFace, !!sceneRef),
    [realPhotoMode, outfitRef, sceneSel, chosenFace, sceneRef])
  // Prompt THẬT SỰ gửi đi.
  //
  // Nhân vật: prompt tự gõ tay giờ gửi ĐÚNG NGUYÊN VĂN, KHÔNG tự nối charTail (máy ảnh/da/ánh
  // sáng/bố cục/không chữ) nữa — coi model sinh ảnh như 1 mô hình sinh ảnh: người đã tự gõ tay
  // tức là đã tự tin với đúng prompt đó rồi. Đã TEST THẬT bằng prompt khách (beauty editorial/
  // glamorous/dạ hội): nối charTail vào thì sinh được; BỎ charTail thì bị OpenAI CHẶN THẲNG ở
  // bước kiểm duyệt output (safety_violations=[sexual]) — khối "ảnh đời thường lộn xộn" trong
  // charTail vô tình làm vỏ bọc giúp qua kiểm duyệt. Chấp nhận đánh đổi này theo yêu cầu — bù
  // lại bằng charGenError (banner đỏ) + gợi ý tải ảnh tạo từ ChatGPT lên thay thế khi bị chặn
  // (xem UI ở nút "Sinh nhân vật" và "Tải ảnh lên"). charTail vẫn dùng NGUYÊN trong
  // buildQuickCharacterPrompt (prompt dựng từ dropdown, override === null).
  const charSend = charOverride === null ? charPrompt : charOverride.trim()
  // Cảnh thì NGƯỢC LẠI vẫn phải nối: ảnh tham chiếu (chosenFace/sceneRef) được đính kèm ĐỘC
  // LẬP với ô prompt (đọc từ state, xem genScene()) — gõ tay xoá mất câu neo/khối da là model
  // nhận ảnh tham chiếu mà không biết dùng vào việc gì, hay sinh sai mặt/sai cảnh (khác hẳn
  // nhân vật: genCharacter() không bao giờ đính ảnh tham chiếu — không có rủi ro "sai mặt", chỉ
  // có rủi ro kiểm duyệt vừa nói ở trên).
  const sceneSend = sceneOverride === null ? scenePrompt : withRealism(sceneOverride, sceneTail, sceneLead)
  // Chặn ngay tại nút: backend cũng kiểm (nó là cửa cuối), nhưng để bấm rồi mới ăn banner
  // đỏ thì người dùng mất một vòng chờ mà vẫn không biết cắt ở đâu. PromptBox hiện sẵn
  // số dư ngay lúc gõ, nút chỉ việc khoá theo.
  const charOverLimit = charSend.length > MAX_IMAGE_PROMPT_LEN
  const sceneOverLimit = sceneSend.length > MAX_IMAGE_PROMPT_LEN

  // Reroll the scene dropdowns (region, place, pose, light, angle…) so a batch of shots
  // spreads across the country instead of repeating one district. Drops any hand-edited
  // scene prompt, which would otherwise mask the new picks.
  function shuffleScene() {
    const picked: Record<string, string> = {}
    for (const f of QUICK_SCENE_FIELDS) {
      if (KEEP_ON_SHUFFLE.has(f.key)) continue
      picked[f.key] = f.opts[Math.floor(Math.random() * f.opts.length)][1]
    }
    // Chi tiết do GPT bịa ra là của CẢNH CŨ — đổi cảnh thì phải bỏ, không thì bãi biển
    // mới vẫn còn cái ghế nhựa của quán cà phê cũ.
    setSceneSel((s) => ({ ...s, ...picked, clutter: '', clutter_vi: '', foreground_vi: '' }))
    setSceneOverride(null)
  }

  // Reroll các nét nhân vật (trừ Quốc tịch/Độ tuổi — cùng danh sách BASIC_CHAR_KEYS mà
  // genCharacter() ở chế độ đơn giản dùng) mà KHÔNG tốn phí sinh ảnh — chỉ đổi preview
  // prompt để xem thử combo mới trước khi bấm "Sinh nhân vật" (chỉ đó mới thật sự gọi
  // API). Cùng công dụng với shuffleScene()/"Đổi cảnh" ở trên, và cũng cần vì "Tuỳ chỉnh
  // nâng cao" tắt auto-reroll (xem điều kiện !charAdvanced trong genCharacter).
  function shuffleCharacter() {
    setCharSel((s) => randomCharTraits(s))
    setCharOverride(null)
  }

  /** Nhờ GPT chọn tổ hợp gương mặt thay vì bốc ngẫu nhiên. Chỉ đổi 8 ô của thực đơn,
   *  KHÔNG đụng Quốc tịch / Độ tuổi / Mức nhan sắc — mức nhan sắc là thứ người dùng
   *  chọn, GPT không được phép đổi.
   *
   *  Bốc ngẫu nhiên vẫn là mặc định vì đo ra nó đa dạng hơn (xem quickPrompt.ts). Nút
   *  này dành cho khi tổ hợp ngẫu nhiên ra một khuôn mặt "chắp vá" — GPT chọn các nét
   *  hợp nhau hơn. Không tốn tiền sinh ảnh, chỉ 1 lời gọi GPT chữ. */
  async function faceByGpt() {
    const menu = faceMenuCodes(charSel.beauty || '')
    if (!Object.keys(menu).length) {
      showToast('Mức "Đẹp" không dùng thực đơn gương mặt — đổi sang mức khác để dùng nút này.', 'error')
      return
    }
    setBusy('face')
    try {
      const label = QUICK_CHARACTER_FIELDS.find((f) => f.key === 'beauty')
        ?.opts.find(([, v]) => v === charSel.beauty)?.[0] || 'bình thường'
      const { codes } = await contentsApi.pickFace(menu, `a Vietnamese woman who looks ${label}`)
      setCharSel((s) => ({ ...s, ...Object.fromEntries(Object.entries(codes).map(([k, v]) => [`f_${k}`, v])) }))
      setCharOverride(null)
      showToast('GPT đã chọn xong gương mặt — bấm "Sinh nhân vật" để tạo ảnh.', 'success')
    } catch (error) {
      fail(error, 'GPT chọn gương mặt thất bại.')
    } finally {
      setBusy(null)
    }
  }

  /** GPT bịa ra vật che tiền cảnh + đồ lộn xộn hậu cảnh, HỢP VỚI ĐÚNG NƠI đang chọn.
   *  Đây là thứ trước kia bị viết cứng ("lưng ghế") nên ảnh nào cũng ra một cái ghế. */
  async function inventDetails() {
    setBusy('details')
    try {
      const d = await contentsApi.sceneDetails(sceneSel.location || '', sceneSel.region || '', sceneSel.pose || '')
      setSceneSel((s) => ({
        ...s,
        // Người dùng đã chọn «Không có — không gì che ống kính» thì TÔN TRỌNG lựa chọn đó:
        // GPT chỉ bịa thêm đồ lộn xộn ở hậu cảnh, không được lén nhét vật che vào.
        ...(s.foreground === 'none'
          ? {}
          : { foreground: d.foreground || s.foreground, foreground_vi: d.foreground_vi || '' }),
        clutter: d.clutter || '',
        clutter_vi: d.clutter_vi || '',
      }))
      setSceneOverride(null)
      showToast('GPT đã bịa chi tiết mới cho cảnh này.', 'success')
    } catch (error) {
      fail(error, 'GPT bịa chi tiết thất bại.')
    } finally {
      setBusy(null)
    }
  }

  function fail(error: unknown, fallback: string) {
    showToast(error instanceof Error ? error.message : fallback, 'error')
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      showToast('Đã copy prompt.', 'success')
    } catch {
      showToast('Trình duyệt chặn sao chép.', 'error')
    }
  }

  // The selected model's own args: GPT uses `quality`, the fal models use
  // `resolution` — the endpoint ignores the one that doesn't apply.
  function providerArgs(prov: ImageProvider): { quality?: OpenAIImageQuality; resolution?: string } {
    const opt = modelOpt[prov] || {}
    return {
      quality: prov === 'openai' ? (opt.quality as OpenAIImageQuality) : undefined,
      resolution: prov === 'openai' ? undefined : opt.resolution,
    }
  }

  /** Sinh `count` ảnh SONG SONG từ cùng một prompt và giữ lại những cái thành công.
   *  Dùng allSettled chứ không phải Promise.all: một ảnh lỗi (kiểm duyệt, quá tải) thì
   *  vẫn giữ được mấy ảnh còn lại, thay vì mất trắng cả loạt. */
  // Generic trên T để genScene() có thể trả kèm {prompt, ref} đã dùng cho từng ảnh (cần để
  // sửa-prompt-riêng-từng-ảnh — xem EditPromptModal); genCharacter/genOutfit/genBackground
  // vẫn chỉ cần {image} như trước, không đổi gì ở phía họ. `run` nhận index (0..count-1) để
  // genScene() ở chế độ ghép lấy đúng prompt/ref đã xem trước (scenePreviews[index]) thay vì
  // random lại — callers không cần index vẫn khai `() => ...` bình thường, TS chấp nhận.
  async function genMany<T extends { image: string }>(run: (index: number) => Promise<T>): Promise<T[]> {
    const results = await Promise.allSettled(Array.from({ length: count }, (_, i) => run(i)))
    // Promise.allSettled infers PromiseSettledResult<Awaited<T>>, không phải <T> — dù T ở
    // đây không bao giờ TỰ là Promise (bị ràng buộc {image: string}) nên Awaited<T> = T lúc
    // chạy thật, TS vẫn cần khai đúng Awaited<T> ở type predicate rồi mới ép kiểu ở return.
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<T>> => r.status === 'fulfilled')
    if (ok.length === 0) {
      const first = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      throw (first?.reason instanceof Error ? first.reason : new Error('Sinh ảnh thất bại.'))
    }
    if (ok.length < count) showToast(`Chỉ sinh được ${ok.length}/${count} ảnh.`, 'error')
    return ok.map((r) => r.value) as T[]
  }

  async function genCharacter() {
    // Đơn giản + chưa tự sửa prompt → random các nét (trừ quốc tịch/tuổi) NGAY khi bấm sinh:
    // mỗi lần một người mới, còn N ảnh trong cùng lần thì cùng một người (dùng chung sendPrompt).
    let sendPrompt = charSend
    if (!charAdvanced && charOverride === null) {
      const rolled = randomCharTraits(charSel)
      setCharSel(rolled) // để preview + lưu nhân vật khớp ảnh vừa sinh
      sendPrompt = buildQuickCharacterPrompt(rolled, CHAR_PROVIDER)
    }
    if (!sendPrompt) { showToast('Prompt đang trống — gõ nội dung hoặc bấm «Về khối».', 'error'); return }
    setBusy('char')
    setCharGenError(null)
    try {
      const { quality, resolution } = providerArgs(CHAR_PROVIDER)
      // explainErrors=true: prompt tự gõ tay giờ không còn charTail làm "vỏ bọc đời thường"
      // (xem charSend) nên dễ bị OpenAI kiểm duyệt output chặn hơn — nhờ BE hỏi GPT đọc lỗi gốc
      // rồi trả lời tiếng Việt dễ hiểu, hiện thẳng lên banner đỏ thay vì lỗi tiếng Anh khó hiểu.
      const images = await genMany(() =>
        contentsApi.generateImage(sendPrompt, undefined, false, true, size, quality, CHAR_PROVIDER, resolution))
      const fresh = images.map((r) => ({ id: (idRef.current += 1), image: r.image, label: charProviderLabel }))
      setCands((prev) => [...fresh, ...prev].slice(0, 12))
      setChosenId((cur) => (cur == null ? fresh[0].id : cur)) // auto-pick the first one made
      showToast(`Đã sinh ${fresh.length} ảnh nhân vật.`, 'success')
    } catch (error) {
      setCharGenError(error instanceof Error ? error.message : 'Sinh nhân vật thất bại.')
      fail(error, 'Sinh nhân vật thất bại.')
    } finally {
      setBusy(null)
    }
  }

  // Sinh ảnh BỘ ĐỒ (flat-lay, không người) → ứng viên để chọn làm ref trang phục.
  async function genOutfit() {
    setBusy('outfit')
    try {
      const { quality, resolution } = providerArgs(sceneProvider)
      const images = await genMany(() =>
        contentsApi.generateImage(buildOutfitPrompt(sceneSel), undefined, false, false, size, quality, sceneProvider, resolution))
      const fresh = images.map((r) => ({ id: (idRef.current += 1), image: r.image, label: 'Bộ đồ' }))
      setOutfitCands((prev) => [...fresh, ...prev].slice(0, 8))
      setOutfitRef((cur) => cur || fresh[0].image) // chưa chọn thì lấy tạm cái đầu
      showToast(`Đã sinh ${fresh.length} ảnh bộ đồ.`, 'success')
    } catch (error) {
      fail(error, 'Sinh bộ đồ thất bại.')
    } finally {
      setBusy(null)
    }
  }

  // Sinh ảnh BỐI CẢNH (trống, không người) → ứng viên; chọn xong dùng chung state sceneRef.
  async function genBackground() {
    // Nền AI sinh trống người — chưa từng có nền trước đó thì tắt sceneRefIsPhoto (ảnh AI
    // không phải "ảnh thật có sẵn người"). Đã có nền từ trước (vd tải ảnh lên) thì
    // `cur || fresh[0].image` không ghi đè — giữ nguyên cờ cũ, không đụng vào.
    const hadSceneRef = !!sceneRef
    setBusy('bg')
    try {
      const { quality, resolution } = providerArgs(sceneProvider)
      const images = await genMany(() =>
        contentsApi.generateImage(buildBackgroundPrompt(sceneSel), undefined, false, false, size, quality, sceneProvider, resolution))
      const fresh = images.map((r) => ({ id: (idRef.current += 1), image: r.image, label: 'Bối cảnh' }))
      setBgCands((prev) => [...fresh, ...prev].slice(0, 8))
      setSceneRef((cur) => cur || fresh[0].image)
      if (!hadSceneRef) setSceneRefIsPhoto(false)
      showToast(`Đã sinh ${fresh.length} ảnh bối cảnh.`, 'success')
    } catch (error) {
      fail(error, 'Sinh bối cảnh thất bại.')
    } finally {
      setBusy(null)
    }
  }

  async function genScene() {
    // Ghép: đủ đồ + nền + mặt → gửi 3 ref [nền, đồ, mặt]; mỗi ảnh random dáng/góc mặt để cả
    // loạt cùng đồ+nền mà khác dáng. Thứ tự ref PHẢI khớp "image 1/2/3" trong buildOutfitScenePrompt.
    if (!realPhotoMode && !composing && !sceneSend) {
      showToast('Prompt đang trống — gõ nội dung hoặc bấm «Về khối».', 'error'); return
    }
    setBusy('scene')
    setSceneGenError(null)
    try {
      const { quality, resolution } = providerArgs(sceneProvider)
      // no_fallback khi có reference: edit bị từ chối KHÔNG được rơi về text-only (mất mặt).
      // Trả kèm {prompt, ref} đã dùng cho TỪNG ảnh để lưu vào Shot, phục vụ "Sửa prompt"
      // per-ảnh (EditPromptModal) — «Tạo lại» ở đó gọi lại generateImage với đúng ref này.
      const images = await genMany(async (i) => {
        if (realPhotoMode) {
          // Ảnh ĐẦU bám nguyên ảnh gốc (y dáng, y góc mặt, y khung máy). Các ảnh SAU là
          // BIẾN THỂ: cùng người, cùng bộ đồ, cùng nơi chốn và cùng góc máy, nhưng khác
          // tư thế / góc mặt / biểu cảm / ánh mắt — xem buildRealPhotoVariantPrompt.
          //
          // Trước đây cả `count` ảnh dùng CHUNG một prompt/ref nên `run(i)` không dùng `i`
          // và 3 ảnh ra gần như y hệt nhau: trả tiền 3 lần cho đúng 1 tấm. Để "1 ảnh/lần"
          // thì không có ảnh biến thể nào — hành vi y như cũ.
          const bienThe = i > 0
          const p = bienThe ? buildRealPhotoVariantPrompt(!!outfitRef) : sceneSend
          const ref: string[] = outfitRef ? [sceneRef, outfitRef, chosenFace] : [sceneRef, chosenFace]
          const res = await contentsApi.generateImage(p, ref, true, false, size, quality, sceneProvider, resolution)
          return { ...res, prompt: p, ref, note: bienThe ? 'biến thể' : 'bám ảnh gốc' }
        }
        if (composing) {
          // Dùng ĐÚNG prompt/ref đã xem trước ở scenePreviews[i] (người dùng có thể đã sửa
          // tay qua EditPromptModal) — chỉ random mới nếu preview thiếu (phòng hờ, không nên
          // xảy ra vì scenePreviews (useMemo ở trên) luôn có đủ `count` phần tử khi composing).
          const preview = scenePreviews[i]
          const sel = { ...sceneSel, pose: randSceneOpt('pose'), head: randSceneOpt('head') }
          const p = preview?.prompt ?? buildOutfitScenePrompt(sel)
          const ref: string[] = preview?.ref ?? [sceneRef, outfitRef, chosenFace]
          const res = await contentsApi.generateImage(p, ref, true, false, size, quality, sceneProvider, resolution)
          // note: nhãn phụ dưới ảnh, chỉ chế độ ảnh thật mới dùng — để trống ở đây cho
          // khớp kiểu trả về của cả 3 nhánh (genMany suy ra kiểu là hợp của cả ba).
          return { ...res, prompt: p, ref, note: '' }
        }
        // Ảnh cảnh có sẵn → [cảnh, mặt]; không thì chỉ [mặt]. Thứ tự khớp prompt sceneRef.
        const ref: string | string[] | undefined = sceneRef
          ? (chosenFace ? [sceneRef, chosenFace] : sceneRef)
          : (chosenFace || undefined)
        const res = await contentsApi.generateImage(sceneSend, ref, !!ref, false, size, quality, sceneProvider, resolution)
        return { ...res, prompt: sceneSend, ref, note: '' }
      })
      const fresh = images.map((r) => ({
        id: (idRef.current += 1),
        image: r.image,
        // Ở chế độ ảnh thật, nhãn nói rõ ảnh nào bám nguyên ảnh gốc và ảnh nào là biến
        // thể — nếu không thì nhìn 3 ảnh na ná nhau không biết đâu là bản trung thực.
        label: r.note ? `${sceneProviderLabel} · ${r.note}` : sceneProviderLabel,
        prompt: r.prompt,
        ref: r.ref,
      }))
      setShots((prev) => [...fresh, ...prev].slice(0, 24))
      showToast(`Đã sinh ${fresh.length} ảnh cảnh.`, 'success')
    } catch (error) {
      setSceneGenError(error instanceof Error ? error.message : 'Sinh ảnh cảnh thất bại.')
      fail(error, 'Sinh ảnh cảnh thất bại.')
    } finally {
      setBusy(null)
    }
  }

  /** Nguyên thuỷ: đẩy một data URI xuống máy. Mọi lời gọi PHẢI truyền vào data URI đã là
   *  JPEG (xem toJpegDataUri/cropToAspect) — đừng đưa thẳng ảnh gốc từ model vào đây, vì đó
   *  là PNG còn nguyên C2PA. */
  function download(image: string, name: string) {
    const a = document.createElement('a')
    a.href = image
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  /** Tải ảnh ở kích thước gốc, chuyển sang JPEG để gỡ C2PA. */
  async function downloadFull(image: string, name: string) {
    try {
      download(await toJpegDataUri(image), name)
    } catch (error) {
      fail(error, 'Tải ảnh thất bại.')
    }
  }

  /** Tải ảnh ở độ phân giải nhỏ hơn: vẽ lại qua canvas rồi mới tải.
   *  `maxSide` = cạnh DÀI mong muốn; tỉ lệ khung hình giữ nguyên. */
  async function downloadResized(image: string, name: string, maxSide: number) {
    try {
      const im = await loadImage(image)
      const long = Math.max(im.naturalWidth, im.naturalHeight)
      const k = maxSide / long
      const c = document.createElement('canvas')
      c.width = Math.round(im.naturalWidth * k)
      c.height = Math.round(im.naturalHeight * k)
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(im, 0, 0, c.width, c.height)
      download(canvasToJpeg(c), name.replace(/\.jpg$/, `-${c.width}x${c.height}.jpg`))
    } catch (error) {
      fail(error, 'Thu nhỏ ảnh thất bại.')
    }
  }

  /** Tải ảnh đã crop sẵn về đúng tỉ lệ Facebook cần (xem `cropToAspect`) — dùng khi
   *  anh tải về máy rồi tự tay đăng lên Facebook, để không bị dư viền/thiếu khung. */
  async function downloadCropped(image: string, name: string, ratio: number) {
    try {
      const cropped = await cropToAspect(image, ratio)
      download(cropped, name.replace(/\.jpg$/, `-fb.jpg`))
    } catch (error) {
      fail(error, 'Cắt ảnh thất bại.')
    }
  }

  // "Tạo nhân vật mới / làm lại từ đầu": xoá sạch phiên hiện tại về trạng thái ban đầu.
  // Nếu đang ở add-mode (?characterId=…), điều hướng về URL sạch để bỏ tham số đó.
  function resetAll() {
    const hasUnsaved = shots.some((s) => !s.saved) || (!!chosenFace && !savedChar)
    if (hasUnsaved && !window.confirm('Còn ảnh chưa lưu sẽ mất. Vẫn tạo nhân vật mới từ đầu?')) return
    setCands([]); setChosenId(null); setShots([])
    setSavedChar(null); setCharName(''); setSceneRef(''); setSceneRefIsPhoto(false); setAddChar(null)
    setCharSel(quickCharacterDefaults()); setSceneSel(sceneDefaults())
    setCharOverride(null); setSceneOverride(null)
    if (searchParams.get('characterId')) navigate('/characters/quick', { replace: true })
    showToast('Bắt đầu nhân vật mới.', 'success')
  }

  async function saveCharacter() {
    if (!chosenFace) return
    const name = charName.trim()
    if (!name) {
      showToast('Đặt tên nhân vật đã.', 'error')
      return
    }
    setSavingChar(true)
    try {
      // Chờ lượt cất kho của đúng ảnh này (thường xong từ lâu) rồi lưu bằng URL.
      await waitForPrestore([chosenFace])
      const created = await charactersApi.create({
        name,
        source_image: storedRef(chosenFace),
        face_prompt: buildQuickCharacterDescription(charSel),
      })
      setSavedChar({ id: created.id, name: created.name })
      qc.invalidateQueries({ queryKey: ['characters'] })
      showToast(`Đã lưu nhân vật «${created.name}».`, 'success')
    } catch (error) {
      fail(error, 'Lưu nhân vật thất bại.')
    } finally {
      setSavingChar(false)
    }
  }

  async function saveShot(shot: Shot) {
    if (!savedChar) {
      showToast('Hãy lưu nhân vật trước (cột trái).', 'error')
      return
    }
    setSavingShotId(shot.id)
    try {
      await waitForPrestore([shot.image])
      await charactersApi.addMedia(savedChar.id, { scenes: [storedRef(shot.image)] })
      setShots((prev) => prev.map((s) => (s.id === shot.id ? { ...s, saved: true } : s)))
      qc.invalidateQueries({ queryKey: ['characters'] })
      showToast('Đã lưu ảnh vào nhân vật.', 'success')
    } catch (error) {
      fail(error, 'Lưu ảnh thất bại.')
    } finally {
      setSavingShotId(null)
    }
  }

  // Closing must not silently drop work: auto-save whatever is unsaved as a draft —
  // an UN-NAMED character when none was saved yet (the list shows it as "Chưa đặt
  // tên"), plus every scene image not yet stored. Mirrors FaceSwapWizard.handleClose.
  async function closePage() {
    const unsavedShots = shots.filter((s) => !s.saved).map((s) => s.image)
    // Bộ đồ + bối cảnh đã khoá (outfitRef/sceneRef, xem "Khoá bộ đồ + bối cảnh") tốn phí
    // sinh thật (genOutfit/genBackground là 1 lần gọi model có phí) nhưng trước giờ không
    // có cách lưu riêng — thoát trang là mất trắng dù đã dùng để ghép cảnh. Lưu chung đợt
    // với unsavedShots, coi như 2 ảnh cảnh phụ của nhân vật.
    const unsavedExtras = [outfitRef, sceneRef].filter((u): u is string => !!u)
    const toSave = [...unsavedShots, ...unsavedExtras]
    const needsChar = !!chosenFace && !savedChar
    if (!needsChar && toSave.length === 0) {
      navigate('/characters')
      return
    }
    setClosing(true)
    try {
      // Chờ các lượt cất kho đang bay để lưu bằng URL thay vì base64 (có chặn thời
      // gian bên trong, kho chậm thì không giam người dùng ở đây).
      await waitForPrestore([...toSave, ...(chosenFace ? [chosenFace] : [])])
      if (savedChar) {
        await saveScenesChunked(savedChar.id, toSave)
      } else {
        // Tách làm 2 bước: tạo nhân vật (chỉ metadata), rồi lưu ảnh THEO LÔ. Trước đây
        // gộp mọi scene vào 1 call create → cùng rủi ro "1 POST khổng lồ" như addMedia.
        // Tên rỗng là cố ý — list render thành "Chưa đặt tên".
        const created = await charactersApi.create({
          name: charName.trim(),
          ...(chosenFace ? { source_image: storedRef(chosenFace) } : {}),
          face_prompt: buildQuickCharacterDescription(charSel),
        })
        setSavedChar({ id: created.id, name: created.name })
        if (toSave.length) await saveScenesChunked(created.id, toSave)
      }
      qc.invalidateQueries({ queryKey: ['characters'] })
      showToast(charName.trim() ? 'Đã lưu nhân vật.' : 'Đã lưu nhân vật (chưa đặt tên).', 'success')
      navigate('/characters')
    } catch (error) {
      // Auto-save failed: let the user stay and retry instead of losing the images.
      setClosing(false)
      const msg = error instanceof Error ? error.message : 'Lưu nhân vật thất bại.'
      if (window.confirm(`${msg}\n\nVẫn thoát? Ảnh chưa lưu sẽ mất.`)) navigate('/characters')
    }
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={closePage}
          disabled={closing}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          aria-label="Quay lại"
          title="Quay lại — tự lưu nhân vật & ảnh chưa lưu"
        >
          {closing ? <Loader2 className="size-4 animate-spin" /> : <ArrowLeft className="size-4" />}
        </button>
        <div className="flex flex-col">
          <h1 className="flex items-center gap-1.5 text-lg font-semibold">
            <Sparkles className="size-4 text-primary" />
            {addChar ? `Thêm ảnh cho: ${addChar.name || '(chưa đặt tên)'}` : 'Tạo nhân vật mới'}
          </h1>
          <p className="text-xs text-muted-foreground">
            {addChar
              ? 'Mặt nhân vật đã khoá từ ảnh gốc — chỉ cần chọn bối cảnh và sinh cảnh, ảnh mới sẽ lưu vào nhân vật này.'
              // Không viết cứng tên model ở đây: câu cũ ghi "Nhân vật dùng Grok" trong khi
              // CHAR_PROVIDER đã là 'openai' từ lâu. Model thật hiện ở ô "Model (cố định)".
              : 'Chọn nét nhân vật & bối cảnh bằng menu — không cần gõ mô tả.'}
          </p>
        </div>
      </div>

      {/* Model + frame */}
      <section className="flex flex-wrap items-end gap-6 rounded-xl border border-border p-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Model nhân vật (cố định)</span>
          <div className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground">
            {/* CHỈ model nhân vật. Model cảnh đã có ô chọn riêng ngay bên cạnh nên ghi ở
                đây nữa là thừa, mà chữ "cố định" cũng thành sai. Tên lấy qua
                CHAR_MODEL_LABEL_OVERRIDE (nhãn hiển thị theo yêu cầu, không phải model
                thật) — để chỉ có MỘT chỗ quyết định cái tên người dùng đọc. */}
            <span className="font-medium text-foreground">{charProviderLabel}</span>
          </div>
        </div>
        {/* Đổi model cho ảnh CẢNH. Đây là lối thoát khi gpt-image chặn ảnh kết quả vì bộ
            đồ hở: bộ đồ nằm trong ẢNH tham chiếu nên sửa prompt vô ích, chỉ còn cách đổi
            model. Model nhân vật KHÔNG đổi được (xem CHAR_PROVIDER). */}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Model ảnh cảnh</span>
          <select
            className={`${SELECT_CLASS} w-44`}
            value={sceneProvider}
            onChange={(e) => setSceneProvider(e.target.value as ImageProvider)}
            title="GPT cho ảnh đẹp nhất nhưng chặn đồ hở. Grok/Seedream đi qua fal.ai, kiểm duyệt lỏng hơn."
          >
            {QUICK_MODELS.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Khung ảnh</span>
          <select
            className={`${SELECT_CLASS} w-40`}
            value={size}
            onChange={(e) => setSize(e.target.value as OpenAIImageSize)}
          >
            {QUICK_SIZES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {/* Số ảnh sinh mỗi lần bấm — sinh SONG SONG rồi chọn cái ưng nhất.
            Đây là nút TỐN TIỀN: 3 ảnh = 3 lần gọi model = 3 lần trả phí. */}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Số ảnh / lần</span>
          <select
            className={`${SELECT_CLASS} w-28`}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            title="Sinh nhiều ảnh cùng lúc để chọn cái đẹp nhất. Càng nhiều càng tốn tiền API."
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n} ảnh
              </option>
            ))}
          </select>
        </label>
        {/* Mỗi model một knob chất lượng (mặc định mức thấp nhất). PHẢI lọc trùng: khi
            nhân vật và cảnh dùng CHUNG một model (hiện tại cả hai đều 'openai') thì vòng
            lặp cũ vẽ ĐÚNG HAI Ô GIỐNG HỆT NHAU, cùng key `openai-quality` (React cảnh báo
            trùng key) và cả hai đều dán nhãn "Nhân vật" vì `prov === CHAR_PROVIDER` đúng
            cho cả hai. Người dùng thấy hai ô Chất lượng y hệt, chỉnh ô nào cũng như nhau. */}
        {Array.from(new Set([sceneProvider, CHAR_PROVIDER])).flatMap((prov) =>
          QUICK_MODEL_OPTIONS[prov].map((spec) => (
            <label key={`${prov}-${spec.param}`} className="flex flex-col gap-1.5">
              {/* KHÔNG kèm tên model trong ngoặc: hai ô "Model (cố định)" và "Model ảnh
                  cảnh" ngay bên cạnh đã ghi tên rồi, mà tên thật ở đây còn đá nhau với
                  nhãn hiển thị của nhân vật (CHAR_MODEL_LABEL_OVERRIDE). */}
              <span className="text-xs font-medium text-muted-foreground">
                {sceneProvider === CHAR_PROVIDER
                  ? `${spec.label} · Nhân vật + Cảnh`
                  : `${spec.label} · ${prov === CHAR_PROVIDER ? 'Nhân vật' : 'Cảnh'}`}
              </span>
              <select
                className={`${SELECT_CLASS} w-44`}
                value={modelOpt[prov]?.[spec.param] ?? spec.default}
                onChange={(e) =>
                  setModelOpt((m) => ({ ...m, [prov]: { ...m[prov], [spec.param]: e.target.value } }))
                }
              >
                {spec.choices.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )),
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 1 · Character */}
        <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
          {addChar && (
            <p className="rounded-lg border border-primary/30 bg-primary/5 p-2 text-xs text-muted-foreground">
              Đang thêm ảnh cho nhân vật <b>{addChar.name || '(chưa đặt tên)'}</b> — mặt đã khoá từ ảnh gốc.
              Không cần tạo nhân vật mới; sang cột phải chọn bối cảnh và sinh cảnh.
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">1 · Nhân vật</h2>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted">
              <Upload className="size-3.5" /> Tải ảnh lên
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  void uploadCharacter(e.target.files?.[0])
                  e.target.value = '' // cho phép chọn lại đúng file đó lần nữa
                }}
              />
            </label>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {charAdvanced
                ? 'Chỉnh tay mọi nét nhân vật.'
                : 'Chỉ cần Quốc tịch + Độ tuổi — các nét còn lại tự đổi ngẫu nhiên mỗi lần sinh.'}
            </span>
            <button
              type="button"
              onClick={() => setCharAdvanced((v) => !v)}
              className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              {charAdvanced ? 'Đơn giản' : 'Tuỳ chỉnh nâng cao'}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {QUICK_CHARACTER_FIELDS.filter((f) => charAdvanced || BASIC_CHAR_KEYS.has(f.key)).map((f) => (
              <FieldSelect
                key={f.key}
                field={f}
                value={charSel[f.key]}
                onChange={(v) => setCharSel((s) => ({ ...s, [f.key]: v }))}
              />
            ))}
          </div>
          <PromptBox
            title="Prompt nhân vật"
            built={charPrompt}
            builtVi={charPromptVi}
            override={charOverride}
            setOverride={setCharOverride}
            onCopy={copyText}
            tail=""
          />
          <div className="flex items-center gap-2">
            <button
              onClick={genCharacter}
              disabled={busy != null || charOverLimit}
              title={charOverLimit ? `Prompt vượt giới hạn ${MAX_IMAGE_PROMPT_LEN.toLocaleString('vi-VN')} ký tự — rút gọn bớt rồi sinh` : undefined}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'char' ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              Sinh nhân vật
            </button>
            <button
              type="button"
              onClick={shuffleCharacter}
              disabled={busy != null}
              title="Bốc ngẫu nhiên lại các nét (trừ Quốc tịch/Độ tuổi) để xem preview — chưa tốn phí, bấm Sinh nhân vật mới thật sự tạo ảnh"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs font-medium hover:bg-muted disabled:opacity-40"
            >
              <Shuffle className="size-3.5" /> Đổi nét
            </button>
            <button
              type="button"
              onClick={faceByGpt}
              disabled={busy != null}
              title="Nhờ GPT chọn tổ hợp nét mặt hợp nhau, thay cho bốc ngẫu nhiên — giữ nguyên Mức nhan sắc bạn đã chọn. Chưa tốn phí sinh ảnh."
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs font-medium hover:bg-muted disabled:opacity-40"
            >
              {busy === 'face' ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
              Mặt bằng GPT
            </button>
          </div>
          {/* Lỗi sinh nhân vật gần nhất — banner đỏ, không tự biến mất như toast (xem
              charGenError). Phổ biến nhất là bị OpenAI kiểm duyệt output chặn (prompt tự gõ
              tay không còn charTail làm vỏ bọc "ảnh đời thường" — xem charSend), nên kèm luôn
              lối thoát: tự tạo ảnh trên ChatGPT rồi tải lên bằng nút "Tải ảnh lên" ở góc trên. */}
          {charGenError && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-700 dark:text-red-400">
              <div className="flex items-start justify-between gap-2">
                <span className="flex-1">⚠️ {charGenError}</span>
                <button
                  type="button"
                  onClick={() => setCharGenError(null)}
                  title="Đóng"
                  className="shrink-0 rounded-md p-0.5 hover:bg-red-500/10"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <p className="flex items-center gap-1.5 text-red-700/80 dark:text-red-400/80">
                <ArrowUp className="size-3.5 shrink-0" />
                Có thể tự tạo ảnh này trên ChatGPT rồi bấm <b>«Tải ảnh lên»</b> ở góc trên để dùng ảnh đó thay thế.
              </p>
            </div>
          )}

          {cands.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground">Bấm «Dùng» để chọn nhân vật cho bước sinh cảnh</span>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {cands.map((c) => {
                  const chosen = c.id === chosenId
                  return (
                    <div key={c.id} className="flex flex-col gap-1.5">
                      <img
                        src={c.image}
                        alt=""
                        onClick={() => setZoomImageUrl(c.image)}
                        title="Bấm để phóng to"
                        className="aspect-[2/3] w-full cursor-zoom-in rounded-lg border border-border object-cover"
                      />
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => { setChosenId(c.id); setSavedChar(null) }}
                          disabled={chosen}
                          className={`inline-flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
                            chosen
                              ? 'bg-primary/10 text-primary'
                              : 'border border-border hover:bg-muted'
                          }`}
                        >
                          {chosen && <Check className="size-3" />}
                          {chosen ? 'Đang dùng' : 'Dùng'}
                        </button>
                        <DownloadMenu
                          image={c.image}
                          onFull={() => void downloadFull(c.image, `nhanvat-${c.id}.jpg`)}
                          onResize={(px) => void downloadResized(c.image, `nhanvat-${c.id}.jpg`, px)}
                          onCrop={(ratio) => void downloadCropped(c.image, `nhanvat-${c.id}.jpg`, ratio)}
                        />
                        <button
                          onClick={() => {
                            setCands((prev) => prev.filter((x) => x.id !== c.id))
                            if (chosen) setChosenId(null) // ảnh đang dùng bị xóa → bỏ khoá mặt
                          }}
                          title="Xóa ảnh này"
                          className="shrink-0 rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {chosenFace && (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
              {savedChar ? (
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 font-medium text-green-600 dark:text-green-400">
                    <Check className="size-3.5" /> Đã lưu «{savedChar.name}»
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={resetAll}
                      className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 font-medium text-primary-foreground hover:opacity-90"
                    >
                      <Sparkles className="size-3" /> Tạo mới từ đầu
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    value={charName}
                    onChange={(e) => setCharName(e.target.value)}
                    placeholder="Tên nhân vật để lưu"
                    className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    onClick={saveCharacter}
                    disabled={savingChar || !charName.trim()}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {savingChar ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                    Lưu nhân vật
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* 2 · Scene */}
        <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">2 · Bối cảnh</h2>
            <div className="flex items-center gap-1">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted">
                <Upload className="size-3.5" /> Ảnh cảnh có sẵn
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    void uploadSceneRef(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => void inventDetails()}
                disabled={!!sceneRef || busy === 'details'}
                title="GPT bịa ra vật che tiền cảnh + đồ lộn xộn hậu cảnh hợp với đúng nơi này — mỗi lần bấm một kiểu khác"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40"
              >
                {busy === 'details' ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                GPT chi tiết
              </button>
              <button
                type="button"
                onClick={shuffleScene}
                disabled={!!sceneRef}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40"
                title={sceneRef ? 'Đang dùng ảnh cảnh tải lên — các lựa chọn bối cảnh không còn tác dụng' : 'Bốc ngẫu nhiên khu vực, bối cảnh, tư thế, ánh sáng, góc máy… để loạt ảnh không trùng nhau'}
              >
                <Shuffle className="size-3.5" /> Đổi cảnh
              </button>
            </div>
          </div>

          {/* Ảnh cảnh tải lên: khi có, KHÔNG sinh cảnh nữa mà ghép người vào đúng ảnh này.
              sceneRefIsPhoto: ảnh đã có sẵn người tạo dáng → giữ NGUYÊN mọi thứ, chỉ đổi mặt +
              trang phục (xem realPhotoMode/buildRealPhotoScenePrompt); tắt đi thì coi ảnh này
              chỉ là bối cảnh trống, vẫn tự chọn dáng qua field Tư thế như trước. */}
          {sceneRef && (
            <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2">
              <div className="flex items-center gap-2">
                <img
                  src={sceneRef}
                  alt=""
                  onClick={() => setZoomImageUrl(sceneRef)}
                  className="size-12 cursor-zoom-in rounded-md object-cover"
                />
                <span className="flex-1 text-xs text-muted-foreground">
                  {sceneRefIsPhoto ? (
                    <>Ảnh đã có sẵn người tạo dáng — <b>giữ nguyên y hệt ảnh gốc</b> (dáng, góc máy,
                      ánh sáng, bối cảnh), chỉ đổi <b>mặt</b> (và <b>trang phục</b> nếu đã sinh riêng
                      1 ảnh đồ bên dưới). Mọi ô dropdown bên dưới <b>tạm thời không dùng đến</b>.
                      {' '}Sinh nhiều ảnh một lần: <b>ảnh đầu bám nguyên ảnh gốc</b>, các ảnh sau tự
                      đổi <b>tư thế · góc mặt · kiểu cười · ánh mắt</b> (vẫn giữ nguyên bối cảnh và
                      góc máy). Nhãn dưới mỗi ảnh ghi rõ ảnh nào là ảnh nào.</>
                  ) : (
                    <>Ghép nhân vật vào <b>đúng ảnh cảnh này</b> — giữ nguyên nền, ánh sáng, góc máy.
                      Các ô Khu vực / Bối cảnh / Ánh sáng / Cỡ cảnh bên dưới <b>tạm thời không dùng đến</b>.</>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => { setSceneRef(''); setSceneRefIsPhoto(false); setSceneOverride(null) }}
                  className="shrink-0 rounded-md border border-border p-1 hover:bg-muted"
                  title="Bỏ ảnh cảnh, quay về sinh cảnh từ menu"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <button
                  type="button"
                  role="switch"
                  aria-checked={sceneRefIsPhoto}
                  onClick={() => setSceneRefIsPhoto((v) => !v)}
                  title="Bật: ảnh tải lên đã có sẵn người tạo dáng, chỉ đổi mặt + trang phục. Tắt: coi ảnh này là bối cảnh trống, tự chọn dáng như trước."
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${sceneRefIsPhoto ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                >
                  <span
                    className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform ${sceneRefIsPhoto ? 'translate-x-4' : 'translate-x-0.5'}`}
                  />
                </button>
                <span className="text-muted-foreground">Ảnh có sẵn người — chỉ đổi mặt + trang phục</span>
              </label>
            </div>
          )}

          {/* «Sau lưng» + «cận mặt» là hai lựa chọn đá nhau — prompt sẽ tự dịch thành cận
              GÁY, nhưng vẫn phải nói cho người dùng biết họ đang mâu thuẫn với chính mình.
              realPhotoMode: field cỡ cảnh/góc mặt đã ẩn (không còn ảnh hưởng gì) nên bỏ qua. */}
          {!realPhotoMode && hasFaceShotConflict(sceneSel) && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
              Anh chọn <b>Sau lưng</b> nhưng cỡ cảnh lại là <b>cận mặt</b> — hai cái này ngược nhau.
              Prompt sẽ hiểu là <b>cận gáy</b>. Muốn thấy mặt thì đổi Góc khuôn mặt sang Chính diện / 3/4.
            </p>
          )}

          {/* Tự cầm máy chụp mình thì không thể quay lưng vào ống kính. Chế độ selfie
              thắng, nhưng phải nói cho người dùng biết lựa chọn kia đang bị bỏ qua. */}
          {!realPhotoMode && hasSelfieBackConflict(sceneSel) && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
              Cỡ cảnh <b>Selfie dang tay</b> là cô tự cầm máy chụp mình, nên không thể đồng thời
              <b> quay lưng</b> vào ống kính. Prompt sẽ bỏ qua Góc khuôn mặt <b>Sau lưng</b>.
            </p>
          )}

          {chosenFace ? (
            <div className="flex items-center gap-2 rounded-lg bg-muted/30 p-2">
              <img src={chosenFace} alt="" className="size-12 rounded-md object-cover" />
              <span className="text-xs text-muted-foreground">Giữ khuôn mặt nhân vật đã chọn khi sinh cảnh.</span>
            </div>
          ) : (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
              Chưa chọn nhân vật → sinh cảnh sẽ ra người ngẫu nhiên. Sinh &amp; chọn nhân vật ở cột trái trước.
            </p>
          )}
          {/* realPhotoMode: ảnh gốc đã quyết định hết dáng/góc/ánh sáng/bối cảnh rồi, không còn
              field nào khác để chọn — ẩn hẳn thay vì chỉ ghi chú "tạm không dùng" (trước đây vẫn
              hiện & bấm được dù vô tác dụng, dễ gây hiểu lầm là còn ảnh hưởng). RIÊNG "Trang
              phục" vẫn PHẢI hiện: khối "Sinh bộ đồ" bên dưới đọc thẳng sceneSel.outfit, ẩn luôn
              ô này thì không còn cách nào chọn đồ trước khi sinh nữa (bug thật — mất hẳn phần
              chọn/nhập bộ đồ khi bật ảnh cảnh có sẵn người, đúng thứ anh báo). */}
          {realPhotoMode ? (
            outfitField && (
              <FieldSelect
                field={outfitField}
                value={sceneSel.outfit}
                onChange={(v) => setSceneSel((s) => ({ ...s, outfit: v }))}
              />
            )
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {sceneAdvanced
                    ? 'Chỉnh tay mọi thông số cảnh.'
                    : 'Chỉ chọn Trang phục + Bối cảnh — dáng / góc / ánh sáng… tự đổi khi ghép.'}
                </span>
                <button
                  type="button"
                  onClick={() => setSceneAdvanced((v) => !v)}
                  className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                >
                  {sceneAdvanced ? 'Đơn giản' : 'Tuỳ chỉnh nâng cao'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {QUICK_SCENE_FIELDS.filter((f) => sceneAdvanced || SIMPLE_SCENE_KEYS.has(f.key)).map((f) => (
                  <FieldSelect
                    key={f.key}
                    field={f}
                    value={sceneSel[f.key]}
                    onChange={(v) => setSceneSel((s) => ({ ...s, [f.key]: v }))}
                  />
                ))}
              </div>
            </>
          )}
          {/* Khoá bộ đồ + bối cảnh: sinh 2 ảnh ref (đồ flat-lay + nền trống), chọn, rồi
              «Sinh cảnh» ghép [nền, đồ, mặt] → cả loạt cùng đồ, cùng chỗ, chỉ khác dáng. */}
          <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                Khoá bộ đồ + bối cảnh{' '}
                <span className="font-normal text-muted-foreground">(mọi ảnh cùng đồ, cùng chỗ)</span>
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => void genOutfit()}
                  disabled={busy != null}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40"
                >
                  {busy === 'outfit' ? <Loader2 className="size-3 animate-spin" /> : <Shirt className="size-3" />} Sinh bộ đồ
                </button>
                <button
                  type="button"
                  onClick={() => void genBackground()}
                  disabled={busy != null || sceneRefIsPhoto}
                  title={sceneRefIsPhoto ? 'Đang dùng ảnh thật đã có sẵn người — tắt công tắc phía trên nếu muốn sinh bối cảnh AI mới' : undefined}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40"
                >
                  {busy === 'bg' ? <Loader2 className="size-3 animate-spin" /> : <MapPin className="size-3" />} Sinh bối cảnh
                </button>
              </div>
            </div>

            {outfitCands.length > 0 && (
              <div>
                <span className="text-[11px] text-muted-foreground">Chọn bộ đồ:</span>
                <div className="mt-1 flex gap-1.5 overflow-x-auto pb-1">
                  {outfitCands.map((c) => (
                    <img
                      key={c.id}
                      src={c.image}
                      alt=""
                      onClick={() => setOutfitRef(c.image)}
                      className={`size-14 shrink-0 cursor-pointer rounded-md object-cover ${outfitRef === c.image ? 'ring-2 ring-primary' : 'opacity-70 hover:opacity-100'}`}
                    />
                  ))}
                </div>
              </div>
            )}
            {bgCands.length > 0 && (
              <div>
                <span className="text-[11px] text-muted-foreground">Chọn bối cảnh:</span>
                <div className="mt-1 flex gap-1.5 overflow-x-auto pb-1">
                  {bgCands.map((c) => (
                    <img
                      key={c.id}
                      src={c.image}
                      alt=""
                      onClick={() => { setSceneRef(c.image); setSceneRefIsPhoto(false) }}
                      className={`size-14 shrink-0 cursor-pointer rounded-md object-cover ${sceneRef === c.image ? 'ring-2 ring-primary' : 'opacity-70 hover:opacity-100'}`}
                    />
                  ))}
                </div>
              </div>
            )}

            {(outfitRef || sceneRef) && (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                {outfitRef && (
                  <span className="inline-flex items-center gap-1.5">
                    <img src={outfitRef} alt="" onClick={() => setZoomImageUrl(outfitRef)} className="size-9 cursor-zoom-in rounded object-cover" />
                    <span className="font-medium text-green-600 dark:text-green-400">Đồ ✓</span>
                    <button type="button" onClick={() => { setOutfitRef(''); setOutfitCands([]) }} className="text-muted-foreground hover:underline">bỏ</button>
                  </span>
                )}
                {sceneRef && (
                  <span className="inline-flex items-center gap-1.5">
                    <img src={sceneRef} alt="" onClick={() => setZoomImageUrl(sceneRef)} className="size-9 cursor-zoom-in rounded object-cover" />
                    <span className="font-medium text-green-600 dark:text-green-400">Nền ✓</span>
                    <button type="button" onClick={() => { setSceneRef(''); setSceneRefIsPhoto(false); setBgCands([]) }} className="text-muted-foreground hover:underline">bỏ</button>
                  </span>
                )}
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              {realPhotoMode
                ? outfitRef
                  ? '✓ Ảnh thật + đồ + mặt đã đủ — bấm «Sinh cảnh» để đổi mặt và trang phục, giữ nguyên mọi thứ khác.'
                  : '✓ Ảnh thật + mặt đã đủ — bấm «Sinh cảnh» để đổi mặt (giữ nguyên trang phục gốc), hoặc bấm «Sinh bộ đồ» nếu muốn đổi luôn trang phục.'
                : composing
                  ? '✓ Đã khoá đồ + nền + mặt — bấm «Sinh cảnh» để ra loạt ảnh cùng đồ, cùng chỗ, khác dáng.'
                  : outfitRef || sceneRef
                    ? 'Cần đủ cả bộ đồ, bối cảnh và một khuôn mặt (chọn ở cột trái) để ghép.'
                    : 'Chọn Trang phục + Bối cảnh ở trên, rồi bấm “Sinh bộ đồ” / “Sinh bối cảnh”.'}
            </p>

            {/* count ô xem trước — chưa sinh ảnh thật, chỉ là prompt (mỗi ô tự random dáng/góc
                mặt riêng, xem useMemo scenePreviews ở trên). Bấm vào 1 ô để sửa tay prompt của
                ĐÚNG ô đó trước khi bấm «Sinh cảnh». */}
            {composing && scenePreviews.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">
                    Xem trước {scenePreviews.length} ảnh sắp sinh — bấm vào ô để sửa prompt riêng
                  </span>
                  <button
                    type="button"
                    onClick={() => { setReshuffleNonce((n) => n + 1); setPreviewOverrides({}) }}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium hover:bg-muted"
                    title="Random lại dáng/góc mặt cho cả loạt xem trước"
                  >
                    <Shuffle className="size-3" /> Đổi dáng
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {scenePreviews.map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setEditPreviewIndex(i)}
                      title="Bấm để sửa prompt ảnh này"
                      className="flex aspect-[2/3] flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border p-2 text-center hover:border-primary hover:bg-muted"
                    >
                      <Pencil className="size-4 text-muted-foreground" />
                      <span className="text-[11px] text-muted-foreground">Ảnh #{i + 1}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <PromptBox
            title="Prompt cảnh"
            built={scenePrompt}
            builtVi={scenePromptVi}
            override={sceneOverride}
            setOverride={setSceneOverride}
            onCopy={copyText}
            tail={sceneTail}
            lead={sceneLead}
          />
          {/* Lỗi sinh cảnh gần nhất. Khi là lỗi KIỂM DUYỆT và đang dùng GPT thì chỉ luôn
              lối thoát: đổi model. Đo được ngày 20/08 — cùng một ảnh gốc + ảnh mặt, bộ đồ
              áo dài ra 3/3 ảnh, bộ đồ bikini/áo bơi bị chặn 12/12; bộ đồ nằm trong ẢNH nên
              sửa chữ trong prompt không bao giờ cứu được, mà mỗi lần thử lại vẫn mất tiền. */}
          {sceneGenError && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-700 dark:text-red-400">
              <div className="flex items-start justify-between gap-2">
                <span className="flex-1">⚠️ {sceneGenError}</span>
                <button
                  type="button"
                  onClick={() => setSceneGenError(null)}
                  title="Đóng"
                  className="shrink-0 rounded-md p-0.5 hover:bg-red-500/10"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              {sceneProvider === 'openai' && /kiểm duyệt|nhạy cảm|moderation|từ chối/i.test(sceneGenError) && (
                <p className="flex items-start gap-1.5 text-red-700/80 dark:text-red-400/80">
                  <ArrowUp className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Nếu ảnh bộ đồ / ảnh cảnh là đồ bơi, đồ bó hoặc hở vai thì <b>sửa prompt không
                    cứu được</b> — thông tin đó nằm trong ẢNH. Đổi <b>«Model ảnh cảnh»</b> ở thanh
                    trên sang <b>Grok Imagine</b> rồi sinh lại.
                  </span>
                </p>
              )}
            </div>
          )}
          <button
            onClick={genScene}
            disabled={busy != null || sceneOverLimit}
            title={sceneOverLimit ? `Prompt vượt giới hạn ${MAX_IMAGE_PROMPT_LEN.toLocaleString('vi-VN')} ký tự — rút gọn bớt rồi sinh` : undefined}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy === 'scene' ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Sinh ảnh cảnh
          </button>
        </section>
      </div>

      {/* Results */}
      {shots.length > 0 && (
        <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Ảnh cảnh · {shots.length}</h2>
            <button
              onClick={() => setShots([])}
              className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-muted"
            >
              Xoá hết
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {shots.map((s) => (
              <div key={s.id} className="flex flex-col gap-1.5">
                <img
                  src={s.image}
                  alt=""
                  onClick={() => setZoomImageUrl(s.image)}
                  title="Bấm để phóng to"
                  className="aspect-[2/3] w-full cursor-zoom-in rounded-lg border border-border object-cover"
                />
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-xs text-muted-foreground">
                    #{s.id} · {s.label}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => saveShot(s)}
                      disabled={s.saved || savingShotId === s.id}
                      title={s.saved ? 'Đã lưu vào nhân vật' : 'Lưu vào nhân vật'}
                      className="rounded-md border border-border p-1 hover:bg-muted disabled:opacity-60"
                    >
                      {s.saved ? (
                        <Check className="size-3.5 text-green-600 dark:text-green-400" />
                      ) : savingShotId === s.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => setEditPromptShotId(s.id)}
                      title="Sửa prompt ảnh này"
                      className="rounded-md border border-border p-1 hover:bg-muted"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      onClick={() => setFilterShotId(s.id)}
                      title="Lọc màu (không tốn phí API)"
                      className="rounded-md border border-border p-1 hover:bg-muted"
                    >
                      <SlidersHorizontal className="size-3.5" />
                    </button>
                    <DownloadMenu
                      image={s.image}
                      onFull={() => void downloadFull(s.image, `canh-${s.id}.jpg`)}
                      onResize={(px) => void downloadResized(s.image, `canh-${s.id}.jpg`, px)}
                      onCrop={(ratio) => void downloadCropped(s.image, `canh-${s.id}.jpg`, ratio)}
                    />
                    <button
                      onClick={() => setShots((prev) => prev.filter((x) => x.id !== s.id))}
                      title="Xóa ảnh này"
                      className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Bảng lọc màu — overlay riêng, nằm đè lên trang. Cùng cách dùng như ở
          FaceSwapWizardLegacy và CharactersPage. */}
      {filterShotId !== null && (
        <FilterPicker
          image={shots.find((s) => s.id === filterShotId)?.image || ''}
          onClose={() => setFilterShotId(null)}
          onApply={(out) => {
            setShots((prev) => prev.map((s) => (s.id === filterShotId ? { ...s, image: out, saved: false } : s)))
            setFilterShotId(null)
          }}
        />
      )}

      {/* Sửa prompt riêng 1 ảnh cảnh rồi tạo lại — thay đúng ảnh đó tại chỗ, giữ nguyên
          các ảnh khác trong lô. Tái dùng ref đã lưu lúc sinh (xem genScene) nên "Tạo lại"
          vẫn khoá đúng mặt/đồ/nền như ảnh gốc. */}
      {editPromptShotId !== null && (() => {
        const target = shots.find((s) => s.id === editPromptShotId)
        if (!target) return null
        return (
          <EditPromptModal
            prompt={target.prompt || ''}
            onClose={() => setEditPromptShotId(null)}
            lockLead={!!target.ref}
            onRegenerate={async (newPrompt) => {
              try {
                const { quality, resolution } = providerArgs(sceneProvider)
                const { image } = await contentsApi.generateImage(
                  newPrompt, target.ref, !!target.ref, false, size, quality, sceneProvider, resolution,
                )
                setShots((prev) => prev.map((s) => (
                  s.id === editPromptShotId ? { ...s, image, prompt: newPrompt, saved: false } : s
                )))
                showToast('Đã tạo lại ảnh theo prompt mới.', 'success')
              } catch (error) {
                fail(error, 'Tạo lại ảnh thất bại.')
                throw error // giữ modal mở (EditPromptModal chỉ tự đóng khi onRegenerate resolve)
              }
            }}
          />
        )
      })()}

      {/* Sửa prompt 1 ô xem trước (chưa sinh) — chỉ lưu text, KHÔNG gọi API. genScene() sẽ
          đọc đúng bản đã sửa này khi bấm «Sinh cảnh» thật. */}
      {editPreviewIndex !== null && scenePreviews[editPreviewIndex] && (
        <EditPromptModal
          prompt={scenePreviews[editPreviewIndex].prompt}
          actionLabel="Lưu"
          actionIcon={<Check className="size-3.5" />}
          onClose={() => setEditPreviewIndex(null)}
          lockLead
          advanced={{
            pose: scenePreviews[editPreviewIndex].pose,
            head: scenePreviews[editPreviewIndex].head,
            rebuild: (pose, head) => buildOutfitScenePrompt({ ...sceneSel, pose, head }),
          }}
          onRegenerate={async (newPrompt) => {
            const key = scenePreviews[editPreviewIndex].key
            setPreviewOverrides((prev) => ({ ...prev, [key]: newPrompt }))
          }}
        />
      )}

      {/* Lightbox — ảnh full-screen (click nền hoặc nút × để đóng, Esc cũng đóng). */}
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
    </div>
  )
}
