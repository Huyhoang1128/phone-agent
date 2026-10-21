/**
 * Instagram-style colour-filter picker. Shows a large preview of one image and a
 * strip of pilgram filters; "Áp dụng" hands the chosen image back via onApply.
 *
 * Renders as its own fixed overlay so it can sit on top of the face-swap wizard.
 *
 * BA CỠ ẢNH, VÌ SAO. Bản đầu gửi ảnh FULL cho mỗi filter, mỗi lần một cái, và chỉ
 * khi người dùng bấm vào filter đó: 2,25 MB base64 đi lên + ~470 KB đi về cho mỗi
 * lần bấm, còn dải filter thì hiện 13 ô giống hệt nhau (đều là ảnh gốc) nên muốn
 * biết filter nào ra sao thì phải bấm hết 13 lần — người dùng báo "áp filter không
 * được" chính là chỗ này. Giờ chia ba cỡ:
 *
 *   - dải filter: THUMB_EDGE px, dựng ảnh mẫu nhỏ ở máy khách rồi gửi lên một lần
 *     cho mỗi filter → 13 ô hiện đúng màu thật của nó, đo được ~37 KB mỗi ô;
 *   - ô xem trước lớn: PREVIEW_EDGE px, lấy khi người dùng chọn filter — đủ nét
 *     trên màn hình mà chỉ ~310 KB (ảnh full là ~576 KB);
 *   - ảnh full: CHỈ lấy đúng một lần, lúc bấm "Áp dụng", vì đó là ảnh sẽ được lưu.
 *
 * Cả ba đều gửi `storedRef(image)`: ảnh nào đã được cất vào kho (xem
 * lib/imageStore.ts) thì chỉ gửi URL vài trăm byte và backend tự tải về, nên phần
 * upload nặng biến mất hoàn toàn.
 *
 * Props:
 *   image    — the source image as a data URI / URL
 *   onApply  — called with the chosen (possibly filtered) image data URI
 *   onClose  — called when the user cancels or closes
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { contentsApi } from '@/lib/api'
import { thumbnailDataUri } from '@/lib/image'
import { storedRef } from '@/lib/imageStore'
import { useToast } from '@/context/ToastContext'

interface Props {
  image: string
  onApply: (dataUri: string) => void
  onClose: () => void
  // Label for the confirm button (default "Áp dụng"). e.g. "Lưu thành ảnh mới".
  applyLabel?: string
  // When true the confirm button shows a spinner and the picker is locked —
  // used when onApply runs an async save the parent owns.
  applyBusy?: boolean
}

// Curated subset of pilgram filters (BE allow-lists the full set). '' = no
// filter (the untouched original). Labels are the recognisable IG filter names.
const FILTERS: { name: string; label: string }[] = [
  { name: '', label: 'Gốc' },
  { name: 'clarendon', label: 'Clarendon' },
  { name: 'gingham', label: 'Gingham' },
  { name: 'lark', label: 'Lark' },
  { name: 'mayfair', label: 'Mayfair' },
  { name: 'aden', label: 'Aden' },
  { name: 'valencia', label: 'Valencia' },
  { name: 'brooklyn', label: 'Brooklyn' },
  { name: 'nashville', label: 'Nashville' },
  { name: 'rise', label: 'Rise' },
  { name: 'reyes', label: 'Reyes' },
  { name: 'moon', label: 'Moon · B&W' },
  { name: 'inkwell', label: 'Inkwell · B&W' },
]

// Ô trong dải chỉ cao 48px (h-12) trên màn hình thường, 260 là dư cho màn Retina.
const THUMB_EDGE = 260
// Ô xem trước lớn rộng tối đa ~480px (max-w-lg), 1024 là dư cho màn Retina.
const PREVIEW_EDGE = 1024
// Số request filter chạy cùng lúc khi mở dải. Việc của server là xử lý điểm ảnh
// (không gọi OpenAI, không qua hạn mức sinh ảnh) và mỗi ảnh mẫu chỉ ~50ms.
const STRIP_CONCURRENCY = 4

export function FilterPicker({ image, onApply, onClose, applyLabel, applyBusy = false }: Props) {
  const { showToast } = useToast()
  // name → ảnh mẫu nhỏ cho dải filter ('' = ảnh gốc, không cần gọi server).
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  // name → bản xem trước cỡ PREVIEW_EDGE cho ô lớn.
  const [previews, setPreviews] = useState<Record<string, string>>({ '': image })
  const [selected, setSelected] = useState('')
  // Đang lấy bản xem trước của filter nào (chỉ để hiện vòng xoay trên ô đó).
  const [busy, setBusy] = useState<string | null>(null)
  // Đang lấy ảnh full sau khi bấm "Áp dụng".
  const [applying, setApplying] = useState(false)
  // Ảnh full đã lấy được, để bấm "Áp dụng" hai lần không gọi lại server.
  const fullRef = useRef<Map<string, string>>(new Map())
  // Component còn sống hay đã đóng — chặn setState sau khi đóng modal. PHẢI đặt
  // lại true khi mount: StrictMode ở dev mount → unmount → mount lại, nên nếu chỉ
  // có nhánh cleanup thì sau lần giả-unmount cờ này mắc ở false mãi và mọi
  // setState bị chặn — dải filter gọi API xong nhưng không ô nào đổi màu (đã dựng
  // lại đúng lỗi này trên trình duyệt trước khi sửa).
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // Dựng cả dải filter ngay khi mở: một ảnh mẫu nhỏ ở máy khách, rồi gửi nó lên
  // cho từng filter. Ảnh khác miền không vẽ được ra canvas (canvas bị "bẩn") →
  // gửi thẳng URL và để backend tự tải về, vẫn nhẹ vì payload chỉ là cái URL.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const src = await thumbnailDataUri(image, THUMB_EDGE).catch(() => storedRef(image))
      if (cancelled) return
      setThumbs((prev) => ({ ...prev, '': src }))
      const names = FILTERS.map((f) => f.name).filter(Boolean)
      let next = 0
      const worker = async () => {
        while (next < names.length && !cancelled) {
          const name = names[next++]
          try {
            const { image: out } = await contentsApi.applyFilter(src, name, THUMB_EDGE)
            if (!cancelled && aliveRef.current) setThumbs((prev) => ({ ...prev, [name]: out }))
          } catch {
            // Một filter lỗi thì ô đó cứ hiện ảnh gốc — không chặn 12 ô còn lại.
          }
        }
      }
      await Promise.all(Array.from({ length: STRIP_CONCURRENCY }, worker))
    })()
    return () => { cancelled = true }
  }, [image])

  // Ô lớn: ưu tiên bản xem trước đã có; chưa có thì tạm dùng ảnh mẫu nhỏ (hơi mềm
  // trong khoảng một giây) để bấm vào là thấy màu đổi ngay, không phải nhìn ảnh cũ.
  const preview = previews[selected] ?? thumbs[selected] ?? image

  async function choose(name: string) {
    setSelected(name)
    if (previews[name] || !name) return
    setBusy(name)
    try {
      const { image: out } = await contentsApi.applyFilter(storedRef(image), name, PREVIEW_EDGE)
      if (aliveRef.current) setPreviews((prev) => ({ ...prev, [name]: out }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Áp dụng filter thất bại'
      showToast(message, 'error')
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }

  // "Áp dụng" mới là lúc cần ảnh FULL — đây là ảnh sẽ được lưu, nên không thể
  // dùng bản xem trước đã co nhỏ. "Gốc" thì trả lại đúng ảnh ban đầu, khỏi gọi.
  async function handleApply() {
    if (!selected) { onApply(image); return }
    const cached = fullRef.current.get(selected)
    if (cached) { onApply(cached); return }
    setApplying(true)
    try {
      const { image: out } = await contentsApi.applyFilter(storedRef(image), selected)
      fullRef.current.set(selected, out)
      onApply(out)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Áp dụng filter thất bại'
      showToast(message, 'error')
    } finally {
      if (aliveRef.current) setApplying(false)
    }
  }

  const locked = applyBusy || applying

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col gap-3 rounded-xl border border-border bg-background p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Chọn filter màu</p>
          <button type="button" onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        <div className="relative">
          <img src={preview} alt="preview"
            className="aspect-square w-full rounded-lg border border-border bg-muted/30 object-contain" />
          {busy && (
            <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/25">
              <Loader2 className="size-6 animate-spin text-white" />
            </span>
          )}
        </div>

        <div className="grid grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-5">
          {FILTERS.map((f) => {
            const active = selected === f.name
            // Ô nào chưa có ảnh mẫu thì hiện ảnh gốc kèm vòng xoay — dải luôn kín
            // ô, không nhảy layout khi từng ảnh mẫu về.
            const shot = thumbs[f.name]
            return (
              <button key={f.name || 'original'} type="button" onClick={() => choose(f.name)}
                disabled={locked}
                className={`relative flex flex-col items-center gap-1 rounded-lg border p-1 text-[10px] font-medium transition disabled:opacity-50 ${
                  active ? 'border-primary ring-2 ring-primary' : 'border-border hover:bg-muted'
                }`}>
                <span className="relative block h-12 w-full overflow-hidden rounded-md bg-muted/30">
                  <img src={shot ?? thumbs[''] ?? image} alt={f.label}
                    className="h-full w-full object-cover" />
                  {!shot && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/30">
                      <Loader2 className="size-3.5 animate-spin text-white" />
                    </span>
                  )}
                  {active && (
                    <span className="absolute right-0.5 top-0.5 rounded-full bg-primary p-0.5 text-primary-foreground">
                      <Check className="size-3" />
                    </span>
                  )}
                </span>
                <span className="truncate">{f.label}</span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={locked}>Hủy</Button>
          <Button size="sm" onClick={handleApply} disabled={locked} className="gap-1.5">
            {locked ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {applyLabel ?? 'Áp dụng'}
          </Button>
        </div>
      </div>
    </div>
  )
}
