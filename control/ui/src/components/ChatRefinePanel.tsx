/**
 * ChatRefinePanel — left-column AI chat for a single Content (= 1 KB).
 *
 * Spec: docs/Gen_Scenario/chat-refine-design.md §6.1, §6.3
 *
 * UX:
 *   - List of USER/ASSISTANT bubbles ordered chronologically.
 *   - Composer at the bottom: textarea + Send. Optional "@Frame N" chip
 *     prefills frame_target so AI talks about that specific frame.
 *   - The "@Frame" chip is added by the parent calling `requestFocusOnFrame`
 *     when the user clicks "💬 Hỏi AI" on a frame card to the right.
 *   - Auto-scrolls to the newest message on mount and after every send.
 *   - Send is disabled while a reply is in-flight (single concurrent turn).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Bot, Loader2, Send, Sparkles, User as UserIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownText } from '@/components/MarkdownText'
import { PatchSuggestionCard } from '@/components/PatchSuggestionCard'
import { contentsApi } from '@/lib/api'
import type { FramePatch, ScriptChatMessage } from '@/lib/types'

export interface ChatRefinePanelHandle {
  /** Called by the right-pane "💬 Hỏi AI" button to seed the composer. */
  focusFrame: (frameNumber: number) => void
}

interface Props {
  contentId: number
  /** Total frames in the current KB — used to render the @Frame chip max. */
  framesCount: number
  onClose?: () => void
}

export const ChatRefinePanel = forwardRef<ChatRefinePanelHandle, Props>(
  function ChatRefinePanel({ contentId, framesCount, onClose }, ref) {
    const { t } = useTranslation()
    const qc = useQueryClient()
    const listEndRef = useRef<HTMLDivElement | null>(null)
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)
    const [body, setBody] = useState('')
    const [frameTarget, setFrameTarget] = useState<number | null>(null)

    const { data: messages = [], isLoading } = useQuery<ScriptChatMessage[]>({
      queryKey: ['contents', contentId, 'script-chat'],
      queryFn: () => contentsApi.scriptChat.list(contentId),
    })

    const sendMutation = useMutation({
      mutationFn: async () => {
        const trimmed = body.trim()
        if (!trimmed) throw new Error('empty')
        await contentsApi.scriptChat.send(contentId, {
          body: trimmed,
          frame_target: frameTarget,
        })
      },
      onSuccess: async () => {
        setBody('')
        setFrameTarget(null)
        // Refetch chat (assistant turn + attached_patches) and Content
        // (in case a future iteration auto-commits — we'd see updated
        // frames immediately too).
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['contents', contentId, 'script-chat'] }),
          qc.invalidateQueries({ queryKey: ['contents', String(contentId)] }),
        ])
      },
    })

    // Apply handler called from inside an assistant bubble's
    // PatchSuggestionCard: commits the AI-proposed `after` fields via the
    // existing /update-frame endpoint so the edit goes through the same
    // CODE-enforces-contract path as manual edits (mode guard, dash
    // sanitize, audit log).
    async function handleApplyPatch(after: FramePatch['after'], frameIndex: number) {
      await contentsApi.updateFrame(contentId, {
        op: 'update',
        frame_index: frameIndex,
        fields: after,
      })
      await qc.invalidateQueries({ queryKey: ['contents', String(contentId)] })
    }

    // ── Imperative handle: parent calls focusFrame(n) ────────────────────
    useImperativeHandle(ref, () => ({
      focusFrame: (n: number) => {
        if (n >= 1 && n <= framesCount) {
          setFrameTarget(n)
          textareaRef.current?.focus()
        }
      },
    }), [framesCount])

    // ── Auto-scroll to newest on every list change ───────────────────────
    useEffect(() => {
      listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }, [messages.length, sendMutation.isPending])

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
      // Cmd/Ctrl+Enter or plain Enter (without Shift) → send.
      // We allow Shift+Enter to insert a newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (!sendMutation.isPending && body.trim()) sendMutation.mutate()
      }
    }

    return (
      <div className="flex h-full flex-col rounded-xl border border-border bg-card">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Sparkles className="size-4 text-primary" />
          <h3 className="flex-1 text-sm font-semibold">{t('content.chatRefine.title')}</h3>
          {onClose && (
            <button
              onClick={onClose}
              aria-label={t('content.chatRefine.collapse')}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t('content.chatRefine.collapse')}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 py-2.5">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
              <Bot className="size-8 opacity-50" />
              <p>{t('content.chatRefine.emptyHint')}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {messages.map((m) => (
                <MessageBubble key={m.id} msg={m} onApplyPatch={handleApplyPatch} />
              ))}
              {sendMutation.isPending && (
                <div className="flex items-center gap-2 self-start rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {t('content.chatRefine.aiThinking')}
                </div>
              )}
              <div ref={listEndRef} />
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border p-3">
          {frameTarget !== null && (
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
              <span>@{t('content.chatRefine.frameChip', { n: frameTarget })}</span>
              <button
                onClick={() => setFrameTarget(null)}
                aria-label={t('content.chatRefine.removeFrameChip')}
                className="rounded-full p-0.5 hover:bg-primary/25"
                title={t('content.chatRefine.removeFrameChip')}
              >
                <X className="size-3" />
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('content.chatRefine.placeholder')}
            rows={2}
            className="w-full resize-y rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          {sendMutation.isError && (
            <p className="mt-1 text-[11px] text-destructive">
              {t('content.chatRefine.sendFailed')}
            </p>
          )}
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {t('content.chatRefine.hint')}
            </span>
            <Button
              size="sm"
              onClick={() => sendMutation.mutate()}
              disabled={!body.trim() || sendMutation.isPending}
            >
              {sendMutation.isPending ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <Send className="mr-1 size-3.5" />
              )}
              {t('content.chatRefine.send')}
            </Button>
          </div>
        </div>
      </div>
    )
  },
)

interface MessageBubbleProps {
  msg: ScriptChatMessage
  onApplyPatch: (after: FramePatch['after'], frameIndex: number) => Promise<void>
}

function MessageBubble({ msg, onApplyPatch }: MessageBubbleProps) {
  const { t } = useTranslation()
  const isUser = msg.sender === 'USER'
  const patches = Array.isArray(msg.attached_patches) ? msg.attached_patches : []
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
          <PatchSuggestionCard
            key={`p-${p.frame_index}`}
            patch={p}
            onApply={onApplyPatch}
          />
        ))}
      </div>
    </div>
  )
}
