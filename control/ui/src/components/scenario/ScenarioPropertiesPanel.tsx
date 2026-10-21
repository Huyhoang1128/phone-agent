/**
 * v3.2.2 — ScenarioPropertiesPanel với cơ chế Tabs & Contextual Inspector.
 * 
 * - Tab 1: Dự án & Nhân vật (Character Registry + Global Metadata)
 * - Tab 2: Biên tập Shot (Form editor 8 trường chi tiết + các action Hỏi AI, Restore, History, Delete)
 */
import {
  ChevronDown, ChevronRight, MessageSquare, User as UserIcon,
  Settings, Edit3, RotateCcw, History, Trash2, Loader2, AlertTriangle
} from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { colors, typography, funnelPillClass, continuityChipClass } from '@/lib/scenario-tokens'
import type { ContentScenarioItem, ScenarioCharacter, ContinuityMode } from '@/lib/types'

interface Props {
  scenario: ContentScenarioItem
  onAskAiCharacter: (name: string) => void
  activeShotId: number | null
  onUpdateShot: (shotId: number, fields: Record<string, unknown>) => void
  onAskAiShot?: (shotId: number) => void
  onRestoreShot?: (shotId: number) => void
  onOpenShotHistory?: (shotId: number) => void
  onDeleteShot?: (shotId: number) => void
  isDeletingShot?: boolean
}

export function ScenarioPropertiesPanel({
  scenario,
  onAskAiCharacter,
  activeShotId,
  onUpdateShot,
  onAskAiShot,
  onRestoreShot,
  onOpenShotHistory,
  onDeleteShot,
  isDeletingShot,
}: Props) {
  const { t } = useTranslation()
  const characters = scenario.character_registry || []
  const shots = scenario.shots || []

  const [activeTab, setActiveTab] = useState<'global' | 'inspector'>('global')

  // Tự động chuyển tab sang inspector khi click chọn 1 shot bất kỳ
  useEffect(() => {
    if (activeShotId !== null) {
      setActiveTab('inspector')
    }
  }, [activeShotId])

  const activeShot = shots.find((s) => s.shot_id === activeShotId)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* ── Tabs Header ────────────────────────────────────────────────── */}
      <div className="flex shrink-0 border-b border-border bg-muted/20">
        <button
          onClick={() => setActiveTab('global')}
          className={[
            'flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-semibold border-b-2 transition',
            activeTab === 'global'
              ? 'border-indigo-600 text-indigo-600 bg-background/55'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/10',
          ].join(' ')}
        >
          <Settings className="size-3.5" />
          {t('content.aiScenario.propertiesGlobalTab', { defaultValue: 'Dự án' })}
        </button>
        <button
          onClick={() => setActiveTab('inspector')}
          className={[
            'flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-semibold border-b-2 transition',
            activeTab === 'inspector'
              ? 'border-indigo-600 text-indigo-600 bg-background/55'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/10',
          ].join(' ')}
        >
          <Edit3 className="size-3.5" />
          {t('content.aiScenario.propertiesInspectorTab', { defaultValue: 'Biên tập Shot' })}
        </button>
      </div>

      {/* ── Tab Contents ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
        {activeTab === 'global' ? (
          <div className="space-y-4 py-2">
            {/* Characters section */}
            <Section title={t('content.aiScenario.registryPanelTitle')}>
              {characters.length === 0 && (
                <p className={typography.helperText}>
                  {t('content.aiScenario.charactersEmpty', { defaultValue: 'Chưa có nhân vật.' })}
                </p>
              )}
              <div className="space-y-2">
                {characters.map((c) => (
                  <CharacterCard
                    key={c.name}
                    character={c}
                    onAskAi={() => onAskAiCharacter(c.name)}
                    t={t}
                  />
                ))}
              </div>
            </Section>

            {/* Global properties section */}
            <Section title={t('content.aiScenario.propsGlobal', { defaultValue: 'Thuộc tính chung' })}>
              <PropertyRow label={t('content.aiScenario.propGenre', { defaultValue: 'Genre' })} value={scenario.genre} />
              <PropertyRow label={t('content.aiScenario.propDuration', { defaultValue: 'Duration' })} value={`${scenario.duration_target_seconds}s`} />
              <PropertyRow label={t('content.aiScenario.propShotCount', { defaultValue: 'Shot count' })} value={String(scenario.shot_count_target)} />
              <PropertyRow label={t('content.aiScenario.propMode', { defaultValue: 'Mode' })} value={scenario.mode} />
              {scenario.source_file_name && (
                <PropertyRow label={t('content.aiScenario.propSourceFile', { defaultValue: 'Source file' })} value={scenario.source_file_name} truncate />
              )}
            </Section>

            {/* Meta section */}
            <Section title={t('content.aiScenario.propsMeta', { defaultValue: 'Meta' })}>
              <PropertyRow
                label={t('content.aiScenario.propCreatedAt', { defaultValue: 'Tạo lúc' })}
                value={new Date(scenario.created_at).toLocaleString()}
              />
              <PropertyRow
                label={t('content.aiScenario.propUpdatedAt', { defaultValue: 'Cập nhật' })}
                value={new Date(scenario.updated_at).toLocaleString()}
              />
            </Section>
          </div>
        ) : (
          <div className="p-3 space-y-4">
            {!activeShot ? (
              <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                <Edit3 className="size-8 text-muted-foreground/30 mb-2" />
                <p className="text-xs">
                  {t('content.aiScenario.inspectorPlaceholder', {
                    defaultValue: 'Chọn một Shot từ danh sách hoặc timeline để bắt đầu biên tập.',
                  })}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Active Shot Header */}
                <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-border pb-3 bg-muted/10 -mx-3 px-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-bold text-foreground">
                      Shot {activeShot.shot_id}
                    </span>
                    {activeShot.funnel_part && (
                      <span className={[
                        'rounded px-1.5 py-0.5 text-[9px] font-medium border',
                        funnelPillClass(activeShot.funnel_part)
                      ].join(' ')}>
                        {activeShot.funnel_part}
                      </span>
                    )}
                    <span className={`rounded border px-1.5 py-0.5 text-[9px] ${continuityChipClass(activeShot.continuity_mode)}`}>
                      {continuityModeLabel(activeShot.continuity_mode, activeShot.anchor_source_id, t)}
                    </span>
                  </div>

                  {/* Actions toolbar */}
                  <div className="flex items-center gap-0.5">
                    {onAskAiShot && (
                      <button
                        onClick={() => onAskAiShot(activeShot.shot_id)}
                        className="rounded p-1 text-indigo-600 hover:bg-indigo-500/10"
                        title={t('content.aiScenario.askAi')}
                        aria-label="Hỏi AI"
                      >
                        <MessageSquare className="size-3.5" />
                      </button>
                    )}
                    {onRestoreShot && (
                      <button
                        onClick={() => onRestoreShot(activeShot.shot_id)}
                        className="rounded p-1 text-amber-600 hover:bg-amber-500/10"
                        title={t('content.aiScenario.restoreShot')}
                        aria-label="Khôi phục shot"
                      >
                        <RotateCcw className="size-3.5" />
                      </button>
                    )}
                    {onOpenShotHistory && (
                      <button
                        onClick={() => onOpenShotHistory(activeShot.shot_id)}
                        className="rounded p-1 text-sky-600 hover:bg-sky-500/10"
                        title={t('content.aiScenario.shotHistoryButton')}
                        aria-label="Lịch sử shot"
                      >
                        <History className="size-3.5" />
                      </button>
                    )}
                    {onDeleteShot && (
                      <button
                        onClick={() => onDeleteShot(activeShot.shot_id)}
                        disabled={isDeletingShot}
                        className="rounded p-1 text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                        title={t('content.aiScenario.deleteShot', { defaultValue: 'Xoá shot' })}
                        aria-label={t('content.aiScenario.deleteShot', { defaultValue: 'Xoá shot' })}
                      >
                        {isDeletingShot ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {/* Inline warnings */}
                {activeShot.warnings && activeShot.warnings.length > 0 && (
                  <div className="rounded bg-amber-500/10 border border-amber-500/30 p-2 text-[11px] text-amber-800 dark:text-amber-200 flex items-start gap-1">
                    <AlertTriangle className="size-3.5 shrink-0 mt-0.5 text-amber-600" />
                    <div>{activeShot.warnings.join(' · ')}</div>
                  </div>
                )}

                {/* Editors Fields */}
                <div className="space-y-3">
                  <FieldEditor
                    label={t('content.aiScenario.voiceLabel', { defaultValue: 'Voice Over' })}
                    value={activeShot.voice_over}
                    onSave={(v) => onUpdateShot(activeShot.shot_id, { voice_over: v })}
                    rows={4}
                    emphasize
                    counterMax={25}
                  />

                  <FieldEditor
                    label={t('content.aiScenario.kineticLabel', { defaultValue: 'Hành động' })}
                    value={activeShot.kinetic_action}
                    onSave={(v) => onUpdateShot(activeShot.shot_id, { kinetic_action: v })}
                    rows={3}
                    emphasize
                  />

                  <FieldSelector
                    label={t('content.aiScenario.characterInFrameLabel', { defaultValue: 'Nhân vật trong khung' })}
                    value={activeShot.character_in_frame || 'None'}
                    options={['None', ...characters.map((c) => c.name).filter(Boolean)]}
                    onSave={(v) => onUpdateShot(activeShot.shot_id, { character_in_frame: v })}
                  />

                  <FieldEditor
                    label={t('content.aiScenario.cameraLabel', { defaultValue: 'Góc máy' })}
                    value={activeShot.camera_articulation}
                    onSave={(v) => onUpdateShot(activeShot.shot_id, { camera_articulation: v })}
                  />

                  <FieldEditor
                    label={t('content.aiScenario.backgroundLabel', { defaultValue: 'Bối cảnh' })}
                    value={activeShot.background}
                    onSave={(v) => onUpdateShot(activeShot.shot_id, { background: v })}
                  />

                  <FieldEditor
                    label={t('content.aiScenario.poseLabel', { defaultValue: 'Tư thế' })}
                    value={activeShot.character_pose}
                    onSave={(v) => onUpdateShot(activeShot.shot_id, { character_pose: v })}
                  />

                  <FieldEditor
                    label={t('content.aiScenario.propLabel', { defaultValue: 'Đạo cụ' })}
                    value={activeShot.prop_description}
                    onSave={(v) => onUpdateShot(activeShot.shot_id, { prop_description: v })}
                  />

                  <FieldEditor
                    label={t('content.aiScenario.textureLabel', { defaultValue: 'Ánh sáng' })}
                    value={activeShot.texture_and_lighting}
                    onSave={(v) => onUpdateShot(activeShot.shot_id, { texture_and_lighting: v })}
                  />

                  <FieldEditor
                    label={t('content.aiScenario.musicLabel', { defaultValue: 'Nhạc nền' })}
                    value={activeShot.music_hint}
                    onSave={(v) => onUpdateShot(activeShot.shot_id, { music_hint: v })}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Section wrapper với title ───────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="border-b border-border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 hover:bg-muted/30 transition"
      >
        <span className={typography.fieldLabel}>{title}</span>
        {open ? (
          <ChevronDown className="size-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground" />
        )}
      </button>
      {open && <div className="px-3 pb-3 space-y-1.5">{children}</div>}
    </div>
  )
}

// ─── Character card ──────────────────────────────────────────────────────────

function CharacterCard({
  character,
  onAskAi,
  t,
}: {
  character: ScenarioCharacter
  onAskAi: () => void
  t: (k: string, opts?: Record<string, unknown>) => string
}) {
  const [expanded, setExpanded] = useState(false)
  const initials = (character.name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-2 hover:bg-muted/30 transition"
      >
        <div className={`flex size-8 items-center justify-center rounded-full font-semibold text-xs ${colors.primary.bgSoft} ${colors.primary.text}`}>
          {initials || <UserIcon className="size-3.5" />}
        </div>
        <div className="flex-1 min-w-0 text-left">
          <div className="text-xs font-semibold truncate">{character.name}</div>
          <div className="text-[10px] text-muted-foreground truncate">
            {[character.age, character.ethnicity].filter(Boolean).join(' · ')}
          </div>
        </div>
        {expanded ? (
          <ChevronDown className="size-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-2.5 py-2 space-y-1.5">
          {character.outfit_style && (
            <div>
              <div className={typography.fieldLabel}>{t('content.aiScenario.charOutfit', { defaultValue: 'Outfit' })}</div>
              <div className="text-xs leading-relaxed text-muted-foreground">
                {character.outfit_style}
              </div>
            </div>
          )}
          {character.voice_id_hint && (
            <div>
              <div className={typography.fieldLabel}>{t('content.aiScenario.charVoiceId', { defaultValue: 'Voice ID' })}</div>
              <div className="text-xs font-mono text-muted-foreground">
                {character.voice_id_hint}
              </div>
            </div>
          )}
          <button
            onClick={onAskAi}
            className={`mt-1 inline-flex items-center gap-1 text-[11px] ${colors.primary.text} hover:underline`}
          >
            <MessageSquare className="size-3" />
            {t('content.aiScenario.askAi')}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Property row ────────────────────────────────────────────────────────────

function PropertyRow({
  label,
  value,
  truncate,
}: {
  label: string
  value: string
  truncate?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className={typography.metaText}>{label}</span>
      <span
        className={`font-medium ${truncate ? 'truncate' : ''}`}
        title={truncate ? value : undefined}
      >
        {value || '—'}
      </span>
    </div>
  )
}

// ─── Inline field editor ─────────────────────────────────────────────────────

interface FieldProps {
  label: string
  value: string
  onSave: (v: string) => void
  rows?: number
  emphasize?: boolean
  counterMax?: number
}

function FieldEditor({ label, value, onSave, rows = 2, emphasize, counterMax }: FieldProps) {
  const { t } = useTranslation()
  const [local, setLocal] = useState(value || '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wordCount = local.trim().split(/\s+/).filter(Boolean).length
  const overLimit = counterMax !== undefined && wordCount > counterMax

  useEffect(() => {
    if (document.activeElement !== textareaRef.current && value !== local) {
      setLocal(value || '')
    }
  }, [value])

  return (
    <label className="block">
      <div className="flex items-center justify-between mb-0.5">
        <span className={typography.fieldLabel}>{label}</span>
        {counterMax !== undefined && (
          <span
            className={`text-[10px] ${overLimit ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-muted-foreground/60'
              }`}
          >
            {wordCount}/{counterMax} {t('content.aiScenario.wordUnit', { defaultValue: 'từ' })}
          </span>
        )}
      </div>
      <textarea
        ref={textareaRef}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local !== value) onSave(local)
        }}
        rows={rows}
        className={[
          'w-full resize-none rounded-md border bg-muted/45 px-3 py-2 leading-relaxed transition text-xs',
          'focus:bg-background focus:outline-none focus:ring-1 border-border/40',
          emphasize
            ? 'focus:border-indigo-500/50 focus:ring-indigo-500/30'
            : 'focus:border-indigo-400/50 focus:ring-indigo-500/20',
          overLimit ? 'border-amber-500/40' : '',
        ].join(' ')}
      />
    </label>
  )
}

// ─── Field Selector ──────────────────────────────────────────────────────────

interface SelectorProps {
  label: string
  value: string
  options: string[]
  onSave: (v: string) => void
}

function FieldSelector({ label, value, options, onSave }: SelectorProps) {
  const [local, setLocal] = useState(value || 'None')
  useEffect(() => {
    if (value !== local) setLocal(value || 'None')
  }, [value])

  return (
    <label className="block">
      <div className="flex items-center justify-between mb-0.5">
        <span className={typography.fieldLabel}>{label}</span>
      </div>
      <select
        value={local}
        onChange={(e) => {
          setLocal(e.target.value)
          onSave(e.target.value)
        }}
        className={[
          'w-full rounded-md border bg-muted/45 px-3 py-2 text-xs leading-relaxed transition border-border/40',
          'focus:bg-background focus:outline-none focus:ring-1',
          'focus:border-indigo-400/50 focus:ring-indigo-500/20',
        ].join(' ')}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </label>
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
