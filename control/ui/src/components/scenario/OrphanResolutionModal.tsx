/**
 * v3.2 — OrphanResolutionModal
 *
 * Chốt #14 Round 12: khi user xoá shot mà có shot khác đang FRAME_ANCHOR tới
 * → BE trả 409 với payload { orphans, reanchor_candidates } → modal này hiện
 * cho user chọn (a) Convert orphan sang NEW_SCENE; (b) Re-anchor sang shot khác;
 * (c) Huỷ xoá.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface OrphanInfo {
  shot_id: number
  character_in_frame: string
}

interface ReanchorCandidate {
  shot_id: number
  character_in_frame: string
  continuity_mode: string
}

interface Props {
  open: boolean
  deletingShotId: number
  orphans: OrphanInfo[]
  reanchorCandidates: ReanchorCandidate[]
  onConfirm: (resolution: string) => void   // 'convert_new_scene' | `reanchor:${shot_id}`
  onCancel: () => void
  loading?: boolean
}

export default function OrphanResolutionModal({
  open, deletingShotId, orphans, reanchorCandidates, onConfirm, onCancel, loading,
}: Props) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'convert' | 'reanchor'>('convert')
  const [reanchorTo, setReanchorTo] = useState<number | null>(
    reanchorCandidates[0]?.shot_id ?? null,
  )

  if (!open) return null

  const orphanList = orphans.map((o) => `Shot ${o.shot_id} (${o.character_in_frame || 'None'})`).join(', ')

  function handleConfirm() {
    if (mode === 'convert') {
      onConfirm('convert_new_scene')
    } else if (reanchorTo) {
      onConfirm(`reanchor:${reanchorTo}`)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between border-b border-border px-5 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="size-5 text-amber-500 mt-0.5" />
            <div>
              <h2 className="text-base font-semibold">
                {t('content.aiScenario.orphan.title', { shot_id: deletingShotId })}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('content.aiScenario.orphan.warning', { orphans: orphanList })}
              </p>
            </div>
          </div>
          <button onClick={onCancel} disabled={loading}
            className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50">
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
          {/* Option A: Convert NEW_SCENE */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="radio" name="resolution" value="convert"
              checked={mode === 'convert'} onChange={() => setMode('convert')}
              disabled={loading}
              className="mt-1" />
            <div>
              <div className="font-medium">{t('content.aiScenario.orphan.optionConvert')}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t('content.aiScenario.orphan.optionConvertDesc')}
              </div>
            </div>
          </label>

          {/* Option B: Re-anchor */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="radio" name="resolution" value="reanchor"
              checked={mode === 'reanchor'} onChange={() => setMode('reanchor')}
              disabled={loading || reanchorCandidates.length === 0}
              className="mt-1" />
            <div className="flex-1">
              <div className="font-medium">{t('content.aiScenario.orphan.optionReanchor')}</div>
              <div className="text-xs text-muted-foreground mt-0.5 mb-2">
                {t('content.aiScenario.orphan.optionReanchorDesc')}
              </div>
              {mode === 'reanchor' && (
                <select
                  value={reanchorTo ?? ''}
                  onChange={(e) => setReanchorTo(Number(e.target.value))}
                  disabled={loading}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                >
                  {reanchorCandidates.map((c) => (
                    <option key={c.shot_id} value={c.shot_id}>
                      Shot {c.shot_id} — {c.character_in_frame || 'None'} ({c.continuity_mode})
                    </option>
                  ))}
                </select>
              )}
              {reanchorCandidates.length === 0 && (
                <div className="text-xs italic text-red-600">
                  {t('content.aiScenario.orphan.noReanchorCandidates')}
                </div>
              )}
            </div>
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            {t('content.aiScenario.orphan.cancelDelete')}
          </Button>
          <Button onClick={handleConfirm} disabled={loading || (mode === 'reanchor' && !reanchorTo)}>
            {loading
              ? t('content.aiScenario.orphan.deleting')
              : t('content.aiScenario.orphan.confirmDelete')}
          </Button>
        </div>
      </div>
    </div>
  )
}
