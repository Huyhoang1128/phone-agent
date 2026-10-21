/**
 * "Ghép mặt" (face-swap) tab of the create-character wizard.
 *
 * Two image inputs — source (the face/identity) and target (the image whose face
 * gets replaced) — each either uploaded from the computer or picked from the
 * character's available media. Both go to the self-hosted face-swap gateway via
 * the Django proxy (`contentsApi.faceSwap` → `/contents/face-swap/`), which tries
 * every engine it exposes (FaceFusion, Deep-Live-Cam) in parallel; the user picks
 * whichever result they prefer, then downloads it or saves it into the character
 * with the wizard's own saver (`onSaveMedia`, the same one every other tab uses).
 *
 * Kept in its own file so FaceSwapWizard only gains a mode + a one-line branch.
 */
import { useState } from 'react'
import { Check, Download, Loader2, Save, Sparkles, Upload, X } from 'lucide-react'
import { contentsApi } from '@/lib/api'

const ENGINE_LABELS: Record<string, string> = {
  facefusion: 'FaceFusion',
  deeplivecam: 'Deep-Live-Cam',
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Không đọc được ảnh.'))
    reader.readAsDataURL(file)
  })
}

function ImageSlot({
  label,
  hint,
  value,
  onChange,
  availableMedia,
}: {
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
  availableMedia: string[]
}) {
  async function onPick(file: File | null) {
    if (!file) return
    onChange(await readFileAsDataUrl(file))
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
      {value ? (
        <div className="relative">
          <img
            src={value}
            alt={label}
            className="h-40 w-full rounded-md border border-border bg-muted/30 object-contain"
          />
          <button
            type="button"
            onClick={() => onChange('')}
            title="Bỏ ảnh"
            className="absolute right-1 top-1 inline-flex items-center gap-1 rounded-md bg-background/80 px-1.5 py-0.5 text-xs hover:bg-background"
          >
            <X className="size-3" /> Bỏ
          </button>
        </div>
      ) : (
        <label className="flex h-40 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-xs text-muted-foreground hover:bg-muted/30">
          <Upload className="size-4" />
          <span>Tải ảnh lên</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />
        </label>
      )}
      {availableMedia.length > 0 && (
        <>
          <span className="text-[11px] text-muted-foreground">hoặc chọn từ media nhân vật:</span>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {availableMedia.map((url) => (
              <button
                key={url}
                type="button"
                onClick={() => onChange(url)}
                title="Chọn ảnh này"
                className={`shrink-0 overflow-hidden rounded-md border ${
                  value === url ? 'border-foreground ring-2 ring-ring' : 'border-border hover:border-foreground/50'
                }`}
              >
                <img src={url} alt="" className="size-12 object-cover" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default function FaceSwapPanel({
  availableMedia,
  onSaveMedia,
  savedMediaUrls,
  savingMedia,
  download,
}: {
  availableMedia: string[]
  onSaveMedia: (img: string) => Promise<boolean>
  savedMediaUrls: Set<string>
  savingMedia: string | null
  download: (src: string, filename: string) => void
}) {
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<Record<string, string>>({})
  const [engineErrors, setEngineErrors] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')

  async function runSwap() {
    if (!source || !target) {
      setError('Cần cả ảnh nguồn (khuôn mặt) và ảnh đích.')
      return
    }
    setError('')
    setLoading(true)
    setResults({})
    setEngineErrors({})
    setSelected('')
    try {
      const res = await contentsApi.faceSwap(source, target)
      setResults(res.results || {})
      setEngineErrors(res.errors || {})
      const firstImage = Object.values(res.results || {})[0]
      if (firstImage) setSelected(firstImage)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ghép mặt thất bại.')
    } finally {
      setLoading(false)
    }
  }

  const saved = selected ? savedMediaUrls.has(selected) : false
  const resultEntries = Object.entries(results)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Ghép khuôn mặt từ <b>ảnh nguồn</b> lên <b>ảnh đích</b> — chạy song song FaceFusion và Deep-Live-Cam, tự chọn kết quả ưng ý. Mỗi ô: tải ảnh lên hoặc chọn từ media nhân vật.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ImageSlot
          label="Ảnh nguồn (khuôn mặt)"
          hint="Lấy khuôn mặt từ ảnh này"
          value={source}
          onChange={setSource}
          availableMedia={availableMedia}
        />
        <ImageSlot
          label="Ảnh đích (giữ dáng/cảnh)"
          hint="Thay khuôn mặt trên ảnh này"
          value={target}
          onChange={setTarget}
          availableMedia={availableMedia}
        />
      </div>
      <button
        type="button"
        onClick={runSwap}
        disabled={loading || !source || !target}
        className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
        Ghép mặt
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {Object.entries(engineErrors).map(([engine, detail]) => (
        <p key={engine} className="text-xs text-destructive">
          {ENGINE_LABELS[engine] ?? engine}: {detail}
        </p>
      ))}
      {resultEntries.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Kết quả — chọn ảnh muốn dùng</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {resultEntries.map(([engine, image]) => {
              const active = selected === image
              return (
                <button
                  key={engine}
                  type="button"
                  onClick={() => setSelected(image)}
                  title="Chọn ảnh này"
                  className={`flex flex-col gap-1.5 rounded-lg border p-2 text-left ${
                    active ? 'border-foreground ring-2 ring-ring' : 'border-border hover:border-foreground/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{ENGINE_LABELS[engine] ?? engine}</span>
                    {active && <Check className="size-3.5 text-green-600" />}
                  </div>
                  <img
                    src={image}
                    alt={`Kết quả ${ENGINE_LABELS[engine] ?? engine}`}
                    className="w-full rounded-md bg-muted/30 object-contain"
                  />
                </button>
              )
            })}
          </div>
          <div className="flex gap-1.5 sm:max-w-xs">
            <button
              type="button"
              onClick={() => onSaveMedia(selected)}
              disabled={!selected || saved || savingMedia === selected}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40"
            >
              {savingMedia === selected ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : saved ? (
                <Check className="size-3.5 text-green-600" />
              ) : (
                <Save className="size-3.5" />
              )}
              {saved ? 'Đã lưu' : 'Lưu vào nhân vật'}
            </button>
            <button
              type="button"
              onClick={() => selected && download(selected, 'ghep-mat.jpg')}
              disabled={!selected}
              className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40"
            >
              <Download className="size-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
