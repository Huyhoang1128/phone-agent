/**
 * Lightweight crop/framing tool — pan (drag) + zoom over a fixed-aspect frame.
 * It does NOT export pixels (the character images are cross-origin S3, which
 * would taint a canvas); instead it returns a NORMALISED crop rect {x,y,w,h} in
 * 0..1 of the natural image, and the backend crops with Pillow. No new deps.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, Move, X, ZoomIn } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface CropRect { x: number; y: number; w: number; h: number }

const FRAME_W = 420 // display width of the crop frame (px)

export default function ImageCropper({ src, aspect, title, onCancel, onConfirm }: {
  src: string
  aspect: number // frame width / height (avatar = 1, cover ≈ 2.63)
  title: string
  onCancel: () => void
  onConfirm: (rect: CropRect) => void
}) {
  const frameW = FRAME_W
  const frameH = Math.round(FRAME_W / aspect)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  // Base scale so the image COVERS the frame at zoom = 1.
  const base = nat ? Math.max(frameW / nat.w, frameH / nat.h) : 1
  const scale = base * zoom
  const drawW = nat ? nat.w * scale : frameW
  const drawH = nat ? nat.h * scale : frameH
  const maxX = Math.max(0, (drawW - frameW) / 2)
  const maxY = Math.max(0, (drawH - frameH) / 2)
  const clampedX = Math.max(-maxX, Math.min(maxX, off.x))
  const clampedY = Math.max(-maxY, Math.min(maxY, off.y))
  const posX = (frameW - drawW) / 2 + clampedX
  const posY = (frameH - drawH) / 2 + clampedY

  // Re-clamp the offset whenever zoom/image changes.
  useEffect(() => { setOff((o) => ({ x: Math.max(-maxX, Math.min(maxX, o.x)), y: Math.max(-maxY, Math.min(maxY, o.y)) })) }, [zoom, nat]) // eslint-disable-line react-hooks/exhaustive-deps

  function onPointerDown(e: React.PointerEvent) {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, ox: clampedX, oy: clampedY }
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return
    setOff({ x: drag.current.ox + (e.clientX - drag.current.x), y: drag.current.oy + (e.clientY - drag.current.y) })
  }
  function onPointerUp() { drag.current = null }

  function confirm() {
    if (!nat) return
    const sx = -posX / scale
    const sy = -posY / scale
    const sw = frameW / scale
    const sh = frameH / scale
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
    onConfirm({
      x: clamp01(sx / nat.w),
      y: clamp01(sy / nat.h),
      w: clamp01(sw / nat.w),
      h: clamp01(sh / nat.h),
    })
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-lg flex-col rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button onClick={onCancel} className="rounded-lg p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
        </div>
        <div className="flex flex-col items-center gap-3 overflow-auto p-5">
          <div
            className="relative cursor-move touch-none overflow-hidden rounded-lg border border-border bg-muted/30 select-none"
            style={{ width: frameW, height: frameH, maxWidth: '100%' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
            <img
              src={src}
              alt="crop"
              draggable={false}
              onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              style={{ position: 'absolute', left: posX, top: posY, width: drawW, height: drawH, maxWidth: 'none' }}
            />
            {!nat && <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Move className="size-3" /> Kéo để di chuyển • dùng thanh trượt để phóng to</p>
          <div className="flex w-full max-w-[420px] items-center gap-2">
            <ZoomIn className="size-4 text-muted-foreground" />
            <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-full" />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={onCancel}>Hủy</Button>
          <Button onClick={confirm} disabled={!nat}>Xong</Button>
        </div>
      </div>
    </div>
  )
}
