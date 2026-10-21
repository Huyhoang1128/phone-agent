import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Play,
  Pencil,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  Zap,
  ClipboardList,
  CalendarClock,
  Settings2,
  ChevronDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import {
  authApi,
  devicesApi,
  eventsApi,
  profilesApi,
  teamsApi,
  workflowsApi,
  workflowRunsApi,
  workflowStepsApi,
  workflowTriggersApi,
} from '@/lib/api'
import { cronNextRuns } from '@/lib/cronPreview'
import type {
  EventSourceType,
  Profile,
  SystemEventDef,
  ScheduleType,
  TaskStatus,
  TaskType,
  Workflow,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepActionConfig,
  WorkflowStepActionType,
  WorkflowStepCreate,
  WorkflowStepInputBinding,
  WorkflowStepScheduleConfig,
  WorkflowStepTaskConfig,
  WorkflowTrigger,
  WorkflowTriggerCreate,
  TriggerType,
  PeriodicScheduleType,
} from '@/lib/types'
import { TiktokWorkflowHint } from '@/components/chatbot/TiktokWorkflowHint'
import { ChatbotActionConfigEditor } from '@/components/chatbot/ChatbotActionConfigEditor'

const TRIGGER_TYPES: TriggerType[] = ['periodic', 'event', 'webhook']
const PERIODIC_SCHEDULE_TYPES: PeriodicScheduleType[] = ['once', 'interval', 'cron']
const DEFAULT_EVENT_SOURCE_TYPE: EventSourceType = 'device'
const STEP_ACTION_TYPES: WorkflowStepActionType[] = ['create_task', 'create_schedule', 'custom']
const ACTIVE_RUN_STATUSES: WorkflowRun['status'][] = ['pending', 'running']
const TASK_TYPES: TaskType[] = ['generic']
const TASK_STATUSES: TaskStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled']
const SCHEDULE_TYPES: ScheduleType[] = ['once', 'interval', 'cron']
const EMPTY_STEP_BINDING: WorkflowStepInputBinding = {
  source_type: 'trigger',
  source_path: '',
  target_path: '',
}

const emptyTriggerForm = (): WorkflowTriggerCreate => ({
  trigger_type: 'periodic',
  is_active: true,
  periodic_schedule_type: 'once',
  run_at: null,
  interval_seconds: null,
  cron_expression: '',
  event_name: '',
  event_source_type: DEFAULT_EVENT_SOURCE_TYPE,
  event_source_id: null,
  event_filter: {},
  webhook_secret: '',
})

const emptyTaskConfig = (): WorkflowStepTaskConfig => ({
  name: '',
  description: '',
  task_type: 'generic',
  status: 'pending',
  payload: {},
  device_id: null,
})

const emptyScheduleConfig = (profileId: number | null = null): WorkflowStepScheduleConfig => ({
  profile_id: profileId,
  schedule_type: 'once',
  run_at: null,
  interval_seconds: null,
  cron_expression: '',
  max_retries: 0,
  retry_delay_seconds: 60,
  is_active: true,
})

function normalizeTaskConfig(config?: Partial<WorkflowStepTaskConfig>): WorkflowStepTaskConfig {
  return {
    ...emptyTaskConfig(),
    ...config,
    payload:
      config?.payload && typeof config.payload === 'object' && !Array.isArray(config.payload)
        ? config.payload
        : {},
  }
}

function normalizeScheduleConfig(
  config?: Partial<WorkflowStepScheduleConfig>,
  profileId: number | null = null,
): WorkflowStepScheduleConfig {
  return {
    ...emptyScheduleConfig(profileId),
    ...config,
    run_at: config?.run_at ?? null,
    interval_seconds: config?.interval_seconds ?? null,
  }
}

function buildActionConfig(
  actionType: WorkflowStepActionType,
  current?: WorkflowStepActionConfig,
  profileId: number | null = null,
): WorkflowStepActionConfig {
  if (actionType === 'create_task') {
    return {
      task: normalizeTaskConfig(current?.task),
    }
  }
  if (actionType === 'create_schedule') {
    return {
      task: normalizeTaskConfig(current?.task),
      schedule: normalizeScheduleConfig(current?.schedule, profileId),
    }
  }
  return current ?? {}
}

const emptyStepForm = (sortOrder = 1): WorkflowStepCreate => ({
  name: '',
  description: '',
  sort_order: sortOrder,
  action_type: 'custom',
  action_config: {},
  input_bindings: [],
})

const EVENT_SOURCE_TYPES: EventSourceType[] = ['device', 'team', 'user']

function getEventI18nKey(eventName: string) {
  return `workflowDetail.eventLabels.${eventName.replace(/\./g, '_')}`
}

function getActionTypeIcon(actionType: string) {
  switch (actionType) {
    case 'create_task':
      return <ClipboardList className="size-5 text-blue-600" />
    case 'create_schedule':
      return <CalendarClock className="size-5 text-purple-600" />
    default:
      return <Settings2 className="size-5 text-muted-foreground" />
  }
}

function actionTypeI18nSuffix(actionType: string) {
  const key = actionType || 'custom'
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function getActionTypeBg(actionType: string) {
  switch (actionType) {
    case 'create_task':
      return 'bg-blue-100 dark:bg-blue-900/30'
    case 'create_schedule':
      return 'bg-purple-100 dark:bg-purple-900/30'
    default:
      return 'bg-muted'
  }
}

function getStepActionSummary(step: WorkflowStep, t: (key: string, opts?: Record<string, unknown>) => string) {
  if (step.action_type === 'create_task') {
    const taskName = step.action_config.task?.name || t('workflowDetail.unconfigured')
    const bindingCount = step.input_bindings.length
    return `${t('workflowDetail.taskSummaryLabel', { name: taskName })}${bindingCount ? ` · ${t('workflowDetail.bindingSummaryLabel', { count: bindingCount })}` : ''}`
  }

  if (step.action_type === 'create_schedule') {
    const scheduleType = step.action_config.schedule?.schedule_type
    const taskName = step.action_config.task?.name || t('workflowDetail.unconfigured')
    const parts = [t('workflowDetail.scheduleSummaryLabel', { task: taskName })]
    if (scheduleType) {
      parts.push(t(`workflowDetail.${scheduleType}`))
    }
    if (step.input_bindings.length) {
      parts.push(t('workflowDetail.bindingSummaryLabel', { count: step.input_bindings.length }))
    }
    return parts.join(' · ')
  }

  return ''
}

function getTriggerSummary(trigger: WorkflowTrigger, t: (key: string, opts?: Record<string, unknown>) => string) {
  if (trigger.trigger_type === 'periodic') {
    const type = trigger.periodic_schedule_type
    if (type === 'interval' && trigger.interval_seconds != null) return `${t('workflowDetail.interval')} · ${trigger.interval_seconds}s`
    if (type === 'cron' && trigger.cron_expression) return `${t('workflowDetail.cron')} · ${trigger.cron_expression}`
    if (type === 'once' && trigger.run_at) return `${t('workflowDetail.once')} · ${new Date(trigger.run_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}`
    return t('workflowDetail.periodic')
  }
  if (trigger.trigger_type === 'event') {
    return t(getEventI18nKey(trigger.event_name), { defaultValue: trigger.event_name })
  }
  return `Webhook · ${trigger.webhook_token.slice(0, 8)}…`
}

function getRunStatusBadgeClass(status: WorkflowRun['status']) {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    case 'running':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
    case 'cancelled':
      return 'bg-muted text-muted-foreground'
    case 'pending':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function toPathSegments(path: string) {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function getValueByPath(source: unknown, path: string): unknown {
  if (!path.trim()) {
    return undefined
  }
  const segments = toPathSegments(path)
  let cursor: unknown = source
  for (const segment of segments) {
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return undefined
      }
      cursor = cursor[index]
      continue
    }
    if (cursor == null || typeof cursor !== 'object') {
      return undefined
    }
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function setValueByPath(target: Record<string, unknown>, path: string, value: unknown) {
  const segments = toPathSegments(path)
  if (segments.length === 0) {
    return
  }

  let cursor: Record<string, unknown> = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]
    const next = cursor[segment]
    if (next == null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[segment] = {}
    }
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[segments[segments.length - 1]] = value
}

function buildStepPreviewOutput(step: WorkflowStep, triggerPayload: Record<string, unknown>) {
  const baseOutput =
    step.action_config && typeof step.action_config === 'object'
      ? structuredClone(step.action_config) as Record<string, unknown>
      : {}

  for (const binding of step.input_bindings) {
    const value = getValueByPath(triggerPayload, binding.source_path)
    if (value === undefined) {
      continue
    }
    setValueByPath(baseOutput, binding.target_path, value)
  }

  return baseOutput
}

function buildTriggerOutputPreview(steps: WorkflowStep[], triggerPayload: Record<string, unknown>) {
  const perStepOutput: Record<string, Record<string, unknown>> = {}

  for (const step of steps) {
    const mappedOutput: Record<string, unknown> = {}
    for (const binding of step.input_bindings) {
      const value = getValueByPath(triggerPayload, binding.source_path)
      if (value === undefined) {
        continue
      }
      setValueByPath(mappedOutput, binding.target_path, value)
    }
    if (Object.keys(mappedOutput).length > 0) {
      perStepOutput[`#${step.sort_order} ${step.name}`] = mappedOutput
    }
  }

  return Object.keys(perStepOutput).length > 0
    ? perStepOutput
    : triggerPayload
}

function formatJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2)
}

export default function WorkflowDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const numId = Number(id)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [showForm, setShowForm] = useState(false)
  const [editingTrigger, setEditingTrigger] = useState<WorkflowTrigger | null>(null)
  const [form, setForm] = useState<WorkflowTriggerCreate>(emptyTriggerForm())
  const [formError, setFormError] = useState('')
  const [showStepForm, setShowStepForm] = useState(false)
  const [editingStep, setEditingStep] = useState<WorkflowStep | null>(null)
  const [stepForm, setStepForm] = useState<WorkflowStepCreate>(emptyStepForm())
  const [stepFormError, setStepFormError] = useState('')
  const [stepFormTaskPayloadText, setStepFormTaskPayloadText] = useState('{}')
  const [stepFormTaskPayloadError, setStepFormTaskPayloadError] = useState('')
  const [copiedToken, setCopiedToken] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<'builder' | 'runs'>('builder')
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null)

  const { data: workflow, isLoading } = useQuery<Workflow>({
    queryKey: ['workflows', id],
    queryFn: () => workflowsApi.get(numId),
  })
  const { data: workflowRuns = [], isLoading: isRunsLoading } = useQuery<WorkflowRun[]>({
    queryKey: ['workflows', id, 'runs'],
    queryFn: () => workflowRunsApi.list(numId),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const runs = query.state.data ?? []
      return runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status)) ? 5000 : false
    },
  })
  const { data: eventDefinitions = [] } = useQuery<SystemEventDef[]>({
    queryKey: ['system-events'],
    queryFn: () => eventsApi.list(),
  })
  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list(),
  })
  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ['profiles'],
    queryFn: () => profilesApi.list(),
  })
  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: () => teamsApi.list(),
  })
  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => authApi.me(),
  })

  const runMutation = useMutation({
    mutationFn: () => workflowsApi.run(numId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows', id] })
      qc.invalidateQueries({ queryKey: ['workflows', id, 'runs'] })
      showToast(t('workflowList.runStarted'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('common.saveError'), 'error'),
  })

  const addMutation = useMutation({
    mutationFn: (data: WorkflowTriggerCreate) => workflowTriggersApi.create(numId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows', id] })
      showToast(t('workflowDetail.triggerAdded'), 'success')
      resetForm()
    },
    onError: (e: Error) => {
      setFormError(e.message)
      showToast(e.message || t('common.saveError'), 'error')
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ triggerId, data }: { triggerId: number; data: Partial<WorkflowTriggerCreate> }) =>
      workflowTriggersApi.update(numId, triggerId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows', id] })
      showToast(t('workflowDetail.triggerUpdated'), 'success')
      resetForm()
    },
    onError: (e: Error) => {
      setFormError(e.message)
      showToast(e.message || t('common.saveError'), 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (triggerId: number) => workflowTriggersApi.delete(numId, triggerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows', id] })
      showToast(t('workflowDetail.triggerDeleted'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('common.saveError'), 'error'),
  })

  const addStepMutation = useMutation({
    mutationFn: (data: WorkflowStepCreate) => workflowStepsApi.create(numId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows', id] })
      showToast(t('workflowDetail.stepAdded'), 'success')
      resetStepForm()
    },
    onError: (e: Error) => {
      setStepFormError(e.message)
      showToast(e.message || t('common.saveError'), 'error')
    },
  })

  const updateStepMutation = useMutation({
    mutationFn: ({ stepId, data }: { stepId: number; data: Partial<WorkflowStepCreate> }) =>
      workflowStepsApi.update(numId, stepId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows', id] })
      showToast(t('workflowDetail.stepUpdated'), 'success')
      resetStepForm()
    },
    onError: (e: Error) => {
      setStepFormError(e.message)
      showToast(e.message || t('common.saveError'), 'error')
    },
  })

  const deleteStepMutation = useMutation({
    mutationFn: (stepId: number) => workflowStepsApi.delete(numId, stepId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows', id] })
      showToast(t('workflowDetail.stepDeleted'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('common.saveError'), 'error'),
  })

  function resetForm() {
    setForm(emptyTriggerForm())
    setEditingTrigger(null)
    setShowForm(false)
    setFormError('')
  }

  function resetStepForm() {
    const nextForm = emptyStepForm(workflow ? getNextStepSortOrder(workflow.steps) : 1)
    setStepForm(nextForm)
    setStepFormTaskPayloadText(
      JSON.stringify(normalizeTaskConfig(nextForm.action_config?.task).payload, null, 2),
    )
    setStepFormTaskPayloadError('')
    setEditingStep(null)
    setShowStepForm(false)
    setStepFormError('')
  }

  function openAddForm() {
    if ((workflow?.triggers.length ?? 0) > 0) {
      showToast(t('workflowDetail.singleTriggerLimit'), 'error')
      return
    }
    setEditingTrigger(null)
    const base = emptyTriggerForm()
    const firstDeviceId = devices.length > 0 ? devices[0].id : null
    setForm({ ...base, event_source_id: firstDeviceId })
    setFormError('')
    setShowForm(true)
  }

  function openAddStepForm() {
    setEditingStep(null)
    const nextForm = emptyStepForm(workflow ? getNextStepSortOrder(workflow.steps) : 1)
    setStepForm(nextForm)
    setStepFormTaskPayloadText(
      JSON.stringify(normalizeTaskConfig(nextForm.action_config?.task).payload, null, 2),
    )
    setStepFormTaskPayloadError('')
    setStepFormError('')
    setShowStepForm(true)
  }

  function openEditForm(trigger: WorkflowTrigger) {
    setEditingTrigger(trigger)
    setForm({
      trigger_type: trigger.trigger_type,
      is_active: trigger.is_active,
      periodic_schedule_type: trigger.periodic_schedule_type || 'once',
      run_at: trigger.run_at
        ? new Date(trigger.run_at).toISOString().slice(0, 16)
        : null,
      interval_seconds: trigger.interval_seconds,
      cron_expression: trigger.cron_expression || '',
      event_name: trigger.event_name || '',
      event_source_type: trigger.event_source_type || DEFAULT_EVENT_SOURCE_TYPE,
      event_source_id: trigger.event_source_id,
      event_filter: trigger.event_filter || {},
      webhook_secret: '',
    })
    setFormError('')
    setShowForm(true)
  }

  function openEditStepForm(step: WorkflowStep) {
    const actionConfig = buildActionConfig(step.action_type || 'custom', step.action_config, workflow?.profile_id ?? null)
    const taskConfig = normalizeTaskConfig(actionConfig.task)
    const scheduleConfig = normalizeScheduleConfig(
      {
        ...actionConfig.schedule,
        run_at: actionConfig.schedule?.run_at ? toDateTimeLocalValue(actionConfig.schedule.run_at) : null,
      },
      workflow?.profile_id ?? null,
    )
    setEditingStep(step)
    setStepForm({
      name: step.name,
      description: step.description,
      sort_order: step.sort_order,
      action_type: step.action_type || 'custom',
      action_config:
        step.action_type === 'create_schedule'
          ? {
              task: taskConfig,
              schedule: scheduleConfig,
            }
          : step.action_type === 'create_task'
            ? {
                task: taskConfig,
              }
            : step.action_config ?? {},
      input_bindings: step.input_bindings ?? [],
    })
    setStepFormTaskPayloadText(JSON.stringify(taskConfig.payload, null, 2))
    setStepFormTaskPayloadError('')
    setStepFormError('')
    setShowStepForm(true)
  }

  function setField<K extends keyof WorkflowTriggerCreate>(key: K, value: WorkflowTriggerCreate[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function setStepField<K extends keyof WorkflowStepCreate>(key: K, value: WorkflowStepCreate[K]) {
    setStepForm((current) => ({ ...current, [key]: value }))
  }

  function setStepActionType(actionType: WorkflowStepActionType) {
    const nextActionConfig =
      actionType === 'custom'
        ? {}
        : buildActionConfig(actionType, stepForm.action_config, workflow?.profile_id ?? null)
    setStepForm((current) => ({
      ...current,
      action_type: actionType,
      action_config: nextActionConfig,
    }))
    setStepFormTaskPayloadText(JSON.stringify(normalizeTaskConfig(nextActionConfig.task).payload, null, 2))
    setStepFormTaskPayloadError('')
  }

  function setStepTaskField<K extends keyof WorkflowStepTaskConfig>(
    key: K,
    value: WorkflowStepTaskConfig[K],
  ) {
    setStepForm((current) => ({
      ...current,
      action_config: {
        ...current.action_config,
        task: {
          ...normalizeTaskConfig(current.action_config?.task),
          [key]: value,
        },
      },
    }))
  }

  function setStepScheduleField<K extends keyof WorkflowStepScheduleConfig>(
    key: K,
    value: WorkflowStepScheduleConfig[K],
  ) {
    setStepForm((current) => ({
      ...current,
      action_config: {
        ...current.action_config,
        schedule: {
          ...normalizeScheduleConfig(current.action_config?.schedule, workflow?.profile_id ?? null),
          [key]: value,
        },
      },
    }))
  }

  function updateStepInputBinding(
    index: number,
    key: keyof WorkflowStepInputBinding,
    value: WorkflowStepInputBinding[keyof WorkflowStepInputBinding],
  ) {
    const nextBindings = [...(stepForm.input_bindings ?? [])]
    nextBindings[index] = {
      ...(nextBindings[index] ?? EMPTY_STEP_BINDING),
      [key]: value,
    }
    setStepField('input_bindings', nextBindings)
  }

  function addStepInputBinding() {
    setStepField('input_bindings', [...(stepForm.input_bindings ?? []), { ...EMPTY_STEP_BINDING }])
  }

  function removeStepInputBinding(index: number) {
    setStepField(
      'input_bindings',
      (stepForm.input_bindings ?? []).filter((_, bindingIndex) => bindingIndex !== index),
    )
  }

  function parseStepTaskPayload() {
    try {
      const parsed = JSON.parse(stepFormTaskPayloadText) as Record<string, unknown>
      setStepTaskField('payload', parsed)
      setStepFormTaskPayloadText(JSON.stringify(parsed, null, 2))
      setStepFormTaskPayloadError('')
      return parsed
    } catch {
      setStepFormTaskPayloadError(t('workflowDetail.invalidJson'))
      return null
    }
  }

  function handleTriggerSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!editingTrigger && (workflow?.triggers.length ?? 0) > 0) {
      setFormError(t('workflowDetail.singleTriggerLimit'))
      return
    }
    const payload: WorkflowTriggerCreate = { ...form }
    if (payload.trigger_type === 'periodic' && payload.run_at) {
      const parsed = new Date(payload.run_at)
      if (isNaN(parsed.getTime())) {
        setFormError(t('workflowDetail.invalidDate'))
        return
      }
      payload.run_at = parsed.toISOString()
    }
    if (payload.trigger_type === 'event' && payload.event_source_id == null) {
      setFormError(t('workflowDetail.eventSourceRequired'))
      return
    }
    if (editingTrigger) {
      updateMutation.mutate({ triggerId: editingTrigger.id, data: payload })
    } else {
      addMutation.mutate(payload)
    }
  }

  function handleStepSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (stepFormTaskPayloadError) {
      return
    }

    const parsedTaskPayload =
      stepForm.action_type === 'create_task' || stepForm.action_type === 'create_schedule'
        ? parseStepTaskPayload()
        : null
    if (
      (stepForm.action_type === 'create_task' || stepForm.action_type === 'create_schedule') &&
      !parsedTaskPayload
    ) {
      return
    }

    const inputBindings = (stepForm.input_bindings ?? [])
      .filter((binding) => binding.source_path.trim() || binding.target_path.trim())
      .map((binding) => ({
        source_type: 'trigger' as const,
        source_path: binding.source_path.trim(),
        target_path: binding.target_path.trim(),
      }))

    if (inputBindings.some((binding) => !binding.source_path || !binding.target_path)) {
      setStepFormError(t('workflowDetail.inputBindingIncomplete'))
      return
    }

    const actionType = stepForm.action_type ?? 'custom'
    const actionConfig = buildActionConfig(actionType, stepForm.action_config, workflow?.profile_id ?? null)
    const taskConfig =
      actionType === 'create_task' || actionType === 'create_schedule'
        ? {
            ...normalizeTaskConfig(actionConfig.task),
            payload: parsedTaskPayload ?? normalizeTaskConfig(actionConfig.task).payload,
          }
        : undefined
    const scheduleConfig =
      actionType === 'create_schedule'
        ? normalizeScheduleConfig(actionConfig.schedule, workflow?.profile_id ?? null)
        : undefined

    const normalizedScheduleConfig = scheduleConfig ? { ...scheduleConfig } : undefined
    if (normalizedScheduleConfig?.schedule_type === 'once' && normalizedScheduleConfig.run_at) {
      const parsedRunAt = new Date(normalizedScheduleConfig.run_at)
      if (isNaN(parsedRunAt.getTime())) {
        setStepFormError(t('workflowDetail.invalidDate'))
        return
      }
      normalizedScheduleConfig.run_at = parsedRunAt.toISOString()
    }

    const payload: WorkflowStepCreate = {
      ...stepForm,
      sort_order: Number(stepForm.sort_order ?? (workflow ? getNextStepSortOrder(workflow.steps) : 1)),
      action_type: actionType,
      action_config:
        actionType === 'create_schedule'
          ? {
              task: taskConfig,
              schedule: normalizedScheduleConfig,
            }
          : actionType === 'create_task'
            ? { task: taskConfig }
            : stepForm.action_config ?? {},
      input_bindings: inputBindings,
    }
    if (!payload.sort_order || payload.sort_order < 1) {
      setStepFormError(t('workflowDetail.stepOrderInvalid'))
      return
    }
    setStepFormError('')
    if (editingStep) {
      updateStepMutation.mutate({ stepId: editingStep.id, data: payload })
    } else {
      addStepMutation.mutate(payload)
    }
  }

  function copyToken(trigger: WorkflowTrigger) {
    navigator.clipboard.writeText(trigger.webhook_token).then(() => {
      setCopiedToken(trigger.id)
      setTimeout(() => setCopiedToken(null), 2000)
    }).catch(() => {
      showToast(t('common.saveError'), 'error')
    })
  }

  const cronPreviews =
    form.trigger_type === 'periodic' &&
    form.periodic_schedule_type === 'cron' &&
    form.cron_expression
      ? cronNextRuns(form.cron_expression, 3)
      : []
  const selectedSource = (form.event_source_type || DEFAULT_EVENT_SOURCE_TYPE) as EventSourceType
  const availableEvents = eventDefinitions.filter((item) => item.source_type === selectedSource)
  const sourceOptions =
    selectedSource === 'device'
      ? devices.map((item) => ({ id: item.id, label: item.name }))
      : selectedSource === 'team'
        ? teams.map((item) => ({ id: item.id, label: item.name }))
        : me
          ? [{ id: me.id, label: me.display_name || me.username }]
          : []

  function updateEventSource(sourceType: EventSourceType) {
    const nextOptions =
      sourceType === 'device'
        ? devices.map((item) => item.id)
        : sourceType === 'team'
          ? teams.map((item) => item.id)
          : me
            ? [me.id]
            : []
    const nextSourceId = nextOptions.length > 0 ? nextOptions[0] : null
    setForm((f) => ({
      ...f,
      event_source_type: sourceType,
      event_source_id: nextSourceId,
      event_name: '',
    }))
  }

  function updateEventSourceId(value: string) {
    const parsed = Number(value)
    setField('event_source_id', Number.isFinite(parsed) ? parsed : null)
  }

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>
  }
  if (!workflow) {
    return <p className="text-destructive">{t('workflowDetail.notFound')}</p>
  }

  const nextStepSortOrder = getNextStepSortOrder(workflow.steps)
  const hasTrigger = workflow.triggers.length > 0
  const isPending = addMutation.isPending || updateMutation.isPending
  const isStepPending = addStepMutation.isPending || updateStepMutation.isPending
  const stepActionType = stepForm.action_type ?? 'custom'
  const stepTaskConfig = normalizeTaskConfig(stepForm.action_config?.task)
  const stepScheduleConfig = normalizeScheduleConfig(stepForm.action_config?.schedule, workflow.profile_id)
  const stepScheduleCronPreviews =
    stepActionType === 'create_schedule' &&
    stepScheduleConfig.schedule_type === 'cron' &&
    stepScheduleConfig.cron_expression
      ? cronNextRuns(stepScheduleConfig.cron_expression, 3)
      : []
  const workflowSteps = workflow.steps
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate('/workflow')}>
            <ArrowLeft className="size-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{workflow.name}</h1>
            {workflow.description && (
              <p className="mt-0.5 text-sm text-muted-foreground">{workflow.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {workflow.status === 'active' ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              <CheckCircle2 className="size-3" />
              {t('workflowList.active')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              <XCircle className="size-3" />
              {t('workflowList.inactive')}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
          >
            <Play className="mr-1 size-4 text-green-600" />
            {t('workflowDetail.run')}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to={`/workflow/${id}/edit`}>
              <Pencil className="mr-1 size-4" />
              {t('workflowDetail.edit')}
            </Link>
          </Button>
        </div>
      </div>

      <div className="inline-flex w-fit rounded-lg border border-border bg-muted p-1">
        <button
          type="button"
          onClick={() => setActiveTab('builder')}
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${activeTab === 'builder' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          {t('workflowDetail.tabBuilder')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('runs')}
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${activeTab === 'runs' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          {t('workflowDetail.tabRuns')}
        </button>
      </div>

      {activeTab === 'builder' && (
        <>
          {/* ── Triggers section (above steps) ─────────────────────────────────── */}
          <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{t('workflowDetail.triggersTitle')}</h2>
          {!showForm && !hasTrigger && (
            <Button size="sm" onClick={openAddForm}>
              <Plus className="mr-1 size-4" />
              {t('workflowDetail.addTrigger')}
            </Button>
          )}
        </div>
        {!showForm && hasTrigger && (
          <p className="text-xs text-muted-foreground">{t('workflowDetail.singleTriggerLimit')}</p>
        )}

        {/* Add / Edit trigger form */}
        {showForm && (
          <div className="rounded-lg border border-border p-4">
            <h3 className="mb-4 text-sm font-semibold">
              {editingTrigger
                ? t('workflowDetail.editTriggerTitle')
                : t('workflowDetail.addTriggerTitle')}
            </h3>
            <form onSubmit={handleTriggerSubmit} className="flex flex-col gap-4">
              {/* Trigger type */}
              <label className="flex flex-col gap-1 text-sm">
                {t('workflowDetail.triggerType')}
                <select
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  value={form.trigger_type}
                  onChange={(e) => setField('trigger_type', e.target.value as TriggerType)}
                >
                  {TRIGGER_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`workflowDetail.${type}`)}
                    </option>
                  ))}
                </select>
              </label>

              {/* Active toggle */}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.is_active ?? true}
                  onChange={(e) => setField('is_active', e.target.checked)}
                  className="rounded"
                />
                {t('workflowDetail.isActive')}
              </label>

              {/* Periodic fields */}
              {form.trigger_type === 'periodic' && (
                <>
                  <label className="flex flex-col gap-1 text-sm">
                    {t('workflowDetail.periodicScheduleType')}
                    <select
                      className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                      value={form.periodic_schedule_type || 'once'}
                      onChange={(e) =>
                        setField('periodic_schedule_type', e.target.value as PeriodicScheduleType)
                      }
                    >
                      {PERIODIC_SCHEDULE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(`workflowDetail.${type}`)}
                        </option>
                      ))}
                    </select>
                  </label>

                  {form.periodic_schedule_type === 'once' && (
                    <label className="flex flex-col gap-1 text-sm">
                      {t('workflowDetail.runAt')}
                      <input
                        required
                        type="datetime-local"
                        className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                        value={form.run_at ?? ''}
                        onChange={(e) => setField('run_at', e.target.value)}
                      />
                    </label>
                  )}

                  {form.periodic_schedule_type === 'interval' && (
                    <label className="flex flex-col gap-1 text-sm">
                      {t('workflowDetail.intervalSeconds')}
                      <input
                        required
                        type="number"
                        min={1}
                        className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                        value={form.interval_seconds ?? ''}
                        onChange={(e) => setField('interval_seconds', Number(e.target.value))}
                      />
                    </label>
                  )}

                  {form.periodic_schedule_type === 'cron' && (
                    <div className="flex flex-col gap-2 text-sm">
                      <label className="flex flex-col gap-1">
                        {t('workflowDetail.cronExpression')}
                        <input
                          required
                          className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                          value={form.cron_expression ?? ''}
                          onChange={(e) => setField('cron_expression', e.target.value)}
                          placeholder="* * * * *"
                        />
                      </label>
                      {cronPreviews.length > 0 && (
                        <div className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
                          {cronPreviews.map((d, i) => (
                            <p key={i}>{d}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Event fields */}
              {form.trigger_type === 'event' && (
                <div className="flex flex-col gap-4">
                  {/* Phase 2.3.7 — TikTok preset hint cho event_filter */}
                  <TiktokWorkflowHint mode="trigger" />
                  <label className="flex flex-col gap-1 text-sm">
                    {t('workflowDetail.eventSourceType')}
                    <select
                      className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                      value={form.event_source_type || 'device'}
                      onChange={(e) => updateEventSource(e.target.value as EventSourceType)}
                    >
                      {EVENT_SOURCE_TYPES.map((sourceType) => (
                        <option key={sourceType} value={sourceType}>
                          {t(`workflowDetail.eventSource${sourceType.charAt(0).toUpperCase()}${sourceType.slice(1)}`)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1 text-sm">
                    {t('workflowDetail.eventSource')}
                    <select
                      required
                      className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                      value={form.event_source_id ?? ''}
                      onChange={(e) => updateEventSourceId(e.target.value)}
                    >
                      {sourceOptions.length === 0 ? (
                        <option value="">{t('workflowDetail.noEventSourceOptions')}</option>
                      ) : (
                        sourceOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))
                      )}
                    </select>
                  </label>

                  <div className="flex flex-col gap-2 text-sm">
                    <p className="font-medium">{t('workflowDetail.selectEvent')}</p>
                    {availableEvents.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('workflowDetail.noEventsForSource')}</p>
                    ) : (
                      <div className="grid gap-2">
                        {availableEvents.map((eventDef) => (
                          <label key={`${eventDef.source_type}:${eventDef.name}`} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={form.event_name === eventDef.name}
                              onChange={() =>
                                setField(
                                  'event_name',
                                  form.event_name === eventDef.name ? '' : eventDef.name,
                                )
                              }
                              className="rounded"
                            />
                            <span>
                              {t(getEventI18nKey(eventDef.name), { defaultValue: eventDef.label })}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Webhook fields */}
              {form.trigger_type === 'webhook' && (
                <label className="flex flex-col gap-1 text-sm">
                  {t('workflowDetail.webhookSecret')}
                  <input
                    type="password"
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    value={form.webhook_secret ?? ''}
                    onChange={(e) => setField('webhook_secret', e.target.value)}
                    placeholder="optional"
                  />
                </label>
              )}

              {formError && <p className="text-sm text-destructive">{formError}</p>}

              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={isPending}>
                  {isPending ? t('common.saving') : t('common.save')}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={resetForm}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          </div>
        )}

        {/* Triggers list */}
        {workflow.triggers.length === 0 && !showForm ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
            <p className="text-sm font-medium text-muted-foreground">
              {t('workflowDetail.noTriggers')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              {t('workflowDetail.noTriggersHint')}
            </p>
          </div>
        ) : workflow.triggers.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                    {t('workflowDetail.triggerType')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                    {t('workflowDetail.isActive')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                    {t('workflowDetail.nextRun')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                    {t('workflowDetail.lastTriggered')}
                  </th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {workflow.triggers.map((trigger) => (
                  <tr key={trigger.id} className="border-t border-border hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <span className="font-medium capitalize">
                        {t(`workflowDetail.${trigger.trigger_type}`)}
                      </span>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {trigger.trigger_type === 'periodic' && trigger.periodic_schedule_type && (
                          <span className="capitalize">
                            {t(`workflowDetail.${trigger.periodic_schedule_type}`)}
                            {trigger.periodic_schedule_type === 'interval' &&
                              trigger.interval_seconds != null &&
                              ` · ${trigger.interval_seconds}s`}
                            {trigger.periodic_schedule_type === 'cron' &&
                              trigger.cron_expression &&
                              ` · ${trigger.cron_expression}`}
                            {trigger.periodic_schedule_type === 'once' &&
                              trigger.run_at &&
                              ` · ${new Date(trigger.run_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}`}
                          </span>
                        )}
                        {trigger.trigger_type === 'event' && (
                          <span>
                            {t(getEventI18nKey(trigger.event_name), { defaultValue: trigger.event_name })}
                            {trigger.event_source_type && trigger.event_source_id != null
                              ? ` · ${t(
                                `workflowDetail.eventSource${trigger.event_source_type.charAt(0).toUpperCase()}${trigger.event_source_type.slice(1)}`,
                              )} #${trigger.event_source_id}`
                              : ''}
                          </span>
                        )}
                        {trigger.trigger_type === 'webhook' && (
                          <span className="flex items-center gap-1">
                            <span className="font-mono text-xs">{trigger.webhook_token.slice(0, 8)}…</span>
                            <button
                              type="button"
                              onClick={() => copyToken(trigger)}
                              className="rounded p-0.5 hover:bg-muted"
                              aria-label={t('workflowDetail.copyToken')}
                            >
                              {copiedToken === trigger.id ? (
                                <Check className="size-3 text-green-600" />
                              ) : (
                                <Copy className="size-3" />
                              )}
                            </button>
                          </span>
                        )}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      {trigger.is_active ? (
                        <CheckCircle2 className="size-4 text-green-600" />
                      ) : (
                        <XCircle className="size-4 text-muted-foreground" />
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {trigger.next_run_at
                        ? new Date(trigger.next_run_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })
                        : t('workflowDetail.never')}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {trigger.last_triggered_at
                        ? new Date(trigger.last_triggered_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })
                        : t('workflowDetail.never')}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => openEditForm(trigger)}
                          aria-label={t('workflowDetail.editTrigger')}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => deleteMutation.mutate(trigger.id)}
                          disabled={deleteMutation.isPending}
                          aria-label={t('workflowDetail.deleteTrigger')}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* ── Steps section – shown as node flow ─────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{t('workflowDetail.stepsTitle')}</h2>
          {!showStepForm && (
            <Button size="sm" onClick={openAddStepForm}>
              <Plus className="mr-1 size-4" />
              {t('workflowDetail.addStep')}
            </Button>
          )}
        </div>

        {/* Step form */}
        {showStepForm && (
          <div className="rounded-lg border border-border p-4">
            <h3 className="mb-4 text-sm font-semibold">
              {editingStep ? t('workflowDetail.editStepTitle') : t('workflowDetail.addStepTitle')}
            </h3>
            <form onSubmit={handleStepSubmit} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1 text-sm">
                {t('workflowDetail.stepActionType')}
                <select
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  value={stepActionType}
                  onChange={(e) => setStepActionType(e.target.value as WorkflowStepActionType)}
                >
                  {STEP_ACTION_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`workflowDetail.actionType${actionTypeI18nSuffix(type)}`)}
                    </option>
                  ))}
                </select>
              </label>

              {/* Phase 2.6 — Full editor cho action_config khi custom.
                  Dropdown preset + JSON textarea + validate client-side.
                  Auto sync back vào stepForm.action_config. */}
              {stepActionType === 'custom' && (
                <ChatbotActionConfigEditor
                  value={(stepForm.action_config as Record<string, unknown>) || {}}
                  onChange={(next, isValid) => {
                    if (isValid) {
                      setStepField('action_config', next as WorkflowStepActionConfig)
                    }
                  }}
                />
              )}

              <label className="flex flex-col gap-1 text-sm">
                {t('workflowDetail.stepName')}
                <input
                  required
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  value={stepForm.name}
                  onChange={(e) => setStepField('name', e.target.value)}
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                {t('workflowDetail.stepDescription')}
                <textarea
                  rows={3}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  value={stepForm.description ?? ''}
                  onChange={(e) => setStepField('description', e.target.value)}
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                {t('workflowDetail.stepOrder')}
                <input
                  required
                  min={1}
                  type="number"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  value={stepForm.sort_order ?? nextStepSortOrder}
                  onChange={(e) => setStepField('sort_order', Number(e.target.value))}
                />
              </label>

              {(stepActionType === 'create_task' || stepActionType === 'create_schedule') && (
                <fieldset className="rounded-lg border border-border p-4">
                  <legend className="px-1 text-sm font-medium">
                    {t('workflowDetail.taskConfigTitle')}
                  </legend>
                  <div className="mt-2 flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                      {t('workflowDetail.taskName')}
                      <input
                        className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                        value={stepTaskConfig.name}
                        onChange={(e) => setStepTaskField('name', e.target.value)}
                      />
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      {t('workflowDetail.taskDescription')}
                      <textarea
                        rows={3}
                        className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                        value={stepTaskConfig.description}
                        onChange={(e) => setStepTaskField('description', e.target.value)}
                      />
                    </label>

                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="flex flex-col gap-1 text-sm">
                        {t('workflowDetail.taskType')}
                        <select
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                          value={stepTaskConfig.task_type}
                          onChange={(e) => setStepTaskField('task_type', e.target.value as TaskType)}
                        >
                          {TASK_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {type}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="flex flex-col gap-1 text-sm">
                        {t('workflowDetail.taskStatus')}
                        <select
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                          value={stepTaskConfig.status}
                          onChange={(e) => setStepTaskField('status', e.target.value as TaskStatus)}
                        >
                          {TASK_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                      {t('workflowDetail.taskDevice')}
                      <select
                        className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                        value={stepTaskConfig.device_id ?? ''}
                        onChange={(e) =>
                          setStepTaskField('device_id', e.target.value ? Number(e.target.value) : null)
                        }
                      >
                        <option value="">{t('workflowDetail.deviceNone')}</option>
                        {devices.map((device) => (
                          <option key={device.id} value={device.id}>
                            {device.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      {t('workflowDetail.taskPayload')}
                      <textarea
                        rows={5}
                        className={`rounded-lg border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring ${stepFormTaskPayloadError ? 'border-destructive' : 'border-border'}`}
                        value={stepFormTaskPayloadText}
                        onChange={(e) => setStepFormTaskPayloadText(e.target.value)}
                        onBlur={parseStepTaskPayload}
                      />
                      {stepFormTaskPayloadError && (
                        <span className="text-xs text-destructive">{stepFormTaskPayloadError}</span>
                      )}
                    </label>
                  </div>
                </fieldset>
              )}

              {stepActionType === 'create_schedule' && (
                <fieldset className="rounded-lg border border-border p-4">
                  <legend className="px-1 text-sm font-medium">
                    {t('workflowDetail.scheduleConfigTitle')}
                  </legend>
                  <div className="mt-2 flex flex-col gap-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="flex flex-col gap-1 text-sm">
                        {t('workflowDetail.scheduleType')}
                        <select
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                          value={stepScheduleConfig.schedule_type}
                          onChange={(e) =>
                            setStepScheduleField('schedule_type', e.target.value as ScheduleType)
                          }
                        >
                          {SCHEDULE_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {t(`workflowDetail.${type}`)}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="flex flex-col gap-1 text-sm">
                        {t('workflowDetail.profile')}
                        <select
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                          value={stepScheduleConfig.profile_id ?? ''}
                          onChange={(e) =>
                            setStepScheduleField('profile_id', e.target.value ? Number(e.target.value) : null)
                          }
                        >
                          <option value="">{t('workflowDetail.profileNone')}</option>
                          {profiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {stepScheduleConfig.schedule_type === 'once' && (
                      <label className="flex flex-col gap-1 text-sm">
                        {t('workflowDetail.runAt')}
                        <input
                          type="datetime-local"
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                          value={stepScheduleConfig.run_at ?? ''}
                          onChange={(e) => setStepScheduleField('run_at', e.target.value || null)}
                        />
                      </label>
                    )}

                    {stepScheduleConfig.schedule_type === 'interval' && (
                      <label className="flex flex-col gap-1 text-sm">
                        {t('workflowDetail.intervalSeconds')}
                        <input
                          min={1}
                          type="number"
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                          value={stepScheduleConfig.interval_seconds ?? ''}
                          onChange={(e) =>
                            setStepScheduleField(
                              'interval_seconds',
                              e.target.value ? Number(e.target.value) : null,
                            )
                          }
                        />
                      </label>
                    )}

                    {stepScheduleConfig.schedule_type === 'cron' && (
                      <div className="flex flex-col gap-2 text-sm">
                        <label className="flex flex-col gap-1">
                          {t('workflowDetail.cronExpression')}
                          <input
                            className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                            value={stepScheduleConfig.cron_expression}
                            onChange={(e) => setStepScheduleField('cron_expression', e.target.value)}
                            placeholder="* * * * *"
                          />
                        </label>
                        {stepScheduleCronPreviews.length > 0 && (
                          <div className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
                            {stepScheduleCronPreviews.map((dateValue, index) => (
                              <p key={index}>{dateValue}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <fieldset className="rounded-lg border border-border p-3">
                      <legend className="px-1 text-sm font-medium">
                        {t('workflowDetail.retrySettings')}
                      </legend>
                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                          {t('workflowDetail.maxRetries')}
                          <input
                            type="number"
                            min={0}
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                            value={stepScheduleConfig.max_retries}
                            onChange={(e) => setStepScheduleField('max_retries', Number(e.target.value))}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                          {t('workflowDetail.retryDelaySeconds')}
                          <input
                            type="number"
                            min={1}
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                            value={stepScheduleConfig.retry_delay_seconds}
                            onChange={(e) =>
                              setStepScheduleField('retry_delay_seconds', Number(e.target.value))
                            }
                          />
                        </label>
                      </div>
                    </fieldset>

                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={stepScheduleConfig.is_active}
                        onChange={(e) => setStepScheduleField('is_active', e.target.checked)}
                        className="rounded"
                      />
                      {t('workflowDetail.isActive')}
                    </label>
                  </div>
                </fieldset>
              )}

              {(stepActionType === 'create_task' || stepActionType === 'create_schedule') && (
                <fieldset className="rounded-lg border border-border p-4">
                  <legend className="px-1 text-sm font-medium">
                    {t('workflowDetail.stepInputBindings')}
                  </legend>
                  <div className="mt-2 flex flex-col gap-3">
                    <p className="text-xs text-muted-foreground">
                      {t('workflowDetail.inputBindingHint')}
                    </p>
                    {(stepForm.input_bindings ?? []).map((binding, index) => (
                      <div key={index} className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-[1fr_1fr_auto]">
                        <label className="flex flex-col gap-1 text-sm">
                          {t('workflowDetail.inputBindingSourcePath')}
                          <input
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                            value={binding.source_path}
                            onChange={(e) => updateStepInputBinding(index, 'source_path', e.target.value)}
                            placeholder={t('workflowDetail.inputBindingSourcePlaceholder')}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                          {t('workflowDetail.inputBindingTargetPath')}
                          <input
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                            value={binding.target_path}
                            onChange={(e) => updateStepInputBinding(index, 'target_path', e.target.value)}
                            placeholder={
                              stepActionType === 'create_schedule'
                                ? t('workflowDetail.inputBindingTargetPlaceholderSchedule')
                                : t('workflowDetail.inputBindingTargetPlaceholderTask')
                            }
                          />
                        </label>
                        <div className="flex items-end">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => removeStepInputBinding(index)}
                          >
                            {t('common.delete')}
                          </Button>
                        </div>
                      </div>
                    ))}
                    <div>
                      <Button type="button" size="sm" variant="outline" onClick={addStepInputBinding}>
                        <Plus className="mr-1 size-4" />
                        {t('workflowDetail.addInputBinding')}
                      </Button>
                    </div>
                  </div>
                </fieldset>
              )}

              {stepFormError && <p className="text-sm text-destructive">{stepFormError}</p>}

              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={isStepPending}>
                  {isStepPending ? t('common.saving') : t('common.save')}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={resetStepForm}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          </div>
        )}

        {/* Node flow */}
        {workflow.steps.length === 0 && !showStepForm ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
            <p className="text-sm font-medium text-muted-foreground">{t('workflowDetail.noSteps')}</p>
            <p className="mt-1 text-xs text-muted-foreground/70">{t('workflowDetail.noStepsHint')}</p>
          </div>
        ) : workflow.steps.length > 0 ? (
          <div className="flex flex-col items-center gap-0">
            {/* Trigger "start" node – only when triggers exist */}
            {workflow.triggers.length > 0 && (
              <>
                <div className="w-full max-w-lg rounded-xl border-2 border-amber-400 bg-amber-50 px-5 py-3 shadow-sm dark:bg-amber-900/20">
                  <div className="flex items-center gap-3">
                    <div className="flex size-8 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-800/40">
                      <Zap className="size-4 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                        {t('workflowDetail.triggersTitle')}
                      </p>
                      <p className="truncate text-sm text-amber-900 dark:text-amber-200">
                        {getTriggerSummary(workflow.triggers[0], t)}
                        {workflow.triggers.length > 1 && (
                          <span className="ml-1 text-xs text-amber-600">
                            +{workflow.triggers.length - 1}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>
                {/* Arrow */}
                <FlowArrow />
              </>
            )}

            {/* Step nodes */}
            {workflow.steps.map((step, index) => (
              <div key={step.id} className="flex w-full max-w-lg flex-col items-center">
                <div className="w-full rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${getActionTypeBg(step.action_type)}`}>
                        {getActionTypeIcon(step.action_type)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">
                            {step.sort_order}
                          </span>
                          <p className="truncate text-sm font-semibold">{step.name}</p>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t(`workflowDetail.actionType${actionTypeI18nSuffix(step.action_type)}`)}
                        </p>
                        {getStepActionSummary(step, t) && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {getStepActionSummary(step, t)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => openEditStepForm(step)}
                        aria-label={t('workflowDetail.editStep')}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => deleteStepMutation.mutate(step.id)}
                        disabled={deleteStepMutation.isPending}
                        aria-label={t('workflowDetail.deleteStep')}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                  {step.description && (
                    <p className="mt-2 text-xs text-muted-foreground pl-12">{step.description}</p>
                  )}
                </div>
                {/* Arrow connector between steps */}
                {index < workflow.steps.length - 1 && <FlowArrow />}
              </div>
            ))}
          </div>
        ) : null}
          </div>
        </>
      )}

      {activeTab === 'runs' && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">{t('workflowDetail.runsTitle')}</h2>
          </div>

          {isRunsLoading ? (
            <p className="text-sm text-muted-foreground">{t('workflowDetail.loadingRuns')}</p>
          ) : workflowRuns.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
              <p className="text-sm font-medium text-muted-foreground">{t('workflowDetail.noRuns')}</p>
              <p className="mt-1 text-xs text-muted-foreground/70">{t('workflowDetail.noRunsHint')}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {workflowRuns.map((run) => {
                const isExpanded = expandedRunId === run.id
                const runTrigger = workflow.triggers.find((trigger) => trigger.id === run.trigger)
                const triggerOutputPreview = buildTriggerOutputPreview(workflowSteps, run.trigger_payload)
                return (
                  <div key={run.id} className="rounded-lg border border-border bg-card">
                    <button
                      type="button"
                      onClick={() => setExpandedRunId(isExpanded ? null : run.id)}
                      className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">
                          {t('workflowDetail.runNumber', { number: run.run_number })}
                        </span>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getRunStatusBadgeClass(run.status)}`}
                        >
                          {run.status}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {run.created_at ? new Date(run.created_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' }) : t('workflowDetail.never')}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="space-y-4 border-t border-border px-4 py-3">
                        <div className="grid gap-2 text-sm md:grid-cols-2">
                          <p>
                            <span className="text-muted-foreground">{t('workflowDetail.triggeredBy')}: </span>
                            {run.triggered_by}
                          </p>
                          <p>
                            <span className="text-muted-foreground">{t('workflowDetail.startedAt')}: </span>
                            {run.started_at ? new Date(run.started_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' }) : t('workflowDetail.never')}
                          </p>
                          <p>
                            <span className="text-muted-foreground">{t('workflowDetail.finishedAt')}: </span>
                            {run.finished_at ? new Date(run.finished_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' }) : t('workflowDetail.never')}
                          </p>
                          <p>
                            <span className="text-muted-foreground">{t('workflowDetail.triggerType')}: </span>
                            {runTrigger ? getTriggerSummary(runTrigger, t) : t('workflowDetail.unconfigured')}
                          </p>
                        </div>

                        {run.error_message && (
                          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                            {run.error_message}
                          </p>
                        )}

                        <div className="grid gap-4 lg:grid-cols-2">
                          <div className="rounded-lg border border-border bg-muted/30 p-3">
                            <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                              {t('workflowDetail.triggerInput')}
                            </p>
                            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-background p-2 text-xs">
                              {formatJson(run.trigger_payload)}
                            </pre>
                          </div>
                          <div className="rounded-lg border border-border bg-muted/30 p-3">
                            <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                              {t('workflowDetail.triggerOutput')}
                            </p>
                            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-background p-2 text-xs">
                              {formatJson(triggerOutputPreview)}
                            </pre>
                          </div>
                        </div>

                        <div className="space-y-3">
                          <p className="text-sm font-medium">{t('workflowDetail.stepsTitle')}</p>
                          {workflowSteps.length === 0 ? (
                            <p className="text-xs text-muted-foreground">{t('workflowDetail.noSteps')}</p>
                          ) : (
                            workflowSteps.map((step) => {
                                const mappedInputs = step.input_bindings.map((binding) => ({
                                  ...binding,
                                  value: getValueByPath(run.trigger_payload, binding.source_path),
                                }))
                                const outputPreview = buildStepPreviewOutput(step, run.trigger_payload)
                                return (
                                  <div key={`${run.id}-${step.id}`} className="rounded-lg border border-border bg-background p-3">
                                    <p className="mb-2 text-sm font-medium">
                                      #{step.sort_order} {step.name}
                                    </p>
                                    <div className="grid gap-3 lg:grid-cols-2">
                                      <div>
                                        <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                                          {t('workflowDetail.stepInput')}
                                        </p>
                                        {mappedInputs.length === 0 ? (
                                          <p className="text-xs text-muted-foreground">{t('workflowDetail.noStepInput')}</p>
                                        ) : (
                                          <div className="space-y-2">
                                            {mappedInputs.map((binding, index) => (
                                              <div key={index} className="rounded border border-border p-2 text-xs">
                                                <p><span className="text-muted-foreground">{t('workflowDetail.inputBindingSourcePath')}:</span> {binding.source_path}</p>
                                                <p><span className="text-muted-foreground">{t('workflowDetail.inputBindingTargetPath')}:</span> {binding.target_path}</p>
                                                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2">{formatJson(binding.value)}</pre>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                      <div>
                                        <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                                          {t('workflowDetail.stepOutput')}
                                        </p>
                                        <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                                          {formatJson(outputPreview)}
                                        </pre>
                                      </div>
                                    </div>
                                  </div>
                                )
                              })
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FlowArrow() {
  return (
    <div className="flex flex-col items-center py-1">
      <div className="h-4 w-0.5 bg-border" />
      <ChevronDown className="size-4 text-border" />
    </div>
  )
}

function getNextStepSortOrder(steps: WorkflowStep[]) {
  return steps.length > 0 ? Math.max(...steps.map((step) => step.sort_order)) + 1 : 1
}

function toDateTimeLocalValue(value: string) {
  const parsed = new Date(value)
  if (isNaN(parsed.getTime())) {
    return ''
  }
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
