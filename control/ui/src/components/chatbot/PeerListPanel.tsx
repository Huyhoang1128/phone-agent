/**
 * Left panel — list peer (conversation) của 1 device. Click 1 peer → callback
 * `onSelect(peer_handle)`.
 *
 * MVP: chưa virtual scroll (tin rằng < 500 peers). Phase L có thể đưa
 * `react-window` nếu thấy chậm.
 */
import { cn } from '@/lib/utils'
import { Loader2, RefreshCcw } from 'lucide-react'
import type { TiktokConversationItem } from '@/lib/types'

function relativeTime(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime()
    const min = Math.floor(ms / 60000)
    if (min < 1) return 'vừa xong'
    if (min < 60) return `${min}p`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}h`
    const day = Math.floor(hr / 24)
    if (day < 7) return `${day}d`
    return new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
  } catch { return iso }
}

export interface PeerListPanelProps {
  conversations: TiktokConversationItem[]
  selectedPeerHandle: string | null
  onSelect: (peerHandle: string) => void
  isLoading: boolean
  isRefetching?: boolean
  onRefresh?: () => void
  emptyHint?: string
}

export function PeerListPanel({
  conversations,
  selectedPeerHandle,
  onSelect,
  isLoading,
  isRefetching,
  onRefresh,
  emptyHint = 'Chưa có cuộc trò chuyện nào.',
}: PeerListPanelProps) {
  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">Cuộc trò chuyện ({conversations.length})</span>
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={isRefetching}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
            title="Refresh"
          >
            {isRefetching
              ? <Loader2 className="size-4 animate-spin" />
              : <RefreshCcw className="size-4" />}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          Đang tải...
        </div>
      ) : conversations.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
          {emptyHint}
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {conversations.map((conv) => {
            const selected = conv.peer_handle === selectedPeerHandle
            return (
              <li key={conv.peer_handle}>
                <button
                  onClick={() => onSelect(conv.peer_handle)}
                  className={cn(
                    'flex w-full items-start gap-2 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
                    selected && 'bg-muted',
                  )}
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                    {conv.peer_handle.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">{conv.peer_handle}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {relativeTime(conv.last_message_at)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      {conv.is_muted && <span title="AI đang tạm dừng">⏸</span>}
                      <span className="truncate">
                        {conv.last_message_type === 'bot' && '↩ '}
                        {conv.last_message_content || '(no content)'}
                      </span>
                    </div>
                  </div>
                  {conv.message_count > 1 && (
                    <span className="ml-1 shrink-0 rounded-full bg-muted-foreground/20 px-1.5 text-[10px] font-medium">
                      {conv.message_count}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
