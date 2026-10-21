/**
 * PatchSuggestionCard — inline AI-proposed patch in a chat bubble.
 *
 * Phase 5 — replaces the standalone RefineFrameModal: when the chat AI
 * decides to refine a frame (via the `apply_frame_patch` tool), the
 * before/after diff lives RIGHT IN the assistant bubble with Apply /
 * Discard buttons. No modal hop, no separate workflow.
 *
 * Apply behaviour is owned by the parent via the `onApply(after)` callback
 * so the same card works in 2 contexts:
 *   - Post-save (ContentDetailPage): parent calls /update-frame
 *   - Preview (PreviewKbRefineModal): parent mutates local state
 *
 * Discard is purely visual — collapses the card. The patch already lived
 * in chat history (DB or FE state); we don't delete it server-side.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Film, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FramePatch } from '@/lib/types'

interface Props {
  patch: FramePatch
  /** Called when user clicks Apply. Should commit `after` fields somewhere
   *  (DB for post-save, local state for preview) and resolve when done. */
  onApply: (after: FramePatch['after'], frameIndex: number) => Promise<void>
}

type Status = 'pending' | 'applying' | 'applied' | 'discarded' | 'error'

const FIELDS: Array<keyof FramePatch['after']> = ['Voice', 'Text', 'Visual', 'Music']

export function PatchSuggestionCard({ patch, onApply }: Props) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<Status>('pending')
  const [error, setError] = useState('')

  async function handleApply() {
    setStatus('applying')
    setError('')
    try {
      await onApply(patch.after, patch.frame_index)
      setStatus('applied')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  // Collapsed states render minimally so chat history stays readable.
  if (status === 'discarded') {
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
        <X className="size-3" />
        {t('content.patch.discarded', { n: patch.frame_index })}
      </div>
    )
  }
  if (status === 'applied') {
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-green-100 px-2 py-1 text-[11px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <CheckCircle2 className="size-3" />
        {t('content.patch.applied', { n: patch.frame_index })}
      </div>
    )
  }

  // Filter to only fields with a real diff (skip no-op + skip empty-both).
  // The server already drops no-op patches in `_process_chat_turn`, but
  // defending here keeps the card visibly clean if any sneak through.
  const visibleFields = FIELDS.filter((key) => {
    const oldVal = String(patch.before[key] ?? '')
    const newVal = String(patch.after[key] ?? '')
    return oldVal !== newVal && (oldVal || newVal)
  })

  return (
    <div className="mt-1.5 rounded-md border border-primary/30 bg-background p-2 shadow-sm">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
          <Film className="size-3" />
          {t('content.patch.title', { n: patch.frame_index })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => setStatus('discarded')}
            disabled={status === 'applying'}
          >
            {t('content.patch.discard')}
          </Button>
          <Button
            size="sm"
            className="h-6 gap-1 px-2 text-[10px]"
            onClick={handleApply}
            disabled={status === 'applying'}
          >
            {status === 'applying' ? (
              <><Loader2 className="size-2.5 animate-spin" />{t('content.patch.applying')}</>
            ) : (
              <><CheckCircle2 className="size-2.5" />{t('content.patch.apply')}</>
            )}
          </Button>
        </div>
      </div>
      <div className="space-y-1.5">
        {visibleFields.map((key) => {
          const oldVal = String(patch.before[key] ?? '')
          const newVal = String(patch.after[key] ?? '')
          return (
            <div key={key} className="text-[11px]">
              <span className="mr-1 inline-block min-w-[42px] font-semibold uppercase tracking-wide text-muted-foreground">
                {key}
              </span>
              {oldVal && (
                <span className="leading-snug line-through opacity-60">{oldVal}</span>
              )}
              {oldVal && <span className="mx-1 text-muted-foreground">→</span>}
              <span className="font-medium leading-snug text-green-700 dark:text-green-400">
                {newVal || <em className="opacity-60">{t('content.editableField.empty')}</em>}
              </span>
            </div>
          )
        })}
      </div>
      {error && <p className="mt-1.5 text-[10px] text-destructive">{error}</p>}
    </div>
  )
}
