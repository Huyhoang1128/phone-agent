import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Send,
  BotMessageSquare,
  Users,
  Loader2,
  StopCircle,
  Trash2,
  ChevronDown,
  CheckCircle2,
  Clock,
  XCircle,
  Settings,
  Plus,
  X,
  Play,
} from 'lucide-react'
import { agentGroupsApi, tasksApi, chatSettingsApi } from '@/lib/api'
import type { AgentGroup, Task, TaskEvent, AgentPlanItem } from '@/lib/types'
import { useToast } from '@/context/ToastContext'
import { SSEChatService } from '@/services/sseChat'

const AGENT_TEAMS_URL =
  (import.meta.env.VITE_AGENT_TEAMS_URL as string | undefined)?.trim() ||
  'http://localhost:7777'

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for non-secure contexts (HTTP)
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return [...bytes]
    .map((b, i) => ([4, 6, 8, 10].includes(i) ? '-' : '') + b.toString(16).padStart(2, '0'))
    .join('')
}

interface ChatMessage {
  id: string
  role: 'user' | 'agent' | 'plan'
  content: string
  status?: string
  taskId?: number
  plan?: AgentPlanItem[]
  planId?: number
}

function statusIcon(status: string) {
  if (status === 'completed') return <CheckCircle2 className="size-3.5 text-green-500 shrink-0" />
  if (status === 'failed' || status === 'cancelled') return <XCircle className="size-3.5 text-destructive shrink-0" />
  if (status === 'running') return <Loader2 className="size-3.5 animate-spin text-primary shrink-0" />
  return <Clock className="size-3.5 text-muted-foreground shrink-0" />
}

export default function AgentGroupChatPage() {
  const { t } = useTranslation()
  const { showToast } = useToast()
  const queryClient = useQueryClient()

  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isPlanning, setIsPlanning] = useState(false)
  const [runningTasks, setRunningTasks] = useState<Task[]>([])
  const [groupSelectorOpen, setGroupSelectorOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newTemplate, setNewTemplate] = useState('')
  const [modelInput, setModelInput] = useState('')

  const settingsPanelRef = useRef<HTMLDivElement>(null)

  const MAX_TASK_NAME_LENGTH = 80

  const wsMapRef = useRef<Map<number, WebSocket>>(new Map())
  const planAbortRef = useRef<AbortController | null>(null)
  const ssePlannerRef = useRef<SSEChatService | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const groupSelectorRef = useRef<HTMLDivElement>(null)

  const isRunning = runningTasks.length > 0 || isPlanning

  const { data: groups = [], isLoading: groupsLoading } = useQuery<AgentGroup[]>({
    queryKey: ['agent-groups'],
    queryFn: agentGroupsApi.list,
  })

  const { data: chatSettings } = useQuery({
    queryKey: ['chat-settings'],
    queryFn: chatSettingsApi.get,
  })

  const templates: string[] = chatSettings?.templates ?? []
  const llmModel: string = chatSettings?.llm_model ?? ''

  const saveMutation = useMutation({
    mutationFn: chatSettingsApi.update,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-settings'] })
    },
    onError: (e) => {
      showToast(e instanceof Error ? e.message : String(e), 'error')
    },
  })

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? (groups.length > 0 ? groups[0] : null)

  // Sync model input with loaded chat settings
  useEffect(() => {
    if (chatSettings?.llm_model !== undefined) {
      setModelInput(chatSettings.llm_model)
    }
  }, [chatSettings?.llm_model])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Close group selector on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (groupSelectorRef.current && !groupSelectorRef.current.contains(e.target as Node)) {
        setGroupSelectorOpen(false)
      }
      if (settingsPanelRef.current && !settingsPanelRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Disconnect all WebSockets and SSE on unmount
  useEffect(() => {
    return () => {
      wsMapRef.current.forEach((ws) => ws.close())
      wsMapRef.current.clear()
      planAbortRef.current?.abort()
      ssePlannerRef.current?.close()
    }
  }, [])

  function connectTaskWebSocket(taskId: number, messageId: string) {
    wsMapRef.current.get(taskId)?.close()

    const token = localStorage.getItem('access_token') ?? ''
    const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? ''
    const wsBase = apiUrl
      ? apiUrl.replace(/^http/, 'ws')
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
    const url = `${wsBase}/ws/task/${taskId}/?token=${encodeURIComponent(token)}`

    const ws = new WebSocket(url)
    wsMapRef.current.set(taskId, ws)

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as TaskEvent
        const content = event.content?.trim()
        if (!content) return

        setMessages((prev) => {
          // Append sub-event as a new agent message if it's not a duplicate
          const last = prev[prev.length - 1]
          if (last?.role === 'agent' && last.content === content) return prev
          return [
            ...prev,
            {
              id: `${messageId}-${generateUUID()}`,
              role: 'agent' as const,
              content,
              status: event.status,
              taskId,
            },
          ]
        })

        // Update status on the parent agent message bubble
        if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === messageId ? { ...m, status: event.status } : m,
            ),
          )
        }
      } catch {
        // ignore
      }
    }

    const onDone = () => {
      wsMapRef.current.delete(taskId)
      if (wsMapRef.current.size === 0) {
        setRunningTasks([])
      }
    }

    ws.onclose = onDone
    ws.onerror = onDone
  }

  const handleStop = useCallback(async () => {
    if (isPlanning) {
      // Stop SSE stream if active
      ssePlannerRef.current?.close()
      ssePlannerRef.current = null
      planAbortRef.current?.abort()
      planAbortRef.current = null
      setIsPlanning(false)
      setMessages((prev) => prev.filter((m) => m.role !== 'plan'))
      return
    }

    wsMapRef.current.forEach((ws) => ws.close())
    wsMapRef.current.clear()
    const tasks = runningTasks
    setRunningTasks([])

    for (const task of tasks) {
      try {
        await tasksApi.stop(task.id)
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), 'error')
      }
    }
  }, [isPlanning, runningTasks, showToast])

  // ── Plan via SSE (agent_teams direct streaming) ────────────────────────────

  function _startSSEPlan(goal: string, groupId: number, planMsgId: string, agents: AgentGroup['members']) {
    const token = localStorage.getItem('access_token') ?? ''
    const userId = String(localStorage.getItem('user_id') ?? '')

    // Build the planning prompt
    const agentsDesc = agents
      .map(
        (m) =>
          `- device_id=${m.device}: ${m.device_name} (role=${m.role}, profile=${m.device_profile_name || 'N/A'}, status=${m.device_status})`,
      )
      .join('\n')
    const message = `Goal: ${goal}\n\nAvailable agents:\n${agentsDesc}`

    const svc = new SSEChatService()
    ssePlannerRef.current = svc

    // Auto-timeout: disable thinking after 80 seconds
    const thinkingTimeout = setTimeout(() => {
      if (ssePlannerRef.current === svc) {
        svc.close()
        ssePlannerRef.current = null
        setIsPlanning(false)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === planMsgId ? { ...m, content: 'Planning timed out.', status: 'failed' } : m,
          ),
        )
      }
    }, 80_000)

    let accumulatedContent = ''

    svc
      .onEvent((event) => {
        if (event.event === 'TeamRunStarted') {
          // Already showing spinner via 'planning' status — nothing extra needed
          return
        }

        if (event.event === 'TeamRunContent' && typeof event.content === 'string') {
          accumulatedContent += event.content
          // Show the streaming content live in the plan bubble
          setMessages((prev) =>
            prev.map((m) =>
              m.id === planMsgId ? { ...m, content: accumulatedContent, status: 'streaming' } : m,
            ),
          )
          return
        }
      })
      .onComplete(async () => {
        clearTimeout(thinkingTimeout)
        ssePlannerRef.current = null

        // Parse the JSON plan from the accumulated content
        let enrichedPlan: AgentPlanItem[] = []
        try {
          let text = accumulatedContent.trim()
          // Strip markdown code fences if present
          if (text.startsWith('```')) {
            const lines = text.split('\n')
            const inner = lines[lines.length - 1].trim() === '```' ? lines.slice(1, -1) : lines.slice(1)
            text = inner.join('\n').trim()
          }
          const parsed = JSON.parse(text) as { plan?: Array<{ device_id: number; task: string }> }
          const validIds = new Set(agents.map((m) => m.device))
          enrichedPlan = (parsed.plan ?? [])
            .filter((item) => validIds.has(item.device_id))
            .map((item) => {
              // Safe: item.device_id is guaranteed to be in validIds due to the filter above
              const member = agents.find((m) => m.device === item.device_id)
              if (!member) return null
              return {
                device_id: item.device_id,
                device_name: member.device_name,
                role: member.role,
                task: item.task,
              }
            })
            .filter((item): item is AgentPlanItem => item !== null)
        } catch {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === planMsgId
                ? { ...m, content: 'Failed to parse plan from agent response.', status: 'failed' }
                : m,
            ),
          )
          setIsPlanning(false)
          return
        }

        // Persist the plan for human approval
        let planId: number | undefined
        try {
          const saved = await agentGroupsApi.savePlan(groupId, { goal, plan: enrichedPlan })
          planId = saved.id
        } catch (e) {
          console.warn('Failed to save plan to backend:', e)
        }

        setMessages((prev) =>
          prev.map((m) =>
            m.id === planMsgId ? { ...m, content: '', plan: enrichedPlan, planId, status: 'ready' } : m,
          ),
        )
        setIsPlanning(false)
      })
      .onError((err) => {
        clearTimeout(thinkingTimeout)
        ssePlannerRef.current = null
        setMessages((prev) =>
          prev.map((m) =>
            m.id === planMsgId ? { ...m, content: err.message, status: 'failed' } : m,
          ),
        )
        showToast(err.message, 'error')
        setIsPlanning(false)
      })

    svc.sendMessage({
      url: `${AGENT_TEAMS_URL}/v1/agents/planner/runs`,
      message,
      token,
      userId,
      sessionId: generateUUID(),
      ...(llmModel ? { model: llmModel } : {}),
    })
  }

  // ── Plan via Django (synchronous fallback) ─────────────────────────────────

  async function _fetchPlanFromDjango(goal: string, groupId: number, planMsgId: string) {
    const abortCtrl = new AbortController()
    planAbortRef.current = abortCtrl

    try {
      const data = await agentGroupsApi.planTasks(groupId, {
        goal,
        ...(llmModel ? { llm_model: llmModel } : {}),
      })

      if (abortCtrl.signal.aborted) return

      setMessages((prev) =>
        prev.map((m) =>
          m.id === planMsgId ? { ...m, plan: data.plan, planId: data.plan_id, status: 'ready' } : m,
        ),
      )
    } catch (e) {
      if (abortCtrl.signal.aborted) return
      const errMsg = e instanceof Error ? e.message : String(e)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === planMsgId ? { ...m, content: errMsg, status: 'failed' } : m,
        ),
      )
      showToast(errMsg, 'error')
    } finally {
      if (!abortCtrl.signal.aborted) {
        setIsPlanning(false)
        planAbortRef.current = null
      }
    }
  }

  // ── Main send handler ──────────────────────────────────────────────────────

  async function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || !selectedGroup || isRunning) return

    const availableMembers = selectedGroup.members.filter(
      (m) => m.device_status === 'online' || m.device_status === 'connected',
    )

    if (availableMembers.length === 0) {
      showToast(t('agentGroupChat.noAvailableDevices'), 'error')
      return
    }

    setMessages((prev) => [
      ...prev,
      { id: `user-${generateUUID()}`, role: 'user', content: trimmed },
    ])
    setInput('')
    setIsPlanning(true)

    const planMsgId = `plan-${generateUUID()}`
    setMessages((prev) => [
      ...prev,
      { id: planMsgId, role: 'plan', content: '', status: 'planning' },
    ])

    if (AGENT_TEAMS_URL) {
      // Stream plan generation from the planner agent directly via SSE
      _startSSEPlan(trimmed, selectedGroup.id, planMsgId, selectedGroup.members)
    } else {
      // Fallback: synchronous call through the Django backend
      await _fetchPlanFromDjango(trimmed, selectedGroup.id, planMsgId)
    }
  }

  async function handleRunPlan(planMsgId: string, plan: AgentPlanItem[], planId?: number) {
    if (!selectedGroup) return

    // Approve the plan in the backend
    if (planId) {
      try {
        await agentGroupsApi.approvePlan(selectedGroup.id, planId)
      } catch (e) {
        // Non-fatal: log but continue running tasks
        console.warn('Failed to mark plan as approved:', e)
      }
    }

    setMessages((prev) => prev.filter((m) => m.id !== planMsgId))

    const newTasks: Task[] = []

    for (const item of plan) {
      const agentMsgId = `agent-${item.device_id}-${generateUUID()}`
      setMessages((prev) => [
        ...prev,
        { id: agentMsgId, role: 'agent', content: '', status: 'running' },
      ])

      try {
        const name = item.task.length > MAX_TASK_NAME_LENGTH
          ? item.task.slice(0, MAX_TASK_NAME_LENGTH)
          : item.task
        const payload: Record<string, unknown> = { agent: 'default', group_id: selectedGroup.id }
        if (llmModel) payload.llm_model = llmModel
        const created = await tasksApi.create({
          name,
          description: item.task,
          task_type: 'generic',
          status: 'pending',
          payload,
        })
        const running = await tasksApi.run(created.id, [item.device_id], null)
        newTasks.push(running)
        connectTaskWebSocket(running.id, agentMsgId)
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === agentMsgId ? { ...m, content: errMsg, status: 'failed' } : m,
          ),
        )
      }
    }

    if (newTasks.length > 0) {
      setRunningTasks(newTasks)
      showToast(t('agentGroupChat.taskStarted', { count: newTasks.length }), 'success')
    }
  }

  async function handleCancelPlan(planMsgId: string, planId?: number) {
    if (selectedGroup && planId) {
      try {
        await agentGroupsApi.rejectPlan(selectedGroup.id, planId)
      } catch (e) {
        // Non-fatal: log but still remove from UI
        console.warn('Failed to mark plan as rejected:', e)
      }
    }
    setMessages((prev) => prev.filter((m) => m.id !== planMsgId))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleClearChat() {
    if (isRunning) return
    setMessages([])
  }

  function saveTemplates(updated: string[]) {
    saveMutation.mutate({ templates: updated })
  }

  function handleAddTemplate() {
    const trimmed = newTemplate.trim()
    if (!trimmed) return
    saveTemplates([...templates, trimmed])
    setNewTemplate('')
  }

  function handleDeleteTemplate(index: number) {
    saveTemplates(templates.filter((_, i) => i !== index))
  }

  function handleSaveModel() {
    const trimmed = modelInput.trim()
    saveMutation.mutate(
      { llm_model: trimmed },
      {
        onSuccess: () => {
          showToast(t('agentGroupChat.modelSaved'), 'success')
        },
      },
    )
  }

  function handleTemplateClick(tpl: string) {
    const textarea = textareaRef.current
    if (!textarea) {
      setInput(tpl)
      return
    }
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const newValue = input.slice(0, start) + tpl + input.slice(end)
    setInput(newValue)
    // Restore focus and place cursor after inserted template
    setTimeout(() => {
      textarea.focus()
      textarea.setSelectionRange(start + tpl.length, start + tpl.length)
    }, 0)
  }

  const availableCount = selectedGroup
    ? selectedGroup.members.filter(
        (m) => m.device_status === 'online' || m.device_status === 'connected',
      ).length
    : 0

  return (
    <div className="-m-4 sm:-m-6 flex h-full flex-col">
      {/* ── Header ── */}
      <div className="shrink-0 border-b border-border bg-background px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between">
        {/* Group selector */}
        <div ref={groupSelectorRef} className="relative">
          <button
            onClick={() => setGroupSelectorOpen((v) => !v)}
            className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
          >
            <BotMessageSquare className="size-4 text-primary" />
            {groupsLoading ? (
              <span className="text-muted-foreground">{t('common.loading')}</span>
            ) : selectedGroup ? (
              <span>{selectedGroup.name}</span>
            ) : (
              <span className="text-muted-foreground">{t('agentGroupChat.selectGroup')}</span>
            )}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>

          {groupSelectorOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-xl border border-border bg-popover shadow-lg">
              <div className="p-1">
                {groups.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    {t('agentGroupChat.noGroups')}
                  </p>
                ) : (
                  groups.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => {
                        setSelectedGroupId(g.id)
                        setGroupSelectorOpen(false)
                        setMessages([])
                        wsMapRef.current.forEach((ws) => ws.close())
                        wsMapRef.current.clear()
                        setRunningTasks([])
                        setIsPlanning(false)
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
                        g.id === selectedGroup?.id ? 'bg-muted font-medium' : ''
                      }`}
                    >
                      <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold">
                        {g.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate">{g.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {g.member_count} {t('agentGroupChat.devices')}
                        </p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

          <div className="flex items-center gap-3">
            {selectedGroup && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="size-3.5" />
                <span>
                  {availableCount}/{selectedGroup.member_count} {t('agentGroupChat.online')}
                </span>
              </div>
            )}

            {/* Settings button moved here from input bar */}
            <div ref={settingsPanelRef} className="relative shrink-0">
              <button
                onClick={() => setSettingsOpen((v) => !v)}
                className={`flex size-8 items-center justify-center rounded-lg border border-border transition-colors hover:bg-muted ${settingsOpen ? 'bg-muted' : ''}`}
                title={t('agentGroupChat.messageTemplates')}
              >
                <Settings className="size-4 text-muted-foreground" />
              </button>

              {settingsOpen && (
                <div className="absolute top-full right-0 z-50 mt-2 w-72 rounded-xl border border-border bg-popover shadow-lg">
                  <div className="flex items-center justify-between border-b border-border px-3 py-2">
                    <span className="text-sm font-medium">{t('agentGroupChat.messageTemplates')}</span>
                    <button
                      onClick={() => setSettingsOpen(false)}
                      className="rounded p-0.5 hover:bg-muted"
                    >
                      <X className="size-3.5 text-muted-foreground" />
                    </button>
                  </div>

                  <div className="max-h-52 overflow-y-auto p-2">
                    {templates.length === 0 ? (
                      <p className="px-2 py-2 text-xs text-muted-foreground">
                        {t('agentGroupChat.noTemplates')}
                      </p>
                    ) : (
                      templates.map((tpl, i) => (
                        <div
                          key={i}
                          className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted"
                        >
                          <span className="flex-1 truncate text-xs">{tpl}</span>
                          <button
                            onClick={() => handleDeleteTemplate(i)}
                            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                            title={t('agentGroupChat.deleteTemplate')}
                          >
                            <Trash2 className="size-3.5 text-destructive" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="border-t border-border p-2">
                    <div className="flex gap-1.5">
                      <input
                        value={newTemplate}
                        onChange={(e) => setNewTemplate(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleAddTemplate()
                          }
                        }}
                        placeholder={t('agentGroupChat.templatePlaceholder')}
                        className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                      />
                      <button
                        onClick={handleAddTemplate}
                        disabled={!newTemplate.trim()}
                        className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                        title={t('agentGroupChat.addTemplate')}
                      >
                        <Plus className="size-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Model settings */}
                  <div className="border-t border-border px-3 py-2">
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                      {t('agentGroupChat.modelSettings')}
                    </p>
                    <div className="flex gap-1.5">
                      <input
                        value={modelInput}
                        onChange={(e) => setModelInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleSaveModel()
                          }
                        }}
                        placeholder={t('agentGroupChat.modelPlaceholder')}
                        className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                      />
                      <button
                        onClick={handleSaveModel}
                        disabled={modelInput.trim() === (llmModel ?? '').trim()}
                        className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                        title={t('common.save')}
                      >
                        <CheckCircle2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {messages.length > 0 && !isRunning && (
              <button
                onClick={handleClearChat}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t('agentGroupChat.clearChat')}
              >
                <Trash2 className="size-3.5" />
                <span className="hidden sm:inline">{t('agentGroupChat.clearChat')}</span>
              </button>
            )}
          </div>
        </div>

        {/* Template chips */}
        {templates.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {templates.map((tpl, i) => (
              <button
                key={i}
                onClick={() => handleTemplateClick(tpl)}
                disabled={isRunning || !selectedGroup}
                className="max-w-xs truncate rounded-full border border-border bg-muted px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                title={tpl}
              >
                {tpl}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-border bg-muted">
              <BotMessageSquare className="size-7 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">
                {selectedGroup
                  ? t('agentGroupChat.startConversation', { name: selectedGroup.name })
                  : t('agentGroupChat.selectGroupHint')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedGroup
                  ? t('agentGroupChat.startConversationHint', { count: availableCount })
                  : t('agentGroupChat.selectGroupHintDesc')}
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {(msg.role === 'agent' || msg.role === 'plan') && (
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <BotMessageSquare className="size-4" />
                  </div>
                )}

                {msg.role === 'plan' ? (
                  <div className="max-w-[80%] rounded-2xl border border-border bg-card px-4 py-3 text-sm text-foreground">
                    {msg.status === 'planning' ? (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        <span className="text-xs">{t('agentGroupChat.planning')}</span>
                      </div>
                    ) : msg.status === 'streaming' ? (
                      <div>
                        <div className="mb-2 flex items-center gap-2 text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" />
                          <span className="text-xs">{t('agentGroupChat.planning')}</span>
                        </div>
                        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs text-foreground">
                          {msg.content}
                          <span className="inline-block size-2 animate-pulse rounded-full bg-primary align-middle" />
                        </pre>
                      </div>
                    ) : msg.status === 'failed' ? (
                      <div className="flex items-center gap-1.5 text-destructive text-xs">
                        <XCircle className="size-3.5 shrink-0" />
                        <span>{msg.content || t('agentGroupChat.planningFailed')}</span>
                      </div>
                    ) : (
                      <div>
                        <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          {t('agentGroupChat.planTitle')}
                        </p>
                        <ul className="mb-3 flex flex-col gap-2">
                          {msg.plan?.map((item) => (
                            <li key={item.device_id} className="flex gap-2 text-xs">
                              <span className="shrink-0 font-medium">{item.device_name}:</span>
                              <span className="text-muted-foreground">{item.task}</span>
                            </li>
                          ))}
                        </ul>
                        <div className="flex gap-2">
                          <button
                            onClick={() => msg.plan && handleRunPlan(msg.id, msg.plan, msg.planId)}
                            className="flex items-center gap-1 rounded-lg bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90"
                          >
                            <Play className="size-3" />
                            {t('agentGroupChat.runPlan')}
                          </button>
                          <button
                            onClick={() => handleCancelPlan(msg.id, msg.planId)}
                            className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
                          >
                            {t('agentGroupChat.cancelPlan')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
                      msg.role === 'user'
                        ? 'bg-foreground text-background'
                        : 'border border-border bg-card text-foreground'
                    }`}
                  >
                    {msg.role === 'agent' && msg.content === '' ? (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        <span className="text-xs">{t('agentGroupChat.agentThinking')}</span>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap break-words leading-relaxed">
                        {msg.content}
                      </p>
                    )}

                    {msg.role === 'agent' && msg.status && (
                      <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                        {statusIcon(msg.status)}
                        <span>{msg.status}</span>
                      </div>
                    )}
                  </div>
                )}

                {msg.role === 'user' && (
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background text-xs font-semibold">
                    U
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* ── Input ── */}
      <div className="shrink-0 border-t border-border bg-background px-4 py-3 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="relative flex items-end gap-2 rounded-xl border border-border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                !selectedGroup
                  ? t('agentGroupChat.selectGroupHint')
                  : isRunning
                    ? t('agentGroupChat.waitForResponse')
                    : t('agentGroupChat.inputPlaceholder')
              }
              disabled={!selectedGroup || isRunning}
              rows={1}
              className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              style={{ maxHeight: '160px', overflowY: 'auto' }}
            />

            {isRunning ? (
              <button
                onClick={handleStop}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive text-destructive-foreground transition-colors hover:opacity-90"
                title={t('agentGroupChat.stopTask')}
              >
                <StopCircle className="size-4" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() || !selectedGroup}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                title={t('agentGroupChat.send')}
              >
                <Send className="size-4" />
              </button>
            )}
          </div>

          <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
            {t('agentGroupChat.inputHint')}
          </p>
        </div>
      </div>
    </div>
  )
}
