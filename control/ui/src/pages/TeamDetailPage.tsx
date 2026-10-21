import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, UserPlus, Trash2, Shield, Briefcase } from 'lucide-react'
import { teamsApi, profilesApi } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import type { TeamRole, TeamPermission } from '@/lib/types'
import { useTranslation } from 'react-i18next'

const ROLES: TeamRole[] = ['owner', 'admin', 'member']

export default function TeamDetailPage() {
  const { id } = useParams<{ id: string }>()
  const teamId = Number(id)
  const navigate = useNavigate()
  const { user } = useAuth()
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<TeamRole>('member')
  const [inviteError, setInviteError] = useState('')

  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editMode, setEditMode] = useState(false)

  const [selectedProfileId, setSelectedProfileId] = useState<number | ''>('')
  const [profilePermission, setProfilePermission] = useState<TeamPermission>('view')

  const { data: team, isLoading } = useQuery({
    queryKey: ['team', teamId],
    queryFn: () => teamsApi.get(teamId),
    enabled: !!teamId,
  })

  const { data: allProfiles = [] } = useQuery({
    queryKey: ['profiles'],
    queryFn: profilesApi.list,
    enabled: !!teamId,
  })

  const updateMutation = useMutation({
    mutationFn: (data: { name: string; description: string }) => teamsApi.update(teamId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team', teamId] })
      qc.invalidateQueries({ queryKey: ['teams'] })
      setEditMode(false)
      showToast(t('common.saveSuccess'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('common.saveError'), 'error'),
  })

  const addMemberMutation = useMutation({
    mutationFn: () => teamsApi.addMember(teamId, inviteEmail, inviteRole),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team', teamId] })
      setInviteEmail('')
      setInviteError('')
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (e: Error) => {
      setInviteError(e.message)
      showToast(e.message || t('common.createError'), 'error')
    },
  })

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: string }) =>
      teamsApi.updateMemberRole(teamId, userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', teamId] }),
  })

  const removeMemberMutation = useMutation({
    mutationFn: (userId: number) => teamsApi.removeMember(teamId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team', teamId] })
      qc.invalidateQueries({ queryKey: ['teams'] })
    },
  })

  const addProfileMutation = useMutation({
    mutationFn: ({ profileId, permission }: { profileId: number; permission: TeamPermission }) =>
      profilesApi.share(profileId, teamId, permission),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] })
      qc.invalidateQueries({ queryKey: ['team', teamId] })
      setSelectedProfileId('')
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('common.createError'), 'error'),
  })

  const removeProfileMutation = useMutation({
    mutationFn: (profileId: number) => profilesApi.unshare(profileId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] })
      qc.invalidateQueries({ queryKey: ['team', teamId] })
      showToast(t('common.saveSuccess'), 'success')
    },
    onError: (e: Error) => showToast(e.message || t('common.saveError'), 'error'),
  })

  const myRole = team?.members?.find((m) => m.user_id === user?.id)?.role
  const canManage = myRole === 'owner' || myRole === 'admin'

  // Profiles already shared with this team
  const teamProfiles = allProfiles.filter((p) => p.team_id === teamId)
  // User's own profiles not yet shared with this team (candidates to add)
  const availableProfiles = allProfiles.filter(
    (p) => p.owner_id === user?.id && p.team_id !== teamId,
  )

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  }

  if (!team) {
    return <p className="text-sm text-muted-foreground">{t('teams.notFound')}</p>
  }

  return (
    <div className="mx-auto max-w-3xl">
      {/* Back */}
      <button
        onClick={() => navigate('/teams')}
        className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t('teams.backToTeams')}
      </button>

      {/* Team header */}
      <div className="mb-6 rounded-xl border border-border bg-card p-5">
        {editMode ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              updateMutation.mutate({ name: editName, description: editDesc })
            }}
            className="flex flex-col gap-3"
          >
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              required
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <textarea
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              rows={2}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={updateMutation.isPending}
                className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                {t('common.save')}
              </button>
              <button
                type="button"
                onClick={() => setEditMode(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <div className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-sm">
                  {team.name.charAt(0).toUpperCase()}
                </div>
                <h1 className="text-lg font-semibold">{team.name}</h1>
              </div>
              {team.description && (
                <p className="mt-1 text-sm text-muted-foreground">{team.description}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {team.member_count} {t('teams.members')} · {t('teams.yourRole')}: <span className="font-medium">{myRole}</span>
              </p>
            </div>
            {canManage && (
              <button
                onClick={() => {
                  setEditName(team.name)
                  setEditDesc(team.description)
                  setEditMode(true)
                }}
                className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                {t('common.edit')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Invite member */}
      {canManage && (
        <div className="mb-6 rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            <UserPlus className="size-4" />
            {t('teams.inviteMember')}
          </h2>
          <div className="flex gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="email@example.com"
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as TeamRole)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              {ROLES.filter((r) => r !== 'owner').map((r) => (
                <option key={r} value={r}>{t(`teams.role_${r}`)}</option>
              ))}
            </select>
            <button
              onClick={() => {
                setInviteError('')
                addMemberMutation.mutate()
              }}
              disabled={!inviteEmail || addMemberMutation.isPending}
              className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {t('teams.invite')}
            </button>
          </div>
          {inviteError && <p className="mt-2 text-sm text-destructive">{inviteError}</p>}
        </div>
      )}

      {/* Members list */}
      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Shield className="size-4" />
            {t('teams.membersList')}
          </h2>
        </div>
        <div className="divide-y divide-border">
          {team.members?.map((member) => (
            <div key={member.id} className="flex items-center gap-3 px-5 py-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                {(member.display_name || member.username).charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {member.display_name || member.username}
                </p>
                <p className="truncate text-xs text-muted-foreground">{member.email}</p>
              </div>
              {canManage && member.role !== 'owner' ? (
                <select
                  value={member.role}
                  onChange={(e) =>
                    updateRoleMutation.mutate({ userId: member.user_id, role: e.target.value })
                  }
                  className="rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none"
                >
                  {ROLES.filter((r) => r !== 'owner').map((r) => (
                    <option key={r} value={r}>{t(`teams.role_${r}`)}</option>
                  ))}
                </select>
              ) : (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                  {t(`teams.role_${member.role}`)}
                </span>
              )}
              {canManage && member.user_id !== user?.id && member.role !== 'owner' && (
                <button
                  onClick={() => {
                    if (confirm(t('teams.removeMemberConfirm')))
                      removeMemberMutation.mutate(member.user_id)
                  }}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                  title={t('teams.removeMember')}
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Team Profiles */}
      <div className="mt-6 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Briefcase className="size-4" />
            {t('teams.teamProfiles')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('teams.teamProfilesDescription')}</p>
        </div>

        {/* Add profile form */}
        {canManage && availableProfiles.length > 0 && (
          <div className="border-b border-border px-5 py-4">
            <div className="flex gap-2">
              <select
                value={selectedProfileId}
                onChange={(e) =>
                  setSelectedProfileId(e.target.value === '' ? '' : Number(e.target.value))
                }
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">{t('teams.selectProfile')}</option>
                {availableProfiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <select
                value={profilePermission}
                onChange={(e) => setProfilePermission(e.target.value as TeamPermission)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="view">{t('sharing.permissionView')}</option>
                <option value="edit">{t('sharing.permissionEdit')}</option>
              </select>
              <button
                onClick={() => {
                  if (!selectedProfileId) return
                  addProfileMutation.mutate({
                    profileId: Number(selectedProfileId),
                    permission: profilePermission,
                  })
                }}
                disabled={!selectedProfileId || addProfileMutation.isPending}
                className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                {t('teams.addProfileToTeam')}
              </button>
            </div>
          </div>
        )}

        <div className="divide-y divide-border">
          {teamProfiles.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">{t('teams.noTeamProfiles')}</p>
          ) : (
            teamProfiles.map((profile) => (
              <div key={profile.id} className="flex items-center gap-3 px-5 py-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                  {profile.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{profile.name}</p>
                  <span className="text-xs text-muted-foreground">{profile.team_permission}</span>
                </div>
                {profile.owner_id === user?.id && (
                  <button
                    onClick={() => {
                      if (confirm(t('teams.removeProfileConfirm')))
                        removeProfileMutation.mutate(profile.id)
                    }}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                    title={t('teams.removeProfile')}
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
