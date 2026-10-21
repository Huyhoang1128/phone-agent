import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Settings,
  Camera,
  Music,
  AtSign,
  UsersRound,
  ChevronUp,
  ChevronDown,
  Plus,
  BookOpen,
  Smartphone,
  Play,
  Pause,
  GripVertical,
  Loader2,
  SlidersHorizontal,
  MonitorSmartphone,
  CheckCircle2,
  Clock,
} from 'lucide-react'
import { agentGroupsApi, devicesApi, tasksApi } from '@/lib/api'
import type { AgentGroup, Device, Task, TaskEvent } from '@/lib/types'
import DeviceStream from '@/components/DeviceStream'
import { useToast } from '@/context/ToastContext'

type AgentId = 'default' | 'instagram' | 'tiktok' | 'x' | 'facebook'

interface Agent {
  id: AgentId
  nameKey: string
  descKey: string
  Icon: React.ElementType
}

const AGENTS: Agent[] = [
  { id: 'default', nameKey: 'playground.agentDefault', descKey: 'playground.agentDefaultDesc', Icon: Settings },
  { id: 'instagram', nameKey: 'playground.agentInstagram', descKey: 'playground.agentInstagramDesc', Icon: Camera },
  { id: 'tiktok', nameKey: 'playground.agentTiktok', descKey: 'playground.agentTiktokDesc', Icon: Music },
  { id: 'x', nameKey: 'playground.agentX', descKey: 'playground.agentXDesc', Icon: AtSign },
  { id: 'facebook', nameKey: 'playground.agentFacebook', descKey: 'playground.agentFacebookDesc', Icon: UsersRound },
]

export default function PlaygroundPage() {
  const { t } = useTranslation()
  const { showToast } = useToast()
  const [task, setTask] = useState('')
  const [selectedAgent, setSelectedAgent] = useState<AgentId>('default')
  const [platformOpen, setPlatformOpen] = useState(true)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [selectedDevice, setSelectedDevice] = useState<string>('')
  const [useProfile, setUseProfile] = useState(false)
  const [selectedProfileId, setSelectedProfileId] = useState<string>('')
  const [sendToGroup, setSendToGroup] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState<string>('')
  const [streamMode, setStreamMode] = useState<'events' | 'device'>('events')
  const [streamingIdentifier, setStreamingIdentifier] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [runningTask, setRunningTask] = useState<Task | null>(null)
  const [taskEvents, setTaskEvents] = useState<TaskEvent[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const eventsEndRef = useRef<HTMLDivElement>(null)

  // Mobile tab: 'config' shows the left config panel, 'stream' shows the right panel
  const [mobileTab, setMobileTab] = useState<'config' | 'stream'>('config')

  // Resizable right panel
  const MIN_RIGHT_WIDTH = 300
  const MAX_RIGHT_WIDTH = 800
  const DEFAULT_RIGHT_WIDTH = 380
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const rightPanelRef = useRef<HTMLDivElement>(null)
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : false
  )

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Apply dynamic width on desktop only
  useEffect(() => {
    if (!rightPanelRef.current) return
    if (isDesktop) {
      rightPanelRef.current.style.width = `${rightWidth}px`
    } else {
      rightPanelRef.current.style.width = ''
    }
  }, [rightWidth, isDesktop])

  // Auto-scroll event log to bottom when new events arrive
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [taskEvents])

  // Open a WebSocket to stream live task events
  function connectTaskWebSocket(taskId: number) {
    // Close any existing connection
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    const token = localStorage.getItem('access_token') ?? ''
    const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? ''
    const wsBase = apiUrl ? apiUrl.replace(/^http/, 'ws') : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
    const url = `${wsBase}/ws/task/${taskId}/?token=${encodeURIComponent(token)}`

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as TaskEvent
        setTaskEvents((prev) => [...prev, event])
      } catch {
        // ignore malformed messages
      }
    }

    ws.onerror = () => {
      // silently ignore — task events still persist in DB
    }

    ws.onclose = () => {
      wsRef.current = null
    }
  }

  // Disconnect WebSocket on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close()
    }
  }, [])

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    dragStartX.current = e.clientX
    dragStartWidth.current = rightWidth
    e.preventDefault()

    const onMouseMove = (ev: MouseEvent) => {
      const delta = dragStartX.current - ev.clientX
      const newWidth = Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, dragStartWidth.current + delta))
      setRightWidth(newWidth)
    }
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [rightWidth])

  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list(),
  })

  const { data: groups = [] } = useQuery<AgentGroup[]>({
    queryKey: ['agent-groups'],
    queryFn: agentGroupsApi.list,
  })

  async function handleRun() {
    const trimmed = task.trim()
    if (!trimmed) return

    setIsRunning(true)
    setRunError(null)
    setRunningTask(null)

    try {
      const name = trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed
      const created = await tasksApi.create({
        name,
        description: trimmed,
        task_type: 'generic',
        status: 'pending',
        payload: { agent: selectedAgent },
      })

      let deviceIds: number[] = []
      if (sendToGroup && selectedGroupId) {
        const group = groups.find((g) => String(g.id) === selectedGroupId)
        if (group) {
          deviceIds = group.members
            .filter((m) => m.device_status === 'online' || m.device_status === 'connected')
            .map((m) => m.device)
        }
        if (deviceIds.length === 0) {
          setRunError(t('playground.noAvailableDevicesInGroup'))
          setIsRunning(false)
          return
        }
      } else {
        deviceIds = selectedDevice ? [Number(selectedDevice)] : []
      }

      const profileId = useProfile && selectedProfileId ? Number(selectedProfileId) : null
      const running = await tasksApi.run(created.id, deviceIds, profileId)
      setRunningTask(running)
      setTaskEvents([])
      connectTaskWebSocket(running.id)
      if (sendToGroup && deviceIds.length > 0) {
        showToast(t('playground.taskStartedGroup', { count: deviceIds.length }), 'success')
      } else {
        showToast(t('playground.taskStarted'), 'success')
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsRunning(false)
    }
  }

  async function handlePause() {
    if (!runningTask) return
    try {
      await tasksApi.stop(runningTask.id)
      wsRef.current?.close()
      setRunningTask(null)
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
    }
  }

  function handleReset() {
    setTask('')
    setSelectedAgent('default')
    setSelectedDevice('')
    setUseProfile(false)
    setSelectedProfileId('')
    setSendToGroup(false)
    setSelectedGroupId('')
    setStreamingIdentifier(null)
    setRunError(null)
    setRunningTask(null)
    setTaskEvents([])
    wsRef.current?.close()
  }

  function handleToggleDeviceStream() {
    if (streamingIdentifier) {
      // Stop stream
      setStreamingIdentifier(null)
    } else {
      // Start stream — look up the device's identifier field
      const device = devices.find((d) => String(d.id) === selectedDevice)
      if (device?.identifier) {
        setStreamingIdentifier(device.identifier)
      }
    }
  }

  // Stable callback so DeviceStream never sees a new onStop reference on
  // parent re-renders (e.g. while dragging the resize divider).
  const handleStreamStop = useCallback(() => setStreamingIdentifier(null), [])

  // Selected device object
  const selectedDeviceObj = devices.find((d) => String(d.id) === selectedDevice) ?? null

  // Selected group and its available (online/connected) member count
  const selectedGroupObj = groups.find((g) => String(g.id) === selectedGroupId) ?? null
  const availableGroupDeviceCount = selectedGroupObj
    ? selectedGroupObj.members.filter(
        (m) => m.device_status === 'online' || m.device_status === 'connected',
      ).length
    : 0

  return (
    <div className="flex h-full flex-col gap-0 -m-4 sm:-m-6 lg:flex-row">
      {/* ── Mobile tab bar — hidden on desktop ── */}
      <div className="flex shrink-0 border-b border-border bg-background lg:hidden">
        <button
          onClick={() => setMobileTab('config')}
          className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
            mobileTab === 'config'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <SlidersHorizontal className="size-4" />
          {t('playground.tabConfig')}
        </button>
        <button
          onClick={() => setMobileTab('stream')}
          className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
            mobileTab === 'stream'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <MonitorSmartphone className="size-4" />
          {t('playground.tabStream')}
        </button>
      </div>

      {/* ── Left: config panel ── */}
      <div className={`flex flex-1 min-w-0 flex-col overflow-y-auto p-4 sm:p-6 gap-4 ${mobileTab === 'stream' ? 'hidden lg:flex' : ''}`}>
        {/* Task */}
        <section className="rounded-xl border border-border bg-background p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">{t('playground.task')}</h2>
            <button className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted">
              <BookOpen className="size-3.5" />
              {t('playground.templates')}
            </button>
          </div>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder={t('playground.taskPlaceholder')}
            rows={5}
            className="w-full resize-y rounded-lg border border-border bg-background p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          />
        </section>

        {/* Agent */}
        <section className="rounded-xl border border-border bg-background p-5">
          <h2 className="mb-4 text-base font-semibold">{t('playground.agent')}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {AGENTS.map(({ id, nameKey, descKey, Icon }) => (
              <button
                key={id}
                onClick={() => setSelectedAgent(id)}
                className={`flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors ${
                  selectedAgent === id
                    ? 'border-primary/60 bg-primary/5'
                    : 'border-border bg-muted/30 hover:bg-muted/60'
                }`}
              >
                <div className="flex size-8 items-center justify-center rounded-lg border border-border bg-background">
                  <Icon className="size-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{t(nameKey)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground leading-snug">{t(descKey)}</p>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Platform */}
        <section className="rounded-xl border border-border bg-background">
          <button
            onClick={() => setPlatformOpen((o) => !o)}
            className="flex w-full items-center justify-between px-5 py-4"
          >
            <h2 className="text-base font-semibold">{t('playground.platform')}</h2>
            {platformOpen ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>

          {platformOpen && (
            <div className="border-t border-border px-5 pb-5 pt-4">
              {/* Devices */}
              <div className="rounded-xl border border-border p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">{t('playground.devices')}</p>
                    <p className="text-xs text-muted-foreground">{t('playground.devicesHint')}</p>
                  </div>
                  <button className="flex size-7 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted">
                    <Plus className="size-4" />
                  </button>
                </div>

                {/* Send to group checkbox */}
                <label className="mb-3 flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={sendToGroup}
                    onChange={(e) => {
                      setSendToGroup(e.target.checked)
                      if (e.target.checked) {
                        setSelectedDevice('')
                        setStreamingIdentifier(null)
                        setUseProfile(false)
                        setSelectedProfileId('')
                      } else {
                        setSelectedGroupId('')
                      }
                    }}
                    className="size-4 rounded border-border accent-primary"
                  />
                  <div>
                    <span className="text-sm font-medium">{t('playground.sendToGroup')}</span>
                    <p className="text-xs text-muted-foreground">{t('playground.sendToGroupHint')}</p>
                  </div>
                </label>

                {sendToGroup ? (
                  /* Group selector */
                  <div className="space-y-2">
                    <div className="relative">
                      <select
                        value={selectedGroupId}
                        onChange={(e) => setSelectedGroupId(e.target.value)}
                        className="h-10 w-full appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="">{t('playground.selectGroup')}</option>
                        {groups.map((g) => (
                          <option key={g.id} value={String(g.id)}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    </div>
                    {selectedGroupObj && (
                      <p className="text-xs text-muted-foreground">
                        {t('playground.groupAvailableDevices', { count: availableGroupDeviceCount })}
                      </p>
                    )}
                  </div>
                ) : (
                  /* Single device selector */
                  <>
                    <div className="relative">
                      <select
                        value={selectedDevice}
                        onChange={(e) => {
                          const deviceId = e.target.value
                          setSelectedDevice(deviceId)
                          setStreamingIdentifier(null)
                          // Auto-enable profile if the newly selected device has profiles
                          const device = devices.find((d) => String(d.id) === deviceId)
                          const firstProfile = device?.profiles?.[0]
                          setUseProfile(!!firstProfile)
                          setSelectedProfileId(firstProfile ? String(firstProfile.id) : '')
                        }}
                        className="h-10 w-full appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="">{t('playground.selectDevice')}</option>
                        {devices.map((d) => (
                          <option key={d.id} value={String(d.id)}>
                            {/* Show first profile name if device belongs to a profile */}
                            {d.profiles.length > 0 ? `${d.profiles[0].name} - ${d.name}` : d.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    </div>

                    {/* Profile option — only shown when the selected device has profiles */}
                    {selectedDeviceObj && selectedDeviceObj.profiles.length > 0 && (
                      <div className="mt-4 space-y-3">
                        <label className="flex cursor-pointer items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={useProfile}
                            onChange={(e) => setUseProfile(e.target.checked)}
                            className="size-4 rounded border-border accent-primary"
                          />
                          <div>
                            <span className="text-sm font-medium">{t('playground.useProfile')}</span>
                            <p className="text-xs text-muted-foreground">{t('playground.useProfileHint')}</p>
                          </div>
                        </label>
                        {useProfile && (
                          <div className="relative">
                            <select
                              value={selectedProfileId}
                              onChange={(e) => setSelectedProfileId(e.target.value)}
                              className="h-10 w-full appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                            >
                              <option value="">{t('playground.selectProfile')}</option>
                              {selectedDeviceObj.profiles.map((p) => (
                                <option key={p.id} value={String(p.id)}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Advanced Settings */}
        <section className="rounded-xl border border-border bg-background">
          <button
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex w-full items-center justify-between px-5 py-4"
          >
            <h2 className="text-base font-semibold">{t('playground.advancedSettings')}</h2>
            {advancedOpen ? (
              <ChevronUp className="size-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 text-muted-foreground" />
            )}
          </button>
          {advancedOpen && (
            <div className="border-t border-border px-5 pb-5 pt-4">
              <p className="text-sm text-muted-foreground">{t('playground.advancedPlaceholder')}</p>
            </div>
          )}
        </section>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            onClick={handleReset}
            disabled={isRunning}
            className="flex-1 rounded-xl border border-border bg-background py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('playground.resetDefaults')}
          </button>
          {runningTask ? (
            <button
              onClick={handlePause}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-destructive py-3 text-sm font-semibold text-destructive-foreground transition-colors hover:bg-destructive/90"
            >
              <Pause className="size-4" />
              {t('playground.pause')}
            </button>
          ) : (
            <button
              onClick={handleRun}
              disabled={isRunning || !task.trim()}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRunning ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('playground.running')}
                </>
              ) : (
                <>
                  {t('playground.run')}
                  <Play className="size-4" />
                </>
              )}
            </button>
          )}
        </div>
        {runError && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {runError}
          </p>
        )}
      </div>

      {/* ── Drag handle — desktop only ── */}
      <div
        onMouseDown={handleDividerMouseDown}
        className="hidden lg:flex w-2 cursor-col-resize flex-col items-center justify-center bg-border/40 hover:bg-primary/30 transition-colors active:bg-primary/50 group shrink-0 select-none"
        title="Drag to resize"
      >
        <GripVertical className="size-4 text-muted-foreground/50 group-hover:text-primary/70" />
      </div>

      {/* ── Right: Task Stream panel ── */}
      <div
        className={`flex w-full shrink-0 flex-col border-border bg-background lg:border-l lg:flex lg:min-h-0 ${
          mobileTab === 'config' ? 'hidden' : 'flex flex-1 min-h-0'
        }`}
        ref={rightPanelRef}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <p className="text-sm font-semibold">{t('playground.taskStream')}</p>
            <p className="text-xs text-muted-foreground">{t('playground.taskStreamDesc')}</p>
          </div>
          {/* Events / Device toggle */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('playground.events')}</span>
            <button
              onClick={() => {
                setStreamMode((m) => (m === 'events' ? 'device' : 'events'))
                setStreamingIdentifier(null)
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                streamMode === 'device' ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`inline-block size-3.5 rounded-full bg-white shadow transition-transform ${
                  streamMode === 'device' ? 'translate-x-[18px]' : 'translate-x-[2px]'
                }`}
              />
            </button>
            <span className="text-xs text-muted-foreground">{t('playground.device')}</span>
          </div>
        </div>

        {/* Stream content area */}
        {streamMode === 'device' ? (
          streamingIdentifier ? (
            /* Live WebRTC stream */
            <div className="flex flex-1 min-h-0 overflow-hidden">
              <DeviceStream
                identifier={streamingIdentifier}
                deviceId={selectedDeviceObj?.id}
                screenWidth={selectedDeviceObj?.screen_width}
                screenHeight={selectedDeviceObj?.screen_height}
                onStop={handleStreamStop}
              />
            </div>
          ) : (
            /* Device mode — no stream yet */
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
              <Smartphone className="size-16 text-muted-foreground/40" strokeWidth={1} />
              {selectedDeviceObj ? (
                <>
                  <p className="text-sm font-medium">{selectedDeviceObj.name}</p>
                  <button
                    onClick={handleToggleDeviceStream}
                    disabled={!selectedDeviceObj.identifier}
                    className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Play className="size-4" />
                    {t('playground.streamStart')}
                  </button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('playground.streamSelectDevice')}</p>
              )}
            </div>
          )
        ) : (
          /* Events mode */
          runningTask ? (
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
              {/* Task summary card */}
              <div className="rounded-xl border border-border bg-muted/30 p-4">
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">{t('playground.taskCreated')}</p>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                    {runningTask.status}
                  </span>
                </div>
                <p className="text-sm font-semibold">{runningTask.name}</p>
                {runningTask.description && (
                  <p className="mt-1 text-xs text-muted-foreground line-clamp-3">{runningTask.description}</p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">ID: {runningTask.id}</p>
              </div>

              {/* Live event log */}
              {taskEvents.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium text-muted-foreground">{t('playground.taskLog', 'Task Log')}</p>
                  {taskEvents.map((ev, idx) => {
                    const isProcessed = ev.status === 'processed'
                    return (
                      <div
                        key={idx}
                        className={`flex gap-2.5 rounded-lg border p-3 text-xs ${
                          isProcessed
                            ? 'border-green-500/30 bg-green-500/5'
                            : 'border-border bg-muted/20'
                        }`}
                      >
                        <span className="mt-0.5 shrink-0">
                          {isProcessed ? (
                            <CheckCircle2 className="size-3.5 text-green-500" />
                          ) : (
                            <Clock className="size-3.5 text-muted-foreground animate-pulse" />
                          )}
                        </span>
                        <p className="leading-relaxed text-foreground">{ev.content}</p>
                      </div>
                    )
                  })}
                  <div ref={eventsEndRef} />
                </div>
              )}

              {taskEvents.length === 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin shrink-0" />
                  {t('playground.waitingForEvents', 'Waiting for task events…')}
                </div>
              )}
            </div>
          ) : (
            /* Events mode placeholder */
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <Smartphone className="size-16 text-muted-foreground/40" strokeWidth={1} />
              <p className="text-sm text-muted-foreground">{t('playground.streamPlaceholder')}</p>
            </div>
          )
        )}
      </div>
    </div>
  )
}
