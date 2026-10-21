/**
 * Dark, in-editor Photoshop-style RETOUCH overlay — 100% client-side (no server).
 * Brush tools on the working image:
 *   • Đẩy (Liquify / smudge-push)  • Mịn da (smooth)  • Làm mờ (blur)
 *   • Sáng (Dodge) / Tối (Burn)    • Đóng dấu (Clone stamp — Alt/right-click to set source)
 * Per-stroke undo (Ctrl+Z). "Xong" commits the edited image back to the editor.
 *
 * Everything runs on a single working <canvas> at the image's NATURAL resolution
 * so quality is preserved; brushes operate only on the local brush region for
 * smooth performance.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, Undo2, Wand2, X } from 'lucide-react'
import { useToast } from '@/context/ToastContext'

type Tool = 'push' | 'smooth' | 'blur' | 'dodge' | 'burn' | 'clone'
interface Props { image: string; onApply: (dataUri: string) => void; onClose: () => void }

const TOOLS: { t: Tool; label: string; hint: string }[] = [
  { t: 'push', label: 'Đẩy', hint: 'Kéo để đẩy/nắn pixel (làm thon, chỉnh dáng).' },
  { t: 'smooth', label: 'Mịn da', hint: 'Tô để làm mịn da / mờ nhẹ chi tiết.' },
  { t: 'blur', label: 'Làm mờ', hint: 'Tô tới đâu mờ tới đó — quẹt lại lần nữa để mờ đậm thêm. Cọ = vùng, Mạnh = độ mờ.' },
  { t: 'dodge', label: 'Sáng', hint: 'Tô để làm sáng cục bộ.' },
  { t: 'burn', label: 'Tối', hint: 'Tô để làm tối cục bộ.' },
  { t: 'clone', label: 'Đóng dấu', hint: 'Alt/chuột phải đặt nguồn, rồi tô để sao chép vùng đó.' },
]

export function RetouchOverlay({ image, onApply, onClose }: Props) {
  const { showToast } = useToast()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const snapshot = useRef<HTMLCanvasElement | null>(null) // frozen source for the current stroke (clone/push/smooth)
  const cloneSrc = useRef<{ x: number; y: number } | null>(null)
  const cloneOffset = useRef<{ x: number; y: number } | null>(null)
  const undoStack = useRef<ImageData[]>([])
  const [ready, setReady] = useState(false)
  const [tool, setTool] = useState<Tool>('push')
  const [brush, setBrush] = useState(60)
  const [strength, setStrength] = useState(50)
  const [canUndo, setCanUndo] = useState(false)

  // Load the image into the working canvas at natural resolution.
  useEffect(() => {
    const im = new Image()
    im.onload = () => {
      const c = canvasRef.current
      if (!c) return
      c.width = im.naturalWidth; c.height = im.naturalHeight
      c.getContext('2d')!.drawImage(im, 0, 0)
      setReady(true)
    }
    im.src = image
  }, [image])

  function coords(e: React.PointerEvent) {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) }
  }
  function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
    const o = document.createElement('canvas'); o.width = src.width; o.height = src.height
    o.getContext('2d')!.drawImage(src, 0, 0); return o
  }
  function pushUndo() {
    const c = canvasRef.current!; const ctx = c.getContext('2d')!
    undoStack.current.push(ctx.getImageData(0, 0, c.width, c.height))
    if (undoStack.current.length > 24) undoStack.current.shift()
    setCanUndo(true)
  }
  function undo() {
    const prev = undoStack.current.pop()
    if (!prev) return
    canvasRef.current!.getContext('2d')!.putImageData(prev, 0, 0)
    setCanUndo(undoStack.current.length > 0)
  }

  // Stamp a soft-edged circular patch from `src` (fromX,fromY) onto the working
  // canvas at (toX,toY) with feathered alpha.
  function softStamp(src: CanvasImageSource, fromX: number, fromY: number, toX: number, toY: number, r: number, alpha: number) {
    const ctx = canvasRef.current!.getContext('2d')!
    const d = Math.max(2, Math.round(r * 2))
    const tmp = document.createElement('canvas'); tmp.width = d; tmp.height = d
    const tctx = tmp.getContext('2d')!
    tctx.drawImage(src, fromX - r, fromY - r, d, d, 0, 0, d, d)
    tctx.globalCompositeOperation = 'destination-in'
    const g = tctx.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, d / 2)
    g.addColorStop(0, `rgba(0,0,0,${alpha})`); g.addColorStop(0.7, `rgba(0,0,0,${alpha * 0.5})`); g.addColorStop(1, 'rgba(0,0,0,0)')
    tctx.fillStyle = g; tctx.fillRect(0, 0, d, d)
    ctx.drawImage(tmp, Math.round(toX - r), Math.round(toY - r))
  }
  // Soft white/black radial in soft-light → local lighten / darken.
  function tone(toX: number, toY: number, r: number, alpha: number, lighten: boolean) {
    const ctx = canvasRef.current!.getContext('2d')!
    ctx.save()
    ctx.globalCompositeOperation = 'soft-light'
    const g = ctx.createRadialGradient(toX, toY, 0, toX, toY, r)
    const c = lighten ? '255,255,255' : '0,0,0'
    g.addColorStop(0, `rgba(${c},${alpha})`); g.addColorStop(1, `rgba(${c},0)`)
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(toX, toY, r, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }

  function apply(p: { x: number; y: number }) {
    const r = brush / 2
    const a = strength / 100
    const src = snapshot.current
    if (tool === 'dodge' || tool === 'burn') {
      tone(p.x, p.y, r, a * 0.35, tool === 'dodge')
    } else if (tool === 'smooth' || tool === 'blur') {
      // Same soft stamp for both; only the frozen source differs (see onDown) — blur
      // stamps at a higher alpha so one pass already reads as blurred, and stacking
      // strokes keeps blurring further because each stroke re-blurs the current canvas.
      if (src) softStamp(src, p.x, p.y, p.x, p.y, r, tool === 'blur' ? Math.min(1, a * 1.8) : a)
    } else if (tool === 'push') {
      if (src && last.current) {
        const dx = p.x - last.current.x, dy = p.y - last.current.y
        // sample from where the pixels came FROM (opposite the drag) → pushes along the drag.
        softStamp(src, p.x - dx, p.y - dy, p.x, p.y, r, Math.min(1, a * 1.4))
      }
    } else if (tool === 'clone') {
      if (src && cloneOffset.current) {
        softStamp(src, p.x + cloneOffset.current.x, p.y + cloneOffset.current.y, p.x, p.y, r, Math.min(1, a * 1.6))
      }
    }
    last.current = p
  }

  function onDown(e: React.PointerEvent) {
    if (!ready) return
    e.preventDefault()
    const p = coords(e)
    // Clone: Alt or right-button sets the source point.
    if (tool === 'clone' && (e.altKey || e.button === 2)) {
      cloneSrc.current = p
      showToast('Đã đặt nguồn sao chép. Giờ tô để đóng dấu.', 'success')
      return
    }
    if (tool === 'clone') {
      if (!cloneSrc.current) { showToast('Alt/chuột phải vào vùng nguồn trước.', 'error'); return }
      cloneOffset.current = { x: cloneSrc.current.x - p.x, y: cloneSrc.current.y - p.y }
    }
    pushUndo()
    // For smooth/blur, freeze a BLURRED copy as the source; otherwise freeze the canvas.
    // Mịn da only softens skin detail, so its radius stays small; Làm mờ is meant to hide
    // a whole region (a face, a logo, a background), so its radius scales with «Mạnh».
    if (tool === 'smooth' || tool === 'blur') {
      const radius = tool === 'blur'
        ? Math.max(4, Math.round((brush / 4) * (0.4 + strength / 100)))
        : Math.max(2, Math.round(brush / 8))
      const blur = cloneCanvas(canvasRef.current!)
      const bctx = blur.getContext('2d')!
      bctx.globalCompositeOperation = 'copy'
      bctx.filter = `blur(${radius}px)`
      bctx.drawImage(canvasRef.current!, 0, 0)
      bctx.filter = 'none'
      snapshot.current = blur
    } else {
      snapshot.current = cloneCanvas(canvasRef.current!)
    }
    drawing.current = true; last.current = null
    apply(p)
  }
  function onMove(e: React.PointerEvent) { if (drawing.current) apply(coords(e)) }
  function onUp() { drawing.current = false; last.current = null; snapshot.current = null }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo() }
      else if (e.key === 'Escape') commit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function commit() { const c = canvasRef.current; if (c) onApply(c.toDataURL('image/png')); onClose() }

  const curHint = TOOLS.find((x) => x.t === tool)?.hint || ''

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-neutral-900 text-white">
      <header className="flex h-[52px] flex-shrink-0 items-center gap-2 overflow-x-auto border-b border-white/10 bg-neutral-900 px-3">
        <span className="flex flex-shrink-0 items-center gap-1.5 text-sm font-semibold"><Wand2 className="size-4" /> Tút ảnh</span>
        <span className="mx-1 h-6 w-px flex-shrink-0 bg-white/15" />
        <div className="inline-flex flex-shrink-0 overflow-hidden rounded-md border border-white/15 text-xs">
          {TOOLS.map(({ t, label }) => (
            <button key={t} type="button" onClick={() => setTool(t)}
              className={`px-2.5 py-1 font-medium ${tool === t ? 'bg-white/20' : 'text-white/70 hover:bg-white/10'}`}>{label}</button>
          ))}
        </div>
        <span className="ml-1 flex flex-shrink-0 items-center gap-1.5 text-xs text-white/70">Cọ
          <input type="range" min={12} max={200} value={brush} onChange={(e) => setBrush(Number(e.target.value))} className="w-24" />
        </span>
        <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-white/70">Mạnh
          <input type="range" min={5} max={100} value={strength} onChange={(e) => setStrength(Number(e.target.value))} className="w-20" />
        </span>
        <button type="button" onClick={undo} disabled={!canUndo} title="Hoàn tác (Ctrl+Z)" className="ml-1 inline-flex flex-shrink-0 items-center gap-1 rounded p-1.5 hover:bg-white/10 disabled:opacity-30"><Undo2 className="size-4" /> Hoàn tác</button>
        <div className="ml-auto flex flex-shrink-0 items-center gap-2 pl-2">
          <button type="button" onClick={commit} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500">Xong</button>
          <button type="button" onClick={onClose} title="Đóng (huỷ)" className="rounded p-1.5 hover:bg-white/10"><X className="size-5" /></button>
        </div>
      </header>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-neutral-800 p-4">
        {!ready && <Loader2 className="size-6 animate-spin text-white/60" />}
        <canvas ref={canvasRef}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
          onContextMenu={(e) => e.preventDefault()}
          className="max-h-[80vh] w-auto max-w-full rounded"
          style={{ cursor: 'crosshair', touchAction: 'none', display: ready ? 'block' : 'none' }} />
        <p className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/50 px-2 py-0.5 text-[11px] text-white/70">{curHint} · Ctrl+Z hoàn tác</p>
      </div>
    </div>
  )
}
