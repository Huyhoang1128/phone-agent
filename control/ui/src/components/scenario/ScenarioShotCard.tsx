/**
 * v3.2.2 — ScenarioShotCard compact preview (progressive disclosure refactored).
 * 
 * - Hiển thị read-only preview cho các trường cốt lõi (Voice Over, Hành động).
 * - Click vào thẻ để chọn và kích hoạt biên tập trong Inspector ở cột phải.
 * - Giữ các icon hành động: Hỏi AI, Restore, Lịch sử, Xóa.
 */
import {
  AlertTriangle,
  History,
  Loader2,
  MessageSquare,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { continuityChipClass, funnelPillClass, layout } from '@/lib/scenario-tokens'
import type { ContinuityMode, ScenarioShot } from '@/lib/types'

interface Props {
  shot: ScenarioShot
  onAskAi: () => void
  onSelect: () => void
  onRestore?: () => void
  onOpenHistory?: () => void
  onDelete?: () => void
  isDeleting?: boolean
  isActive?: boolean
}

export function ScenarioShotCard({
  shot,
  onAskAi,
  onSelect,
  onRestore,
  onOpenHistory,
  onDelete,
  isDeleting,
  isActive,
}: Props) {
  const { t } = useTranslation()
  const continuityLabel = continuityModeLabel(shot.continuity_mode, shot.anchor_source_id, t)
  const hasWarning = (shot.warnings?.length || 0) > 0

  return (
    <div
      id={`shot-anchor-${shot.shot_id}`}
      onClick={onSelect}
      className={[
        layout.cardSurface,
        layout.cardSurfaceHover,
        'overflow-hidden scroll-mt-20 cursor-pointer transition-all duration-200',
        isActive
          ? 'border-indigo-500 ring-2 ring-indigo-500/20 bg-indigo-500/5'
          : 'bg-card border-border/60 hover:bg-muted/10',
      ].join(' ')}
    >
      {/* ── Header — shot meta + actions ─────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/20 px-3 py-1.5 border-b border-border/40">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-bold text-foreground">
            Shot {shot.shot_id}
          </span>
          {shot.funnel_part && (
            <span className={[
              'rounded px-1.5 py-0.5 text-[9px] font-medium border',
              funnelPillClass(shot.funnel_part)
            ].join(' ')}>
              {shot.funnel_part}
            </span>
          )}
          {shot.character_in_frame && shot.character_in_frame !== 'None' && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground font-medium">
              @{shot.character_in_frame}
            </span>
          )}
          <span className={`rounded border px-1.5 py-0.5 text-[9px] ${continuityChipClass(shot.continuity_mode)}`}>
            {continuityLabel}
          </span>
          {hasWarning && (
            <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 border border-amber-500/40 px-1.5 py-0.5 text-[9px] text-amber-700 dark:text-amber-300">
              <AlertTriangle className="size-2.5" />
              {shot.warnings?.length ?? 0}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onAskAi}
            className="rounded p-1 text-indigo-600 hover:bg-indigo-500/10"
            title={t('content.aiScenario.askAi')}
            aria-label="Hỏi AI"
          >
            <MessageSquare className="size-3.5" />
          </button>
          {onRestore && (
            <button
              onClick={onRestore}
              className="rounded p-1 text-amber-600 hover:bg-amber-500/10"
              title={t('content.aiScenario.restoreShot')}
              aria-label="Khôi phục shot"
            >
              <RotateCcw className="size-3.5" />
            </button>
          )}
          {onOpenHistory && (
            <button
              onClick={onOpenHistory}
              className="rounded p-1 text-sky-600 hover:bg-sky-500/10"
              title={t('content.aiScenario.shotHistoryButton')}
              aria-label="Lịch sử shot"
            >
              <History className="size-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              disabled={isDeleting}
              className="rounded p-1 text-red-600 hover:bg-red-500/10 disabled:opacity-50"
              title={t('content.aiScenario.deleteShot', { defaultValue: 'Xoá' })}
              aria-label={t('content.aiScenario.deleteShot', { defaultValue: 'Xoá shot' })}
            >
              {isDeleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* ── Body — Compact Previews ─────────────────────────────────────── */}
      <div className="p-2.5 space-y-2">
        {/* voice_over preview */}
        {shot.voice_over && (
          <div className="text-xs leading-relaxed text-foreground">
            <span className="font-semibold text-muted-foreground uppercase text-[9px] mr-1 block">Voice Over:</span>
            <p className="line-clamp-2 italic bg-muted/10 p-1.5 rounded border border-border/20 text-muted-foreground">
              "{shot.voice_over}"
            </p>
          </div>
        )}

        {/* kinetic_action preview */}
        {shot.kinetic_action && (
          <div className="text-xs leading-relaxed text-foreground">
            <span className="font-semibold text-muted-foreground uppercase text-[9px] mr-1 block">Hành động:</span>
            <p className="line-clamp-2 bg-muted/5 p-1.5 rounded border border-border/10">
              {shot.kinetic_action}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Helper: continuity_mode label ───────────────────────────────────────────

function continuityModeLabel(
  mode: ContinuityMode,
  anchor: number | null,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  if (mode === 'FRAME_ANCHOR')
    return t('content.aiScenario.continuityFrameAnchor', { from: anchor ?? '?' })
  if (mode === 'B_ROLL_CUT') return t('content.aiScenario.continuityBRollCut')
  return t('content.aiScenario.continuityNewScene')
}
