import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Pause, Play, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ScheduleStatusBadge, TaskStatusBadge, ExecStatusBadge } from '@/components/StatusBadge'
import { schedulesApi } from '@/lib/api'
import type { Schedule, ScheduleExecution } from '@/lib/types'

export default function ScheduleDetail() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const numId = Number(id)
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data: schedule, isLoading } = useQuery<Schedule>({
    queryKey: ['schedules', id],
    queryFn: () => schedulesApi.get(numId),
    refetchInterval: 30_000,
  })

  const { data: executions = [] } = useQuery<ScheduleExecution[]>({
    queryKey: ['schedules', id, 'executions'],
    queryFn: () => schedulesApi.executions(numId),
    refetchInterval: 30_000,
  })

  const pauseMutation = useMutation({
    mutationFn: () => schedulesApi.pause(numId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules', id] }),
  })

  const resumeMutation = useMutation({
    mutationFn: () => schedulesApi.resume(numId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules', id] }),
  })

  if (isLoading) return <p className="text-muted-foreground">{t('common.loading')}</p>
  if (!schedule) return <p className="text-destructive">{t('scheduleDetail.notFound')}</p>

  const isPaused = schedule.status === 'paused'
  const isActive = schedule.status === 'active'

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{schedule.task.name}</h1>
          <p className="text-sm text-muted-foreground">
            {t('scheduleDetail.schedule')} #{schedule.id} · {schedule.schedule_type}
          </p>
        </div>
        <div className="flex gap-2">
          {isActive && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => pauseMutation.mutate()}
              disabled={pauseMutation.isPending}
            >
              <Pause className="mr-1 size-4" />
              {t('scheduleDetail.pause')}
            </Button>
          )}
          {isPaused && (
            <Button
              size="sm"
              onClick={() => resumeMutation.mutate()}
              disabled={resumeMutation.isPending}
            >
              <Play className="mr-1 size-4" />
              {t('scheduleDetail.resume')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => navigate(`/tasks/${schedule.task.id}`)}>
            <Pencil className="mr-1 size-4" />
            {t('scheduleDetail.editTask')}
          </Button>
        </div>
      </div>

      {/* Info cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <InfoCard label={t('scheduleDetail.statusLabel')}>
          <ScheduleStatusBadge status={schedule.status} />
        </InfoCard>
        <InfoCard label={t('scheduleDetail.taskStatus')}>
          <TaskStatusBadge status={schedule.task.status} />
        </InfoCard>
        <InfoCard label={t('scheduleDetail.nextRun')}>
          {schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' }) : '—'}
        </InfoCard>
        <InfoCard label={t('scheduleDetail.lastRun')}>
          {schedule.last_run_at ? new Date(schedule.last_run_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' }) : '—'}
        </InfoCard>
        <InfoCard label={t('scheduleDetail.retries')}>
          {schedule.retry_count} / {schedule.max_retries}
        </InfoCard>
        <InfoCard label={t('scheduleDetail.retryDelay')}>{schedule.retry_delay_seconds}s</InfoCard>
        {schedule.schedule_type === 'interval' && (
          <InfoCard label={t('scheduleDetail.interval')}>{schedule.interval_seconds}s</InfoCard>
        )}
        {schedule.schedule_type === 'cron' && (
          <InfoCard label={t('scheduleDetail.cron')}>{schedule.cron_expression}</InfoCard>
        )}
        {schedule.schedule_type === 'once' && schedule.run_at && (
          <InfoCard label={t('scheduleDetail.runAt')}>{new Date(schedule.run_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}</InfoCard>
        )}
      </div>

      {/* Execution history */}
      <div>
        <h2 className="mb-2 text-base font-semibold">{t('scheduleDetail.executionHistory')}</h2>
        {executions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('scheduleDetail.noExecutions')}</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">{t('scheduleDetail.execId')}</th>
                  <th className="px-4 py-2 text-left font-medium">{t('scheduleDetail.started')}</th>
                  <th className="px-4 py-2 text-left font-medium">{t('scheduleDetail.finished')}</th>
                  <th className="px-4 py-2 text-left font-medium">{t('scheduleDetail.result')}</th>
                  <th className="px-4 py-2 text-left font-medium">{t('scheduleDetail.error')}</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((ex) => (
                  <tr key={ex.id} className="border-t border-border hover:bg-muted/50">
                    <td className="px-4 py-2 text-muted-foreground">{ex.id}</td>
                    <td className="px-4 py-2">{new Date(ex.started_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}</td>
                    <td className="px-4 py-2">
                      {ex.finished_at ? new Date(ex.finished_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' }) : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <ExecStatusBadge status={ex.result_status} />
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {ex.error_message || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function InfoCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <div className="text-sm font-medium">{children}</div>
    </div>
  )
}
