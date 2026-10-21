import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Clapperboard, LayoutGrid, User, Users, Activity,
  Plus, Trash2, Pencil, ExternalLink, X, Search, RefreshCw, Loader2, FileText,
  Target, Heart, MessageCircle, Share2, Trophy,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { useAuth } from '@/context/AuthContext'
import { facebookCompetitorApi, facebookPagesApi, facebookGroupsApi, facebookProfilesApi, profilesApi, devicesApi } from '@/lib/api'
import type {
  FacebookPage as FacebookPageType,
  FacebookPageCreate,
  FacebookPageStatus,
  FacebookGroup,
  FacebookGroupCreate,
  FacebookGroupStatus,
  FacebookProfile,
  FacebookProfileCreate,
  FacebookProfileStatus,
  FacebookCompetitorPost,
  Profile,
} from '@/lib/types'
import FacebookInteractionsTab from '@/pages/FacebookInteractionsTab'

type FacebookTab = 'pages' | 'groups' | 'profiles' | 'content' | 'interactions'

const PAGE_STATUSES: FacebookPageStatus[] = ['active', 'paused', 'archived']
const GROUP_STATUSES: FacebookGroupStatus[] = ['active', 'paused', 'archived']
const PROFILE_STATUSES: FacebookProfileStatus[] = ['active', 'paused', 'archived']

const DEFAULT_FORM: FacebookPageCreate = {
  name: '',
  page_url: '',
  page_uid: '',
  page_token: '',
  category: '',
  description: '',
  follower_count: 0,
  status: 'active',
}

const DEFAULT_GROUP_FORM: FacebookGroupCreate = {
  name: '',
  group_url: '',
  group_uid: '',
  group_token: '',
  description: '',
  member_count: 0,
  admin_profile: null,
  admin_fb_profile: null,
  default_poster_fb_profile: null,
  status: 'active',
}

const DEFAULT_PROFILE_FORM: FacebookProfileCreate = {
  name: '',
  profile_url: '',
  profile_uid: '',
  profile_token: '',
  description: '',
  friend_count: 0,
  status: 'active',
  device: null,
  account_name: '',
}

function StatusBadge({ status }: { status: FacebookPageStatus }) {
  const { t } = useTranslation()
  const colorMap: Record<FacebookPageStatus, string> = {
    active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    paused: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    archived: 'bg-muted text-muted-foreground',
  }
  const labelMap: Record<FacebookPageStatus, string> = {
    active: t('facebook.pagesTab.statusActive'),
    paused: t('facebook.pagesTab.statusPaused'),
    archived: t('facebook.pagesTab.statusArchived'),
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${colorMap[status]}`}>
      {labelMap[status]}
    </span>
  )
}

function ProfileStatusBadge({ status }: { status: FacebookProfileStatus }) {
  const { t } = useTranslation()
  const colorMap: Record<FacebookProfileStatus, string> = {
    active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    paused: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    archived: 'bg-muted text-muted-foreground',
  }
  const labelMap: Record<FacebookProfileStatus, string> = {
    active: t('facebook.profilesTab.statusActive'),
    paused: t('facebook.profilesTab.statusPaused'),
    archived: t('facebook.profilesTab.statusArchived'),
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${colorMap[status]}`}>
      {labelMap[status]}
    </span>
  )
}

function GroupStatusBadge({ status }: { status: FacebookGroupStatus }) {
  const { t } = useTranslation()
  const colorMap: Record<FacebookGroupStatus, string> = {
    active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    paused: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    archived: 'bg-muted text-muted-foreground',
  }
  const labelMap: Record<FacebookGroupStatus, string> = {
    active: t('facebook.groupsTab.statusActive'),
    paused: t('facebook.groupsTab.statusPaused'),
    archived: t('facebook.groupsTab.statusArchived'),
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${colorMap[status]}`}>
      {labelMap[status]}
    </span>
  )
}

function formatDate(value: string) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })
}

// ─── Pages Tab ────────────────────────────────────────────────────────────────

function FacebookPagesTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const navigate = useNavigate()

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<FacebookPageType | null>(null)
  const [form, setForm] = useState<FacebookPageCreate>(DEFAULT_FORM)
  const [formError, setFormError] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<FacebookPageStatus | ''>('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [appliedDates, setAppliedDates] = useState<{ date_from?: string; date_to?: string }>({})

  const { data: pages, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['facebook-pages', appliedDates],
    queryFn: () => facebookPagesApi.list(appliedDates),
  })

  const filteredPages = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (pages ?? []).filter((p) => {
      if (statusFilter && p.status !== statusFilter) return false
      if (!q) return true
      return (
        p.name.toLowerCase().includes(q) ||
        p.page_url.toLowerCase().includes(q) ||
        p.page_uid.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      )
    })
  }, [pages, search, statusFilter])

  const saveMutation = useMutation({
    mutationFn: (data: FacebookPageCreate) =>
      editing ? facebookPagesApi.update(editing.id, data) : facebookPagesApi.create(data),
    onSuccess: () => {
      showToast(editing ? t('facebook.pagesTab.saveSuccess') : t('facebook.pagesTab.createSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-pages'] })
      closeModal()
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.pagesTab.saveError'), 'error'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => facebookPagesApi.delete(id),
    onSuccess: () => {
      showToast(t('facebook.pagesTab.deleteSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-pages'] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.pagesTab.deleteError'), 'error'),
  })

  function openCreate() {
    setEditing(null)
    setForm(DEFAULT_FORM)
    setFormError('')
    setModalOpen(true)
  }

  function openEdit(page: FacebookPageType) {
    setEditing(page)
    setForm({
      name: page.name,
      page_url: page.page_url,
      page_uid: page.page_uid,
      page_token: page.page_token,
      category: page.category,
      description: page.description,
      follower_count: page.follower_count,
      status: page.status,
    })
    setFormError('')
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setEditing(null)
    setForm(DEFAULT_FORM)
    setFormError('')
  }

  function handleSubmit() {
    if (!form.name.trim()) {
      setFormError(t('facebook.pagesTab.nameRequired'))
      return
    }
    saveMutation.mutate({ ...form, name: form.name.trim() })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('facebook.pagesTab.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('facebook.pagesTab.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`mr-1.5 size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            {t('common.refresh')}
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1.5 size-3.5" />
            {t('facebook.pagesTab.addBtn')}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('facebook.pagesTab.searchPlaceholder')}
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as FacebookPageStatus | '')}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t('facebook.pagesTab.filterAllStatus')}</option>
          {PAGE_STATUSES.map((s) => (
            <option key={s} value={s}>{t(`facebook.pagesTab.status${s.charAt(0).toUpperCase()}${s.slice(1)}`)}</option>
          ))}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label={t('facebook.filterFrom')}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label={t('facebook.filterTo')}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        <Button size="sm" variant="outline" onClick={() => setAppliedDates({ date_from: dateFrom || undefined, date_to: dateTo || undefined })}>
          {t('facebook.report.apply')}
        </Button>
        {(appliedDates.date_from || appliedDates.date_to) && (
          <Button size="sm" variant="ghost" onClick={() => { setDateFrom(''); setDateTo(''); setAppliedDates({}) }}>
            {t('facebook.clearFilters')}
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : filteredPages.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10">
            <LayoutGrid className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t('facebook.pagesTab.empty')}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pagesTab.colName')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pagesTab.colUrl')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pagesTab.colCategory')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pagesTab.colFollowers')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pagesTab.colStatus')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pagesTab.colCreated')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.pagesTab.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredPages.map((page) => (
                <tr key={page.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5">
                    <p
                      className="font-medium text-foreground cursor-pointer hover:underline hover:text-primary transition-colors"
                      onClick={() => navigate(`/facebook/pages/${page.id}`)}
                    >{page.name}</p>
                    {page.description && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">{page.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5 max-w-[240px]">
                    {page.page_url ? (
                      <a
                        href={page.page_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{page.page_url}</span>
                      </a>
                    ) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{page.category || '—'}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
                    {page.follower_count.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={page.status} /></td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{formatDate(page.created_at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => navigate(`/facebook/pages/${page.id}`)}
                        aria-label={t('facebook.pagesTab.open')}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <FileText className="size-3.5" />
                        <span>{t('facebook.pagesTab.open')}</span>
                      </button>
                      <button
                        onClick={() => openEdit(page)}
                        aria-label={t('common.edit')}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        onClick={() => { if (confirm(t('facebook.pagesTab.deleteConfirm'))) deleteMutation.mutate(page.id) }}
                        aria-label={t('common.delete')}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create / Edit modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl flex max-h-[90vh] flex-col">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">
                {editing ? t('facebook.pagesTab.editTitle') : t('facebook.pagesTab.createTitle')}
              </h2>
              <button onClick={closeModal} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-4 overflow-y-auto p-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.pagesTab.fieldName')}</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder={t('facebook.pagesTab.fieldNamePlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.pagesTab.fieldUrl')}</label>
                <input
                  type="url"
                  value={form.page_url}
                  onChange={(e) => setForm((p) => ({ ...p, page_url: e.target.value }))}
                  placeholder={t('facebook.pagesTab.fieldUrlPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.pagesTab.fieldUid')}</label>
                  <input
                    type="text"
                    value={form.page_uid}
                    onChange={(e) => setForm((p) => ({ ...p, page_uid: e.target.value }))}
                    placeholder={t('facebook.pagesTab.fieldUidPlaceholder')}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.pagesTab.fieldCategory')}</label>
                  <input
                    type="text"
                    value={form.category}
                    onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
                    placeholder={t('facebook.pagesTab.fieldCategoryPlaceholder')}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.pagesTab.fieldToken')}</label>
                <input
                  type="password"
                  value={form.page_token ?? ''}
                  onChange={(e) => setForm((p) => ({ ...p, page_token: e.target.value }))}
                  placeholder={t('facebook.pagesTab.fieldTokenPlaceholder')}
                  autoComplete="off"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">{t('facebook.pagesTab.fieldTokenHint')}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.pagesTab.fieldFollowers')}</label>
                  <input
                    type="number"
                    min={0}
                    value={form.follower_count}
                    onChange={(e) => setForm((p) => ({ ...p, follower_count: Math.max(0, Number(e.target.value) || 0) }))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.pagesTab.fieldStatus')}</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm((p) => ({ ...p, status: e.target.value as FacebookPageStatus }))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    {PAGE_STATUSES.map((s) => (
                      <option key={s} value={s}>{t(`facebook.pagesTab.status${s.charAt(0).toUpperCase()}${s.slice(1)}`)}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.pagesTab.fieldDescription')}</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  placeholder={t('facebook.pagesTab.fieldDescriptionPlaceholder')}
                  rows={3}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {formError && <p className="text-xs text-destructive">{formError}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" onClick={closeModal} disabled={saveMutation.isPending}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSubmit} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FacebookGroupsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [groupEditing, setGroupEditing] = useState<FacebookGroup | null>(null)
  const [groupForm, setGroupForm] = useState<FacebookGroupCreate>(DEFAULT_GROUP_FORM)
  const [groupFormError, setGroupFormError] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<FacebookGroupStatus | ''>('')

  const { data: groups, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['facebook-groups'],
    queryFn: () => facebookGroupsApi.list(),
  })

  const { data: profiles } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => profilesApi.list(),
  })

  // FB Profiles (Facebook personal accounts) — used as Group admin selector.
  const { data: fbProfiles } = useQuery({
    queryKey: ['facebook-profiles'],
    queryFn: () => facebookProfilesApi.list(),
  })

  // Mark profiles not owned by the current user — they're visible to us via
  // team-share. Backend accepts them as admin too; we just suffix the label
  // so the user knows it's a shared resource.
  const isShared = (ownerId: number | null) => user?.id !== undefined && ownerId !== user.id

  const groupsFiltered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (groups ?? []).filter((group) => {
      if (statusFilter && group.status !== statusFilter) return false
      if (!q) return true
      return (
        group.name.toLowerCase().includes(q)
        || group.group_url.toLowerCase().includes(q)
        || group.group_uid.toLowerCase().includes(q)
        || (group.admin_profile_name ?? '').toLowerCase().includes(q)
      )
    })
  }, [groups, search, statusFilter])

  const saveGroupMutation = useMutation({
    mutationFn: (data: FacebookGroupCreate) =>
      groupEditing ? facebookGroupsApi.update(groupEditing.id, data) : facebookGroupsApi.create(data),
    onSuccess: () => {
      showToast(groupEditing ? t('facebook.groupsTab.saveSuccess') : t('facebook.groupsTab.createSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-groups'] })
      closeGroupModal()
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.groupsTab.saveError'), 'error'),
  })

  const deleteGroupMutation = useMutation({
    mutationFn: (id: number) => facebookGroupsApi.delete(id),
    onSuccess: () => {
      showToast(t('facebook.groupsTab.deleteSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-groups'] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.groupsTab.deleteError'), 'error'),
  })

  function openCreateGroup() {
    setGroupEditing(null)
    setGroupForm(DEFAULT_GROUP_FORM)
    setGroupFormError('')
    setGroupModalOpen(true)
  }

  function openEditGroup(group: FacebookGroup) {
    setGroupEditing(group)
    setGroupForm({
      name: group.name,
      group_url: group.group_url,
      group_uid: group.group_uid,
      group_token: group.group_token,
      description: group.description,
      member_count: group.member_count,
      admin_profile: group.admin_profile,
      admin_fb_profile: group.admin_fb_profile,
      default_poster_fb_profile: group.default_poster_fb_profile,
      status: group.status,
    })
    setGroupFormError('')
    setGroupModalOpen(true)
  }

  function closeGroupModal() {
    setGroupModalOpen(false)
    setGroupEditing(null)
    setGroupForm(DEFAULT_GROUP_FORM)
    setGroupFormError('')
  }

  function submitGroup() {
    if (!groupForm.name?.trim()) {
      setGroupFormError(t('facebook.groupsTab.nameRequired'))
      return
    }
    saveGroupMutation.mutate({
      ...groupForm,
      name: groupForm.name.trim(),
      admin_profile: groupForm.admin_profile ?? null,
      admin_fb_profile: groupForm.admin_fb_profile ?? null,
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('facebook.groupsTab.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('facebook.groupsTab.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`mr-1.5 size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            {t('common.refresh')}
          </Button>
          <Button size="sm" onClick={openCreateGroup}>
            <Plus className="mr-1.5 size-3.5" />
            {t('facebook.groupsTab.addBtn')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('facebook.groupsTab.searchPlaceholder')}
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as FacebookGroupStatus | '')}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t('facebook.groupsTab.filterAllStatus')}</option>
          {GROUP_STATUSES.map((status) => (
            <option key={status} value={status}>{t(`facebook.groupsTab.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}</option>
          ))}
        </select>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : groupsFiltered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10">
            <Users className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t('facebook.groupsTab.empty')}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.groupsTab.colName')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.groupsTab.colAdminProfile')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.groupsTab.colMembers')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.groupsTab.colStatus')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.groupsTab.colCreated')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.groupsTab.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {groupsFiltered.map((group) => (
                <tr key={group.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5">
                    <p
                      className="font-medium text-foreground cursor-pointer hover:underline hover:text-primary transition-colors"
                      onClick={() => navigate(`/facebook/groups/${group.id}`)}
                    >{group.name}</p>
                    {group.group_url ? (
                      <a
                        href={group.group_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 inline-flex max-w-[280px] items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{group.group_url}</span>
                      </a>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{group.admin_profile_name || '—'}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">{group.member_count.toLocaleString()}</td>
                  <td className="px-4 py-2.5"><GroupStatusBadge status={group.status} /></td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{formatDate(group.created_at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => navigate(`/facebook/groups/${group.id}`)}
                        aria-label={t('facebook.groupsTab.open')}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <FileText className="size-3.5" />
                        <span>{t('facebook.groupsTab.open')}</span>
                      </button>
                      <button
                        onClick={() => openEditGroup(group)}
                        aria-label={t('common.edit')}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        onClick={() => { if (confirm(t('facebook.groupsTab.deleteConfirm'))) deleteGroupMutation.mutate(group.id) }}
                        aria-label={t('common.delete')}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {groupModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl flex max-h-[90vh] flex-col">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">
                {groupEditing ? t('facebook.groupsTab.editTitle') : t('facebook.groupsTab.createTitle')}
              </h2>
              <button onClick={closeGroupModal} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-4 overflow-y-auto p-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.groupsTab.fieldName')}</label>
                <input
                  type="text"
                  value={groupForm.name ?? ''}
                  onChange={(e) => setGroupForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder={t('facebook.groupsTab.fieldNamePlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.groupsTab.fieldUrl')}</label>
                <input
                  type="url"
                  value={groupForm.group_url ?? ''}
                  onChange={(e) => setGroupForm((p) => ({ ...p, group_url: e.target.value }))}
                  placeholder={t('facebook.groupsTab.fieldUrlPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.groupsTab.fieldUid')}</label>
                  <input
                    type="text"
                    value={groupForm.group_uid ?? ''}
                    onChange={(e) => setGroupForm((p) => ({ ...p, group_uid: e.target.value }))}
                    placeholder={t('facebook.groupsTab.fieldUidPlaceholder')}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.groupsTab.fieldMembers')}</label>
                  <input
                    type="number"
                    min={0}
                    value={groupForm.member_count ?? 0}
                    onChange={(e) => setGroupForm((p) => ({ ...p, member_count: Math.max(0, Number(e.target.value) || 0) }))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.groupsTab.fieldToken')}</label>
                <input
                  type="password"
                  value={groupForm.group_token ?? ''}
                  onChange={(e) => setGroupForm((p) => ({ ...p, group_token: e.target.value }))}
                  placeholder={t('facebook.groupsTab.fieldTokenPlaceholder')}
                  autoComplete="off"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">{t('facebook.groupsTab.fieldTokenHint')}</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.groupsTab.fieldAdminProfile')}</label>
                  <select
                    value={groupForm.admin_profile ?? ''}
                    onChange={(e) => setGroupForm((p) => ({ ...p, admin_profile: e.target.value ? Number(e.target.value) : null }))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">{t('facebook.groupsTab.noAdminProfile')}</option>
                    {(profiles ?? []).map((profile: Profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}{isShared(profile.owner_id) ? ' (team)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.groupsTab.fieldStatus')}</label>
                  <select
                    value={groupForm.status ?? 'active'}
                    onChange={(e) => setGroupForm((p) => ({ ...p, status: e.target.value as FacebookGroupStatus }))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    {GROUP_STATUSES.map((status) => (
                      <option key={status} value={status}>{t(`facebook.groupsTab.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.groupsTab.fieldAdminFbProfile')}</label>
                <select
                  value={groupForm.admin_fb_profile ?? ''}
                  onChange={(e) => setGroupForm((p) => ({ ...p, admin_fb_profile: e.target.value ? Number(e.target.value) : null }))}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t('facebook.groupsTab.noAdminFbProfile')}</option>
                  {(fbProfiles ?? []).map((fp) => (
                    <option key={fp.id} value={fp.id}>
                      {fp.name}{isShared(fp.owner_id) ? ' (team)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">{t('facebook.groupsTab.adminFbProfileHint')}</p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">FB Profile đăng bài (poster) <span className="text-xs font-normal text-muted-foreground">— khác admin</span></label>
                <select
                  value={groupForm.default_poster_fb_profile ?? ''}
                  onChange={(e) => setGroupForm((p) => ({ ...p, default_poster_fb_profile: e.target.value ? Number(e.target.value) : null }))}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">— Chưa chọn poster —</option>
                  {(fbProfiles ?? [])
                    .filter((fp) => fp.id !== groupForm.admin_fb_profile)
                    .map((fp) => (
                      <option key={fp.id} value={fp.id}>
                        {fp.name}{isShared(fp.owner_id) ? ' (team)' : ''}
                      </option>
                    ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Tài khoản FB sẽ tap nút Đăng (ẩn danh) khi cron fire. Mặc định
                  áp dụng cho mọi bài import từ Google Sheet — có thể sửa từng
                  bài sau. Phải khác với admin.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.groupsTab.fieldDescription')}</label>
                <textarea
                  value={groupForm.description ?? ''}
                  onChange={(e) => setGroupForm((p) => ({ ...p, description: e.target.value }))}
                  placeholder={t('facebook.groupsTab.fieldDescriptionPlaceholder')}
                  rows={3}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {groupFormError && <p className="text-xs text-destructive">{groupFormError}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" onClick={closeGroupModal} disabled={saveGroupMutation.isPending}>
                {t('common.cancel')}
              </Button>
              <Button onClick={submitGroup} disabled={saveGroupMutation.isPending}>
                {saveGroupMutation.isPending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

function FacebookProfilesTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const navigate = useNavigate()

  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [profileEditing, setProfileEditing] = useState<FacebookProfile | null>(null)
  const [profileForm, setProfileForm] = useState<FacebookProfileCreate>(DEFAULT_PROFILE_FORM)
  const [profileFormError, setProfileFormError] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<FacebookProfileStatus | ''>('')

  const { data: fbProfiles, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['facebook-profiles'],
    queryFn: () => facebookProfilesApi.list(),
  })

  const { data: devices } = useQuery({
    queryKey: ['devices-for-fb-profile'],
    queryFn: () => devicesApi.list(),
  })

  const profilesFiltered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (fbProfiles ?? []).filter((profile) => {
      if (statusFilter && profile.status !== statusFilter) return false
      if (!q) return true
      return (
        profile.name.toLowerCase().includes(q)
        || profile.profile_url.toLowerCase().includes(q)
        || profile.profile_uid.toLowerCase().includes(q)
      )
    })
  }, [fbProfiles, search, statusFilter])

  const saveProfileMutation = useMutation({
    mutationFn: (data: FacebookProfileCreate) =>
      profileEditing ? facebookProfilesApi.update(profileEditing.id, data) : facebookProfilesApi.create(data),
    onSuccess: () => {
      showToast(profileEditing ? t('facebook.profilesTab.saveSuccess') : t('facebook.profilesTab.createSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-profiles'] })
      closeProfileModal()
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.profilesTab.saveError'), 'error'),
  })

  const deleteProfileMutation = useMutation({
    mutationFn: (id: number) => facebookProfilesApi.delete(id),
    onSuccess: () => {
      showToast(t('facebook.profilesTab.deleteSuccess'), 'success')
      qc.invalidateQueries({ queryKey: ['facebook-profiles'] })
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.profilesTab.deleteError'), 'error'),
  })

  function openCreateProfile() {
    setProfileEditing(null)
    setProfileForm(DEFAULT_PROFILE_FORM)
    setProfileFormError('')
    setProfileModalOpen(true)
  }

  function openEditProfile(profile: FacebookProfile) {
    setProfileEditing(profile)
    setProfileForm({
      name: profile.name,
      profile_url: profile.profile_url,
      profile_uid: profile.profile_uid,
      profile_token: profile.profile_token,
      description: profile.description,
      friend_count: profile.friend_count,
      status: profile.status,
      device: profile.device,
      account_name: profile.account_name,
    })
    setProfileFormError('')
    setProfileModalOpen(true)
  }

  function closeProfileModal() {
    setProfileModalOpen(false)
    setProfileEditing(null)
    setProfileForm(DEFAULT_PROFILE_FORM)
    setProfileFormError('')
  }

  function submitProfile() {
    if (!profileForm.name?.trim()) {
      setProfileFormError(t('facebook.profilesTab.nameRequired'))
      return
    }
    saveProfileMutation.mutate({ ...profileForm, name: profileForm.name.trim() })
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('facebook.profilesTab.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('facebook.profilesTab.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`mr-1.5 size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            {t('common.refresh')}
          </Button>
          <Button size="sm" onClick={openCreateProfile}>
            <Plus className="mr-1.5 size-3.5" />
            {t('facebook.profilesTab.addBtn')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('facebook.profilesTab.searchPlaceholder')}
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as FacebookProfileStatus | '')}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t('facebook.profilesTab.filterAllStatus')}</option>
          {PROFILE_STATUSES.map((status) => (
            <option key={status} value={status}>{t(`facebook.profilesTab.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}</option>
          ))}
        </select>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : profilesFiltered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10">
            <User className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t('facebook.profilesTab.empty')}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.profilesTab.colIndex')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.profilesTab.colName')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.profilesTab.colFriends')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.profilesTab.colStatus')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.profilesTab.colCreated')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.profilesTab.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {profilesFiltered.map((profile, idx) => (
                <tr key={profile.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">{idx + 1}</td>
                  <td className="px-4 py-2.5">
                    <p
                      className="font-medium text-foreground cursor-pointer hover:underline hover:text-primary transition-colors"
                      onClick={() => navigate(`/facebook/profiles/${profile.id}`)}
                    >{profile.name}</p>
                    {profile.profile_url ? (
                      <a
                        href={profile.profile_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 inline-flex max-w-[280px] items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{profile.profile_url}</span>
                      </a>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">{profile.friend_count.toLocaleString()}</td>
                  <td className="px-4 py-2.5"><ProfileStatusBadge status={profile.status} /></td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">{formatDate(profile.created_at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => navigate(`/facebook/profiles/${profile.id}`)}
                        aria-label={t('facebook.profilesTab.open')}
                        className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <FileText className="size-3.5" />
                        <span>{t('facebook.profilesTab.open')}</span>
                      </button>
                      <button
                        onClick={() => openEditProfile(profile)}
                        aria-label={t('common.edit')}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        onClick={() => { if (confirm(t('facebook.profilesTab.deleteConfirm'))) deleteProfileMutation.mutate(profile.id) }}
                        aria-label={t('common.delete')}
                        className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {profileModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl flex max-h-[90vh] flex-col">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">
                {profileEditing ? t('facebook.profilesTab.editTitle') : t('facebook.profilesTab.createTitle')}
              </h2>
              <button onClick={closeProfileModal} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col gap-4 overflow-y-auto p-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.profilesTab.fieldName')}</label>
                <input
                  type="text"
                  value={profileForm.name ?? ''}
                  onChange={(e) => setProfileForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder={t('facebook.profilesTab.fieldNamePlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.profilesTab.fieldUrl')}</label>
                <input
                  type="url"
                  value={profileForm.profile_url ?? ''}
                  onChange={(e) => setProfileForm((p) => ({ ...p, profile_url: e.target.value }))}
                  placeholder={t('facebook.profilesTab.fieldUrlPlaceholder')}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.profilesTab.fieldUid')}</label>
                  <input
                    type="text"
                    value={profileForm.profile_uid ?? ''}
                    onChange={(e) => setProfileForm((p) => ({ ...p, profile_uid: e.target.value }))}
                    placeholder={t('facebook.profilesTab.fieldUidPlaceholder')}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('facebook.profilesTab.fieldFriends')}</label>
                  <input
                    type="number"
                    min={0}
                    value={profileForm.friend_count ?? 0}
                    onChange={(e) => setProfileForm((p) => ({ ...p, friend_count: Math.max(0, Number(e.target.value) || 0) }))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.profilesTab.fieldToken')}</label>
                <input
                  type="password"
                  value={profileForm.profile_token ?? ''}
                  onChange={(e) => setProfileForm((p) => ({ ...p, profile_token: e.target.value }))}
                  placeholder={t('facebook.profilesTab.fieldTokenPlaceholder')}
                  autoComplete="off"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">{t('facebook.profilesTab.fieldTokenHint')}</p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.profilesTab.fieldStatus')}</label>
                <select
                  value={profileForm.status ?? 'active'}
                  onChange={(e) => setProfileForm((p) => ({ ...p, status: e.target.value as FacebookProfileStatus }))}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  {PROFILE_STATUSES.map((status) => (
                    <option key={status} value={status}>{t(`facebook.profilesTab.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 gap-3 rounded-lg border border-amber-200/40 bg-amber-50/40 p-3 dark:border-amber-800/40 dark:bg-amber-900/10 sm:grid-cols-2">
                <div className="sm:col-span-2 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
                  <Activity className="size-3.5" />
                  <span className="font-medium">Phoneagent publish target</span>
                  <span>— bắt buộc để đăng bài qua thiết bị.</span>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium">Device</label>
                  <select
                    value={profileForm.device ?? ''}
                    onChange={(e) => setProfileForm((p) => ({ ...p, device: e.target.value ? Number(e.target.value) : null }))}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">— Chưa chọn —</option>
                    {(devices ?? []).map((d) => (
                      <option key={d.id} value={d.id}>{d.name || d.device_serial_id}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium">Account name trên FB app</label>
                  <input
                    type="text"
                    value={profileForm.account_name ?? ''}
                    onChange={(e) => setProfileForm((p) => ({ ...p, account_name: e.target.value }))}
                    placeholder="Vd: Profile A"
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <p className="sm:col-span-2 text-[11px] text-muted-foreground">
                  Account name là tên hiển thị của tài khoản FB trên thiết bị (skill <code className="font-mono">facebook_profile_post</code> dùng để match đúng account khi switch).
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">{t('facebook.profilesTab.fieldDescription')}</label>
                <textarea
                  value={profileForm.description ?? ''}
                  onChange={(e) => setProfileForm((p) => ({ ...p, description: e.target.value }))}
                  placeholder={t('facebook.profilesTab.fieldDescriptionPlaceholder')}
                  rows={3}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {profileFormError && <p className="text-xs text-destructive">{profileFormError}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" onClick={closeProfileModal} disabled={saveProfileMutation.isPending}>
                {t('common.cancel')}
              </Button>
              <Button onClick={submitProfile} disabled={saveProfileMutation.isPending}>
                {saveProfileMutation.isPending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// ─── Placeholder for not-yet-built tabs ───────────────────────────────────────

function PlaceholderTab({ tab }: { tab: 'content' }) {
  const { t } = useTranslation()
  const section = {
    title: t(`facebook.sections.${tab}.title`),
    description: t(`facebook.sections.${tab}.description`),
    items: [
      t(`facebook.sections.${tab}.items.first`),
      t(`facebook.sections.${tab}.items.second`),
      t(`facebook.sections.${tab}.items.third`),
    ],
  }
  return (
    <section className="rounded-2xl border border-border bg-background p-6">
      <div className="border-b border-border pb-4">
        <h2 className="text-lg font-semibold">{section.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {section.items.map((item) => (
          <div key={item} className="rounded-xl border border-border bg-muted/20 p-4">
            <p className="text-sm text-foreground">{item}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function formatNumber(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

function CompetitorAnalyzerCard() {
  const { t } = useTranslation()
  const { showToast } = useToast()
  const [url, setUrl] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [maxPosts, setMaxPosts] = useState(50)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [posts, setPosts] = useState<FacebookCompetitorPost[]>([])

  const analyzeMutation = useMutation({
    mutationFn: () => facebookCompetitorApi.analyze({
      url: url.trim(),
      since: since || undefined,
      until: until || undefined,
      max_posts: maxPosts,
    }),
    onSuccess: (data) => {
      setPosts(data.posts)
      setResultsOpen(true)
      if (data.count === 0) {
        showToast(t('facebook.competitor.emptyResult'), 'info')
      }
    },
    onError: (err) => showToast(err instanceof Error ? err.message : t('facebook.competitor.analyzeError'), 'error'),
  })

  function handleAnalyze() {
    if (!url.trim()) {
      showToast(t('facebook.competitor.urlRequired'), 'error')
      return
    }
    analyzeMutation.mutate()
  }

  const topThreshold = useMemo(() => {
    if (posts.length === 0) return 0
    const sorted = [...posts].sort((a, b) => b.engagement_total - a.engagement_total)
    return sorted[Math.min(2, sorted.length - 1)].engagement_total
  }, [posts])

  return (
    <>
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2"><Target className="size-5 text-primary" /></div>
            <div>
              <h2 className="text-base font-semibold">{t('facebook.competitor.title')}</h2>
              <p className="text-sm text-muted-foreground">{t('facebook.competitor.subtitle')}</p>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_auto_auto_auto]">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('facebook.competitor.urlPlaceholder')}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            title={t('facebook.competitor.since')}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            title={t('facebook.competitor.until')}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="number"
            min={1}
            max={200}
            value={maxPosts}
            onChange={(e) => setMaxPosts(Math.max(1, Math.min(200, Number(e.target.value) || 50)))}
            title={t('facebook.competitor.maxPosts')}
            className="w-20 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <Button onClick={handleAnalyze} disabled={analyzeMutation.isPending}>
            {analyzeMutation.isPending ? (
              <><Loader2 className="mr-1.5 size-3.5 animate-spin" />{t('facebook.competitor.analyzing')}</>
            ) : (
              <><Target className="mr-1.5 size-3.5" />{t('facebook.competitor.analyzeBtn')}</>
            )}
          </Button>
        </div>
      </section>

      {resultsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[92vh] w-full max-w-5xl flex-col rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold">{t('facebook.competitor.resultsTitle', { count: posts.length })}</h2>
                <p className="text-xs text-muted-foreground">{t('facebook.competitor.resultsSubtitle')}</p>
              </div>
              <button onClick={() => setResultsOpen(false)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>

            <div className="overflow-y-auto">
              {posts.length === 0 ? (
                <div className="py-16 text-center text-sm text-muted-foreground">{t('facebook.competitor.emptyResult')}</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border bg-muted/40">
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">#</th>
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">{t('facebook.competitor.colContent')}</th>
                      <th className="px-4 py-2.5 text-left font-medium text-muted-foreground whitespace-nowrap">{t('facebook.competitor.colPostedAt')}</th>
                      <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">{t('facebook.competitor.colReactions')}</th>
                      <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">{t('facebook.competitor.colComments')}</th>
                      <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">{t('facebook.competitor.colShares')}</th>
                      <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">{t('facebook.competitor.colEngagement')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {posts.map((p, idx) => {
                      const isTop = topThreshold > 0 && p.engagement_total >= topThreshold
                      return (
                        <tr key={`${p.post_url}-${idx}`} className={`hover:bg-muted/30 transition-colors ${isTop ? 'bg-amber-50/40 dark:bg-amber-900/10' : ''}`}>
                          <td className="px-4 py-2.5 text-xs tabular-nums text-muted-foreground">
                            <div className="flex items-center gap-1">
                              {isTop && <Trophy className="size-3.5 text-amber-500" />}
                              <span>{idx + 1}</span>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 max-w-[420px]">
                            <p className="line-clamp-2 text-foreground">{p.content || '—'}</p>
                            {p.post_url && (
                              <a href={p.post_url} target="_blank" rel="noopener noreferrer"
                                className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
                                <ExternalLink className="size-3 shrink-0" />
                                <span className="truncate max-w-[300px]">{p.post_url}</span>
                              </a>
                            )}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                            {p.posted_at ? formatDate(p.posted_at) : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            <span className="inline-flex items-center gap-1 text-pink-600 dark:text-pink-400">
                              <Heart className="size-3.5" />{formatNumber(p.reactions_count)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">
                              <MessageCircle className="size-3.5" />{formatNumber(p.comments_count)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Share2 className="size-3.5" />{formatNumber(p.shares_count)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{formatNumber(p.engagement_total)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex items-center justify-end border-t border-border px-5 py-3">
              <Button variant="outline" onClick={() => setResultsOpen(false)}>{t('common.close')}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const VALID_FB_TABS: ReadonlyArray<FacebookTab> = ['pages', 'groups', 'profiles', 'content', 'interactions']

export default function FacebookPage() {
  const { t } = useTranslation()
  // Persist the active tab in the URL so the browser's back button (e.g. from
  // a detail page like /facebook/profiles/:id) restores the tab the user
  // came from instead of falling back to the 'pages' default.
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as FacebookTab | null
  const activeTab: FacebookTab = tabParam && VALID_FB_TABS.includes(tabParam) ? tabParam : 'pages'
  const setActiveTab = (next: FacebookTab) => {
    const sp = new URLSearchParams(searchParams)
    sp.set('tab', next)
    setSearchParams(sp, { replace: true })
  }

  const tabs: { id: FacebookTab; label: string; Icon: React.ElementType }[] = useMemo(
    () => [
      { id: 'pages', label: t('facebook.tabs.pages'), Icon: LayoutGrid },
      { id: 'interactions', label: t('facebook.tabs.interactions'), Icon: Activity },
      { id: 'groups', label: t('facebook.tabs.groups'), Icon: Users },
      { id: 'profiles', label: t('facebook.tabs.profiles'), Icon: User },
      { id: 'content', label: t('facebook.tabs.content'), Icon: Clapperboard },
    ],
    [t],
  )

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{t('facebook.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('facebook.description')}</p>
      </div>

      <CompetitorAnalyzerCard />

      <div className="flex gap-1 rounded-xl border border-border bg-muted/40 p-1">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={[
              'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              activeTab === id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            <Icon className="size-4 shrink-0" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {activeTab === 'pages' ? (
        <FacebookPagesTab />
      ) : activeTab === 'interactions' ? (
        <FacebookInteractionsTab />
      ) : activeTab === 'groups' ? (
        <FacebookGroupsTab />
      ) : activeTab === 'profiles' ? (
        <FacebookProfilesTab />
      ) : (
        <PlaceholderTab tab={activeTab} />
      )}
    </div>
  )
}
