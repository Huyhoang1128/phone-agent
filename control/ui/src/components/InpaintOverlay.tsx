/**
 * Dark, in-editor "remove object" (LaMa inpaint) overlay — themed to match the
 * Canva editor. The user brushes a red mask over an unwanted area; on mouse-up
 * it AUTO-runs the inpaint and replaces the working image (no extra button).
 * Ctrl+Z reverts the last removal. "Xong" commits the final image back.
 *
 * The mask canvas runs at the image's NATURAL resolution so the exported mask
 * lines up 1:1 with the image regardless of on-screen scaling.
 */
import { useEffect, useRef, useState } from 'react'
import { Eraser, Loader2, Undo2, X } from 'lucide-react'
import { contentsApi } from '@/lib/api'
import { useToast } from '@/context/ToastContext'

interface Props {
  image: string // source image as a data URI
  onApply: (dataUri: string) => void // commit the (possibly edited) image back
  onClose: () => void
}

export function InpaintOverlay({ image, onApply, onClose }: Props) {
  const { showToast } = useToast()
  const maskRef = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const painted = useRef(false)
  const undoStack = useRef<string[]>([])
  const [cur, setCur] = useState(image)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [brush, setBrush] = useState(30)
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush')
  const [busy, setBusy] = useState(false)
  const [canUndo, setCanUndo] = useState(false)

  // Size the mask canvas to the current image's natural resolution.
  useEffect(() => { const im = new Image(); im.onload = () => setDims({ w: im.naturalWidth, h: im.naturalHeight }); im.src = cur }, [cur])
  useEffect(() => {
    const c = maskRef.current
    if (!dims || !c) return
    c.width = dims.w; c.height = dims.h
    c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    painted.current = false
  }, [dims])

  function coords(e: React.PointerEvent) {
    const c = maskRef.current!
    const r = c.getBoundingClientRect()
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) }
  }
  function paint(p: { x: number; y: number }) {
    const ctx = maskRef.current?.getContext('2d')
    if (!ctx) return
    const erasing = tool === 'eraser'
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over'
    const col = erasing ? 'rgba(0,0,0,1)' : 'rgba(255,40,40,0.85)'
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = brush; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    if (last.current) { ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke() }
    else { ctx.beginPath(); ctx.arc(p.x, p.y, brush / 2, 0, Math.PI * 2); ctx.fill() }
    ctx.globalCompositeOperation = 'source-over'
    last.current = p
    if (!erasing) painted.current = true
  }
  function exportMask(): string {
    const src = maskRef.current!
    const out = document.createElement('canvas')
    out.width = src.width; out.height = src.height
    const octx = out.getContext('2d')!
    const sd = src.getContext('2d')!.getImageData(0, 0, src.width, src.height).data
    const od = octx.createImageData(out.width, out.height)
    for (let i = 0; i < sd.length; i += 4) {
      const on = sd[i + 3] > 10
      od.data[i] = od.data[i + 1] = od.data[i + 2] = on ? 255 : 0
      od.data[i + 3] = 255
    }
    octx.putImageData(od, 0, 0)
    return out.toDataURL('image/png')
  }
  function clearMask() { const c = maskRef.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height); painted.current = false }

  // Auto-run on mouse-up: brush a region → release → it disappears.
  async function runAuto() {
    if (busy || tool === 'eraser' || !painted.current) return
    setBusy(true)
    const mask = exportMask()
    const prev = cur
    try {
      const { image: result } = await contentsApi.removeText(cur, mask)
      undoStack.current.push(prev); setCanUndo(true)
      setCur(result) // dims effect resets + clears the mask
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Xoá thất bại (kiểm tra dịch vụ inpaint).', 'error')
      clearMask()
    } finally { setBusy(false) }
  }
  function undo() {
    const prev = undoStack.current.pop()
    if (prev === undefined) return
    setCur(prev); setCanUndo(undoStack.current.length > 0)
  }

  function onDown(e: React.PointerEvent) { if (busy) return; e.preventDefault(); drawing.current = true; last.current = null; paint(coords(e)) }
  function onMove(e: React.PointerEvent) { if (drawing.current && !busy) paint(coords(e)) }
  function onUp() { if (!drawing.current) return; drawing.current = false; last.current = null; runAuto() }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo() }
      else if (e.key === 'Escape') { onApply(cur); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cur])

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-neutral-900 text-white">
      {/* Top bar — same dark style as the editor header */}
      <header className="flex h-[52px] flex-shrink-0 items-center gap-2 border-b border-white/10 bg-neutral-900 px-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold"><Eraser className="size-4" /> Tẩy / Xoá vật thừa</span>
        <span className="mx-1 h-6 w-px bg-white/15" />
        <div className="inline-flex overflow-hidden rounded-md border border-white/15 text-xs">
          {(['brush', 'eraser'] as const).map((tl) => (
            <button key={tl} type="button" onClick={() => setTool(tl)}
              className={`px-2.5 py-1 font-medium ${tool === tl ? 'bg-white/20' : 'text-white/70 hover:bg-white/10'}`}>
              {tl === 'brush' ? 'Vẽ' : 'Tẩy'}
            </button>
          ))}
        </div>
        <span className="ml-1 flex items-center gap-1.5 text-xs text-white/70">Cọ
          <input type="range" min={8} max={90} value={brush} onChange={(e) => setBrush(Number(e.target.value))} className="w-24" />
        </span>
        <button type="button" onClick={undo} disabled={!canUndo || busy} title="Hoàn tác (Ctrl+Z)" className="ml-1 inline-flex items-center gap-1 rounded p-1.5 hover:bg-white/10 disabled:opacity-30">
          <Undo2 className="size-4" /> Hoàn tác
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => { onApply(cur); onClose() }} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500">Xong</button>
          <button type="button" onClick={onClose} title="Đóng (huỷ)" className="rounded p-1.5 hover:bg-white/10"><X className="size-5" /></button>
        </div>
      </header>

      {/* Canvas */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-neutral-800 p-4">
        <div className="relative inline-block" style={{ touchAction: 'none' }}>
          <img src={cur} alt="" className="block max-h-[80vh] w-auto select-none rounded" draggable={false} />
          <canvas ref={maskRef}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
            className="absolute inset-0 h-full w-full opacity-60"
            style={{ cursor: busy ? 'wait' : 'crosshair' }} />
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <span className="inline-flex items-center gap-2 rounded-md bg-black/70 px-3 py-1.5 text-sm"><Loader2 className="size-4 animate-spin" /> Đang xoá…</span>
            </div>
          )}
        </div>
        <p className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/50 px-2 py-0.5 text-[11px] text-white/70">
          Bôi đỏ lên vật cần xoá rồi nhả chuột — tự xoá · Ctrl+Z hoàn tác · "Tẩy" để gỡ bớt vùng bôi
        </p>
      </div>
    </div>
  )
}
