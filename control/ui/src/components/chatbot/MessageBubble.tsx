/**
 * 1 bubble tin nhắn — render trái (user) hoặc phải (bot).
 *
 * Color scheme đơn giản: bot màu primary, user màu muted, system màu warning.
 * Hiển thị timestamp + source badge ngắn ([NOTI] / [SENT] / [OBS]).
 */
import { cn } from '@/lib/utils'
import type { TiktokInboxMessage } from '@/lib/types'

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
  } catch {
    return iso
  }
}

function sourceBadge(src: TiktokInboxMessage['source']): string {
  switch (src) {
    case 'notification': return 'NOTI'
    case 'agent_observed': return 'OBS'
    case 'agent_sent': return 'SENT'
    default: return src
  }
}

export interface MessageBubbleProps {
  message: TiktokInboxMessage
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isBot = message.message_type === 'bot'
  const isSystem = message.message_type === 'system'

  return (
    <div className={cn('flex w-full', isBot ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm',
          isBot && 'bg-primary text-primary-foreground rounded-br-sm',
          !isBot && !isSystem && 'bg-muted text-foreground rounded-bl-sm',
          isSystem && 'bg-yellow-100 text-yellow-900 rounded-bl-sm dark:bg-yellow-900/30 dark:text-yellow-100',
        )}
      >
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
        <div className={cn(
          'mt-1 flex items-center gap-1 text-[10px] opacity-70',
          isBot ? 'justify-end' : 'justify-start',
        )}>
          {message.is_preview && <span>preview · </span>}
          <span>{sourceBadge(message.source)}</span>
          <span>·</span>
          <span>{formatTime(message.created_at)}</span>
        </div>
      </div>
    </div>
  )
}
