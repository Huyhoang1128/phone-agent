/**
 * AI Scenario v3 — Generate modal
 *
 * Doc: docs/Gen_Scenario/ai-scenario-v3-thiet-ke.md §14 (FE component tree)
 *
 * Flow:
 *   1. User mở modal từ ContentPage (nút "AI Scenario")
 *   2. Fill brief + duration (preset + tuỳ chỉnh) + (tuỳ chọn) file/paste + nâng cao shot count + genre
 *   3. POST /content-scenarios/generate/ → trả ScenarioJSON
 *   4. navigate('/content-scenarios/draft', state: scenario)
 */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Loader2, X, Sparkles, ChevronDown, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { contentScenariosApi } from '@/lib/api'
import type { ScenarioGenre } from '@/lib/types'

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024  // OQ3: 10 MB
const ALLOWED_EXTS = ['.xlsx', '.docx', '.pdf', '.txt']

type DurationPreset = 15 | 30 | 60 | 'custom'

interface Props {
  open: boolean
  onClose: () => void
}

export default function ScenarioGenerateModal({ open, onClose }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [brief, setBrief] = useState('')
  const [durationPreset, setDurationPreset] = useState<DurationPreset>(30)
  const [durationCustom, setDurationCustom] = useState<number | ''>('')
  const [genre, setGenre] = useState<ScenarioGenre>('seeding')

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [shotCountOverride, setShotCountOverride] = useState<number | ''>('')
  const [brandOverride, setBrandOverride] = useState('')

  const [file, setFile] = useState<File | null>(null)
  const [pasteText, setPasteText] = useState('')

  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState('')
  // BUG-G FIX: AbortController để hủy generate đang chạy ở FE side.
  // 3D upgrade: kèm request_id để POST /cancel/ trước khi abort → BE SET Redis
  // flag → orchestrator raise ScenarioCancelled → return 499 → tiết kiệm cost.
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef<string>('')

  if (!open) return null

  const duration = durationPreset === 'custom'
    ? (typeof durationCustom === 'number' ? durationCustom : 30)
    : durationPreset
  const defaultShotCount = Math.max(3, Math.round(duration / 5))
  const shotCount = typeof shotCountOverride === 'number' && shotCountOverride > 0
    ? shotCountOverride
    : defaultShotCount

  function reset() {
    setBrief('')
    setDurationPreset(30)
    setDurationCustom('')
    setGenre('seeding')
    setShowAdvanced(false)
    setShotCountOverride('')
    setBrandOverride('')
    setFile(null)
    setPasteText('')
    setError('')
    setIsGenerating(false)
  }

  function close() {
    // BUG-G + 3D: hủy generate đang chạy với TRUE cancel backend.
    // Flow: POST /cancel/{request_id} → BE SET Redis flag → orchestrator raise
    // ScenarioCancelled ở layer boundary tiếp theo → return 499 → tiết kiệm
    // ~50-70% LLM cost. Sau đó AbortController.abort() ngắt fetch FE.
    if (isGenerating && abortRef.current) {
      const rid = requestIdRef.current
      if (rid) {
        // Fire-and-forget POST cancel — KHÔNG await để abort xảy ra ngay.
        // Best-effort: nếu Redis fail vẫn OK (BE check_cancel no-op).
        contentScenariosApi.cancelGenerate(rid).catch(() => { /* noop */ })
      }
      abortRef.current.abort()
      abortRef.current = null
      requestIdRef.current = ''
      showToast(t('content.aiScenario.generateCancelled', {
        defaultValue: 'Đã hủy. Pipeline AI sẽ stop ở layer tiếp theo — tiết kiệm cost.',
      }), 'info')
    }
    reset()
    onClose()
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setError('')
    const f = e.target.files?.[0] || null
    if (!f) {
      setFile(null)
      return
    }
    const ext = f.name.toLowerCase().slice(f.name.lastIndexOf('.'))
    if (!ALLOWED_EXTS.includes(ext)) {
      setError(t('content.aiScenario.unsupportedFormat'))
      e.target.value = ''
      return
    }
    if (f.size > MAX_UPLOAD_BYTES) {
      setError(t('content.aiScenario.fileTooLarge'))
      e.target.value = ''
      return
    }
    setFile(f)
  }

  async function handleGenerate() {
    if (!brief.trim()) {
      setError(t('content.aiScenario.briefRequired'))
      return
    }
    if (durationPreset === 'custom') {
      const d = Number(durationCustom)
      if (!Number.isFinite(d) || d < 10 || d > 120) {
        // BUG-H FIX: trước báo nhầm `unsupportedFormat` (về file extension) khi
        // user nhập duration ngoài range — đổi sang key đúng nói rõ 10-120s.
        setError(t('content.aiScenario.durationOutOfRange', {
          defaultValue: 'Thời lượng phải trong khoảng 10-120 giây',
        }))
        return
      }
    }
    setError('')
    setIsGenerating(true)
    // BUG-G + 3D: AbortController + request_id (UUIDv4) cho TRUE cancel BE.
    // crypto.randomUUID() — modern browser support (Chrome 92+, Safari 15+).
    // Fallback: dùng Math.random nếu UUID API missing (cũ).
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`
    requestIdRef.current = requestId
    try {
      const resp = await contentScenariosApi.generate({
        brief: brief.trim(),
        duration_target_seconds: duration,
        shot_count_target: shotCount,
        genre,
        brand_override: brandOverride.trim() || undefined,
        file: file || undefined,
        paste_text: pasteText.trim() || undefined,
        request_id: requestId,
      }, ctrl.signal)
      showToast(t('content.aiScenario.title'), 'success')
      navigate('/content-scenarios/draft', {
        state: {
          scenario: resp.scenario,
          intent_json: resp.intent_json,
          source_file_name: resp.source_file_name,
          warning: resp.warning,
        },
      })
      reset()
      onClose()
    } catch (e) {
      // (1) Nếu user abort → fetch throws AbortError. Skip toast vì close() đã show.
      if (e instanceof DOMException && e.name === 'AbortError') {
        return
      }
      // (2) BE trả 499 (CANCELLED detected via Redis) → khác AbortError vì user
      // có thể đã click Hủy nhưng abort kịp respond trước; hoặc fetch hoàn tất
      // với 499 status. Skip silently — toast đã hiện ở close().
      if (e instanceof Error && (e.message.includes('CANCELLED:') || e.message.includes('Đã hủy'))) {
        return
      }
      const msg = e instanceof Error ? e.message : t('content.aiScenario.genError')
      setError(msg)
      showToast(msg, 'error')
    } finally {
      abortRef.current = null
      requestIdRef.current = ''
      setIsGenerating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-6 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Sparkles className="size-5 text-violet-500" />
              {t('content.aiScenario.title')}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('content.aiScenario.description')}</p>
          </div>
          {/* BUG-G FIX: nút X close luôn enable — khi đang generate, click sẽ abort */}
          <button onClick={close}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            title={isGenerating ? t('content.aiScenario.generateCancelHint', { defaultValue: 'Hủy generate đang chạy' }) : ''}>
            <X className="size-5" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-5 px-6 py-5">
          {/* Brief */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('content.aiScenario.briefLabel')} <span className="text-red-500">*</span></label>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={t('content.aiScenario.briefPlaceholder')}
              rows={3}
              maxLength={4000}
              disabled={isGenerating}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>

          {/* Duration */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('content.aiScenario.durationLabel')}</label>
            <div className="flex flex-wrap gap-2">
              {[15, 30, 60].map((d) => (
                <button key={d} type="button"
                  onClick={() => setDurationPreset(d as DurationPreset)}
                  disabled={isGenerating}
                  className={`rounded-md border px-4 py-1.5 text-sm transition ${
                    durationPreset === d
                      ? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-200'
                      : 'border-border bg-background hover:bg-muted'
                  }`}>
                  {d}s
                </button>
              ))}
              <button type="button"
                onClick={() => setDurationPreset('custom')}
                disabled={isGenerating}
                className={`rounded-md border px-4 py-1.5 text-sm transition ${
                  durationPreset === 'custom'
                    ? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-200'
                    : 'border-border bg-background hover:bg-muted'
                }`}>
                {t('content.aiScenario.durationCustom')}
              </button>
              {durationPreset === 'custom' && (
                <input type="number" min={10} max={120}
                  value={durationCustom}
                  onChange={(e) => setDurationCustom(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder={t('content.aiScenario.durationCustomPlaceholder')}
                  disabled={isGenerating}
                  className="w-32 rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              )}
            </div>
          </div>

          {/* Genre */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('content.aiScenario.genreLabel')}</label>
            <select
              value={genre}
              onChange={(e) => setGenre(e.target.value as ScenarioGenre)}
              disabled={isGenerating}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
            >
              <option value="seeding">{t('content.aiScenario.genreOptions.seeding')}</option>
              <option value="testimonial">{t('content.aiScenario.genreOptions.testimonial')}</option>
              <option value="educational">{t('content.aiScenario.genreOptions.educational')}</option>
              <option value="brand_story">{t('content.aiScenario.genreOptions.brand_story')}</option>
            </select>
          </div>

          {/* File upload */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('content.aiScenario.fileLabel')}</label>
            <input type="file" accept=".xlsx,.docx,.pdf,.txt" onChange={handleFileChange} disabled={isGenerating}
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-violet-500/10 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-violet-700 dark:file:text-violet-200" />
            {file && <p className="text-xs text-muted-foreground">{file.name} ({Math.round(file.size / 1024)} KB)</p>}
          </div>

          {/* Paste text */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('content.aiScenario.pasteLabel')}</label>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={3}
              maxLength={50000}
              disabled={isGenerating}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>

          {/* Advanced */}
          <div>
            <button type="button" onClick={() => setShowAdvanced((v) => !v)} disabled={isGenerating}
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
              {showAdvanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              {t('content.aiScenario.advancedToggle')}
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3 rounded-lg border border-dashed border-border p-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('content.aiScenario.shotCountLabel')} (default {defaultShotCount})</label>
                  <input type="number" min={1} max={20}
                    value={shotCountOverride}
                    onChange={(e) => setShotCountOverride(e.target.value === '' ? '' : Number(e.target.value))}
                    disabled={isGenerating}
                    className="w-32 rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('content.aiScenario.brandOverrideLabel')}</label>
                  <textarea
                    value={brandOverride}
                    onChange={(e) => setBrandOverride(e.target.value)}
                    placeholder={t('content.aiScenario.brandOverridePlaceholder')}
                    rows={2}
                    maxLength={4000}
                    disabled={isGenerating}
                    className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-xs" />
                </div>
              </div>
            )}
          </div>

          {/* Error */}
          {error && <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">{error}</div>}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border bg-card px-6 py-4">
          {/* BUG-G FIX: nút Hủy luôn enable. Khi đang generate → abort + close. */}
          <Button variant="ghost" onClick={close}>
            {t('common.cancel') || 'Huỷ'}
          </Button>
          <Button onClick={handleGenerate} disabled={isGenerating || !brief.trim()}>
            {isGenerating ? (
              <><Loader2 className="mr-2 size-4 animate-spin" />{t('content.aiScenario.running')}</>
            ) : (
              <><Sparkles className="mr-1 size-4" />{t('content.aiScenario.start')}</>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
