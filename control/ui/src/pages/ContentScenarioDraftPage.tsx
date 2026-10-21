/**
 * AI Scenario v3 — Draft preview page (`/content-scenarios/draft`).
 *
 * v3.2.1 UX-F refactor: dùng CÙNG component pattern với DetailPage
 * (ScenarioTimeline + ScenarioShotCard + ScenarioChatPanel + ScenarioPropertiesPanel
 * + collapsible 3 panels). Khác biệt với DetailPage:
 *   - Scenario CHƯA SAVE → không có history/restore/delete shot
 *   - Chat dùng `previewScriptChat` stateless (sessionStorage chat history)
 *   - State changes local-only đến khi user click "Lưu" → POST /save/ → navigate /:id
 *   - Header: chỉ Copy JSON + Lưu (no Optimize/Variant/Export)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import i18next from 'i18next'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Copy, Loader2, Save, Sparkles,
  Eye, EyeOff,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { copyTextToClipboard } from '@/lib/clipboard'
import { ScenarioChatPanel } from '@/components/scenario/ScenarioChatPanel'
import { ScenarioPropertiesPanel } from '@/components/scenario/ScenarioPropertiesPanel'
import { ScenarioShotCard } from '@/components/scenario/ScenarioShotCard'
import { ScenarioTimeline } from '@/components/scenario/ScenarioTimeline'
import { ScenarioViewport } from '@/components/scenario/ScenarioViewport'
import { useToast } from '@/context/ToastContext'
import { contentScenariosApi } from '@/lib/api'
import { typography } from '@/lib/scenario-tokens'
import type {
  ContentScenarioItem,
  ProposedOptionsPayload,
  ScenarioCharacter,
  ScenarioChatMessage,
  ScenarioChatTurnResponse,
  ScenarioIntent,
  ScenarioJSON,
  ScenarioPatch,
  ScenarioShot,
  StructuredAction,
} from '@/lib/types'

const STORAGE_KEY = 'aiScenarioDraft.v1'

interface DraftState {
  scenario: ScenarioJSON
  intent_json?: ScenarioIntent
  source_file_name?: string
  warning?: string | null
}

interface ChatTurn {
  sender: 'USER' | 'ASSISTANT'
  body: string
  target_shots?: number[]
  target_character?: string
  attached_patches?: ScenarioPatch[]
}

interface ChatTransient {
  structured_actions: StructuredAction[]
  proposed_options: ProposedOptionsPayload | null
  clarification_question: string | null
}

// ─── localStorage helpers cho panel collapse state ──────────────────────────

const LS_KEYS = {
  chatCollapsed: 'scenario.draft.panel.chat.collapsed',
  propsCollapsed: 'scenario.draft.panel.properties.collapsed',
} as const

function loadPanelState(key: string): boolean {
  if (typeof window === 'undefined') return false
  try { return window.localStorage.getItem(key) === '1' } catch { return false }
}
function savePanelState(key: string, collapsed: boolean) {
  try { window.localStorage.setItem(key, collapsed ? '1' : '0') } catch { /* noop */ }
}

// ─── Session storage helpers cho draft data ─────────────────────────────────

function loadFromStorage(): DraftState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as DraftState
  } catch { return null }
}

function saveToStorage(s: DraftState) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* quota — bỏ qua */ }
}

function clearStorage() {
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* */ }
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function ContentScenarioDraftPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { showToast } = useToast()

  // ── Hydrate: state từ navigate, fallback sessionStorage ────────────────
  const initial = useMemo<DraftState | null>(() => {
    const fromState = (location.state as DraftState | null)
    if (fromState?.scenario) return fromState
    return loadFromStorage()
  }, [location.state])

  const [draft, setDraft] = useState<DraftState | null>(initial)
  const [chatHistory, setChatHistory] = useState<ChatTurn[]>([])
  const [chatTransients, setChatTransients] = useState<Record<number, ChatTransient>>({})
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [targetShots, setTargetShots] = useState<number[]>([])
  const [targetCharacter, setTargetCharacter] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [activeShotId, setActiveShotId] = useState<number | null>(null)

  const [chatWidth, setChatWidth] = useState(320)
  const [propsWidth, setPropsWidth] = useState(280)
  const [viewportVisible, setViewportVisible] = useState(true)

  const handleMouseDown = (e: React.MouseEvent, direction: 'left' | 'right') => {
    e.preventDefault()
    const startX = e.clientX
    const startChatWidth = chatWidth
    const startPropsWidth = propsWidth

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX
      if (direction === 'left') {
        const newWidth = Math.max(200, Math.min(600, startChatWidth + deltaX))
        setChatWidth(newWidth)
      } else {
        const newWidth = Math.max(200, Math.min(600, startPropsWidth - deltaX))
        setPropsWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  // UX-7 — Collapsible panels (state persist localStorage riêng cho draft)
  const [chatCollapsed, setChatCollapsed] = useState(() => loadPanelState(LS_KEYS.chatCollapsed))
  const [propsCollapsed, setPropsCollapsed] = useState(() => loadPanelState(LS_KEYS.propsCollapsed))
  useEffect(() => savePanelState(LS_KEYS.chatCollapsed, chatCollapsed), [chatCollapsed])
  useEffect(() => savePanelState(LS_KEYS.propsCollapsed, propsCollapsed), [propsCollapsed])

  // Persist draft to sessionStorage
  useEffect(() => {
    if (draft) saveToStorage(draft)
  }, [draft])

  // ── Empty state guard ─────────────────────────────────────────────────
  if (!draft) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <p className="text-sm text-muted-foreground">
          {t('content.aiScenario.draftEmpty', { defaultValue: 'Chưa có draft. Quay lại Nội dung để tạo.' })}
        </p>
        <Button onClick={() => navigate('/content?tab=scenario')}>
          {t('common.back', { defaultValue: 'Về Nội dung' })}
        </Button>
      </div>
    )
  }

  const { scenario } = draft
  const shots = scenario.shots || []
  const characters = scenario.global_character_registry || []

  // ── Handlers ──────────────────────────────────────────────────────────
  function updateShot(shot_id: number, patch: Partial<ScenarioShot>) {
    setDraft({
      ...draft!,
      scenario: {
        ...scenario,
        shots: scenario.shots.map((s) => (s.shot_id === shot_id ? { ...s, ...patch } : s)),
      },
    })
  }

  function updateCharacter(name: string, patch: Partial<ScenarioCharacter>) {
    setDraft({
      ...draft!,
      scenario: {
        ...scenario,
        global_character_registry: scenario.global_character_registry.map((c) =>
          c.name === name ? { ...c, ...patch } : c,
        ),
      },
    })
  }

  async function applyPatch(p: ScenarioPatch): Promise<boolean> {
    try {
      if (p.kind === 'shot') {
        updateShot(p.shot_id, p.after as Partial<ScenarioShot>)
      } else {
        updateCharacter(p.character_name, p.after)
      }
      showToast(t('content.aiScenario.saveSuccess'), 'success')
      return true
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Apply patch failed', 'error')
      return false
    }
  }

  async function sendChat() {
    const body = chatInput.trim()
    if (!body) return
    setChatSending(true)
    const userTurn: ChatTurn = {
      sender: 'USER', body,
      target_shots: targetShots, target_character: targetCharacter,
    }
    setChatHistory((h) => [...h, userTurn])
    setChatInput('')
    try {
      const resp: ScenarioChatTurnResponse = await contentScenariosApi.previewScriptChat({
        scenario,
        history: chatHistory.map((h) => ({
          sender: h.sender, body: h.body,
          target_shots: h.target_shots, target_character: h.target_character,
        })),
        body,
        target_shots: targetShots, target_character: targetCharacter,
      })
      const newIdx = chatHistory.length + 1  // index của assistant turn sắp push
      setChatHistory((h) => [...h, {
        sender: 'ASSISTANT', body: resp.assistant, attached_patches: resp.patches,
      }])
      // Store transient (structured_actions / options / clarification) theo index
      if (resp.structured_actions || resp.proposed_options || resp.clarification_question) {
        setChatTransients((prev) => ({
          ...prev,
          [newIdx]: {
            structured_actions: resp.structured_actions || [],
            proposed_options: resp.proposed_options || null,
            clarification_question: resp.clarification_question || null,
          },
        }))
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Chat failed', 'error')
    } finally {
      setChatSending(false)
    }
  }

  function handlePickOption(label: string) {
    setChatInput(`Đi theo hướng: ${label}`)
  }

  async function handleSave() {
    if (!draft) return
    setIsSaving(true)
    try {
      const saved = await contentScenariosApi.save({
        scenario,
        source_file_name: draft.source_file_name,
        intent_json: draft.intent_json,
      })
      clearStorage()
      showToast(t('content.aiScenario.saveSuccess'), 'success')
      navigate(`/content-scenarios/${saved.id}`)
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('content.aiScenario.saveError'), 'error')
    } finally {
      setIsSaving(false)
    }
  }

  async function copyJson() {
    // v3.2.2 fix: override shot_count_target = actual shots.length (chống mismatch
    // sau khi user edit shots trong draft). Đồng nhất với DetailPage.copyJson.
    const shots = scenario.shots || []
    const json = {
      ...scenario,
      shot_count: shots.length,
      shot_count_target: undefined,  // bỏ field cũ (informational, không cần expose)
    }
    delete (json as any).shot_count_target
    const ok = await copyTextToClipboard(JSON.stringify(json, null, 2))
    if (ok) {
      showToast(t('content.aiScenario.copyJsonSuccess'), 'success')
    } else {
      showToast('Copy failed', 'error')
    }
  }

  // ── Adapters cho shared components (DraftPage vs DetailPage có schema khác) ──
  const messagesAdapter: ScenarioChatMessage[] = chatHistory.map((turn, i) => ({
    id: i,
    sender: turn.sender,
    body: turn.body,
    target_shots: turn.target_shots || [],
    target_character: turn.target_character || '',
    attached_patches: turn.attached_patches || [],
    llm_model: '',
    created_at: new Date().toISOString(),
  } as unknown as ScenarioChatMessage))

  // Adapter ScenarioJSON → ContentScenarioItem partial cho PropertiesPanel
  const scenarioItemAdapter: ContentScenarioItem = {
    id: 0,
    title: scenario.title,
    brief: '',
    duration_target_seconds: scenario.duration_target_seconds,
    shot_count_target: scenario.shot_count_target,
    genre: scenario.genre,
    character_registry: characters,
    mode: 'ai_video',
    source_file_name: draft.source_file_name || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as ContentScenarioItem

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col -mx-4 -my-4 sm:-mx-6 sm:-my-6">
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* Top toolbar — breadcrumb + meta + Copy JSON + Lưu */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <header className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-2.5">
        {/* Left — Breadcrumb + title + meta */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            onClick={() => navigate('/content?tab=scenario')}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition"
            aria-label={t('common.back', { defaultValue: 'Quay lại' })}
          >
            <ChevronLeft className="size-4" />
          </button>
          <div className="min-w-0">
            <h1 className={`${typography.pageTitle} truncate`}>
              {scenario.title || t('content.aiScenario.draftTitle', { defaultValue: 'Bản nháp kịch bản' })}
              <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                {t('content.aiScenario.draftBadge', { defaultValue: 'NHÁP' })}
              </span>
            </h1>
            <p className="text-[11px] text-muted-foreground">
              {scenario.genre} · {scenario.duration_target_seconds}s · {shots.length} shots ·{' '}
              {t('content.aiScenario.draftUnsavedHint', { defaultValue: 'Chưa lưu vào kho' })}
            </p>
          </div>
        </div>

        {/* Right — Primary actions */}
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={copyJson}>
            <Copy className="mr-1 size-3.5" />
            {t('content.aiScenario.copyJson')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving}
            className="bg-indigo-600 hover:bg-indigo-700 text-white">
            {isSaving
              ? <><Loader2 className="mr-1 size-3.5 animate-spin" />{t('content.aiScenario.saving')}</>
              : <><Save className="mr-1 size-3.5" />{t('content.aiScenario.save')}</>}
          </Button>
        </div>
      </header>

      {/* Warning banner */}
      {draft.warning && (
        <div className="border-b border-amber-300/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-200">
          ⚠️ {draft.warning}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* UX-7 — Resizable Panels Workspace (Phase 1) */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative select-none">
        {/* ─── LEFT: Chat panel (stateless previewScriptChat) ────────────── */}
        <div 
          className="relative flex min-h-0 flex-col overflow-hidden border-r border-border bg-background shrink-0"
          style={{ width: chatCollapsed ? '40px' : `${chatWidth}px` }}
        >
          {chatCollapsed ? (
            <CollapsedPanelBar
              icon={<Sparkles className="size-4" />}
              label={t('content.aiScenario.chatPanelTitle')}
              onExpand={() => setChatCollapsed(false)}
              side="left"
            />
          ) : (
            <>
              <button
                onClick={() => setChatCollapsed(true)}
                className="absolute top-2 right-2 z-20 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('content.aiScenario.collapse', { defaultValue: 'Thu gọn' })}
              >
                <ChevronsLeft className="size-3.5" />
              </button>
              <ScenarioChatPanel
                scenarioId={0}  // draft chưa save — placeholder, không dùng cho approval
                messages={messagesAdapter}
                transients={chatTransients}
                chatInput={chatInput}
                setChatInput={setChatInput}
                chatSending={chatSending}
                onSend={sendChat}
                targetShots={targetShots}
                targetCharacter={targetCharacter}
                onClearShot={(s) => setTargetShots((arr) => arr.filter((x) => x !== s))}
                onClearCharacter={() => setTargetCharacter('')}
                onApplyPatch={applyPatch}
                onPickOption={handlePickOption}
                onExecuteApproved={() => {
                  showToast(
                    t('content.aiScenario.draftNoApprovalAvail', {
                      defaultValue: 'Action nâng cao chỉ khả dụng sau khi lưu. Lưu kịch bản trước nhé.',
                    }),
                    'info',
                  )
                }}
                onExecuteInsert={() => {
                  showToast(
                    t('content.aiScenario.draftNoInsertAvail', {
                      defaultValue: 'Insert shot chỉ khả dụng sau khi lưu.',
                    }),
                    'info',
                  )
                }}
              />
            </>
          )}
        </div>

        {/* Left Drag Resizer Handle */}
        {!chatCollapsed && (
          <div
            className="w-1 cursor-col-resize bg-border hover:bg-indigo-500/50 active:bg-indigo-600 transition-colors shrink-0 z-10"
            onMouseDown={(e) => handleMouseDown(e, 'left')}
          />
        )}

        {/* ─── CENTER: Shots List (UX-4 compact cards) ────────────────────── */}
        <div className="flex-1 flex min-h-0 flex-col bg-background overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/20 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className={typography.sectionTitle}>{t('content.aiScenario.shotPanelTitle')}</span>
              <button
                onClick={() => setViewportVisible(v => !v)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                title={viewportVisible ? 'Ẩn màn hình Storyboard' : 'Hiện màn hình Storyboard'}
              >
                {viewportVisible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
            <span className="text-[11px] text-muted-foreground italic">
              {t('content.aiScenario.draftEditHint', {
                defaultValue: 'Sửa trực tiếp vào field — lưu rồi mới persist DB',
              })}
            </span>
          </div>

          {viewportVisible && shots.length > 0 && (
            <ScenarioViewport shot={shots.find(s => s.shot_id === activeShotId) || shots[0]} />
          )}

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 custom-scrollbar">
            {shots.length === 0 && (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {t('content.aiScenario.shotsEmpty', { defaultValue: 'Chưa có shot nào.' })}
                </p>
              </div>
            )}
            {shots.map((shot) => (
              <ScenarioShotCard
                key={shot.shot_id}
                shot={shot}
                isActive={activeShotId === shot.shot_id}
                onAskAi={() => { setTargetShots([shot.shot_id]); setActiveShotId(shot.shot_id) }}
                onSelect={() => setActiveShotId(shot.shot_id)}
                // DraftPage chưa save — KHÔNG có restore/history/delete
              />
            ))}
          </div>
        </div>

        {/* Right Drag Resizer Handle */}
        {!propsCollapsed && (
          <div
            className="w-1 cursor-col-resize bg-border hover:bg-indigo-500/50 active:bg-indigo-600 transition-colors shrink-0 z-10"
            onMouseDown={(e) => handleMouseDown(e, 'right')}
          />
        )}

        {/* ─── RIGHT: Properties panel (UX-6 & Inspector Tab) ────────────────── */}
        <div 
          className="relative flex min-h-0 flex-col overflow-hidden border-l border-border bg-background shrink-0"
          style={{ width: propsCollapsed ? '40px' : `${propsWidth}px` }}
        >
          {propsCollapsed ? (
            <CollapsedPanelBar
              icon={<Sparkles className="size-4" />}
              label={t('content.aiScenario.propertiesPanelTitle', { defaultValue: 'Thuộc tính' })}
              onExpand={() => setPropsCollapsed(false)}
              side="right"
            />
          ) : (
            <>
              <button
                onClick={() => setPropsCollapsed(true)}
                className="absolute top-2 left-2 z-20 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('content.aiScenario.collapse', { defaultValue: 'Thu gọn' })}
              >
                <ChevronsRight className="size-3.5" />
              </button>
              <ScenarioPropertiesPanel
                scenario={scenarioItemAdapter}
                onAskAiCharacter={(name) => setTargetCharacter(name)}
                activeShotId={activeShotId}
                onUpdateShot={updateShot}
                onAskAiShot={(shotId) => { setTargetShots([shotId]); setActiveShotId(shotId) }}
              />
            </>
          )}
        </div>
      </div>

      {/* ─── BOTTOM: Timeline Track Panel (Phase 2) ───────────────────────── */}
      <div className="shrink-0 border-t border-border bg-card">
        <ScenarioTimeline shots={shots} activeShotId={activeShotId} onJump={setActiveShotId} />
      </div>
    </div>
  )
}

// ─── CollapsedPanelBar (duplicate từ DetailPage — small, OK) ──────────────────

function CollapsedPanelBar({
  icon, label, onExpand, side,
}: {
  icon: React.ReactNode
  label: string
  onExpand: () => void
  side: 'left' | 'right'
}) {
  const Icon = side === 'left' ? ChevronRight : ChevronLeft
  const aria = i18next.t('content.aiScenario.expandPanel', {
    defaultValue: 'Mở rộng {{label}}',
    label,
  })
  return (
    <button
      onClick={onExpand}
      className="flex h-full w-full flex-col items-center justify-start gap-2 py-3 hover:bg-muted/30 transition"
      aria-label={aria}
    >
      <Icon className="size-4 text-muted-foreground" />
      <div className="rounded bg-muted p-1.5 text-muted-foreground">{icon}</div>
      <span
        className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
      >
        {label}
      </span>
    </button>
  )
}

// Suppress unused import warning — useRef is reserved for future AbortController
void useRef
