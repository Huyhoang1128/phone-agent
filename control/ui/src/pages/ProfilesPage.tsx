import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronLeft,
  Plus,
  Trash2,
  Save,
  User,
  WandSparkles,
  X,
  LayoutGrid,
  Globe,
  BrainCircuit,
  Clock3,
  GitBranch,
  Files,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScheduleStatusBadge } from '@/components/StatusBadge'
import { ShareButton } from '@/components/ShareResourceDialog'
import ProfileAppStore from '@/components/ProfileAppStore'
import { useToast } from '@/context/ToastContext'
import { useAuth } from '@/context/AuthContext'
import { profilesApi, credentialsApi, workflowsApi, schedulesApi, tiktokApi, facebookScheduledPostsApi, facebookPagesApi, genvideoContentApi } from '@/lib/api'
import type { HighlightClip } from '@/lib/api'
import type { Profile, Credential, ProfileMemory, ProfileRoutine, Workflow, WorkflowTrigger, Schedule, FacebookPage, ProfileContentItem } from '@/lib/types'

type Tab = 'overview' | 'apps' | 'content' | 'memory' | 'routine' | 'scheduledTasks' | 'workflow' | 'files'
type ViewMode = 'my' | 'team'

const EMPTY_FORM = {
  name: '',
  goal: '',
  topic: '',
  topics: [] as string[],
  personality: '',
  website_url: '',
  proxy_host: '',
  proxy_port: null as number | null,
  proxy_username: '',
  proxy_password: '',
  device: null as number | null,
  apps: [] as number[],
  credentials: [] as number[],
}

export default function ProfilesPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const { user } = useAuth()

  const [viewMode, setViewMode] = useState<ViewMode>('my')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saveError, setSaveError] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [showDetail, setShowDetail] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const { data: profiles = [], isLoading } = useQuery<Profile[]>({
    queryKey: ['profiles'],
    queryFn: profilesApi.list,
  })

  const { data: allCredentials = [] } = useQuery<Credential[]>({
    queryKey: ['credentials'],
    queryFn: credentialsApi.list,
  })

  function setFormFromProfile(profile: Profile) {
    setForm({
      name: profile.name,
      goal: profile.goal,
      topic: profile.topic,
      topics: profile.topics?.length ? profile.topics : (profile.topic ? [profile.topic] : []),
      personality: profile.personality,
      website_url: profile.website_url,
      proxy_host: profile.proxy_host,
      proxy_port: profile.proxy_port,
      proxy_username: profile.proxy_username,
      proxy_password: profile.proxy_password,
      device: profile.device,
      apps: profile.apps,
      credentials: profile.credentials,
    })
  }

  const createMutation = useMutation({
    mutationFn: profilesApi.create,
    onSuccess: (profile) => {
      qc.invalidateQueries({ queryKey: ['profiles'] })
      setSelectedId(profile.id)
      setShowDetail(true)
      setFormFromProfile(profile)
      setGeneratedTopics([])
      setIsCreating(false)
      setNewProfileName('')
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (err: Error) => showToast(err.message || t('common.createError'), 'error'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: typeof EMPTY_FORM }) =>
      profilesApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] })
      setSaveError('')
      showToast(t('common.saveSuccess'), 'success')
    },
    onError: (err: Error) => {
      setSaveError(err.message)
      showToast(err.message || t('common.saveError'), 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: profilesApi.delete,
    onSuccess: (_data, deletedId) => {
      qc.invalidateQueries({ queryKey: ['profiles'] })
      if (selectedId === deletedId) {
        setSelectedId(null)
        setShowDetail(false)
        setForm({ ...EMPTY_FORM })
        setGeneratedTopics([])
      }
    },
  })

  function selectProfile(profile: Profile) {
    setSelectedId(profile.id)
    setActiveTab('overview')
    setSaveError('')
    setShowDetail(true)
    setFormFromProfile(profile)
    setGeneratedTopics([])
  }

  function handleNewProfile() {
    setIsCreating(true)
    setNewProfileName('')
  }

  function handleConfirmCreate() {
    const name = newProfileName.trim() || t('profiles.newProfileName')
    createMutation.mutate({ name })
  }

  function handleCancelCreate() {
    setIsCreating(false)
    setNewProfileName('')
  }

  useEffect(() => {
    if (isCreating) {
      nameInputRef.current?.focus()
    }
  }, [isCreating])

  function handleSave() {
    if (!selectedId) return
    if (!form.name.trim()) {
      setSaveError(t('profiles.nameRequired'))
      return
    }
    const normalizedTopics = Array.from(new Set(form.topics.map((item) => item.trim()).filter(Boolean)))
    updateMutation.mutate({
      id: selectedId,
      data: {
        ...form,
        topics: normalizedTopics,
        topic: normalizedTopics[0] ?? '',
      },
    })
  }

  function toggleCredential(credId: number) {
    setForm((f) => ({
      ...f,
      credentials: f.credentials.includes(credId)
        ? f.credentials.filter((id) => id !== credId)
        : [...f.credentials, credId],
    }))
  }

  const generateTopicsMutation = useMutation({
    mutationFn: ({ profileId, personality, existingTopics }: { profileId: number; personality: string; existingTopics: string[] }) =>
      profilesApi.generateTopics(profileId, { personality, existing_topics: existingTopics, count: 5 }),
    onError: (err: Error) => showToast(err.message || t('common.saveError'), 'error'),
  })

  const topicActionMutation = useMutation({
    mutationFn: ({ profileId, action, topic, topics, metadata }: { profileId: number; action: string; topic?: string; topics?: string[]; metadata?: Record<string, unknown> }) =>
      profilesApi.logTopicAction(profileId, { action, topic, topics, metadata }),
  })

  function removeSavedTopic(topic: string) {
    if (selectedId == null) return
    const nextTopics = form.topics.filter((item) => item !== topic)
    setForm((f) => ({
      ...f,
      topics: nextTopics,
      topic: nextTopics[0] ?? '',
    }))
    topicActionMutation.mutate({ profileId: selectedId, action: 'remove_saved_topic', topic })
  }

  function removeGeneratedTopic(topic: string) {
    if (selectedId == null) return
    const nextGeneratedTopics = generatedTopics.filter((item) => item !== topic)
    setGeneratedTopics(nextGeneratedTopics)
    topicActionMutation.mutate({ profileId: selectedId, action: 'remove_generated_topic', topic })
  }

  const [generatedTopics, setGeneratedTopics] = useState<string[]>([])

  function applyGeneratedTopics() {
    if (selectedId == null || generatedTopics.length === 0) return
    const profileId = selectedId
    const nextTopics = Array.from(new Set([...form.topics, ...generatedTopics]))
    setForm((f) => ({
      ...f,
      topics: nextTopics,
      topic: nextTopics[0] ?? '',
    }))
    topicActionMutation.mutate({
      profileId,
      action: 'apply_generated_topics',
      topics: generatedTopics,
    }, {
      onSuccess: async () => {
        try {
          const updatedProfile = await profilesApi.get(profileId)
          setFormFromProfile(updatedProfile)
          setGeneratedTopics([])
          qc.invalidateQueries({ queryKey: ['profiles'] })
        } catch (err) {
          showToast(err instanceof Error ? err.message : t('common.saveError'), 'error')
        }
      },
      onError: (err: Error) => showToast(err.message || t('common.saveError'), 'error'),
    })
  }

  function handleGenerateTopics() {
    if (selectedId == null || generateTopicsMutation.isPending) return
    const allTopics = Array.from(new Set([...form.topics, ...generatedTopics]))
    generateTopicsMutation.mutate(
      { profileId: selectedId, personality: form.personality, existingTopics: allTopics },
      {
        onSuccess: (data) => {
          const nextTopics = Array.from(new Set([...generatedTopics, ...(data.topics || [])]))
          setGeneratedTopics(nextTopics)
          showToast(t('profiles.topicGenerateSuccess', { count: data.topics?.length || 0 }), 'success')
        },
      },
    )
  }

  const tabs: { key: Tab; label: string; icon: React.ElementType; soon?: boolean }[] = [
    { key: 'overview', label: t('profiles.tabOverview'), icon: User },
    { key: 'apps', label: t('profiles.tabApps'), icon: LayoutGrid },
    { key: 'content', label: 'Content', icon: Globe },
    { key: 'memory', label: t('profiles.tabMemory'), icon: BrainCircuit },
    { key: 'routine', label: t('profiles.tabRoutine'), icon: Clock3 },
    { key: 'scheduledTasks', label: t('profiles.tabScheduledTasks'), icon: Check },
    { key: 'workflow', label: t('profiles.tabWorkflow'), icon: GitBranch },
    { key: 'files', label: t('profiles.tabFiles'), icon: Files, soon: true },
  ]

  // Derived lists for each view mode
  const myProfiles = profiles.filter((p) => p.owner_id === user?.id)
  const teamProfiles = profiles.filter((p) => p.team_id !== null && p.owner_id !== user?.id)

  // Group team profiles by team name
  const teamGroups = teamProfiles.reduce<Record<string, Profile[]>>((acc, p) => {
    const key = p.team_name ?? String(p.team_id)
    acc[key] = [...(acc[key] ?? []), p]
    return acc
  }, {})

  const selectedProfile = profiles.find((p) => p.id === selectedId) ?? null

  // The Apps tab needs to know whether the profile has a device bound.
  const profileHasDevice = form.device != null

  return (
    <div className="flex h-full">
      {/* ── Left panel: profile list ── */}
      <div
        className={`flex shrink-0 flex-col border-r border-border ${
          showDetail ? 'hidden md:flex md:w-56' : 'w-full md:w-56'
        }`}
      >
        {/* View mode toggle */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setViewMode('my')}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              viewMode === 'my'
                ? 'border-b-2 border-foreground text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('profiles.viewMy')}
          </button>
          <button
            onClick={() => setViewMode('team')}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              viewMode === 'team'
                ? 'border-b-2 border-foreground text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('profiles.viewTeam')}
          </button>
        </div>

        {viewMode === 'my' && (
          <button
            onClick={handleNewProfile}
            disabled={createMutation.isPending || isCreating}
            className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <Plus className="size-4" />
            {t('profiles.newProfile')}
          </button>
        )}
        {/* Inline name input shown when creating a new profile */}
        {isCreating && (
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
            <input
              ref={nameInputRef}
              type="text"
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmCreate()
                if (e.key === 'Escape') handleCancelCreate()
              }}
              placeholder={t('profiles.namePlaceholder')}
              disabled={createMutation.isPending}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            />
            <button
              onClick={handleConfirmCreate}
              disabled={createMutation.isPending}
              aria-label={t('common.save')}
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <Check className="size-3.5" />
            </button>
            <button
              onClick={handleCancelCreate}
              disabled={createMutation.isPending}
              aria-label={t('profiles.createCancel')}
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">{t('common.loading')}</p>
          ) : viewMode === 'my' ? (
            myProfiles.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted-foreground">{t('profiles.noProfiles')}</p>
            ) : (
              myProfiles.map((profile) => (
                <div
                  key={profile.id}
                  onClick={() => selectProfile(profile)}
                  className={`group flex cursor-pointer items-center justify-between px-4 py-2.5 text-sm transition-colors ${
                    selectedId === profile.id
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <span className="truncate">{profile.name}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteMutation.mutate(profile.id)
                    }}
                    className="ml-1 hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"
                    aria-label={t('profiles.deleteProfile')}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))
            )
          ) : teamProfiles.length === 0 ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">{t('profiles.noTeamProfiles')}</p>
          ) : (
            Object.entries(teamGroups).map(([teamName, groupProfiles]) => (
              <div key={teamName}>
                <p className="border-b border-border bg-muted/50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('profiles.teamGroup', { name: teamName })}
                </p>
                {groupProfiles.map((profile) => (
                  <div
                    key={profile.id}
                    onClick={() => selectProfile(profile)}
                    className={`flex cursor-pointer items-center px-4 py-2.5 text-sm transition-colors ${
                      selectedId === profile.id
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    <span className="truncate">{profile.name}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Right panel ── */}
      {selectedId == null ? (
        <div className="hidden md:flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t('profiles.selectOrCreate')}
        </div>
      ) : (
        <div
          className={`flex-1 flex-col overflow-hidden ${
            showDetail ? 'flex' : 'hidden md:flex'
          }`}
        >
          {/* Back button — mobile only */}
          <div className="flex items-center border-b border-border px-3 py-2 md:hidden">
            <button
              onClick={() => setShowDetail(false)}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
              {t('common.back')}
            </button>
          </div>

          {/* Tab bar + Save */}
          <div className="flex items-center justify-between border-b border-border px-4">
            <div className="flex overflow-x-auto">
              {tabs.map(({ key, label, icon: Icon, soon }) => (
                <button
                  key={key}
                  disabled={soon}
                  onClick={() => !soon && setActiveTab(key)}
                  className={`flex items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
                    activeTab === key && !soon
                      ? 'border-foreground text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-60'
                  }`}
                >
                  <Icon className="size-4" />
                  <span className="hidden sm:inline">{label}</span>
                  {soon && (
                    <>
                      <span className="ml-1 hidden rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">
                        {t('profiles.soon')}
                      </span>
                      <span className="sr-only">{t('profiles.soon')}</span>
                    </>
                  )}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={updateMutation.isPending}
                className="gap-1.5"
              >
                <Save className="size-4" />
                {updateMutation.isPending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-auto p-6">
            {saveError && (
              <p className="mb-4 text-xs text-destructive">{saveError}</p>
            )}

            {/* Overview tab */}
            {activeTab === 'overview' && (
              <div className="max-w-2xl">
                <h2 className="text-base font-semibold">{t('profiles.overviewTitle')}</h2>
                <p className="mt-1 mb-6 text-sm text-muted-foreground">
                  {t('profiles.overviewDescription')}
                </p>

                {/* Name */}
                <div className="mb-6 flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('profiles.fieldName')}</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                {/* Website URL */}
                <div className="mb-6 flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('profiles.websiteUrlLabel')}</label>
                  <p className="text-xs text-muted-foreground">{t('profiles.websiteUrlDescription')}</p>
                  <input
                    type="url"
                    value={form.website_url}
                    onChange={(e) => setForm({ ...form, website_url: e.target.value })}
                    placeholder={t('profiles.websiteUrlPlaceholder')}
                    className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                {/* Summary table */}
                <div className="overflow-hidden rounded-lg border border-border">
                  <SummaryRow
                    label={t('profiles.summaryApps')}
                    value={
                      form.apps.length > 0
                        ? t('profiles.summaryAppsCount', { count: form.apps.length })
                        : t('profiles.summaryNoneConfigured')
                    }
                  />
                  <SummaryRow
                    label={t('profiles.summaryProxy')}
                    value={
                      form.proxy_host
                        ? `${form.proxy_host}${form.proxy_port ? ':' + form.proxy_port : ''}`
                        : t('profiles.summaryNotConfigured')
                    }
                  />
                  <SummaryRow
                    label={t('profiles.summaryTopic')}
                    value={form.topics.length > 0 ? form.topics.join(', ') : t('profiles.summaryNotConfigured')}
                  />
                  <SummaryRow label={t('profiles.summaryWorkflow')} value={t('profiles.comingSoon')} />
                  <SummaryRow label={t('profiles.summaryLocation')} value={t('profiles.comingSoon')} last />
                </div>

                {/* Goal section */}
                <div className="mt-6 flex flex-col gap-2">
                  <label className="text-sm font-medium">{t('profiles.topicLabel')}</label>
                  <p className="text-xs text-muted-foreground">{t('profiles.topicDescription')}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleGenerateTopics}
                      disabled={selectedId == null || generateTopicsMutation.isPending}
                      className="gap-1.5"
                    >
                      <WandSparkles className="size-4" />
                      {generateTopicsMutation.isPending ? t('profiles.topicGenerating') : t('profiles.topicGenerateAction')}
                    </Button>
                    {generatedTopics.length > 0 && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={applyGeneratedTopics}
                      >
                        {t('profiles.topicApplyGenerated')}
                      </Button>
                    )}
                  </div>

                  <div className="rounded-lg border border-border bg-background p-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">{t('profiles.topicSavedTitle')}</p>
                    {form.topics.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('profiles.topicSavedEmpty')}</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {form.topics.map((item) => (
                          <span key={`saved-${item}`} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                            {item}
                            <button
                              type="button"
                              onClick={() => removeSavedTopic(item)}
                              className="text-primary/80 hover:text-primary"
                              aria-label={t('profiles.topicRemoveSaved')}
                            >
                              <X className="size-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {generatedTopics.length > 0 && (
                    <div className="rounded-lg border border-border bg-muted/20 p-3">
                      <p className="mb-2 text-xs font-medium text-muted-foreground">{t('profiles.topicGeneratedTitle')}</p>
                      <div className="flex flex-wrap gap-2">
                        {generatedTopics.map((item) => (
                          <span key={`generated-${item}`} className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                            {item}
                            <button
                              type="button"
                              onClick={() => removeGeneratedTopic(item)}
                              className="text-emerald-700/80 hover:text-emerald-700 dark:text-emerald-300/80 dark:hover:text-emerald-300"
                              aria-label={t('profiles.topicRemoveGenerated')}
                            >
                              <X className="size-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {(selectedProfile?.topic_history?.length ?? 0) > 0 && (
                    <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3">
                      <p className="mb-2 text-xs font-medium text-muted-foreground">{t('profiles.topicHistoryTitle')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {(selectedProfile?.topic_history ?? []).map((item, idx) => (
                          <span key={`${item.topic}-${idx}`} className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                            {item.topic}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Goal section */}
                <div className="mt-6 flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('profiles.goalLabel')}</label>
                  <p className="text-xs text-muted-foreground">{t('profiles.goalDescription')}</p>
                  <textarea
                    value={form.goal}
                    onChange={(e) => setForm({ ...form, goal: e.target.value })}
                    rows={4}
                    placeholder={t('profiles.goalPlaceholder')}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
                  />
                </div>

                {/* Personality section */}
                <div className="mt-6 flex flex-col gap-1.5">
                  <label className="text-sm font-medium">{t('profiles.personalityLabel')}</label>
                  <p className="text-xs text-muted-foreground">{t('profiles.personalityDescription')}</p>
                  <textarea
                    value={form.personality}
                    onChange={(e) => setForm({ ...form, personality: e.target.value })}
                    rows={4}
                    placeholder={t('profiles.personalityPlaceholder')}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring resize-none"
                  />
                </div>

                {selectedId != null &&
                  selectedProfile != null &&
                  selectedProfile.owner_id === user?.id && (
                  <div className="mt-8 flex justify-end border-t border-border pt-4">
                    <ShareButton
                      currentTeamId={selectedProfile.team_id}
                      currentTeamName={selectedProfile.team_name}
                      currentPermission={selectedProfile.team_permission}
                      onShare={(teamId, permission) =>
                        profilesApi.share(selectedId, teamId, permission)
                      }
                      onUnshare={() => profilesApi.unshare(selectedId)}
                      invalidateKey={['profiles']}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Apps tab */}
            {activeTab === 'apps' && selectedId != null && (
              <div className="max-w-2xl">
                {!profileHasDevice && (
                  <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
                    {t('profiles.appsNoDeviceWarning')}
                  </div>
                )}

                {/* CHPlay — unified app store / queue for this profile */}
                <h2 className="text-base font-semibold">{t('profiles.appStoreTitle')}</h2>
                <p className="mt-1 mb-3 text-sm text-muted-foreground">
                  {t('profiles.appStoreDescription')}
                </p>
                <ProfileAppStore profileId={selectedId} hasDevice={profileHasDevice} />

                {/* Credentials — still saved via the Save button */}
                <h2 className="mt-8 text-base font-semibold">{t('profiles.credentialsTitle')}</h2>
                <p className="mt-1 mb-3 text-sm text-muted-foreground">
                  {t('profiles.credentialsDescription')}
                </p>
                {allCredentials.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('profiles.noCredentialsAvailable')}</p>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border">
                    {allCredentials.map((cred, i) => (
                      <label
                        key={cred.id}
                        className={`flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-muted ${
                          i < allCredentials.length - 1 ? 'border-b border-border' : ''
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={form.credentials.includes(cred.id)}
                          onChange={() => toggleCredential(cred.id)}
                          className="size-4 rounded"
                        />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{cred.app_name}</p>
                          <p className="text-xs text-muted-foreground">{cred.username}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Content tab */}
            {activeTab === 'content' && selectedId != null && (
              <ProfileContentTab profileId={selectedId} profileTopic={form.topic} />
            )}

            {/* Memory tab */}
            {activeTab === 'memory' && selectedId != null && (
              <ProfileMemoryTab profileId={selectedId} />
            )}

            {/* Routine tab */}
            {activeTab === 'routine' && selectedId != null && (
              <ProfileRoutineTab profileId={selectedId} />
            )}

            {/* Scheduled tasks tab */}
            {activeTab === 'scheduledTasks' && selectedId != null && (
              <ProfileScheduledTasksTab profileId={selectedId} />
            )}

            {/* Workflow tab */}
            {activeTab === 'workflow' && selectedId != null && (
              <ProfileWorkflowTab profileId={selectedId} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryRow({
  label,
  value,
  last,
}: {
  label: string
  value: string
  last?: boolean
}) {
  return (
    <div
      className={`flex items-center justify-between px-4 py-3 text-sm ${
        !last ? 'border-b border-border' : ''
      }`}
    >
      <span className="text-foreground">{label}</span>
      <span className="text-muted-foreground">{value}</span>
    </div>
  )
}

function ProfileMemoryTab({ profileId }: { profileId: number }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const [memoryKey, setMemoryKey] = useState('')
  const [memoryValue, setMemoryValue] = useState('')
  const [memoryTags, setMemoryTags] = useState('')
  const [formError, setFormError] = useState('')

  const { data: items = [], isLoading } = useQuery<ProfileMemory[]>({
    queryKey: ['profile-memory', profileId],
    queryFn: () => profilesApi.listMemory(profileId),
  })

  const setMutation = useMutation({
    mutationFn: () => {
      const tags = memoryTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      return profilesApi.setMemory(profileId, memoryKey.trim(), memoryValue, tags)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile-memory', profileId] })
      setMemoryKey('')
      setMemoryValue('')
      setMemoryTags('')
      setFormError('')
      showToast(t('common.saveSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message, 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => profilesApi.deleteMemory(profileId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile-memory', profileId] })
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!memoryKey.trim()) {
      setFormError(t('profiles.keyRequired'))
      return
    }
    setMutation.mutate()
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-base font-semibold">{t('profiles.memoryTitle')}</h2>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">{t('profiles.memoryDescription')}</p>

      <form onSubmit={handleSubmit} className="mb-4 flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
        <p className="text-xs font-medium text-muted-foreground">{t('profiles.addMemory')}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            placeholder={t('profiles.keyPlaceholder')}
            value={memoryKey}
            onChange={(e) => setMemoryKey(e.target.value)}
            className="h-8 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring sm:flex-1"
          />
          <input
            type="text"
            placeholder={t('profiles.valuePlaceholder')}
            value={memoryValue}
            onChange={(e) => setMemoryValue(e.target.value)}
            className="h-8 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring sm:flex-[2]"
          />
          <Button type="submit" size="sm" disabled={setMutation.isPending}>
            <Plus className="size-3.5" />
          </Button>
        </div>
        <input
          type="text"
          placeholder={t('profiles.tagsPlaceholder')}
          value={memoryTags}
          onChange={(e) => setMemoryTags(e.target.value)}
          className="h-8 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        {formError && <p className="text-xs text-destructive">{formError}</p>}
      </form>

      {isLoading ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('profiles.noMemory')}</p>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border overflow-hidden">
          {items.map((item) => (
            <div key={item.id} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-mono font-medium text-muted-foreground mb-0.5">{item.key}</p>
                <p className="text-sm break-all">{item.value}</p>
                {item.tags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {item.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {new Date(item.updated_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}
                </p>
              </div>
              <button
                onClick={() => deleteMutation.mutate(item.id)}
                className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                aria-label={t('common.delete')}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const CRON_PRESETS: { labelKey: string; cron: string; time: string }[] = [
  { labelKey: 'profiles.routineCronPresetDaily8',   cron: '0 8 * * *',   time: '08:00' },
  { labelKey: 'profiles.routineCronPresetDaily12',  cron: '0 12 * * *',  time: '12:00' },
  { labelKey: 'profiles.routineCronPresetDaily19',  cron: '0 19 * * *',  time: '19:00' },
  { labelKey: 'profiles.routineCronPresetDaily21',  cron: '0 21 * * *',  time: '21:00' },
  { labelKey: 'profiles.routineCronPresetMon',      cron: '0 8 * * 1',   time: '08:00' },
  { labelKey: 'profiles.routineCronPresetTue',      cron: '0 8 * * 2',   time: '08:00' },
  { labelKey: 'profiles.routineCronPresetWed',      cron: '0 8 * * 3',   time: '08:00' },
  { labelKey: 'profiles.routineCronPresetThu',      cron: '0 8 * * 4',   time: '08:00' },
  { labelKey: 'profiles.routineCronPresetFri',      cron: '0 8 * * 5',   time: '08:00' },
  { labelKey: 'profiles.routineCronPresetWeekdays', cron: '0 8 * * 1-5', time: '08:00' },
]

function ProfileRoutineTab({ profileId }: { profileId: number }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const [scheduleTime, setScheduleTime] = useState('')
  const [routineAction, setRoutineAction] = useState('')
  const [cronExpression, setCronExpression] = useState('')
  const [formError, setFormError] = useState('')

  const { data: items = [], isLoading } = useQuery<ProfileRoutine[]>({
    queryKey: ['profile-routines', profileId],
    queryFn: () => profilesApi.listRoutines(profileId),
  })

  const createMutation = useMutation({
    mutationFn: () =>
      profilesApi.createRoutine(profileId, {
        schedule_time: scheduleTime,
        action: routineAction.trim(),
        cron_expression: cronExpression.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile-routines', profileId] })
      qc.invalidateQueries({ queryKey: ['profiles'] })
      setScheduleTime('')
      setRoutineAction('')
      setCronExpression('')
      setFormError('')
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message || t('common.createError'), 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => profilesApi.deleteRoutine(profileId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile-routines', profileId] })
      qc.invalidateQueries({ queryKey: ['profiles'] })
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!scheduleTime || !routineAction.trim() || !cronExpression.trim()) {
      setFormError(t('profiles.routineRequired'))
      return
    }
    createMutation.mutate()
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-base font-semibold">{t('profiles.routineTitle')}</h2>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">{t('profiles.routineDescription')}</p>

      <form onSubmit={handleSubmit} className="mb-4 rounded-lg border border-border bg-muted/30 p-4">
        <p className="mb-3 text-xs font-medium text-muted-foreground">{t('profiles.routineAdd')}</p>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">{t('profiles.routineTime')}</label>
            <input
              type="time"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
              className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1 md:col-span-2">
            <label className="text-xs text-muted-foreground">{t('profiles.routineAction')}</label>
            <input
              type="text"
              value={routineAction}
              onChange={(e) => setRoutineAction(e.target.value)}
              placeholder={t('profiles.routineActionPlaceholder')}
              className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1 md:col-span-3">
            <label className="text-xs text-muted-foreground">{t('profiles.routineCron')}</label>
            <input
              type="text"
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              placeholder={t('profiles.routineCronPlaceholder')}
              className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">{t('profiles.routineCronPresets')}</span>
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.cron}
                  type="button"
                  onClick={() => {
                    setCronExpression(preset.cron)
                    setScheduleTime(preset.time)
                  }}
                  className="rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                >
                  {t(preset.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>
        {formError && <p className="mt-2 text-xs text-destructive">{formError}</p>}
        <Button type="submit" size="sm" className="mt-3" disabled={createMutation.isPending}>
          <Plus className="mr-1 size-3.5" />
          {createMutation.isPending ? t('common.creating') : t('common.create')}
        </Button>
      </form>

      {isLoading ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('profiles.routineEmpty')}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[120px_1fr_180px_52px] bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground">
            <span>{t('profiles.routineTime')}</span>
            <span>{t('profiles.routineAction')}</span>
            <span>{t('profiles.routineCron')}</span>
            <span />
          </div>
          {items.map((item, i) => (
            <div
              key={item.id}
              className={`grid grid-cols-[120px_1fr_180px_52px] items-start gap-2 px-4 py-3 text-sm ${
                i < items.length - 1 ? 'border-b border-border' : ''
              }`}
            >
              <span>{item.schedule_time.slice(0, 5)}</span>
              <span>{item.action}</span>
              <span className="font-mono text-xs text-muted-foreground">{item.cron_expression}</span>
              <button
                onClick={() => deleteMutation.mutate(item.id)}
                className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                aria-label={t('common.delete')}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function triggerLabel(trigger: WorkflowTrigger, t: (key: string) => string): string {
  if (trigger.trigger_type === 'periodic') {
    const type = trigger.periodic_schedule_type
    if (type === 'interval' && trigger.interval_seconds != null)
      return `${t('workflowDetail.interval')} · ${trigger.interval_seconds}s`
    if (type === 'cron' && trigger.cron_expression)
      return `${t('workflowDetail.cron')} · ${trigger.cron_expression}`
    if (type === 'once' && trigger.run_at)
      return `${t('workflowDetail.once')} · ${new Date(trigger.run_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}`
    return t('workflowDetail.periodic')
  }
  if (trigger.trigger_type === 'event') return trigger.event_name || t('workflowDetail.event')
  return t('workflowDetail.webhook')
}

function ProfileWorkflowTab({ profileId }: { profileId: number }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const [showPicker, setShowPicker] = useState(false)

  const { data: workflows = [], isLoading } = useQuery<Workflow[]>({
    queryKey: ['profile-workflows', profileId],
    queryFn: () => workflowsApi.listByProfile(profileId),
  })

  const { data: allWorkflows = [] } = useQuery<Workflow[]>({
    queryKey: ['workflows'],
    queryFn: workflowsApi.list,
    enabled: showPicker,
  })

  // Show all workflows not already assigned to this profile
  const candidateWorkflows = allWorkflows.filter((wf) => wf.profile_id !== profileId)

  const addMutation = useMutation({
    mutationFn: (workflowId: number) =>
      workflowsApi.update(workflowId, { profile: profileId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile-workflows', profileId] })
      qc.invalidateQueries({ queryKey: ['workflows'] })
      showToast(t('profiles.workflowAdded'), 'success')
    },
    onError: (err: Error) => showToast(err.message || t('common.saveError'), 'error'),
  })

  const removeMutation = useMutation({
    mutationFn: (workflowId: number) =>
      workflowsApi.update(workflowId, { profile: null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile-workflows', profileId] })
      qc.invalidateQueries({ queryKey: ['workflows'] })
      showToast(t('profiles.workflowRemoved'), 'success')
    },
    onError: (err: Error) => showToast(err.message || t('common.saveError'), 'error'),
  })

  return (
    <div className="max-w-2xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{t('profiles.tabWorkflow')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('profiles.workflowDescription')}</p>
        </div>
        <Button size="sm" onClick={() => setShowPicker(true)} className="shrink-0">
          <Plus className="mr-1 size-4" />
          {t('profiles.addWorkflow')}
        </Button>
      </div>

      {isLoading ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('common.loading')}</p>
      ) : workflows.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('profiles.noWorkflows')}</p>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border overflow-hidden">
          {workflows.map((wf) => (
            <div key={wf.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
              <GitBranch className="size-4 shrink-0 text-muted-foreground" />
              <Link to={`/workflow/${wf.id}`} className="min-w-0 flex-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <p className="text-sm font-medium truncate hover:underline">{wf.name}</p>
                {wf.description && (
                  <p className="text-xs text-muted-foreground truncate">{wf.description}</p>
                )}
                {wf.triggers.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1" aria-label={t('workflowDetail.triggersTitle')}>
                    {wf.triggers.map((trigger) => (
                      <span
                        key={trigger.id}
                        className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {triggerLabel(trigger, t)}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                wf.status === 'active'
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : 'bg-muted text-muted-foreground'
              }`}>
                {wf.status}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => removeMutation.mutate(wf.id)}
                disabled={removeMutation.isPending}
                aria-label={t('profiles.removeWorkflow')}
              >
                <Trash2 className="size-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Add Workflow Picker */}
      {showPicker && (
        <div className="mt-4 rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">{t('profiles.addWorkflowTitle')}</h3>
            <button
              onClick={() => setShowPicker(false)}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label={t('common.close')}
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto p-2">
            {candidateWorkflows.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('profiles.workflowPickerEmpty')}
              </p>
            ) : (
              candidateWorkflows.map((wf) => (
                <button
                  key={wf.id}
                  onClick={() => {
                    addMutation.mutate(wf.id)
                    setShowPicker(false)
                  }}
                  disabled={addMutation.isPending}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted disabled:opacity-50"
                >
                  <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{wf.name}</p>
                    {wf.description && (
                      <p className="text-xs text-muted-foreground truncate">{wf.description}</p>
                    )}
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    wf.status === 'active'
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-muted text-muted-foreground'
                  }`}>
                    {wf.status}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ProfileScheduledTasksTab({ profileId }: { profileId: number }) {
  const { t } = useTranslation()

  const { data: schedules = [], isLoading } = useQuery<Schedule[]>({
    queryKey: ['profile-schedules', profileId],
    queryFn: () => schedulesApi.listByProfile(profileId),
  })

  return (
    <div className="max-w-3xl">
      <h2 className="text-base font-semibold">{t('profiles.scheduledTasksTitle')}</h2>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">{t('profiles.scheduledTasksDescription')}</p>

      {isLoading ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('common.loading')}</p>
      ) : schedules.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('profiles.noScheduledTasks')}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[1fr_110px_120px_170px_170px] bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground">
            <span>{t('profiles.scheduledTaskColumnTask')}</span>
            <span>{t('profiles.scheduledTaskColumnType')}</span>
            <span>{t('profiles.scheduledTaskColumnStatus')}</span>
            <span>{t('profiles.scheduledTaskColumnNextRun')}</span>
            <span>{t('profiles.scheduledTaskColumnLastRun')}</span>
          </div>
          {schedules.map((item, i) => (
            <div
              key={item.id}
              className={`grid grid-cols-[1fr_110px_120px_170px_170px] items-center gap-2 px-4 py-3 text-sm ${
                i < schedules.length - 1 ? 'border-b border-border' : ''
              }`}
            >
              <Link
                to={`/tasks/${item.task.id}`}
                className="truncate font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              >
                {item.task.name}
              </Link>
              <span className="text-muted-foreground">{item.schedule_type}</span>
              <span><ScheduleStatusBadge status={item.status} /></span>
              <span className="text-xs text-muted-foreground">
                {item.next_run_at ? new Date(item.next_run_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' }) : '—'}
              </span>
              <span className="text-xs text-muted-foreground">
                {item.last_run_at ? new Date(item.last_run_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' }) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type RepostPlatform = 'tiktok' | 'facebook' | 'youtube' | 'instagram'
type VideoItem = { id: number; link_download: string; des: string; filename: string; timestamp: string }

function fmtTime(ts: string) {
  try { return new Date(ts).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }
  catch { return ts }
}

function VideoCard({
  filename, des, timestamp, link_download, checked, onCheck, onRepost,
}: {
  filename: string; des: string; timestamp: string; link_download: string
  checked: boolean; onCheck: (v: boolean) => void; onRepost: () => void
}) {
  return (
    <div className={`rounded-xl border overflow-hidden transition-all bg-card ${checked ? 'border-primary ring-1 ring-primary/30' : 'border-border hover:border-primary/40'}`}>
      <div className="relative bg-black">
        <video src={link_download} className="w-full max-h-48 object-contain" preload="metadata" controls />
        <label className="absolute top-2 left-2 cursor-pointer z-10">
          <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onCheck(e.target.checked)} />
          <div className={`size-5 rounded border-2 flex items-center justify-center transition ${checked ? 'bg-primary border-primary' : 'bg-black/50 border-white/80 backdrop-blur-sm'}`}>
            {checked && <Check className="size-3 text-white stroke-[3]" />}
          </div>
        </label>
      </div>
      <div className="p-3">
        <p className="text-sm font-medium truncate" title={filename}>{filename}</p>
        {des && <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{des}</p>}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">{fmtTime(timestamp)}</span>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs shrink-0" onClick={onRepost}>Đăng lại</Button>
        </div>
      </div>
    </div>
  )
}

function ProfileContentTab({ profileId, profileTopic }: { profileId: number; profileTopic: string }) {
  const { showToast } = useToast()
  const qc = useQueryClient()

  // Highlights state
  const [highlightUrl, setHighlightUrl] = useState('')
  const [highlightLoading, setHighlightLoading] = useState(false)
  const [highlightClips, setHighlightClips] = useState<HighlightClip[]>([])

  const { data: contentItems = [], isLoading: todayLoading } = useQuery<ProfileContentItem[]>({
    queryKey: ['profile-content-items', profileId],
    queryFn: () => profilesApi.listContentItems(profileId),
  })
  const todayVideos: VideoItem[] = contentItems.map((item) => ({
    id: item.id,
    link_download: item.video_url,
    des: item.description,
    filename: item.title || `#${item.id}`,
    timestamp: item.updated_at || item.created_at,
  }))

  // Multi-select + bulk schedule state
  const [selectedLinks, setSelectedLinks] = useState<Set<string>>(new Set())
  const [bulkModalOpen, setBulkModalOpen] = useState(false)
  const [bulkPlatform, setBulkPlatform] = useState<'tiktok' | 'facebook'>('tiktok')
  const [bulkTime, setBulkTime] = useState('')
  const [bulkInterval, setBulkInterval] = useState(30)
  const [bulkFbPageId, setBulkFbPageId] = useState<number | null>(null)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkError, setBulkError] = useState('')

  // Repost modal state
  const [repostVideo, setRepostVideo] = useState<VideoItem | null>(null)
  const [repostPlatform, setRepostPlatform] = useState<RepostPlatform>('tiktok')
  const [repostScheduledAt, setRepostScheduledAt] = useState('')
  const [repostContent, setRepostContent] = useState('')
  const [repostFbPageId, setRepostFbPageId] = useState<number | null>(null)
  const [repostLoading, setRepostLoading] = useState(false)
  const [repostError, setRepostError] = useState('')

  const { data: facebookPages = [] } = useQuery<FacebookPage[]>({
    queryKey: ['facebook-pages'],
    queryFn: () => facebookPagesApi.list(),
    enabled: (repostVideo !== null && repostPlatform === 'facebook') || (bulkModalOpen && bulkPlatform === 'facebook'),
  })

  async function handleHighlightSubmit() {
    const url = highlightUrl.trim()
    if (!url) return
    setHighlightLoading(true)
    try {
      const { task_id, estimated_seconds } = await genvideoContentApi.requestHighlights(url)
      const estMins = estimated_seconds ? Math.ceil(estimated_seconds / 60) : null
      showToast(estMins ? `Đang xử lý, dự kiến ~${estMins} phút…` : `Task ID: ${task_id}`, 'success')
      setHighlightClips([])
      ;(async () => {
        // Poll budget scales with the service estimate so long videos don't
        // time out at the old fixed 6 min. 2× the estimate for safety,
        // clamped to [20 min, 40 min]. estimated_seconds may be null.
        const POLL_INTERVAL_MS = 5000
        const estMs = (estimated_seconds ?? 0) * 1000
        const budgetMs = Math.min(Math.max(estMs * 2, 20 * 60 * 1000), 40 * 60 * 1000)
        const maxAttempts = Math.ceil(budgetMs / POLL_INTERVAL_MS)
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
          const task = await genvideoContentApi.getTask(task_id)
          if (task.status === 'succeeded' || task.status === 'finished' || task.status === 'done') {
            const clips = task.result?.highlights ?? []
            setHighlightClips(clips)
            if (clips.length > 0) {
              await Promise.all(
                clips.map((clip) =>
                  profilesApi.createContentItem(profileId, {
                    title: clip.filename,
                    source_url: url,
                    video_url: clip.download_url,
                    description: clip.action_desc || clip.transcript || '',
                    tags: [profileTopic].filter(Boolean),
                    metadata: {
                      clip_id: clip.id,
                      rank: clip.rank,
                      timestamp: clip.timestamp,
                      task_id,
                    },
                  }),
                ),
              )
              qc.invalidateQueries({ queryKey: ['profile-content-items', profileId] })
            }
            showToast('Lấy highlight xong!', 'success')
            return
          }
          if (task.status === 'failed' || task.status === 'error') {
            showToast('Lấy highlight thất bại', 'error')
            return
          }
        }
        showToast('Timeout khi chờ highlight', 'error')
      })()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi khi lấy highlight', 'error')
    } finally {
      setHighlightLoading(false)
    }
  }

  async function handleRepostSubmit() {
    if (!repostVideo) return
    if (!repostScheduledAt) { setRepostError('Vui lòng chọn thời gian đăng'); return }
    setRepostError('')
    setRepostLoading(true)
    try {
      if (repostPlatform === 'tiktok') {
        await tiktokApi.scheduleTiktokVideo({ profile_id: profileId, link_download: repostVideo.link_download, scheduled_at: new Date(repostScheduledAt).toISOString() })
        showToast('Đã lên lịch đăng TikTok', 'success')
        setRepostVideo(null)
      } else if (repostPlatform === 'facebook') {
        if (!repostFbPageId) { setRepostError('Vui lòng chọn trang Facebook'); return }
        if (!repostContent.trim()) { setRepostError('Vui lòng nhập nội dung'); return }
        await facebookScheduledPostsApi.create({ page: repostFbPageId, content: repostContent.trim(), scheduled_at: new Date(repostScheduledAt).toISOString() })
        showToast('Đã lên lịch đăng Facebook', 'success')
        setRepostVideo(null)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Lỗi khi đăng lại'
      setRepostError(msg)
      showToast(msg, 'error')
    } finally {
      setRepostLoading(false)
    }
  }

  async function handleBulkSchedule() {
    if (!bulkTime) { setBulkError('Vui lòng chọn thời gian đăng'); return }
    setBulkError('')
    setBulkLoading(true)
    const links = [...selectedLinks]
    const baseMs = new Date(bulkTime).getTime()
    try {
      if (bulkPlatform === 'tiktok') {
        await Promise.all(links.map((link, i) =>
          tiktokApi.scheduleTiktokVideo({ profile_id: profileId, link_download: link, scheduled_at: new Date(baseMs + i * bulkInterval * 60000).toISOString() })
        ))
      } else {
        if (!bulkFbPageId) { setBulkError('Vui lòng chọn trang Facebook'); setBulkLoading(false); return }
        await Promise.all(links.map((link, i) =>
          facebookScheduledPostsApi.create({ page: bulkFbPageId!, content: link, scheduled_at: new Date(baseMs + i * bulkInterval * 60000).toISOString() })
        ))
      }
      showToast(`Đã lên lịch ${links.length} video`, 'success')
      setSelectedLinks(new Set())
      setBulkModalOpen(false)
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Lỗi khi lên lịch')
    } finally {
      setBulkLoading(false)
    }
  }

  function openRepost(video: VideoItem) {
    setRepostVideo(video)
    setRepostPlatform('tiktok')
    setRepostScheduledAt('')
    setRepostContent(video.des || '')
    setRepostFbPageId(null)
    setRepostError('')
  }

  function toggleSelect(link: string) {
    setSelectedLinks((prev) => {
      const next = new Set(prev)
      if (next.has(link)) next.delete(link)
      else next.add(link)
      return next
    })
  }

  const allTodayLinks = todayVideos.map((v) => v.link_download)
  const allSelected = allTodayLinks.length > 0 && allTodayLinks.every((l) => selectedLinks.has(l))

  function toggleSelectAll() {
    if (allSelected) setSelectedLinks(new Set())
    else setSelectedLinks(new Set(allTodayLinks))
  }

  return (
    <div className="max-w-4xl space-y-10">
      {/* ── Content của bạn (Highlights) ── */}
      <section>
        <div className="mb-4">
          <h2 className="text-base font-semibold">Content của bạn</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Nhập link YouTube để trích xuất highlight tự động</p>
        </div>
        <div className="flex gap-2">
          <input
            type="url"
            placeholder="https://youtube.com/watch?v=..."
            value={highlightUrl}
            onChange={(e) => setHighlightUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleHighlightSubmit()}
            className="flex-1 h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <Button onClick={handleHighlightSubmit} disabled={highlightLoading || !highlightUrl.trim()} size="sm">
            {highlightLoading ? 'Đang xử lý...' : 'Lấy highlight'}
          </Button>
        </div>

        {highlightClips.length > 0 && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {highlightClips.map((clip) => (
              <VideoCard
                key={clip.id}
                filename={`#${clip.rank} — ${clip.filename}`}
                des={[clip.action_desc, clip.transcript ? `"${clip.transcript}"` : ''].filter(Boolean).join('\n')}
                timestamp={clip.timestamp}
                link_download={clip.download_url}
                checked={selectedLinks.has(clip.download_url)}
                onCheck={() => toggleSelect(clip.download_url)}
                onRepost={() => openRepost({ id: clip.id, link_download: clip.download_url, des: clip.action_desc, filename: clip.filename, timestamp: clip.timestamp })}
              />
            ))}
          </div>
        )}
        {highlightLoading && (
          <p className="mt-4 text-center text-xs text-muted-foreground animate-pulse">Đang lấy highlight…</p>
        )}
      </section>

      {/* ── Kho content theo hồ sơ ── */}
      <section>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Kho content của hồ sơ</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Video đã lưu riêng cho hồ sơ đang chọn</p>
          </div>
          {todayVideos.length > 0 && (
            <button
              onClick={toggleSelectAll}
              className="text-xs text-primary hover:underline shrink-0"
            >
              {allSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
            </button>
          )}
        </div>

        {todayLoading ? (
          <p className="py-8 text-center text-xs text-muted-foreground animate-pulse">Đang tải…</p>
        ) : todayVideos.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">Chưa có video nào trong kho của hồ sơ này</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {todayVideos.map((video) => (
              <VideoCard
                key={video.id}
                filename={video.filename}
                des={video.des}
                timestamp={video.timestamp}
                link_download={video.link_download}
                checked={selectedLinks.has(video.link_download)}
                onCheck={() => toggleSelect(video.link_download)}
                onRepost={() => openRepost({ id: video.id, link_download: video.link_download, des: video.des, filename: video.filename, timestamp: video.timestamp })}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Floating bulk action bar ── */}
      {selectedLinks.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-5 py-3 shadow-2xl ring-1 ring-black/5">
            <span className="text-sm font-medium">{selectedLinks.size} video đã chọn</span>
            <Button size="sm" onClick={() => { setBulkTime(''); setBulkError(''); setBulkModalOpen(true) }}>
              <Clock3 className="mr-1.5 size-3.5" />
              Lên lịch
            </Button>
            <button className="rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => setSelectedLinks(new Set())}>
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Bulk schedule modal ── */}
      {bulkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">Lên lịch {selectedLinks.size} video</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">Các video sẽ được đăng cách nhau {bulkInterval} phút</p>
              </div>
              <button className="rounded p-1 hover:bg-muted" onClick={() => setBulkModalOpen(false)}><X className="size-4" /></button>
            </div>

            <div className="mb-3 flex gap-2">
              {(['tiktok', 'facebook'] as const).map((p) => (
                <button key={p} onClick={() => setBulkPlatform(p)} className={`flex-1 rounded-xl border py-1.5 text-xs font-medium transition ${bulkPlatform === p ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'}`}>
                  {p === 'tiktok' ? 'TikTok' : 'Facebook'}
                </button>
              ))}
            </div>

            {bulkPlatform === 'facebook' && (
              <div className="mb-3 flex flex-col gap-1.5">
                <label className="text-xs font-medium">Trang Facebook</label>
                <select className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={bulkFbPageId ?? ''} onChange={(e: { target: HTMLSelectElement }) => setBulkFbPageId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Chọn trang...</option>
                  {facebookPages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}
                </select>
              </div>
            )}

            <div className="mb-3 flex flex-col gap-1.5">
              <label className="text-xs font-medium">Thời gian bắt đầu đăng</label>
              <input type="datetime-local" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={bulkTime} onChange={(e) => setBulkTime(e.target.value)} />
            </div>

            <div className="mb-4 flex flex-col gap-1.5">
              <label className="text-xs font-medium">Khoảng cách giữa các video (phút)</label>
              <input type="number" min={1} max={1440} className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={bulkInterval} onChange={(e) => setBulkInterval(Math.max(1, Number(e.target.value)))} />
            </div>

            {bulkError && <p className="mb-3 text-xs text-destructive">{bulkError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setBulkModalOpen(false)} disabled={bulkLoading}>Hủy</Button>
              <Button size="sm" onClick={handleBulkSchedule} disabled={bulkLoading}>
                {bulkLoading ? 'Đang xử lý...' : `Lên lịch ${selectedLinks.size} video`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Repost modal (improved) ── */}
      {repostVideo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card shadow-xl overflow-hidden">
            {/* Video preview */}
            <div className="relative bg-black">
              <video src={repostVideo.link_download} className="w-full max-h-52 object-contain" preload="metadata" controls />
            </div>

            <div className="p-5">
              <div className="mb-4 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold truncate">{repostVideo.filename || 'Video'}</h3>
                  {repostVideo.des && <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{repostVideo.des}</p>}
                  <p className="mt-1 text-[11px] text-muted-foreground">{fmtTime(repostVideo.timestamp)}</p>
                </div>
                <button className="shrink-0 rounded p-1 hover:bg-muted" onClick={() => setRepostVideo(null)}><X className="size-4" /></button>
              </div>

              {/* Platform tabs */}
              <div className="mb-4 grid grid-cols-4 gap-1.5">
                {(['tiktok', 'facebook', 'youtube', 'instagram'] as RepostPlatform[]).map((p) => (
                  <button key={p} onClick={() => setRepostPlatform(p)} className={`rounded-xl border py-1.5 text-xs font-medium transition ${repostPlatform === p ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'}`}>
                    {p === 'tiktok' ? 'TikTok' : p === 'facebook' ? 'Facebook' : p === 'youtube' ? 'YouTube' : 'Instagram'}
                  </button>
                ))}
              </div>

              {(repostPlatform === 'youtube' || repostPlatform === 'instagram') ? (
                <p className="py-5 text-center text-sm text-muted-foreground">Chưa hỗ trợ nền tảng này</p>
              ) : (
                <>
                  {repostPlatform === 'facebook' && (
                    <>
                      <div className="mb-3 flex flex-col gap-1.5">
                        <label className="text-xs font-medium">Trang Facebook</label>
                        <select className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={repostFbPageId ?? ''} onChange={(e: { target: HTMLSelectElement }) => setRepostFbPageId(e.target.value ? Number(e.target.value) : null)}>
                          <option value="">Chọn trang...</option>
                          {facebookPages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}
                        </select>
                      </div>
                      <div className="mb-3 flex flex-col gap-1.5">
                        <label className="text-xs font-medium">Nội dung bài đăng</label>
                        <textarea className="min-h-[72px] w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-y" value={repostContent} onChange={(e) => setRepostContent(e.target.value)} placeholder="Nhập nội dung bài đăng…" />
                      </div>
                    </>
                  )}

                  <div className="mb-4 flex flex-col gap-1.5">
                    <label className="text-xs font-medium">Thời gian đăng</label>
                    <input type="datetime-local" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={repostScheduledAt} onChange={(e) => setRepostScheduledAt(e.target.value)} />
                    {repostScheduledAt && (
                      <p className="text-[11px] text-muted-foreground">
                        Sẽ đăng lúc: <span className="font-medium text-foreground">{fmtTime(new Date(repostScheduledAt).toISOString())}</span>
                      </p>
                    )}
                  </div>

                  {repostError && <p className="mb-3 text-xs text-destructive">{repostError}</p>}
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setRepostVideo(null)} disabled={repostLoading}>Hủy</Button>
                    <Button size="sm" onClick={handleRepostSubmit} disabled={repostLoading || !repostScheduledAt}>
                      {repostLoading ? 'Đang xử lý...' : 'Lên lịch đăng'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
