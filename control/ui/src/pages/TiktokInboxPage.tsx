/**
 * TikTok Inbox (Phase 2.3.5) — top-level page.
 *
 * Layout 2-pane:
 *   Sidebar device picker → PeerListPanel → ChatDetailPanel
 *
 * State management:
 * - `selectedDeviceId` — query param `?device=X` để share link.
 * - `selectedPeerHandle` — query param `?peer=Y`.
 * - Conversations + messages dùng react-query với staleTime ngắn.
 * - WS subscribe via `useTiktokInboxWs` → merge realtime event vào cache.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCcw } from 'lucide-react'

import { devicesApi, tiktokInboxApi } from '@/lib/api'
import type {
  Device,
  TiktokConversationItem,
  TiktokConversationDetail,
  TiktokMessagesPage,
  TiktokInboxWsEvent,
  TiktokInboxMessage,
} from '@/lib/types'
import { PeerListPanel } from '@/components/chatbot/PeerListPanel'
import { ChatDetailPanel } from '@/components/chatbot/ChatDetailPanel'
import { useTiktokInboxWs } from '@/components/chatbot/useTiktokInboxWs'

export default function TiktokInboxPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const qc = useQueryClient()

  const deviceIdParam = searchParams.get('device')
  const peerHandleParam = searchParams.get('peer')

  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(
    deviceIdParam ? Number(deviceIdParam) : null,
  )
  const [selectedPeerHandle, setSelectedPeerHandle] = useState<string | null>(peerHandleParam)

  // ── Device list ───────────────────────────────────────────────────────────
  const devicesQuery = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list(),
  })

  // Auto-pick device đầu tiên nếu chưa chọn.
  useEffect(() => {
    if (selectedDeviceId == null && devicesQuery.data && devicesQuery.data.length > 0) {
      const first = devicesQuery.data[0]
      setSelectedDeviceId(first.id)
      const sp = new URLSearchParams(searchParams)
      sp.set('device', String(first.id))
      setSearchParams(sp, { replace: true })
    }
  }, [devicesQuery.data, selectedDeviceId, searchParams, setSearchParams])

  // ── Conversations list ───────────────────────────────────────────────────
  const convQuery = useQuery({
    queryKey: ['tiktok-conversations', selectedDeviceId],
    queryFn: () => tiktokInboxApi.listConversations(selectedDeviceId!),
    enabled: selectedDeviceId != null,
    staleTime: 30_000,
  })

  // ── Conversation detail (khi chọn peer) ──────────────────────────────────
  const detailQuery = useQuery<TiktokConversationDetail>({
    queryKey: ['tiktok-conv-detail', selectedDeviceId, selectedPeerHandle],
    queryFn: () => tiktokInboxApi.getConversationDetail(selectedDeviceId!, selectedPeerHandle!),
    enabled: selectedDeviceId != null && Boolean(selectedPeerHandle),
  })

  // ── Messages (paginated) ─────────────────────────────────────────────────
  const messagesQuery = useQuery<TiktokMessagesPage>({
    queryKey: ['tiktok-conv-messages', selectedDeviceId, selectedPeerHandle],
    queryFn: () => tiktokInboxApi.listMessages(selectedDeviceId!, selectedPeerHandle!, { limit: 50 }),
    enabled: selectedDeviceId != null && Boolean(selectedPeerHandle),
  })

  // Local state cho messages — accumulate khi load more + insert realtime.
  const [messagesAcc, setMessagesAcc] = useState<TiktokInboxMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  // Reset accumulator khi đổi peer.
  useEffect(() => {
    setMessagesAcc([])
    setHasMore(false)
    setNextBefore(null)
  }, [selectedDeviceId, selectedPeerHandle])

  // Khi messagesQuery data về (page đầu), set accumulator.
  useEffect(() => {
    const page = messagesQuery.data
    if (!page) return
    // Page về DESC (newest first). FE muốn render bottom-up ASC: reverse.
    setMessagesAcc([...page.messages].reverse())
    setHasMore(page.has_more)
    setNextBefore(page.next_before)
  }, [messagesQuery.data])

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore || nextBefore == null) return
    if (selectedDeviceId == null || !selectedPeerHandle) return
    setIsLoadingMore(true)
    try {
      const page = await tiktokInboxApi.listMessages(selectedDeviceId, selectedPeerHandle, {
        limit: 50, before: nextBefore,
      })
      // Prepend older messages (DESC từ API → reverse → ASC) vào đầu list.
      setMessagesAcc((prev) => [...[...page.messages].reverse(), ...prev])
      setHasMore(page.has_more)
      setNextBefore(page.next_before)
    } finally {
      setIsLoadingMore(false)
    }
  }, [hasMore, isLoadingMore, nextBefore, selectedDeviceId, selectedPeerHandle])

  // ── WebSocket: realtime events ───────────────────────────────────────────
  const onWsEvent = useCallback((event: TiktokInboxWsEvent) => {
    if (event.event_type === 'message.created') {
      const { device_id, peer_handle, message } = event.payload
      // Invalidate conversation list cho device để refresh last_message_at.
      qc.invalidateQueries({ queryKey: ['tiktok-conversations', device_id] })

      // Nếu message thuộc peer đang chọn → append vào accumulator (nếu chưa có).
      if (device_id === selectedDeviceId && peer_handle === selectedPeerHandle) {
        setMessagesAcc((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev
          return [...prev, message]
        })
      }
    } else if (event.event_type === 'peer_mute.changed') {
      qc.invalidateQueries({ queryKey: ['tiktok-conversations', event.payload.device_id] })
      if (event.payload.device_id === selectedDeviceId
          && event.payload.peer_handle === selectedPeerHandle) {
        qc.invalidateQueries({ queryKey: ['tiktok-conv-detail', selectedDeviceId, selectedPeerHandle] })
      }
    }
  }, [qc, selectedDeviceId, selectedPeerHandle])

  const ws = useTiktokInboxWs(selectedDeviceId, onWsEvent)

  // ── Handlers ─────────────────────────────────────────────────────────────
  function handleSelectPeer(peer: string) {
    setSelectedPeerHandle(peer)
    const sp = new URLSearchParams(searchParams)
    sp.set('peer', peer)
    setSearchParams(sp, { replace: true })
  }

  function handleSelectDevice(id: number) {
    setSelectedDeviceId(id)
    setSelectedPeerHandle(null)
    const sp = new URLSearchParams(searchParams)
    sp.set('device', String(id))
    sp.delete('peer')
    setSearchParams(sp, { replace: true })
  }

  // ── Render ───────────────────────────────────────────────────────────────
  const conversations: TiktokConversationItem[] = convQuery.data?.conversations ?? []
  const currentDevice = useMemo(
    () => devicesQuery.data?.find((d) => d.id === selectedDeviceId) ?? null,
    [devicesQuery.data, selectedDeviceId],
  )

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <h1 className="text-lg font-semibold">{t('nav.tiktokInbox')}</h1>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Thiết bị:</label>
          <select
            value={selectedDeviceId ?? ''}
            onChange={(e) => handleSelectDevice(Number(e.target.value))}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          >
            {devicesQuery.data?.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          {currentDevice && (
            <span className="text-xs text-muted-foreground">
              · ws: <span className={ws.status === 'open' ? 'text-green-600' : 'text-yellow-600'}>{ws.status}</span>
            </span>
          )}
          <button
            onClick={() => ws.reconnect()}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            title="Reconnect WebSocket"
          >
            <RefreshCcw className="size-4" />
          </button>
        </div>
        {convQuery.isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Two-pane body */}
      <div className="flex flex-1 overflow-hidden">
        <PeerListPanel
          conversations={conversations}
          selectedPeerHandle={selectedPeerHandle}
          onSelect={handleSelectPeer}
          isLoading={convQuery.isLoading}
          isRefetching={convQuery.isFetching && !convQuery.isLoading}
          onRefresh={() => convQuery.refetch()}
        />
        <ChatDetailPanel
          detail={detailQuery.data ?? null}
          isDetailLoading={detailQuery.isLoading}
          messages={messagesAcc}
          isMessagesLoading={messagesQuery.isLoading}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMore}
        />
      </div>
    </div>
  )
}
