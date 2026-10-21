import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { workflowsApi } from '@/lib/api'
import type { WorkflowCreate, WorkflowStatus } from '@/lib/types'

const WORKFLOW_STATUSES: WorkflowStatus[] = ['active', 'inactive']

const emptyForm: WorkflowCreate = {
  name: '',
  description: '',
  status: 'active',
}

export default function WorkflowForm() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [error, setError] = useState('')
  const [overrides, setOverrides] = useState<Partial<WorkflowCreate>>({})

  const { data: existing } = useQuery({
    queryKey: ['workflows', id],
    queryFn: () => workflowsApi.get(Number(id)),
    enabled: isEdit,
  })

  const base = existing
    ? { name: existing.name, description: existing.description, status: existing.status }
    : emptyForm

  const form: WorkflowCreate = { ...base, ...overrides }

  function setField<K extends keyof WorkflowCreate>(key: K, value: WorkflowCreate[K]) {
    setOverrides((o) => ({ ...o, [key]: value }))
  }

  const mutation = useMutation({
    mutationFn: isEdit
      ? (data: WorkflowCreate) => workflowsApi.update(Number(id), data)
      : workflowsApi.create,
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['workflows'] })
      showToast(t('common.saveSuccess'), 'success')
      if (isEdit) {
        navigate('/workflow')
      } else {
        navigate(`/workflow/${created.id}`)
      }
    },
    onError: (e: Error) => {
      setError(e.message)
      showToast(e.message || t('common.saveError'), 'error')
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    mutation.mutate(form)
  }

  return (
    <div className="max-w-lg">
      <h1 className="mb-4 text-xl font-semibold">
        {isEdit ? t('workflowForm.editWorkflow') : t('workflowForm.newWorkflow')}
      </h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          {t('workflowForm.name')}
          <input
            required
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t('workflowForm.description')}
          <textarea
            rows={3}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={form.description ?? ''}
            onChange={(e) => setField('description', e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t('workflowForm.status')}
          <select
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={form.status}
            onChange={(e) => setField('status', e.target.value as WorkflowStatus)}
          >
            {WORKFLOW_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`workflowList.${s}`)}
              </option>
            ))}
          </select>
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-2">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? t('common.saving') : isEdit ? t('common.update') : t('common.create')}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate('/workflow')}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  )
}
