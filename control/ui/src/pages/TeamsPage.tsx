import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Users, Trash2, ChevronRight } from 'lucide-react'
import { teamsApi } from '@/lib/api'
import type { TeamCreate } from '@/lib/types'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/context/ToastContext'

export default function TeamsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')

  const { data: teams = [], isLoading } = useQuery({
    queryKey: ['teams'],
    queryFn: teamsApi.list,
  })

  const createMutation = useMutation({
    mutationFn: (data: TeamCreate) => teamsApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teams'] })
      setShowCreate(false)
      setName('')
      setDescription('')
      setError('')
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (e: Error) => {
      setError(e.message)
      showToast(e.message || t('common.createError'), 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => teamsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams'] }),
  })

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError(t('teams.nameRequired'))
      return
    }
    createMutation.mutate({ name: name.trim(), description: description.trim() })
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('teams.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('teams.description')}</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90"
        >
          <Plus className="size-4" />
          {t('teams.createTeam')}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="mb-6 rounded-xl border border-border bg-card p-5">
          <h2 className="mb-4 text-base font-semibold">{t('teams.createTeam')}</h2>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('teams.fieldName')} *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder={t('teams.namePlaceholder')}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('teams.fieldDescription')}</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder={t('teams.descriptionPlaceholder')}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                {createMutation.isPending ? t('common.creating') : t('common.create')}
              </button>
              <button
                type="button"
                onClick={() => { setShowCreate(false); setError('') }}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Team list */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : teams.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <Users className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-sm font-medium">{t('teams.noTeams')}</p>
          <p className="text-sm text-muted-foreground">{t('teams.noTeamsHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {teams.map((team) => (
            <div key={team.id} className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-sm">
                {team.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <Link to={`/teams/${team.id}`} className="truncate font-medium hover:underline">
                  {team.name}
                </Link>
                {team.description && (
                  <p className="truncate text-sm text-muted-foreground">{team.description}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {team.member_count} {t('teams.members')} · {team.my_role}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {(team.my_role === 'owner' || team.my_role === 'admin') && (
                  <button
                    onClick={() => {
                      if (confirm(t('teams.deleteConfirm'))) deleteMutation.mutate(team.id)
                    }}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                    title={t('teams.deleteTeam')}
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
                <Link
                  to={`/teams/${team.id}`}
                  className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  {t('common.edit')}
                  <ChevronRight className="size-3.5" />
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
