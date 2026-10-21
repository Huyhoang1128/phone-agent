import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, FileText,
  Image as ImageIcon, Loader2, MessageSquare, RotateCcw, Sparkles, Video, Wand2, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChatRefinePanel, type ChatRefinePanelHandle } from '@/components/ChatRefinePanel'
import { FrameTieredEditor } from '@/components/FrameTieredEditor'
import { contentsApi } from '@/lib/api'
import type {
  ContentItem, GeneratedScript, GeneratedScriptFrame,
} from '@/lib/types'

const CHAT_PANEL_STORAGE_KEY = 'contentDetail.chatPanel.open'

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
}

export default function ContentDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data: item, isLoading } = useQuery<ContentItem>({
    queryKey: ['contents', id],
    queryFn: () => contentsApi.get(Number(id)),
    enabled: Boolean(id),
  })

  // ── "Tối ưu bằng AI" (ScriptStudio) ──────────────────────────────────────
  const qc = useQueryClient()
  const [optOpen, setOptOpen] = useState(false)
  const [brief, setBrief] = useState('')
  const [allowStructure, setAllowStructure] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [optResult, setOptResult] = useState<GeneratedScript | null>(null)
  const [optError, setOptError] = useState('')
  const [saving, setSaving] = useState(false)

  function closeOpt() {
    setOptOpen(false)
    setOptResult(null)
    setOptError('')
    setBrief('')
    setAllowStructure(false)
  }

  async function runOptimize() {
    if (!item) return
    setOptimizing(true)
    setOptError('')
    setOptResult(null)
    try {
      const resp = await contentsApi.optimizeScript(item.id, {
        mode: 'real_footage',
        allow_structure_change: allowStructure,
        optimization_brief: brief.trim(),
      })
      setOptResult(resp.optimized_script)
    } catch (e) {
      setOptError(e instanceof Error ? e.message : t('content.optimize.failed'))
    } finally {
      setOptimizing(false)
    }
  }

  async function saveOptimized() {
    if (!item || !optResult) return
    setSaving(true)
    setOptError('')
    try {
      await contentsApi.saveFrames(item.id, optResult.frames)
      await qc.invalidateQueries({ queryKey: ['contents', id] })
      closeOpt()
    } catch (e) {
      setOptError(e instanceof Error ? e.message : t('content.optimize.failed'))
    } finally {
      setSaving(false)
    }
  }

  // ── Chat-refine: panel collapse state (persist in localStorage) ──────────
  const [chatOpen, setChatOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(CHAT_PANEL_STORAGE_KEY)
      return v == null ? true : v === '1'
    } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem(CHAT_PANEL_STORAGE_KEY, chatOpen ? '1' : '0') } catch { /* private mode */ }
  }, [chatOpen])

  // Keyboard shortcut: Ctrl+\ to toggle chat panel (matches VSCode sidebar).
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault()
        setChatOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Imperative bridge: clicking "💬 Hỏi AI" on a frame card focuses the chat
  // composer + sets the @Frame chip via the panel's imperative handle.
  const chatPanelRef = useRef<ChatRefinePanelHandle | null>(null)
  function focusChatOnFrame(frameNumber: number) {
    if (!chatOpen) setChatOpen(true)
    setTimeout(() => chatPanelRef.current?.focusFrame(frameNumber), 50)
  }

  // ── Restore-all confirm modal state ─────────────────────────────────────
  // (the per-frame 🪄 refine modal is gone — chat handles refines now via
  // PatchSuggestionCard inline)
  const [restoreAllConfirm, setRestoreAllConfirm] = useState(false)
  const [restoringAll, setRestoringAll] = useState(false)

  async function handleManualUpdate(
    frameIndex: number,
    field: keyof GeneratedScriptFrame,
    newValue: string,
  ) {
    if (!item) return
    await contentsApi.updateFrame(item.id, {
      op: 'update',
      frame_index: frameIndex,
      fields: { [field]: newValue } as Partial<GeneratedScriptFrame>,
    })
    await qc.invalidateQueries({ queryKey: ['contents', id] })
  }

  async function handleRestoreFrame(frameIndex: number) {
    if (!item) return
    if (!window.confirm(t('content.restore.confirmFrame', { n: frameIndex }))) return
    await contentsApi.updateFrame(item.id, {
      op: 'restore_frame',
      frame_index: frameIndex,
    })
    await qc.invalidateQueries({ queryKey: ['contents', id] })
  }

  async function handleRestoreAll() {
    if (!item) return
    setRestoringAll(true)
    try {
      await contentsApi.updateFrame(item.id, { op: 'restore_all' })
      await qc.invalidateQueries({ queryKey: ['contents', id] })
      setRestoreAllConfirm(false)
    } finally {
      setRestoringAll(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground">{t('content.detailNotFound')}</p>
        <Button variant="outline" onClick={() => navigate('/content')}>
          <ArrowLeft className="mr-2 size-4" />
          {t('content.backToList')}
        </Button>
      </div>
    )
  }

  // Records produced by the "Gen Content" AI flow store their actual payload
  // in `frames` (one entry per scene); the legacy video / file / image / text
  // fields are empty by design. Render those records with a dedicated layout
  // and skip the empty legacy cards entirely.
  const isGenerated = item.source_type === 'generated'
  const framesToShow: GeneratedScriptFrame[] = Array.isArray(item.frames) ? item.frames : []

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate('/content')} aria-label={t('content.backToList')}>
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="truncate text-xl font-semibold">{item.title}</h1>
        {isGenerated && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-2"
            onClick={() => navigate(`/content/${item.id}/convert-to-video`)}
          >
            <Video className="size-4" />
            {t('content.convert.action')}
          </Button>
        )}
        {isGenerated && (
          <Button variant="outline" size="sm" className="gap-2" onClick={() => setOptOpen(true)}>
            <Wand2 className="size-4" />
            {t('content.optimize.action')}
          </Button>
        )}
        {isGenerated && (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
            <Sparkles className="size-3" />
            {t('content.aiBadge')}
          </span>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">
          {t('content.createdAt')}: {formatDateTime(item.created_at)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('content.updatedAt')}: {formatDateTime(item.updated_at)}
        </p>
        {isGenerated && (
          <div className="mt-3 grid grid-cols-1 gap-2 border-t border-border pt-3 text-xs sm:grid-cols-3">
            {item.kb_name && (
              <div>
                <p className="font-medium text-muted-foreground">{t('content.kbNameLabel')}</p>
                <p className="text-foreground">{item.kb_name}</p>
              </div>
            )}
            {item.od_number && (
              <div>
                <p className="font-medium text-muted-foreground">{t('content.odNumberLabel')}</p>
                <p className="text-foreground">{item.od_number}</p>
              </div>
            )}
            {item.parent_scenario_filename && (
              <div>
                <p className="font-medium text-muted-foreground">{t('content.parentScenarioLabel')}</p>
                <p className="break-all font-mono text-foreground">{item.parent_scenario_filename}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {isGenerated ? (
        // AI-generated record: 2-column layout — chat panel left, KB editor right.
        // The chat panel is collapsible (Ctrl+\) and its open/closed state is
        // persisted in localStorage so user preference survives across sessions.
        <div className={`grid gap-4 ${chatOpen ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : 'lg:grid-cols-[40px_1fr]'}`}>
          {/* Left — Chat panel (or collapsed rail) */}
          {chatOpen ? (
            <div className="h-[min(80vh,720px)]">
              <ChatRefinePanel
                ref={chatPanelRef}
                contentId={item.id}
                framesCount={Array.isArray(item.frames) ? item.frames.length : 0}
                onClose={() => setChatOpen(false)}
              />
            </div>
          ) : (
            <button
              onClick={() => setChatOpen(true)}
              className="flex h-full min-h-[120px] flex-col items-center justify-start gap-2 rounded-xl border border-border bg-card py-3 text-muted-foreground hover:bg-muted hover:text-foreground"
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

          {/* Right — KB editor */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <FileText className="size-4" />
              <h2 className="text-sm font-semibold">{t('content.framesTitle')}</h2>
              {item.mode && (
                <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {t(`content.mode.${item.mode}`)}
                </span>
              )}
              {/* Auto-save reassurance — post-save edits + AI Apply commit
                  to DB immediately via /update-frame. Users were confused
                  by the lack of an explicit Save button; this badge makes
                  the auto-save contract visible. */}
              <span
                className="ml-1 inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400"
                title={t('content.autoSaveTooltip')}
              >
                <Sparkles className="size-3" />
                {t('content.autoSaveBadge')}
              </span>
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
              <div className="ml-auto flex items-center gap-2">
                {Array.isArray(item.origin_frames) && item.origin_frames.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setRestoreAllConfirm(true)}
                    title={t('content.restore.allTitle')}
                  >
                    <RotateCcw className="size-3.5" />
                    {t('content.restore.allAction')}
                  </Button>
                )}
              </div>
            </div>

            {framesToShow.length > 0 ? (
              <div className="flex flex-col gap-4">
                {framesToShow.map((frame, i) => {
                  const frameNumber = typeof frame.Frame === 'number' ? frame.Frame : i + 1
                  const phan = typeof frame['Phần'] === 'string' ? String(frame['Phần']) : ''
                  return (
                    <div key={i} className="rounded-lg border border-border bg-background p-3">
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                          Frame {String(frame.Frame ?? i + 1)}
                        </span>
                        {phan && (
                          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                            {phan}
                          </span>
                        )}
                        <div className="ml-auto flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 px-2 text-[11px]"
                            onClick={() => focusChatOnFrame(frameNumber)}
                            title={t('content.askAi.title', { n: frameNumber })}
                          >
                            <MessageSquare className="size-3" />
                            {t('content.askAi.short')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 px-2 text-[11px]"
                            onClick={() => handleRestoreFrame(frameNumber)}
                            title={t('content.restore.frameTitle', { n: frameNumber })}
                          >
                            <RotateCcw className="size-3" />
                            {t('content.restore.frameShort')}
                          </Button>
                        </div>
                      </div>

                      <PersistedFrameEditor
                        frame={frame}
                        mode={item.mode}
                        readOnly={false}
                        onSaveField={(field, value) => handleManualUpdate(frameNumber, field, value)}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('content.noFrames')}</p>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Left column: text content */}
        <div className="flex flex-col gap-5">
          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <FileText className="size-4" />
              {t('content.fieldTextContent')}
            </h2>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {item.text_content || item.script || t('content.noTextContent')}
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <FileText className="size-4" />
              {t('content.fieldFileUrl')}
            </h2>
            {item.file_url ? (
              <a
                href={item.file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                <ExternalLink className="size-3.5" />
                {item.file_url}
              </a>
            ) : (
              <p className="text-sm text-muted-foreground">{t('content.noFile')}</p>
            )}
          </div>
        </div>

        {/* Right column: video and image media */}
        <div className="flex flex-col gap-5">
          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Video className="size-4" />
              {t('content.fieldVideoUrl')}
            </h2>
            {item.video_url ? (
              <div className="flex flex-col gap-2">
                <a
                  href={item.video_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="size-3.5" />
                  {item.video_url}
                </a>
                <video
                  src={item.video_url}
                  controls
                  aria-label={t('content.fieldVideoUrl')}
                  className="mt-2 w-full rounded-lg"
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('content.noVideo')}</p>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <ImageIcon className="size-4" />
              {t('content.fieldImageUrls')}
            </h2>
            {Array.isArray(item.image_urls) && item.image_urls.length > 0 ? (
              <div className="flex flex-col gap-3">
                {item.image_urls.map((url, index) => (
                  <div key={`${url}-${index}`} className="flex flex-col gap-1">
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      <ExternalLink className="size-3.5" />
                      {url}
                    </a>
                    <img
                      src={url}
                      alt={`${t('content.fieldImageUrls')} ${index + 1}`}
                      className="w-full rounded-lg object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('content.noImages')}</p>
            )}
          </div>
        </div>
        </div>
      )}

      {/* ── Modal "Khôi phục cả KB" — confirm ─────────────────────────── */}
      {restoreAllConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl">
            <h3 className="mb-2 flex items-center gap-2 text-base font-semibold">
              <RotateCcw className="size-4 text-amber-600" />
              {t('content.restore.allConfirmTitle')}
            </h3>
            <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('content.restore.allConfirmL1')}</li>
              <li>{t('content.restore.allConfirmL2')}</li>
              <li>{t('content.restore.allConfirmL3')}</li>
            </ul>
            <p className="mb-4 text-xs text-muted-foreground">{t('content.restore.allConfirmChatKept')}</p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setRestoreAllConfirm(false)} disabled={restoringAll}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleRestoreAll} disabled={restoringAll}>
                {restoringAll ? (
                  <><Loader2 className="mr-1.5 size-3.5 animate-spin" />{t('common.processing')}</>
                ) : (
                  t('content.restore.allConfirmAction')
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal "Tối ưu bằng AI" ─────────────────────────────────────── */}
      {optOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{t('content.optimize.title')}</h2>
              <button onClick={closeOpt} className="rounded-lg p-1 text-muted-foreground hover:bg-muted" aria-label={t('common.cancel')}>
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-4 overflow-auto p-5">
              {!optResult ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium">{t('content.optimize.briefLabel')}</label>
                    <textarea
                      value={brief}
                      onChange={(e) => setBrief(e.target.value)}
                      rows={3}
                      placeholder={t('content.optimize.briefPlaceholder')}
                      className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={allowStructure} onChange={(e) => setAllowStructure(e.target.checked)} />
                    {t('content.optimize.allowStructure')}
                  </label>
                </>
              ) : (
                <div className="flex flex-col gap-3">
                  <p className="text-xs text-muted-foreground">{t('content.optimize.previewHint')}</p>
                  {optResult.frames.map((frame, i) => (
                    <div key={i} className="rounded-lg border border-border bg-background p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                          Frame {String(frame.Frame ?? i + 1)}
                        </span>
                        {typeof frame['Phần'] === 'string' && frame['Phần'] && (
                          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                            {String(frame['Phần'])}
                          </span>
                        )}
                      </div>
                      {frame.Voice && <p className="mb-1 text-sm"><span className="font-medium">Voice: </span>{frame.Voice}</p>}
                      {frame.Text && <p className="mb-1 text-sm"><span className="font-medium">Text: </span>{frame.Text}</p>}
                      {typeof frame.Visual === 'string' && frame.Visual && <p className="mb-1 text-sm text-muted-foreground"><span className="font-medium text-foreground">Visual: </span>{frame.Visual}</p>}
                      {frame.Footage && <p className="text-xs text-muted-foreground"><span className="font-medium">Footage: </span>{frame.Footage}</p>}
                      {frame.Time && <p className="text-xs text-muted-foreground"><span className="font-medium">Time: </span>{frame.Time}</p>}
                      {typeof frame.Music === 'string' && frame.Music && <p className="text-xs text-muted-foreground"><span className="font-medium">Music: </span>{frame.Music}</p>}
                    </div>
                  ))}
                </div>
              )}
              {optError && <p className="text-sm text-destructive">{optError}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" onClick={closeOpt} disabled={optimizing || saving}>
                {t('common.cancel')}
              </Button>
              {!optResult ? (
                <Button onClick={runOptimize} disabled={optimizing}>
                  {optimizing ? (
                    <><Loader2 className="mr-1 size-4 animate-spin" />{t('content.optimize.running')}</>
                  ) : (
                    t('content.optimize.start')
                  )}
                </Button>
              ) : (
                <Button onClick={saveOptimized} disabled={saving}>
                  {saving ? (
                    <><Loader2 className="mr-1 size-4 animate-spin" />{t('common.saving')}</>
                  ) : (
                    t('content.optimize.save')
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── PersistedFrameEditor ─────────────────────────────────────────────────
// Wraps FrameTieredEditor with per-field debounce + auto-save against
// /update-frame. We hold a local `draft` so the user's typing isn't
// interrupted by server snapshots, and reconcile when the parent's
// authoritative `frame` changes (e.g. after Restore or Apply-patch).
//
// Save status indicator is at the card level (single chip) rather than
// per-field to avoid noise; this matches the user's observation that the
// pre-Phase-5 grid felt cluttered.
interface PersistedFrameEditorProps {
  frame: GeneratedScriptFrame
  mode: ContentItem['mode']
  readOnly: boolean
  onSaveField: (field: keyof GeneratedScriptFrame, value: string) => Promise<void>
}

function PersistedFrameEditor({ frame, mode, readOnly, onSaveField }: PersistedFrameEditorProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<GeneratedScriptFrame>(frame)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const lastSavedFrameRef = useRef<GeneratedScriptFrame>(frame)

  // Reconcile when the server-side frame changes (e.g. restore, refine
  // Apply, footage resolve). Don't blow away an unsaved draft mid-typing.
  useEffect(() => {
    if (status === 'idle' || status === 'saved') {
      setDraft(frame)
      lastSavedFrameRef.current = frame
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame])

  useEffect(() => () => {
    timersRef.current.forEach((t) => clearTimeout(t))
    timersRef.current.clear()
  }, [])

  function handleChange(field: keyof GeneratedScriptFrame, value: string) {
    setDraft((prev) => ({ ...prev, [field]: value }))
    const existing = timersRef.current.get(String(field))
    if (existing) clearTimeout(existing)
    timersRef.current.set(String(field), setTimeout(() => {
      const lastSaved = String(lastSavedFrameRef.current[field] ?? '')
      if (value === lastSaved) {
        setStatus('idle')
        return
      }
      setStatus('saving'); setError('')
      onSaveField(field, value)
        .then(() => {
          lastSavedFrameRef.current = { ...lastSavedFrameRef.current, [field]: value }
          setStatus('saved')
          setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 1500)
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err))
          setStatus('error')
        })
    }, 800))
  }

  // Reuse the same mode-mask the server enforces. Voice/Text/Visual/Music
  // always editable; Footage/Time/Note locked in real_footage mode.
  function isEditable(field: keyof GeneratedScriptFrame): boolean {
    if (readOnly) return false
    if (mode === 'ai_video') {
      return ['Voice', 'Text', 'Visual', 'Music', 'Footage', 'Time', 'Note'].includes(String(field))
    }
    return ['Voice', 'Text', 'Visual', 'Music'].includes(String(field))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
        {status === 'saving' && (
          <><Loader2 className="size-3 animate-spin" />{t('content.editableField.saving')}</>
        )}
        {status === 'saved' && (
          <span className="text-green-600">✓ {t('content.editableField.saved')}</span>
        )}
        {status === 'error' && (
          <span className="text-destructive" title={error}>
            ⚠ {t('content.editableField.error')}
          </span>
        )}
      </div>
      <FrameTieredEditor
        frame={draft}
        mode={mode === 'ai_video' ? 'ai_video' : 'real_footage'}
        isEditable={isEditable}
        onChange={handleChange}
      />
    </div>
  )
}
