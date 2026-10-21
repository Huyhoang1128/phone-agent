/**
 * Right panel — chat detail của 1 peer đã chọn.
 *
 * Render: ChatHeader (peer info + pause button) + scrollable message list
 * (load thêm khi scroll lên đầu) + footer info (chỉ read-only — user KHÔNG gõ
 * tin trực tiếp; muốn gửi thì pause AI rồi gõ trên phone).
 *
 * Realtime: parent đã merge WS events vào `messages` prop. Component auto
 * scroll xuống đáy khi list dài thêm (chỉ nếu user đang ở cuối, tránh giật).
 */
import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { ChatHeader } from './ChatHeader'
import { MessageBubble } from './MessageBubble'
import type { TiktokConversationDetail, TiktokInboxMessage } from '@/lib/types'

export interface ChatDetailPanelProps {
  detail: TiktokConversationDetail | null
  isDetailLoading: boolean
  messages: TiktokInboxMessage[]
  isMessagesLoading: boolean
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void
}

export function ChatDetailPanel({
  detail,
  isDetailLoading,
  messages,
  isMessagesLoading,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: ChatDetailPanelProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const lastMessageIdRef = useRef<number | null>(null)

  // Auto-scroll xuống đáy KHI có message mới VÀ user đang ở gần đáy.
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last) return
    const prev = lastMessageIdRef.current
    lastMessageIdRef.current = last.id
    if (prev == null) {
      // Lần load đầu — jump xuống đáy ngay.
      const el = scrollerRef.current
      if (el) el.scrollTop = el.scrollHeight
      return
    }
    if (last.id === prev) return
    const el = scrollerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 120) {
      // User đang ở gần đáy → auto-scroll. Nếu user đang đọc tin cũ thì không
      // làm phiền.
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  if (!detail && !isDetailLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background text-sm text-muted-foreground">
        Chọn 1 cuộc trò chuyện ở danh sách bên trái.
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col bg-background">
      <ChatHeader detail={detail} isLoading={isDetailLoading} />

      <div ref={scrollerRef} className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        {hasMore && (
          <div className="flex justify-center pb-1">
            <button
              onClick={onLoadMore}
              disabled={isLoadingMore}
              className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              {isLoadingMore
                ? (<><Loader2 className="mr-1 inline size-3 animate-spin" /> Đang tải...</>)
                : 'Tải thêm tin cũ hơn'}
            </button>
          </div>
        )}

        {isMessagesLoading && messages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Đang tải tin nhắn...
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Chưa có tin nhắn.
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        Bot tự reply — KHÔNG gõ tin trực tiếp ở đây. Muốn xử lý tay → Tạm dừng AI rồi mở app TikTok trên điện thoại.
      </div>
    </div>
  )
}
