/**
 * FrameTieredEditor — visual grouping of the 7 frame fields by role.
 *
 * Phase 5 layout (replaces the prior flat 2-col grid that mixed audio +
 * visual + production-meta into one wall of textareas):
 *
 *   Tier 1 — Âm thanh & chữ : Voice (full-w) + Text/Music (½ each)
 *   Tier 2 — Hình ảnh       : Visual (full-w)
 *   Tier 3 — Dựng           : Footage / Time / Note  (3-col compact,
 *                              read-only in real_footage mode)
 *
 * Used in 2 places:
 *   - PreviewKbRefineModal (local React state, no auto-save)
 *   - ContentDetailPage    (DB-backed, parent's onChange triggers PATCH)
 *
 * This component is presentation-only: it does NOT debounce / call APIs.
 * The parent decides what `onChange` does.
 */
import { useTranslation } from 'react-i18next'
import type { GeneratedScriptFrame } from '@/lib/types'

interface Props {
  frame: GeneratedScriptFrame
  /** Generation mode — drives the locked vs editable styling of Tier 3. */
  mode: 'real_footage' | 'ai_video'
  /** Caller decides which fields are editable. Lets the post-save view
   *  add an extra layer (e.g. preview-mode read-only) on top of `mode`. */
  isEditable: (field: keyof GeneratedScriptFrame) => boolean
  /** Called on every keystroke. Parent decides what to do (debounce save,
   *  immediate local state update, etc). */
  onChange: (field: keyof GeneratedScriptFrame, value: string) => void
}

type FieldKey = 'Voice' | 'Text' | 'Visual' | 'Music' | 'Footage' | 'Time' | 'Note'

export function FrameTieredEditor({ frame, mode, isEditable, onChange }: Props) {
  const { t } = useTranslation()
  const lockHint = mode === 'real_footage' ? t('content.fieldLock.realFootage') : undefined
  const productionLocked = !isEditable('Footage') && !isEditable('Time') && !isEditable('Note')

  function renderField(key: FieldKey, opts: { rows?: number } = {}) {
    const editable = isEditable(key)
    const value = typeof frame[key] === 'string' ? String(frame[key]) : ''
    const rows = opts.rows ?? 1
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {key}
        </span>
        {editable ? (
          <textarea
            value={value}
            onChange={(e) => onChange(key, e.target.value)}
            rows={rows}
            className="resize-y rounded border border-border bg-background px-1.5 py-1 text-[13px] leading-snug outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
          />
        ) : (
          <p
            className="whitespace-pre-wrap rounded border border-dashed border-border/70 bg-muted/30 px-1.5 py-1 text-[13px] leading-snug text-muted-foreground"
            title={lockHint}
          >
            {value || <span className="italic opacity-60">{t('content.editableField.empty')}</span>}
          </p>
        )}
      </div>
    )
  }

  // Compact layout — tier groupings are conveyed by spacing only (no labels).
  // Field labels (Voice/Text/Music/Visual/Footage/Time/Note) self-explain.
  // 2026-05-28: removed the tier-label rows after user feedback that they
  // ate too much vertical space and made one frame fill the viewport.
  return (
    <div className="flex flex-col gap-2">
      {/* Audio & captions */}
      {renderField('Voice', { rows: 2 })}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {renderField('Text', { rows: 1 })}
        {renderField('Music', { rows: 1 })}
      </div>

      {/* Visual */}
      {renderField('Visual', { rows: 2 })}

      {/* Production meta — locked badge inline, no extra label row */}
      {productionLocked && (
        <div className="-mb-1 flex items-center gap-1 text-[10px] text-muted-foreground/80">
          <span className="h-px flex-1 bg-border/60" />
          <span>🔒 {t(`content.mode.${mode}`)}</span>
          <span className="h-px flex-1 bg-border/60" />
        </div>
      )}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        {renderField('Footage', { rows: 1 })}
        {renderField('Time', { rows: 1 })}
        {renderField('Note', { rows: 1 })}
      </div>
    </div>
  )
}
