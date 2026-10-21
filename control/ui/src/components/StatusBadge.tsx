import { Badge } from '@/components/ui/badge'
import { useTranslation } from 'react-i18next'
import type { TaskStatus, ScheduleStatus, ExecutionStatus } from '@/lib/types'

const taskStatusVariant: Record<TaskStatus, 'info' | 'warning' | 'success' | 'danger' | 'muted'> =
  {
    pending_approval: 'warning',
    pending: 'info',
    queued: 'info',
    running: 'warning',
    completed: 'success',
    failed: 'danger',
    cancelled: 'muted',
  }

const scheduleStatusVariant: Record<
  ScheduleStatus,
  'success' | 'muted' | 'danger'
> = {
  active: 'success',
  paused: 'muted',
  completed: 'success',
  failed: 'danger',
}

const execStatusVariant: Record<ExecutionStatus, 'success' | 'danger' | 'warning'> = {
  success: 'success',
  failure: 'danger',
  retry: 'warning',
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const { t } = useTranslation()
  return <Badge variant={taskStatusVariant[status]}>{t(`status.${status}`)}</Badge>
}

export function ScheduleStatusBadge({ status }: { status: ScheduleStatus }) {
  const { t } = useTranslation()
  return <Badge variant={scheduleStatusVariant[status]}>{t(`status.${status}`)}</Badge>
}

export function ExecStatusBadge({ status }: { status: ExecutionStatus }) {
  const { t } = useTranslation()
  return <Badge variant={execStatusVariant[status]}>{t(`status.${status}`)}</Badge>
}
