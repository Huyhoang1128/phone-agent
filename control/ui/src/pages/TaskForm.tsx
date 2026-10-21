import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { tasksApi, devicesApi } from '@/lib/api'
import type { TaskCreate, TaskType, TaskStatus, Device } from '@/lib/types'

const TASK_TYPES: TaskType[] = ['generic']
const TASK_STATUSES: TaskStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled']

const emptyForm: TaskCreate = {
  name: '',
  description: '',
  task_type: 'generic',
  status: 'pending',
  payload: {},
}

export default function TaskForm() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [payloadError, setPayloadError] = useState('')
  const [error, setError] = useState('')
  const [overrides, setOverrides] = useState<Partial<TaskCreate>>({})
  const [payloadTextOverride, setPayloadTextOverride] = useState<string | null>(null)

  const { data: existing } = useQuery({
    queryKey: ['tasks', id],
    queryFn: () => tasksApi.get(Number(id)),
    enabled: isEdit,
  })

  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list(),
  })

  // Merge existing data (from server) with local overrides
  const base = existing
    ? {
        name: existing.name,
        description: existing.description,
        task_type: existing.task_type,
        status: existing.status,
        payload: existing.payload,
      }
    : emptyForm

  const form: TaskCreate = { ...base, ...overrides }
  const payloadText =
    payloadTextOverride !== null
      ? payloadTextOverride
      : JSON.stringify(form.payload, null, 2)

  function setField<K extends keyof TaskCreate>(key: K, value: TaskCreate[K]) {
    setOverrides((o) => ({ ...o, [key]: value }))
  }

  const mutation = useMutation({
    mutationFn: isEdit
      ? (data: TaskCreate) => tasksApi.update(Number(id), data)
      : tasksApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      showToast(t('common.saveSuccess'), 'success')
      navigate('/tasks')
    },
    onError: (e: Error) => {
      setError(e.message)
      showToast(e.message || t('common.saveError'), 'error')
    },
  })

  function handlePayloadBlur() {
    try {
      const parsed = JSON.parse(payloadText) as Record<string, unknown>
      setField('payload', parsed)
      setPayloadTextOverride(null)
      setPayloadError('')
    } catch {
      setPayloadError('Invalid JSON')
    }
  }

  const selectedDeviceId = (() => {
    const ids = form.payload?.devices_id
    if (Array.isArray(ids) && ids.length > 0) return String(ids[0])
    return ''
  })()

  function handleDeviceChange(deviceId: string) {
    const parsed = (() => {
      try { return JSON.parse(payloadText) as Record<string, unknown> } catch { return form.payload }
    })()
    const updated = { ...parsed, devices_id: deviceId ? [Number(deviceId)] : [] }
    setField('payload', updated)
    setPayloadTextOverride(null)
    setPayloadError('')
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (payloadError) return
    mutation.mutate(form)
  }

  return (
    <div className="max-w-lg">
      <h1 className="mb-4 text-xl font-semibold">{isEdit ? t('taskForm.editTask') : t('taskForm.newTask')}</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          {t('taskForm.name')}
          <input
            required
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t('taskForm.description')}
          <textarea
            rows={3}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={form.description}
            onChange={(e) => setField('description', e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t('taskForm.taskType')}
          <select
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={form.task_type}
            onChange={(e) => setField('task_type', e.target.value as TaskType)}
          >
            {TASK_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t('taskForm.status')}
          <select
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={form.status}
            onChange={(e) => setField('status', e.target.value as TaskStatus)}
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t('taskForm.device')}
          <select
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={selectedDeviceId}
            onChange={(e) => handleDeviceChange(e.target.value)}
          >
            <option value="">{t('taskForm.deviceNone')}</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} ({device.identifier})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t('taskForm.payload')}
          <textarea
            rows={4}
            className={`rounded-lg border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring ${payloadError ? 'border-destructive' : 'border-border'}`}
            value={payloadText}
            onChange={(e) => setPayloadTextOverride(e.target.value)}
            onBlur={handlePayloadBlur}
          />
          {payloadError && <span className="text-xs text-destructive">{t('taskForm.invalidJson')}</span>}
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-2">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? t('common.saving') : isEdit ? t('common.update') : t('common.create')}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate('/tasks')}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  )
}
