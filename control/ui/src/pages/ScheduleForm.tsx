import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { tasksApi, schedulesApi } from '@/lib/api'
import type { Task, ScheduleCreate, ScheduleType } from '@/lib/types'
import { cronNextRuns } from '@/lib/cronPreview'

const SCHEDULE_TYPES: ScheduleType[] = ['once', 'interval', 'cron']

function IntervalInput({
  value,
  onChange,
}: {
  value: number | null
  onChange: (v: number) => void
}) {
  const { t } = useTranslation()
  const [unit, setUnit] = useState<'seconds' | 'minutes' | 'hours'>('minutes')
  const multipliers = { seconds: 1, minutes: 60, hours: 3600 }

  function handleValueChange(raw: number) {
    onChange(raw * multipliers[unit])
  }

  const displayValue = value == null ? '' : Math.round(value / multipliers[unit])

  return (
    <div className="flex gap-2">
      <input
        type="number"
        min={1}
        className="w-28 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        value={displayValue}
        onChange={(e) => handleValueChange(Number(e.target.value))}
      />
      <select
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        value={unit}
        onChange={(e) => setUnit(e.target.value as typeof unit)}
      >
        <option value="seconds">{t('scheduleForm.seconds')}</option>
        <option value="minutes">{t('scheduleForm.minutes')}</option>
        <option value="hours">{t('scheduleForm.hours')}</option>
      </select>
    </div>
  )
}

export default function ScheduleForm() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [taskId, setTaskId] = useState<number | ''>('')
  const [scheduleType, setScheduleType] = useState<ScheduleType>('once')
  const [runAt, setRunAt] = useState('')
  const [intervalSeconds, setIntervalSeconds] = useState<number | null>(null)
  const [cronExpr, setCronExpr] = useState('* * * * *')
  const [maxRetries, setMaxRetries] = useState(0)
  const [retryDelaySec, setRetryDelaySec] = useState(60)
  const [error, setError] = useState('')

  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ['tasks', 'all'],
    queryFn: tasksApi.listAll,
  })

  const mutation = useMutation({
    mutationFn: schedulesApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['schedules'] })
      showToast(t('common.createSuccess'), 'success')
      navigate('/schedules')
    },
    onError: (e: Error) => {
      setError(e.message)
      showToast(e.message || t('common.createError'), 'error')
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!taskId) {
      setError(t('scheduleForm.pleaseSelectTask'))
      return
    }
    const data: ScheduleCreate = {
      task: Number(taskId),
      schedule_type: scheduleType,
      max_retries: maxRetries,
      retry_delay_seconds: retryDelaySec,
    }
    if (scheduleType === 'once') data.run_at = new Date(runAt).toISOString()
    if (scheduleType === 'interval') data.interval_seconds = intervalSeconds
    if (scheduleType === 'cron') data.cron_expression = cronExpr
    mutation.mutate(data)
  }

  const cronPreviews = scheduleType === 'cron' ? cronNextRuns(cronExpr, 3) : []

  return (
    <div className="max-w-lg">
      <h1 className="mb-4 text-xl font-semibold">{t('scheduleForm.title')}</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          {t('scheduleForm.task')}
          <select
            required
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">{t('scheduleForm.selectTask')}</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t('scheduleForm.scheduleType')}
          <select
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={scheduleType}
            onChange={(e) => setScheduleType(e.target.value as ScheduleType)}
          >
            {SCHEDULE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>

        {scheduleType === 'once' && (
          <label className="flex flex-col gap-1 text-sm">
            {t('scheduleForm.runAt')}
            <input
              required
              type="datetime-local"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={runAt}
              onChange={(e) => setRunAt(e.target.value)}
            />
          </label>
        )}

        {scheduleType === 'interval' && (
          <div className="flex flex-col gap-1 text-sm">
            <span>{t('scheduleForm.repeatEvery')}</span>
            <IntervalInput value={intervalSeconds} onChange={setIntervalSeconds} />
          </div>
        )}

        {scheduleType === 'cron' && (
          <div className="flex flex-col gap-2 text-sm">
            <label className="flex flex-col gap-1">
              {t('scheduleForm.cronExpression')}
              <input
                required
                className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
              />
            </label>
            {cronPreviews.length > 0 && (
              <div className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
                <p className="mb-1 font-medium">{t('scheduleForm.nextRuns')}</p>
                {cronPreviews.map((d, i) => (
                  <p key={i}>{d}</p>
                ))}
              </div>
            )}
            {cronPreviews.length === 0 && cronExpr && (
              <p className="text-xs text-destructive">{t('scheduleForm.invalidCron')}</p>
            )}
          </div>
        )}

        <fieldset className="rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('scheduleForm.retrySettings')}</legend>
          <div className="flex gap-4">
            <label className="flex flex-col gap-1 text-sm">
              {t('scheduleForm.maxRetries')}
              <input
                type="number"
                min={0}
                className="w-20 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={maxRetries}
                onChange={(e) => setMaxRetries(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t('scheduleForm.retryDelay')}
              <input
                type="number"
                min={1}
                className="w-28 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={retryDelaySec}
                onChange={(e) => setRetryDelaySec(Number(e.target.value))}
              />
            </label>
          </div>
        </fieldset>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-2">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? t('scheduleForm.creating') : t('scheduleForm.createSchedule')}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate('/schedules')}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  )
}
