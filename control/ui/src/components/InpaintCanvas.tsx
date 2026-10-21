/**
 * Mask editor for text/object removal. Shows the source image with a paint-over
 * mask layer; the user brushes the region to erase (red) — or clicks "Tự dò chữ"
 * to pre-fill text boxes via OCR — then "Xóa chữ" inpaints it via the backend
 * (self-hosted LaMa). The result is handed back via onResult.
 *
 * The mask canvas runs at the image's NATURAL resolution so the exported mask
 * lines up 1:1 with the image, regardless of on-screen scaling.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { contentsApi } from '@/lib/api'
import { useToast } from '@/context/ToastContext'

interface Props {
  image: string // source image as a data URI
  onResult: (dataUri: string) => void
}

export function InpaintCanvas({ image, onResult }: Props) {
  const { showToast } = useToast()
  const maskRef = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [brush, setBrush] = useState(28)
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush')
  const [busy, setBusy] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [hasMask, setHasMask] = useState(false)
  const [error, setError] = useState('')

  // Read the image's natural size, then size the mask canvas to match.
  useEffect(() => {
    const im = new Image()
    im.onload = () => setDims({ w: im.naturalWidth, h: im.naturalHeight })
    im.src = image
  }, [image])

  useEffect(() => {
    const c = maskRef.current
    if (!dims || !c) return
    c.width = dims.w
    c.height = dims.h
    c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    setHasMask(false)
  }, [dims])

  function toImageCoords(e: React.PointerEvent) {
    const c = maskRef.current!
    const rect = c.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (c.width / rect.width),
      y: (e.clientY - rect.top) * (c.height / rect.height),
    }
  }

  function paintTo(p: { x: number; y: number }) {
    const ctx = maskRef.current?.getContext('2d')
    if (!ctx) return
    const erasing = tool === 'eraser'
    // Eraser removes painted pixels (destination-out); brush adds the red mask.
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over'
    const color = erasing ? 'rgba(0,0,0,1)' : 'rgba(255,40,40,0.85)'
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = brush
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (last.current) {
      ctx.beginPath()
      ctx.moveTo(last.current.x, last.current.y)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.arc(p.x, p.y, brush / 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
    last.current = p
    if (!erasing && !hasMask) setHasMask(true)
  }

  function onDown(e: React.PointerEvent) {
    e.preventDefault()
    drawing.current = true
    last.current = null
    paintTo(toImageCoords(e))
  }
  function onMove(e: React.PointerEvent) {
    if (drawing.current) paintTo(toImageCoords(e))
  }
  function stop() {
    drawing.current = false
    last.current = null
  }

  function clearMask() {
    const c = maskRef.current
    if (!c) return
    c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    setHasMask(false)
  }

  async function autoDetect() {
    setError('')
    setOcrBusy(true)
    try {
      const { boxes } = await contentsApi.detectText(image)
      const ctx = maskRef.current?.getContext('2d')
      if (!ctx) return
      if (!boxes.length) {
        showToast('Không tìm thấy chữ in. Anh bôi tay vùng cần xóa nhé.', 'info')
        return
      }
      ctx.fillStyle = 'rgba(255,40,40,0.85)'
      const pad = 4
      boxes.forEach((b) => ctx.fillRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2))
      setHasMask(true)
      showToast(`Đã khoanh ${boxes.length} vùng chữ — chỉnh lại nếu cần rồi bấm "Xóa chữ".`, 'success')
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Dò chữ thất bại'
      setError(m)
      showToast(m, 'error')
    } finally {
      setOcrBusy(false)
    }
  }

  // Flatten the painted layer into a black/white mask (white = erase).
  function exportMask(): string {
    const src = maskRef.current!
    const out = document.createElement('canvas')
    out.width = src.width
    out.height = src.height
    const octx = out.getContext('2d')!
    const srcData = src.getContext('2d')!.getImageData(0, 0, src.width, src.height).data
    const od = octx.createImageData(out.width, out.height)
    for (let i = 0; i < srcData.length; i += 4) {
      const painted = srcData[i + 3] > 10
      od.data[i] = od.data[i + 1] = od.data[i + 2] = painted ? 255 : 0
      od.data[i + 3] = 255
    }
    octx.putImageData(od, 0, 0)
    return out.toDataURL('image/png')
  }

  async function runInpaint() {
    if (!hasMask) {
      setError('Hãy bôi (hoặc dò) vùng cần xoá trước.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const { image: result } = await contentsApi.removeText(image, exportMask())
      onResult(result)
      clearMask()
      showToast('Đã xoá xong.', 'success')
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Xoá thất bại'
      setError(m)
      showToast(m, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative w-full overflow-hidden rounded-lg border border-border bg-muted/30" style={{ touchAction: 'none' }}>
        <img src={image} alt="source" className="block w-full select-none" draggable={false} />
        <canvas ref={maskRef}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerLeave={stop}
          className="absolute inset-0 h-full w-full cursor-crosshair opacity-60" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={autoDetect} disabled={ocrBusy || busy} className="gap-1.5">
          {ocrBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          Tự dò chữ
        </Button>
        <div className="inline-flex overflow-hidden rounded-lg border border-border text-xs">
          {(['brush', 'eraser'] as const).map((tl) => (
            <button key={tl} type="button" onClick={() => setTool(tl)}
              className={`px-2.5 py-1 font-medium transition-colors ${
                tool === tl ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'
              }`}>
              {tl === 'brush' ? 'Vẽ' : 'Tẩy'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Cọ</span>
          <input type="range" min={6} max={80} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={clearMask} disabled={busy || !hasMask} className="gap-1.5">
          <Trash2 className="size-3.5" />
          Xóa vùng chọn
        </Button>
        <Button type="button" size="sm" onClick={runInpaint} disabled={busy || !hasMask} className="gap-1.5">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          Xoá vật / chữ
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Bôi đè (màu đỏ) lên vùng cần xoá — chữ, vật thừa, tóc lòa xòa, mụn… — hoặc bấm "Tự dò chữ" cho chữ in; dùng "Tẩy" gỡ bớt vùng không muốn, rồi bấm "Xoá vật / chữ". Vùng được bôi sẽ được lấp lại theo nền xung quanh.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
