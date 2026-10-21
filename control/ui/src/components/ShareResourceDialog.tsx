import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Share2, X } from 'lucide-react'
import { teamsApi } from '@/lib/api'
import type { TeamPermission } from '@/lib/types'
import { useTranslation } from 'react-i18next'

interface Props {
  currentTeamId: number | null
  currentTeamName: string | null
  currentPermission: TeamPermission
  onShare: (teamId: number, permission: TeamPermission) => Promise<unknown>
  onUnshare: () => Promise<unknown>
  invalidateKey: string[]
}

export function ShareButton({
  currentTeamId,
  currentTeamName,
  currentPermission,
  onShare,
  onUnshare,
  invalidateKey,
}: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selectedTeam, setSelectedTeam] = useState<number | ''>('')
  const [permission, setPermission] = useState<TeamPermission>('view')
  const [error, setError] = useState('')

  const { data: teams = [] } = useQuery({
    queryKey: ['teams'],
    queryFn: teamsApi.list,
    enabled: open,
  })

  const shareMutation = useMutation({
    mutationFn: () => {
      if (!selectedTeam) throw new Error('Select a team')
      return onShare(Number(selectedTeam), permission)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: invalidateKey })
      setOpen(false)
      setError('')
    },
    onError: (e: Error) => setError(e.message),
  })

  const unshareMutation = useMutation({
    mutationFn: onUnshare,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: invalidateKey })
      setOpen(false)
    },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        title={t('sharing.shareTitle')}
      >
        <Share2 className="size-3.5" />
        {currentTeamName ? currentTeamName : t('sharing.share')}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('sharing.shareTitle')}</h2>
              <button onClick={() => setOpen(false)} className="rounded-md p-1 hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>

            {currentTeamId && (
              <div className="mb-4 rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-sm">
                  {t('sharing.sharedWith')}: <strong>{currentTeamName}</strong> ({currentPermission})
                </p>
                <button
                  onClick={() => unshareMutation.mutate()}
                  disabled={unshareMutation.isPending}
                  className="mt-2 text-xs text-destructive hover:underline"
                >
                  {t('sharing.unshare')}
                </button>
              </div>
            )}

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('sharing.selectTeam')}</label>
                <select
                  value={selectedTeam}
                  onChange={(e) => setSelectedTeam(e.target.value === '' ? '' : Number(e.target.value))}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                >
                  <option value="">{t('sharing.chooseTeam')}</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>{team.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('sharing.permission')}</label>
                <select
                  value={permission}
                  onChange={(e) => setPermission(e.target.value as TeamPermission)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                >
                  <option value="view">{t('sharing.permissionView')}</option>
                  <option value="edit">{t('sharing.permissionEdit')}</option>
                </select>
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex gap-2">
                <button
                  onClick={() => shareMutation.mutate()}
                  disabled={!selectedTeam || shareMutation.isPending}
                  className="flex-1 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
                >
                  {shareMutation.isPending ? t('common.saving') : t('sharing.share')}
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
