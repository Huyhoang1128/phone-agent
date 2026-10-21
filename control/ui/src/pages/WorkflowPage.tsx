import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { GitBranch, Plus, Trash2, Play, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { workflowsApi } from '@/lib/api'
import type { Workflow } from '@/lib/types'
import { useToast } from '@/context/ToastContext'

export default function WorkflowPage() {
  const { t } = useTranslation()
  const { showToast } = useToast()
  const qc = useQueryClient()

  const { data: workflows = [], isLoading } = useQuery<Workflow[]>({
    queryKey: ['workflows'],
    queryFn: workflowsApi.list,
  })

  const deleteMutation = useMutation({
    mutationFn: workflowsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
    onError: (e: Error) => showToast(e.message || t('common.saveError'), 'error'),
  })

  const runMutation = useMutation({
    mutationFn: workflowsApi.run,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows'] })
      showToast(t('workflowList.runStarted'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('common.saveError'), 'error'),
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('workflow.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('workflow.description')}</p>
        </div>
        <Button asChild size="sm">
          <Link to="/workflow/new">
            <Plus className="mr-1 size-4" />
            {t('workflow.newWorkflow')}
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
      ) : workflows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-20 text-center">
          <GitBranch className="mb-4 size-10 text-muted-foreground/50" />
          <p className="text-sm font-medium text-muted-foreground">{t('workflow.empty')}</p>
          <p className="mt-1 text-xs text-muted-foreground/70">{t('workflow.emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                  {t('workflowList.name')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                  {t('workflowList.status')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                  {t('workflowList.triggers')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                  {t('workflowList.created')}
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {workflows.map((wf) => (
                <tr key={wf.id} className="border-t border-border hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <Link to={`/workflow/${wf.id}`} className="font-medium hover:underline">
                      {wf.name}
                    </Link>
                    {wf.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                        {wf.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {wf.status === 'active' ? (
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
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{wf.triggers.length}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(wf.created_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => runMutation.mutate(wf.id)}
                        disabled={runMutation.isPending}
                        aria-label={t('workflowList.run')}
                      >
                        <Play className="size-4 text-green-600" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => deleteMutation.mutate(wf.id)}
                        disabled={deleteMutation.isPending}
                        aria-label={t('workflowList.delete')}
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
      )}
    </div>
  )
}
