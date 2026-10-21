/**
 * Dark, in-editor "Đổi màu vùng" overlay — Magic-Wand select-by-color + local
 * recolor, 100% client-side. Click to flood-select a region of similar colour
 * (tolerance), Shift = add, Alt = subtract, then shift Hue/Saturation/Lightness
 * or "Tô màu" (colorize) only inside the selection. Live preview; "Xong" bakes.
 *
 * Works on a capped-resolution copy (≤1600px) so flood-fill stays snappy.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RotateCcw, Wand2, X } from 'lucide-react'

interface Props { image: string; onApply: (dataUri: string) => void; onClose: () => void }
interface Recolor { hue: number; sat: number; light: number; colorize: boolean; color: string }
const DEFAULT: Recolor = { hue: 0, sat: 0, light: 0, colorize: false, color: '#ff3b3b' }

function hexToHsl(hex: string): { h: number; s: number } {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0; const l = (mx + mn) / 2; const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (d !== 0) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4 }
  return { h: ((h * 60) + 360) % 360, s }
}

export function RecolorOverlay({ image, onApply, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const base = useRef<ImageData | null>(null)        // original pixels (capped res)
  const mask = useRef<Uint8Array | null>(null)        // 255 = selected
  const seed = useRef<{ r: number; g: number; b: number } | null>(null)
  const drawing = useRef(false)
  const [ready, setReady] = useState(false)
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [mode, setMode] = useState<'wand' | 'brush'>('wand')
  const [tol, setTol] = useState(12)
  const [brush, setBrush] = useState(40)
  const [erase, setErase] = useState(false)
  const [showSel, setShowSel] = useState(true)
  const [hasSel, setHasSel] = useState(false)
  const [p, setP] = useState<Recolor>(DEFAULT)

  useEffect(() => {
    const im = new Image()
    im.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight))
      const w = Math.max(1, Math.round(im.naturalWidth * scale)), h = Math.max(1, Math.round(im.naturalHeight * scale))
      const c = canvasRef.current!; c.width = w; c.height = h
      const ctx = c.getContext('2d')!; ctx.drawImage(im, 0, 0, w, h)
      base.current = ctx.getImageData(0, 0, w, h)
      mask.current = new Uint8Array(w * h)
      setDims({ w, h }); setReady(true)
    }
    im.src = image
  }, [image])

  function coords(e: React.PointerEvent) {
    const c = canvasRef.current!; const r = c.getBoundingClientRect()
    return { x: Math.round((e.clientX - r.left) * (c.width / r.width)), y: Math.round((e.clientY - r.top) * (c.height / r.height)) }
  }

  // Flood-fill select pixels within `tol` colour distance of the clicked seed.
  function floodSelect(sx: number, sy: number, mode: 'new' | 'add' | 'sub') {
    const b = base.current, m = mask.current; if (!b || !m) return
    const { w, h } = dims
    const d = b.data
    const idx = (sy * w + sx)
    const sr = d[idx * 4], sg = d[idx * 4 + 1], sb = d[idx * 4 + 2]
    seed.current = { r: sr, g: sg, b: sb }
    const maxD = (tol / 100) * 110
    if (mode === 'new') m.fill(0)
    const seen = new Uint8Array(w * h)
    const stack = [idx]
    const val = mode === 'sub' ? 0 : 255
    while (stack.length) {
      const i = stack.pop()!
      if (seen[i]) continue
      seen[i] = 1
      const o = i * 4
      const dr = d[o] - sr, dg = d[o + 1] - sg, db = d[o + 2] - sb
      if (Math.sqrt(dr * dr + dg * dg + db * db) > maxD) continue
      m[i] = val
      const x = i % w, y = (i / w) | 0
      if (x > 0) stack.push(i - 1)
      if (x < w - 1) stack.push(i + 1)
      if (y > 0) stack.push(i - w)
      if (y < h - 1) stack.push(i + w)
    }
    setHasSel(m.some((v) => v > 0))
  }

  const recolorActive = useMemo(() => p.colorize || p.hue !== 0 || p.sat !== 0 || p.light !== 0, [p])

  // Build the preview: base + recolor inside mask + (optional) selection outline.
  function render() {
    const b = base.current, m = mask.current, c = canvasRef.current
    if (!b || !m || !c) return
    const { w, h } = dims
    const out = new Uint8ClampedArray(b.data)
    const target = p.colorize ? hexToHsl(p.color) : null
    const satF = 1 + p.sat / 100
    const hueShift = p.hue
    const lAdd = p.light / 100
    if (recolorActive) {
      for (let i = 0; i < m.length; i++) {
        if (!m[i]) continue
        const o = i * 4
        let r = b.data[o] / 255, g = b.data[o + 1] / 255, bl = b.data[o + 2] / 255
        const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl), dd = mx - mn
        let hh = 0; let l = (mx + mn) / 2; let s = dd === 0 ? 0 : dd / (1 - Math.abs(2 * l - 1))
        if (dd !== 0) { if (mx === r) hh = ((g - bl) / dd) % 6; else if (mx === g) hh = (bl - r) / dd + 2; else hh = (r - g) / dd + 4; hh = (hh * 60 + 360) % 360 }
        if (target) { hh = target.h; s = target.s } else { hh = (hh + hueShift + 360) % 360; s = Math.max(0, Math.min(1, s * satF)) }
        l = Math.max(0, Math.min(1, l + lAdd))
        // HSL→RGB
        const cc = (1 - Math.abs(2 * l - 1)) * s
        const xx = cc * (1 - Math.abs(((hh / 60) % 2) - 1))
        const mm = l - cc / 2
        let rr = 0, gg = 0, bb = 0
        if (hh < 60) { rr = cc; gg = xx } else if (hh < 120) { rr = xx; gg = cc } else if (hh < 180) { gg = cc; bb = xx }
        else if (hh < 240) { gg = xx; bb = cc } else if (hh < 300) { rr = xx; bb = cc } else { rr = cc; bb = xx }
        const a = m[i] / 255
        out[o] = (rr + mm) * 255 * a + b.data[o] * (1 - a)
        out[o + 1] = (gg + mm) * 255 * a + b.data[o + 1] * (1 - a)
        out[o + 2] = (bb + mm) * 255 * a + b.data[o + 2] * (1 - a)
      }
    }
    if (showSel && hasSel) {
      // Tint the WHOLE selected region (translucent cyan) so the user clearly
      // sees the selected area — a thin outline looks like noise on a textured
      // / fragmented selection.
      const a = 0.4
      for (let i = 0; i < m.length; i++) {
        if (!m[i]) continue
        const o = i * 4
        out[o] = out[o] * (1 - a)
        out[o + 1] = out[o + 1] * (1 - a) + 210 * a
        out[o + 2] = out[o + 2] * (1 - a) + 255 * a
      }
    }
    c.getContext('2d')!.putImageData(new ImageData(out, w, h), 0, 0)
  }
  useEffect(() => { if (ready) render() }, [p, showSel, hasSel, ready, dims])

  // Brush-select: paint the mask directly (full manual control) — add, or
  // Alt/right-button to erase from the selection.
  function paintMask(cx: number, cy: number, erase: boolean) {
    const m = mask.current; if (!m) return
    const { w, h } = dims
    const r = brush / 2, r2 = r * r
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r))
    const v = erase ? 0 : 255
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy
      if (dx * dx + dy * dy <= r2) m[y * w + x] = v
    }
  }

  function onDown(e: React.PointerEvent) {
    if (!ready) return
    e.preventDefault()
    const { x, y } = coords(e)
    if (x < 0 || y < 0 || x >= dims.w || y >= dims.h) return
    if (mode === 'wand') {
      floodSelect(x, y, e.shiftKey ? 'add' : e.altKey ? 'sub' : 'new')
    } else {
      drawing.current = true
      paintMask(x, y, erase || e.altKey || e.button === 2)
      setHasSel(true)
    }
    render()
  }
  function onMove(e: React.PointerEvent) {
    if (!drawing.current || mode !== 'brush') return
    const { x, y } = coords(e)
    paintMask(x, y, erase || e.altKey || e.buttons === 2)
    render()
  }
  function onUp() { if (!drawing.current) return; drawing.current = false; setHasSel(mask.current!.some((v) => v > 0)) }
  function clearSel() { mask.current?.fill(0); setHasSel(false); render() }

  function commit() {
    const b = base.current, m = mask.current; if (!b || !m) { onClose(); return }
    // re-render WITHOUT the selection outline, then export
    const tmp = showSel; setShowSel(false)
    setTimeout(() => {
      render()
      onApply(canvasRef.current!.toDataURL('image/png'))
      setShowSel(tmp); onClose()
    }, 0)
  }

  const Slider = ({ k, name, min, max }: { k: keyof Recolor; name: string; min: number; max: number }) => (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-16 text-white/70">{name}</span>
      <input type="range" min={min} max={max} value={p[k] as number} onChange={(e) => setP((s) => ({ ...s, [k]: Number(e.target.value) }))} className="flex-1" />
    </label>
  )

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-neutral-900 text-white">
      <header className="flex h-[52px] flex-shrink-0 items-center gap-2 overflow-x-auto border-b border-white/10 bg-neutral-900 px-3">
        <span className="flex flex-shrink-0 items-center gap-1.5 text-sm font-semibold"><Wand2 className="size-4" /> Đổi màu vùng</span>
        <div className="inline-flex flex-shrink-0 overflow-hidden rounded-md border border-white/15 text-xs">
          {([['wand', 'Đũa thần'], ['brush', 'Cọ chọn']] as const).map(([m, lbl]) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={`px-2.5 py-1 font-medium ${mode === m ? 'bg-white/20' : 'text-white/70 hover:bg-white/10'}`}>{lbl}</button>
          ))}
        </div>
        {mode === 'wand' ? (
          <span className="ml-1 flex flex-shrink-0 items-center gap-1.5 text-xs text-white/70">Dung sai
            <input type="range" min={2} max={100} value={tol} onChange={(e) => setTol(Number(e.target.value))} className="w-24" /></span>
        ) : (
          <>
            <div className="ml-1 inline-flex flex-shrink-0 overflow-hidden rounded-md border border-white/15 text-xs">
              {([['paint', 'Cọ'], ['erase', 'Tẩy']] as const).map(([k, lbl]) => (
                <button key={k} type="button" onClick={() => setErase(k === 'erase')}
                  className={`px-2.5 py-1 font-medium ${(k === 'erase') === erase ? 'bg-white/20' : 'text-white/70 hover:bg-white/10'}`}>{lbl}</button>
              ))}
            </div>
            <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-white/70">Cỡ
              <input type="range" min={10} max={160} value={brush} onChange={(e) => setBrush(Number(e.target.value))} className="w-24" /></span>
          </>
        )}
        <label className="flex flex-shrink-0 items-center gap-1 text-xs text-white/70"><input type="checkbox" checked={showSel} onChange={(e) => setShowSel(e.target.checked)} /> Hiện vùng chọn</label>
        <button type="button" onClick={clearSel} disabled={!hasSel} className="inline-flex flex-shrink-0 items-center gap-1 rounded p-1.5 text-xs hover:bg-white/10 disabled:opacity-30"><RotateCcw className="size-3.5" /> Chọn lại</button>
        <div className="ml-auto flex flex-shrink-0 items-center gap-2 pl-2">
          <button type="button" onClick={commit} disabled={!hasSel} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50">Xong</button>
          <button type="button" onClick={onClose} title="Huỷ" className="rounded p-1.5 hover:bg-white/10"><X className="size-5" /></button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex flex-1 items-center justify-center overflow-hidden bg-neutral-800 p-4">
          {!ready && <Loader2 className="size-6 animate-spin text-white/60" />}
          <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onContextMenu={(e) => e.preventDefault()}
            className="max-h-[82vh] max-w-full rounded" style={{ cursor: 'crosshair', touchAction: 'none', display: ready ? 'block' : 'none' }} />
        </div>
        <aside className="w-64 flex-shrink-0 space-y-3 overflow-y-auto border-l border-white/10 bg-neutral-900 p-4 text-sm">
          <p className="text-xs text-white/50">{mode === 'wand'
            ? 'Đũa thần: bấm vào vùng cùng màu (vd cái áo). Shift+bấm thêm, Alt+bấm bớt.'
            : 'Cọ chọn: tô tay lên vùng muốn đổi (kiểm soát chính xác). Bấm "Tẩy" để xoá bớt vùng đã tô.'} Rồi chỉnh màu bên dưới.</p>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={p.colorize} onChange={(e) => setP((s) => ({ ...s, colorize: e.target.checked }))} /> Tô màu cụ thể</label>
          {p.colorize ? (
            <label className="flex items-center gap-2 text-xs"><span className="w-16 text-white/70">Màu</span>
              <input type="color" value={p.color} onChange={(e) => setP((s) => ({ ...s, color: e.target.value }))} className="h-8 w-12 cursor-pointer rounded border border-white/20 bg-transparent" /></label>
          ) : (
            <>
              <Slider k="hue" name="Tông màu" min={-180} max={180} />
              <Slider k="sat" name="Bão hoà" min={-100} max={100} />
            </>
          )}
          <Slider k="light" name="Sáng/tối" min={-100} max={100} />
          <button type="button" onClick={() => setP(DEFAULT)} className="w-full rounded-md bg-white/5 px-2 py-1.5 text-xs hover:bg-white/15">Đặt lại màu</button>
          <p className="text-[10px] text-white/40">{hasSel ? 'Đã có vùng chọn — chỉnh màu sẽ chỉ áp trong đó.' : 'Chưa chọn vùng nào.'}</p>
        </aside>
      </div>
    </div>
  )
}
