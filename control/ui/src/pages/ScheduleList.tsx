import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ScheduleStatusBadge } from '@/components/StatusBadge'
import { schedulesApi } from '@/lib/api'
import type { Schedule } from '@/lib/types'

export default function ScheduleList() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: schedules = [], isLoading } = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: schedulesApi.list,
  })

  const deleteMutation = useMutation({
    mutationFn: schedulesApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  if (isLoading) return <p className="text-muted-foreground">{t('scheduleList.loadingSchedules')}</p>

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('scheduleList.title')}</h1>
        <Button asChild size="sm">
          <Link to="/schedules/new">
            <Plus className="mr-1 size-4" />
            {t('scheduleList.newSchedule')}
          </Link>
        </Button>
      </div>

      {schedules.length === 0 ? (
        <p className="text-muted-foreground">{t('scheduleList.noSchedules')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t('scheduleList.task')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('scheduleList.type')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('scheduleList.status')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('scheduleList.nextRun')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('scheduleList.lastRun')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id} className="border-t border-border hover:bg-muted/50">
                  <td className="px-4 py-2">
                    <Link to={`/schedules/${s.id}`} className="font-medium hover:underline">
                      {s.task.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{s.schedule_type}</td>
                  <td className="px-4 py-2">
                    <ScheduleStatusBadge status={s.status} />
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {s.next_run_at ? new Date(s.next_run_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' }) : '—'}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {s.last_run_at ? new Date(s.last_run_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' }) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => deleteMutation.mutate(s.id)}
                      aria-label={t('scheduleList.deleteSchedule')}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
