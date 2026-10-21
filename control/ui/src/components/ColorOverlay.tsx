/**
 * Dark, in-editor Photoshop-style COLOR overlay — 100% client-side. A real
 * Curves widget (shadows/mid/highlights) plus Hue / Saturation / Temperature /
 * Brightness / Contrast, with a LIVE downscaled preview (snappy) and a full-res
 * bake on "Xong". Pure pixel math — no server.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RotateCcw, SlidersHorizontal, X } from 'lucide-react'

interface Props { image: string; onApply: (dataUri: string) => void; onClose: () => void }
interface Params { lo: number; mid: { x: number; y: number }; hi: number; hue: number; sat: number; temp: number; bright: number; contrast: number }
const DEFAULT: Params = { lo: 0, mid: { x: 128, y: 128 }, hi: 255, hue: 0, sat: 0, temp: 0, bright: 0, contrast: 0 }

// 3-point curve (0,lo)-(mid)-(255,hi) → 256-entry LUT (linear interpolation).
function buildLut(p: Params): Uint8Array {
  const pts = [{ x: 0, y: p.lo }, { x: Math.min(254, Math.max(1, p.mid.x)), y: p.mid.y }, { x: 255, y: p.hi }]
  const lut = new Uint8Array(256)
  for (let v = 0; v < 256; v++) {
    let i = 0
    while (i < pts.length - 2 && v > pts[i + 1].x) i++
    const a = pts[i], b = pts[i + 1]
    const t = b.x === a.x ? 0 : (v - a.x) / (b.x - a.x)
    lut[v] = Math.max(0, Math.min(255, Math.round(a.y + (b.y - a.y) * t)))
  }
  return lut
}

function processImageData(data: Uint8ClampedArray, p: Params, lut: Uint8Array) {
  const c = (p.contrast / 100) * 1.2
  const cf = c >= 0 ? 1 + c : 1 / (1 - c) // contrast factor
  const br = p.bright * 1.2
  const t = p.temp * 0.6
  const hueShift = p.hue / 360
  const satF = 1 + p.sat / 100
  const doHsl = p.hue !== 0 || p.sat !== 0
  for (let i = 0; i < data.length; i += 4) {
    let r = lut[data[i]], g = lut[data[i + 1]], b = lut[data[i + 2]]
    // brightness + contrast
    r = (r - 128) * cf + 128 + br; g = (g - 128) * cf + 128 + br; b = (b - 128) * cf + 128 + br
    // temperature (warm = +R/-B)
    r += t; b -= t
    r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b
    if (doHsl) {
      // RGB→HSL
      const rn = r / 255, gn = g / 255, bn = b / 255
      const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn)
      let h = 0, s = 0; const l = (mx + mn) / 2
      const dlt = mx - mn
      if (dlt !== 0) {
        s = l > 0.5 ? dlt / (2 - mx - mn) : dlt / (mx + mn)
        if (mx === rn) h = (gn - bn) / dlt + (gn < bn ? 6 : 0)
        else if (mx === gn) h = (bn - rn) / dlt + 2
        else h = (rn - gn) / dlt + 4
        h /= 6
      }
      h = (h + hueShift + 1) % 1
      s = Math.max(0, Math.min(1, s * satF))
      // HSL→RGB
      if (s === 0) { r = g = b = l * 255 } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s
        const pp = 2 * l - q
        const hk = (tc: number) => { tc = (tc + 1) % 1; if (tc < 1 / 6) return pp + (q - pp) * 6 * tc; if (tc < 1 / 2) return q; if (tc < 2 / 3) return pp + (q - pp) * (2 / 3 - tc) * 6; return pp }
        r = hk(h + 1 / 3) * 255; g = hk(h) * 255; b = hk(h - 1 / 3) * 255
      }
    }
    data[i] = r; data[i + 1] = g; data[i + 2] = b
  }
}

export function ColorOverlay({ image, onApply, onClose }: Props) {
  const previewRef = useRef<HTMLCanvasElement | null>(null)
  const srcFull = useRef<HTMLCanvasElement | null>(null)   // natural-res source
  const srcPrev = useRef<HTMLCanvasElement | null>(null)   // downscaled source for live preview
  const baseData = useRef<ImageData | null>(null)          // cached preview pixels (unmodified)
  const [ready, setReady] = useState(false)
  const [p, setP] = useState<Params>(DEFAULT)
  const [busy, setBusy] = useState(false)
  const lut = useMemo(() => buildLut(p), [p])

  useEffect(() => {
    const im = new Image()
    im.onload = () => {
      const full = document.createElement('canvas'); full.width = im.naturalWidth; full.height = im.naturalHeight
      full.getContext('2d')!.drawImage(im, 0, 0)
      srcFull.current = full
      const scale = Math.min(1, 900 / Math.max(im.naturalWidth, im.naturalHeight))
      const pw = Math.max(1, Math.round(im.naturalWidth * scale)), ph = Math.max(1, Math.round(im.naturalHeight * scale))
      const prev = document.createElement('canvas'); prev.width = pw; prev.height = ph
      prev.getContext('2d')!.drawImage(im, 0, 0, pw, ph)
      srcPrev.current = prev
      baseData.current = prev.getContext('2d')!.getImageData(0, 0, pw, ph)
      const pc = previewRef.current!; pc.width = pw; pc.height = ph
      setReady(true)
    }
    im.src = image
  }, [image])

  // Live preview whenever params change.
  useEffect(() => {
    if (!ready || !baseData.current || !previewRef.current) return
    const id = new ImageData(new Uint8ClampedArray(baseData.current.data), baseData.current.width, baseData.current.height)
    processImageData(id.data, p, lut)
    previewRef.current.getContext('2d')!.putImageData(id, 0, 0)
  }, [p, lut, ready])

  function commit() {
    const full = srcFull.current
    if (!full) { onClose(); return }
    setBusy(true)
    // run full-res in a microtask so the spinner can paint
    setTimeout(() => {
      const out = document.createElement('canvas'); out.width = full.width; out.height = full.height
      const octx = out.getContext('2d')!
      octx.drawImage(full, 0, 0)
      const id = octx.getImageData(0, 0, out.width, out.height)
      processImageData(id.data, p, lut)
      octx.putImageData(id, 0, 0)
      onApply(out.toDataURL('image/png'))
      onClose()
    }, 30)
  }

  // Curves widget interaction.
  const PAD = 170
  const curveRef = useRef<HTMLDivElement | null>(null)
  const dragPt = useRef<'lo' | 'mid' | 'hi' | null>(null)
  const toVal = (px: number) => Math.max(0, Math.min(255, Math.round((px / PAD) * 255)))
  const toY = (py: number) => Math.max(0, Math.min(255, Math.round((1 - py / PAD) * 255)))
  function curveDown(e: React.PointerEvent) {
    const r = curveRef.current!.getBoundingClientRect()
    const x = toVal(e.clientX - r.left)
    // nearest of the 3 points by input-x
    const near = x < 64 ? 'lo' : x > 192 ? 'hi' : 'mid'
    dragPt.current = near
    curveMove(e)
  }
  function curveMove(e: React.PointerEvent) {
    if (!dragPt.current) return
    const r = curveRef.current!.getBoundingClientRect()
    const y = toY(e.clientY - r.top)
    if (dragPt.current === 'lo') setP((s) => ({ ...s, lo: y }))
    else if (dragPt.current === 'hi') setP((s) => ({ ...s, hi: y }))
    else { const x = toVal(e.clientX - r.left); setP((s) => ({ ...s, mid: { x: Math.min(230, Math.max(25, x)), y } })) }
  }
  function curveUp() { dragPt.current = null }

  const Slider = ({ k, name, min, max }: { k: keyof Params; name: string; min: number; max: number }) => (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 text-white/70">{name}</span>
      <input type="range" min={min} max={max} value={p[k] as number} onChange={(e) => setP((s) => ({ ...s, [k]: Number(e.target.value) }))} className="flex-1" />
      <button type="button" onClick={() => setP((s) => ({ ...s, [k]: 0 }))} className="text-white/40 hover:text-white">↺</button>
    </label>
  )

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-neutral-900 text-white">
      <header className="flex h-[52px] flex-shrink-0 items-center gap-2 border-b border-white/10 bg-neutral-900 px-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold"><SlidersHorizontal className="size-4" /> Chỉnh màu (Pro)</span>
        <button type="button" onClick={() => setP(DEFAULT)} className="ml-2 inline-flex items-center gap-1 rounded p-1.5 text-xs hover:bg-white/10"><RotateCcw className="size-3.5" /> Đặt lại</button>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={commit} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50">{busy && <Loader2 className="size-4 animate-spin" />} Xong</button>
          <button type="button" onClick={onClose} title="Huỷ" className="rounded p-1.5 hover:bg-white/10"><X className="size-5" /></button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex flex-1 items-center justify-center overflow-hidden bg-neutral-800 p-4">
          {!ready && <Loader2 className="size-6 animate-spin text-white/60" />}
          <canvas ref={previewRef} className="max-h-[82vh] max-w-full rounded" style={{ display: ready ? 'block' : 'none' }} />
        </div>
        <aside className="w-72 flex-shrink-0 space-y-4 overflow-y-auto border-l border-white/10 bg-neutral-900 p-4">
          <div>
            <div className="mb-1.5 text-xs font-medium text-white/60">Đường cong (Curves)</div>
            <div ref={curveRef} onPointerDown={curveDown} onPointerMove={curveMove} onPointerUp={curveUp} onPointerLeave={curveUp}
              className="relative cursor-crosshair rounded-md border border-white/15 bg-neutral-950" style={{ width: PAD, height: PAD, touchAction: 'none' }}>
              <svg width={PAD} height={PAD} className="absolute inset-0">
                <line x1="0" y1={PAD} x2={PAD} y2="0" stroke="rgba(255,255,255,.1)" />
                <polyline fill="none" stroke="#3b82f6" strokeWidth="2"
                  points={`0,${PAD - (p.lo / 255) * PAD} ${(p.mid.x / 255) * PAD},${PAD - (p.mid.y / 255) * PAD} ${PAD},${PAD - (p.hi / 255) * PAD}`} />
                {[['lo', 0, p.lo], ['mid', p.mid.x, p.mid.y], ['hi', 255, p.hi]].map(([k, x, y]) => (
                  <circle key={k as string} cx={(Number(x) / 255) * PAD} cy={PAD - (Number(y) / 255) * PAD} r="5" fill="#fff" />
                ))}
              </svg>
            </div>
            <p className="mt-1 text-[10px] text-white/40">Kéo 3 điểm: tối (trái) · trung (giữa) · sáng (phải).</p>
          </div>
          <div className="space-y-2">
            <Slider k="bright" name="Độ sáng" min={-100} max={100} />
            <Slider k="contrast" name="Tương phản" min={-100} max={100} />
            <Slider k="sat" name="Bão hoà" min={-100} max={100} />
            <Slider k="hue" name="Tông màu (Hue)" min={-180} max={180} />
            <Slider k="temp" name="Nhiệt độ" min={-100} max={100} />
          </div>
        </aside>
      </div>
    </div>
  )
}
