import { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Smartphone, Loader2, AlertTriangle, StopCircle, Maximize, Minimize, MonitorOff, MonitorCheck } from 'lucide-react'
import { devicesApi } from '@/lib/api'

type StreamState = 'idle' | 'connecting' | 'waiting' | 'streaming' | 'error'

interface DeviceStreamProps {
  /** Device identifier (from Device.identifier field) */
  identifier: string
  /** Device ID used to send commands via the API */
  deviceId?: number
  /** Known device screen width (from API). Used to enforce correct aspect ratio and as coordinate fallback. */
  screenWidth?: number | null
  /** Known device screen height (from API). Used to enforce correct aspect ratio and as coordinate fallback. */
  screenHeight?: number | null
  onStop?: () => void
}

/** Derive the WebSocket base URL from VITE_API_URL (http→ws, https→wss). */
function getWsBase(): string {
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? ''
  if (apiUrl) {
    return apiUrl.replace(/^http/, 'ws')
  }
  // Same-origin fallback
  const loc = window.location
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}`
}

// ── scrcpy control-message encoding ──────────────────────────────────────────
//
// IMPORTANT: The binary layout MUST match what ScrcpyControlChannel.kt on the
// Android device expects.  The Android side reads:
//   - type, action, pointerId in BIG_ENDIAN
//   - x, y, videoWidth, videoHeight, pressure, scroll values in LITTLE_ENDIAN
//
// See mobilerun-portal-main/…/streaming/ScrcpyControlChannel.kt

const INJECT_TOUCH_EVENT = 0x02
const INJECT_SCROLL_EVENT = 0x03

/**
 * Encode a scrcpy INJECT_TOUCH_EVENT (type 0x02) as a 32-byte buffer.
 *
 * Android ScrcpyControlChannel.kt reads:
 *   [0]      type         uint8   0x02
 *   [1]      action       uint8   0=down 1=up 2=move
 *   [2–9]    pointerId    uint64  BIG_ENDIAN
 *   [10–13]  x            int32   LITTLE_ENDIAN
 *   [14–17]  y            int32   LITTLE_ENDIAN
 *   [18–19]  screenWidth  uint16  LITTLE_ENDIAN
 *   [20–21]  screenHeight uint16  LITTLE_ENDIAN
 *   [22–23]  pressure     uint16  LITTLE_ENDIAN  (0 = none, 0xFFFF = max)
 *   [24–27]  actionButton int32   LITTLE_ENDIAN  (0 = primary button)
 *   [28–31]  buttons      int32   LITTLE_ENDIAN  (0 = none)
 *
 * Total: 32 bytes (Android checks data.size < 32)
 */
function encodeTouchEvent(
  action: number,
  pointerId: number,
  x: number,
  y: number,
  screenWidth: number,
  screenHeight: number,
  pressure: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(32)
  const view = new DataView(buf)
  view.setUint8(0, INJECT_TOUCH_EVENT)
  view.setUint8(1, action)
  // pointerId as uint64 (BIG_ENDIAN)
  view.setUint32(2, 0, false)
  view.setUint32(6, pointerId, false)
  // x, y, screenWidth, screenHeight, pressure, actionButton in LITTLE_ENDIAN
  view.setInt32(10, Math.round(x), true)
  view.setInt32(14, Math.round(y), true)
  view.setUint16(18, screenWidth, true)
  view.setUint16(20, screenHeight, true)
  view.setUint16(22, Math.round(pressure * 0xffff), true)
  view.setInt32(24, 0, true) // actionButton = primary
  view.setInt32(28, 0, true) // buttons = none
  return buf
}

/**
 * Encode a scrcpy INJECT_SCROLL_EVENT (type 0x03) as a 21-byte buffer.
 *
 * Android ScrcpyControlChannel.kt reads:
 *   [0]      type         uint8   0x03
 *   [1–4]    x            int32   LITTLE_ENDIAN
 *   [5–8]    y            int32   LITTLE_ENDIAN
 *   [9–10]   screenWidth  uint16  LITTLE_ENDIAN
 *   [11–12]  screenHeight uint16  LITTLE_ENDIAN
 *   [13–14]  hScroll      int16   LITTLE_ENDIAN  (scroll units)
 *   [15–16]  vScroll      int16   LITTLE_ENDIAN  (scroll units)
 *   [17–20]  buttons      int32   LITTLE_ENDIAN  (0 = none)
 */
function encodeScrollEvent(
  x: number,
  y: number,
  screenWidth: number,
  screenHeight: number,
  hScroll: number,
  vScroll: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(21)
  const view = new DataView(buf)
  view.setUint8(0, INJECT_SCROLL_EVENT)
  view.setInt32(1, Math.round(x), true)
  view.setInt32(5, Math.round(y), true)
  view.setUint16(9, screenWidth, true)
  view.setUint16(11, screenHeight, true)
  view.setInt16(13, Math.round(hScroll), true)
  view.setInt16(15, Math.round(vScroll), true)
  view.setInt32(17, 0, true) // buttons = none
  return buf
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DeviceStream({ identifier, deviceId, screenWidth, screenHeight, onStop }: DeviceStreamProps) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([])
  const remoteDescSetRef = useRef(false)
  // Mirror of `state` accessible inside closures without causing stale captures.
  const stateRef = useRef<StreamState>('idle')
  // ICE servers may be updated by webrtc/rtcConfiguration messages from the server.
  const iceServersRef = useRef<RTCIceServer[]>([{ urls: 'stun:stun.l.google.com:19302' }])
  // Active pointer IDs for multi-touch tracking
  const activePointersRef = useRef<Map<number, number>>(new Map())
  // Keep a stable ref to onStop so callbacks never need it as a dependency.
  // Without this, a new onStop arrow function on every parent re-render would
  // cause startStream's useCallback to get a new reference, which in turn
  // re-fires the useEffect and restarts the whole WebSocket session on every
  // parent state change (e.g. while dragging the resize divider).
  const onStopRef = useRef(onStop)
  useEffect(() => {
    onStopRef.current = onStop
  }, [onStop])

  const [state, setState] = useState<StreamState>('idle')
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [screenOn, setScreenOn] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  function setStreamState(s: StreamState) {
    stateRef.current = s
    setState(s)
  }

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onmessage = null
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close()
      }
      wsRef.current = null
    }
    if (dcRef.current) {
      dcRef.current.onopen = null
      dcRef.current.onclose = null
      dcRef.current.onerror = null
      if (dcRef.current.readyState === 'open') {
        dcRef.current.close()
      }
      dcRef.current = null
    }
    if (pcRef.current) {
      pcRef.current.ontrack = null
      pcRef.current.onicecandidate = null
      pcRef.current.ondatachannel = null
      pcRef.current.onconnectionstatechange = null
      pcRef.current.close()
      pcRef.current = null
    }
    iceCandidateQueueRef.current = []
    remoteDescSetRef.current = false
    activePointersRef.current.clear()
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  const sendSignal = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  /**
   * Send a scrcpy binary control frame.
   * Preferred path: WebRTC DataChannel (low-latency, P2P/TURN).
   * Fallback path:  WebSocket relay through the server.
   */
  const sendControl = useCallback((buf: ArrayBuffer) => {
    const dc = dcRef.current
    const ws = wsRef.current
    if (dc?.readyState === 'open') {
      console.debug(`[sendControl] via DataChannel id=${dc.id} bytes=${buf.byteLength}`)
      dc.send(buf)
    } else if (ws?.readyState === WebSocket.OPEN) {
      console.debug(`[sendControl] via WebSocket fallback bytes=${buf.byteLength} (dc.readyState=${dc?.readyState ?? 'null'})`)
      ws.send(buf)
    } else {
      console.warn(`[sendControl] NO channel available — dc.readyState=${dc?.readyState ?? 'null'} ws.readyState=${ws?.readyState ?? 'null'}`)
    }
  }, [])

  /** Apply any queued ICE candidates after remote description is set. */
  const flushIceCandidates = useCallback(async () => {
    if (!pcRef.current || !remoteDescSetRef.current) return
    for (const candidate of iceCandidateQueueRef.current) {
      try {
        await pcRef.current.addIceCandidate(candidate)
      } catch (e) {
        console.warn('[DeviceStream] Failed to add queued ICE candidate', e)
      }
    }
    iceCandidateQueueRef.current = []
  }, [])

  /** Attach DataChannel event handlers (works for both created and received channels). */
  const attachDataChannel = useCallback((dc: RTCDataChannel, source: 'created' | 'ondatachannel') => {
    console.log(`[DeviceStream] attachDataChannel source=${source} label=${dc.label} id=${dc.id} readyState=${dc.readyState} negotiated=${dc.negotiated}`)
    dcRef.current = dc
    dc.binaryType = 'arraybuffer'
    dc.onopen = () => {
      console.log(`[DeviceStream] DataChannel "${dc.label}" opened (source=${source} id=${dc.id})`)
    }
    dc.onclose = () => {
      console.log(`[DeviceStream] DataChannel "${dc.label}" closed (source=${source} id=${dc.id})`)
    }
    dc.onerror = (e) => {
      console.warn(`[DeviceStream] DataChannel "${dc.label}" error (source=${source} id=${dc.id})`, e)
    }
    dc.onmessage = (e) => {
      const bytes = e.data instanceof ArrayBuffer ? e.data.byteLength : (e.data as Blob).size
      console.debug(`[DeviceStream] DataChannel message received bytes=${bytes}`)
    }
  }, [])

  const handleOffer = useCallback(
    async (sessionId: string, sdp: string) => {
      if (!wsRef.current) return

      const pc = new RTCPeerConnection({ iceServers: iceServersRef.current })
      pcRef.current = pc

      pc.ontrack = (event) => {
        if (videoRef.current && event.streams[0]) {
          videoRef.current.srcObject = event.streams[0]
          setStreamState('streaming')
        }
      }

      // ── DataChannel setup ──────────────────────────────────────────────────
      //
      // The Android device (WebRtcManager.kt) creates the control DataChannel
      // with `negotiated=true, id=1`.  This means the channel is NOT announced
      // via signaling (no `ondatachannel` event on the remote side).  Both sides
      // MUST independently create a DataChannel with the same `id` and
      // `negotiated=true` for them to connect.
      //
      // Therefore we create the DataChannel HERE, before setting the remote
      // description, so it is included in the initial SDP answer and matches
      // the device's channel.
      const dcInit: RTCDataChannelInit = {
        negotiated: true,
        id: 1,
      }
      const dc = pc.createDataChannel('control', dcInit)
      attachDataChannel(dc, 'created')

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal({
            method: 'webrtc/ice',
            params: {
              sessionId,
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
            },
          })
        }
      }

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          setStreamState('error')
          setErrorMsg('WebRTC connection failed')
        }
      }

      try {
        await pc.setRemoteDescription({ type: 'offer', sdp })
        remoteDescSetRef.current = true
        await flushIceCandidates()

        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        // Relay the SDP answer back to the device via the signaling server.
        // The device expects a 'webrtc/answer' message (not a simple ACK) because
        // it sent us its SDP offer and needs our answer to complete the negotiation.
        sendSignal({
          method: 'webrtc/answer',
          params: { sessionId, sdp: answer.sdp },
        })
      } catch (e) {
        console.error('[DeviceStream] Offer handling failed', e)
        setStreamState('error')
        setErrorMsg(e instanceof Error ? e.message : 'WebRTC negotiation failed')
      }
    },
    [sendSignal, flushIceCandidates, attachDataChannel],
  )

  const handleIce = useCallback(
    async (candidate: RTCIceCandidateInit) => {
      if (!pcRef.current) return
      if (remoteDescSetRef.current) {
        try {
          await pcRef.current.addIceCandidate(candidate)
        } catch (e) {
          console.warn('[DeviceStream] addIceCandidate error', e)
        }
      } else {
        iceCandidateQueueRef.current.push(candidate)
      }
    },
    [],
  )

  const startStream = useCallback(() => {
    cleanup()
    setStreamState('connecting')
    setErrorMsg('')

    const wsUrl = `${getWsBase()}/ws/viewer/${identifier}/`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setStreamState('waiting')
    }

    ws.onmessage = async (event) => {
      // Binary frame from device (e.g. reverse DataChannel data)
      if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
        return
      }

      let msg: { method?: string; params?: Record<string, unknown> }
      try {
        msg = JSON.parse(event.data as string)
      } catch {
        return
      }

      const { method, params = {} } = msg

      switch (method) {
        case 'webrtc/offer':
          await handleOffer(params.sessionId as string, params.sdp as string)
          break

        case 'webrtc/answer':
          // Device answered the browser's renegotiation offer (e.g. to open
          // a control DataChannel after the initial video-only connection).
          if (pcRef.current?.signalingState === 'have-local-offer') {
            try {
              await pcRef.current.setRemoteDescription({ type: 'answer', sdp: params.sdp as string })
              console.log('[DeviceStream] Applied renegotiation answer — DataChannel should open')
            } catch (e) {
              console.warn('[DeviceStream] Failed to apply renegotiation answer', e)
            }
          }
          break

        case 'webrtc/ice':
          await handleIce({
            candidate: params.candidate as string,
            sdpMid: params.sdpMid as string,
            sdpMLineIndex: params.sdpMLineIndex as number,
          })
          break

        case 'webrtc/rtcConfiguration': {
          // Server sent updated ICE configuration (e.g. TURN credentials).
          const rtcConfig = params.rtcConfiguration as { iceServers?: RTCIceServer[] } | undefined
          if (rtcConfig?.iceServers) {
            iceServersRef.current = rtcConfig.iceServers
            // Apply to existing PeerConnection if possible.
            pcRef.current?.setConfiguration({ iceServers: rtcConfig.iceServers })
          }
          break
        }

        case 'stream/stopped':
        case 'device/offline':
          cleanup()
          setStreamState('idle')
          onStopRef.current?.()
          break

        case 'stream/error':
          setErrorMsg((params.message as string | undefined) ?? 'Stream error from device')
          setStreamState('error')
          break

        default:
          break
      }
    }

    ws.onerror = () => {
      setStreamState('error')
      setErrorMsg('WebSocket connection error')
    }

    ws.onclose = (event) => {
      // 4000/4001/4003 = rejected by server — do not attempt reconnect
      if (event.code === 4000 || event.code === 4001 || event.code === 4003) {
        setStreamState('error')
        setErrorMsg(`Connection rejected (${event.code})`)
        return
      }
      // Only reset to idle if we haven't already transitioned to a terminal state
      if (stateRef.current !== 'error') {
        setStreamState('idle')
      }
    }
  }, [identifier, cleanup, handleOffer, handleIce])

  const stopStream = useCallback(() => {
    cleanup()
    setStreamState('idle')
    onStopRef.current?.()
  }, [cleanup])

  // ── Touch / pointer event handlers ────────────────────────────────────────

  const getScaledCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number; w: number; h: number } | null => {
      const video = videoRef.current
      if (!video) return null
      const rect = video.getBoundingClientRect()
      // Rendered dimensions of the video element
      const renderedW = rect.width
      const renderedH = rect.height
      if (renderedW === 0 || renderedH === 0) return null
      // Natural resolution: prefer the live video dimensions, then the known
      // device screen size (from the API), and finally fall back to the rendered
      // element size so that coordinate mapping is always based on the real
      // device resolution rather than the arbitrary container size.
      const naturalW = video.videoWidth || (screenWidth ?? renderedW)
      const naturalH = video.videoHeight || (screenHeight ?? renderedH)

      // The video uses object-contain, so the actual content area may be smaller
      // than the element (letterbox bars on top/bottom or left/right).
      // Calculate the content display area to get the correct coordinate offset.
      const contentAspect = naturalW / naturalH
      const elementAspect = renderedW / renderedH

      let contentDisplayW: number
      let contentDisplayH: number
      let offsetX: number
      let offsetY: number

      if (contentAspect > elementAspect) {
        // Content is wider than the element — black bars on top and bottom
        contentDisplayW = renderedW
        contentDisplayH = renderedW / contentAspect
        offsetX = 0
        offsetY = (renderedH - contentDisplayH) / 2
      } else {
        // Content is taller than the element — black bars on left and right
        contentDisplayH = renderedH
        contentDisplayW = renderedH * contentAspect
        offsetX = (renderedW - contentDisplayW) / 2
        offsetY = 0
      }

      // Click position relative to the content area (excluding letterbox)
      const relX = clientX - rect.left - offsetX
      const relY = clientY - rect.top - offsetY

      // Clicks in the letterbox region map to nothing on the device
      if (relX < 0 || relX > contentDisplayW || relY < 0 || relY > contentDisplayH) return null

      // Scale from content-display coordinates → device screen coordinates
      return {
        x: (relX / contentDisplayW) * naturalW,
        y: (relY / contentDisplayH) * naturalH,
        w: naturalW,
        h: naturalH,
      }
    },
    [screenWidth, screenHeight],
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLVideoElement>) => {
      if (stateRef.current !== 'streaming') {
        console.debug(`[DeviceStream] pointerDown ignored — state=${stateRef.current}`)
        return
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      const coords = getScaledCoords(e.clientX, e.clientY)
      if (!coords) {
        console.warn('[DeviceStream] pointerDown — getScaledCoords returned null (video not ready?)')
        return
      }
      console.debug(`[DeviceStream] pointerDown pointerId=${e.pointerId} x=${coords.x.toFixed(0)} y=${coords.y.toFixed(0)} screen=${coords.w}x${coords.h} pressure=${e.pressure}`)
      activePointersRef.current.set(e.pointerId, e.pointerId)
      sendControl(encodeTouchEvent(0, e.pointerId, coords.x, coords.y, coords.w, coords.h, e.pressure))
    },
    [getScaledCoords, sendControl],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLVideoElement>) => {
      if (stateRef.current !== 'streaming') return
      if (!activePointersRef.current.has(e.pointerId)) return
      const coords = getScaledCoords(e.clientX, e.clientY)
      if (!coords) return
      sendControl(encodeTouchEvent(2, e.pointerId, coords.x, coords.y, coords.w, coords.h, e.pressure))
    },
    [getScaledCoords, sendControl],
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLVideoElement>) => {
      if (stateRef.current !== 'streaming') return
      activePointersRef.current.delete(e.pointerId)
      const coords = getScaledCoords(e.clientX, e.clientY)
      if (!coords) return
      sendControl(encodeTouchEvent(1, e.pointerId, coords.x, coords.y, coords.w, coords.h, 0))
    },
    [getScaledCoords, sendControl],
  )

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (stateRef.current !== 'streaming') return
      e.preventDefault()
      const coords = getScaledCoords(e.clientX, e.clientY)
      if (!coords) return
      // Normalise browser delta (typically ±120 per notch) to scroll units.
      const hScroll = -Math.round(e.deltaX / 120)
      const vScroll = -Math.round(e.deltaY / 120)
      if (hScroll === 0 && vScroll === 0) return
      sendControl(encodeScrollEvent(coords.x, coords.y, coords.w, coords.h, hScroll, vScroll))
    },
    [getScaledCoords, sendControl],
  )

  // Attach a non-passive wheel listener so that preventDefault() works.
  // React's synthetic onWheel is passive by default (since React 17), which
  // prevents calling preventDefault() and causes a browser warning.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      video.removeEventListener('wheel', handleWheel)
    }
  }, [handleWheel])

  // Auto-start / restart when the device identifier changes.
  // Also close the WebSocket when the user closes the tab or navigates away from
  // the page entirely (pagehide), so the server's disconnect handler sends
  // stream/stop to the device.
  useEffect(() => {
    startStream()

    const handlePageHide = () => cleanup()
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      cleanup()
    }
  }, [identifier, startStream, cleanup])

  // Track fullscreen state changes (e.g. user pressing Escape)
  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  function handleToggleFullscreen() {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }

  async function handleToggleScreen() {
    if (!deviceId) return
    const nextState = !screenOn
    const action = nextState ? 'screen_on' : 'screen_off'
    try {
      await devicesApi.sendCommand(deviceId, action)
      setScreenOn(nextState)
    } catch (e) {
      console.warn('[DeviceStream] Failed to send screen toggle command', e)
    }
  }

  return (
    <div className="relative flex h-full w-full flex-row overflow-hidden bg-black">
      {/* Phone screen area */}
      <div ref={containerRef} className="relative flex flex-1 flex-col items-center justify-center overflow-hidden">
      {/* Video element — always mounted, visible only when streaming */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`max-h-full max-w-full object-contain ${state === 'streaming' ? 'block' : 'hidden'}`}
        style={{
          touchAction: 'none',
          cursor: 'crosshair',
          // When the device's screen dimensions are known, enforce the correct
          // aspect ratio so the video is displayed proportionally even before
          // the WebRTC stream reports its natural size.
          ...(screenWidth && screenHeight
            ? { aspectRatio: `${screenWidth} / ${screenHeight}` }
            : {}),
        }}
        role="application"
        aria-label={t('playground.streamControlSurface', 'Device screen — touch or click to interact')}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />

      {/* Overlay states */}
      {state === 'connecting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white">
          <Loader2 className="size-10 animate-spin opacity-70" />
          <p className="text-sm opacity-70">{t('playground.streamConnecting')}</p>
        </div>
      )}

      {state === 'waiting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white">
          <Smartphone className="size-12 opacity-40" strokeWidth={1} />
          <p className="text-sm opacity-70">{t('playground.streamWaiting')}</p>
        </div>
      )}

      {state === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-white">
          <AlertTriangle className="size-10 text-destructive opacity-80" />
          <p className="text-sm font-medium text-destructive">{t('playground.streamError')}</p>
          {errorMsg && <p className="text-xs opacity-60">{errorMsg}</p>}
          <button
            onClick={startStream}
            className="mt-2 rounded-lg bg-white/10 px-4 py-2 text-xs font-medium hover:bg-white/20"
          >
            {t('playground.streamStart')}
          </button>
        </div>
      )}

      </div>

      {/* Right side panel — fullscreen + screen toggle buttons */}
      {deviceId && (
        <div className="flex w-12 shrink-0 flex-col items-center justify-center gap-3 bg-white py-4 shadow-md">
          {/* Fullscreen toggle — shown only when streaming */}
          {state === 'streaming' && (
            <button
              onClick={handleToggleFullscreen}
              title={isFullscreen ? t('playground.streamExitFullscreen') : t('playground.streamFullscreen')}
              className="flex flex-col items-center gap-1 rounded-lg p-2 text-gray-700 transition-colors hover:bg-gray-100"
            >
              {isFullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
            </button>
          )}

          {/* Screen toggle */}
          <button
            onClick={handleToggleScreen}
            title={screenOn ? t('playground.screenTurnOff') : t('playground.screenTurnOn')}
            className={`flex flex-col items-center gap-1 rounded-lg p-2 transition-colors ${
              screenOn ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-100'
            }`}
          >
            {screenOn ? (
              <MonitorCheck className="size-5" />
            ) : (
              <MonitorOff className="size-5" />
            )}
          </button>

          {/* Stop stream — shown only when streaming */}
          {state === 'streaming' && (
            <button
              onClick={stopStream}
              title={t('playground.streamStop')}
              className="flex flex-col items-center gap-1 rounded-lg p-2 text-red-500 transition-colors hover:bg-gray-100"
            >
              <StopCircle className="size-5" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
