import { useEffect, useRef, useCallback, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Play,
  Square,
  Pencil,
  CheckCircle2,
  Clock,
  Loader2,
  GripVertical,
  SlidersHorizontal,
  MonitorSmartphone,
  ListChecks,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TaskStatusBadge } from '@/components/StatusBadge'
import { tasksApi } from '@/lib/api'
import type { Task, TaskEvent } from '@/lib/types'
import { useToast } from '@/context/ToastContext'

export default function TaskDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [liveEvents, setLiveEvents] = useState<TaskEvent[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const eventsEndRef = useRef<HTMLDivElement>(null)

  // Mobile tab: 'info' shows the left info panel, 'steps' shows the right panel
  const [mobileTab, setMobileTab] = useState<'info' | 'steps'>('info')

  // Resizable right panel
  const MIN_RIGHT_WIDTH = 300
  const MAX_RIGHT_WIDTH = 800
  const DEFAULT_RIGHT_WIDTH = 380
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : false
  )

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveEvents])

  const { data: task, isLoading } = useQuery<Task>({
    queryKey: ['tasks', id],
    queryFn: () => tasksApi.get(Number(id)),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const t = query.state.data
      return t?.status === 'running' ? 5_000 : false
    },
  })

  // Connect WebSocket for live events when task is running
  function connectTaskWebSocket(taskId: number) {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    const token = localStorage.getItem('access_token') ?? ''
    const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? ''
    const wsBase = apiUrl
      ? apiUrl.replace(/^http/, 'ws')
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
    const url = `${wsBase}/ws/task/${taskId}/?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as TaskEvent
        setLiveEvents((prev) => [...prev, event])
      } catch {
        // ignore malformed messages
      }
    }
    ws.onerror = () => {}
    ws.onclose = () => {
      wsRef.current = null
    }
  }

  // When task becomes running, connect WebSocket
  useEffect(() => {
    if (task?.status === 'running') {
      setLiveEvents([])
      connectTaskWebSocket(task.id)
    } else {
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [task?.status, task?.id])

  // Disconnect on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close()
    }
  }, [])

  const runMutation = useMutation({
    mutationFn: (taskId: number) => tasksApi.run(taskId),
    onSuccess: (updated) => {
      qc.setQueryData(['tasks', id], updated)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      showToast(t('taskDetail.taskStarted'), 'success')
    },
    onError: () => showToast(t('taskDetail.taskRunError'), 'error'),
  })

  const stopMutation = useMutation({
    mutationFn: (taskId: number) => tasksApi.stop(taskId),
    onSuccess: (updated) => {
      qc.setQueryData(['tasks', id], updated)
      qc.invalidateQueries({ queryKey: ['tasks'] })
      wsRef.current?.close()
      setLiveEvents([])
    },
  })

  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragStartX.current = e.clientX
      dragStartWidth.current = rightWidth
      e.preventDefault()
      const onMouseMove = (ev: MouseEvent) => {
        const delta = dragStartX.current - ev.clientX
        const newWidth = Math.min(
          MAX_RIGHT_WIDTH,
          Math.max(MIN_RIGHT_WIDTH, dragStartWidth.current + delta),
        )
        setRightWidth(newWidth)
      }
      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [rightWidth],
  )

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!task) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground">{t('taskDetail.notFound')}</p>
        <Button variant="outline" onClick={() => navigate('/tasks')}>
          <ArrowLeft className="mr-2 size-4" />
          {t('taskDetail.backToList')}
        </Button>
      </div>
    )
  }

  // Merge stored result with any live events that arrived after page load
  const storedEvents: TaskEvent[] = Array.isArray(task.result) ? task.result : []
  const allEvents: TaskEvent[] =
    task.status === 'running' && liveEvents.length > 0
      ? liveEvents
      : storedEvents

  return (
    <div className="flex h-full flex-col gap-0 -m-4 sm:-m-6 lg:flex-row">
      {/* ── Mobile tab bar — hidden on desktop ── */}
      <div className="flex shrink-0 border-b border-border bg-background lg:hidden">
        <button
          onClick={() => setMobileTab('info')}
          className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
            mobileTab === 'info'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <SlidersHorizontal className="size-4" />
          {t('taskDetail.tabInfo')}
        </button>
        <button
          onClick={() => setMobileTab('steps')}
          className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
            mobileTab === 'steps'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <MonitorSmartphone className="size-4" />
          {t('taskDetail.tabSteps')}
        </button>
      </div>

      {/* ── Left: task info panel ── */}
      <div
        className={`flex flex-1 min-w-0 flex-col overflow-y-auto p-4 sm:p-6 gap-4 ${
          mobileTab === 'steps' ? 'hidden lg:flex' : ''
        }`}
      >
        {/* Back + title row */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate('/tasks')} aria-label={t('taskDetail.backToList')}>
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-xl font-semibold truncate">{task.name}</h1>
        </div>

        {/* Status + actions */}
        <div className="flex flex-wrap items-center gap-2">
          <TaskStatusBadge status={task.status} />
          <div className="ml-auto flex items-center gap-2">
            {task.status === 'running' ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => stopMutation.mutate(task.id)}
                disabled={stopMutation.isPending}
              >
                <Square className="mr-1.5 size-3.5" />
                {t('taskDetail.stop')}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => runMutation.mutate(task.id)}
                disabled={runMutation.isPending}
              >
                {runMutation.isPending ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <Play className="mr-1.5 size-3.5" />
                )}
                {t('taskDetail.run')}
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link to={`/tasks/${task.id}/edit`}>
                <Pencil className="mr-1.5 size-3.5" />
                {t('taskDetail.edit')}
              </Link>
            </Button>
          </div>
        </div>

        {/* Details card */}
        <section className="rounded-xl border border-border bg-background p-5 flex flex-col gap-3">
          {task.description && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">{t('taskDetail.description')}</p>
              <p className="text-sm">{task.description}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-0.5">{t('taskDetail.taskType')}</p>
              <p>{task.task_type}</p>
            </div>
            {task.llm_model && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-0.5">{t('taskDetail.llmModel')}</p>
                <p>{task.llm_model}</p>
              </div>
            )}
            {task.steps != null && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-0.5">{t('taskDetail.steps')}</p>
                <p>{task.steps}</p>
              </div>
            )}
            {task.device_serial && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-0.5">{t('taskDetail.device')}</p>
                <p className="truncate">{task.device_serial}</p>
              </div>
            )}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-0.5">{t('taskDetail.created')}</p>
              <p>{new Date(task.created_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}</p>
            </div>
            {task.finished_at && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-0.5">{t('taskDetail.finished')}</p>
                <p>{new Date(task.finished_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}</p>
              </div>
            )}
          </div>
        </section>

        {/* Payload card */}
        {task.payload && Object.keys(task.payload).length > 0 && (
          <section className="rounded-xl border border-border bg-background p-5">
            <p className="text-xs font-medium text-muted-foreground mb-2">{t('taskDetail.payload')}</p>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">
              {JSON.stringify(task.payload, null, 2)}
            </pre>
          </section>
        )}
      </div>

      {/* ── Drag handle — desktop only ── */}
      <div
        onMouseDown={handleDividerMouseDown}
        className="hidden lg:flex w-2 cursor-col-resize flex-col items-center justify-center bg-border/40 hover:bg-primary/30 transition-colors active:bg-primary/50 group shrink-0 select-none"
        title={t('taskDetail.dragToResize')}
      >
        <GripVertical className="size-4 text-muted-foreground/50 group-hover:text-primary/70" />
      </div>

      {/* ── Right: steps/result panel ── */}
      <div
        style={isDesktop ? { width: `${rightWidth}px` } : undefined}
        className={`flex shrink-0 flex-col border-border bg-background lg:border-l lg:flex lg:min-h-0 ${
          mobileTab === 'info' ? 'hidden' : 'flex w-full flex-1 min-h-0'
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <ListChecks className="size-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-sm font-semibold">{t('taskDetail.resultPanel')}</p>
            <p className="text-xs text-muted-foreground">{t('taskDetail.resultPanelDesc')}</p>
          </div>
          {task.status === 'running' && (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground" aria-label={t('common.liveUpdates')}>
              <span aria-hidden="true">{t('common.liveUpdates')}</span>
              <span className="inline-block size-2 rounded-full bg-green-500" aria-hidden="true" />
            </span>
          )}
        </div>

        {/* Steps content */}
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
          {/* Task summary card */}
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">{t('taskDetail.taskId')}: {task.id}</p>
              <TaskStatusBadge status={task.status} />
            </div>
            <p className="text-sm font-semibold">{task.name}</p>
            {task.description && (
              <p className="mt-1 text-xs text-muted-foreground line-clamp-3">{task.description}</p>
            )}
          </div>

          {/* Event list */}
          {allEvents.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">{t('taskDetail.taskLog')}</p>
              {allEvents.map((ev, idx) => {
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
                        <Clock className="size-3.5 text-muted-foreground" />
                      )}
                    </span>
                    <p className="leading-relaxed text-foreground">{ev.content}</p>
                  </div>
                )
              })}
              <div ref={eventsEndRef} />
            </div>
          ) : task.status === 'running' ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin shrink-0" />
              {t('taskDetail.waitingForEvents')}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <ListChecks className="size-12 text-muted-foreground/30" strokeWidth={1} />
              <p className="text-sm text-muted-foreground">{t('taskDetail.noSteps')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
