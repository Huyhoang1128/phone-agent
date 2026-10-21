/**
 * v3.2.1 — Render 4 loại output mới của AI Director Mode trong chat bubble:
 *
 *   1. structured_actions  → 1 card / action (insert/delete/reorder/optimize)
 *                            DANGEROUS có nút Approve / Reject gọi resolveApproval API.
 *   2. proposed_options    → numbered list, click 1 option → pre-fill chat input.
 *   3. clarification       → 1 bubble dạng hỏi.
 *
 * v3.2.2 Phase 2 — thêm:
 *   - 4 verb card mới (add_character, move_shot, duplicate_shot, batch_update_shots)
 *   - PlanCard cho plan_proposed (multi-step plan + execute)
 *   - data_impact_class quyết định approval modal (Safe/Destructive/Expensive)
 *     thay vì requires_approval boolean.
 *
 * Tách thành component riêng để ContentScenarioDetailPage không phình.
 */
import {AlertTriangle, BarChart3, CheckCircle2, ChevronRight, Clock, Copy, HelpCircle, Lightbulb, Loader2, MoveRight, Plus, RefreshCcw, Sparkles, Trash2, UserPlus, X, Zap} from 'lucide-react'
import {useState} from 'react'
import {useQueryClient} from '@tanstack/react-query'
import {useTranslation} from 'react-i18next'

import {Button} from '@/components/ui/button'
import {useToast} from '@/context/ToastContext'
import {contentScenariosApi} from '@/lib/api'
import type {DataImpactClass, ProposedOptionsPayload, ScenarioPatch, StructuredAction, StructuredActionCrossShotAnalysis, StructuredActionPlanProposed, StructuredActionDiagnosis} from '@/lib/types'
import {VisualStoryboardDiff} from './VisualStoryboardDiff'

interface Props {
  scenarioId: number
  attachedPatches?: ScenarioPatch[]
  structuredActions?: StructuredAction[]
  proposedOptions?: ProposedOptionsPayload | null
  clarificationQuestion?: string | null
  /** Khi user click "Chọn hướng N" → callback giúp pre-fill chat input. */
  onPickOption?: (label: string) => void
  /** Khi user approve 1 dangerous action → callback gọi endpoint execute tương ứng. */
  onExecuteApproved?: (action: StructuredAction) => Promise<void> | void
  /** Khi user click execute insert_shot (không dangerous) → callback. */
  onExecuteInsert?: (action: Extract<StructuredAction, {kind: 'insert_shot'}>) => Promise<void> | void
  onApplyPatch?: (patch: ScenarioPatch) => Promise<boolean>
  messageId?: number
  resolvedActions?: Record<string, { status: 'applied' | 'rejected'; at: string }>
  chatSending?: boolean
}

export function ScenarioChatProposalCards({
  scenarioId,
  attachedPatches = [],
  structuredActions = [],
  proposedOptions,
  clarificationQuestion,
  onPickOption,
  onExecuteApproved,
  onExecuteInsert,
  onApplyPatch,
  messageId,
  resolvedActions,
  chatSending,
}: Props) {
  const {t} = useTranslation()
  const isLocked = !messageId || messageId < 0 || !!chatSending

  const patches = attachedPatches
  const groupedActions = structuredActions.filter(
    (act) => act.kind !== 'plan_proposed' && act.kind !== 'cross_shot_analysis' && act.kind !== 'diagnosis'
  )
  const planActions = structuredActions.filter((act) => act.kind === 'plan_proposed')
  const analysisActions = structuredActions.filter((act) => act.kind === 'cross_shot_analysis')
  const diagnosisActions = structuredActions.filter((act) => act.kind === 'diagnosis')

  const hasContent =
    patches.length > 0 ||
    structuredActions.length > 0 ||
    (proposedOptions && proposedOptions.options.length > 0) ||
    !!clarificationQuestion

  if (!hasContent) return null

  return (
    <div className="mt-2 space-y-2">
      {clarificationQuestion && (
        <ClarificationCard question={clarificationQuestion} t={t} />
      )}
      {proposedOptions && proposedOptions.options.length > 0 && (
        <ProposedOptionsCard
          payload={proposedOptions}
          onPickOption={onPickOption}
          t={t}
          isLocked={isLocked}
        />
      )}
      {(patches.length > 0 || groupedActions.length > 0) && (
        <ProposalGroupCard
          scenarioId={scenarioId}
          patches={patches}
          actions={groupedActions}
          onExecuteApproved={onExecuteApproved}
          onExecuteInsert={onExecuteInsert}
          onApplyPatch={onApplyPatch}
          t={t}
          messageId={messageId}
          resolvedActions={resolvedActions}
          structuredActions={structuredActions}
          isLocked={isLocked}
        />
      )}
      {planActions.map((act, i) => (
        <PlanCard
          key={`plan-${i}`}
          scenarioId={scenarioId}
          action={act as StructuredActionPlanProposed}
          t={t}
          messageId={messageId}
          actionIndex={structuredActions.indexOf(act)}
          resolvedActions={resolvedActions}
          isLocked={isLocked}
        />
      ))}
      {analysisActions.map((act, i) => (
        <AnalysisCard key={`analysis-${i}`} action={act as any} t={t} />
      ))}
      {diagnosisActions.map((act, i) => (
        <DiagnosisCard key={`diagnosis-${i}`} action={act as any} />
      ))}
    </div>
  )
}

// ─── 1. Clarification card ──────────────────────────────────────────────────

function ClarificationCard({question, t}: {question: string; t: any}) {
  return (
    <div className="rounded border border-amber-300/50 bg-amber-50/60 px-2.5 py-2 dark:border-amber-700/40 dark:bg-amber-900/15">
      <div className="flex items-start gap-1.5">
        <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300">
            {t('content.aiScenario.clarificationLabel')}
          </div>
          <div className="mt-0.5 whitespace-pre-wrap text-xs">{question}</div>
        </div>
      </div>
    </div>
  )
}

// ─── 2. Proposed options card ───────────────────────────────────────────────

function ProposedOptionsCard({
  payload,
  onPickOption,
  t,
  isLocked,
}: {
  payload: ProposedOptionsPayload
  onPickOption?: (label: string) => void
  t: any
  isLocked?: boolean
}) {
  return (
    <div className="rounded border border-violet-300/50 bg-violet-50/60 px-2.5 py-2 dark:border-violet-700/40 dark:bg-violet-900/15">
      <div className="flex items-start gap-1.5">
        <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-semibold uppercase text-violet-700 dark:text-violet-300">
            {t('content.aiScenario.proposedOptionsLabel')}
          </div>
          {payload.preamble && (
            <div className="mt-0.5 text-xs italic text-muted-foreground">{payload.preamble}</div>
          )}
          <ol className="mt-1.5 space-y-1">
            {payload.options.map((opt, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="mt-0.5 text-[10px] font-semibold text-violet-600 dark:text-violet-400">
                  {i + 1}.
                </span>
                <div className="flex-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => onPickOption?.(opt.label)}
                    disabled={isLocked}
                    className="text-left text-xs font-medium hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
                  >
                    {opt.label}
                  </button>
                  {opt.description && (
                    <div className="text-[11px] text-muted-foreground">{opt.description}</div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  )
}

// ─── 3. Structured action card (insert/delete/reorder/optimize) ──────────────

function StructuredActionCard({
  scenarioId,
  action,
  onExecuteApproved,
  onExecuteInsert,
  t,
  resolving: propResolving,
  resolved: propResolved,
  onResolveChange,
  isLocked,
}: {
  scenarioId: number
  action: StructuredAction
  onExecuteApproved?: (action: StructuredAction) => Promise<void> | void
  onExecuteInsert?: (action: Extract<StructuredAction, {kind: 'insert_shot'}>) => Promise<void> | void
  t: any
  resolving?: 'approve' | 'reject' | null
  resolved?: 'approved' | 'rejected' | null
  onResolveChange?: (resolving: 'approve' | 'reject' | null, resolved: 'approved' | 'rejected' | null) => void
  isLocked?: boolean
}) {
  const {showToast} = useToast()
  const [localResolving, setLocalResolving] = useState<'approve' | 'reject' | null>(null)
  const [localResolved, setLocalResolved] = useState<'approved' | 'rejected' | null>(null)

  const resolving = propResolving !== undefined ? propResolving : localResolving
  const resolved = propResolved !== undefined ? propResolved : localResolved

  const setResolving = (val: 'approve' | 'reject' | null) => {
    if (onResolveChange) onResolveChange(val, resolved)
    else setLocalResolving(val)
  }
  const setResolved = (val: 'approved' | 'rejected' | null) => {
    if (onResolveChange) onResolveChange(resolving, val)
    else setLocalResolved(val)
  }

  async function handleResolve(choice: 'approve' | 'reject') {
    if (!action.requires_approval || !('approval_id' in action) || !action.approval_id) {
      // v3.2.2 Phase 0+2 fix bug #1: execute trực tiếp cho SAFE non-approval action
      // (insert_shot, add_character, move_shot, duplicate_shot, batch_update_shots).
      // Đánh dấu resolved để card UI cập nhật.
      if (choice === 'approve') {
        const EXECUTE_KINDS = [
          'insert_shot', 'delete_shot', 'reorder_shots', 'optimize_whole_scenario',
          'delete_character', 'add_character', 'move_shot', 'duplicate_shot', 'batch_update_shots'
        ]
        if (EXECUTE_KINDS.includes(action.kind) && onExecuteApproved) {
          setResolving('approve')
          try {
            // insert_shot có handler riêng để backward compat
            if (action.kind === 'insert_shot' && onExecuteInsert) {
              await onExecuteInsert(action)
            } else {
              await onExecuteApproved(action)
            }
            setResolved('approved')
          } catch (err) {
            console.error('Execute failed:', err)
          } finally {
            setResolving(null)
          }
        }
      } else if (choice === 'reject') {
        setResolved('rejected')
      }
      return
    }
    setResolving(choice)
    try {
      await contentScenariosApi.resolveApproval(scenarioId, action.approval_id, choice)
      setResolved(choice === 'approve' ? 'approved' : 'rejected')
      if (choice === 'approve' && onExecuteApproved) {
        // Approval recorded → execute thực tế
        await onExecuteApproved(action)
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Resolve failed', 'error')
    } finally {
      setResolving(null)
    }
  }

  // v3.2.2 Phase 2 — impact-based UI thay vì kind-based "dangerous"
  // BE inject data_impact_class. Fallback theo kind nếu thiếu (backward compat).
  const impact: DataImpactClass = (action as any).data_impact_class
    || (action.kind === 'insert_shot' || action.kind === 'add_character'
        || action.kind === 'move_shot' || action.kind === 'duplicate_shot'
        || action.kind === 'batch_update_shots' ? 'safe'
        : action.kind === 'optimize_whole_scenario' ? 'expensive'
        : 'destructive')
  const isSafe = impact === 'safe'
  const isExpensive = impact === 'expensive'
  // "destructive" hoặc "expensive" → cần confirm
  const needsConfirm = !isSafe

  const Icon = (() => {
    switch (action.kind) {
      case 'insert_shot': return Plus
      case 'delete_shot': case 'delete_character': return Trash2
      case 'reorder_shots': case 'move_shot': return MoveRight
      case 'optimize_whole_scenario': return RefreshCcw
      case 'add_character': return UserPlus
      case 'duplicate_shot': return Copy
      case 'batch_update_shots': return Zap
      default: return AlertTriangle
    }
  })()

  const accentColor = isExpensive
    ? 'border-amber-300/50 bg-amber-50/60 dark:border-amber-700/40 dark:bg-amber-900/15'
    : needsConfirm
    ? 'border-red-300/50 bg-red-50/60 dark:border-red-700/40 dark:bg-red-900/15'
    : 'border-sky-300/50 bg-sky-50/60 dark:border-sky-700/40 dark:bg-sky-900/15'
  const iconColor = isExpensive
    ? 'text-amber-600 dark:text-amber-400'
    : needsConfirm
    ? 'text-red-600 dark:text-red-400'
    : 'text-sky-600 dark:text-sky-400'

  const label = (() => {
    switch (action.kind) {
      case 'insert_shot':
        return t('content.aiScenario.actionInsertShot', {after: action.after_shot_id})
      case 'delete_shot':
        return t('content.aiScenario.actionDeleteShot', {shot_id: action.shot_id})
      case 'reorder_shots':
        return t('content.aiScenario.actionReorderShots', {order: action.new_order.join('→')})
      case 'optimize_whole_scenario':
        return t('content.aiScenario.actionOptimizeWhole')
      // v3.2.2 Phase 0 — fix bug #2
      case 'delete_character':
        return t('content.aiScenario.actionDeleteCharacter', {
          name: action.character_name,
          defaultValue: `Xoá nhân vật "${action.character_name}"`,
        })
      // v3.2.2 Phase 2 — 4 verb mới
      case 'add_character':
        return t('content.aiScenario.actionAddCharacter', {
          name: action.name, defaultValue: `Thêm nhân vật "${action.name}"`,
        })
      case 'move_shot':
        return t('content.aiScenario.actionMoveShot', {
          shot_id: action.shot_id, position: action.new_position,
          defaultValue: `Di chuyển Shot ${action.shot_id} → vị trí ${action.new_position}`,
        })
      case 'duplicate_shot':
        return t('content.aiScenario.actionDuplicateShot', {
          shot_id: action.shot_id, defaultValue: `Sao chép Shot ${action.shot_id}`,
        })
      case 'batch_update_shots':
        return t('content.aiScenario.actionBatchUpdate', {
          n: action.updates.length,
          defaultValue: `Update batch ${action.updates.length} shot`,
        })
      default:
        return (action as any).kind || 'Action'
    }
  })()

  const detail = (() => {
    if (action.kind === 'insert_shot') return action.brief
    if (action.kind === 'optimize_whole_scenario') return action.variant_brief || ''
    if (action.kind === 'delete_character') {
      return action.replace_in_shots_with
        ? t('content.aiScenario.deleteCharacterReplace', {
            replacement: action.replace_in_shots_with,
            defaultValue: `Các shot đang dùng sẽ chuyển sang character "${action.replace_in_shots_with}".`,
          })
        : t('content.aiScenario.deleteCharacterNoReplace', {
            defaultValue: 'Các shot đang dùng sẽ mất character_in_frame (set "None"). Có thể bổ sung sau.',
          })
    }
    if (action.kind === 'add_character') {
      return `${action.age} · ${action.outfit_style}${action.ethnicity ? ' · ' + action.ethnicity : ''}`
    }
    if (action.kind === 'batch_update_shots') {
      return action.updates
        .map((u) => `Shot ${u.shot_id}: ${Object.keys(u.fields).join(', ')}`)
        .join(' | ')
    }
    return ''
  })()

  return (
    <div className={`rounded border px-2.5 py-2 ${accentColor}`}>
      <div className="flex items-start gap-1.5">
        <Icon className={`mt-0.5 size-3.5 shrink-0 ${iconColor}`} />
        <div className="flex-1 min-w-0">
          <div className={`text-[10px] font-semibold uppercase ${iconColor}`}>
            {isExpensive
              ? t('content.aiScenario.expensiveActionLabel', {defaultValue: 'Thao tác tốn cost — confirm'})
              : needsConfirm
              ? t('content.aiScenario.dangerousActionLabel')
              : t('content.aiScenario.proposedActionLabel')}
          </div>
          <div className="mt-0.5 text-xs font-medium">{label}</div>
          {detail && <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>}

          {resolved && (
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <CheckCircle2 className="size-3" />
              {resolved === 'approved'
                ? t('content.aiScenario.approvalApproved')
                : t('content.aiScenario.approvalRejected')}
            </div>
          )}

          {!resolved && (
            <div className="mt-1.5 flex gap-1.5">
              <Button
                size="sm"
                onClick={() => handleResolve('approve')}
                disabled={!!resolving || isLocked}
                className="h-6 px-2 text-[10px]"
              >
                {resolving === 'approve' ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <>
                    {needsConfirm ? <CheckCircle2 className="size-3" /> : <ChevronRight className="size-3" />}
                    {needsConfirm ? t('content.aiScenario.approve') : t('content.aiScenario.execute')}
                  </>
                )}
              </Button>
              {needsConfirm && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleResolve('reject')}
                  disabled={!!resolving || isLocked}
                  className="h-6 px-2 text-[10px] text-muted-foreground hover:text-red-600"
                >
                  {resolving === 'reject' ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <>
                      <X className="size-3" />
                      {t('content.aiScenario.reject')}
                    </>
                  )}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Icons re-export cho IconHint nếu cần ───────────────────────────────────
export const ActionKindIcon = {
  insert_shot: Plus,
  delete_shot: Trash2,
  reorder_shots: MoveRight,
  optimize_whole_scenario: RefreshCcw,
  add_character: UserPlus,
  delete_character: Trash2,
  move_shot: MoveRight,
  duplicate_shot: Copy,
  batch_update_shots: Zap,
  plan_proposed: Clock,
} as const

// ─── v3.2.2 Phase 3 — Cross-shot Analysis card (5 dimension scoring) ─────────

const DIMENSION_LABELS: Record<string, string> = {
  cinematic: 'Cinematic',
  kinetic: 'Kinetic',
  continuity: 'Continuity',
  brand: 'Brand voice',
  style: 'Style',
}

function scoreColor(score: number): string {
  if (score >= 4.0) return 'bg-emerald-500'
  if (score >= 3.0) return 'bg-amber-500'
  return 'bg-red-500'
}

function scoreLabel(score: number): string {
  if (score >= 4.5) return 'Xuất sắc'
  if (score >= 4.0) return 'Tốt'
  if (score >= 3.0) return 'Ổn'
  if (score >= 2.0) return 'Yếu'
  return 'Cần sửa'
}

function AnalysisCard({
  action,
  t,
}: {
  action: StructuredActionCrossShotAnalysis
  t: any
}) {
  if (action.error) {
    return (
      <div className="rounded border border-red-300/50 bg-red-50/60 px-3 py-2 dark:border-red-700/40 dark:bg-red-900/15">
        <div className="flex items-center gap-1.5 text-[11px] text-red-700 dark:text-red-300">
          <AlertTriangle className="size-3.5" />
          {t('content.aiScenario.scanError', {defaultValue: 'Scan thất bại'})}: {action.error}
        </div>
      </div>
    )
  }
  const scores = action.scores || {}
  const dimensions = ['cinematic', 'kinetic', 'continuity', 'brand', 'style'] as const

  return (
    <div className="rounded border border-violet-300/50 bg-violet-50/60 px-3 py-2.5 dark:border-violet-700/40 dark:bg-violet-900/15">
      <div className="flex items-start gap-2">
        <BarChart3 className="mt-0.5 size-4 shrink-0 text-violet-600 dark:text-violet-400" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-semibold uppercase text-violet-700 dark:text-violet-300">
            {t('content.aiScenario.analysisLabel', {defaultValue: 'PHÂN TÍCH KỊCH BẢN'})}
          </div>

          {/* 5 score bars */}
          <div className="mt-2 space-y-1">
            {dimensions.map((d) => {
              const v = Number(scores[d] || 0)
              const pct = Math.max(0, Math.min(100, (v / 5) * 100))
              return (
                <div key={d} className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 shrink-0 font-medium">{DIMENSION_LABELS[d]}</span>
                  <div className="flex-1 h-2 rounded-full bg-background/60 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${scoreColor(v)} transition-all`}
                      style={{width: `${pct}%`}}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right font-mono">{v.toFixed(1)}</span>
                  <span className="w-14 shrink-0 text-right text-muted-foreground italic">
                    {scoreLabel(v)}
                  </span>
                </div>
              )
            })}
          </div>

          {action.strengths && action.strengths.length > 0 && (
            <div className="mt-2 text-[11px]">
              <div className="font-semibold text-emerald-700 dark:text-emerald-300">✓ Điểm mạnh:</div>
              <ul className="ml-3 list-disc text-muted-foreground">
                {action.strengths.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}

          {action.weaknesses && action.weaknesses.length > 0 && (
            <div className="mt-1.5 text-[11px]">
              <div className="font-semibold text-amber-700 dark:text-amber-300">⚠ Cần cải thiện:</div>
              <ul className="ml-3 list-disc text-muted-foreground">
                {action.weaknesses.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}

          {action.recommendations && action.recommendations.length > 0 && (
            <div className="mt-1.5 text-[11px]">
              <div className="font-semibold text-violet-700 dark:text-violet-300">💡 Đề xuất:</div>
              <ul className="ml-3 list-disc text-muted-foreground">
                {action.recommendations.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── v3.2.2 Phase 2 — Plan & Execute card ────────────────────────────────────

function PlanCard({
  scenarioId,
  action,
  t,
  messageId,
  actionIndex,
  resolvedActions,
  isLocked,
}: {
  scenarioId: number
  action: StructuredActionPlanProposed
  t: any
  messageId?: number
  actionIndex?: number
  resolvedActions?: Record<string, { status: 'applied' | 'rejected'; at: string }>
  isLocked?: boolean
}) {
  const {showToast} = useToast()
  const qc = useQueryClient()
  const [executing, setExecuting] = useState(false)
  const [executed, setExecuted] = useState(() => {
    if (actionIndex !== undefined && resolvedActions) {
      const res = resolvedActions[`action-${actionIndex}`]
      return res?.status === 'applied'
    }
    return false
  })
  const [steps, setSteps] = useState(action.steps)
  const [completedCount, setCompletedCount] = useState(0)
  const [failedCount, setFailedCount] = useState(0)
  const [cancelled, setCancelled] = useState(() => {
    if (actionIndex !== undefined && resolvedActions) {
      const res = resolvedActions[`action-${actionIndex}`]
      return res?.status === 'rejected'
    }
    return false
  })

  const impact = action.data_impact_class || 'safe'
  const isExpensive = impact === 'expensive'
  const isDestructive = impact === 'destructive'
  const accent = isExpensive
    ? 'border-amber-300/50 bg-amber-50/60 dark:border-amber-700/40 dark:bg-amber-900/15'
    : isDestructive
    ? 'border-red-300/50 bg-red-50/60 dark:border-red-700/40 dark:bg-red-900/15'
    : 'border-indigo-300/50 bg-indigo-50/60 dark:border-indigo-700/40 dark:bg-indigo-900/15'

  async function handleExecute(stepIndices?: number[]) {
    if (!action.plan_id) {
      showToast(t('content.aiScenario.planNoIdAvail', {
        defaultValue: 'Plan ID missing — chỉ khả dụng cho saved scenario.',
      }), 'info')
      return
    }

    const targetIndices = stepIndices !== undefined
      ? stepIndices
      : steps.map((s, idx) => s.status !== 'done' ? idx : -1).filter(idx => idx !== -1)

    if (targetIndices.length === 0) return

    setSteps(prev => prev.map((s, idx) => targetIndices.includes(idx) ? { ...s, status: 'running' } : s))
    setExecuting(true)
    try {
      const res = await contentScenariosApi.executePlan(scenarioId, action.plan_id, targetIndices)
      setSteps(res.steps as any)
      setCompletedCount(res.completed_steps)
      setFailedCount(res.failed_steps)

      const allDone = res.steps.every((s: any) => s.status === 'done')
      if (allDone) {
        setExecuted(true)
      }

      const finished = res.steps.every((s: any) => s.status === 'done' || s.status === 'failed' || s.status === 'skipped')
      if (finished && messageId && actionIndex !== undefined) {
        await contentScenariosApi.resolveProposal(
          scenarioId,
          messageId,
          `action-${actionIndex}`,
          res.failed_steps === 0 ? 'applied' : 'rejected'
        ).catch(console.error)
        if (res.failed_steps === 0) {
          setExecuted(true)
        }
      }

      // Invalidate scenario query cache to reload editor elements
      await qc.invalidateQueries({ queryKey: ['scenario', scenarioId] })

      if (res.failed_steps === 0) {
        showToast(t('content.aiScenario.planCompletedOk', {
          defaultValue: `Plan đã chạy xong: ${res.completed_steps} bước OK`,
        }), 'success')
      } else {
        showToast(t('content.aiScenario.planCompletedPartial', {
          defaultValue: `Plan xong: ${res.completed_steps} OK, ${res.failed_steps} fail`,
        }), 'info')
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Execute plan failed', 'error')
      setSteps(action.steps)
    } finally {
      setExecuting(false)
    }
  }

  async function handleCancel() {
    if (!action.plan_id) {
      setCancelled(true)
      if (messageId && actionIndex !== undefined) {
        await contentScenariosApi.resolveProposal(scenarioId, messageId, `action-${actionIndex}`, 'rejected').catch(console.error)
      }
      return
    }
    try {
      await contentScenariosApi.cancelPlan(scenarioId, action.plan_id)
      setCancelled(true)
      if (messageId && actionIndex !== undefined) {
        await contentScenariosApi.resolveProposal(scenarioId, messageId, `action-${actionIndex}`, 'rejected').catch(console.error)
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Cancel plan failed', 'error')
    }
  }

  return (
    <div className={`rounded border px-3 py-2.5 ${accent}`}>
      <div className="flex items-start gap-2">
        <Clock className="mt-0.5 size-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-semibold uppercase text-indigo-700 dark:text-indigo-300">
            {t('content.aiScenario.planProposedLabel', {defaultValue: 'AI ĐỀ XUẤT KẾ HOẠCH'})}
          </div>
          <div className="mt-0.5 text-sm font-medium">{action.goal}</div>
          {action.analysis && (
            <div className="mt-1 rounded bg-background/40 px-2 py-1 text-[11px] text-muted-foreground italic">
              📊 {action.analysis}
            </div>
          )}

          <ol className="mt-2 space-y-1.5">
            {steps.map((s, i) => {
              const statusIcon = s.status === 'done' ? <CheckCircle2 className="size-3 text-emerald-500" />
                : s.status === 'failed' ? <X className="size-3 text-red-500" />
                : s.status === 'running' ? <Loader2 className="size-3 animate-spin text-indigo-500" />
                : s.status === 'skipped' ? <Clock className="size-3 text-muted-foreground/60" />
                : <Clock className="size-3 text-muted-foreground" />
              return (
                <li key={i} className="flex items-center justify-between gap-1.5 text-[11px] py-0.5 group/step">
                  <div className="flex items-start gap-1.5 flex-1 min-w-0">
                    <span className="shrink-0 font-mono text-muted-foreground">{i + 1}.</span>
                    <span className="mt-0.5 shrink-0">{statusIcon}</span>
                    <span className="flex-1 min-w-0">
                      <span className="font-medium break-words">{s.description}</span>
                      <span className="ml-1 text-muted-foreground text-[10px]">
                        ({s.tool_name})
                      </span>
                      {s.tool_args_preview && (
                        <div className="mt-0.5 block text-[10px] text-muted-foreground bg-background/25 rounded px-1.5 py-0.5 border border-border/20">
                          {(s.tool_args_preview as any).shot_ids && (s.tool_args_preview as any).shot_ids.length > 0 && (
                            <span className="mr-3 inline-block">🎬 Cảnh: {(s.tool_args_preview as any).shot_ids.join(', ')}</span>
                          )}
                          {(s.tool_args_preview as any).brief && (
                            <span className="inline-block">📝 Yêu cầu: {(s.tool_args_preview as any).brief}</span>
                          )}
                        </div>
                      )}
                      {s.error && (
                        <div className="mt-0.5 text-red-600 dark:text-red-400">⚠ {s.error}</div>
                      )}
                    </span>
                  </div>
                  {s.status !== 'done' && !executed && !cancelled && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleExecute([i])}
                      disabled={executing || isLocked}
                      className="h-5 px-1.5 text-[9px] font-medium shrink-0 ml-2 bg-background/50 hover:bg-indigo-600 hover:text-white transition-all shadow-sm flex items-center gap-1 opacity-70 group-hover/step:opacity-100 focus:opacity-100 disabled:opacity-50"
                    >
                      {s.status === 'running' ? (
                        <Loader2 className="size-2.5 animate-spin" />
                      ) : (
                        <>
                          <ChevronRight className="size-2.5" />
                          Thực hiện
                        </>
                      )}
                    </Button>
                  )}
                </li>
              )
            })}
          </ol>

          {executed && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              ✅ {completedCount} bước OK
              {failedCount > 0 ? ` · ❌ ${failedCount} fail` : ''}
            </div>
          )}
          {cancelled && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              ⏸ {t('content.aiScenario.planCancelled', {defaultValue: 'Đã hủy plan'})}
            </div>
          )}

          {!executed && !cancelled && (
            <div className="mt-2 flex gap-1.5">
              <Button
                size="sm"
                onClick={() => handleExecute()}
                disabled={executing || !action.plan_id || isLocked}
                className="h-6 px-2 text-[10px]"
              >
                {executing ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <>
                    <CheckCircle2 className="size-3 mr-1" />
                    {t('content.aiScenario.executeAllPlan', {defaultValue: 'Phê duyệt tất cả'})}
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancel}
                disabled={executing || isLocked}
                className="h-6 px-2 text-[10px] text-muted-foreground hover:text-red-600"
              >
                <X className="size-3" />
                {t('content.aiScenario.cancelPlan', {defaultValue: 'Hủy'})}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── 5. Proposal Group Card (attached patches + structured actions) ──────────
interface ProposalGroupCardProps {
  scenarioId: number
  patches: ScenarioPatch[]
  actions: StructuredAction[]
  onExecuteApproved?: (action: StructuredAction) => Promise<void> | void
  onExecuteInsert?: (action: Extract<StructuredAction, {kind: 'insert_shot'}>) => Promise<void> | void
  onApplyPatch?: (patch: ScenarioPatch) => Promise<boolean>
  t: any
  messageId?: number
  resolvedActions?: Record<string, { status: 'applied' | 'rejected'; at: string }>
  structuredActions: StructuredAction[]
  isLocked?: boolean
}

export function ProposalGroupCard({
  scenarioId,
  patches,
  actions,
  onExecuteApproved,
  onExecuteInsert,
  onApplyPatch,
  t,
  messageId,
  resolvedActions,
  structuredActions,
  isLocked,
}: ProposalGroupCardProps) {
  const {showToast} = useToast()
  const [approvingAll, setApprovingAll] = useState(false)
  
  const [patchStates, setPatchStates] = useState<Record<number, 'idle' | 'applying' | 'applied' | 'error' | 'discarded'>>(() => {
    const initial: Record<number, 'idle' | 'applying' | 'applied' | 'error' | 'discarded'> = {}
    patches.forEach((_, i) => {
      const key = `patch-${i}`
      const res = resolvedActions?.[key]
      if (res?.status === 'applied') {
        initial[i] = 'applied'
      } else if (res?.status === 'rejected') {
        initial[i] = 'discarded'
      }
    })
    return initial
  })

  const [actionResolving, setActionResolving] = useState<Record<number, 'approve' | 'reject' | null>>({})
  const [actionResolved, setActionResolved] = useState<Record<number, 'approved' | 'rejected' | null>>(() => {
    const initial: Record<number, 'approved' | 'rejected' | null> = {}
    actions.forEach((act, i) => {
      const actionIdx = structuredActions.indexOf(act)
      const key = `action-${actionIdx}`
      const res = resolvedActions?.[key]
      if (res?.status === 'applied') {
        initial[i] = 'approved'
      } else if (res?.status === 'rejected') {
        initial[i] = 'rejected'
      }
    })
    return initial
  })

  const totalChanges = patches.length + actions.length

  const allResolved =
    patches.every((_, i) => {
      const s = patchStates[i] || 'idle'
      return s === 'applied' || s === 'discarded'
    }) &&
    actions.every((_, i) => {
      const r = actionResolved[i] || null
      return r === 'approved' || r === 'rejected'
    })

  async function handleApproveAll() {
    if (approvingAll) return
    setApprovingAll(true)

    try {
      // 1. Loop through patches sequentially
      for (let i = 0; i < patches.length; i++) {
        const currentState = patchStates[i] || 'idle'
        if (currentState === 'applied' || currentState === 'discarded') {
          continue
        }

        setPatchStates((prev) => ({ ...prev, [i]: 'applying' }))
        try {
          if (onApplyPatch) {
            const ok = await onApplyPatch(patches[i])
            if (ok) {
              setPatchStates((prev) => ({ ...prev, [i]: 'applied' }))
              if (messageId) {
                await contentScenariosApi.resolveProposal(scenarioId, messageId, `patch-${i}`, 'applied').catch(console.error)
              }
            } else {
              setPatchStates((prev) => ({ ...prev, [i]: 'error' }))
              throw new Error(t('content.aiScenario.patchApplyFailed', { defaultValue: 'Áp dụng thay đổi phân cảnh thất bại.' }))
            }
          } else {
            setPatchStates((prev) => ({ ...prev, [i]: 'error' }))
            throw new Error('No onApplyPatch handler provided')
          }
        } catch (err) {
          setPatchStates((prev) => ({ ...prev, [i]: 'error' }))
          throw err
        }
      }

      // 2. Loop through actions sequentially
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i]
        const resolved = actionResolved[i] || null
        if (resolved === 'approved' || resolved === 'rejected') {
          continue
        }

        const actionIdx = structuredActions.indexOf(action)
        setActionResolving((prev) => ({ ...prev, [i]: 'approve' }))
        try {
          if (!action.requires_approval || !('approval_id' in action) || !action.approval_id) {
            // execute direct
            const EXECUTE_KINDS = [
              'insert_shot', 'delete_shot', 'reorder_shots', 'optimize_whole_scenario',
              'delete_character', 'add_character', 'move_shot', 'duplicate_shot', 'batch_update_shots'
            ]
            if (EXECUTE_KINDS.includes(action.kind)) {
              if (action.kind === 'insert_shot' && onExecuteInsert) {
                await onExecuteInsert(action)
              } else if (onExecuteApproved) {
                await onExecuteApproved(action)
              }
            }
          } else {
            await contentScenariosApi.resolveApproval(scenarioId, action.approval_id, 'approve')
            if (onExecuteApproved) {
              await onExecuteApproved(action)
            }
          }
          if (messageId && actionIdx !== -1) {
            await contentScenariosApi.resolveProposal(scenarioId, messageId, `action-${actionIdx}`, 'applied').catch(console.error)
          }
          setActionResolved((prev) => ({ ...prev, [i]: 'approved' }))
        } catch (err) {
          setActionResolving((prev) => ({ ...prev, [i]: null }))
          throw err
        } finally {
          setActionResolving((prev) => ({ ...prev, [i]: null }))
        }
      }

      showToast(t('content.aiScenario.approveAllSuccess', { defaultValue: 'Đã duyệt toàn bộ thay đổi thành công' }), 'success')
    } catch (err) {
      console.error('Approve all error:', err)
      showToast(err instanceof Error ? err.message : 'Duyệt tất cả thất bại', 'error')
    } finally {
      setApprovingAll(false)
    }
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/25 p-3 dark:border-indigo-900/40 dark:bg-indigo-950/10 shadow-sm">
      {/* Group Header */}
      <div className="flex items-center justify-between mb-2 pb-2 border-b border-indigo-100 dark:border-indigo-950/40">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-indigo-600 dark:text-indigo-400 animate-pulse" />
          <span className="text-[11px] font-semibold text-indigo-950 dark:text-indigo-200">
            {t('content.aiScenario.proposalGroupTitle', {
              n: totalChanges,
              defaultValue: `Đề xuất cập nhật — ${totalChanges} thay đổi`
            })}
          </span>
        </div>

        {!allResolved && (
          <Button
            size="sm"
            onClick={handleApproveAll}
            disabled={approvingAll || isLocked}
            className="h-6.5 px-2.5 text-[10px] bg-indigo-600 hover:bg-indigo-700 text-white font-medium shadow-sm transition-all"
          >
            {approvingAll ? (
              <>
                <Loader2 className="size-3 animate-spin mr-1" />
                {t('content.aiScenario.approvingAll', { defaultValue: 'Đang duyệt...' })}
              </>
            ) : (
              <>
                <CheckCircle2 className="size-3 mr-1" />
                {t('content.aiScenario.approveAll', { defaultValue: 'Duyệt tất cả' })}
              </>
            )}
          </Button>
        )}
      </div>

      {/* Scrollable Container with max height constraint */}
      <div className="max-h-[350px] overflow-y-auto space-y-2 pr-1 custom-scrollbar">
        {patches.map((p, i) => (
          <VisualStoryboardDiff
            key={`group-patch-${i}`}
            patch={p}
            onApply={async (patch) => {
              const ok = await onApplyPatch!(patch)
              if (ok && messageId) {
                await contentScenariosApi.resolveProposal(scenarioId, messageId, `patch-${i}`, 'applied').catch(console.error)
              }
              return ok
            }}
            state={patchStates[i] || 'idle'}
            onStateChange={(s) => {
              setPatchStates((prev) => ({ ...prev, [i]: s }))
              if (s === 'discarded' && messageId) {
                contentScenariosApi.resolveProposal(scenarioId, messageId, `patch-${i}`, 'rejected').catch(console.error)
              }
            }}
            disabled={isLocked}
          />
        ))}

        {actions.map((act, i) => {
          const actionIdx = structuredActions.indexOf(act)
          return (
            <StructuredActionCard
              key={`group-action-${i}`}
              scenarioId={scenarioId}
              action={act}
              onExecuteApproved={onExecuteApproved}
              onExecuteInsert={onExecuteInsert}
              t={t}
              resolving={actionResolving[i] || null}
              resolved={actionResolved[i] || null}
              isLocked={isLocked}
              onResolveChange={async (resolving, resolved) => {
                setActionResolving((prev) => ({ ...prev, [i]: resolving }))
                setActionResolved((prev) => ({ ...prev, [i]: resolved }))
                if (resolved && messageId && actionIdx !== -1) {
                  await contentScenariosApi.resolveProposal(
                    scenarioId,
                    messageId,
                    `action-${actionIdx}`,
                    resolved === 'approved' ? 'applied' : 'rejected'
                  ).catch(console.error)
                }
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

// ─── 7. Diagnosis Card ────────────────────────────────────────────────────────

function DiagnosisCard({
  action,
}: {
  action: StructuredActionDiagnosis
}) {
  const isGood = action.score >= 4.0
  const isAverage = action.score >= 3.0
  const scoreColorClass = isGood ? 'text-emerald-600 dark:text-emerald-400' : isAverage ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'
  
  return (
    <div className="rounded border border-indigo-200/60 bg-indigo-50/20 px-3.5 py-3 dark:border-indigo-900/30 dark:bg-indigo-950/10 backdrop-blur-md transition hover:border-indigo-300/80">
      <div className="flex items-start gap-2.5">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-indigo-500 animate-pulse" />
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
              Chẩn đoán: {action.reviewer}
            </span>
            <span className={`text-xs font-mono font-bold ${scoreColorClass}`}>
              {action.score.toFixed(1)} / 5.0
            </span>
          </div>

          <div className="mt-1 text-[11px] text-muted-foreground">
            <span className="font-medium">Phân cảnh đã quét:</span>{' '}
            {action.shots_examined && action.shots_examined.length > 0 ? (
              action.shots_examined.map((id) => (
                <span key={id} className="inline-block bg-indigo-100/50 dark:bg-indigo-900/30 px-1 py-0.5 rounded text-[10px] font-mono mr-1">
                  Cảnh {id}
                </span>
              ))
            ) : (
              'Toàn bộ'
            )}
          </div>

          {action.findings && action.findings.length > 0 ? (
            <div className="mt-3 space-y-2.5">
              {action.findings.map((finding, idx) => {
                const isTransition = finding.target_kind === 'transition'
                const targetLabel = finding.target
                  ? finding.target.toLowerCase().startsWith('shot ')
                    ? isTransition
                      ? `Chuyển cảnh ${finding.target.substring(5)}`
                      : `Cảnh ${finding.target.substring(5)}`
                    : finding.target
                  : isTransition
                  ? 'Chuyển cảnh'
                  : 'Cảnh'

                return (
                  <div
                    key={idx}
                    className="rounded-lg border border-indigo-100/50 bg-white/40 p-2.5 dark:border-indigo-950/40 dark:bg-indigo-950/20 shadow-sm transition hover:bg-white/60 dark:hover:bg-indigo-950/30"
                  >
                    <div className="flex items-center mb-1.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium font-mono border ${
                        isTransition
                          ? 'bg-purple-100/60 text-purple-700 border-purple-200/50 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-900/30'
                          : 'bg-indigo-100/60 text-indigo-700 border-indigo-200/50 dark:bg-indigo-950/30 dark:text-indigo-300 dark:border-indigo-900/30'
                      }`}>
                        {targetLabel}
                      </span>
                    </div>

                    <div className="space-y-1.5 text-[11px] leading-relaxed">
                      {finding.problem && (
                        <div className="flex items-start gap-1.5">
                          <AlertTriangle className="size-3.5 mt-0.5 shrink-0 text-red-500 dark:text-red-400" />
                          <span className="text-muted-foreground">
                            <span className="font-semibold text-red-600 dark:text-red-400">Vấn đề:</span> {finding.problem}
                          </span>
                        </div>
                      )}
                      {finding.suggestion && (
                        <div className="flex items-start gap-1.5 border-t border-indigo-100/20 dark:border-indigo-900/10 pt-1.5 mt-1.5">
                          <Lightbulb className="size-3.5 mt-0.5 shrink-0 text-indigo-500 dark:text-indigo-400" />
                          <span className="text-muted-foreground">
                            <span className="font-semibold text-indigo-600 dark:text-indigo-400">Hướng xử lý:</span> {finding.suggestion}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <>
              {action.issues && action.issues.length > 0 && (
                <div className="mt-2.5 text-[11px]">
                  <div className="font-semibold text-red-600 dark:text-red-400 flex items-center gap-1">
                    <span>⚠️ Cảnh báo phát hiện:</span>
                  </div>
                  <ul className="ml-3 mt-1 list-disc space-y-1 text-muted-foreground leading-relaxed">
                    {action.issues.map((issue, idx) => (
                      <li key={idx} className="whitespace-pre-wrap">{issue}</li>
                    ))}
                  </ul>
                </div>
              )}

              {action.fixes && action.fixes.length > 0 && (
                <div className="mt-2.5 border-t border-indigo-100/40 dark:border-indigo-900/20 pt-2.5 text-[11px]">
                  <div className="font-semibold text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
                    <Lightbulb className="size-3.5 text-indigo-500" />
                    <span>💡 Hướng xử lý đề xuất:</span>
                  </div>
                  <ul className="ml-3 mt-1 list-disc space-y-1 text-muted-foreground leading-relaxed">
                    {action.fixes.map((fix, idx) => (
                      <li key={idx} className="whitespace-pre-wrap">{fix}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

