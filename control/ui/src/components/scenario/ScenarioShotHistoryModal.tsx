/**
 * v3.2.1 Phase 5 — Shot History modal cho rollback per-shot từ audit log.
 *
 * v3.2.1 UX-E (improvement): trước đây mỗi entry chỉ show 1 field summary đầu
 * tiên có content (voice_over) → user không phân biệt được các entry nếu chỉ
 * đổi kinetic_action. Giờ:
 *
 * - Hiển thị DIFF per-field: previous_value (sẽ revert về) → fields_changed (giá trị sau)
 *   bằng red-strikethrough → emerald (giống PatchDiffPreview)
 * - Show action badge + actor_id
 * - Group theo session time nếu nhiều entry cùng thời điểm
 */
import {Clock, History, Loader2, RotateCcw, X} from 'lucide-react'
import {useEffect, useState} from 'react'
import {useTranslation} from 'react-i18next'

import {Button} from '@/components/ui/button'
import {useToast} from '@/context/ToastContext'
import {contentScenariosApi} from '@/lib/api'
import type {ScenarioHistoryEntry} from '@/lib/types'

interface Props {
  scenarioId: number
  shotId: number
  isOpen: boolean
  onClose: () => void
  onRestored: () => void
}

export function ScenarioShotHistoryModal({scenarioId, shotId, isOpen, onClose, onRestored}: Props) {
  const {t} = useTranslation()
  const {showToast} = useToast()
  const [entries, setEntries] = useState<ScenarioHistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setLoading(true)
    contentScenariosApi
      .shotHistory(scenarioId, shotId, 50)
      .then((data) => {
        if (!cancelled) setEntries(data)
      })
      .catch((e) => {
        if (!cancelled) showToast(e instanceof Error ? e.message : 'Load history failed', 'error')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, scenarioId, shotId])

  async function handleRestore(auditId: number) {
    setRestoring(auditId)
    try {
      await contentScenariosApi.restoreFromAudit(scenarioId, auditId)
      showToast(t('content.aiScenario.historyRestoreSuccess'), 'success')
      onRestored()
      onClose()
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Restore failed', 'error')
    } finally {
      setRestoring(null)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <History className="size-4" />
            {t('content.aiScenario.shotHistoryTitle', {shot_id: shotId})}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-4 py-3">
          {loading && (
            <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 size-3 animate-spin" /> {t('common.loading')}
            </div>
          )}
          {!loading && entries.length === 0 && (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {t('content.aiScenario.shotHistoryEmpty')}
            </div>
          )}
          {!loading && entries.length > 0 && (
            <ul className="space-y-2">
              {entries.map((e) => (
                <HistoryEntryCard
                  key={e.audit_id}
                  entry={e}
                  expanded={expandedId === e.audit_id}
                  onToggle={() =>
                    setExpandedId((prev) => (prev === e.audit_id ? null : e.audit_id))
                  }
                  onRestore={handleRestore}
                  restoring={restoring === e.audit_id}
                  restoringOther={restoring !== null && restoring !== e.audit_id}
                  t={t}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end border-t border-border px-4 py-2.5">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Per-entry card với diff inline ──────────────────────────────────────────

function HistoryEntryCard({
  entry,
  expanded,
  onToggle,
  onRestore,
  restoring,
  restoringOther,
  t,
}: {
  entry: ScenarioHistoryEntry
  expanded: boolean
  onToggle: () => void
  onRestore: (id: number) => void
  restoring: boolean
  restoringOther: boolean
  t: (k: string, opts?: Record<string, unknown>) => string
}) {
  const time = new Date(entry.created_at).toLocaleString()
  // Tập các field đã đổi (key của fields_changed). Nếu rỗng, fallback hiển thị
  // tất cả keys của previous_value.
  const changedKeys = Object.keys(entry.fields_changed || {}).filter((k) => {
    const v = entry.fields_changed?.[k]
    return v !== undefined && v !== null && String(v).trim() !== ''
  })
  const keysToShow = changedKeys.length > 0
    ? changedKeys
    : Object.keys(entry.previous_value || {}).slice(0, 3)

  return (
    <li className="rounded border border-border bg-card overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left hover:bg-muted/30 transition"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
            <Clock className="size-2.5" />
            {time}
            <span className="ml-1 rounded bg-indigo-500/10 px-1.5 py-0.5 text-[9px] text-indigo-700 dark:text-indigo-300">
              {entry.action}
            </span>
            {entry.shot_id !== null && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[9px]">
                Shot {entry.shot_id}
              </span>
            )}
          </div>
          {/* Compact diff preview — show changed keys names */}
          <div className="mt-1 text-xs">
            {keysToShow.length === 0 ? (
              <span className="italic text-muted-foreground">
                {entry.previous_value_summary || '(không có dữ liệu)'}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {t('content.aiScenario.historyChangedFields', {
                  defaultValue: 'Đổi: {{fields}}',
                  fields: keysToShow.join(', '),
                })}
              </span>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation()
            onRestore(entry.audit_id)
          }}
          disabled={restoring || restoringOther}
          className="h-7 shrink-0 px-2 text-[10px]"
        >
          {restoring ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <>
              <RotateCcw className="mr-1 size-3" />
              {t('content.aiScenario.historyRestoreCta')}
            </>
          )}
        </Button>
      </button>

      {/* ── Expanded — full diff per-field ────────────────────────────── */}
      {expanded && keysToShow.length > 0 && (
        <div className="border-t border-border bg-muted/20 px-3 py-2 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            {t('content.aiScenario.historyDiffLabel', { defaultValue: 'Diff (restore = revert về cột TRƯỚC)' })}
          </div>
          {keysToShow.map((k) => {
            const before = String(entry.previous_value?.[k] ?? '(trống)').trim() || '(trống)'
            const after = String(entry.fields_changed?.[k] ?? '').trim()
            const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '...' : s)
            return (
              <div key={k} className="text-[11px] leading-relaxed">
                <span className="inline-block min-w-[100px] font-semibold uppercase text-[10px] text-muted-foreground">
                  {k}:
                </span>
                <span className="text-red-600/80 line-through dark:text-red-400/80">
                  {truncate(before, 80)}
                </span>
                {after && (
                  <>
                    {' '}<span className="text-muted-foreground">→</span>{' '}
                    <span className="text-emerald-700 dark:text-emerald-300">{truncate(after, 80)}</span>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </li>
  )
}
