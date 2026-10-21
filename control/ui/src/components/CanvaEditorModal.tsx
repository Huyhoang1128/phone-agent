/**
 * Full-screen single-image editor on react-konva (MIT). Opened from the per-image
 * "Chỉnh sửa" button. Polotno/Canva-like layout: an icon rail on the left that
 * opens sliding content panels (Text presets, Elements/shapes, Photos, Background,
 * Layers), a contextual property bar on top, and the design on a zoom/pan
 * workspace in the middle.
 *
 * Features: text (inline edit, fonts, bold/italic/underline/align/line+letter
 * spacing, shadow/outline, highlight, presets), shapes (rect/rounded/ellipse/
 * triangle/star/hexagon/heart/bubble/line/arrow with stroke + dash + corner
 * radius), freehand pen, inserted/stock images with filters, icons (Iconify),
 * QR, crop, image adjustments (brightness/contrast/saturation/blur/grayscale/
 * sepia) on background + images, zoom/pan, align/flip, arrow-key nudge,
 * eyedropper + recent colors, layers panel (reorder/hide/lock), opacity,
 * duplicate, undo/redo, snap guides. Export PNG/PDF or save to SeaweedFS.
 *
 * Background + icons + stock photos are fetched CORS-safe so the canvas isn't
 * tainted and export works.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import Konva from 'konva'
import { jsPDF } from 'jspdf'
import QRCode from 'qrcode'
import {
  Stage, Layer, Image as KonvaImage, Rect, Ellipse, Text, TextPath, Line, Arrow, RegularPolygon,
  Star as KStar, Path, Label, Tag, Transformer,
} from 'react-konva'
import {
  AlignCenter, AlignLeft, AlignRight, Bold, BringToFront, Check, Circle, Copy, Crop,
  Download, Droplet, Eraser, Eye, EyeOff, FileDown, FlipHorizontal2, FlipVertical2, Frame,
  Group, Heart, Hexagon, LayoutTemplate, Music2, Play, Ungroup,
  Highlighter, ImagePlus, Italic, Layers as LayersIcon, Loader2, Lock, LockOpen,
  MessageCircle, Minus, MousePointer2, MoveUpRight, Pencil, Pipette, Plus, QrCode, Redo2,
  RotateCcw, Save, Search, SendToBack, Shapes, SlidersHorizontal, Slash, Smile, Sparkles,
  Square, Star, Trash2, Triangle, Type, Underline, Undo2, Wand2, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import type React from 'react'
import { useToast } from '@/context/ToastContext'
import { charactersApi, contentsApi } from '@/lib/api'
import { compressForUpload } from '@/lib/image'
import { InpaintOverlay } from '@/components/InpaintOverlay'
import { RetouchOverlay } from '@/components/RetouchOverlay'
import { ColorOverlay } from '@/components/ColorOverlay'
import { RecolorOverlay } from '@/components/RecolorOverlay'
import type { Character } from '@/lib/types'

type Tool = 'select' | 'text' | 'rect' | 'roundedRect' | 'ellipse' | 'triangle' | 'star'
  | 'hexagon' | 'heart' | 'bubble' | 'line' | 'arrow' | 'pen'
type Panel = null | 'templates' | 'text' | 'elements' | 'icons' | 'photos' | 'background' | 'layers' | 'resize'

interface Adjust { brightness: number; contrast: number; saturation: number; blur: number; grayscale: boolean; sepia: boolean }
const NO_ADJUST: Adjust = { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: false, sepia: false }

interface Common {
  id: string; x: number; y: number; rotation: number; scaleX: number; scaleY: number; opacity: number
  visible?: boolean; locked?: boolean; groupId?: string
  blend?: string; gradOn?: boolean; gradFrom?: string; gradTo?: string
  shadowOn?: boolean; shadowColor?: string; shadowBlur?: number; shadowX?: number; shadowY?: number
}
interface Stroked { stroke?: string; strokeWidth?: number; dash?: boolean }
type EditorElement =
  | (Common & { type: 'text'; text: string; fontSize: number; fill: string; fontFamily: string; bold: boolean; italic: boolean; underline: boolean; align: 'left' | 'center' | 'right'; lineHeight: number; letterSpacing: number; shadow: boolean; outline: boolean; highlight: boolean; highlightColor: string; curve: number })
  | (Common & Stroked & { type: 'rect'; width: number; height: number; fill: string; cornerRadius: number })
  | (Common & Stroked & { type: 'ellipse'; radiusX: number; radiusY: number; fill: string })
  | (Common & Stroked & { type: 'triangle'; radius: number; fill: string })
  | (Common & Stroked & { type: 'star'; outerRadius: number; fill: string })
  | (Common & Stroked & { type: 'hexagon'; radius: number; fill: string })
  | (Common & Stroked & { type: 'heart' | 'bubble'; fill: string })
  | (Common & { type: 'line' | 'arrow'; points: number[]; stroke: string; strokeWidth: number; dash?: boolean })
  | (Common & { type: 'image'; img: HTMLImageElement; width: number; height: number; adjust: Adjust })
  | { id: string; type: 'draw'; points: number[]; stroke: string; strokeWidth: number; opacity: number; visible?: boolean; locked?: boolean; groupId?: string }

const HEADER_H = 52
const RAIL_W = 72
const PANEL_W = 300
const PAGESTRIP_H = 76
let pageSeq = 1
const SNAP = 6
const ZMIN = 0.1
const ZMAX = 4
const HEART_PATH = 'M50 88 C 12 60, 0 35, 18 18 C 30 6, 46 10, 50 24 C 54 10, 70 6, 82 18 C 100 35, 88 60, 50 88 Z'
const BUBBLE_PATH = 'M10 8 H90 Q100 8 100 18 V58 Q100 68 90 68 H42 L26 84 V68 H10 Q0 68 0 58 V18 Q0 8 10 8 Z'
const FONTS = [
  'Roboto', 'Be Vietnam Pro', 'Montserrat', 'Open Sans', 'Lato', 'Oswald',
  'Playfair Display', 'Lobster', 'Pacifico', 'Dancing Script', 'Bebas Neue', 'Anton',
]
const SWATCHES = [
  '#000000', '#ffffff', '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#64748b',
]
const PEXELS_KEY = (import.meta as { env?: Record<string, string> }).env?.VITE_PEXELS_API_KEY || ''
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
let elementSeq = 0
const nextId = () => `el-${++elementSeq}-${performance.now() | 0}`
const workspaceSize = () => ({ width: window.innerWidth - RAIL_W, height: window.innerHeight - HEADER_H - PAGESTRIP_H })
interface PageState { id: string; elements: EditorElement[]; bgImage: HTMLImageElement | null; bgAdjust: Adjust; bgColor: string; frame: { w: number; h: number; label: string } | null }
// Measure a text's rendered width (for laying it on a curve path).
let _measureCtx: CanvasRenderingContext2D | null = null
const measureTextW = (t: string, fs: number, ff: string, bold: boolean, italic: boolean): number => {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d')
  if (!_measureCtx) return t.length * fs * 0.55
  _measureCtx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fs}px ${ff}`
  return _measureCtx.measureText(t || ' ').width
}
// Quadratic arc path for curved text: bends up (curve>0) or down (curve<0).
const arcPath = (width: number, curve: number, fontSize: number): string => {
  const bend = (curve / 100) * fontSize * 2.6
  return `M 0 0 Q ${width / 2} ${-bend} ${width} 0`
}
const strokeOf = (e: Stroked): Record<string, unknown> => {
  if (!e.stroke || !e.strokeWidth) return {}
  return { stroke: e.stroke, strokeWidth: e.strokeWidth, dash: e.dash ? [Math.max(6, e.strokeWidth * 2), Math.max(4, e.strokeWidth)] : undefined }
}
// Linear-gradient fill (if enabled) else a solid fill. start/end are in node-local coords.
const fillOf = (e: Common & { fill: string }, start: { x: number; y: number }, end: { x: number; y: number }): Record<string, unknown> =>
  e.gradOn && e.gradFrom && e.gradTo
    ? { fillPriority: 'linear-gradient', fillLinearGradientStartPoint: start, fillLinearGradientEndPoint: end, fillLinearGradientColorStops: [0, e.gradFrom, 1, e.gradTo] }
    : { fill: e.fill }
// Drop-shadow props for shapes/images (text keeps its own boolean shadow).
const shadowOf = (e: Common): Record<string, unknown> =>
  e.shadowOn ? { shadowEnabled: true, shadowColor: e.shadowColor || '#000000', shadowBlur: e.shadowBlur ?? 12, shadowOffsetX: e.shadowX ?? 6, shadowOffsetY: e.shadowY ?? 6 } : {}
type ShapeEl = Extract<EditorElement, { type: 'rect' | 'ellipse' | 'triangle' | 'star' | 'hexagon' | 'heart' | 'bubble' }>
const isShapeEl = (e: EditorElement | null): e is ShapeEl =>
  !!e && ['rect', 'ellipse', 'triangle', 'star', 'hexagon', 'heart', 'bubble'].includes(e.type)

// ── Resize presets (design frame in pixels) ──────────────────────────────────
const FRAMES: { w: number; h: number; label: string }[] = [
  { w: 1080, h: 1080, label: 'Vuông 1:1' },
  { w: 1080, h: 1350, label: 'Dọc 4:5' },
  { w: 1080, h: 1920, label: 'Story 9:16' },
  { w: 1920, h: 1080, label: 'Ngang 16:9' },
  { w: 1200, h: 630, label: 'FB post' },
  { w: 851, h: 315, label: 'FB cover' },
]

// ── One-tap filter presets (applied to a selected image / background) ────────
const FILTER_PRESETS: { name: string; a: Adjust }[] = [
  { name: 'Gốc', a: { ...NO_ADJUST } },
  { name: 'Vintage', a: { brightness: 0.05, contrast: 12, saturation: -0.18, blur: 0, grayscale: false, sepia: true } },
  { name: 'Đen trắng', a: { brightness: 0, contrast: 12, saturation: 0, blur: 0, grayscale: true, sepia: false } },
  { name: 'Ấm', a: { brightness: 0.08, contrast: 8, saturation: 0.32, blur: 0, grayscale: false, sepia: false } },
  { name: 'Lạnh', a: { brightness: 0.03, contrast: 10, saturation: -0.12, blur: 0, grayscale: false, sepia: false } },
  { name: 'Nét', a: { brightness: 0.02, contrast: 28, saturation: 0.1, blur: 0, grayscale: false, sepia: false } },
]

// ── Templates (built-in JSON layouts) ────────────────────────────────────────
type Rect = { x: number; y: number; width: number; height: number }
interface TemplateDef { id: string; name: string; frame?: { w: number; h: number; label: string }; bgColor?: string; build: (r: Rect) => EditorElement[] }
const mkText = (o: Partial<Extract<EditorElement, { type: 'text' }>> & { x: number; y: number; text: string; fontSize: number }): EditorElement => ({
  id: nextId(), type: 'text', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, fill: '#ffffff', fontFamily: 'Montserrat',
  bold: false, italic: false, underline: false, align: 'left', lineHeight: 1.15, letterSpacing: 0, shadow: false,
  outline: false, highlight: false, highlightColor: '#fde047', curve: 0, ...o,
})
const mkRect = (o: Partial<Extract<EditorElement, { type: 'rect' }>> & { x: number; y: number; width: number; height: number }): EditorElement => ({
  id: nextId(), type: 'rect', rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, fill: '#000000', cornerRadius: 0, ...o,
})
const TEMPLATES: TemplateDef[] = [
  {
    id: 'lower-banner', name: 'Dải tiêu đề dưới',
    build: (r) => [
      mkRect({ x: r.x, y: r.y + r.height * 0.72, width: r.width, height: r.height * 0.28, fill: '#000000', opacity: 0.55 }),
      mkText({ x: r.x + r.width * 0.05, y: r.y + r.height * 0.76, text: 'TIÊU ĐỀ CHÍNH', fontSize: r.width * 0.06, bold: true }),
      mkText({ x: r.x + r.width * 0.05, y: r.y + r.height * 0.88, text: 'Mô tả ngắn ở đây', fontSize: r.width * 0.032, fill: '#e5e7eb' }),
    ],
  },
  {
    id: 'sale-badge', name: 'Huy hiệu Sale',
    build: (r) => [
      { id: nextId(), type: 'ellipse', x: r.x + r.width * 0.8, y: r.y + r.height * 0.2, rotation: -12, scaleX: 1, scaleY: 1, opacity: 1, radiusX: r.width * 0.13, radiusY: r.width * 0.13, fill: '#ef4444' },
      mkText({ x: r.x + r.width * 0.7, y: r.y + r.height * 0.16, text: 'SALE\n50%', fontSize: r.width * 0.05, bold: true, align: 'center', rotation: -12 }),
    ],
  },
  {
    id: 'quote', name: 'Trích dẫn', bgColor: '#0f172a',
    build: (r) => [
      mkText({ x: r.x + r.width * 0.1, y: r.y + r.height * 0.32, text: '“Câu trích dẫn truyền cảm hứng của bạn.”', fontSize: r.width * 0.055, bold: true, align: 'center', lineHeight: 1.3 }),
      mkText({ x: r.x + r.width * 0.1, y: r.y + r.height * 0.66, text: '— Tác giả', fontSize: r.width * 0.032, fill: '#94a3b8', align: 'center' }),
    ],
  },
  {
    id: 'frame-border', name: 'Khung viền',
    build: (r) => [
      { id: nextId(), type: 'rect', x: r.x + r.width * 0.04, y: r.y + r.height * 0.04, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, width: r.width * 0.92, height: r.height * 0.92, fill: 'transparent', cornerRadius: 8, stroke: '#ffffff', strokeWidth: 6 },
      mkText({ x: r.x + r.width * 0.1, y: r.y + r.height * 0.45, text: 'NỘI DUNG', fontSize: r.width * 0.07, bold: true, align: 'center' }),
    ],
  },
  {
    id: 'big-sale', name: 'Giảm giá lớn', bgColor: '#dc2626',
    build: (r) => [
      mkText({ x: r.x + r.width * 0.05, y: r.y + r.height * 0.12, text: 'SIÊU SALE', fontSize: r.width * 0.08, bold: true, align: 'center', letterSpacing: 4 }),
      mkText({ x: r.x + r.width * 0.05, y: r.y + r.height * 0.32, text: '50%', fontSize: r.width * 0.32, bold: true, align: 'center', fill: '#fde047' }),
      mkText({ x: r.x + r.width * 0.05, y: r.y + r.height * 0.78, text: 'Áp dụng đến hết tháng', fontSize: r.width * 0.035, align: 'center' }),
    ],
  },
  {
    id: 'event', name: 'Sự kiện', bgColor: '#0f172a',
    build: (r) => [
      mkRect({ x: r.x + r.width * 0.5 - r.width * 0.18, y: r.y + r.height * 0.12, width: r.width * 0.36, height: r.height * 0.08, fill: '#3b82f6', cornerRadius: 40 }),
      mkText({ x: r.x + r.width * 0.5 - r.width * 0.18, y: r.y + r.height * 0.135, text: '20.07.2026', fontSize: r.width * 0.035, bold: true, align: 'center' }),
      mkText({ x: r.x + r.width * 0.08, y: r.y + r.height * 0.4, text: 'TÊN SỰ KIỆN', fontSize: r.width * 0.085, bold: true, align: 'center', lineHeight: 1.1 }),
      mkText({ x: r.x + r.width * 0.08, y: r.y + r.height * 0.7, text: '📍 Địa điểm tổ chức', fontSize: r.width * 0.035, align: 'center', fill: '#94a3b8' }),
    ],
  },
  {
    id: 'profile-card', name: 'Tên & chức danh',
    build: (r) => [
      mkRect({ x: r.x, y: r.y + r.height * 0.66, width: r.width, height: r.height * 0.34, fill: '#111827', opacity: 0.8 }),
      mkText({ x: r.x + r.width * 0.06, y: r.y + r.height * 0.72, text: 'NGUYỄN VĂN A', fontSize: r.width * 0.06, bold: true }),
      mkText({ x: r.x + r.width * 0.06, y: r.y + r.height * 0.82, text: 'Chức danh / Công ty', fontSize: r.width * 0.034, fill: '#9ca3af' }),
    ],
  },
  {
    id: 'cta', name: 'Nút kêu gọi',
    build: (r) => [
      mkText({ x: r.x + r.width * 0.08, y: r.y + r.height * 0.28, text: 'Ưu đãi có hạn!', fontSize: r.width * 0.07, bold: true, align: 'center' }),
      mkRect({ x: r.x + r.width * 0.3, y: r.y + r.height * 0.62, width: r.width * 0.4, height: r.height * 0.1, fill: '#22c55e', cornerRadius: 40 }),
      mkText({ x: r.x + r.width * 0.3, y: r.y + r.height * 0.645, text: 'MUA NGAY', fontSize: r.width * 0.04, bold: true, align: 'center' }),
    ],
  },
  {
    id: 'story-promo', name: 'Khuyến mãi',
    build: (r) => [
      mkRect({ x: r.x, y: r.y, width: r.width, height: r.height * 0.2, fill: '#000000', opacity: 0.4 }),
      mkText({ x: r.x + r.width * 0.08, y: r.y + r.height * 0.07, text: 'MỚI VỀ', fontSize: r.width * 0.07, bold: true, letterSpacing: 6 }),
      mkRect({ x: r.x + r.width * 0.15, y: r.y + r.height * 0.84, width: r.width * 0.7, height: r.height * 0.06, fill: '#ffffff', cornerRadius: 50 }),
      mkText({ x: r.x + r.width * 0.15, y: r.y + r.height * 0.852, text: 'VUỐT LÊN ĐỂ XEM', fontSize: r.width * 0.032, bold: true, align: 'center', fill: '#111827' }),
    ],
  },
]

interface Props {
  imageUrl: string
  characterId?: number
  onClose: () => void
  onSaved?: (updated: Character) => void
}

export default function CanvaEditorModal({ imageUrl, characterId, onClose, onSaved }: Props) {
  const { showToast } = useToast()
  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const nodeRefs = useRef<Record<string, Konva.Node>>({})
  const bgNodeRef = useRef<Konva.Image>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cropRef = useRef<Konva.Rect>(null)
  const cropTrRef = useRef<Konva.Transformer>(null)
  const isDrawing = useRef(false)
  const dragLayerId = useRef<string | null>(null)

  const [tool, setTool] = useState<Tool>('select')
  const [panel, setPanel] = useState<Panel>(null)
  const [color, setColor] = useState('#ef4444')
  const [recentColors, setRecentColors] = useState<string[]>([])
  const [strokeWidth, setStrokeWidth] = useState(4)
  const [elements, setElements] = useState<EditorElement[]>([])
  const [past, setPast] = useState<EditorElement[][]>([])
  const [future, setFuture] = useState<EditorElement[][]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null
  const selectOne = (id: string) => setSelectedIds([id])
  const clearSel = () => setSelectedIds([])
  const clipboard = useRef<EditorElement[]>([])
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const marqueeStart = useRef<{ x: number; y: number } | null>(null)
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null)
  const [bgAdjust, setBgAdjust] = useState<Adjust>(NO_ADJUST)
  const [bgColor, setBgColor] = useState<string>('')
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [cropping, setCropping] = useState(false)
  const [cropRect, setCropRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [editing, setEditing] = useState<{ id: string; value: string; left: number; top: number; fontSize: number; color: string; fontFamily: string; bold: boolean } | null>(null)
  const [guides, setGuides] = useState<number[][]>([])
  const [stageSize, setStageSize] = useState(workspaceSize)
  const [zoom, setZoom] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [frame, setFrame] = useState<{ w: number; h: number; label: string } | null>(null)
  const [bgFocus, setBgFocus] = useState({ x: 0.5, y: 0.5 }) // image position inside a fixed frame (0..1)
  const [bgZoom, setBgZoom] = useState(1) // extra zoom of the image inside a fixed frame (≥1 → room to pan)
  const bgPan = useRef<{ px: number; py: number; fx: number; fy: number } | null>(null)
  const [bgRemoving, setBgRemoving] = useState(false)
  const [exportScale, setExportScale] = useState(1)
  const [inpaintSrc, setInpaintSrc] = useState<string | null>(null) // open the "remove object" (LaMa inpaint) tool on this image
  const [retouchSrc, setRetouchSrc] = useState<string | null>(null) // open the client-side "Tút ảnh" (liquify/smooth/dodge/burn/clone) tool
  const [colorSrc, setColorSrc] = useState<string | null>(null) // open the client-side "Chỉnh màu (Pro)" curves/hue/temp tool
  const [recolorSrc, setRecolorSrc] = useState<string | null>(null) // open the magic-wand "Đổi màu vùng" tool
  const [pageOrder, setPageOrder] = useState<string[]>(() => ['pg-1'])
  const [activeId, setActiveId] = useState('pg-1')
  const [otherPages, setOtherPages] = useState<Record<string, PageState>>({})

  const selectedEl = elements.find((e) => e.id === selectedId) || null

  useEffect(() => {
    const id = 'editor-google-fonts'
    if (document.getElementById(id)) return
    const link = document.createElement('link')
    link.id = id
    link.rel = 'stylesheet'
    link.href = `https://fonts.googleapis.com/css2?${FONTS.map((f) => `family=${f.replace(/ /g, '+')}`).join('&')}&display=swap`
    document.head.appendChild(link)
  }, [])

  // ── History ───────────────────────────────────────────────────────────────
  const snapshot = () => { setPast((p) => [...p, elements]); setFuture([]) }
  const undo = () => setPast((p) => {
    if (!p.length) return p
    setFuture((f) => [elements, ...f]); setElements(p[p.length - 1]); clearSel()
    return p.slice(0, -1)
  })
  const redo = () => setFuture((f) => {
    if (!f.length) return f
    setPast((p) => [...p, elements]); setElements(f[0]); clearSel()
    return f.slice(1)
  })

  useEffect(() => {
    const onResize = () => setStageSize(workspaceSize())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Paste an image straight from the clipboard (e.g. a screenshot).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const items = e.clipboardData?.items
      if (!items) return
      for (const it of Array.from(items)) {
        if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) { e.preventDefault(); handleInsertImage(f); return } }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [elements, stageSize])

  // Load the background CORS-clean so the canvas stays exportable.
  useEffect(() => {
    let cancelled = false
    const setFrom = (src: string, withCors: boolean) => {
      const img = new window.Image()
      if (withCors) img.crossOrigin = 'anonymous'
      img.onload = () => !cancelled && setBgImage(img)
      img.onerror = () => { if (!cancelled && withCors) viaProxy() }
      img.src = src
    }
    const viaProxy = () => {
      charactersApi.proxyImage(imageUrl)
        .then((res) => !cancelled && setFrom(res.image, false))
        .catch(() => !cancelled && showToast('Không tải được ảnh để chỉnh sửa.', 'error'))
    }
    setFrom(imageUrl, true)
    return () => { cancelled = true }
  }, [imageUrl, showToast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inpaintSrc || retouchSrc || colorSrc || recolorSrc) return // a pixel-edit overlay owns the keyboard while open
      const tag = (e.target as HTMLElement)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      if (e.code === 'Space' && !typing && !spaceHeld) setSpaceHeld(true)
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Escape' && !editing) { if (cropping) cancelCrop(); else onClose() }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length && !typing) removeSelected()
      else if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo() }
      else if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo() }
      else if (mod && e.key.toLowerCase() === 'd' && selectedIds.length && !typing) { e.preventDefault(); duplicateSelected() }
      else if (mod && e.key.toLowerCase() === 'c' && selectedIds.length && !typing) { copySelected() }
      else if (mod && e.key.toLowerCase() === 'x' && selectedIds.length && !typing) { copySelected(); removeSelected() }
      else if (mod && e.key.toLowerCase() === 'v' && !typing && clipboard.current.length) { e.preventDefault(); pasteClipboard() }
      else if (mod && e.key.toLowerCase() === 'a' && !typing) { e.preventDefault(); setSelectedIds(elements.filter((el) => !el.locked).map((el) => el.id)) }
      else if (mod && e.key.toLowerCase() === 'g' && selectedIds.length > 1 && !typing) { e.preventDefault(); e.shiftKey ? ungroupSelected() : groupSelected() }
      else if (e.key.startsWith('Arrow') && selectedIds.length && !typing && !editing) { e.preventDefault(); nudge(e.key, e.shiftKey ? 10 : 1) }
    }
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceHeld(false) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp) }
  }, [onClose, selectedIds, elements, past, future, editing, cropping, spaceHeld, inpaintSrc, retouchSrc, colorSrc, recolorSrc])

  // bgRect = the image fitted to the workspace (used when there is NO fixed
  // frame). When the user picks a Resize preset, the design becomes a fixed
  // frame (frameRect) and the image is drawn "cover" inside it.
  const bgRect = useMemo(() => {
    if (!bgImage) return null
    const scale = Math.min(stageSize.width / bgImage.width, stageSize.height / bgImage.height) * 0.9
    const width = bgImage.width * scale
    const height = bgImage.height * scale
    return { x: (stageSize.width - width) / 2, y: (stageSize.height - height) / 2, width, height }
  }, [bgImage, stageSize])

  const rectForFrame = (f: { w: number; h: number }) => {
    const scale = Math.min(stageSize.width / f.w, stageSize.height / f.h) * 0.9
    const width = f.w * scale, height = f.h * scale
    return { x: (stageSize.width - width) / 2, y: (stageSize.height - height) / 2, width, height }
  }
  const frameRect = useMemo(() => (frame ? rectForFrame(frame) : null), [frame, stageSize])
  // designRect = the exported / aligned-to region: the frame if set, else the image.
  const designRect = frame ? frameRect : bgRect
  const designRectRef = useRef(designRect)
  designRectRef.current = designRect
  // Background image draw props: "cover" crop inside the frame, or plain fit.
  const bgImgProps = useMemo(() => {
    if (!bgImage) return null
    if (frame && frameRect) {
      const s = Math.max(frameRect.width / bgImage.width, frameRect.height / bgImage.height) * bgZoom
      const cw = frameRect.width / s, ch = frameRect.height / s
      const roomX = Math.max(0, bgImage.width - cw), roomY = Math.max(0, bgImage.height - ch)
      return { x: frameRect.x, y: frameRect.y, width: frameRect.width, height: frameRect.height, crop: { x: roomX * bgFocus.x, y: roomY * bgFocus.y, width: cw, height: ch } }
    }
    if (!bgRect) return null
    return { x: bgRect.x, y: bgRect.y, width: bgRect.width, height: bgRect.height, crop: undefined }
  }, [bgImage, frame, frameRect, bgRect, bgFocus, bgZoom])

  useEffect(() => {
    const tr = trRef.current
    if (!tr) return
    const lockedSet = new Set(elements.filter((e) => e.locked).map((e) => e.id))
    const nodes = selectedIds.filter((id) => !lockedSet.has(id) && id !== editing?.id).map((id) => nodeRefs.current[id]).filter(Boolean) as Konva.Node[]
    tr.nodes(nodes)
    tr.getLayer()?.batchDraw()
  }, [selectedIds, elements, editing?.id])

  useEffect(() => {
    if (!cropping) return
    const tr = cropTrRef.current
    const node = cropRef.current
    if (tr && node) { tr.nodes([node]); tr.getLayer()?.batchDraw() }
  }, [cropping, cropRect])

  // ── Image filters (Konva.Filters) on background + inserted images ───────────
  const applyAdjust = (node: Konva.Node | null, a: Adjust) => {
    if (!node) return
    const n = node as unknown as {
      cache: () => void; clearCache: () => void; filters: (f: unknown[]) => void
      brightness: (v: number) => void; contrast: (v: number) => void; saturation: (v: number) => void
      hue: (v: number) => void; luminance: (v: number) => void; blurRadius: (v: number) => void
    }
    const filters: unknown[] = []
    if (a.brightness) filters.push(Konva.Filters.Brighten)
    if (a.contrast) filters.push(Konva.Filters.Contrast)
    if (a.saturation) filters.push(Konva.Filters.HSL)
    if (a.blur) filters.push(Konva.Filters.Blur)
    if (a.grayscale) filters.push(Konva.Filters.Grayscale)
    if (a.sepia) filters.push(Konva.Filters.Sepia)
    if (!filters.length) { n.clearCache(); n.filters([]); node.getLayer()?.batchDraw(); return }
    n.cache()
    n.filters(filters)
    n.brightness(a.brightness)
    n.contrast(a.contrast)
    n.saturation(a.saturation)
    n.hue(0)
    n.luminance(0)
    n.blurRadius(a.blur)
    node.getLayer()?.batchDraw()
  }
  useEffect(() => { applyAdjust(bgNodeRef.current, bgAdjust) }, [bgAdjust, bgImage, bgImgProps, stageSize])
  useEffect(() => {
    elements.forEach((el) => { if (el.type === 'image') applyAdjust(nodeRefs.current[el.id], el.adjust) })
  }, [elements, stageSize])

  // ── Crop ────────────────────────────────────────────────────────────────────
  const startCrop = () => {
    if (!bgRect) return
    if (frame) { showToast('Bỏ khung cố định (Kích thước → Tự do) trước khi cắt.', 'error'); return }
    setPanel(null); clearSel(); resetZoom()
    setCropRect({ x: bgRect.x, y: bgRect.y, width: bgRect.width, height: bgRect.height })
    setCropping(true)
  }
  const cancelCrop = () => { setCropping(false); setCropRect(null) }
  const applyCrop = () => {
    if (!bgImage || !bgRect || !cropRect) return
    const sx = Math.max(0, ((cropRect.x - bgRect.x) / bgRect.width) * bgImage.width)
    const sy = Math.max(0, ((cropRect.y - bgRect.y) / bgRect.height) * bgImage.height)
    const sw = Math.min(bgImage.width - sx, (cropRect.width / bgRect.width) * bgImage.width)
    const sh = Math.min(bgImage.height - sy, (cropRect.height / bgRect.height) * bgImage.height)
    if (sw < 1 || sh < 1) return
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(sw)
    canvas.height = Math.round(sh)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(bgImage, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    const newImg = new window.Image()
    newImg.onload = () => { setBgImage(newImg); setCropping(false); setCropRect(null) }
    newImg.src = canvas.toDataURL('image/png')
  }

  // ── Element creation ────────────────────────────────────────────────────────
  const center = () => ({ x: stageSize.width / 2, y: stageSize.height / 2 })
  const base = (): Common => ({ id: nextId(), x: center().x, y: center().y, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 })

  const addElement = (el: EditorElement) => {
    snapshot()
    setElements((prev) => [...prev, el])
    selectOne(el.id)
    setTool('select')
  }

  const addText = (preset: 'heading' | 'subheading' | 'body') => {
    const c = center()
    const fontSize = preset === 'heading' ? 64 : preset === 'subheading' ? 40 : 26
    const text = preset === 'heading' ? 'Tiêu đề' : preset === 'subheading' ? 'Phụ đề' : 'Nội dung của bạn'
    addElement({
      ...base(), type: 'text', x: c.x - 120, y: c.y - fontSize / 2, text, fontSize, fill: color,
      fontFamily: 'Roboto', bold: preset === 'heading', italic: false, underline: false, align: 'left',
      lineHeight: 1.2, letterSpacing: 0, shadow: false, outline: false, highlight: false, highlightColor: '#fde047', curve: 0,
    })
  }

  const addShape = (t: Tool) => {
    const c = center()
    const st: Stroked = { stroke: undefined, strokeWidth: 0, dash: false }
    switch (t) {
      case 'rect': addElement({ ...base(), ...st, type: 'rect', x: c.x - 80, y: c.y - 50, width: 160, height: 100, fill: color, cornerRadius: 0 }); break
      case 'roundedRect': addElement({ ...base(), ...st, type: 'rect', x: c.x - 80, y: c.y - 50, width: 160, height: 100, fill: color, cornerRadius: 24 }); break
      case 'ellipse': addElement({ ...base(), ...st, type: 'ellipse', radiusX: 80, radiusY: 60, fill: color }); break
      case 'triangle': addElement({ ...base(), ...st, type: 'triangle', radius: 80, fill: color }); break
      case 'star': addElement({ ...base(), ...st, type: 'star', outerRadius: 80, fill: color }); break
      case 'hexagon': addElement({ ...base(), ...st, type: 'hexagon', radius: 80, fill: color }); break
      case 'heart': addElement({ ...base(), ...st, type: 'heart', x: c.x - 60, y: c.y - 55, scaleX: 1.2, scaleY: 1.2, fill: color }); break
      case 'bubble': addElement({ ...base(), ...st, type: 'bubble', x: c.x - 70, y: c.y - 50, scaleX: 1.4, scaleY: 1.4, fill: color }); break
      case 'line': addElement({ ...base(), type: 'line', x: 0, y: 0, points: [c.x - 100, c.y, c.x + 100, c.y], stroke: color, strokeWidth }); break
      case 'arrow': addElement({ ...base(), type: 'arrow', x: 0, y: 0, points: [c.x - 100, c.y, c.x + 100, c.y], stroke: color, strokeWidth }); break
    }
  }

  const handleRail = (t: Tool) => {
    if (t === 'pen') { setTool('pen'); clearSel(); setPanel(null); return }
    setTool('select')
    addShape(t)
  }

  const addImageEl = (img: HTMLImageElement, maxFrac = 0.5) => {
    const max = Math.min(stageSize.width, stageSize.height) * maxFrac
    const scale = Math.min(1, max / Math.max(img.width, img.height))
    const w = (img.width || 200) * scale
    const h = (img.height || 200) * scale
    const c = center()
    addElement({ ...base(), type: 'image', x: c.x - w / 2, y: c.y - h / 2, img, width: w, height: h, adjust: { ...NO_ADJUST } })
  }

  const handleInsertImage = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => { const img = new window.Image(); img.onload = () => addImageEl(img); img.src = reader.result as string }
    reader.readAsDataURL(file)
  }
  const handleDropFiles = (e: React.DragEvent) => {
    e.preventDefault()
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'))
    if (file) handleInsertImage(file)
  }

  const insertFromUrl = (url: string, maxFrac = 0.6) => {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => addImageEl(img, maxFrac)
    img.onerror = () => showToast('Không tải được ảnh.', 'error')
    img.src = url
  }

  const insertIcon = (name: string) => {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => addImageEl(img, 0.25)
    img.onerror = () => showToast('Không tải được icon.', 'error')
    img.src = `https://api.iconify.design/${name.replace(':', '/')}.svg?height=240&color=${encodeURIComponent(color)}`
  }

  const insertQr = async () => {
    const text = window.prompt('Nội dung QR (link/chữ):', 'https://')
    if (!text) return
    try {
      const dataUrl = await QRCode.toDataURL(text, { width: 512, margin: 1 })
      const img = new window.Image()
      img.onload = () => addImageEl(img, 0.3)
      img.src = dataUrl
    } catch { showToast('Tạo QR thất bại.', 'error') }
  }

  // ── Element ops (operate on the whole multi-selection) ──────────────────────
  const removeSelected = () => {
    if (!selectedIds.length) return
    snapshot()
    const ids = new Set(selectedIds)
    setElements((prev) => prev.filter((e) => !ids.has(e.id)))
    selectedIds.forEach((id) => delete nodeRefs.current[id])
    clearSel()
  }
  const cloneElement = (e: EditorElement): EditorElement => {
    const c = { ...e, id: nextId() } as EditorElement
    if (c.type !== 'draw') { c.x += 24; c.y += 24 }
    return c
  }
  const duplicateSelected = () => {
    if (!selectedIds.length) return
    snapshot()
    const ids = new Set(selectedIds)
    const clones = elements.filter((e) => ids.has(e.id)).map(cloneElement)
    setElements((prev) => [...prev, ...clones])
    setSelectedIds(clones.map((c) => c.id))
  }
  const copySelected = () => { if (selectedIds.length) { const ids = new Set(selectedIds); clipboard.current = elements.filter((e) => ids.has(e.id)) } }
  const pasteClipboard = () => {
    if (!clipboard.current.length) return
    snapshot()
    const clones = clipboard.current.map(cloneElement)
    setElements((prev) => [...prev, ...clones])
    setSelectedIds(clones.map((c) => c.id))
  }
  const groupSelected = () => {
    if (selectedIds.length < 2) return
    snapshot()
    const gid = `grp-${nextId()}`
    const ids = new Set(selectedIds)
    setElements((prev) => prev.map((el) => (ids.has(el.id) ? ({ ...el, groupId: gid } as EditorElement) : el)))
  }
  const ungroupSelected = () => {
    if (!selectedIds.length) return
    snapshot()
    const ids = new Set(selectedIds)
    setElements((prev) => prev.map((el) => (ids.has(el.id) ? ({ ...el, groupId: undefined } as EditorElement) : el)))
  }
  const selectElement = (el: EditorElement, shift: boolean) => {
    setAdjustOpen(false)
    if (el.groupId) {
      const members = elements.filter((e) => e.groupId === el.groupId).map((e) => e.id)
      setSelectedIds((s) => (shift ? Array.from(new Set([...s, ...members])) : members))
    } else if (shift) {
      setSelectedIds((s) => (s.includes(el.id) ? s.filter((x) => x !== el.id) : [...s, el.id]))
    } else selectOne(el.id)
  }
  const reorderSelected = (dir: 'front' | 'back') => {
    if (!selectedId) return
    snapshot()
    setElements((prev) => {
      const el = prev.find((e) => e.id === selectedId)
      if (!el) return prev
      const rest = prev.filter((e) => e.id !== selectedId)
      return dir === 'front' ? [...rest, el] : [el, ...rest]
    })
  }
  const patchSelected = (patch: Partial<EditorElement>) => {
    if (!selectedId) return
    snapshot()
    setElements((prev) => prev.map((el) => (el.id === selectedId ? ({ ...el, ...patch } as EditorElement) : el)))
  }
  const patchById = (id: string, patch: Partial<EditorElement>) => {
    setElements((prev) => prev.map((el) => (el.id === id ? ({ ...el, ...patch } as EditorElement) : el)))
  }
  const pushRecent = (c: string) => setRecentColors((prev) => [c, ...prev.filter((x) => x !== c)].slice(0, 8))
  const applyColor = (value: string) => {
    setColor(value); pushRecent(value)
    if (!selectedEl) return
    if (selectedEl.type === 'draw' || selectedEl.type === 'line' || selectedEl.type === 'arrow') patchSelected({ stroke: value } as Partial<EditorElement>)
    else if (selectedEl.type !== 'image') patchSelected({ fill: value } as Partial<EditorElement>)
  }
  const eyedrop = async () => {
    const ED = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
    if (!ED) { showToast('Trình duyệt không hỗ trợ hút màu.', 'error'); return }
    try { const r = await new ED().open(); applyColor(r.sRGBHex) } catch { /* cancelled */ }
  }
  const changeFontSize = (v: number) => {
    if (selectedEl?.type !== 'text') return
    patchSelected({ fontSize: clamp(v, 8, 400) } as Partial<EditorElement>)
  }
  const nudge = (key: string, step: number) => {
    if (!selectedIds.length) return
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
    const ids = new Set(selectedIds)
    snapshot()
    setElements((prev) => prev.map((el) => (ids.has(el.id) && el.type !== 'draw' ? { ...el, x: el.x + dx, y: el.y + dy } : el)))
  }
  const flipSelected = (axis: 'h' | 'v') => {
    if (!selectedIds.length) return
    const ids = new Set(selectedIds)
    snapshot()
    setElements((prev) => prev.map((el) => {
      if (!ids.has(el.id) || el.type === 'draw') return el
      return axis === 'h' ? { ...el, scaleX: -el.scaleX } : { ...el, scaleY: -el.scaleY }
    }))
  }
  const alignSelected = (dir: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
    if (!selectedIds.length || !designRect) return
    snapshot()
    selectedIds.forEach((id) => {
      const node = nodeRefs.current[id]
      if (!node) return
      const layer = node.getLayer()
      if (!layer) return
      const r = node.getClientRect({ relativeTo: layer })
      let dx = 0, dy = 0
      if (dir === 'left') dx = designRect.x - r.x
      else if (dir === 'center') dx = designRect.x + designRect.width / 2 - (r.x + r.width / 2)
      else if (dir === 'right') dx = designRect.x + designRect.width - (r.x + r.width)
      else if (dir === 'top') dy = designRect.y - r.y
      else if (dir === 'middle') dy = designRect.y + designRect.height / 2 - (r.y + r.height / 2)
      else if (dir === 'bottom') dy = designRect.y + designRect.height - (r.y + r.height)
      node.x(node.x() + dx); node.y(node.y() + dy)
      commitNode(id, node)
    })
  }

  // ── Remove background (client-side ONNX/WASM, no server/API key) ─────────────
  // Server-side background removal: POST the image (as a CORS-clean data-uri)
  // to the backend, which proxies to the self-hosted rembg worker. Keeps the
  // heavy ML off both the browser and the Django process.
  const runRemoveBg = async (src: HTMLImageElement, apply: (img: HTMLImageElement) => void) => {
    if (!src?.src) return
    setBgRemoving(true)
    showToast('Đang xoá nền…', 'success')
    try {
      let dataUri = src.src
      if (!dataUri.startsWith('data:')) {
        const c = document.createElement('canvas')
        c.width = src.naturalWidth || src.width
        c.height = src.naturalHeight || src.height
        const ctx = c.getContext('2d')
        if (!ctx) throw new Error('no ctx')
        ctx.drawImage(src, 0, 0)
        dataUri = c.toDataURL('image/png')
      }
      const res = await contentsApi.removeBackground(dataUri)
      const img = new window.Image()
      img.onload = () => { snapshot(); apply(img); showToast('Đã xoá nền.', 'success') }
      img.onerror = () => showToast('Không nạp được ảnh sau khi xoá nền.', 'error')
      img.src = res.image
    } catch {
      showToast('Xoá nền thất bại (kiểm tra dịch vụ xoá nền).', 'error')
    } finally { setBgRemoving(false) }
  }
  const removeBgOfSelected = () => { if (imgEl) runRemoveBg(imgEl.img, (img) => patchById(imgEl.id, { img } as Partial<EditorElement>)) }
  const removeBgOfBackground = () => { if (bgImage) runRemoveBg(bgImage, (img) => setBgImage(img)) }

  // Serialize the background photo to a CORS-clean data-uri so the pixel-editing
  // overlays (inpaint / retouch) can work on it at natural resolution.
  const bgToDataUri = (): string | null => {
    if (!bgImage) { showToast('Chưa có ảnh để sửa.', 'error'); return null }
    try {
      if (bgImage.src.startsWith('data:')) return bgImage.src
      const c = document.createElement('canvas')
      c.width = bgImage.naturalWidth || bgImage.width
      c.height = bgImage.naturalHeight || bgImage.height
      const ctx = c.getContext('2d'); if (!ctx) throw new Error('no ctx')
      ctx.drawImage(bgImage, 0, 0)
      return c.toDataURL('image/png')
    } catch { showToast('Không chuẩn bị được ảnh để sửa.', 'error'); return null }
  }
  const openInpaint = () => { const d = bgToDataUri(); if (d) { setPanel(null); clearSel(); setInpaintSrc(d) } }
  const openRetouch = () => { const d = bgToDataUri(); if (d) { setPanel(null); clearSel(); setRetouchSrc(d) } }
  const openColor = () => { const d = bgToDataUri(); if (d) { setPanel(null); clearSel(); setColorSrc(d) } }
  const openRecolor = () => { const d = bgToDataUri(); if (d) { setPanel(null); clearSel(); setRecolorSrc(d) } }

  // ── Templates / resize ──────────────────────────────────────────────────────
  const applyTemplate = (t: TemplateDef) => {
    snapshot()
    if (t.frame) setFrame(t.frame)
    if (t.bgColor !== undefined) setBgColor(t.bgColor)
    const r = t.frame ? rectForFrame(t.frame) : (designRect || { x: stageSize.width * 0.1, y: stageSize.height * 0.1, width: stageSize.width * 0.8, height: stageSize.height * 0.8 })
    setElements(t.build(r))
    clearSel() // keep the Templates panel open so the user can try others
  }
  // Changing the frame re-maps every element from the OLD design rect to the NEW
  // one (proportional reposition + uniform scale) so the layout adapts to each
  // platform instead of keeping absolute coords.
  const applyFrame = (f: { w: number; h: number; label: string } | null) => {
    snapshot()
    const oldRect = frame ? frameRect : bgRect
    const newRect = f ? rectForFrame(f) : bgRect
    if (oldRect && newRect && oldRect.width > 0 && oldRect.height > 0 && elements.length) {
      const sx = newRect.width / oldRect.width
      const sy = newRect.height / oldRect.height
      const su = Math.min(sx, sy)
      setElements((prev) => prev.map((el) => {
        if (el.type === 'draw' || el.type === 'line' || el.type === 'arrow') {
          return { ...el, points: el.points.map((v, i) => (i % 2 === 0 ? newRect.x + (v - oldRect.x) * sx : newRect.y + (v - oldRect.y) * sy)) } as EditorElement
        }
        return { ...el, x: newRect.x + (el.x - oldRect.x) * sx, y: newRect.y + (el.y - oldRect.y) * sy, scaleX: el.scaleX * su, scaleY: el.scaleY * su } as EditorElement
      }))
    }
    setFrame(f); setBgFocus({ x: 0.5, y: 0.5 }); setBgZoom(1); resetZoom()
  }
  // One-click: reframe the design to a platform's thumbnail size so the user can
  // immediately Save/PNG it as a TikTok cover (9:16) or YouTube thumbnail (16:9).
  const makeThumbnail = (platform: 'tiktok' | 'youtube') => {
    const f = platform === 'tiktok'
      ? { w: 1080, h: 1920, label: 'TikTok 9:16' }
      : { w: 1280, h: 720, label: 'YouTube 16:9' }
    // Toggle: re-clicking the active platform returns to the free (image) size.
    if (frame && frame.w === f.w && frame.h === f.h) {
      applyFrame(null)
      showToast('Đã về cỡ mặc định (theo ảnh).', 'success')
      return
    }
    applyFrame(f)
    setPanel('background') // open the panel so the image-position sliders are at hand
    showToast(`Đã đặt khung ${f.label}. Kéo "Vị trí ảnh trong khung" để căn, rồi Lưu / PNG.`, 'success')
  }

  // ── Pages (multi-page; active page lives in the hooks above, others stored) ──
  const snapshotActivePage = (): PageState => ({ id: activeId, elements, bgImage, bgAdjust, bgColor, frame })
  const loadPage = (p: PageState) => {
    setElements(p.elements); setBgImage(p.bgImage); setBgAdjust(p.bgAdjust); setBgColor(p.bgColor); setFrame(p.frame)
    clearSel(); setPast([]); setFuture([]); setAdjustOpen(false); resetZoom()
  }
  const blankPage = (id: string): PageState => ({ id, elements: [], bgImage: null, bgAdjust: { ...NO_ADJUST }, bgColor: '', frame: null })
  const switchPage = (id: string) => {
    if (id === activeId) return
    const target = otherPages[id]
    if (!target) return
    setOtherPages((o) => ({ ...o, [activeId]: snapshotActivePage() }))
    loadPage(target); setActiveId(id)
  }
  const addPage = () => {
    const id = `pg-${++pageSeq}`
    const np = blankPage(id)
    setOtherPages((o) => ({ ...o, [activeId]: snapshotActivePage(), [id]: np }))
    setPageOrder((ord) => [...ord, id])
    loadPage(np); setActiveId(id)
  }
  const duplicatePage = () => {
    const id = `pg-${++pageSeq}`
    const snap = snapshotActivePage()
    const np: PageState = { ...snap, id, elements: snap.elements.map((e) => ({ ...e, id: nextId() })) }
    setOtherPages((o) => ({ ...o, [activeId]: snap, [id]: np }))
    setPageOrder((ord) => { const i = ord.indexOf(activeId); const a = [...ord]; a.splice(i + 1, 0, id); return a })
    loadPage(np); setActiveId(id)
  }
  const deletePage = () => {
    if (pageOrder.length <= 1) return
    const idx = pageOrder.indexOf(activeId)
    const fallback = pageOrder[idx + 1] || pageOrder[idx - 1]
    const target = otherPages[fallback]
    setPageOrder((ord) => ord.filter((x) => x !== activeId))
    setOtherPages((o) => { const c = { ...o }; delete c[activeId]; return c })
    if (target) loadPage(target)
    setActiveId(fallback)
  }
  const orderedPages = (): PageState[] => pageOrder.map((id) => (id === activeId ? snapshotActivePage() : otherPages[id])).filter((p): p is PageState => !!p)

  const commitNode = (id: string, node: Konva.Node) => {
    setElements((prev) => prev.map((e) => (e.id === id && e.type !== 'draw'
      ? { ...e, x: node.x(), y: node.y(), rotation: node.rotation(), scaleX: node.scaleX(), scaleY: node.scaleY() }
      : e)))
  }

  // ── Snap-to-guide on drag ───────────────────────────────────────────────────
  const handleDragMove = (e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target
    const layer = node.getLayer()
    if (!layer) return
    const box = node.getClientRect({ relativeTo: layer })
    const vStops: number[] = []
    const hStops: number[] = []
    if (designRect) {
      vStops.push(designRect.x, designRect.x + designRect.width / 2, designRect.x + designRect.width)
      hStops.push(designRect.y, designRect.y + designRect.height / 2, designRect.y + designRect.height)
    } else {
      vStops.push(stageSize.width / 2); hStops.push(stageSize.height / 2)
    }
    for (const n of Object.values(nodeRefs.current)) {
      if (n === node) continue
      const b = n.getClientRect({ relativeTo: layer })
      vStops.push(b.x, b.x + b.width / 2, b.x + b.width)
      hStops.push(b.y, b.y + b.height / 2, b.y + b.height)
    }
    const vEdges = [box.x, box.x + box.width / 2, box.x + box.width]
    const hEdges = [box.y, box.y + box.height / 2, box.y + box.height]
    const lines: number[][] = []
    let bestV: { diff: number; stop: number } | null = null
    for (const stop of vStops) for (const edge of vEdges) {
      const diff = stop - edge
      if (Math.abs(diff) <= SNAP && (!bestV || Math.abs(diff) < Math.abs(bestV.diff))) bestV = { diff, stop }
    }
    if (bestV) { node.x(node.x() + bestV.diff); lines.push([bestV.stop, -9999, bestV.stop, 9999]) }
    let bestH: { diff: number; stop: number } | null = null
    for (const stop of hStops) for (const edge of hEdges) {
      const diff = stop - edge
      if (Math.abs(diff) <= SNAP && (!bestH || Math.abs(diff) < Math.abs(bestH.diff))) bestH = { diff, stop }
    }
    if (bestH) { node.y(node.y() + bestH.diff); lines.push([-9999, bestH.stop, 9999, bestH.stop]) }
    setGuides(lines)
  }

  // ── Inline text editing ─────────────────────────────────────────────────────
  const startEditing = (el: Extract<EditorElement, { type: 'text' }>) => {
    const node = nodeRefs.current[el.id]
    const scaleY = node?.scaleY() ?? el.scaleY
    setEditing({
      id: el.id, value: el.text,
      left: el.x * zoom + pos.x, top: el.y * zoom + pos.y,
      fontSize: el.fontSize * Math.abs(scaleY) * zoom, color: el.fill, fontFamily: el.fontFamily, bold: el.bold,
    })
  }
  const commitEditing = () => {
    if (!editing) return
    const { id, value } = editing
    snapshot()
    setElements((prev) => prev.map((x) => (x.id === id && x.type === 'text' ? { ...x, text: value } : x)))
    setEditing(null)
  }

  // ── Pen / pointer ───────────────────────────────────────────────────────────
  const relPointer = () => stageRef.current?.getRelativePointerPosition() || null
  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (cropping || spaceHeld) return
    if (tool === 'pen') {
      isDrawing.current = true
      const p = relPointer(); if (!p) return
      snapshot()
      setElements((prev) => [...prev, { id: nextId(), type: 'draw', points: [p.x, p.y], stroke: color, strokeWidth, opacity: 1 }])
      return
    }
    // Frame active + press on the background → drag the image to reposition it
    // inside the frame (instead of starting a marquee).
    if (frame && e.target.name() === 'bg') {
      setAdjustOpen(false)
      const p = relPointer()
      if (p) bgPan.current = { px: p.x, py: p.y, fx: bgFocus.x, fy: bgFocus.y }
      return
    }
    // Empty-canvas press → start a marquee (rubber-band) selection.
    if (e.target === e.target.getStage() || e.target.name() === 'bg') {
      setAdjustOpen(false)
      if (!e.evt.shiftKey) clearSel()
      const p = relPointer()
      if (p) { marqueeStart.current = { x: p.x, y: p.y }; setMarquee({ x: p.x, y: p.y, w: 0, h: 0 }) }
    }
  }
  const handleMouseMove = () => {
    if (bgPan.current && frame && bgImage && frameRect) {
      const p = relPointer(); if (!p) return
      const base = Math.max(frameRect.width / bgImage.width, frameRect.height / bgImage.height) * bgZoom
      const cw = frameRect.width / base, ch = frameRect.height / base
      const roomX = Math.max(0, bgImage.width - cw), roomY = Math.max(0, bgImage.height - ch)
      const dxs = (p.x - bgPan.current.px) / base, dys = (p.y - bgPan.current.py) / base
      setBgFocus({
        x: roomX > 0 ? clamp(bgPan.current.fx - dxs / roomX, 0, 1) : 0.5,
        y: roomY > 0 ? clamp(bgPan.current.fy - dys / roomY, 0, 1) : 0.5,
      })
      return
    }
    if (tool === 'pen' && isDrawing.current) {
      const p = relPointer(); if (!p) return
      setElements((prev) => {
        const last = prev[prev.length - 1]
        if (!last || last.type !== 'draw') return prev
        return [...prev.slice(0, -1), { ...last, points: [...last.points, p.x, p.y] }]
      })
      return
    }
    if (marqueeStart.current) {
      const p = relPointer(); if (!p) return
      const s = marqueeStart.current
      setMarquee({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) })
    }
  }
  const handleMouseUp = () => {
    isDrawing.current = false
    if (bgPan.current) { bgPan.current = null; return }
    if (marqueeStart.current && marquee && (marquee.w > 4 || marquee.h > 4)) {
      const layer = stageRef.current?.getStage()?.findOne('Layer') as Konva.Layer | undefined
      const hits = elements.filter((el) => {
        if (el.locked || el.visible === false) return false
        const node = nodeRefs.current[el.id]
        if (!node || !layer) return false
        const b = node.getClientRect({ relativeTo: layer })
        return b.x < marquee.x + marquee.w && b.x + b.width > marquee.x && b.y < marquee.y + marquee.h && b.y + b.height > marquee.y
      }).map((el) => el.id)
      // expand to whole groups
      const groups = new Set(elements.filter((el) => hits.includes(el.id) && el.groupId).map((el) => el.groupId))
      const full = elements.filter((el) => hits.includes(el.id) || (el.groupId && groups.has(el.groupId))).map((el) => el.id)
      setSelectedIds((s) => Array.from(new Set([...s, ...full])))
    }
    marqueeStart.current = null
    setMarquee(null)
  }
  // ── Move every selected node together when one of them is dragged ────────────
  const multiDrag = useRef<{ id: string; sx: number; sy: number; others: { node: Konva.Node; x: number; y: number }[] } | null>(null)
  const beginMultiDrag = (id: string) => {
    snapshot()
    if (selectedIds.length > 1 && selectedIds.includes(id)) {
      const node = nodeRefs.current[id]
      if (!node) return
      multiDrag.current = {
        id, sx: node.x(), sy: node.y(),
        others: selectedIds.filter((x) => x !== id).map((x) => nodeRefs.current[x]).filter(Boolean).map((n) => ({ node: n as Konva.Node, x: (n as Konva.Node).x(), y: (n as Konva.Node).y() })),
      }
    }
  }
  const applyMultiDrag = (e: Konva.KonvaEventObject<DragEvent>) => {
    const md = multiDrag.current
    if (!md || e.target.id() !== md.id) return
    const dx = e.target.x() - md.sx, dy = e.target.y() - md.sy
    md.others.forEach((o) => { o.node.x(o.x + dx); o.node.y(o.y + dy) })
  }
  const endMultiDrag = () => {
    const md = multiDrag.current
    if (md) { md.others.forEach((o) => commitNode(o.node.id(), o.node)) }
    multiDrag.current = null
  }

  // ── Zoom / pan ──────────────────────────────────────────────────────────────
  const resetZoom = () => { setZoom(1); setPos({ x: 0, y: 0 }) }
  const zoomBy = (factor: number) => {
    const stage = stageRef.current
    const c = { x: stageSize.width / 2, y: stageSize.height / 2 }
    const newScale = clamp(zoom * factor, ZMIN, ZMAX)
    const mouseTo = { x: (c.x - pos.x) / zoom, y: (c.y - pos.y) / zoom }
    setZoom(newScale)
    setPos({ x: c.x - mouseTo.x * newScale, y: c.y - mouseTo.y * newScale })
    stage?.batchDraw()
  }
  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    if (!(e.evt.ctrlKey || e.evt.metaKey)) return
    e.evt.preventDefault()
    const stage = stageRef.current
    const pointer = stage?.getPointerPosition(); if (!pointer) return
    const dir = e.evt.deltaY > 0 ? -1 : 1
    const newScale = clamp(zoom * (1 + dir * 0.12), ZMIN, ZMAX)
    const mouseTo = { x: (pointer.x - pos.x) / zoom, y: (pointer.y - pos.y) / zoom }
    setZoom(newScale)
    setPos({ x: pointer.x - mouseTo.x * newScale, y: pointer.y - mouseTo.y * newScale })
  }

  // ── Export / save ───────────────────────────────────────────────────────────
  // Snapshot the active page's design region to a PNG data-URI. Reads
  // designRectRef (not the render-time closure) so it stays correct mid-loop
  // when capturing every page sequentially.
  const captureCurrent = (mime: 'image/png' | 'image/jpeg' = 'image/png'): Promise<{ uri: string; w: number; h: number }> => new Promise((resolve, reject) => {
    clearSel(); setGuides([])
    setTimeout(() => {
      const stage = stageRef.current
      if (!stage) { reject(new Error('no stage')); return }
      const prevScale = stage.scaleX(); const prevPos = stage.position()
      stage.scale({ x: 1, y: 1 }); stage.position({ x: 0, y: 0 }); stage.batchDraw()
      const r = designRectRef.current
      try {
        const base = { pixelRatio: exportScale, mimeType: mime, quality: 0.92 }
        const opts = r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), ...base } : base
        resolve({ uri: stage.toDataURL(opts), w: r?.width ?? stageSize.width, h: r?.height ?? stageSize.height })
      } catch (e) { showToast('Không xử lý được ảnh (canvas bị chặn).', 'error'); reject(e as Error) }
      finally { stage.scale({ x: prevScale, y: prevScale }); stage.position(prevPos); stage.batchDraw() }
    }, 60)
  })
  // Render each page into the live stage in turn, capture it, then restore the
  // page the user was on. Single page → just captures the current one.
  const captureAllPages = async (): Promise<{ uri: string; w: number; h: number }[]> => {
    const pages = orderedPages()
    if (pages.length <= 1) return [await captureCurrent()]
    const out: { uri: string; w: number; h: number }[] = []
    const originalId = activeId
    for (const p of pages) {
      loadPage(p); setActiveId(p.id)
      await new Promise((r) => setTimeout(r, 140)) // let React render + Konva filter-cache settle
      out.push(await captureCurrent())
    }
    const orig = pages.find((p) => p.id === originalId)
    if (orig) { loadPage(orig); setActiveId(originalId) }
    return out
  }
  const handleExport = async (mime: 'image/png' | 'image/jpeg' = 'image/png') => { const { uri } = await captureCurrent(mime); const a = document.createElement('a'); a.download = mime === 'image/jpeg' ? 'edited.jpg' : 'edited.png'; a.href = uri; a.click() }
  const handleExportPdf = async () => {
    const shots = await captureAllPages()
    if (!shots.length) return
    const first = shots[0]
    const pdf = new jsPDF({ orientation: first.w >= first.h ? 'landscape' : 'portrait', unit: 'px', format: [first.w, first.h] })
    shots.forEach((s, i) => { if (i > 0) pdf.addPage([s.w, s.h], s.w >= s.h ? 'landscape' : 'portrait'); pdf.addImage(s.uri, 'PNG', 0, 0, s.w, s.h) })
    pdf.save('design.pdf')
  }
  const handleSave = async () => {
    if (!characterId) return
    setSaving(true)
    try {
      const shots = await captureAllPages()
      // Ảnh chụp từ canvas là PNG — mỗi trang vài MB, và base64 còn cộng thêm 33%.
      // File cuối nằm trong kho vẫn là JPEG q95 nên nén trước khi gửi làm lượt lưu
      // nhẹ đi khoảng 4 lần mà mắt không thấy khác (xem lib/image.ts).
      const payload = await Promise.all(shots.map((sh) => compressForUpload(sh.uri)))
      const updated = await charactersApi.addMedia(characterId, { media: payload })
      showToast(`Đã lưu ${shots.length} ảnh thành media mới.`, 'success')
      onSaved?.(updated); onClose()
    } catch { showToast('Lưu ảnh thất bại.', 'error') } finally { setSaving(false) }
  }

  const setRef = (id: string) => (node: Konva.Node | null) => { if (node) nodeRefs.current[id] = node; else delete nodeRefs.current[id] }
  const selectable = tool === 'select' && !cropping && !spaceHeld
  const txt = selectedEl?.type === 'text' ? selectedEl : null
  const shp = isShapeEl(selectedEl) ? selectedEl : null
  const rectEl = selectedEl?.type === 'rect' ? selectedEl : null
  const lineEl = selectedEl && (selectedEl.type === 'line' || selectedEl.type === 'arrow') ? selectedEl : null
  const imgEl = selectedEl?.type === 'image' ? selectedEl : null

  const RAIL: { t: Panel | 'pen-rail'; title: string; Icon: typeof Type; onClick: () => void; active: boolean }[] = [
    { t: 'templates', title: 'Mẫu', Icon: LayoutTemplate, onClick: () => setPanel((p) => (p === 'templates' ? null : 'templates')), active: panel === 'templates' },
    { t: 'text', title: 'Văn bản', Icon: Type, onClick: () => setPanel((p) => (p === 'text' ? null : 'text')), active: panel === 'text' },
    { t: 'elements', title: 'Thành phần', Icon: Shapes, onClick: () => setPanel((p) => (p === 'elements' ? null : 'elements')), active: panel === 'elements' },
    { t: 'icons', title: 'Biểu tượng', Icon: Smile, onClick: () => setPanel((p) => (p === 'icons' ? null : 'icons')), active: panel === 'icons' },
    { t: 'photos', title: 'Ảnh', Icon: ImagePlus, onClick: () => setPanel((p) => (p === 'photos' ? null : 'photos')), active: panel === 'photos' },
    { t: 'background', title: 'Nền & Lọc', Icon: SlidersHorizontal, onClick: () => setPanel((p) => (p === 'background' ? null : 'background')), active: panel === 'background' },
    { t: 'layers', title: 'Lớp', Icon: LayersIcon, onClick: () => setPanel((p) => (p === 'layers' ? null : 'layers')), active: panel === 'layers' },
    { t: 'resize', title: 'Kích thước', Icon: Frame, onClick: () => setPanel((p) => (p === 'resize' ? null : 'resize')), active: panel === 'resize' },
  ]

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-neutral-800">
      {/* Top contextual property bar */}
      <header className="flex items-center gap-1 overflow-x-auto border-b border-white/10 bg-neutral-900 px-3 text-white" style={{ height: HEADER_H }}>
        <button type="button" onClick={undo} disabled={!past.length} title="Hoàn tác (Ctrl+Z)" className="rounded p-1.5 hover:bg-white/10 disabled:opacity-30"><Undo2 className="size-4" /></button>
        <button type="button" onClick={redo} disabled={!future.length} title="Làm lại (Ctrl+Y)" className="rounded p-1.5 hover:bg-white/10 disabled:opacity-30"><Redo2 className="size-4" /></button>
        <Divider />
        {/* Zoom */}
        <button type="button" onClick={() => zoomBy(1 / 1.2)} title="Thu nhỏ" className="rounded p-1.5 hover:bg-white/10"><ZoomOut className="size-4" /></button>
        <button type="button" onClick={resetZoom} title="Đặt lại 100%" className="w-12 rounded px-1 py-1 text-xs tabular-nums hover:bg-white/10">{Math.round(zoom * 100)}%</button>
        <button type="button" onClick={() => zoomBy(1.2)} title="Phóng to" className="rounded p-1.5 hover:bg-white/10"><ZoomIn className="size-4" /></button>
        <Divider />
        <input type="color" value={color} onChange={(e) => applyColor(e.target.value)} title="Màu" className="h-7 w-7 cursor-pointer rounded border border-white/20 bg-transparent" />
        <button type="button" onClick={eyedrop} title="Hút màu" className="rounded p-1.5 hover:bg-white/10"><Pipette className="size-4" /></button>
        {recentColors.length > 0 && (
          <span className="flex items-center gap-0.5" title="Màu gần đây">
            {recentColors.map((c) => <button key={c} type="button" onClick={() => applyColor(c)} style={{ background: c }} className="size-5 rounded border border-white/20" />)}
          </span>
        )}
        <span className="flex items-center gap-1" title="Độ dày nét"><Pencil className="size-3.5 opacity-60" /><input type="range" min={1} max={40} value={strokeWidth} onChange={(e) => setStrokeWidth(Number(e.target.value))} className="w-14" /></span>
        {selectedEl && (
          <span className="flex items-center gap-1" title="Độ mờ"><Droplet className="size-3.5 opacity-60" /><input type="range" min={10} max={100} value={Math.round((selectedEl.opacity ?? 1) * 100)} onChange={(e) => patchSelected({ opacity: Number(e.target.value) / 100 } as Partial<EditorElement>)} className="w-14" /></span>
        )}

        {txt && (
          <>
            <Divider />
            <select value={txt.fontFamily} onChange={(e) => patchSelected({ fontFamily: e.target.value } as Partial<EditorElement>)} title="Font" className="h-7 rounded bg-neutral-800 px-1 text-xs">
              {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <button type="button" onClick={() => changeFontSize(txt.fontSize - 4)} className="rounded p-1.5 hover:bg-white/10"><Minus className="size-4" /></button>
            <input type="number" value={Math.round(txt.fontSize)} onChange={(e) => changeFontSize(Number(e.target.value))} className="h-7 w-12 rounded bg-neutral-800 px-1 text-center text-xs tabular-nums" />
            <button type="button" onClick={() => changeFontSize(txt.fontSize + 4)} className="rounded p-1.5 hover:bg-white/10"><Plus className="size-4" /></button>
            <Tgl on={txt.bold} onClick={() => patchSelected({ bold: !txt.bold } as Partial<EditorElement>)} title="Đậm"><Bold className="size-4" /></Tgl>
            <Tgl on={txt.italic} onClick={() => patchSelected({ italic: !txt.italic } as Partial<EditorElement>)} title="Nghiêng"><Italic className="size-4" /></Tgl>
            <Tgl on={txt.underline} onClick={() => patchSelected({ underline: !txt.underline } as Partial<EditorElement>)} title="Gạch chân"><Underline className="size-4" /></Tgl>
            <Tgl on={txt.align === 'left'} onClick={() => patchSelected({ align: 'left' } as Partial<EditorElement>)} title="Căn trái"><AlignLeft className="size-4" /></Tgl>
            <Tgl on={txt.align === 'center'} onClick={() => patchSelected({ align: 'center' } as Partial<EditorElement>)} title="Căn giữa"><AlignCenter className="size-4" /></Tgl>
            <Tgl on={txt.align === 'right'} onClick={() => patchSelected({ align: 'right' } as Partial<EditorElement>)} title="Căn phải"><AlignRight className="size-4" /></Tgl>
            <span className="flex items-center gap-1" title="Giãn dòng"><span className="text-[10px] opacity-60">↕</span><input type="range" min={80} max={250} value={txt.lineHeight * 100} onChange={(e) => patchSelected({ lineHeight: Number(e.target.value) / 100 } as Partial<EditorElement>)} className="w-12" /></span>
            <span className="flex items-center gap-1" title="Giãn chữ"><span className="text-[10px] opacity-60">⇆</span><input type="range" min={-5} max={30} value={txt.letterSpacing} onChange={(e) => patchSelected({ letterSpacing: Number(e.target.value) } as Partial<EditorElement>)} className="w-12" /></span>
            <Tgl on={txt.shadow} onClick={() => patchSelected({ shadow: !txt.shadow } as Partial<EditorElement>)} title="Đổ bóng"><Sparkles className="size-4" /></Tgl>
            <Tgl on={txt.outline} onClick={() => patchSelected({ outline: !txt.outline } as Partial<EditorElement>)} title="Viền chữ"><span className="text-xs font-bold">O</span></Tgl>
            <Tgl on={txt.highlight} onClick={() => patchSelected({ highlight: !txt.highlight } as Partial<EditorElement>)} title="Nền chữ"><Highlighter className="size-4" /></Tgl>
            {txt.highlight && <input type="color" value={txt.highlightColor} onChange={(e) => patchSelected({ highlightColor: e.target.value } as Partial<EditorElement>)} title="Màu nền chữ" className="h-7 w-7 cursor-pointer rounded border border-white/20 bg-transparent" />}
            <span className="flex items-center gap-1" title="Cong chữ"><span className="text-[11px] opacity-60">Cong</span><input type="range" min={-100} max={100} value={txt.curve} onChange={(e) => patchSelected({ curve: Number(e.target.value) } as Partial<EditorElement>)} className="w-16" /></span>
          </>
        )}

        {shp && (
          <>
            <Divider />
            <span className="text-[11px] opacity-60">Viền</span>
            <input type="color" value={shp.stroke || '#000000'} onChange={(e) => patchSelected({ stroke: e.target.value, strokeWidth: shp.strokeWidth || 3 } as Partial<EditorElement>)} title="Màu viền" className="h-7 w-7 cursor-pointer rounded border border-white/20 bg-transparent" />
            <input type="range" min={0} max={30} value={shp.strokeWidth || 0} onChange={(e) => patchSelected({ strokeWidth: Number(e.target.value) } as Partial<EditorElement>)} className="w-14" title="Độ dày viền" />
            <Tgl on={!!shp.dash} onClick={() => patchSelected({ dash: !shp.dash } as Partial<EditorElement>)} title="Nét đứt"><span className="text-xs">┄</span></Tgl>
            {rectEl && <span className="flex items-center gap-1" title="Bo góc"><Square className="size-3.5 opacity-60" /><input type="range" min={0} max={80} value={rectEl.cornerRadius} onChange={(e) => patchSelected({ cornerRadius: Number(e.target.value) } as Partial<EditorElement>)} className="w-14" /></span>}
          </>
        )}

        {lineEl && (
          <>
            <Divider />
            <Tgl on={!!lineEl.dash} onClick={() => patchSelected({ dash: !lineEl.dash } as Partial<EditorElement>)} title="Nét đứt"><span className="text-xs">┄</span></Tgl>
          </>
        )}

        {imgEl && (
          <>
            <Divider />
            <button type="button" onClick={() => setAdjustOpen((v) => !v)} className={`inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-white/10 ${adjustOpen ? 'bg-white/20' : ''}`}><SlidersHorizontal className="size-4" /> Bộ lọc</button>
            <button type="button" onClick={removeBgOfSelected} disabled={bgRemoving} className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-white/10 disabled:opacity-50">{bgRemoving ? <Loader2 className="size-4 animate-spin" /> : <Eraser className="size-4" />} Xoá nền</button>
          </>
        )}

        {selectedId && selectedEl && (selectedEl.type === 'text' || selectedEl.type === 'rect' || selectedEl.type === 'ellipse') && (
          <>
            <Divider />
            <Tgl on={!!selectedEl.gradOn} onClick={() => patchSelected({ gradOn: !selectedEl.gradOn, gradFrom: selectedEl.gradFrom || color, gradTo: selectedEl.gradTo || '#ffffff' } as Partial<EditorElement>)} title="Tô gradient"><span className="text-sm">▦</span></Tgl>
            {selectedEl.gradOn && <>
              <input type="color" value={selectedEl.gradFrom || '#000000'} onChange={(e) => patchSelected({ gradFrom: e.target.value } as Partial<EditorElement>)} title="Màu đầu" className="h-7 w-7 cursor-pointer rounded border border-white/20 bg-transparent" />
              <input type="color" value={selectedEl.gradTo || '#ffffff'} onChange={(e) => patchSelected({ gradTo: e.target.value } as Partial<EditorElement>)} title="Màu cuối" className="h-7 w-7 cursor-pointer rounded border border-white/20 bg-transparent" />
            </>}
          </>
        )}

        {selectedEl && selectedEl.type !== 'draw' && (shp || imgEl) && (
          <>
            <Divider />
            <Tgl on={!!selectedEl.shadowOn} onClick={() => patchSelected({ shadowOn: !selectedEl.shadowOn } as Partial<EditorElement>)} title="Đổ bóng"><Sparkles className="size-4" /></Tgl>
            {selectedEl.shadowOn && <>
              <input type="color" value={selectedEl.shadowColor || '#000000'} onChange={(e) => patchSelected({ shadowColor: e.target.value } as Partial<EditorElement>)} title="Màu bóng" className="h-7 w-7 cursor-pointer rounded border border-white/20 bg-transparent" />
              <input type="range" min={0} max={40} value={selectedEl.shadowBlur ?? 12} onChange={(e) => patchSelected({ shadowBlur: Number(e.target.value) } as Partial<EditorElement>)} title="Độ nhoè bóng" className="w-14" />
            </>}
          </>
        )}

        {selectedId && selectedEl && selectedEl.type !== 'draw' && (
          <>
            <Divider />
            <select value={selectedEl.blend || 'source-over'} onChange={(e) => patchSelected({ blend: e.target.value === 'source-over' ? undefined : e.target.value } as Partial<EditorElement>)} title="Hoà trộn (blend)" className="h-7 rounded bg-neutral-800 px-1 text-xs">
              <option value="source-over">Hoà trộn: thường</option>
              <option value="multiply">Multiply</option>
              <option value="screen">Screen</option>
              <option value="overlay">Overlay</option>
              <option value="darken">Darken</option>
              <option value="lighten">Lighten</option>
            </select>
          </>
        )}

        {selectedIds.length > 1 && (
          <>
            <Divider />
            <span className="px-1 text-xs text-white/60">{selectedIds.length} đã chọn</span>
            <button type="button" onClick={groupSelected} title="Nhóm (Ctrl+G)" className="rounded p-1.5 hover:bg-white/10"><Group className="size-4" /></button>
            <button type="button" onClick={ungroupSelected} title="Tách nhóm (Ctrl+Shift+G)" className="rounded p-1.5 hover:bg-white/10"><Ungroup className="size-4" /></button>
          </>
        )}

        {selectedIds.length > 0 && (
          <>
            <Divider />
            <button type="button" onClick={() => alignSelected('left')} title="Căn trái khung" className="rounded p-1.5 hover:bg-white/10"><AlignLeft className="size-4" /></button>
            <button type="button" onClick={() => alignSelected('center')} title="Căn giữa ngang" className="rounded p-1.5 hover:bg-white/10"><AlignCenter className="size-4" /></button>
            <button type="button" onClick={() => alignSelected('right')} title="Căn phải khung" className="rounded p-1.5 hover:bg-white/10"><AlignRight className="size-4" /></button>
            <button type="button" onClick={() => flipSelected('h')} title="Lật ngang" className="rounded p-1.5 hover:bg-white/10"><FlipHorizontal2 className="size-4" /></button>
            <button type="button" onClick={() => flipSelected('v')} title="Lật dọc" className="rounded p-1.5 hover:bg-white/10"><FlipVertical2 className="size-4" /></button>
          </>
        )}

        {selectedIds.length > 0 && (
          <>
            <Divider />
            <button type="button" onClick={duplicateSelected} title="Nhân bản (Ctrl+D)" className="rounded p-1.5 hover:bg-white/10"><Copy className="size-4" /></button>
            {selectedId && <button type="button" onClick={() => reorderSelected('front')} title="Lên trên" className="rounded p-1.5 hover:bg-white/10"><BringToFront className="size-4" /></button>}
            {selectedId && <button type="button" onClick={() => reorderSelected('back')} title="Xuống dưới" className="rounded p-1.5 hover:bg-white/10"><SendToBack className="size-4" /></button>}
            <button type="button" onClick={removeSelected} title="Xoá" className="rounded p-1.5 hover:bg-white/10"><Trash2 className="size-4" /></button>
          </>
        )}

        <div className="ml-auto flex items-center gap-2 pl-2">
          <button type="button" onClick={() => makeThumbnail('tiktok')} title="Khung thumbnail TikTok (9:16)" className="inline-flex items-center gap-1.5 rounded-md bg-neutral-700 px-2.5 py-1.5 text-sm font-medium hover:bg-neutral-600"><Music2 className="size-4" /> TikTok</button>
          <button type="button" onClick={() => makeThumbnail('youtube')} title="Khung thumbnail YouTube (16:9)" className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1.5 text-sm font-medium hover:bg-red-500"><Play className="size-4" /> YouTube</button>
          {characterId != null && (
            <button type="button" onClick={handleSave} disabled={saving} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Lưu
            </button>
          )}
          <select value={exportScale} onChange={(e) => setExportScale(Number(e.target.value))} title="Độ phân giải xuất" className="h-8 rounded-md bg-neutral-800 px-1 text-xs">
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={3}>3x</option>
          </select>
          <button type="button" onClick={() => handleExport('image/png')} title="Tải PNG" className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-sm font-medium hover:bg-blue-500"><Download className="size-4" /> PNG</button>
          <button type="button" onClick={() => handleExport('image/jpeg')} title="Tải JPG" className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-sm font-medium hover:bg-blue-500">JPG</button>
          <button type="button" onClick={handleExportPdf} title="Tải PDF" className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-sm font-medium hover:bg-blue-500"><FileDown className="size-4" /> PDF</button>
          <button type="button" onClick={onClose} title="Đóng" className="rounded p-1.5 hover:bg-white/10"><X className="size-5" /></button>
        </div>
      </header>

      {/* Body: icon rail + sliding panel + workspace */}
      <div className="flex flex-1 overflow-hidden">
        <nav className="flex flex-col items-center gap-1 overflow-y-auto bg-neutral-950 py-2 text-white" style={{ width: RAIL_W }}>
          <RailBtn active={tool === 'select' && !panel} onClick={() => { setTool('select'); setPanel(null) }} title="Chọn" Icon={MousePointer2} />
          {RAIL.map(({ t, title, Icon, onClick, active }) => <RailBtn key={t} active={active} onClick={onClick} title={title} Icon={Icon} />)}
          <span className="my-1 h-px w-8 bg-white/15" />
          <RailBtn active={tool === 'pen'} onClick={() => handleRail('pen')} title="Vẽ tay" Icon={Pencil} />
          <RailBtn active={false} onClick={insertQr} title="Mã QR" Icon={QrCode} />
          <RailBtn active={cropping} onClick={startCrop} title="Cắt ảnh" Icon={Crop} />
          <RailBtn active={!!inpaintSrc} onClick={openInpaint} title="Tẩy vật" Icon={Eraser} />
          <RailBtn active={!!retouchSrc} onClick={openRetouch} title="Tút ảnh" Icon={Wand2} />
          <RailBtn active={!!colorSrc} onClick={openColor} title="Chỉnh màu" Icon={SlidersHorizontal} />
          <RailBtn active={!!recolorSrc} onClick={openRecolor} title="Đổi màu vùng" Icon={Droplet} />
        </nav>

        {panel && (
          <aside className="flex flex-col border-r border-white/10 bg-neutral-900 text-white" style={{ width: PANEL_W }}>
            {panel === 'templates' && <TemplatesPanel onApply={applyTemplate} />}
            {panel === 'text' && <TextPanel onAdd={addText} />}
            {panel === 'elements' && <ElementsPanel onAddShape={addShape} onPickIcon={insertIcon} />}
            {panel === 'icons' && <IconsPanel onPick={insertIcon} />}
            {panel === 'photos' && <PhotosPanel onUpload={() => fileRef.current?.click()} onInsertUrl={insertFromUrl} onQr={insertQr} />}
            {panel === 'background' && <BackgroundPanel adjust={bgAdjust} setAdjust={setBgAdjust} bgColor={bgColor} setBgColor={setBgColor} onRemoveBg={removeBgOfBackground} removing={bgRemoving} hasBg={!!bgImage} hasFrame={!!frame} bgFocus={bgFocus} setBgFocus={setBgFocus} bgZoom={bgZoom} setBgZoom={setBgZoom} />}
            {panel === 'resize' && <ResizePanel frame={frame} onPick={applyFrame} />}
            {panel === 'layers' && <LayersPanel
              elements={elements} selectedId={selectedId} onSelect={selectOne}
              onToggle={(id, k) => { const el = elements.find((e) => e.id === id); if (el) patchById(id, { [k]: !el[k] } as Partial<EditorElement>) }}
              onReorder={(from, to) => { snapshot(); setElements((prev) => { const a = [...prev]; const [m] = a.splice(from, 1); a.splice(to, 0, m); return a }) }}
              dragRef={dragLayerId}
            />}
          </aside>
        )}

        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="relative flex-1 overflow-hidden" onDrop={handleDropFiles} onDragOver={(e) => e.preventDefault()}>
          {imgEl && adjustOpen && (
            <AdjustPanel title="Bộ lọc ảnh" adjust={imgEl.adjust} onChange={(a) => patchById(imgEl.id, { adjust: a } as Partial<EditorElement>)} onClose={() => setAdjustOpen(false)} />
          )}

          <Stage
            ref={stageRef}
            width={stageSize.width}
            height={stageSize.height}
            scaleX={zoom}
            scaleY={zoom}
            x={pos.x}
            y={pos.y}
            draggable={spaceHeld}
            onDragEnd={(e) => { if (e.target === e.target.getStage()) setPos({ x: e.target.x(), y: e.target.y() }) }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            style={{ cursor: spaceHeld ? 'grab' : tool === 'pen' ? 'crosshair' : bgPan.current ? 'grabbing' : frame ? 'move' : 'default' }}
          >
            <Layer>
              {(bgColor || frame) && designRect && <Rect x={designRect.x} y={designRect.y} width={designRect.width} height={designRect.height} fill={bgColor || '#ffffff'} listening={false} />}
              {bgImage && bgImgProps && (
                <KonvaImage ref={bgNodeRef} name="bg" image={bgImage} {...bgImgProps} listening={tool !== 'pen'} />
              )}
              {frame && designRect && <Rect x={designRect.x} y={designRect.y} width={designRect.width} height={designRect.height} stroke="#3b82f6" strokeWidth={1 / zoom} listening={false} />}

              {elements.map((el) => {
                if (el.visible === false) return null
                if (editing && editing.id === el.id) return null // hide the node being edited (textarea shows instead)
                if (el.type === 'draw') {
                  return <Line key={el.id} points={el.points} stroke={el.stroke} strokeWidth={el.strokeWidth} opacity={el.opacity} lineCap="round" lineJoin="round" tension={0.4} listening={false} />
                }
                const locked = !!el.locked
                const common = {
                  ref: setRef(el.id),
                  id: el.id,
                  x: el.x, y: el.y, rotation: el.rotation, scaleX: el.scaleX, scaleY: el.scaleY, opacity: el.opacity,
                  globalCompositeOperation: (el.blend || undefined) as GlobalCompositeOperation | undefined,
                  draggable: selectable && !locked,
                  listening: !locked,
                  onClick: (e: Konva.KonvaEventObject<MouseEvent>) => { if (selectable && !locked) selectElement(el, e.evt.shiftKey) },
                  onTap: () => { if (selectable && !locked) selectElement(el, false) },
                  onDragStart: () => beginMultiDrag(el.id),
                  onTransformStart: snapshot,
                  onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => { handleDragMove(e); applyMultiDrag(e) },
                  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => { commitNode(el.id, e.target); endMultiDrag(); setGuides([]) },
                  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => commitNode(el.id, e.target),
                }
                switch (el.type) {
                  case 'text': {
                    const fontStyle = `${el.bold ? 'bold' : ''} ${el.italic ? 'italic' : ''}`.trim() || 'normal'
                    if (el.curve) {
                      const w = measureTextW(el.text, el.fontSize, el.fontFamily, el.bold, el.italic)
                      return (
                        <TextPath key={el.id} {...common} text={el.text} fontSize={el.fontSize} fill={el.fill}
                          fontFamily={el.fontFamily} fontStyle={fontStyle} data={arcPath(w, el.curve, el.fontSize)}
                          stroke={el.outline ? '#000' : undefined} strokeWidth={el.outline ? 2 : 0} fillAfterStrokeEnabled
                          shadowColor={el.shadow ? '#000' : undefined} shadowBlur={el.shadow ? 8 : 0} shadowOffsetY={el.shadow ? 3 : 0}
                          onDblClick={() => startEditing(el)} onDblTap={() => startEditing(el)} />
                      )
                    }
                    const textNode = (
                      <Text {...common} text={el.text} fontSize={el.fontSize} {...fillOf(el, { x: 0, y: 0 }, { x: 0, y: el.fontSize })}
                        fontFamily={el.fontFamily} fontStyle={fontStyle} align={el.align}
                        lineHeight={el.lineHeight} letterSpacing={el.letterSpacing}
                        textDecoration={el.underline ? 'underline' : ''}
                        shadowColor={el.shadow ? '#000' : undefined} shadowBlur={el.shadow ? 8 : 0} shadowOffsetY={el.shadow ? 3 : 0}
                        stroke={el.outline ? '#000' : undefined} strokeWidth={el.outline ? 2 : 0} fillAfterStrokeEnabled
                        onDblClick={() => startEditing(el)} onDblTap={() => startEditing(el)} />
                    )
                    if (!el.highlight) return <Text key={el.id} {...(textNode.props)} />
                    return (
                      <Label key={el.id} {...common} onDblClick={() => startEditing(el)} onDblTap={() => startEditing(el)}>
                        <Tag fill={el.highlightColor} cornerRadius={4} />
                        <Text text={el.text} fontSize={el.fontSize} fill={el.fill} padding={6}
                          fontFamily={el.fontFamily} fontStyle={fontStyle} align={el.align}
                          lineHeight={el.lineHeight} letterSpacing={el.letterSpacing}
                          textDecoration={el.underline ? 'underline' : ''} />
                      </Label>
                    )
                  }
                  case 'rect': return <Rect key={el.id} {...common} width={el.width} height={el.height} {...fillOf(el, { x: 0, y: 0 }, { x: el.width, y: el.height })} cornerRadius={el.cornerRadius} {...strokeOf(el)} {...shadowOf(el)} />
                  case 'ellipse': return <Ellipse key={el.id} {...common} radiusX={el.radiusX} radiusY={el.radiusY} {...fillOf(el, { x: -el.radiusX, y: -el.radiusY }, { x: el.radiusX, y: el.radiusY })} {...strokeOf(el)} {...shadowOf(el)} />
                  case 'triangle': return <RegularPolygon key={el.id} {...common} sides={3} radius={el.radius} fill={el.fill} {...strokeOf(el)} {...shadowOf(el)} />
                  case 'hexagon': return <RegularPolygon key={el.id} {...common} sides={6} radius={el.radius} fill={el.fill} {...strokeOf(el)} {...shadowOf(el)} />
                  case 'star': return <KStar key={el.id} {...common} numPoints={5} innerRadius={el.outerRadius * 0.45} outerRadius={el.outerRadius} fill={el.fill} {...strokeOf(el)} {...shadowOf(el)} />
                  case 'heart': return <Path key={el.id} {...common} data={HEART_PATH} fill={el.fill} {...strokeOf(el)} {...shadowOf(el)} />
                  case 'bubble': return <Path key={el.id} {...common} data={BUBBLE_PATH} fill={el.fill} {...strokeOf(el)} {...shadowOf(el)} />
                  case 'line': return <Line key={el.id} {...common} points={el.points} stroke={el.stroke} strokeWidth={el.strokeWidth} dash={el.dash ? [el.strokeWidth * 2, el.strokeWidth] : undefined} lineCap="round" />
                  case 'arrow': return <Arrow key={el.id} {...common} points={el.points} stroke={el.stroke} fill={el.stroke} strokeWidth={el.strokeWidth} dash={el.dash ? [el.strokeWidth * 2, el.strokeWidth] : undefined} pointerLength={el.strokeWidth * 3} pointerWidth={el.strokeWidth * 3} />
                  default: return <KonvaImage key={el.id} {...common} image={el.img} width={el.width} height={el.height} {...shadowOf(el)} />
                }
              })}

              {guides.map((g, i) => <Line key={`g${i}`} points={g} stroke="#ec4899" strokeWidth={1 / zoom} dash={[4, 4]} listening={false} />)}

              {marquee && (marquee.w > 1 || marquee.h > 1) && (
                <Rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill="#3b82f6" opacity={0.12} stroke="#3b82f6" strokeWidth={1 / zoom} listening={false} />
              )}

              <Transformer ref={trRef} rotateEnabled keepRatio={false} />

              {cropping && cropRect && (
                <>
                  <Rect x={-9999} y={-9999} width={29999} height={9999 + cropRect.y} fill="#000" opacity={0.45} listening={false} />
                  <Rect x={-9999} y={cropRect.y + cropRect.height} width={29999} height={19999} fill="#000" opacity={0.45} listening={false} />
                  <Rect x={-9999} y={cropRect.y} width={9999 + cropRect.x} height={cropRect.height} fill="#000" opacity={0.45} listening={false} />
                  <Rect x={cropRect.x + cropRect.width} y={cropRect.y} width={19999} height={cropRect.height} fill="#000" opacity={0.45} listening={false} />
                  <Rect
                    ref={cropRef}
                    x={cropRect.x} y={cropRect.y} width={cropRect.width} height={cropRect.height}
                    stroke="#fff" strokeWidth={2} dash={[6, 6]} draggable
                    onDragEnd={(e) => setCropRect({ ...cropRect, x: e.target.x(), y: e.target.y() })}
                    onTransformEnd={(e) => {
                      const n = e.target
                      const w = Math.max(20, n.width() * n.scaleX())
                      const h = Math.max(20, n.height() * n.scaleY())
                      n.scaleX(1); n.scaleY(1)
                      setCropRect({ x: n.x(), y: n.y(), width: w, height: h })
                    }}
                  />
                  <Transformer ref={cropTrRef} rotateEnabled={false} />
                </>
              )}
            </Layer>
          </Stage>

          {cropping && (
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-2">
              <button type="button" onClick={applyCrop} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"><Check className="size-4" /> Áp dụng</button>
              <button type="button" onClick={cancelCrop} className="inline-flex items-center gap-1.5 rounded-md bg-neutral-700 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-600"><X className="size-4" /> Huỷ</button>
            </div>
          )}

          {!spaceHeld && (
            <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/50 px-2 py-0.5 text-[10px] text-white/70">
              Ctrl+cuộn để zoom · giữ Space để kéo · phím mũi tên để nhích
            </div>
          )}

          {editing && (
            <textarea
              autoFocus
              value={editing.value}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onBlur={commitEditing}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEditing() } if (e.key === 'Escape') setEditing(null) }}
              style={{ position: 'absolute', left: editing.left, top: editing.top, fontSize: editing.fontSize, color: editing.color, fontFamily: editing.fontFamily, fontWeight: editing.bold ? 700 : 400, lineHeight: 1.1, background: 'transparent', border: '1px dashed #3b82f6', outline: 'none', padding: 2, margin: 0, resize: 'both', minWidth: 60, textShadow: '0 0 3px rgba(0,0,0,.85), 0 0 3px rgba(0,0,0,.85)' }}
            />
          )}
          </div>
          <PageStrip pages={pageOrder} activeId={activeId} onSwitch={switchPage} onAdd={addPage} onDuplicate={duplicatePage} onDelete={deletePage} />
        </div>
      </div>

      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) handleInsertImage(f); e.target.value = '' }} />

      {inpaintSrc && (
        <InpaintOverlay
          image={inpaintSrc}
          onClose={() => setInpaintSrc(null)}
          onApply={(uri) => { const img = new window.Image(); img.onload = () => { snapshot(); setBgImage(img) }; img.src = uri }}
        />
      )}

      {retouchSrc && (
        <RetouchOverlay
          image={retouchSrc}
          onClose={() => setRetouchSrc(null)}
          onApply={(uri) => { const img = new window.Image(); img.onload = () => { snapshot(); setBgImage(img) }; img.src = uri }}
        />
      )}

      {colorSrc && (
        <ColorOverlay
          image={colorSrc}
          onClose={() => setColorSrc(null)}
          onApply={(uri) => { const img = new window.Image(); img.onload = () => { snapshot(); setBgImage(img) }; img.src = uri }}
        />
      )}

      {recolorSrc && (
        <RecolorOverlay
          image={recolorSrc}
          onClose={() => setRecolorSrc(null)}
          onApply={(uri) => { const img = new window.Image(); img.onload = () => { snapshot(); setBgImage(img) }; img.src = uri }}
        />
      )}
    </div>
  )
}

// ── Small UI helpers ──────────────────────────────────────────────────────────
function RailBtn({ active, onClick, title, Icon }: { active: boolean; onClick: () => void; title: string; Icon: typeof Type }) {
  return (
    <button type="button" onClick={onClick} title={title} className={`flex w-14 flex-col items-center gap-0.5 rounded-md py-1.5 text-[9px] leading-none hover:bg-white/10 ${active ? 'bg-white/20' : ''}`}>
      <Icon className="size-5" />
      <span>{title}</span>
    </button>
  )
}
function Divider() { return <span className="mx-1 h-6 w-px shrink-0 bg-white/15" /> }
function PageStrip({ pages, activeId, onSwitch, onAdd, onDuplicate, onDelete }: {
  pages: string[]; activeId: string; onSwitch: (id: string) => void
  onAdd: () => void; onDuplicate: () => void; onDelete: () => void
}) {
  return (
    <div className="flex items-center gap-2 border-t border-white/10 bg-neutral-900 px-3 text-white" style={{ height: PAGESTRIP_H }}>
      <div className="flex flex-1 items-center gap-1.5 overflow-x-auto py-2">
        {pages.map((id, i) => (
          <button key={id} type="button" onClick={() => onSwitch(id)}
            className={`flex h-12 w-16 shrink-0 items-center justify-center rounded-md border text-xs font-medium ${id === activeId ? 'border-blue-400 bg-blue-600/20 text-white' : 'border-white/15 bg-white/5 text-white/70 hover:bg-white/10'}`}>
            Trang {i + 1}
          </button>
        ))}
        <button type="button" onClick={onAdd} title="Thêm trang" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-dashed border-white/25 text-white/70 hover:bg-white/10"><Plus className="size-5" /></button>
      </div>
      <Divider />
      <button type="button" onClick={onDuplicate} title="Nhân bản trang" className="rounded p-2 hover:bg-white/10"><Copy className="size-4" /></button>
      <button type="button" onClick={onDelete} disabled={pages.length <= 1} title="Xoá trang" className="rounded p-2 hover:bg-white/10 disabled:opacity-30"><Trash2 className="size-4" /></button>
    </div>
  )
}
function Tgl({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} title={title} className={`rounded p-1.5 hover:bg-white/10 ${on ? 'bg-white/20' : ''}`}>{children}</button>
}
function PanelHead({ children }: { children: React.ReactNode }) {
  return <h3 className="border-b border-white/10 px-3 py-2.5 text-sm font-semibold">{children}</h3>
}

// ── Panels ────────────────────────────────────────────────────────────────────
function TemplatesPanel({ onApply }: { onApply: (t: TemplateDef) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHead>Mẫu thiết kế</PanelHead>
      <div className="grid grid-cols-2 gap-2 overflow-y-auto p-3">
        {TEMPLATES.map((t) => (
          <button key={t.id} type="button" onClick={() => onApply(t)} className="flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-md border border-white/10 bg-gradient-to-br from-white/10 to-white/5 p-2 text-center text-xs hover:from-white/20">
            <LayoutTemplate className="size-5 opacity-70" />
            <span className="leading-tight">{t.name}</span>
          </button>
        ))}
      </div>
      <p className="border-t border-white/10 px-3 py-2 text-[10px] text-white/40">Áp mẫu sẽ thay các lớp hiện có (hoàn tác được).</p>
    </div>
  )
}

function ResizePanel({ frame, onPick }: { frame: { w: number; h: number; label: string } | null; onPick: (f: { w: number; h: number; label: string } | null) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHead>Kích thước khung</PanelHead>
      <div className="flex flex-col gap-1.5 overflow-y-auto p-3">
        <button type="button" onClick={() => onPick(null)} className={`flex items-center justify-between rounded-md px-3 py-2.5 text-sm ${!frame ? 'bg-blue-600/30 ring-1 ring-blue-400' : 'bg-white/5 hover:bg-white/10'}`}>
          <span>Tự do (theo ảnh)</span>
        </button>
        {FRAMES.map((f) => {
          const active = frame?.w === f.w && frame?.h === f.h
          return (
            <button key={f.label} type="button" onClick={() => onPick(f)} className={`flex items-center justify-between rounded-md px-3 py-2.5 text-sm ${active ? 'bg-blue-600/30 ring-1 ring-blue-400' : 'bg-white/5 hover:bg-white/10'}`}>
              <span>{f.label}</span>
              <span className="text-xs text-white/50">{f.w}×{f.h}</span>
            </button>
          )
        })}
      </div>
      <p className="border-t border-white/10 px-3 py-2 text-[10px] text-white/40">Ảnh nền được đặt "cover" trong khung; xuất ảnh theo đúng khung.</p>
    </div>
  )
}

function TextPanel({ onAdd }: { onAdd: (p: 'heading' | 'subheading' | 'body') => void }) {
  return (
    <div className="flex flex-col">
      <PanelHead>Văn bản</PanelHead>
      <div className="flex flex-col gap-2 p-3">
        <button type="button" onClick={() => onAdd('heading')} className="rounded-lg bg-white/5 px-3 py-3 text-left text-2xl font-bold hover:bg-white/10">Thêm tiêu đề</button>
        <button type="button" onClick={() => onAdd('subheading')} className="rounded-lg bg-white/5 px-3 py-2.5 text-left text-lg font-semibold hover:bg-white/10">Thêm phụ đề</button>
        <button type="button" onClick={() => onAdd('body')} className="rounded-lg bg-white/5 px-3 py-2 text-left text-sm hover:bg-white/10">Thêm đoạn nội dung</button>
        <p className="mt-1 text-xs text-white/50">Nhấp đôi vào chữ trên canvas để sửa nội dung.</p>
      </div>
    </div>
  )
}

function ElementsPanel({ onAddShape, onPickIcon }: { onAddShape: (t: Tool) => void; onPickIcon: (name: string) => void }) {
  const shapes: { t: Tool; Icon: typeof Type; title: string }[] = [
    { t: 'rect', Icon: Square, title: 'Chữ nhật' },
    { t: 'roundedRect', Icon: Square, title: 'Bo góc' },
    { t: 'ellipse', Icon: Circle, title: 'Tròn' },
    { t: 'triangle', Icon: Triangle, title: 'Tam giác' },
    { t: 'star', Icon: Star, title: 'Sao' },
    { t: 'hexagon', Icon: Hexagon, title: 'Lục giác' },
    { t: 'heart', Icon: Heart, title: 'Tim' },
    { t: 'bubble', Icon: MessageCircle, title: 'Thoại' },
    { t: 'line', Icon: Slash, title: 'Đường' },
    { t: 'arrow', Icon: MoveUpRight, title: 'Mũi tên' },
  ]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHead>Thành phần</PanelHead>
      <div className="px-3 pb-1 pt-2 text-xs font-medium text-white/60">Hình khối</div>
      <div className="grid grid-cols-4 gap-1.5 px-3 pb-2">
        {shapes.map(({ t, Icon, title }) => (
          <button key={t} type="button" onClick={() => onAddShape(t)} title={title} className="flex aspect-square items-center justify-center rounded-md bg-white/5 hover:bg-white/15"><Icon className="size-6" /></button>
        ))}
      </div>
      <div className="px-3 pb-1 pt-1 text-xs font-medium text-white/60">Biểu tượng</div>
      <InlineIconPicker onPick={onPickIcon} />
    </div>
  )
}

function IconsPanel({ onPick }: { onPick: (name: string) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHead>Biểu tượng</PanelHead>
      <InlineIconPicker onPick={onPick} />
    </div>
  )
}

/** Iconify search — keyless, CORS-enabled SVG API. */
function InlineIconPicker({ onPick }: { onPick: (name: string) => void }) {
  const [q, setQ] = useState('')
  const [icons, setIcons] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const search = async (query: string) => {
    if (!query.trim()) return
    setLoading(true)
    try {
      const res = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(query)}&limit=60`)
      const data = await res.json()
      setIcons(data.icons || [])
    } catch { setIcons([]) } finally { setLoading(false) }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
      <div className="mb-2 flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2">
        <Search className="size-4 text-white/50" />
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search(q)} placeholder="Tìm icon (home, heart)…" className="w-full bg-transparent py-1.5 text-sm outline-none" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-6 gap-1 overflow-y-auto">
        {loading && <div className="col-span-6 flex justify-center py-6"><Loader2 className="size-5 animate-spin text-white/50" /></div>}
        {!loading && icons.map((name) => (
          <button key={name} type="button" onClick={() => onPick(name)} title={name} className="flex aspect-square items-center justify-center rounded hover:bg-white/15">
            <img src={`https://api.iconify.design/${name.replace(':', '/')}.svg?height=28&color=white`} alt={name} className="size-7" />
          </button>
        ))}
        {!loading && !icons.length && <div className="col-span-6 py-6 text-center text-xs text-white/40">Gõ từ khoá rồi Enter.</div>}
      </div>
    </div>
  )
}

interface PexelsPhoto { id: number; src: { tiny: string; large: string; large2x: string } }
function PhotosPanel({ onUpload, onInsertUrl, onQr }: { onUpload: () => void; onInsertUrl: (url: string, maxFrac?: number) => void; onQr: () => void }) {
  const [q, setQ] = useState('')
  const [photos, setPhotos] = useState<PexelsPhoto[]>([])
  const [loading, setLoading] = useState(false)
  const search = async (query: string) => {
    if (!PEXELS_KEY || !query.trim()) return
    setLoading(true)
    try {
      const res = await fetch(`https://api.pexels.com/v1/search?per_page=30&query=${encodeURIComponent(query)}`, { headers: { Authorization: PEXELS_KEY } })
      const data = await res.json()
      setPhotos(data.photos || [])
    } catch { setPhotos([]) } finally { setLoading(false) }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHead>Ảnh</PanelHead>
      <div className="flex gap-2 px-3 pt-2">
        <button type="button" onClick={onUpload} className="flex-1 rounded-md bg-white/10 px-2 py-2 text-xs font-medium hover:bg-white/20">⬆ Tải từ máy</button>
        <button type="button" onClick={onQr} className="rounded-md bg-white/10 px-2 py-2 text-xs font-medium hover:bg-white/20">QR</button>
      </div>
      {!PEXELS_KEY ? (
        <p className="m-3 rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-200">
          Ảnh kho (Pexels) chưa bật. Thêm <code className="rounded bg-black/30 px-1">VITE_PEXELS_API_KEY</code> (free tại pexels.com/api) vào <code className="rounded bg-black/30 px-1">ui/.env</code> rồi chạy lại để tìm ảnh miễn phí.
        </p>
      ) : (
        <>
          <div className="mx-3 mt-2 flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2">
            <Search className="size-4 text-white/50" />
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search(q)} placeholder="Tìm ảnh kho…" className="w-full bg-transparent py-1.5 text-sm outline-none" />
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-1.5 overflow-y-auto p-3">
            {loading && <div className="col-span-2 flex justify-center py-6"><Loader2 className="size-5 animate-spin text-white/50" /></div>}
            {!loading && photos.map((p) => (
              <button key={p.id} type="button" onClick={() => onInsertUrl(p.src.large)} className="overflow-hidden rounded-md hover:opacity-80">
                <img src={p.src.tiny} alt="" className="h-24 w-full object-cover" />
              </button>
            ))}
            {!loading && !photos.length && <div className="col-span-2 py-6 text-center text-xs text-white/40">Gõ từ khoá rồi Enter.</div>}
          </div>
        </>
      )}
    </div>
  )
}

function BackgroundPanel({ adjust, setAdjust, bgColor, setBgColor, onRemoveBg, removing, hasBg, hasFrame, bgFocus, setBgFocus, bgZoom, setBgZoom }: { adjust: Adjust; setAdjust: (a: Adjust) => void; bgColor: string; setBgColor: (c: string) => void; onRemoveBg: () => void; removing: boolean; hasBg: boolean; hasFrame: boolean; bgFocus: { x: number; y: number }; setBgFocus: (f: { x: number; y: number }) => void; bgZoom: number; setBgZoom: (z: number) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PanelHead>Nền & Bộ lọc</PanelHead>
      {hasFrame && hasBg && (
        <div className="border-b border-white/10 p-3">
          <div className="mb-1.5 text-xs font-medium text-white/60">Ảnh trong khung <span className="font-normal text-white/40">— kéo ảnh trên canvas để di chuyển</span></div>
          <label className="flex items-center gap-2 text-xs"><span className="w-10 text-white/70">Phóng</span>
            <input type="range" min={100} max={300} value={Math.round(bgZoom * 100)} onChange={(e) => setBgZoom(Number(e.target.value) / 100)} className="flex-1" /><span className="w-8 text-right tabular-nums text-white/50">{Math.round(bgZoom * 100)}%</span></label>
          <label className="mt-1.5 flex items-center gap-2 text-xs"><span className="w-10 text-white/70">Ngang</span>
            <input type="range" min={0} max={100} value={Math.round(bgFocus.x * 100)} onChange={(e) => setBgFocus({ ...bgFocus, x: Number(e.target.value) / 100 })} className="flex-1" /></label>
          <label className="mt-1.5 flex items-center gap-2 text-xs"><span className="w-10 text-white/70">Dọc</span>
            <input type="range" min={0} max={100} value={Math.round(bgFocus.y * 100)} onChange={(e) => setBgFocus({ ...bgFocus, y: Number(e.target.value) / 100 })} className="flex-1" /></label>
          <button type="button" onClick={() => { setBgFocus({ x: 0.5, y: 0.5 }); setBgZoom(1) }} className="mt-2 inline-flex items-center justify-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[11px] hover:bg-white/15"><RotateCcw className="size-3" /> Đặt lại</button>
        </div>
      )}
      {hasBg && (
        <div className="px-3 pt-3">
          <button type="button" onClick={onRemoveBg} disabled={removing} className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-white/10 px-2 py-2 text-sm font-medium hover:bg-white/20 disabled:opacity-50">
            {removing ? <Loader2 className="size-4 animate-spin" /> : <Eraser className="size-4" />} Xoá nền ảnh
          </button>
          <p className="mt-1 text-[10px] text-white/40">Xử lý trên máy chủ (rembg/U²-Net) — không tải model về máy.</p>
        </div>
      )}
      <div className="p-3">
        <div className="mb-1 text-xs font-medium text-white/60">Màu nền (vùng trong suốt)</div>
        <div className="grid grid-cols-8 gap-1.5">
          <button type="button" onClick={() => setBgColor('')} title="Không" className="flex aspect-square items-center justify-center rounded border border-white/20 bg-white/5 text-[10px]">∅</button>
          {SWATCHES.map((c) => <button key={c} type="button" onClick={() => setBgColor(c)} style={{ background: c }} className={`aspect-square rounded border ${bgColor === c ? 'border-blue-400' : 'border-white/20'}`} />)}
        </div>
      </div>
      <AdjustControls adjust={adjust} onChange={setAdjust} label="Bộ lọc ảnh nền" />
    </div>
  )
}

function AdjustPanel({ title, adjust, onChange, onClose }: { title: string; adjust: Adjust; onChange: (a: Adjust) => void; onClose: () => void }) {
  return (
    <div className="absolute right-3 top-3 z-10 w-64 rounded-lg border border-white/15 bg-neutral-900 text-white shadow-xl">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-sm font-semibold">{title}</span>
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-white/10"><X className="size-4" /></button>
      </div>
      <AdjustControls adjust={adjust} onChange={onChange} />
    </div>
  )
}

function AdjustControls({ adjust, onChange, label }: { adjust: Adjust; onChange: (a: Adjust) => void; label?: string }) {
  const set = (patch: Partial<Adjust>) => onChange({ ...adjust, ...patch })
  const Slider = ({ k, name, min, max, scale = 1 }: { k: keyof Adjust; name: string; min: number; max: number; scale?: number }) => (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 text-white/70">{name}</span>
      <input type="range" min={min} max={max} value={(adjust[k] as number) / scale} onChange={(e) => set({ [k]: Number(e.target.value) * scale } as Partial<Adjust>)} className="flex-1" />
    </label>
  )
  return (
    <div className="flex flex-col gap-2.5 p-3">
      {label && <div className="text-xs font-medium text-white/60">{label}</div>}
      <div className="flex flex-wrap gap-1">
        {FILTER_PRESETS.map((p) => (
          <button key={p.name} type="button" onClick={() => onChange({ ...p.a })} className="rounded-md bg-white/5 px-2 py-1 text-[11px] hover:bg-white/20">{p.name}</button>
        ))}
      </div>
      <Slider k="brightness" name="Độ sáng" min={-50} max={50} scale={0.01} />
      <Slider k="contrast" name="Tương phản" min={-80} max={80} />
      <Slider k="saturation" name="Bão hoà" min={-80} max={80} scale={0.0125} />
      <Slider k="blur" name="Làm mờ" min={0} max={40} />
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={() => set({ grayscale: !adjust.grayscale })} className={`flex-1 rounded-md px-2 py-1.5 text-xs ${adjust.grayscale ? 'bg-white/25' : 'bg-white/5 hover:bg-white/15'}`}>Đen trắng</button>
        <button type="button" onClick={() => set({ sepia: !adjust.sepia })} className={`flex-1 rounded-md px-2 py-1.5 text-xs ${adjust.sepia ? 'bg-white/25' : 'bg-white/5 hover:bg-white/15'}`}>Sepia</button>
      </div>
      <button type="button" onClick={() => onChange({ ...NO_ADJUST })} className="mt-1 inline-flex items-center justify-center gap-1 rounded-md bg-white/5 px-2 py-1.5 text-xs hover:bg-white/15"><RotateCcw className="size-3.5" /> Đặt lại</button>
    </div>
  )
}

function LayersPanel({ elements, selectedId, onSelect, onToggle, onReorder, dragRef }: {
  elements: EditorElement[]; selectedId: string | null; onSelect: (id: string) => void
  onToggle: (id: string, key: 'visible' | 'locked') => void; onReorder: (from: number, to: number) => void
  dragRef: { current: string | null }
}) {
  const label = (el: EditorElement) => {
    if (el.type === 'text') return el.text.slice(0, 18) || 'Văn bản'
    if (el.type === 'image') return 'Ảnh'
    if (el.type === 'draw') return 'Nét vẽ'
    return ({ rect: 'Chữ nhật', ellipse: 'Hình tròn', triangle: 'Tam giác', star: 'Ngôi sao', hexagon: 'Lục giác', heart: 'Trái tim', bubble: 'Bong bóng', line: 'Đường', arrow: 'Mũi tên' } as Record<string, string>)[el.type] || el.type
  }
  // Top layer first.
  const rows = elements.map((el, i) => ({ el, i })).reverse()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHead>Lớp</PanelHead>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!rows.length && <p className="px-2 py-6 text-center text-xs text-white/40">Chưa có lớp nào. Thêm chữ/hình/ảnh.</p>}
        {rows.map(({ el, i }) => (
          <div
            key={el.id}
            draggable
            onDragStart={() => { dragRef.current = el.id }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { const from = elements.findIndex((x) => x.id === dragRef.current); if (from >= 0 && from !== i) onReorder(from, i); dragRef.current = null }}
            onClick={() => onSelect(el.id)}
            className={`mb-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs ${selectedId === el.id ? 'bg-blue-600/30 ring-1 ring-blue-400' : 'bg-white/5 hover:bg-white/10'}`}
          >
            <span className="flex-1 truncate">{label(el)}</span>
            <button type="button" onClick={(e) => { e.stopPropagation(); onToggle(el.id, 'visible') }} title="Ẩn/hiện" className="rounded p-0.5 hover:bg-white/15">{el.visible === false ? <EyeOff className="size-3.5 opacity-50" /> : <Eye className="size-3.5" />}</button>
            <button type="button" onClick={(e) => { e.stopPropagation(); onToggle(el.id, 'locked') }} title="Khoá" className="rounded p-0.5 hover:bg-white/15">{el.locked ? <Lock className="size-3.5 text-amber-300" /> : <LockOpen className="size-3.5 opacity-50" />}</button>
          </div>
        ))}
      </div>
      <p className="border-t border-white/10 px-3 py-2 text-[10px] text-white/40">Kéo–thả để đổi thứ tự lớp.</p>
    </div>
  )
}
