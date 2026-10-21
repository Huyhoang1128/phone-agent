/**
 * v3.2 — ScenarioVariantModal
 *
 * Chốt #16 Round 12: Generate similar (variant from saved scenario).
 * Modal pre-fill brief + intent từ scenario gốc; user chỉ cần thêm "variant prompt"
 * (vd "tone bí ẩn hơn") → reuse intent_json → skip Layer 2 Parser → tiết kiệm
 * ~5s + $0.002.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { contentScenariosApi } from '@/lib/api'
import type { ContentScenarioItem, ScenarioGenre } from '@/lib/types'

type DurationPreset = 15 | 30 | 60 | 'custom'

interface Props {
  open: boolean
  original: ContentScenarioItem
  onClose: () => void
}

export default function ScenarioVariantModal({ open, original, onClose }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { showToast } = useToast()

  // Pre-fill từ original
  const [brief, setBrief] = useState(original.brief || '')
  const [variantPrompt, setVariantPrompt] = useState('')
  const [genre, setGenre] = useState<ScenarioGenre>(original.genre)
  const [durationPreset, setDurationPreset] = useState<DurationPreset>(
    [15, 30, 60].includes(original.duration_target_seconds)
      ? (original.duration_target_seconds as DurationPreset)
      : 'custom'
  )
  const [durationCustom, setDurationCustom] = useState<number | ''>(
    original.duration_target_seconds
  )
  const [shotCountOverride, setShotCountOverride] = useState<number | ''>(
    original.shot_count_target
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  if (!open) return null

  const duration = durationPreset === 'custom'
    ? (typeof durationCustom === 'number' ? durationCustom : original.duration_target_seconds)
    : durationPreset

  async function handleGenerate() {
    if (!brief.trim()) {
      setError(t('content.aiScenario.briefRequired'))
      return
    }
    setError('')
    setLoading(true)
    try {
      const resp = await contentScenariosApi.generateVariant(original.id, {
        brief: brief.trim(),
        variant_prompt: variantPrompt.trim() || undefined,
        duration_target_seconds: duration,
        shot_count_target: typeof shotCountOverride === 'number' ? shotCountOverride : undefined,
        genre,
      })
      showToast(t('content.aiScenario.variant.success'), 'success')
      navigate('/content-scenarios/draft', {
        state: {
          scenario: resp.scenario,
          intent_json: resp.intent_json,
          source_file_name: resp.source_file_name,
          warning: resp.warning,
        },
      })
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('content.aiScenario.variant.failed')
      setError(msg)
      showToast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <RefreshCw className="size-4 text-violet-500" />
            {t('content.aiScenario.variant.title')}
          </h2>
          <button onClick={onClose} disabled={loading}
            className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50">
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-xs text-muted-foreground">
            {t('content.aiScenario.variant.description', { title: original.title })}
          </p>

          {/* Variant prompt — KEY field */}
          <div className="space-y-1">
            <label className="text-sm font-medium">{t('content.aiScenario.variant.promptLabel')}</label>
            <textarea
              value={variantPrompt}
              onChange={(e) => setVariantPrompt(e.target.value)}
              placeholder={t('content.aiScenario.variant.promptPlaceholder')}
              rows={2}
              maxLength={1000}
              disabled={loading}
              className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </div>

          {/* Brief (editable from original) */}
          <div className="space-y-1">
            <label className="text-sm font-medium">
              {t('content.aiScenario.briefLabel')} <span className="text-xs text-muted-foreground">(pre-filled)</span>
            </label>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={3}
              maxLength={4000}
              disabled={loading}
              className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </div>

          {/* Duration + Genre row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">{t('content.aiScenario.durationLabel')}</label>
              <div className="flex gap-1">
                {[15, 30, 60].map((d) => (
                  <button key={d} type="button"
                    onClick={() => setDurationPreset(d as DurationPreset)}
                    disabled={loading}
                    className={`flex-1 rounded border px-2 py-1 text-xs ${
                      durationPreset === d ? 'border-violet-500 bg-violet-500/10' : 'border-border'
                    }`}>
                    {d}s
                  </button>
                ))}
              </div>
              {durationPreset === 'custom' && (
                <input type="number" min={10} max={120}
                  value={durationCustom}
                  onChange={(e) => setDurationCustom(e.target.value === '' ? '' : Number(e.target.value))}
                  disabled={loading}
                  className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs" />
              )}
              <button type="button"
                onClick={() => setDurationPreset('custom')}
                disabled={loading}
                className={`text-xs underline ${durationPreset === 'custom' ? 'text-violet-600' : 'text-muted-foreground'}`}>
                {t('content.aiScenario.durationCustom')}
              </button>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium">{t('content.aiScenario.genreLabel')}</label>
              <select
                value={genre}
                onChange={(e) => setGenre(e.target.value as ScenarioGenre)}
                disabled={loading}
                className="w-full rounded border border-border bg-background px-2 py-1 text-sm">
                <option value="seeding">{t('content.aiScenario.genreOptions.seeding')}</option>
                <option value="testimonial">{t('content.aiScenario.genreOptions.testimonial')}</option>
                <option value="educational">{t('content.aiScenario.genreOptions.educational')}</option>
                <option value="brand_story">{t('content.aiScenario.genreOptions.brand_story')}</option>
              </select>
            </div>
          </div>

          {/* Shot count override */}
          <div className="space-y-1">
            <label className="text-xs font-medium">
              {t('content.aiScenario.shotCountLabel')} <span className="text-muted-foreground">(optional)</span>
            </label>
            <input type="number" min={1} max={20}
              value={shotCountOverride}
              onChange={(e) => setShotCountOverride(e.target.value === '' ? '' : Number(e.target.value))}
              disabled={loading}
              className="w-32 rounded border border-border bg-background px-2 py-1 text-xs" />
          </div>

          {error && <div className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-600">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {t('common.cancel') || 'Huỷ'}
          </Button>
          <Button onClick={handleGenerate} disabled={loading || !brief.trim()}>
            {loading
              ? <><Loader2 className="mr-1 size-3.5 animate-spin" />{t('content.aiScenario.variant.generating')}</>
              : <><RefreshCw className="mr-1 size-3.5" />{t('content.aiScenario.variant.generate')}</>
            }
          </Button>
        </div>
      </div>
    </div>
  )
}
