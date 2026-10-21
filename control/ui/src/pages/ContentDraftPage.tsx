/**
 * ContentDraftPage — full-page preview & refine for freshly-generated
 * scripts (BEFORE saving). Replaces the prior modal-inside-modal stack
 * (gen modal → "Xem chi tiết" PreviewKbRefineModal) that ran out of
 * viewport room and caused scroll/overflow bugs.
 *
 * Flow:
 *   1. ContentPage's small Gen Content modal hits n8n → scripts.
 *   2. ContentPage navigate('/content/draft', { state }) with the scripts.
 *   3. This page hosts the workspace: sidebar (KB list w/ checkboxes) +
 *      main (chat + frame editor for the selected KB).
 *   4. "Lưu N kịch bản" → POST /save-generated → navigate back to
 *      /content with toast.
 *
 * Reload safety: every state change is mirrored to sessionStorage under a
 * single key. On mount we restore from location.state first, then from
 * sessionStorage. Direct URL hit with no state → redirect home.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft, Bot, ChevronLeft, ChevronRight, Loader2, MessageSquare,
  RotateCcw, Send, Sparkles, User as UserIcon, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FrameTieredEditor } from '@/components/FrameTieredEditor'
import { MarkdownText } from '@/components/MarkdownText'
import { PatchSuggestionCard } from '@/components/PatchSuggestionCard'
import { contentsApi } from '@/lib/api'
import type {
  ContentMode, FramePatch, GeneratedScript, GeneratedScriptFrame,
} from '@/lib/types'

const STORAGE_KEY = 'contentDraft.v1'

interface ChatMsg {
  id: string
  sender: 'USER' | 'ASSISTANT'
  body: string
  frame_target: number | null
  attached_patches?: FramePatch[]
}

interface PersistedDraft {
  scripts: GeneratedScript[]
  parent_scenario_filename: string
  mode: ContentMode
  selectedKbIndexes: number[]
  activeKbIndex: number
  chatByKb: Record<number, ChatMsg[]>   // Map serialised as Record for JSON
  /** Per-KB snapshot of original frames so each KB's per-frame Reset works. */
  originByKb: Record<number, GeneratedScriptFrame[]>
}

interface LocationState {
  scripts: GeneratedScript[]
  parent_scenario_filename: string
  mode: ContentMode
}

function loadFromStorage(): PersistedDraft | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.scripts)) return null
    return parsed as PersistedDraft
  } catch { return null }
}

function saveToStorage(d: PersistedDraft) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(d)) } catch { /* quota */ }
}

function clearStorage() {
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* noop */ }
}


export default function ContentDraftPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()

  // ── Hydrate (location.state preferred, sessionStorage fallback) ──────
  const initial: PersistedDraft | null = useMemo(() => {
    const fromNav = (location.state || null) as LocationState | null
    if (fromNav?.scripts?.length) {
      // Fresh navigation — snapshot scripts so per-frame Reset works.
      const origin: Record<number, GeneratedScriptFrame[]> = {}
      fromNav.scripts.forEach((s, i) => {
        origin[i] = s.frames.map((f) => ({ ...f }))
      })
      return {
        scripts: fromNav.scripts,
        parent_scenario_filename: fromNav.parent_scenario_filename || '',
        mode: fromNav.mode || 'real_footage',
        selectedKbIndexes: fromNav.scripts.map((_, i) => i),  // pre-tick all
        activeKbIndex: 0,
        chatByKb: {},
        originByKb: origin,
      }
    }
    return loadFromStorage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // If neither nav state nor storage → kick back to list.
  useEffect(() => {
    if (!initial) {
      navigate('/content', { replace: true })
    }
  }, [initial, navigate])

  // ── State ────────────────────────────────────────────────────────────
  const [scripts, setScripts] = useState<GeneratedScript[]>(initial?.scripts || [])
  const [chatByKb, setChatByKb] = useState<Record<number, ChatMsg[]>>(initial?.chatByKb || {})
  const [selectedKbIndexes, setSelectedKbIndexes] = useState<Set<number>>(
    new Set(initial?.selectedKbIndexes || []),
  )
  const [activeKbIndex, setActiveKbIndex] = useState<number>(initial?.activeKbIndex || 0)
  const originByKbRef = useRef<Record<number, GeneratedScriptFrame[]>>(initial?.originByKb || {})

  const [parentFilename] = useState(initial?.parent_scenario_filename || '')
  const [mode] = useState<ContentMode>(initial?.mode || 'real_footage')

  // Chat composer state — per-KB chip + body
  const [chatBody, setChatBody] = useState('')
  const [chatChipFrame, setChatChipFrame] = useState<number | null>(null)
  const [chatOpen, setChatOpen] = useState(true)
  const [sending, setSending] = useState(false)
  const [chatError, setChatError] = useState('')
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const listEndRef = useRef<HTMLDivElement | null>(null)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const activeScript = scripts[activeKbIndex]
  const activeMessages: ChatMsg[] = chatByKb[activeKbIndex] || []

  // Mirror state to sessionStorage so reload doesn't lose the draft.
  useEffect(() => {
    if (!scripts.length) return
    saveToStorage({
      scripts,
      parent_scenario_filename: parentFilename,
      mode,
      selectedKbIndexes: Array.from(selectedKbIndexes),
      activeKbIndex,
      chatByKb,
      originByKb: originByKbRef.current,
    })
  }, [scripts, parentFilename, mode, selectedKbIndexes, activeKbIndex, chatByKb])

  // Reset composer when switching KB — chip is per-KB; messages independent.
  useEffect(() => {
    setChatChipFrame(null)
    setChatBody('')
    setChatError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKbIndex])

  // Auto-scroll chat to newest.
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [activeMessages.length, sending, activeKbIndex])

  // ── Save flow ────────────────────────────────────────────────────────
  async function handleSaveAll() {
    if (saving) return
    const chosen = scripts.filter((_, i) => selectedKbIndexes.has(i))
    if (chosen.length === 0) {
      setSaveError(t('content.draft.noneSelected'))
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      await contentsApi.saveGenerated(
        parentFilename,
        chosen,
        mode,
      )
      clearStorage()
      navigate('/content', { replace: true, state: { savedCount: chosen.length } })
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  function handleDiscard() {
    if (!window.confirm(t('content.draft.discardConfirm', { n: scripts.length }))) return
    clearStorage()
    navigate('/content', { replace: true })
  }

  // ── Chat send (stateless preview API) ────────────────────────────────
  const sendChat = useCallback(async () => {
    const trimmed = chatBody.trim()
    if (!trimmed || sending || !activeScript) return
    setChatError('')
    setSending(true)

    const userMsg: ChatMsg = {
      id: `u-${Date.now()}`,
      sender: 'USER',
      body: trimmed,
      frame_target: chatChipFrame,
    }
    const targetKb = activeKbIndex
    setChatByKb((prev) => ({
      ...prev,
      [targetKb]: [...(prev[targetKb] || []), userMsg],
    }))
    setChatBody('')
    setChatChipFrame(null)

    try {
      const prior = (chatByKb[targetKb] || []).map((m) => ({
        sender: m.sender,
        body: m.body,
        frame_target: m.frame_target,
      }))
      const resp = await contentsApi.previewChat({
        kb_name: activeScript.kb_name || '',
        od_number: activeScript.od_number || '',
        frames: activeScript.frames,
        mode,
        body: trimmed,
        frame_target: userMsg.frame_target,
        recent_messages: prior,
      })
      const assistantText = (resp.assistant || '').trim()
      const patches = Array.isArray(resp.patches) ? resp.patches : []
      if (assistantText || patches.length > 0) {
        setChatByKb((prev) => ({
          ...prev,
          [targetKb]: [
            ...(prev[targetKb] || []),
            {
              id: `a-${Date.now()}`,
              sender: 'ASSISTANT',
              body: assistantText,
              frame_target: userMsg.frame_target,
              attached_patches: patches,
            },
          ],
        }))
      }
    } catch (e) {
      setChatError(e instanceof Error ? e.message : t('content.chatRefine.sendFailed'))
    } finally {
      setSending(false)
    }
  }, [chatBody, sending, activeScript, chatChipFrame, activeKbIndex, chatByKb, mode, t])

  function handleComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendChat()
    }
  }

  function focusChatOnFrame(frameNumber: number) {
    setChatChipFrame(frameNumber)
    if (!chatOpen) setChatOpen(true)
    setTimeout(() => composerRef.current?.focus(), 50)
  }

  // ── Frame edits (local) ──────────────────────────────────────────────
  function isFieldEditable(field: keyof GeneratedScriptFrame): boolean {
    if (mode === 'ai_video') {
      return ['Voice', 'Text', 'Visual', 'Music', 'Footage', 'Time', 'Note'].includes(String(field))
    }
    return ['Voice', 'Text', 'Visual', 'Music'].includes(String(field))
  }

  function editField(frameIdx: number, field: keyof GeneratedScriptFrame, value: string) {
    setScripts((prev) => {
      const next = prev.slice()
      const sc = next[activeKbIndex]
      if (!sc) return prev
      const frames = sc.frames.slice()
      frames[frameIdx] = { ...frames[frameIdx], [field]: value }
      next[activeKbIndex] = { ...sc, frames }
      return next
    })
  }

  function resetFrame(frameIdx: number) {
    const orig = originByKbRef.current[activeKbIndex]?.[frameIdx]
    if (!orig) return
    const frameNum = orig.Frame ?? frameIdx + 1
    if (!window.confirm(t('content.restore.confirmFrame', { n: frameNum }))) return
    setScripts((prev) => {
      const next = prev.slice()
      const sc = next[activeKbIndex]
      if (!sc) return prev
      const frames = sc.frames.slice()
      frames[frameIdx] = { ...orig }
      next[activeKbIndex] = { ...sc, frames }
      return next
    })
  }

  async function handleApplyPatch(after: FramePatch['after'], frameIndex: number) {
    setScripts((prev) => {
      const next = prev.slice()
      const sc = next[activeKbIndex]
      if (!sc) return prev
      const frames = sc.frames.slice()
      const target = frames[frameIndex - 1]
      if (!target) return prev
      frames[frameIndex - 1] = {
        ...target,
        ...(after.Voice != null ? { Voice: String(after.Voice) } : {}),
        ...(after.Text != null ? { Text: String(after.Text) } : {}),
        ...(after.Visual != null ? { Visual: String(after.Visual) } : {}),
        ...(after.Music != null ? { Music: String(after.Music) } : {}),
      }
      next[activeKbIndex] = { ...sc, frames }
      return next
    })
  }

  // ── Render guard for direct URL hit ─────────────────────────────────
  if (!initial || !scripts.length || !activeScript) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const totalSelected = selectedKbIndexes.size

  return (
    // AppLayout wraps children in a <main className="flex-1 overflow-auto
    // p-4 sm:p-6"> sitting under a `h-12` (3rem) header. We want a true
    // full-viewport workspace where ONLY the chat list + frame list scroll,
    // not the outer page.
    //
    // <main> has `flex-1` inside a `h-screen overflow-hidden` flex column,
    // so its height = 100vh - 3rem. With `p-4` that leaves a content box
    // of (100vh - 3rem - 2rem) = `calc(100vh - 5rem)`. At `sm:p-6` it
    // becomes `calc(100vh - 6rem)`. Sizing our root EXACTLY to that box
    // means <main> sees no overflow → no outer scrollbar — only the inner
    // `overflow-y-auto` regions scroll.
    <div className="flex h-[calc(100vh-5rem)] flex-col sm:h-[calc(100vh-6rem)]">
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleDiscard}
          title={t('content.draft.discardTitle')}
          aria-label={t('content.draft.discardTitle')}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">
            {t('content.draft.title', { n: scripts.length })}
          </h1>
          <p className="text-[11px] text-muted-foreground">
            {t(`content.mode.${mode}`)} ·{' '}
            <span className="italic">{t('content.draft.unsavedHint')}</span>
            {parentFilename && (
              <>
                {' · '}
                <span className="font-mono">{parentFilename}</span>
              </>
            )}
          </p>
        </div>
        {saveError && (
          <span className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{saveError}</span>
        )}
        <Button
          onClick={handleSaveAll}
          disabled={saving || totalSelected === 0}
          className="gap-1.5"
        >
          {saving ? (
            <><Loader2 className="size-3.5 animate-spin" />{t('common.saving')}</>
          ) : (
            <>💾 {t('content.draft.saveCount', { n: totalSelected })}</>
          )}
        </Button>
      </div>

      {/* ── Body: sidebar + main ────────────────────────────────────── */}
      {/*
       * IMPORTANT: `grid-rows-1` here forces the SINGLE implicit row to
       * become `minmax(0,1fr)` instead of `auto`. Without it the row
       * sizes to content — so a long chat panel stretches the row, which
       * stretches the editor, which exceeds the outer h-[calc...] →
       * <main> shows an outer scrollbar and inner `overflow-y-auto`
       * regions never scroll independently. The `min-h-0` on each cell
       * lets it shrink BELOW its content (required for inner scroll).
       */}
      <div className="grid grid-rows-1 flex-1 grid-cols-[260px_minmax(0,1fr)] overflow-hidden [&>*]:min-h-0">
        {/* Sidebar — KB list */}
        <aside className="flex flex-col gap-1 overflow-y-auto border-r border-border bg-card p-2">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('content.draft.kbList', { n: scripts.length })}
          </p>
          {scripts.map((sc, i) => {
            const isActive = i === activeKbIndex
            const isTicked = selectedKbIndexes.has(i)
            const firstVoice = sc.frames[0]?.Voice || ''
            return (
              <button
                key={i}
                onClick={() => setActiveKbIndex(i)}
                className={`flex items-start gap-2 rounded-md border p-2 text-left transition ${
                  isActive
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-background hover:bg-muted/40'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isTicked}
                  onChange={(e) => {
                    e.stopPropagation()
                    setSelectedKbIndexes((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(i)
                      else next.delete(i)
                      return next
                    })
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="mt-0.5 size-3.5 cursor-pointer"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold">
                    {sc.kb_name || `KB${i + 1}`}
                    {sc.od_number && (
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                        · {sc.od_number}
                      </span>
                    )}
                  </p>
                  <p className="line-clamp-2 text-[11px] text-muted-foreground">
                    {firstVoice || t('content.noFrames')}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground/80">
                    {t('content.draft.frameCount', { n: sc.frames.length })}
                  </p>
                </div>
              </button>
            )
          })}
        </aside>

        {/* Main — 2-pane chat + editor for active KB */}
        <div className={`grid grid-rows-1 overflow-hidden [&>*]:min-h-0 ${chatOpen ? 'grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : 'grid-cols-[40px_1fr]'}`}>
          {chatOpen ? (
            <ChatPane
              messages={activeMessages}
              sending={sending}
              chatBody={chatBody}
              setChatBody={setChatBody}
              chatError={chatError}
              chipFrame={chatChipFrame}
              setChipFrame={setChatChipFrame}
              onSend={sendChat}
              onKeyDown={handleComposerKey}
              onCollapse={() => setChatOpen(false)}
              composerRef={composerRef}
              listEndRef={listEndRef}
              onApplyPatch={handleApplyPatch}
            />
          ) : (
            <button
              onClick={() => setChatOpen(true)}
              className="flex h-full flex-col items-center justify-start gap-2 border-r border-border bg-card py-3 text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t('content.chatRefine.expand')}
              aria-label={t('content.chatRefine.expand')}
            >
              <MessageSquare className="size-4" />
              <span
                className="text-[11px] font-medium"
                style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
              >
                {t('content.chatRefine.title')}
              </span>
              <ChevronRight className="size-3.5" />
            </button>
          )}

          {/* Right — frame editor */}
          <div className="flex h-full flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              {chatOpen && (
                <button
                  onClick={() => setChatOpen(false)}
                  title={t('content.chatRefine.collapse')}
                  aria-label={t('content.chatRefine.collapse')}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
              )}
              <h3 className="text-sm font-semibold">{t('content.framesTitle')}</h3>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {activeScript.kb_name || `KB${activeKbIndex + 1}`}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {t(`content.mode.${mode}`)}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2">
              <div className="flex flex-col gap-2">
                {activeScript.frames.map((frame, i) => {
                  const frameNumber = typeof frame.Frame === 'number' ? frame.Frame : i + 1
                  const phan = typeof frame['Phần'] === 'string' ? String(frame['Phần']) : ''
                  return (
                    <div key={i} className="rounded-lg border border-border bg-background p-2">
                      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold">
                          Frame {String(frame.Frame ?? i + 1)}
                        </span>
                        {phan && (
                          <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                            {phan}
                          </span>
                        )}
                        <div className="ml-auto flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 gap-1 px-1.5 text-[10px]"
                            onClick={() => focusChatOnFrame(frameNumber)}
                            title={t('content.askAi.title', { n: frameNumber })}
                          >
                            <MessageSquare className="size-3" />
                            {t('content.askAi.short')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 gap-1 px-1.5 text-[10px]"
                            onClick={() => resetFrame(i)}
                            title={t('content.restore.frameTitle', { n: frameNumber })}
                          >
                            <RotateCcw className="size-3" />
                            {t('content.restore.frameShort')}
                          </Button>
                        </div>
                      </div>
                      <FrameTieredEditor
                        frame={frame}
                        mode={mode}
                        isEditable={isFieldEditable}
                        onChange={(field, value) => editField(i, field, value)}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────
// Chat pane subcomponent — extracted purely for readability.
// ─────────────────────────────────────────────────────────────────────────
interface ChatPaneProps {
  messages: ChatMsg[]
  sending: boolean
  chatBody: string
  setChatBody: (v: string) => void
  chatError: string
  chipFrame: number | null
  setChipFrame: (n: number | null) => void
  onSend: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onCollapse: () => void
  composerRef: React.RefObject<HTMLTextAreaElement | null>
  listEndRef: React.RefObject<HTMLDivElement | null>
  onApplyPatch: (after: FramePatch['after'], frameIndex: number) => Promise<void>
}

function ChatPane({
  messages, sending, chatBody, setChatBody, chatError,
  chipFrame, setChipFrame, onSend, onKeyDown, onCollapse,
  composerRef, listEndRef, onApplyPatch,
}: ChatPaneProps) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Sparkles className="size-4 text-primary" />
        <h3 className="flex-1 text-sm font-semibold">{t('content.chatRefine.title')}</h3>
        <button
          onClick={onCollapse}
          aria-label={t('content.chatRefine.collapse')}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t('content.chatRefine.collapse')}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2.5">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
            <Bot className="size-8 opacity-50" />
            <p>{t('content.chatRefine.emptyHint')}</p>
            <p className="opacity-70">{t('content.previewRefine.chatLossHint')}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => <DraftBubble key={m.id} msg={m} onApplyPatch={onApplyPatch} />)}
            {sending && (
              <div className="flex items-center gap-2 self-start rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {t('content.chatRefine.aiThinking')}
              </div>
            )}
            <div ref={listEndRef} />
          </div>
        )}
      </div>
      <div className="border-t border-border p-3">
        {chipFrame !== null && (
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
            <span>@{t('content.chatRefine.frameChip', { n: chipFrame })}</span>
            <button
              onClick={() => setChipFrame(null)}
              aria-label={t('content.chatRefine.removeFrameChip')}
              className="rounded-full p-0.5 hover:bg-primary/25"
            >
              <X className="size-3" />
            </button>
          </div>
        )}
        <textarea
          ref={composerRef}
          value={chatBody}
          onChange={(e) => setChatBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('content.chatRefine.placeholder')}
          rows={2}
          className="w-full resize-y rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
        />
        {chatError && (
          <p className="mt-1 text-[11px] text-destructive">{chatError}</p>
        )}
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">{t('content.chatRefine.hint')}</span>
          <Button size="sm" onClick={onSend} disabled={!chatBody.trim() || sending}>
            {sending ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Send className="mr-1 size-3.5" />}
            {t('content.chatRefine.send')}
          </Button>
        </div>
      </div>
    </div>
  )
}


interface DraftBubbleProps {
  msg: ChatMsg
  onApplyPatch: (after: FramePatch['after'], frameIndex: number) => Promise<void>
}

function DraftBubble({ msg, onApplyPatch }: DraftBubbleProps) {
  const { t } = useTranslation()
  const isUser = msg.sender === 'USER'
  const patches = msg.attached_patches || []
  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className={`flex size-7 shrink-0 items-center justify-center rounded-full ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
        {isUser ? <UserIcon className="size-3.5" /> : <Bot className="size-3.5" />}
      </div>
      <div className={`max-w-[88%] rounded-lg px-3 py-1.5 text-sm leading-relaxed ${isUser ? 'bg-primary/10' : 'bg-muted'}`}>
        {msg.frame_target != null && (
          <span className="mr-1 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            @{t('content.chatRefine.frameChip', { n: msg.frame_target })}
          </span>
        )}
        <MarkdownText text={msg.body} />
        {patches.map((p) => (
          <PatchSuggestionCard key={`p-${p.frame_index}`} patch={p} onApply={onApplyPatch} />
        ))}
      </div>
    </div>
  )
}
