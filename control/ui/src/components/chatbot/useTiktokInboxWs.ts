/**
 * WS hook subscribe `/ws/tiktok-inbox/{deviceId}/?token=<jwt>` (Phase 2.3.4 BE).
 *
 * Khi nhận event, gọi handler tương ứng. Pattern follow
 * `TaskDetailPage.tsx:connectTaskWebSocket`.
 *
 * Reconnect: KHÔNG auto-reconnect aggressive (sẽ làm overwhelm khi backend
 * restart). Component caller có thể trigger reconnect bằng cách đổi deviceId
 * hoặc invoke `reconnect()`. Khi tab inactive → browser tự pause/close, mở
 * lại sẽ re-effect.
 */
import { useEffect, useRef, useState } from 'react'
import type { TiktokInboxWsEvent } from '@/lib/types'

type Handler = (event: TiktokInboxWsEvent) => void

export function useTiktokInboxWs(
  deviceId: number | null,
  onEvent: Handler,
): { status: 'idle' | 'connecting' | 'open' | 'closed' | 'error'; reconnect: () => void } {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'open' | 'closed' | 'error'>('idle')
  const wsRef = useRef<WebSocket | null>(null)
  const handlerRef = useRef<Handler>(onEvent)
  // Keep handler ref fresh tránh effect re-run mỗi render khi caller dùng closure mới.
  handlerRef.current = onEvent

  const [reconnectToken, setReconnectToken] = useState(0)
  const reconnect = () => setReconnectToken((n) => n + 1)

  useEffect(() => {
    if (deviceId == null) return

    const token = localStorage.getItem('access_token') ?? ''
    if (!token) {
      setStatus('error')
      return
    }
    const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? ''
    const wsBase = apiUrl
      ? apiUrl.replace(/^http/, 'ws')
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
    const url = `${wsBase}/ws/tiktok-inbox/${deviceId}/?token=${encodeURIComponent(token)}`

    setStatus('connecting')
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => setStatus('open')
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as TiktokInboxWsEvent
        handlerRef.current(event)
      } catch (err) {
        // Malformed payload — ignore (consumer luôn JSON encode).
        console.warn('[useTiktokInboxWs] bad payload:', e.data, err)
      }
    }
    ws.onerror = () => setStatus('error')
    ws.onclose = () => {
      wsRef.current = null
      setStatus('closed')
    }

    return () => {
      try { ws.close() } catch { /* noop */ }
      wsRef.current = null
    }
  }, [deviceId, reconnectToken])

  return { status, reconnect }
}
