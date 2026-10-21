import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Users,
  Plus,
  X,
  ChevronDown,
  Pencil,
  Trash2,
  UserPlus,
  RefreshCw,
  BrainCircuit,
  Monitor,
  ArrowLeft,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { agentGroupsApi, devicesApi } from '@/lib/api'
import { GroupSharedResourcesDialog } from '@/components/GroupSharedResourcesDialog'
import { GroupStreamDialog } from '@/components/GroupStreamDialog'
import type {
  AgentGroup,
  AgentGroupCreate,
  AgentGroupMemberCreate,
  AgentGroupMemberRole,
  Device,
} from '@/lib/types'

const ROLES: { value: AgentGroupMemberRole; labelKey: string }[] = [
  { value: 'leader', labelKey: 'agentGroups.roleLeader' },
  { value: 'worker', labelKey: 'agentGroups.roleWorker' },
  { value: 'observer', labelKey: 'agentGroups.roleObserver' },
]

const DEFAULT_GROUP_FORM: AgentGroupCreate = { name: '', description: '' }
const DEFAULT_MEMBER_FORM: AgentGroupMemberCreate = { device: 0, role: 'worker' }

export default function AgentGroupsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const navigate = useNavigate()

  // List state
  const [search, setSearch] = useState('')
  const [selectedGroup, setSelectedGroup] = useState<AgentGroup | null>(null)

  // Group modal
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<AgentGroup | null>(null)
  const [groupForm, setGroupForm] = useState<AgentGroupCreate>(DEFAULT_GROUP_FORM)
  const [groupFormError, setGroupFormError] = useState('')

  // Member modal
  const [memberModalOpen, setMemberModalOpen] = useState(false)
  const [memberForm, setMemberForm] = useState<AgentGroupMemberCreate>(DEFAULT_MEMBER_FORM)
  const [memberFormError, setMemberFormError] = useState('')

  // Detail panel tab
  const [detailTab, setDetailTab] = useState<'devices' | 'config'>('devices')

  // Config form state (for the second tab)
  const [configForm, setConfigForm] = useState({ system_prompt: '', goal: '' })
  const [configSaving, setConfigSaving] = useState(false)

  // Shared resources dialog
  const [sharedResourcesGroup, setSharedResourcesGroup] = useState<AgentGroup | null>(null)

  // Group stream dialog
  const [streamGroup, setStreamGroup] = useState<AgentGroup | null>(null)

  const { data: groups = [], isLoading, refetch } = useQuery<AgentGroup[]>({
    queryKey: ['agent-groups'],
    queryFn: agentGroupsApi.list,
  })

  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list(),
    enabled: memberModalOpen,
  })

  // When groups refresh, sync selectedGroup
  const currentGroup = groups.find((g) => g.id === selectedGroup?.id) ?? selectedGroup

  // Track which group ID has been synced to avoid overwriting in-progress edits on data refresh
  const syncedGroupIdRef = useRef<number | undefined>(undefined)

  // Sync config form when switching to a different group
  useEffect(() => {
    if (currentGroup && currentGroup.id !== syncedGroupIdRef.current) {
      syncedGroupIdRef.current = currentGroup.id
      setConfigForm({
        system_prompt: currentGroup.system_prompt ?? '',
        goal: currentGroup.goal ?? '',
      })
      setDetailTab('devices')
    }
  }, [currentGroup])

  const createGroupMutation = useMutation({
    mutationFn: (data: AgentGroupCreate) => agentGroupsApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-groups'] })
      closeGroupModal()
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (err: Error) => {
      setGroupFormError(err.message)
      showToast(err.message, 'error')
    },
  })

  const updateGroupMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<AgentGroupCreate> }) =>
      agentGroupsApi.update(id, data),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['agent-groups'] })
      if (selectedGroup?.id === updated.id) setSelectedGroup(updated)
      closeGroupModal()
      showToast(t('common.saveSuccess'), 'success')
    },
    onError: (err: Error) => {
      setGroupFormError(err.message)
      showToast(err.message, 'error')
    },
  })

  const deleteGroupMutation = useMutation({
    mutationFn: (id: number) => agentGroupsApi.delete(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['agent-groups'] })
      if (selectedGroup?.id === id) setSelectedGroup(null)
      showToast(t('agentGroups.deleteSuccess'), 'success')
    },
  })

  const addMemberMutation = useMutation({
    mutationFn: ({ groupId, data }: { groupId: number; data: AgentGroupMemberCreate }) =>
      agentGroupsApi.addMember(groupId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-groups'] })
      closeMemberModal()
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (err: Error) => {
      setMemberFormError(err.message)
      showToast(err.message, 'error')
    },
  })

  const removeMemberMutation = useMutation({
    mutationFn: ({ groupId, memberId }: { groupId: number; memberId: number }) =>
      agentGroupsApi.removeMember(groupId, memberId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-groups'] })
    },
  })

  const updateRoleMutation = useMutation({
    mutationFn: ({
      groupId,
      memberId,
      role,
    }: {
      groupId: number
      memberId: number
      role: AgentGroupMemberRole
    }) => agentGroupsApi.updateMemberRole(groupId, memberId, role),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-groups'] })
    },
  })

  // ── Helpers ────────────────────────────────────────────────────────────────

  function openCreateGroup() {
    setEditingGroup(null)
    setGroupForm(DEFAULT_GROUP_FORM)
    setGroupFormError('')
    setGroupModalOpen(true)
  }

  function openEditGroup(group: AgentGroup) {
    setEditingGroup(group)
    setGroupForm({ name: group.name, description: group.description })
    setGroupFormError('')
    setGroupModalOpen(true)
  }

  function closeGroupModal() {
    setGroupModalOpen(false)
    setEditingGroup(null)
    setGroupForm(DEFAULT_GROUP_FORM)
    setGroupFormError('')
  }

  function openAddMember() {
    setMemberForm(DEFAULT_MEMBER_FORM)
    setMemberFormError('')
    setMemberModalOpen(true)
  }

  function closeMemberModal() {
    setMemberModalOpen(false)
    setMemberForm(DEFAULT_MEMBER_FORM)
    setMemberFormError('')
  }

  function handleGroupSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!groupForm.name.trim()) {
      setGroupFormError(t('agentGroups.nameRequired'))
      return
    }
    if (editingGroup) {
      updateGroupMutation.mutate({ id: editingGroup.id, data: groupForm })
    } else {
      createGroupMutation.mutate(groupForm)
    }
  }

  function handleMemberSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!memberForm.device) {
      setMemberFormError(t('agentGroups.deviceRequired'))
      return
    }
    if (!currentGroup) return
    addMemberMutation.mutate({ groupId: currentGroup.id, data: memberForm })
  }

  async function handleConfigSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!currentGroup) return
    setConfigSaving(true)
    try {
      await updateGroupMutation.mutateAsync({ id: currentGroup.id, data: configForm })
      showToast(t('agentGroups.configSaved'), 'success')
    } finally {
      setConfigSaving(false)
    }
  }

  const filtered = groups.filter(
    (g) =>
      !search ||
      g.name.toLowerCase().includes(search.toLowerCase()) ||
      g.description.toLowerCase().includes(search.toLowerCase()),
  )

  // Members of current selected group (always fresh)
  const groupMembers = currentGroup?.members ?? []

  return (
    <div className="flex h-full flex-col md:flex-row gap-4">
      {/* ── Left panel: group list ── */}
      <div className={`${currentGroup ? 'hidden md:flex' : 'flex'} w-full md:w-72 md:shrink-0 flex-col gap-3`}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">{t('agentGroups.title')}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => refetch()}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted"
              aria-label={t('common.refresh')}
            >
              <RefreshCw className="size-3.5" />
            </button>
            <Button size="sm" onClick={openCreateGroup}>
              <Plus className="mr-1 size-3.5" />
              {t('agentGroups.newGroup')}
            </Button>
          </div>
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder={t('agentGroups.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
        />

        {/* Group list */}
        <div className="flex flex-col gap-1 overflow-y-auto">
          {isLoading ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{t('common.loading')}</p>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                <Users className="size-6 text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground">{t('agentGroups.noGroups')}</p>
              <Button size="sm" variant="outline" onClick={openCreateGroup}>
                <Plus className="mr-1 size-3.5" />
                {t('agentGroups.newGroup')}
              </Button>
            </div>
          ) : (
            filtered.map((group) => (
              <div
                key={group.id}
                className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2.5 transition-colors ${
                  currentGroup?.id === group.id
                    ? 'border-foreground bg-foreground/5'
                    : 'border-border bg-background hover:bg-muted'
                }`}
              >
                <button
                  onClick={() => setSelectedGroup(group)}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                >
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
                    <Users className="size-3.5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{group.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {group.member_count} {t('agentGroups.devicesCount')}
                      {group.team_name ? ` · ${group.team_name}` : ''}
                    </p>
                  </div>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setSharedResourcesGroup(group) }}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                  title={t('agentGroups.sharedResources')}
                  aria-label={t('agentGroups.sharedResources')}
                >
                  <BrainCircuit className="size-3.5" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setStreamGroup(group) }}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                  title={t('agentGroups.groupStream')}
                  aria-label={t('agentGroups.groupStream')}
                >
                  <Monitor className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Right panel: group detail ── */}
      <div className={`${currentGroup ? 'flex' : 'hidden md:flex'} flex-1 flex-col gap-4 overflow-hidden`}>
        {!currentGroup ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-full bg-muted">
                <Users className="size-7 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">{t('agentGroups.selectHint')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('agentGroups.selectHintDesc')}</p>
            </div>
          </div>
        ) : (
          <>
            {/* Mobile back button */}
            <button
              onClick={() => setSelectedGroup(null)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground md:hidden"
              aria-label={t('common.back')}
            >
              <ArrowLeft className="size-4" />
              {t('common.back')}
            </button>

            {/* Group header */}
            <div className="flex items-start justify-between rounded-lg border border-border bg-background p-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">{currentGroup.name}</h2>
                {currentGroup.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{currentGroup.description}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    {currentGroup.member_count} {t('agentGroups.devicesCount')}
                  </span>
                  {currentGroup.team_name && (
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {t('agentGroups.sharedWith')}: {currentGroup.team_name}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  onClick={() => setSharedResourcesGroup(currentGroup)}
                  className="flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                  title={t('agentGroups.sharedResources')}
                  aria-label={t('agentGroups.sharedResources')}
                >
                  <BrainCircuit className="size-3.5" />
                </button>
                <button
                  onClick={() => setStreamGroup(currentGroup)}
                  className="flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                  title={t('agentGroups.groupStream')}
                  aria-label={t('agentGroups.groupStream')}
                >
                  <Monitor className="size-3.5" />
                </button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openEditGroup(currentGroup)}
                  title={t('common.edit')}
                  aria-label={t('common.edit')}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (confirm(t('agentGroups.deleteConfirm'))) {
                      deleteGroupMutation.mutate(currentGroup.id)
                    }
                  }}
                  className="text-destructive hover:bg-destructive/10"
                  title={t('common.delete')}
                  aria-label={t('common.delete')}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-border">
              <button
                onClick={() => setDetailTab('devices')}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  detailTab === 'devices'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('agentGroups.tabDevices')}
              </button>
              <button
                onClick={() => setDetailTab('config')}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  detailTab === 'config'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('agentGroups.tabConfig')}
              </button>
            </div>

            {/* Tab: Devices */}
            {detailTab === 'devices' && (
            <div className="flex flex-col gap-3 overflow-auto rounded-lg border border-border bg-background p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">{t('agentGroups.membersTitle')}</h3>
                <Button size="sm" onClick={openAddMember}>
                  <UserPlus className="mr-1 size-3.5" />
                  {t('agentGroups.addDevice')}
                </Button>
              </div>

              {groupMembers.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-8">
                  <p className="text-xs text-muted-foreground">{t('agentGroups.noMembers')}</p>
                  <Button size="sm" variant="outline" onClick={openAddMember}>
                    <UserPlus className="mr-1 size-3.5" />
                    {t('agentGroups.addDevice')}
                  </Button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-muted/50">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        {t('agentGroups.colDevice')}
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        {t('agentGroups.colSerial')}
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        {t('agentGroups.colWorkerId')}
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        {t('agentGroups.colIdentifier')}
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        {t('agentGroups.colProfile')}
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        {t('agentGroups.colType')}
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        {t('agentGroups.colStatus')}
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        {t('agentGroups.colRole')}
                      </th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {groupMembers.map((member) => (
                      <tr key={member.id} className="border-t border-border hover:bg-muted/40">
                        <td className="px-4 py-2.5 font-medium">
                          <button
                            onClick={() => navigate(`/devices/${member.device}`)}
                            className="text-left hover:underline focus:outline-none"
                          >
                            {member.device_name}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{member.device_serial_id || '-'}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{member.device_worker_id || '-'}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{member.device_identifier || '-'}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{member.device_profile_name || '-'}</td>
                        <td className="px-4 py-2.5">
                          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                            {member.device_type}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={
                              member.device_status === 'online'
                                ? 'inline-flex items-center gap-1 text-xs text-green-600'
                                : member.device_status === 'connected'
                                  ? 'inline-flex items-center gap-1 text-xs text-blue-600'
                                  : 'inline-flex items-center gap-1 text-xs text-muted-foreground'
                            }
                          >
                            <span
                              className={
                                member.device_status === 'online'
                                  ? 'size-1.5 rounded-full bg-green-500'
                                  : member.device_status === 'connected'
                                    ? 'size-1.5 rounded-full bg-blue-500'
                                    : 'size-1.5 rounded-full bg-muted-foreground'
                              }
                            />
                            {member.device_status}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="relative inline-block">
                            <select
                              value={member.role}
                              onChange={(e) =>
                                updateRoleMutation.mutate({
                                  groupId: currentGroup.id,
                                  memberId: member.id,
                                  role: e.target.value as AgentGroupMemberRole,
                                })
                              }
                              className="h-7 appearance-none rounded-md border border-border bg-background pl-2 pr-6 text-xs outline-none focus:ring-2 focus:ring-ring"
                            >
                              {ROLES.map(({ value, labelKey }) => (
                                <option key={value} value={value}>
                                  {t(labelKey)}
                                </option>
                              ))}
                            </select>
                            <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() =>
                              removeMemberMutation.mutate({
                                groupId: currentGroup.id,
                                memberId: member.id,
                              })
                            }
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                            aria-label={t('agentGroups.removeMember')}
                          >
                            <X className="size-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
            )}

            {/* Tab: Configuration */}
            {detailTab === 'config' && (
            <div className="overflow-auto rounded-lg border border-border bg-background p-4">
              <form onSubmit={handleConfigSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('agentGroups.fieldSystemPrompt')}</label>
                  <textarea
                    value={configForm.system_prompt}
                    onChange={(e) => setConfigForm({ ...configForm, system_prompt: e.target.value })}
                    placeholder={t('agentGroups.fieldSystemPromptPlaceholder')}
                    rows={6}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('agentGroups.fieldGoal')}</label>
                  <textarea
                    value={configForm.goal}
                    onChange={(e) => setConfigForm({ ...configForm, goal: e.target.value })}
                    placeholder={t('agentGroups.fieldGoalPlaceholder')}
                    rows={4}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={configSaving}>
                    {configSaving ? t('common.saving') : t('agentGroups.saveConfig')}
                  </Button>
                </div>
              </form>
            </div>
            )}
          </>
        )}
      </div>

      {/* ── Create / Edit Group Modal ── */}
      {groupModalOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4">
          <div className="w-full max-w-md rounded-t-2xl sm:rounded-xl border border-border bg-background p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">
                {editingGroup ? t('agentGroups.editGroupTitle') : t('agentGroups.createGroupTitle')}
              </h2>
              <button
                onClick={closeGroupModal}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>

            <form onSubmit={handleGroupSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('agentGroups.fieldName')}</label>
                <input
                  type="text"
                  value={groupForm.name}
                  onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                  placeholder={t('agentGroups.fieldNamePlaceholder')}
                  className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('agentGroups.fieldDescription')}</label>
                <textarea
                  value={groupForm.description ?? ''}
                  onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                  placeholder={t('agentGroups.fieldDescriptionPlaceholder')}
                  rows={3}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
                />
              </div>

              {groupFormError && (
                <p className="text-xs text-destructive">{groupFormError}</p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" size="sm" onClick={closeGroupModal}>
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={createGroupMutation.isPending || updateGroupMutation.isPending}
                >
                  {createGroupMutation.isPending || updateGroupMutation.isPending
                    ? editingGroup
                      ? t('common.saving')
                      : t('common.creating')
                    : editingGroup
                      ? t('common.save')
                      : t('common.create')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Add Member Modal ── */}
      {memberModalOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4">
          <div className="w-full max-w-sm rounded-t-2xl sm:rounded-xl border border-border bg-background p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('agentGroups.addDeviceTitle')}</h2>
              <button
                onClick={closeMemberModal}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>

            <form onSubmit={handleMemberSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('agentGroups.fieldDevice')}</label>
                <div className="relative">
                  <select
                    value={memberForm.device || ''}
                    onChange={(e) =>
                      setMemberForm({ ...memberForm, device: Number(e.target.value) })
                    }
                    className="h-9 w-full appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">{t('agentGroups.selectDevice')}</option>
                    {devices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name} ({device.device_type})
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('agentGroups.fieldRole')}</label>
                <div className="relative">
                  <select
                    value={memberForm.role}
                    onChange={(e) =>
                      setMemberForm({ ...memberForm, role: e.target.value as AgentGroupMemberRole })
                    }
                    className="h-9 w-full appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    {ROLES.map(({ value, labelKey }) => (
                      <option key={value} value={value}>
                        {t(labelKey)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>

              {memberFormError && (
                <p className="text-xs text-destructive">{memberFormError}</p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" size="sm" onClick={closeMemberModal}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" size="sm" disabled={addMemberMutation.isPending}>
                  {addMemberMutation.isPending ? t('common.creating') : t('agentGroups.addDevice')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* ── Shared Resources Dialog ── */}
      {sharedResourcesGroup && (
        <GroupSharedResourcesDialog
          groupId={sharedResourcesGroup.id}
          groupName={sharedResourcesGroup.name}
          onClose={() => setSharedResourcesGroup(null)}
        />
      )}
      {/* ── Group Stream Dialog ── */}
      {streamGroup && (
        <GroupStreamDialog
          group={streamGroup}
          onClose={() => setStreamGroup(null)}
        />
      )}
    </div>
  )
}
