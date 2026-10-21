/**
 * v3.2.1 UX-5 — Chat panel bubble-style.
 *
 * Theo đề xuất ChatGPT/Gemini trong đề_xuất_tinh_chỉnh_giao_diện.md:
 * - Bong bóng iMessage style: user right-aligned violet, AI left-aligned slate
 * - Avatar + name + time inline
 * - Patch card compact dưới bubble (click expand diff)
 * - Suggested prompts dưới input ("Sửa hook shot 1", "Đổi tone", ...)
 * - Sticky context chips (target_shots, target_character) above input
 */
import { Bot, Send, Sparkles, Square, User, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ScenarioChatProposalCards } from '@/components/scenario/ScenarioChatProposalCards'
import { colors, typography } from '@/lib/scenario-tokens'
import type {
  ProposedOptionsPayload,
  ScenarioChatMessage,
  ScenarioPatch,
  StructuredAction,
} from '@/lib/types'

interface ChatTransient {
  structured_actions: StructuredAction[]
  proposed_options: ProposedOptionsPayload | null
  clarification_question: string | null
  thinking?: string
  artistic_checks?: import('@/lib/types').ArtisticCheckPayload[]
}

interface Props {
  scenarioId: number
  messages: ScenarioChatMessage[]
  transients: Record<number, ChatTransient>
  chatInput: string
  setChatInput: (v: string) => void
  chatSending: boolean
  onSend: (overrideText?: string) => void
  onStop?: () => void
  targetShots: number[]
  targetCharacter: string
  onClearShot: (id: number) => void
  onClearCharacter: () => void
  /** Return Promise<boolean> để PatchCard biết apply success/fail và update state. */
  onApplyPatch: (p: ScenarioPatch) => Promise<boolean>
  onPickOption: (label: string) => void
  onExecuteApproved: (action: StructuredAction) => Promise<void> | void
  onExecuteInsert: (action: Extract<StructuredAction, { kind: 'insert_shot' }>) => Promise<void> | void
}

// SUGGESTED_PROMPTS giữ là KEYS — translate trong render qua t() cho i18n proper.
const SUGGESTED_PROMPT_KEYS = [
  'suggestHookStronger',
  'suggestVoiceGenZ',
  'suggestAddCta',
  'suggestYoungerChar',
  'suggestOptimizeBg',
] as const

export function ScenarioChatPanel({
  scenarioId,
  messages,
  transients,
  chatInput,
  setChatInput,
  chatSending,
  onSend,
  onStop,
  targetShots,
  targetCharacter,
  onClearShot,
  onClearCharacter,
  onApplyPatch,
  onPickOption,
  onExecuteApproved,
  onExecuteInsert,
}: Props) {
  const { t } = useTranslation()
  const [showSuggested, setShowSuggested] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isFirstLoad = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow textarea height based on content
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    const maxHeight = Math.min(150, window.innerHeight * 0.4)
    const nextHeight = textarea.scrollHeight

    if (nextHeight > maxHeight) {
      textarea.style.height = `${maxHeight}px`
      textarea.style.overflowY = 'auto'
    } else {
      textarea.style.height = `${nextHeight}px`
      textarea.style.overflowY = 'hidden'
    }
  }, [chatInput])

  // Tự động cuộn xuống dưới cùng khi có tin nhắn mới hoặc đang stream
  useEffect(() => {
    if (messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({
        behavior: isFirstLoad.current ? 'auto' : 'smooth'
      })
      isFirstLoad.current = false
    }
  }, [messages, transients, chatSending])

  return (
    // min-h-0 BẮT BUỘC cho flex column hỗ trợ overflow trong messages region
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 bg-background">
        <Sparkles className={`size-4 ${colors.primary.text}`} />
        <span className={typography.sectionTitle}>{t('content.aiScenario.chatPanelTitle')}</span>
      </div>

      {/* ── Messages — bubble-style ─────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 space-y-3 custom-scrollbar">
        {messages.length === 0 && (
          <EmptyChatState onPick={(s) => setChatInput(s)} />
        )}
        {messages.map((m) => (
          <ChatBubble
            key={m.id}
            message={m}
            transient={transients[m.id]}
            scenarioId={scenarioId}
            onApplyPatch={onApplyPatch}
            onPickOption={onPickOption}
            onExecuteApproved={onExecuteApproved}
            onExecuteInsert={onExecuteInsert}
            chatSending={chatSending}
            onSend={onSend}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Sticky context chips ────────────────────────────────────────── */}
      {(targetShots.length > 0 || targetCharacter) && (
        <div className="flex shrink-0 flex-wrap gap-1 border-t border-border bg-muted/40 px-2 py-1.5">
          {targetShots.map((s) => (
            <span
              key={s}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${colors.primary.bgSoft} ${colors.primary.text}`}
            >
              {t('content.aiScenario.chipShot', { n: s })}
              <button onClick={() => onClearShot(s)} aria-label="Clear">
                <X className="size-2.5" />
              </button>
            </span>
          ))}
          {targetCharacter && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${colors.success.bgSoft} ${colors.success.text}`}
            >
              {t('content.aiScenario.chipCharacter', { name: targetCharacter })}
              <button onClick={onClearCharacter} aria-label="Clear">
                <X className="size-2.5" />
              </button>
            </span>
          )}
        </div>
      )}

      {/* ── Suggested prompts (chỉ hiện khi input rỗng) ─────────────────── */}
      {showSuggested && chatInput.trim().length === 0 && messages.length > 0 && (
        <div className="shrink-0 border-t border-border bg-background/50 px-2 py-1.5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t('content.aiScenario.suggestedPromptsLabel', { defaultValue: 'Gợi ý nhanh' })}
            </span>
            <button
              onClick={() => setShowSuggested(false)}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              {t('content.aiScenario.hideHint', { defaultValue: 'Ẩn' })}
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {SUGGESTED_PROMPT_KEYS.map((k) => {
              const text = t(`content.aiScenario.${k}`)
              return (
                <button
                  key={k}
                  onClick={() => setChatInput(text)}
                  className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground hover:border-indigo-400/60 hover:text-foreground transition"
                >
                  {text}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Input area ──────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-border bg-background p-2">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (!chatSending) {
                  onSend()
                }
              }
            }}
            placeholder={t('content.aiScenario.chatPlaceholder')}
            style={{ height: 'auto', minHeight: '32px' }}
            className="w-full resize-none rounded-md border border-border bg-muted/30 px-2.5 py-2 pr-9 text-xs leading-relaxed focus:bg-background focus:border-indigo-500/50 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition"
          />
          {chatSending ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={onStop}
              className="absolute right-1.5 bottom-1.5 h-7 w-7 p-0 bg-red-600 hover:bg-red-700 text-white animate-pulse"
              aria-label="Tạm dừng"
            >
              <Square className="size-3" fill="currentColor" />
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => onSend()}
              disabled={!chatInput.trim()}
              className="absolute right-1.5 bottom-1.5 h-7 w-7 p-0"
              aria-label="Gửi"
            >
              <Send className="size-3.5" />
            </Button>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{t('content.aiScenario.chatKeyHint', { defaultValue: 'Enter = gửi · Shift+Enter = xuống dòng' })}</span>
          {chatSending && (
            <span className="inline-flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-indigo-500 animate-pulse" />
              {t('content.aiScenario.chatThinking', { defaultValue: 'AI đang nghĩ...' })}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function SafeMarkdown({ text }: { text: string }) {
  if (!text) return null

  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let listItems: string[] = []

  const flushList = (key: string | number) => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={`list-${key}`} className="list-disc pl-4 my-1 space-y-1">
          {listItems.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>
      )
      listItems.length = 0
    }
  }

  const renderInline = (str: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = []
    let currentText = ''
    let i = 0

    while (i < str.length) {
      if (str.startsWith('**', i)) {
        if (currentText) {
          parts.push(currentText)
          currentText = ''
        }
        const endIdx = str.indexOf('**', i + 2)
        if (endIdx !== -1) {
          parts.push(
            <strong key={i} className="font-bold text-foreground">
              {str.substring(i + 2, endIdx)}
            </strong>
          )
          i = endIdx + 2
        } else {
          currentText += '**'
          i += 2
        }
      } else if (str.startsWith('*', i)) {
        if (currentText) {
          parts.push(currentText)
          currentText = ''
        }
        const endIdx = str.indexOf('*', i + 1)
        if (endIdx !== -1) {
          parts.push(
            <em key={i} className="italic">
              {str.substring(i + 1, endIdx)}
            </em>
          )
          i = endIdx + 1
        } else {
          currentText += '*'
          i += 1
        }
      } else if (str.startsWith('`', i)) {
        if (currentText) {
          parts.push(currentText)
          currentText = ''
        }
        const endIdx = str.indexOf('`', i + 1)
        if (endIdx !== -1) {
          parts.push(
            <code key={i} className="bg-muted px-1.5 py-0.5 rounded font-mono text-[10px] border border-border">
              {str.substring(i + 1, endIdx)}
            </code>
          )
          i = endIdx + 1
        } else {
          currentText += '`'
          i += 1
        }
      } else {
        currentText += str[i]
        i++
      }
    }
    if (currentText) {
      parts.push(currentText)
    }
    return parts
  }

  lines.forEach((line, lineIdx) => {
    const trimmed = line.trim()
    
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (headerMatch) {
      flushList(lineIdx)
      const level = headerMatch[1].length
      const content = headerMatch[2]
      const className = level === 1 
        ? 'text-sm font-bold mt-2 mb-1 text-foreground' 
        : level === 2 
        ? 'text-[13px] font-bold mt-1.5 mb-1 text-foreground' 
        : 'text-[12px] font-semibold mt-1 mb-0.5 text-foreground'
      
      const Tag = `h${Math.min(level, 6)}` as any
      elements.push(
        <Tag key={lineIdx} className={className}>
          {renderInline(content)}
        </Tag>
      )
      return
    }

    const listMatch = trimmed.match(/^[-*]\s+(.*)$/)
    if (listMatch) {
      listItems.push(listMatch[1])
      return
    }

    if (trimmed === '') {
      flushList(lineIdx)
      elements.push(<div key={lineIdx} className="h-1" />)
    } else {
      flushList(lineIdx)
      elements.push(
        <p key={lineIdx} className="my-0.5 leading-relaxed">
          {renderInline(line)}
        </p>
      )
    }
  })

  flushList('end')

  return <div className="space-y-0.5">{elements}</div>
}

// ─── Single bubble ───────────────────────────────────────────────────────────

interface BubbleProps {
  message: ScenarioChatMessage
  transient: ChatTransient | undefined
  scenarioId: number
  onApplyPatch: (p: ScenarioPatch) => Promise<boolean>
  onPickOption: (label: string) => void
  onExecuteApproved: (action: StructuredAction) => Promise<void> | void
  onExecuteInsert: (action: Extract<StructuredAction, { kind: 'insert_shot' }>) => Promise<void> | void
  chatSending: boolean
  onSend: (overrideText?: string) => void
}

function ChatBubble({
  message,
  transient,
  scenarioId,
  onApplyPatch,
  onPickOption,
  onExecuteApproved,
  onExecuteInsert,
  chatSending,
  onSend,
}: BubbleProps) {
  const { t } = useTranslation()
  const isUser = message.sender === 'USER'
  const time = new Date(message.created_at).toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div
        className={`shrink-0 mt-0.5 flex size-6 items-center justify-center rounded-full ${isUser ? colors.primary.bgSoft : 'bg-muted'
          }`}
      >
        {isUser ? (
          <User className={`size-3 ${colors.primary.text}`} />
        ) : (
          <Bot className="size-3 text-muted-foreground" />
        )}
      </div>

      {/* Bubble */}
      <div className={`max-w-[85%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1.5`}>
        <div className="flex items-center gap-1.5 px-1">
          <span className="text-[10px] font-semibold text-muted-foreground">
            {isUser
              ? t('content.aiScenario.senderUser', { defaultValue: 'Bạn' })
              : t('content.aiScenario.senderAi', { defaultValue: 'AI Đạo diễn' })}
          </span>
          <span className="text-[10px] text-muted-foreground/60">{time}</span>
        </div>

        {message.body ? (
          <div
            className={[
              'rounded-2xl px-3 py-2 text-xs leading-relaxed break-words',
              isUser
                ? `${colors.primary.bgSoft} ${colors.primary.text} rounded-tr-sm`
                : 'bg-card border border-border rounded-tl-sm',
            ].join(' ')}
          >
            <SafeMarkdown text={message.body} />
          </div>
        ) : (
          !isUser && !transient?.thinking && (
            <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground bg-muted/20 rounded-2xl border border-border">
              <span className="size-1.5 rounded-full bg-indigo-500 animate-pulse" />
              Đang kết nối tới Đạo diễn...
            </div>
          )
        )}

        {/* Render thinking stream */}
        {!isUser && transient?.thinking && (
          <div className="w-full text-[11px] italic text-muted-foreground/85 bg-muted/40 rounded-lg p-2 border border-dashed border-border leading-relaxed">
            <span className="font-semibold text-indigo-500/80 mr-1">🧠 Ý đồ đạo diễn:</span>
            {transient.thinking}
          </div>
        )}

        {/* Render artistic check scores (Review-on-the-fly) */}
        {(() => {
          const artisticChecks = transient?.artistic_checks || message.artistic_checks || []
          if (!artisticChecks || artisticChecks.length === 0) return null

          return (
            <div className="w-full mt-1 space-y-1.5 rounded-lg border border-violet-100 bg-violet-50/30 p-2 dark:border-violet-900/20 dark:bg-violet-950/10">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300 flex items-center gap-1">
                <Sparkles className="size-3 text-violet-600" />
                Đánh giá nghệ thuật (Review-on-the-fly)
              </div>
              <div className="grid grid-cols-1 gap-1.5 mt-1 sm:grid-cols-3">
                {artisticChecks.map((check, idx) => {
                  const checkScores = (check as any).scores
                  let rawScore = typeof check.score === 'number' ? check.score : 0
                  if (typeof check.score !== 'number' && checkScores && typeof checkScores === 'object') {
                    const values = Object.values(checkScores).map(Number).filter(v => !isNaN(v))
                    if (values.length > 0) {
                      rawScore = values.reduce((a, b) => a + b, 0) / values.length
                    }
                  }
                  const isGood = rawScore >= 4.0
                  const isAverage = rawScore >= 3.0
                  const pct = (rawScore / 5) * 100
                  const barColor = isGood ? 'bg-emerald-500' : isAverage ? 'bg-amber-500' : 'bg-red-500'
                  const textColor = isGood ? 'text-emerald-700 dark:text-emerald-400' : isAverage ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400'
                  const warnings = check.warnings || (check as any).issues || []

                  return (
                    <div key={idx} className="rounded border border-border bg-card p-1.5 text-[10px]">
                      <div className="flex justify-between items-center font-medium">
                        <span className="truncate max-w-[75%]">{check.reviewer}</span>
                        <span className={`font-mono font-bold ${textColor}`}>{rawScore.toFixed(1)}</span>
                      </div>
                      <div className="h-1 w-full bg-muted rounded-full overflow-hidden mt-1">
                        <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                      {warnings && warnings.length > 0 && (
                        <>
                          <div className="text-[9px] text-red-500 mt-1 space-y-0.5">
                            {warnings.map((w, wIdx) => (
                              <div key={wIdx} className="leading-tight">⚠️ {w}</div>
                            ))}
                          </div>
                          <button
                            disabled={chatSending}
                            onClick={() => {
                              const checkShot = (check as any).shot_id
                              const shots = checkShot ? `phân cảnh ${checkShot}` : 'các phân cảnh'
                              const msg = `Reviewer ${check.reviewer} cảnh báo ở ${shots}: "${warnings.join('; ')}". Hãy kiểm tra và đề xuất cách xử lý cụ thể.`
                              onSend(msg)
                            }}
                            className="mt-1.5 w-full flex items-center justify-center gap-1 rounded bg-violet-600/10 hover:bg-violet-600/20 text-violet-700 dark:text-violet-300 dark:bg-violet-500/10 dark:hover:bg-violet-500/20 px-2 py-0.5 text-[9px] font-medium transition active:scale-[0.98] disabled:opacity-50"
                          >
                            <Sparkles className="size-2.5 animate-pulse" />
                            AI kiểm tra & xử lý cảnh báo này
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}

        {/* Proposal / option cards (render cả live stream lẫn historical DB messages) */}
        {(() => {
          if (message.sender !== 'ASSISTANT') return null

          const dbActions = message.structured_actions || []

          // Trích xuất clarification nếu có
          const clarAct = dbActions.find((a: any) => a.kind === 'clarification') as any
          const clarificationQuestion = transient?.clarification_question || clarAct?.question || null

          // Trích xuất options nếu có
          const optAct = dbActions.find((a: any) => a.kind === 'options') as any
          const proposedOptions = transient?.proposed_options || (optAct ? {
            preamble: optAct.intro || '',
            options: (optAct.options || []).map((o: any) => ({ label: o.label || '', description: o.description || '' }))
          } : null)

          // Lọc các actions cấu trúc thực sự (loại bỏ clarification và options)
          const structuredActions = [
            ...(transient?.structured_actions || []),
            ...dbActions.filter((a: any) => a.kind !== 'clarification' && a.kind !== 'options')
          ]

          const attachedPatches = message.attached_patches || []

          const hasProposalContent =
            attachedPatches.length > 0 ||
            structuredActions.length > 0 ||
            !!clarificationQuestion ||
            (proposedOptions && proposedOptions.options.length > 0)

          if (!hasProposalContent) return null

          return (
            <ScenarioChatProposalCards
              scenarioId={scenarioId}
              attachedPatches={attachedPatches}
              structuredActions={structuredActions}
              proposedOptions={proposedOptions}
              clarificationQuestion={clarificationQuestion}
              onPickOption={onPickOption}
              onExecuteApproved={onExecuteApproved}
              onExecuteInsert={onExecuteInsert}
              onApplyPatch={onApplyPatch}
              messageId={message.id}
              resolvedActions={message.resolved_actions}
              chatSending={chatSending}
            />
          )
        })()}
      </div>
    </div>
  )
}



// ─── Empty state — showcase suggested prompts ────────────────────────────────

function EmptyChatState({ onPick }: { onPick: (s: string) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col items-center justify-center py-8 text-center">
      <div className="rounded-full bg-indigo-500/10 p-3 mb-3">
        <Sparkles className="size-6 text-indigo-600 dark:text-indigo-400" />
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        {t('content.aiScenario.emptyChatHint', { defaultValue: 'Bắt đầu refine kịch bản với AI Director' })}
      </p>
      <div className="flex flex-wrap justify-center gap-1.5 max-w-xs">
        {SUGGESTED_PROMPT_KEYS.slice(0, 4).map((k) => {
          const text = t(`content.aiScenario.${k}`)
          return (
            <button
              key={k}
              onClick={() => onPick(text)}
              className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground hover:border-indigo-400/60 hover:text-foreground transition"
            >
              {text}
            </button>
          )
        })}
      </div>
    </div>
  )
}


