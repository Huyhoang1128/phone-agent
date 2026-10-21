import type {
  Task,
  TaskCreate,
  Schedule,
  ScheduleCreate,
  ScheduleExecution,
  Device,
  DeviceCreate,
  DeviceNotification,
  PaginatedResponse,
  ConnectedDevicesResponse,
  Credential,
  CredentialCreate,
  MobileApp,
  Profile,
  ProfileCreate,
  ProfileMemory,
  ProfileRoutine,
  ProfileAppInstallation,
  ProfileContentItem,
  Proxy,
  ProxyCreate,
  Team,
  TeamDetail,
  TeamCreate,
  TeamMember,
  TeamPermission,
  AgentGroup,
  AgentGroupCreate,
  AgentGroupMember,
  AgentGroupMemberCreate,
  AgentGroupSharedMemory,
  AgentGroupSharedFile,
  AgentGroupSharedState,
  AgentGroupPlan,
  AgentPlanItem,
  Workflow,
  WorkflowCreate,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepCreate,
  SystemEventDef,
  WorkflowTrigger,
  WorkflowTriggerCreate,
  ContentItem,
  ContentItemCreate,
  FramePatch,
  GenerateScriptsResponse,
  GeneratedScript,
  GeneratedScriptFrame,
  ReviewerFocus,
  ScriptChatMessage,
  UpdateFramePayload,
  CrawlContentSnapshot,
  CrawlRun,
  CrawlSource,
  CrawlSourceCreate,
  TiktokChannelResearchResponse,
  TiktokChannelResearchVideo,
  FeatureSystemPrompt,
  RepostAiRewriteRequest,
  RepostAiRewriteResponse,
  // Phase 2.3 Chatbot TikTok Inbox
  TiktokConversationListResponse,
  TiktokConversationDetail,
  TiktokMessagesPage,
  TiktokPeerMute,
  TiktokPeerMuteCreate,
  Character,
  CharacterBlocks,
  OpenAIImageSize,
  OpenAIImageQuality,
  ImageProvider,
  CharacterScheduledPost,
} from './types'

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? ''
const isAuthFailureStatus = (status: number) => status === 401

export class ApiError extends Error {
  status: number
  code?: string
  detail?: string

  constructor(message: string, status: number, code?: string, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

function createApiError(status: number, statusText: string, raw: string): ApiError {
  let msg = raw || statusText
  let code: string | undefined
  let detail: string | undefined
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.response?.detail) {
      msg = parsed.response.detail
    } else if (parsed?.detail) {
      msg = parsed.detail
    } else if (parsed?.message) {
      msg = parsed.message
    }
    if (parsed?.code) {
      code = parsed.code
    }
    if (parsed?.detail) {
      detail = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail)
    }
  } catch {}

  if (status === 429 || code === 'quota_exceeded') {
    msg = msg || 'Hệ thống AI đã hết hạn mức sử dụng, vui lòng thử lại sau.'
    if (!code) code = 'quota_exceeded'
  } else if (code === 'rate_limited') {
    msg = msg || 'Hệ thống đang quá tải, vui lòng thử lại sau.'
  } else if (code === 'auth_error') {
    msg = msg || 'Lỗi xác thực hệ thống AI, vui lòng kiểm tra cấu hình key.'
  } else if (code === 'engine_error') {
    msg = msg || 'Lỗi hệ thống AI, vui lòng thử lại sau.'
  }

  return new ApiError(msg, status, code, detail)
}

function getAccessToken(): string | null {
  return localStorage.getItem('access_token')
}

async function parseResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string>),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}/api${path}`, { headers, ...init })

  if (res.status === 401) {
    // Try refresh
    const refreshed = await tryRefreshToken()
    if (refreshed) {
      const newToken = getAccessToken()
      if (newToken) headers['Authorization'] = `Bearer ${newToken}`
      const retryRes = await fetch(`${BASE}/api${path}`, { headers, ...init })
      if (!retryRes.ok) {
        const raw = await retryRes.text().catch(() => retryRes.statusText)
        throw createApiError(retryRes.status, retryRes.statusText, raw)
      }
      return parseResponse<T>(retryRes)
    }
    throw new ApiError('Unauthorized', 401)
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => res.statusText)
    throw createApiError(res.status, res.statusText, raw)
  }
  return parseResponse<T>(res)
}

async function tryRefreshToken(): Promise<boolean> {
  const refresh = localStorage.getItem('refresh_token')
  if (!refresh) return false
  try {
    const res = await fetch(`${BASE}/api/auth/refresh/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh }),
    })
    if (!res.ok) {
      if (isAuthFailureStatus(res.status)) {
        localStorage.removeItem('access_token')
        localStorage.removeItem('refresh_token')
      }
      return false
    }
    const data = await res.json()
    localStorage.setItem('access_token', data.access)
    if (data.refresh) localStorage.setItem('refresh_token', data.refresh)
    return true
  } catch {
    return false
  }
}

async function reqForm<T>(path: string, formData: FormData, signal?: AbortSignal): Promise<T> {
  const token = getAccessToken()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  let res = await fetch(`${BASE}/api${path}`, { method: 'POST', headers, body: formData, signal })
  // Mirror req(): on an expired access token, refresh once and retry — otherwise
  // a long-open form (caption, image picker…) fails with "token not valid".
  if (res.status === 401) {
    const refreshed = await tryRefreshToken()
    if (refreshed) {
      const newToken = getAccessToken()
      if (newToken) headers['Authorization'] = `Bearer ${newToken}`
      res = await fetch(`${BASE}/api${path}`, { method: 'POST', headers, body: formData, signal })
    }
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => res.statusText)
    throw createApiError(res.status, res.statusText, raw)
  }
  return res.json()
}

function withQuery(path: string, params?: Record<string, string | number | boolean | null | undefined>) {
  if (!params) return path
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    query.set(key, String(value))
  })
  const qs = query.toString()
  return qs ? `${path}?${qs}` : path
}

export const tasksApi = {
  list: (params?: {
    page?: number
    page_size?: number
    status?: string
    search?: string
    ordering?: string
  }) => req<PaginatedResponse<Task>>(withQuery('/tasks/', params)),
  listAll: async () => {
    const collected: Task[] = []
    let page = 1
    let totalPages = 1

    while (page <= totalPages) {
      const response = await req<PaginatedResponse<Task>>(
        withQuery('/tasks/', { page, page_size: 100, ordering: '-created_at' }),
      )
      collected.push(...response.results)
      totalPages = Math.max(1, Math.ceil(response.count / 100))
      page += 1
    }

    return collected
  },
  get: (id: number) => req<Task>(`/tasks/${id}/`),
  create: (data: TaskCreate) =>
    req<Task>('/tasks/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: TaskCreate) =>
    req<Task>(`/tasks/${id}/`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/tasks/${id}/`, { method: 'DELETE' }),
  run: (id: number, devicesId?: number[], profileId?: number | null) =>
    req<Task>(`/tasks/${id}/run/`, {
      method: 'POST',
      body: JSON.stringify({ devices_id: devicesId ?? [], profile_id: profileId ?? null }),
    }),
  stop: (id: number) => req<Task>(`/tasks/${id}/stop/`, { method: 'POST' }),
  approve: (id: number, data?: { caption?: string; hashtags?: string[] }) =>
    req<Task>(`/tasks/${id}/approve/`, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    }),
  reject: (id: number) => req<Task>(`/tasks/${id}/reject/`, { method: 'POST' }),
  updateScheduleTime: (id: number, scheduledAt: string) =>
    req<Task>(`/tasks/${id}/update_schedule_time/`, {
      method: 'POST',
      body: JSON.stringify({ scheduled_at: scheduledAt }),
    }),
  updateTaskProfile: (id: number, profileId: number | null) =>
    req<Task>(`/tasks/${id}/update_profile/`, {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId }),
    }),
  share: (id: number, teamId: number, permission: TeamPermission) =>
    req<Task>(`/tasks/${id}/share/`, {
      method: 'POST',
      body: JSON.stringify({ team: teamId, team_permission: permission }),
    }),
  unshare: (id: number) => req<Task>(`/tasks/${id}/unshare/`, { method: 'POST' }),
}

export const schedulesApi = {
  list: () => req<Schedule[]>('/schedules/'),
  listByProfile: (profileId: number) => req<Schedule[]>(`/schedules/?profile_id=${profileId}`),
  get: (id: number) => req<Schedule>(`/schedules/${id}/`),
  create: (data: ScheduleCreate) =>
    req<Schedule>('/schedules/', { method: 'POST', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/schedules/${id}/`, { method: 'DELETE' }),
  pause: (id: number) => req<Schedule>(`/schedules/${id}/pause/`, { method: 'POST' }),
  resume: (id: number) => req<Schedule>(`/schedules/${id}/resume/`, { method: 'POST' }),
  executions: (id: number) =>
    req<ScheduleExecution[]>(`/schedules/${id}/executions/`),
}

export const devicesApi = {
  /**
   * TCS-v2 Sprint 2 (#2): mặc định CHỈ trả device active. Truyền
   * `includeDeleted=true` để xem cả device đã soft-delete (cho toggle "Hiện đã xóa").
   */
  list: (params?: { includeDeleted?: boolean }) =>
    req<Device[]>(`/devices/${params?.includeDeleted ? '?include_deleted=true' : ''}`),
  /** Detail: pass includeDeleted=true để xem device đã soft-delete. */
  get: (id: number, params?: { includeDeleted?: boolean }) =>
    req<Device>(`/devices/${id}/${params?.includeDeleted ? '?include_deleted=true' : ''}`),
  create: (data: DeviceCreate) =>
    req<Device>('/devices/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: DeviceCreate) =>
    req<Device>(`/devices/${id}/`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/devices/${id}/`, { method: 'DELETE' }),
  /** TCS-v2 Sprint 2 (#2): khôi phục device đã soft-delete. */
  restore: (id: number) => req<Device>(`/devices/${id}/restore/`, { method: 'POST' }),
  share: (id: number, teamId: number, permission: TeamPermission) =>
    req<Device>(`/devices/${id}/share/`, {
      method: 'POST',
      body: JSON.stringify({ team: teamId, team_permission: permission }),
    }),
  unshare: (id: number) => req<Device>(`/devices/${id}/unshare/`, { method: 'POST' }),
  claim: (id: number) => req<Device>(`/devices/${id}/claim/`, { method: 'POST' }),
  release: (id: number) => req<Device>(`/devices/${id}/release/`, { method: 'POST' }),
  reclaim: (id: number) => req<Device>(`/devices/${id}/reclaim/`, { method: 'POST' }),
  connected: () => req<ConnectedDevicesResponse>('/devices/connected/'),
  notifications: (id: number, page = 1, pageSize = 10) =>
    req<PaginatedResponse<DeviceNotification>>(
      `/devices/${id}/notifications/?page=${page}&page_size=${pageSize}`,
    ),
  sendCommand: (id: number, action: string) =>
    req<{ success: boolean; action: string; devices_serical: string }>(
      `/devices/${id}/send_command/`,
      { method: 'POST', body: JSON.stringify({ action }) },
    ),
}

export const credentialsApi = {
  list: () => req<Credential[]>('/credentials/'),
  get: (id: number) => req<Credential>(`/credentials/${id}/`),
  create: (data: CredentialCreate) =>
    req<Credential>('/credentials/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: CredentialCreate) =>
    req<Credential>(`/credentials/${id}/`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/credentials/${id}/`, { method: 'DELETE' }),
  share: (id: number, teamId: number, permission: TeamPermission) =>
    req<Credential>(`/credentials/${id}/share/`, {
      method: 'POST',
      body: JSON.stringify({ team: teamId, team_permission: permission }),
    }),
  unshare: (id: number) => req<Credential>(`/credentials/${id}/unshare/`, { method: 'POST' }),
}

export const mobileAppsApi = {
  list: () => req<MobileApp[]>('/apps/'),
  get: (id: number) => req<MobileApp>(`/apps/${id}/`),
  create: async (data: {
    name: string
    package_name?: string
    platform: string
    version?: string
    description?: string
    apk_file?: File | null
  }): Promise<MobileApp> => {
    const formData = new FormData()
    formData.append('name', data.name)
    if (data.package_name) formData.append('package_name', data.package_name)
    formData.append('platform', data.platform)
    if (data.version) formData.append('version', data.version)
    if (data.description) formData.append('description', data.description)
    if (data.apk_file) formData.append('apk_file', data.apk_file)
    return reqForm('/apps/', formData)
  },
  delete: (id: number) => req<void>(`/apps/${id}/`, { method: 'DELETE' }),
  share: (id: number, teamId: number, permission: TeamPermission) =>
    req<MobileApp>(`/apps/${id}/share/`, {
      method: 'POST',
      body: JSON.stringify({ team: teamId, team_permission: permission }),
    }),
  unshare: (id: number) => req<MobileApp>(`/apps/${id}/unshare/`, { method: 'POST' }),
}

export const profilesApi = {
  list: () => req<Profile[]>('/profiles/'),
  get: (id: number) => req<Profile>(`/profiles/${id}/`),
  create: (data: ProfileCreate) =>
    req<Profile>('/profiles/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<ProfileCreate>) =>
    req<Profile>(`/profiles/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/profiles/${id}/`, { method: 'DELETE' }),
  uploadFile: async (profileId: number, file: File, name?: string): Promise<void> => {
    const formData = new FormData()
    formData.append('file', file)
    if (name) formData.append('name', name)
    const token = getAccessToken()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`${BASE}/api/profiles/${profileId}/upload_file/`, {
      method: 'POST',
      headers,
      body: formData,
    })
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText)
      throw new Error(msg || res.statusText)
    }
  },
  deleteFile: (profileId: number, fileId: number) =>
    req<void>(`/profiles/${profileId}/files/${fileId}/`, { method: 'DELETE' }),
  listMemory: (profileId: number) =>
    req<ProfileMemory[]>(`/profiles/${profileId}/memory/`),
  setMemory: (profileId: number, key: string, value: string, tags: string[] = []) =>
    req<ProfileMemory>(`/profiles/${profileId}/memory/`, {
      method: 'POST',
      body: JSON.stringify({ key, value, tags }),
    }),
  deleteMemory: (profileId: number, memoryId: number) =>
    req<void>(`/profiles/${profileId}/memory/${memoryId}/`, { method: 'DELETE' }),
  listContentItems: (profileId: number) =>
    req<ProfileContentItem[]>(`/profiles/${profileId}/content-items/`),
  createContentItem: (
    profileId: number,
    data: Pick<ProfileContentItem, 'title' | 'source_url' | 'video_url' | 'description' | 'tags' | 'metadata'>,
  ) =>
    req<ProfileContentItem>(`/profiles/${profileId}/content-items/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteContentItem: (profileId: number, contentItemId: number) =>
    req<void>(`/profiles/${profileId}/content-items/${contentItemId}/`, { method: 'DELETE' }),
  listRoutines: (profileId: number) =>
    req<ProfileRoutine[]>(`/profiles/${profileId}/routines/`),
  createRoutine: (profileId: number, data: { schedule_time: string; action: string; cron_expression: string }) =>
    req<ProfileRoutine>(`/profiles/${profileId}/routines/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteRoutine: (profileId: number, routineId: number) =>
    req<void>(`/profiles/${profileId}/routines/${routineId}/`, { method: 'DELETE' }),
  // App install/uninstall — each call mutates one app and returns the full
  // updated installation list for the profile.
  listInstallations: (profileId: number) =>
    req<ProfileAppInstallation[]>(`/profiles/${profileId}/installations/`),
  installApp: (profileId: number, appId: number) =>
    req<ProfileAppInstallation[]>(`/profiles/${profileId}/install-app/`, {
      method: 'POST',
      body: JSON.stringify({ app_id: appId }),
    }),
  uninstallApp: (profileId: number, appId: number) =>
    req<ProfileAppInstallation[]>(`/profiles/${profileId}/uninstall-app/`, {
      method: 'POST',
      body: JSON.stringify({ app_id: appId }),
    }),
  generateTopics: (profileId: number, data: { personality?: string; existing_topics?: string[]; count?: number }) =>
    req<{ topics: string[] }>(`/profiles/${profileId}/generate-topics/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  logTopicAction: (
    profileId: number,
    data: { action: string; topic?: string; topics?: string[]; metadata?: Record<string, unknown> },
  ) =>
    req<void>(`/profiles/${profileId}/topic-actions/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  share: (id: number, teamId: number, permission: TeamPermission) =>
    req<Profile>(`/profiles/${id}/share/`, {
      method: 'POST',
      body: JSON.stringify({ team: teamId, team_permission: permission }),
    }),
  unshare: (id: number) => req<Profile>(`/profiles/${id}/unshare/`, { method: 'POST' }),
}

export const teamsApi = {
  list: () => req<Team[]>('/teams/'),
  get: (id: number) => req<TeamDetail>(`/teams/${id}/`),
  create: (data: TeamCreate) =>
    req<Team>('/teams/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<TeamCreate>) =>
    req<Team>(`/teams/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/teams/${id}/`, { method: 'DELETE' }),
  members: (id: number) => req<TeamMember[]>(`/teams/${id}/members/`),
  addMember: (id: number, email: string, role?: string) =>
    req<TeamMember>(`/teams/${id}/members/`, {
      method: 'POST',
      body: JSON.stringify({ email, role: role ?? 'member' }),
    }),
  updateMemberRole: (teamId: number, userId: number, role: string) =>
    req<TeamMember>(`/teams/${teamId}/members/${userId}/`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  removeMember: (teamId: number, userId: number) =>
    req<void>(`/teams/${teamId}/members/${userId}/`, { method: 'DELETE' }),
}

export const proxiesApi = {
  list: () => req<Proxy[]>('/proxies/'),
  get: (id: number) => req<Proxy>(`/proxies/${id}/`),
  create: (data: ProxyCreate) =>
    req<Proxy>('/proxies/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: ProxyCreate) =>
    req<Proxy>(`/proxies/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/proxies/${id}/`, { method: 'DELETE' }),
}

export const agentGroupsApi = {
  list: () => req<AgentGroup[]>('/agent-groups/'),
  get: (id: number) => req<AgentGroup>(`/agent-groups/${id}/`),
  create: (data: AgentGroupCreate) =>
    req<AgentGroup>('/agent-groups/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<AgentGroupCreate>) =>
    req<AgentGroup>(`/agent-groups/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/agent-groups/${id}/`, { method: 'DELETE' }),
  share: (id: number, teamId: number, permission: TeamPermission) =>
    req<AgentGroup>(`/agent-groups/${id}/share/`, {
      method: 'POST',
      body: JSON.stringify({ team: teamId, team_permission: permission }),
    }),
  unshare: (id: number) => req<AgentGroup>(`/agent-groups/${id}/unshare/`, { method: 'POST' }),
  addMember: (groupId: number, data: AgentGroupMemberCreate) =>
    req<AgentGroupMember>(`/agent-groups/${groupId}/members/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  removeMember: (groupId: number, memberId: number) =>
    req<void>(`/agent-groups/${groupId}/members/${memberId}/`, { method: 'DELETE' }),
  updateMemberRole: (groupId: number, memberId: number, role: AgentGroupMember['role']) =>
    req<AgentGroupMember>(`/agent-groups/${groupId}/members/${memberId}/`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  // Shared resources
  listSharedMemory: (groupId: number) =>
    req<AgentGroupSharedMemory[]>(`/agent-groups/${groupId}/shared-memory/`),
  setSharedMemory: (groupId: number, key: string, value: string) =>
    req<AgentGroupSharedMemory>(`/agent-groups/${groupId}/shared-memory/`, {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    }),
  deleteSharedMemory: (groupId: number, memoryId: number) =>
    req<void>(`/agent-groups/${groupId}/shared-memory/${memoryId}/`, { method: 'DELETE' }),
  listSharedFiles: (groupId: number) =>
    req<AgentGroupSharedFile[]>(`/agent-groups/${groupId}/shared-files/`),
  uploadSharedFile: async (groupId: number, name: string, file: File): Promise<AgentGroupSharedFile> => {
    const token = localStorage.getItem('access_token')
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const formData = new FormData()
    formData.append('name', name)
    formData.append('file', file)
    const res = await fetch(`${(import.meta.env.VITE_API_URL as string | undefined) ?? ''}/api/agent-groups/${groupId}/shared-files/`, {
      method: 'POST',
      headers,
      body: formData,
    })
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText)
      throw new Error(msg || res.statusText)
    }
    return res.json()
  },
  deleteSharedFile: (groupId: number, fileId: number) =>
    req<void>(`/agent-groups/${groupId}/shared-files/${fileId}/`, { method: 'DELETE' }),
  listSharedState: (groupId: number) =>
    req<AgentGroupSharedState[]>(`/agent-groups/${groupId}/shared-state/`),
  setSharedState: (groupId: number, key: string, value: unknown) =>
    req<AgentGroupSharedState>(`/agent-groups/${groupId}/shared-state/`, {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    }),
  deleteSharedState: (groupId: number, stateId: number) =>
    req<void>(`/agent-groups/${groupId}/shared-state/${stateId}/`, { method: 'DELETE' }),
  planTasks: (groupId: number, data: { goal: string; llm_model?: string }) =>
    req<{ plan: AgentPlanItem[]; plan_id: number }>(`/agent-groups/${groupId}/plan/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  listPlans: (groupId: number) =>
    req<AgentGroupPlan[]>(`/agent-groups/${groupId}/plans/`),
  savePlan: (groupId: number, data: { goal: string; plan: AgentPlanItem[] }) =>
    req<AgentGroupPlan>(`/agent-groups/${groupId}/plans/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  approvePlan: (groupId: number, planId: number) =>
    req<AgentGroupPlan>(`/agent-groups/${groupId}/plans/${planId}/approve/`, { method: 'POST' }),
  rejectPlan: (groupId: number, planId: number) =>
    req<AgentGroupPlan>(`/agent-groups/${groupId}/plans/${planId}/reject/`, { method: 'POST' }),
}

export const authApi = {
  me: () => req<import('./types').AuthUser>('/auth/me/'),
  updateMe: (data: {
    first_name?: string
    last_name?: string
    email?: string
    display_name?: string
    avatar_url?: string
  }) => req<import('./types').AuthUser>('/auth/me/', { method: 'PATCH', body: JSON.stringify(data) }),
}

export const apiKeysApi = {
  list: () => req<import('./types').ApiKey[]>('/api-keys/'),
  create: (data: import('./types').ApiKeyCreate) =>
    req<import('./types').ApiKey>('/api-keys/', { method: 'POST', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/api-keys/${id}/`, { method: 'DELETE' }),
}

// hacklike17 tokens (FB reaction-boost 🚀). Token is paste-once; reads return
// only key_masked. `like` proxies a boost order through the backend.
export const fbHackKeysApi = {
  list: () => req<import('./types').FbHackKey[]>('/facebook/fb-hack-keys/'),
  create: (data: import('./types').FbHackKeyCreate) =>
    req<import('./types').FbHackKey>('/facebook/fb-hack-keys/', { method: 'POST', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/facebook/fb-hack-keys/${id}/`, { method: 'DELETE' }),
  like: (params: import('./types').FbHackLikeParams) =>
    req<import('./types').FbHackLikeResponse>('/facebook/fb-hack-keys/like/', {
      method: 'POST', body: JSON.stringify(params),
    }),
}

export const webhooksApi = {
  list: () => req<import('./types').Webhook[]>('/webhooks/'),
  get: (id: number) => req<import('./types').Webhook>(`/webhooks/${id}/`),
  create: (data: import('./types').WebhookCreate) =>
    req<import('./types').Webhook>('/webhooks/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').WebhookCreate>) =>
    req<import('./types').Webhook>(`/webhooks/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/webhooks/${id}/`, { method: 'DELETE' }),
}

export interface ContentListParams {
  date_from?: string  // 'YYYY-MM-DD' inclusive
  date_to?: string    // 'YYYY-MM-DD' inclusive
  search?: string     // substring match on title/kb_name/od_number/text_content
  page?: number
  page_size?: number
}

// ── Cổng chặn + thử lại cho việc sinh ảnh ───────────────────────────────────
// Backend cấp phát slot sinh ảnh bằng semaphore CẤP PROCESS: `acquire(blocking=False)`,
// hết slot là trả 503 NGAY chứ không xếp hàng (cố ý — chờ trong đó sẽ giữ thread web và
// treo cả site, đúng sự cố mà cái cap đó sinh ra để chặn). Prod chạy 4 worker × 4 slot,
// nhưng vì semaphore nằm trong từng process nên đó KHÔNG phải "16 quầy chung một hàng":
// nó là 4 cửa hàng riêng, mỗi cửa 4 quầy, và request bị ném ngẫu nhiên vào một cửa. Bắn
// 8 request cùng lúc thì chỉ cần 5 cái rơi trúng một worker là cái thứ 5 ăn 503, dù 3
// worker kia đang rảnh.
//
// Trước đây frontend bắn CẢ LOẠT cùng lúc (Promise.allSettled 8 cảnh) và KHÔNG hề thử
// lại — nên nửa số ảnh chết ngay. Comment ở views.py còn ghi "the frontend already treats
// a failed image as retry", điều đó chưa bao giờ đúng.
//
// Vá ở đúng một chỗ này vì MỌI luồng (wizard cũ, Tạo ảnh nhanh, Media, Ghép mặt) đều gọi
// generateImage — không phải đi sửa từng nơi gọi.
const IMAGE_GEN_MAX_INFLIGHT = 3   // dưới mức 4 của server, chừa slot cho người dùng khác
const IMAGE_GEN_MAX_ATTEMPTS = 5   // 1 lần đầu + 4 lần thử lại
const IMAGE_GEN_BACKOFF_MS = [1500, 3000, 6000, 10000]

let imageGenInflight = 0
const imageGenQueue: (() => void)[] = []

/** Giữ một suất trong hạn mức; trả về hàm nhả suất.
 *
 *  Suất được CHUYỂN THẲNG cho người đang đợi chứ không "giảm bộ đếm rồi đánh thức".
 *  Bản đầu của hàm này làm kiểu sau và nó hở: `resolve()` chỉ xếp lịch microtask, nên
 *  giữa lúc bộ đếm đã giảm và lúc người đợi thực sự chạy tiếp, một lời gọi MỚI xen vào
 *  sẽ thấy bộ đếm còn chỗ và lấy mất suất — rồi người đợi tỉnh dậy cũng tăng bộ đếm,
 *  thành 4 request bay cùng lúc trong khi trần là 3. */
async function acquireImageSlot(): Promise<() => void> {
  if (imageGenInflight >= IMAGE_GEN_MAX_INFLIGHT) {
    // Đợi tới lượt. Khi được đánh thức thì suất đã là của mình, bộ đếm giữ nguyên.
    await new Promise<void>((resolve) => imageGenQueue.push(resolve))
  } else {
    imageGenInflight += 1
  }
  let released = false
  return () => {
    if (released) return          // chặn nhả hai lần làm hỏng bộ đếm
    released = true
    const next = imageGenQueue.shift()
    if (next) next()              // chuyển suất, KHÔNG giảm bộ đếm
    else imageGenInflight -= 1
  }
}

/** Chỉ thử lại đúng lỗi "server đang bận" (503). Lỗi khác — kiểm duyệt, prompt quá dài,
 *  hết quota — thử lại chỉ tốn thời gian và tiền mà kết quả vẫn thế. */
function isBusyError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 503
}

async function withImageGenGate<T>(run: () => Promise<T>): Promise<T> {
  const release = await acquireImageSlot()
  try {
    let lastErr: unknown
    for (let attempt = 0; attempt < IMAGE_GEN_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await run()
      } catch (e) {
        if (!isBusyError(e) || attempt === IMAGE_GEN_MAX_ATTEMPTS - 1) throw e
        lastErr = e
        // Jitter để nhiều tab/nhiều máy không cùng thức dậy một lúc rồi lại đâm nhau.
        const base = IMAGE_GEN_BACKOFF_MS[Math.min(attempt, IMAGE_GEN_BACKOFF_MS.length - 1)]
        await new Promise((r) => setTimeout(r, base + Math.random() * base * 0.5))
      }
    }
    throw lastErr
  } finally {
    release()
  }
}

export const contentsApi = {
  list: (params?: ContentListParams) =>
    req<PaginatedResponse<ContentItem>>(
      // Cast: ContentListParams' specific shape is structurally compatible
      // with the Record signature withQuery expects.
      withQuery('/contents/', params as Record<string, string | number | undefined>),
    ),
  get: (id: number) => req<ContentItem>(`/contents/${id}/`),
  create: (data: ContentItemCreate) =>
    req<ContentItem>('/contents/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<ContentItemCreate>) =>
    req<ContentItem>(`/contents/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/contents/${id}/`, { method: 'DELETE' }),
  share: (id: number, teamId: number, permission: TeamPermission) =>
    req<ContentItem>(`/contents/${id}/share/`, {
      method: 'POST',
      body: JSON.stringify({ team: teamId, team_permission: permission }),
    }),
  unshare: (id: number) => req<ContentItem>(`/contents/${id}/unshare/`, { method: 'POST' }),

  // Step 1 of the AI flow — proxy to n8n. Returns 5 fresh scripts but does
  // not persist anything yet; the FE shows them for review.
  generateScripts: (
    file: File | null,
    orderDescription: string,
    mode: 'real_footage' | 'ai_video' = 'real_footage',
  ) => {
    const fd = new FormData()
    // file is OPTIONAL — only attach when the user picked a template. Without it
    // the n8n flow self-authors 5 scripts from order_description (+ RAG).
    if (file) fd.append('file', file)
    fd.append('order_description', orderDescription)
    fd.append('mode', mode)
    return reqForm<GenerateScriptsResponse>('/contents/generate-scripts/', fd)
  },

  // "Tạo nhân vật" — step-by-step wizard, BE drives OpenAI + Deep-Live-Cam.
  // 0) topicToPrompt(nation) → build a character identity prompt for a woman of
  //    the given COUNTRY (e.g. "Việt Nam") instead of a hardcoded nationality.
  topicToPrompt: (nation: string) =>
    req<{ prompt: string; prompt_en?: string }>('/contents/topic-to-prompt/', {
      method: 'POST',
      body: JSON.stringify({ nation }),
    }),
  // 0b) sceneDetails(place) → GPT invents the small VARIABLE details of a shot: the
  //     object that drifts in front of the lens, and the background clutter. These used
  //     to be hardcoded ("the back of a chair…"), which made every single image come out
  //     with the same chair — an image model does not pick from a list at random. GPT
  //     also knows WHERE the photo is, so a beach gets a beach foreground, not a chair.
  sceneDetails: (location: string, region: string, pose: string) =>
    req<{ foreground: string; clutter: string; foreground_vi: string; clutter_vi: string }>(
      '/contents/scene-details/',
      { method: 'POST', body: JSON.stringify({ location, region, pose }) },
    ),
  // 0b) pickFace(menu, level) → GPT chọn một mã cho mỗi ô của thực đơn gương mặt.
  //     KHÔNG phải đường mặc định: bốc ngẫu nhiên tại chỗ đa dạng hơn hẳn (đo 19/08,
  //     xem ghi chú ở FACE_MENU_KEM trong quickPrompt.ts). Đây là nút "Mặt bằng GPT"
  //     cho ai muốn một tổ hợp hợp nhau hơn. Thực đơn gửi kèm để backend không phải
  //     giữ bản sao — nguồn sự thật nằm ở quickPrompt.ts.
  pickFace: (menu: Record<string, string[]>, level: string) =>
    req<{ codes: Record<string, string> }>('/contents/pick-face/', {
      method: 'POST',
      body: JSON.stringify({ menu, level }),
    }),
  // 0a) captionFromImage(imageUrl, platform?) → AI looks at the image and writes
  //     a Vietnamese caption + hashtags for the "Đăng bài" modal.
  captionFromImage: (imageUrl: string, platform?: string) =>
    req<{ caption: string; hashtags: string[] }>('/contents/caption-from-image/', {
      method: 'POST',
      body: JSON.stringify({ image_url: imageUrl, ...(platform ? { platform } : {}) }),
    }),
  // 0b) sceneToPrompt(theme, nation?, facePrompt?) → a fresh, varied scene
  //     description for a theme (used by "Tạo lại" once the local preset variants
  //     are exhausted). nation localises the everyday atmosphere
  //     (places/streets/fashion); when nation is absent, facePrompt lets the
  //     backend infer the country from the character's identity so scenes still
  //     match nationality (e.g. adding scenes to a saved character).
  // prompt = Vietnamese scene (shown/edited by the user); prompt_en = the same
  // scene pre-translated to English so image generation can send English directly
  // and skip its own per-image translate call.
  sceneToPrompt: (theme: string, nation?: string, facePrompt?: string) =>
    req<{ prompt: string; prompt_en?: string }>('/contents/scene-to-prompt/', {
      method: 'POST',
      body: JSON.stringify({
        theme,
        ...(nation ? { nation } : {}),
        ...(facePrompt ? { face_prompt: facePrompt } : {}),
      }),
    }),
  // downloadUrl(url, name) → a browser-navigable URL that forces a file download
  // (Content-Disposition: attachment) for character media, regardless of host.
  // Cloudfly URLs are re-presigned server-side; SeaweedFS URLs get a disposition
  // query param. Fixes cross-origin images opening in a new tab.
  downloadUrl: (url: string, name: string) =>
    req<{ url: string }>(`/contents/download-url/?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`),
  // Per-account image-generation usage for a day (default today): how many
  // OpenAI image calls were made and how many produced an image.
  imageUsage: (date?: string) =>
    req<{
      date: string
      calls: number
      images: number
      month: string
      month_calls: number
      month_images: number
    }>(`/contents/image-usage/${date ? `?date=${date}` : ''}`),
  // 1) generateImage(prompt, referenceImage?, noFallback?, explainErrors?) → one image to review/regenerate.
  //    referenceImage (a character face / source image, data URI) makes the result
  //    resemble it via images.edit. noFallback=true (edit flow) surfaces an error
  //    when images.edit fails instead of silently text-generating an unrelated image.
  //    explainErrors=true (user-typed prompt) → on failure the BE asks GPT to read
  //    the raw OpenAI error + prompt and return a clear Vietnamese explanation.
  // Returns { image } (a data URI for display/editing) and { url } — the image
  // pre-uploaded to storage, so callers can save it by URL instead of re-sending
  // the whole base64 (url is '' if the pre-upload failed → fall back to base64).
  // referenceImage may be a single data URI (face-lock) OR an array — a realref
  // scene sends [real photo, character image] so the BE composites them (keep the
  // real photo's pose/scene, put the character's face on it).
  // `size` defaults to the square 1024x1024 server-side. Pass '1024x1536' for the
  // portrait frame a brief asking for 9:16 should use.
  // `quality` overrides the server default (kept at 'low' for cost). Only the brief
  // test-bench passes it, so every other caller stays on 'low' untouched.
  generateImage: (
    prompt: string,
    referenceImage?: string | string[],
    noFallback?: boolean,
    explainErrors?: boolean,
    size?: OpenAIImageSize,
    quality?: OpenAIImageQuality,
    // Which model renders. Omitted/'openai' → the unchanged gpt-image path;
    // 'seedream45'/'grok' route to fal.ai (the "Tạo ảnh nhanh" flow).
    provider?: ImageProvider,
    // The fal model's own scale knob (Seedream '1K'/'2K'/'2.3K', Grok '1k'/'2k').
    // Ignored by the OpenAI path.
    resolution?: string,
  ) =>
    // Qua cổng chặn: tối đa IMAGE_GEN_MAX_INFLIGHT request bay cùng lúc, và tự thử lại
    // khi server trả 503 "đang bận sinh ảnh". Người gọi không phải biết gì về việc này —
    // vẫn là một Promise trả về ảnh, hoặc ném lỗi như cũ.
    withImageGenGate(() =>
      req<{ image: string; url?: string }>('/contents/generate-image/', {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          ...(Array.isArray(referenceImage)
            ? (referenceImage.length ? { reference_images: referenceImage } : {})
            : (referenceImage ? { reference_image: referenceImage } : {})),
          ...(noFallback ? { no_fallback: true } : {}),
          ...(explainErrors ? { explain_errors: true } : {}),
          ...(size ? { size } : {}),
          ...(quality ? { quality } : {}),
          ...(provider && provider !== 'openai' ? { provider } : {}),
          ...(resolution ? { resolution } : {}),
        }),
      }),
    ),
  // storeImage(image, kind) → cất ảnh vừa sinh vào kho, trả về { url }.
  //
  // Gọi NGAY khi ảnh hiện ra (chạy nền, không chặn giao diện) để lúc lưu chỉ phải
  // gửi URL thay vì 2,25 MB base64 mỗi ảnh — xem lib/imageStore.ts để hiểu vì sao
  // đường lưu cũ chậm. Lỗi thì cứ để nó lỗi: người gọi bỏ qua và lưu base64 như cũ.
  storeImage: (image: string, kind: 'media' | 'scenes' | 'source' = 'scenes') =>
    req<{ url: string }>('/contents/store-image/', {
      method: 'POST',
      body: JSON.stringify({ image, kind }),
    }),
  // applyFilter(image, filter, maxEdge?) → colour-grade an image with an
  // Instagram-style pilgram filter (e.g. "clarendon"). Local pixel work on the BE,
  // no OpenAI call. Returns a JPEG data URI. `image` may be a data URI OR an
  // http(s) URL (kho ảnh) — BE tự tải về, nên gửi URL thì payload chỉ vài trăm byte.
  // maxEdge co ảnh trả về (ảnh mẫu cho dải filter: ~37 KB/ô thay vì ~576 KB, đo thật).
  applyFilter: (image: string, filter: string, maxEdge?: number) =>
    req<{ image: string }>('/contents/apply-filter/', {
      method: 'POST',
      body: JSON.stringify({ image, filter, ...(maxEdge ? { max_edge: maxEdge } : {}) }),
    }),
  // removeText(image, mask) → erase the masked region (text/watermark) via the
  // self-hosted LaMa inpainting service (no content moderation). mask: white = erase.
  removeText: (image: string, mask: string) =>
    req<{ image: string }>('/contents/remove-text/', {
      method: 'POST',
      body: JSON.stringify({ image, mask }),
    }),
  // upscale(image, scale) → enlarge an EXISTING image via the self-hosted
  // Real-ESRGAN service (no OpenAI cost, and the picture's content cannot change
  // because nothing is re-generated). `image` may be a data URI OR an http(s)
  // character-media URL — the backend fetches those server-side to dodge CORS.
  // Takes ~2s for a 2x on a 1024px image, so callers should show a spinner.
  upscale: (image: string, scale = 2) =>
    req<{ image: string; width: number; height: number }>('/contents/upscale/', {
      method: 'POST',
      body: JSON.stringify({ image, scale }),
    }),
  // faceSwap(source, target) → put the face from `source` onto `target` via the
  // self-hosted face-swap gateway (proxied by Django, no OpenAI cost). Each may be
  // a data URI (uploaded) OR an http(s) URL (a character-media pick, fetched
  // server-side). Tries every engine the gateway exposes and returns whichever
  // succeeded — { results: { facefusion?, deeplivecam? } } (data URIs, keyed by
  // engine), plus { errors } for any engine that failed.
  faceSwap: (source: string, target: string) =>
    req<{ results: Record<string, string>; errors: Record<string, string> }>('/contents/face-swap/', {
      method: 'POST',
      body: JSON.stringify({ source, target }),
    }),
  // removeBackground(image) → cut out the subject (transparent PNG) via the
  // self-hosted rembg/U²-Net worker (runs off the Django process, no client download).
  removeBackground: (image: string) =>
    req<{ image: string }>('/contents/remove-background/', {
      method: 'POST',
      body: JSON.stringify({ image }),
    }),
  // detectText(image) → OCR text boxes (image-pixel coords) to pre-fill the mask.
  detectText: (image: string) =>
    req<{ width: number; height: number; boxes: { x: number; y: number; w: number; h: number; text: string; conf: number }[] }>('/contents/detect-text/', {
      method: 'POST',
      body: JSON.stringify({ image }),
    }),
  // Step 2 — persist the scripts the user ticked. Backend creates one
  // Content row per item, marked source_type='generated'.
  saveGenerated: (
    parentScenarioFilename: string,
    scripts: GeneratedScript[],
    mode: 'real_footage' | 'ai_video' = 'real_footage',
  ) =>
    req<ContentItem[]>('/contents/save-generated/', {
      method: 'POST',
      body: JSON.stringify({
        parent_scenario_filename: parentScenarioFilename,
        scripts,
        mode,
      }),
    }),

  // "Tối ưu bằng AI" — proxy sang ScriptStudio (agent_teams). Trả bản tối ưu để xem
  // trước (KHÔNG tự lưu). FE gọi saveFrames() nếu user chấp nhận.
  optimizeScript: (
    id: number,
    body: { mode?: string; allow_structure_change?: boolean; optimization_brief?: string },
  ) =>
    req<{ optimized_script: GeneratedScript }>(`/contents/${id}/optimize-script/`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Lưu frames đã tối ưu (PATCH; frames là field ghi được trên ContentSerializer).
  saveFrames: (id: number, frames: GeneratedScript['frames']) =>
    req<ContentItem>(`/contents/${id}/`, {
      method: 'PATCH',
      body: JSON.stringify({ frames }),
    }),

  // ── Chat-based AI refine (docs/Gen_Scenario/chat-refine-design.md) ──────
  // 1 thread per Content (=per KB). GET → list messages, POST → append user
  // turn + trigger OpenAI assistant reply server-side; FE refetches to render.
  scriptChat: {
    list: (id: number) =>
      req<ScriptChatMessage[]>(`/contents/${id}/script-chat/`),
    send: (id: number, body: { body: string; frame_target?: number | null }) =>
      req<ScriptChatMessage>(`/contents/${id}/script-chat/`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  // Refine 1 frame qua ScriptStudio (Reviser + 1 reviewer + Reviser, ~6s).
  refineFrame: (
    id: number,
    body: {
      frame_index: number
      brief?: string
      reviewer_focus?: ReviewerFocus
    },
  ) =>
    req<{ frame: GeneratedScriptFrame }>(`/contents/${id}/refine-frame/`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Manual edit 1 frame (auto-save) hoặc Restore từ origin_frames.
  updateFrame: (id: number, payload: UpdateFramePayload) =>
    req<{ frame?: GeneratedScriptFrame; frames?: GeneratedScriptFrame[] }>(
      `/contents/${id}/update-frame/`,
      { method: 'PATCH', body: JSON.stringify(payload) },
    ),

  // ── PREVIEW mode (stateless, no Content.id) — for the draft page that
  //    shows 5 freshly-generated KBs BEFORE saving. Chat history lives in
  //    FE state; refine works on in-memory frames + returns a candidate.
  previewChat: (body: {
    kb_name: string
    od_number: string
    frames: GeneratedScriptFrame[]
    mode: 'real_footage' | 'ai_video'
    body: string
    frame_target?: number | null
    recent_messages?: Array<{
      sender: 'USER' | 'ASSISTANT'
      body: string
      frame_target?: number | null
    }>
  }) =>
    req<{ assistant: string; patches: FramePatch[]; llm_model: string }>(
      '/contents/preview-script-chat/',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  previewRefineFrame: (body: {
    frame: GeneratedScriptFrame
    kb_context: { kb_name: string; od_number: string; frames: GeneratedScriptFrame[] }
    brief?: string
    reviewer_focus?: ReviewerFocus
    recent_chat?: Array<{ sender: 'USER' | 'ASSISTANT'; body: string }>
    mode: 'real_footage' | 'ai_video'
  }) =>
    req<{ frame: GeneratedScriptFrame }>(
      '/contents/preview-refine-frame/',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  getFeatureSystemPrompt: (featureId: string) =>
    req<FeatureSystemPrompt>(withQuery('/contents/feature-system-prompt/', { feature_id: featureId })),

  saveFeatureSystemPrompt: (featureId: string, systemPrompt: string) =>
    req<FeatureSystemPrompt>('/contents/feature-system-prompt/', {
      method: 'PUT',
      body: JSON.stringify({ feature_id: featureId, system_prompt: systemPrompt }),
    }),

  aiRewriteRepost: (data: RepostAiRewriteRequest) =>
    req<RepostAiRewriteResponse>('/contents/ai-rewrite-repost/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
}

export const crawlSourcesApi = {
  list: () => req<CrawlSource[]>('/crawl-sources/'),
  get: (id: number) => req<CrawlSource>(`/crawl-sources/${id}/`),
  create: (data: CrawlSourceCreate) =>
    req<CrawlSource>('/crawl-sources/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<CrawlSourceCreate>) =>
    req<CrawlSource>(`/crawl-sources/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/crawl-sources/${id}/`, { method: 'DELETE' }),
  listRuns: (
    id: number,
    params?: {
      page?: number
      page_size?: number
      status?: string
      search?: string
      started_after?: string
      started_before?: string
    },
  ) => req<PaginatedResponse<CrawlRun>>(withQuery(`/crawl-sources/${id}/runs/`, params)),
  listSnapshots: (
    id: number,
    params?: {
      page?: number
      page_size?: number
      search?: string
      content_type?: string
      has_media?: boolean | ''
      crawled_after?: string
      crawled_before?: string
    },
  ) => req<PaginatedResponse<CrawlContentSnapshot>>(withQuery(`/crawl-sources/${id}/snapshots/`, params)),
}

export const crawlContentSnapshotsApi = {
  get: (id: number) => req<CrawlContentSnapshot>(`/crawl-content-snapshots/${id}/`),
}

export const tiktokApi = {
  list: (params?: { date_from?: string; date_to?: string; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => !!v) as [string, string][]).toString()
      : ''
    return req<import('./types').TiktokVideo[]>(`/tiktok/${qs}`)
  },
  get: (id: number) => req<import('./types').TiktokVideo>(`/tiktok/${id}/`),
  create: (data: import('./types').TiktokVideoCreate) =>
    req<import('./types').TiktokVideo>('/tiktok/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').TiktokVideoCreate>) =>
    req<import('./types').TiktokVideo>(`/tiktok/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/tiktok/${id}/`, { method: 'DELETE' }),
  processVideo: (id: number) =>
    req<{ task_id: string; video: import('./types').TiktokVideo }>(`/tiktok/${id}/process-video/`, { method: 'POST' }),
  listInteractions: (id: number, type?: 'like' | 'comment') => {
    const qs = type ? `?type=${type}` : ''
    return req<import('./types').TiktokVideoInteraction[]>(`/tiktok/${id}/interactions/${qs}`)
  },
  addInteraction: (id: number, data: import('./types').TiktokVideoInteractionCreate) =>
    req<import('./types').TiktokVideoInteraction>(`/tiktok/${id}/interactions/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  listCommentPlans: (id: number) =>
    req<import('./types').TiktokCommentPlan[]>(`/tiktok/${id}/comment-plans/`),
  listApprovedCommentPlans: (params?: {
    date_from?: string
    date_to?: string
    approval_status?: 'approved' | 'pending' | 'all'
    commented_status?: 'commented' | 'not_commented' | 'all'
    profile_id?: string
    device_id?: string
  }) => {
    const qs = params
      ? '?' + new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string][],
      ).toString()
      : ''
    return req<import('./types').TiktokCommentPlan[]>(`/tiktok/approved-comments${qs}`)
  },
  listCommentedInteractions: (params?: {
    date_from?: string
    date_to?: string
    profile_id?: string
    device_id?: string
  }) => {
    const qs = params
      ? '?' + new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string][],
      ).toString()
      : ''
    return req<import('./types').TiktokCommentedInteraction[]>(`/tiktok/commented-interactions${qs}`)
  },
  deleteCommentedInteractions: (ids: number[]) =>
    req<{ deleted: number }>(`/tiktok/delete-interactions/`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  markReplayDispatched: (ids: number[], dispatched = true) =>
    req<{ updated: number; dispatched: boolean }>(`/tiktok/mark-replay-dispatched/`, {
      method: 'POST',
      body: JSON.stringify({ ids, dispatched }),
    }),
  createCommentPlan: (id: number, data: import('./types').TiktokCommentPlanCreate) =>
    req<import('./types').TiktokCommentPlan>(`/tiktok/${id}/comment-plans/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateCommentPlan: (id: number, planId: number, data: Partial<import('./types').TiktokCommentPlanCreate>) =>
    req<import('./types').TiktokCommentPlan>(`/tiktok/${id}/comment-plans/${planId}/`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  executeCommentPlanCluster: (id: number, planId: number, force_restart = false) =>
    req<import('./types').TiktokCommentPlanExecuteClusterResponse>(`/tiktok/${id}/comment-plans/${planId}/execute-cluster/`, {
      method: 'POST',
      body: JSON.stringify({ force_restart }),
    }),
  deleteCommentPlan: (id: number, planId: number) =>
    req<void>(`/tiktok/${id}/comment-plans/${planId}/`, { method: 'DELETE' }),
  listPlanChat: (id: number) =>
    req<import('./types').TiktokCommentPlanChatMessage[]>(`/tiktok/${id}/plan-chat/`),
  createPlanChatMessage: (id: number, data: import('./types').TiktokCommentPlanChatMessageCreate) =>
    req<import('./types').TiktokCommentPlanChatMessage>(`/tiktok/${id}/plan-chat/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  dispatchComments: (id: number, data: import('./types').TiktokDispatchCommentsRequest) =>
    req<import('./types').TiktokDispatchCommentsResponse>(`/tiktok/${id}/dispatch-comments/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  dispatchSingleComment: (id: number, data: import('./types').TiktokDispatchCommentsRequest) =>
    req<import('./types').TiktokDispatchCommentsResponse>(`/tiktok/${id}/dispatch-single-comment/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  approveAllCommentPlans: (id: number) =>
    req<{ approved: number }>(`/tiktok/${id}/comment-plans/approve-all/`, { method: 'POST' }),
  listVideoComments: (id: number) =>
    req<import('./types').TiktokVideoUserComment[]>(`/tiktok/${id}/video-comments/`),
  fetchVideoComments: (
    id: number,
    options?: { max_comments?: number; include_replies?: boolean; num_sessions?: number },
  ) =>
    req<import('./types').TiktokFetchCommentsResponse>(`/tiktok/${id}/fetch-comments/`, {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    }),
  clusterVideoComments: (
    id: number,
    options?: { model?: string; n_neighbors?: number; min_dist?: number; k_max?: number },
  ) =>
    req<import('./types').TiktokCommentClusterResponse>(`/tiktok/${id}/cluster-comments/`, {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    }),
  digComment: (videoId: number, interactionId: number, commentPlanId?: number | null) =>
    req<import('./types').TiktokDigCommentResponse>(`/tiktok/${videoId}/dig-comment/`, {
      method: 'POST',
      body: JSON.stringify({ interaction_id: interactionId, comment_plan_id: commentPlanId ?? null }),
    }),
  generateComment: (videoContent: string, existingComments: string[]) =>
    req<{ comment: string }>('/tiktok/generate-comment/', {
      method: 'POST',
      body: JSON.stringify({ video_content: videoContent, existing_comments: existingComments }),
    }),
  crawlChannelForResearch: (
    channelUrl: string,
    options?: { max_videos?: number; no_cache?: boolean },
  ) =>
    req<TiktokChannelResearchResponse>(
      withQuery('/tiktok/channel-crawl/', {
        'no-cache': options?.no_cache ? 'true' : undefined,
      }),
      {
        method: 'POST',
        body: JSON.stringify({
          channel_url: channelUrl,
          max_videos: options?.max_videos ?? 100,
        }),
      },
    ),
  processChannelVideoForResearch: (id: number, language = 'vi') =>
    req<{ task_id: string; video: TiktokChannelResearchVideo }>(`/tiktok/channel-videos/${id}/process-video/`, {
      method: 'POST',
      body: JSON.stringify({ language }),
    }),
  getChannelVideoForResearch: (id: number) =>
    req<TiktokChannelResearchVideo>(`/tiktok/channel-videos/${id}/process-video/`),
  extractChannelKeywordsForResearch: (channelUrl: string, options?: { max_videos?: number }) =>
    req<import('./types').TiktokChannelKeywordExtractionResponse>('/tiktok/channel-extract-keywords/', {
      method: 'POST',
      body: JSON.stringify({
        channel_url: channelUrl,
        max_videos: options?.max_videos ?? 100,
      }),
    }),
  generateTextVideo: (data: { content_text: string; background_description?: string; concept_music?: string; music_file?: File; style?: string; duration?: number; ref_image_url?: string; ref_image?: File; animation?: boolean }) => {
    const fd = new FormData()
    fd.append('content_text', data.content_text)
    if (data.background_description) fd.append('background_description', data.background_description)
    if (data.concept_music) fd.append('concept_music', data.concept_music)
    if (data.music_file) fd.append('music_file', data.music_file)
    if (data.style) fd.append('style', data.style)
    if (data.duration != null) fd.append('duration', String(data.duration))
    if (data.ref_image_url) fd.append('ref_image_url', data.ref_image_url)
    if (data.ref_image) fd.append('ref_image', data.ref_image)
    if (data.animation != null) fd.append('animation', String(data.animation))
    return reqForm<{ genvideo_task_id: string; estimated_seconds: number | null }>('/tiktok/generate-text-video/', fd)
  },
  // "Video hoạt cảnh" — genvideo /api/script-to-video (prompt + ref image, ≤5s).
  // mode 'boomerang' → /api/script-to-video-unlimited (5/15/30s, fixed prompt).
  generateSceneVideo: (data: { prompt: string; ref_image_url?: string; ref_image?: File; duration?: number; size?: 'tiktok' | 'youtube'; mode?: 'scene' | 'boomerang' }) => {
    const fd = new FormData()
    fd.append('prompt', data.prompt)
    if (data.ref_image_url) fd.append('ref_image_url', data.ref_image_url)
    if (data.ref_image) fd.append('ref_image', data.ref_image)
    if (data.duration != null) fd.append('duration', String(data.duration))
    fd.append('size', data.size || 'youtube')
    if (data.mode) fd.append('mode', data.mode)
    return reqForm<{ genvideo_task_id: string; estimated_seconds: number | null }>('/tiktok/generate-scene-video/', fd)
  },
  getTextVideoTask: (taskId: string) =>
    req<{ task_id: string; status: string; result?: { link_download?: string; music_path?: string } }>(`/tiktok/text-video-task/${taskId}/`),
  scheduleTiktokVideo: (data: { profile_id?: number | null; link_download: string; scheduled_at: string; caption?: string; hashtags?: string[] }) =>
    req<{ task_id: number; status: string }>('/tiktok/schedule-tiktok-video/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  repostChannelVideo: (id: number, data: { content_text: string; scheduled_at: string; profile_id?: number | null; background_description?: string; ref_image?: File; concept_music?: string; music_file?: File; style?: string; duration?: number; animation?: boolean }) => {
    const fd = new FormData()
    fd.append('content_text', data.content_text)
    fd.append('scheduled_at', data.scheduled_at)
    if (data.profile_id != null) fd.append('profile_id', String(data.profile_id))
    if (data.background_description) fd.append('background_description', data.background_description)
    if (data.ref_image) fd.append('ref_image', data.ref_image)
    if (data.concept_music) fd.append('concept_music', data.concept_music)
    if (data.music_file) fd.append('music_file', data.music_file)
    if (data.style) fd.append('style', data.style)
    if (data.duration != null) fd.append('duration', String(data.duration))
    if (data.animation != null) fd.append('animation', String(data.animation))
    return reqForm<{ genvideo_task_id: string; estimated_seconds: number | null }>(`/tiktok/channel-videos/${id}/repost/`, fd)
  },
}

export interface TodayVideo {
  id: number
  filename: string
  link_download: string
  link_youtube: string
  des: string
  timestamp: string
  run_id: string
}

export interface HighlightClip {
  id: number
  rank: number
  filename: string
  download_url: string
  timestamp: string
  action_desc: string
  transcript: string
}

export interface HighlightTaskResult {
  run_id: string
  title: string
  total_clips: number
  highlights: HighlightClip[]
}

export const genvideoContentApi = {
  requestHighlights: (youtubeUrl: string) =>
    req<{ task_id: string; status: string; estimated_seconds: number | null }>('/tiktok/highlights/', {
      method: 'POST',
      body: JSON.stringify({ youtube_url: youtubeUrl }),
    }),
  getTodayVideos: (page = 1, size = 10) =>
    req<{ items: TodayVideo[]; total: number; page: number; size: number; pages: number }>(`/tiktok/today-videos/?page=${page}&size=${size}`),
  getTask: (taskId: string) =>
    req<{ task_id: string; status: string; result?: HighlightTaskResult }>(`/tiktok/text-video-task/${taskId}/`),
}

export const keywordListsApi = {
  list: () => req<import('./types').KeywordList[]>('/tiktok/keyword-lists/'),
  get: (id: number) => req<import('./types').KeywordList>(`/tiktok/keyword-lists/${id}/`),
  create: (data: import('./types').KeywordListCreate) =>
    req<import('./types').KeywordList>('/tiktok/keyword-lists/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').KeywordListCreate> & { dispatched_keywords?: string[] }) =>
    req<import('./types').KeywordList>(`/tiktok/keyword-lists/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/tiktok/keyword-lists/${id}/`, { method: 'DELETE' }),
  share: (id: number, teamId: number, permission: import('./types').TeamPermissionValue) =>
    req<import('./types').KeywordList>(`/tiktok/keyword-lists/${id}/share/`, {
      method: 'POST',
      body: JSON.stringify({ team: teamId, team_permission: permission }),
    }),
  unshare: (id: number) =>
    req<import('./types').KeywordList>(`/tiktok/keyword-lists/${id}/unshare/`, { method: 'POST' }),
  generate: (
    topic: string,
    count: number,
    existingKeywords?: string[],
  ) =>
    req<import('./types').KeywordGenerateResponse>('/tiktok/keyword-lists/generate/', {
      method: 'POST',
      body: JSON.stringify({ topic, count, existing_keywords: existingKeywords ?? [] }),
    }),
  scanDispatched: () =>
    req<{ lists_scanned: number; keywords_removed: number; detail: { list_id: number; list_name: string; removed: string[] }[] }>(
      '/tiktok/keyword-lists/scan-dispatched/',
      { method: 'POST' },
    ),
  searchVideos: (id: number, data: { keyword: string; count?: number; cursor?: number; num_sessions?: number }) =>
    req<import('./types').KeywordSearchVideosResponse>(`/tiktok/keyword-lists/${id}/search-videos/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  saveSearchVideos: (id: number, data: { keyword: string; videos: import('./types').KeywordSearchVideo[] }) =>
    req<import('./types').KeywordSaveSearchVideosResponse>(`/tiktok/keyword-lists/${id}/save-search-videos/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  searchKeywords: (keywords: string[]) =>
    req<{ keywords: string[] | { keyword?: string; keywords?: string[] }[]; failed_keywords?: string[]; detail?: string }>('/tiktok/keyword-lists/search-keywords/', {
      method: 'POST',
      body: JSON.stringify({ keywords }),
    }),
}

export const facebookCleanupApi = {
  cleanupPublishedMedia: () =>
    req<{ scanned: number; deleted: number }>(
      '/facebook/cleanup-published-media/',
      { method: 'POST' },
    ),
}

export const facebookPagesApi = {
  list: (params?: { date_from?: string; date_to?: string; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => !!v) as [string, string][]).toString()
      : ''
    return req<import('./types').FacebookPage[]>(`/facebook/pages/${qs}`)
  },
  get: (id: number) => req<import('./types').FacebookPage>(`/facebook/pages/${id}/`),
  create: (data: import('./types').FacebookPageCreate) =>
    req<import('./types').FacebookPage>('/facebook/pages/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').FacebookPageCreate>) =>
    req<import('./types').FacebookPage>(`/facebook/pages/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/facebook/pages/${id}/`, { method: 'DELETE' }),
  uploadCsv: (pageId: number, source: File | string): Promise<{ created: number; skipped: { row: number; reason: string }[]; errors: { row: number; error: string }[] }> => {
    const fd = new FormData()
    if (typeof source === 'string') fd.append('sheet_url', source)
    else fd.append('file', source)
    return reqForm(`/facebook/pages/${pageId}/upload-csv/`, fd)
  },
}

export const facebookGroupsApi = {
  list: (params?: { date_from?: string; date_to?: string; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => !!v) as [string, string][]).toString()
      : ''
    return req<import('./types').FacebookGroup[]>(`/facebook/groups/${qs}`)
  },
  get: (id: number) => req<import('./types').FacebookGroup>(`/facebook/groups/${id}/`),
  create: (data: import('./types').FacebookGroupCreate) =>
    req<import('./types').FacebookGroup>('/facebook/groups/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').FacebookGroupCreate>) =>
    req<import('./types').FacebookGroup>(`/facebook/groups/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/facebook/groups/${id}/`, { method: 'DELETE' }),
  uploadCsv: (groupId: number, source: File | string): Promise<{ created: number; skipped: { row: number; reason: string }[]; errors: { row: number; error: string }[] }> => {
    const fd = new FormData()
    if (typeof source === 'string') fd.append('sheet_url', source)
    else fd.append('file', source)
    return reqForm(`/facebook/groups/${groupId}/upload-csv/`, fd)
  },
  syncPendingMemberPosts: (groupId: number) =>
    req<{ detail: string; task_id: number }>(
      `/facebook/groups/${groupId}/sync-pending-member-posts/`,
      { method: 'POST' },
    ),
}

export const facebookGroupPendingMemberPostsApi = {
  list: (params?: { group?: number; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]) as [string, string][],
        ).toString()
      : ''
    return req<import('./types').FacebookGroupPendingMemberPost[]>(`/facebook/group-pending-member-posts/${qs}`)
  },
  approve: (id: number) =>
    req<import('./types').FacebookGroupPendingMemberPost>(
      `/facebook/group-pending-member-posts/${id}/approve/`,
      { method: 'POST' },
    ),
  reject: (id: number) =>
    req<import('./types').FacebookGroupPendingMemberPost>(
      `/facebook/group-pending-member-posts/${id}/reject/`,
      { method: 'POST' },
    ),
}

export const facebookGroupPostsApi = {
  list: (params?: { group?: number; date_from?: string; date_to?: string; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]) as [string, string][],
      ).toString()
      : ''
    return req<import('./types').FacebookGroupPost[]>(`/facebook/group-posts/${qs}`)
  },
  get: (id: number) => req<import('./types').FacebookGroupPost>(`/facebook/group-posts/${id}/`),
  create: (data: import('./types').FacebookGroupPostCreate) =>
    req<import('./types').FacebookGroupPost>('/facebook/group-posts/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').FacebookGroupPostCreate>) =>
    req<import('./types').FacebookGroupPost>(`/facebook/group-posts/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/facebook/group-posts/${id}/`, { method: 'DELETE' }),
  uploadImage: (file: File): Promise<{ image_url: string }> => {
    const fd = new FormData()
    fd.append('file', file)
    return reqForm('/facebook/group-posts/upload-image/', fd)
  },
  publishNow: (id: number) =>
    req<{ detail: string; facebook_post_id: string; post_url: string }>(`/facebook/group-posts/${id}/publish-now/`, {
      method: 'POST',
    }),
}

export const facebookGroupScheduledPostsApi = {
  list: (params?: { group?: number; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]) as [string, string][],
        ).toString()
      : ''
    return req<import('./types').FacebookGroupScheduledPost[]>(`/facebook/group-scheduled-posts/${qs}`)
  },
  get: (id: number) => req<import('./types').FacebookGroupScheduledPost>(`/facebook/group-scheduled-posts/${id}/`),
  create: (data: import('./types').FacebookGroupScheduledPostCreate) =>
    req<import('./types').FacebookGroupScheduledPost>('/facebook/group-scheduled-posts/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').FacebookGroupScheduledPostCreate>) =>
    req<import('./types').FacebookGroupScheduledPost>(`/facebook/group-scheduled-posts/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/facebook/group-scheduled-posts/${id}/`, { method: 'DELETE' }),
  publishNow: (id: number) =>
    req<{ detail: string; scheduled_post_id: number; facebook_post_id: string }>(`/facebook/group-scheduled-posts/${id}/publish-now/`, {
      method: 'POST',
    }),
  publishDue: () =>
    req<{ published: number; failed: number }>('/facebook/group-scheduled-posts/publish-due/', { method: 'POST' }),
  deletePending: (groupId?: number) => {
    const suffix = groupId ? `?group=${groupId}` : ''
    return req<{ deleted: number }>(`/facebook/group-scheduled-posts/delete-pending/${suffix}`, {
      method: 'POST',
    })
  },
  approve: (id: number) =>
    req<import('./types').FacebookGroupScheduledPost>(`/facebook/group-scheduled-posts/${id}/approve/`, {
      method: 'POST',
    }),
  reject: (id: number, reason?: string) =>
    req<import('./types').FacebookGroupScheduledPost>(`/facebook/group-scheduled-posts/${id}/reject/`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? '' }),
    }),
}

export const facebookCompetitorApi = {
  analyze: (data: { url: string; since?: string; until?: string; max_posts?: number }) =>
    req<import('./types').FacebookCompetitorAnalysis>('/facebook/analyze-competitor/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
}

export const facebookProfilesApi = {
  list: (params?: { date_from?: string; date_to?: string; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => !!v) as [string, string][]).toString()
      : ''
    return req<import('./types').FacebookProfile[]>(`/facebook/profiles/${qs}`)
  },
  get: (id: number) => req<import('./types').FacebookProfile>(`/facebook/profiles/${id}/`),
  create: (data: import('./types').FacebookProfileCreate) =>
    req<import('./types').FacebookProfile>('/facebook/profiles/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').FacebookProfileCreate>) =>
    req<import('./types').FacebookProfile>(`/facebook/profiles/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/facebook/profiles/${id}/`, { method: 'DELETE' }),
  uploadCsv: (
    profileId: number,
    source: File | string,
    options?: { aiPrompt?: string; aiRewriteEnabled?: boolean; targetGroupId?: number | null },
  ): Promise<{ created: number; skipped: { row: number; reason: string }[]; errors: { row: number; error: string }[] }> => {
    const fd = new FormData()
    if (typeof source === 'string') fd.append('sheet_url', source)
    else fd.append('file', source)
    if (options?.aiRewriteEnabled) fd.append('ai_rewrite_enabled', 'true')
    if (options?.aiPrompt && options.aiPrompt.trim()) {
      fd.append('ai_prompt', options.aiPrompt.trim())
    }
    if (options?.targetGroupId) {
      fd.append('target_group_id', String(options.targetGroupId))
    }
    return reqForm(`/facebook/profiles/${profileId}/upload-csv/`, fd)
  },
  changeAvatar: (profileId: number, image: File): Promise<{ detail: string; task_id: number; image_url: string }> => {
    const fd = new FormData()
    fd.append('file', image)
    return reqForm(`/facebook/profiles/${profileId}/change-avatar/`, fd)
  },
  changeCover: (profileId: number, image: File): Promise<{ detail: string; task_id: number; image_url: string }> => {
    const fd = new FormData()
    fd.append('file', image)
    return reqForm(`/facebook/profiles/${profileId}/change-cover/`, fd)
  },
  postStory: (profileId: number, image: File): Promise<{ detail: string; task_id: number; image_url: string }> => {
    const fd = new FormData()
    fd.append('file', image)
    return reqForm(`/facebook/profiles/${profileId}/post-story/`, fd)
  },
}

export const facebookProfilePostsApi = {
  list: (params?: { profile?: number; date_from?: string; date_to?: string; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]) as [string, string][],
      ).toString()
      : ''
    return req<import('./types').FacebookProfilePost[]>(`/facebook/profile-posts/${qs}`)
  },
  get: (id: number) => req<import('./types').FacebookProfilePost>(`/facebook/profile-posts/${id}/`),
  create: (data: import('./types').FacebookProfilePostCreate) =>
    req<import('./types').FacebookProfilePost>('/facebook/profile-posts/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').FacebookProfilePostCreate>) =>
    req<import('./types').FacebookProfilePost>(`/facebook/profile-posts/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/facebook/profile-posts/${id}/`, { method: 'DELETE' }),
  uploadImage: (file: File): Promise<{ image_url: string }> => {
    const fd = new FormData()
    fd.append('file', file)
    return reqForm('/facebook/profile-posts/upload-image/', fd)
  },
  publishNow: (id: number) =>
    req<{ detail: string; facebook_post_id: string; post_url: string }>(`/facebook/profile-posts/${id}/publish-now/`, {
      method: 'POST',
    }),
}

export const facebookProfileScheduledPostsApi = {
  list: (params?: { profile?: number; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]) as [string, string][],
        ).toString()
      : ''
    return req<import('./types').FacebookProfileScheduledPost[]>(`/facebook/profile-scheduled-posts/${qs}`)
  },
  get: (id: number) => req<import('./types').FacebookProfileScheduledPost>(`/facebook/profile-scheduled-posts/${id}/`),
  create: (data: import('./types').FacebookProfileScheduledPostCreate) =>
    req<import('./types').FacebookProfileScheduledPost>('/facebook/profile-scheduled-posts/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').FacebookProfileScheduledPostCreate>) =>
    req<import('./types').FacebookProfileScheduledPost>(`/facebook/profile-scheduled-posts/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/facebook/profile-scheduled-posts/${id}/`, { method: 'DELETE' }),
  publishNow: (id: number) =>
    req<{ detail: string; scheduled_post_id: number; facebook_post_id: string }>(`/facebook/profile-scheduled-posts/${id}/publish-now/`, {
      method: 'POST',
    }),
  // ── Comment plans (TikTok-style) on a published scheduled post ──────────────
  // Comments are generated via the SAME N8N webhook as TikTok (keyed by device);
  // the FB account on each device posts the comment. dispatch needs an agent_group.
  listCommentPlans: (id: number) =>
    req<import('./types').FacebookScheduledCommentPlan[]>(`/facebook/profile-scheduled-posts/${id}/comment-plans/`),
  // Real scraped comments on the published post + clustering ("Phân tích").
  listPostComments: (id: number) =>
    req<import('./types').FacebookPostUserComment[]>(`/facebook/profile-scheduled-posts/${id}/post-comments/`),
  fetchComments: (id: number, options?: { max_comments?: number; include_replies?: boolean; num_sessions?: number }) =>
    req<import('./types').FacebookFetchCommentsResponse>(`/facebook/profile-scheduled-posts/${id}/fetch-comments/`, {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    }),
  clusterComments: (id: number) =>
    req<import('./types').FacebookCommentClusterResponse>(`/facebook/profile-scheduled-posts/${id}/cluster-comments/`, { method: 'POST', body: '{}' }),
  dispatchComments: (id: number, data: { agent_group: number; devices?: number[]; content?: string; keywords?: string[] }) =>
    req<import('./types').FacebookScheduledDispatchCommentsResponse>(`/facebook/profile-scheduled-posts/${id}/dispatch-comments/`, {
      method: 'POST', body: JSON.stringify(data),
    }),
  dispatchSingleComment: (id: number, data: { agent_group: number; devices?: number[]; content?: string; keywords?: string[] }) =>
    req<import('./types').FacebookScheduledDispatchCommentsResponse>(`/facebook/profile-scheduled-posts/${id}/dispatch-single-comment/`, {
      method: 'POST', body: JSON.stringify(data),
    }),
  updateCommentPlan: (id: number, planId: number, data: { comment_content?: string; is_approved?: boolean }) =>
    req<import('./types').FacebookScheduledCommentPlan>(`/facebook/profile-scheduled-posts/${id}/comment-plans/${planId}/`, {
      method: 'PATCH', body: JSON.stringify(data),
    }),
  deleteCommentPlan: (id: number, planId: number) =>
    req<void>(`/facebook/profile-scheduled-posts/${id}/comment-plans/${planId}/`, { method: 'DELETE' }),
  approveAllCommentPlans: (id: number) =>
    req<{ approved: number }>(`/facebook/profile-scheduled-posts/${id}/comment-plans/approve-all/`, { method: 'POST' }),
  executeCommentPlan: (id: number, planId: number) =>
    req<{ detail: string; scheduled_plan_id: number; task_id: number }>(`/facebook/profile-scheduled-posts/${id}/comment-plans/${planId}/execute-cluster/`, {
      method: 'POST',
    }),
  // Dispatch a phoneagent task to FIND this post's published link on Facebook
  // (worker syncs it back via update-link). Sends a Kafka find_profile_post_link task.
  findLink: (id: number) =>
    req<{ detail: string; task_id: number; scheduled_post_id: number }>(`/facebook/profile-scheduled-posts/${id}/find-link/`, {
      method: 'POST',
    }),
  publishDue: () =>
    req<{ published: number; failed: number }>('/facebook/profile-scheduled-posts/publish-due/', { method: 'POST' }),
  deletePending: (profileId?: number) => {
    const suffix = profileId ? `?profile=${profileId}` : ''
    return req<{ deleted: number }>(`/facebook/profile-scheduled-posts/delete-pending/${suffix}`, {
      method: 'POST',
    })
  },
  aiRewrite: (id: number, prompt?: string) =>
    req<{ id: number; original_content: string; ai_rewritten_content: string; ai_prompt: string }>(
      `/facebook/profile-scheduled-posts/${id}/ai-rewrite/`,
      { method: 'POST', body: JSON.stringify({ prompt: prompt ?? '' }) },
    ),
  aiAccept: (id: number, content: string) =>
    req<{ id: number; content: string }>(`/facebook/profile-scheduled-posts/${id}/ai-accept/`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  // Download the .xlsx template (headers + 1 sample row). Returns a blob the
  // caller turns into an object URL + anchor click to trigger a save dialog.
  downloadTemplate: async (): Promise<Blob> => {
    const token = getAccessToken()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`${BASE}/api/facebook/profile-scheduled-posts/template/`, { headers })
    if (!res.ok) {
      const raw = await res.text().catch(() => res.statusText)
      throw new Error(raw || res.statusText)
    }
    return res.blob()
  },
}

export const facebookProfileScheduledMediaActionsApi = {
  list: (params?: { profile?: number; status?: string; action_type?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]) as [string, string][],
        ).toString()
      : ''
    return req<import('./types').FacebookProfileScheduledMediaAction[]>(`/facebook/profile-scheduled-media-actions/${qs}`)
  },
  delete: (id: number) => req<void>(`/facebook/profile-scheduled-media-actions/${id}/`, { method: 'DELETE' }),
  publishNow: (id: number) =>
    req<import('./types').FacebookProfileScheduledMediaAction>(
      `/facebook/profile-scheduled-media-actions/${id}/publish-now/`,
      { method: 'POST' },
    ),
  deletePending: (profileId?: number) => {
    const suffix = profileId ? `?profile=${profileId}` : ''
    return req<{ deleted: number }>(`/facebook/profile-scheduled-media-actions/delete-pending/${suffix}`, {
      method: 'POST',
    })
  },
}

type SeedingActionPayload = Partial<{
  post: number
  actor_fb_profile: number
  interaction_type: import('./types').FacebookSeedingInteractionType
  comment_content: string
  reply_target_username: string
  reply_target_snippet: string
  ai_prompt: string
}>

function buildSeedingActionsApi<T>(basePath: string) {
  return {
    list: (params?: { post?: number; status?: string }) => {
      const qs = params
        ? '?' + new URLSearchParams(
            Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]) as [string, string][],
          ).toString()
        : ''
      return req<T[]>(`${basePath}${qs}`)
    },
    get: (id: number) => req<T>(`${basePath}${id}/`),
    create: (data: SeedingActionPayload) =>
      req<T>(basePath, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: SeedingActionPayload) =>
      req<T>(`${basePath}${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) => req<void>(`${basePath}${id}/`, { method: 'DELETE' }),
    dispatch: (id: number) =>
      req<T>(`${basePath}${id}/dispatch/`, { method: 'POST' }),
    aiGenerate: (id: number, ai_prompt?: string) =>
      req<T>(`${basePath}${id}/ai-generate/`, {
        method: 'POST',
        body: JSON.stringify({ ai_prompt: ai_prompt ?? '' }),
      }),
  }
}

export const facebookProfilePostSeedingActionsApi = buildSeedingActionsApi<
  import('./types').FacebookProfilePostSeedingAction
>('/facebook/profile-post-seeding-actions/')

export const facebookGroupPostSeedingActionsApi = buildSeedingActionsApi<
  import('./types').FacebookGroupPostSeedingAction
>('/facebook/group-post-seeding-actions/')

export const facebookScheduledPostsApi = {
  list: (params?: { page?: number; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]) as [string, string][],
        ).toString()
      : ''
    return req<import('./types').FacebookScheduledPost[]>(`/facebook/scheduled-posts/${qs}`)
  },
  get: (id: number) => req<import('./types').FacebookScheduledPost>(`/facebook/scheduled-posts/${id}/`),
  create: (data: import('./types').FacebookScheduledPostCreate) =>
    req<import('./types').FacebookScheduledPost>('/facebook/scheduled-posts/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').FacebookScheduledPostCreate>) =>
    req<import('./types').FacebookScheduledPost>(`/facebook/scheduled-posts/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/facebook/scheduled-posts/${id}/`, { method: 'DELETE' }),
  publishNow: (id: number) =>
    req<{ detail: string; scheduled_post_id: number; facebook_post_id: string }>(`/facebook/scheduled-posts/${id}/publish-now/`, {
      method: 'POST',
    }),
  publishDue: () =>
    req<{ published: number; failed: number }>('/facebook/scheduled-posts/publish-due/', { method: 'POST' }),
  deletePending: (pageId?: number) => {
    const suffix = pageId ? `?page=${pageId}` : ''
    return req<{ deleted: number }>(`/facebook/scheduled-posts/delete-pending/${suffix}`, {
      method: 'POST',
    })
  },
}

export const facebookPostsApi = {
  list: (params?: { page?: number; date_from?: string; date_to?: string; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]) as [string, string][],
      ).toString()
      : ''
    return req<import('./types').FacebookPost[]>(`/facebook/posts/${qs}`)
  },
  get: (id: number) => req<import('./types').FacebookPost>(`/facebook/posts/${id}/`),
  create: (data: import('./types').FacebookPostCreate) =>
    req<import('./types').FacebookPost>('/facebook/posts/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').FacebookPostCreate>) =>
    req<import('./types').FacebookPost>(`/facebook/posts/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/facebook/posts/${id}/`, { method: 'DELETE' }),
  uploadImage: (file: File): Promise<{ image_url: string }> => {
    const fd = new FormData()
    fd.append('file', file)
    return reqForm('/facebook/posts/upload-image/', fd)
  },
  publishNow: (id: number) =>
    req<{ detail: string; facebook_post_id: string; post_url: string }>(`/facebook/posts/${id}/publish-now/`, {
      method: 'POST',
    }),
  listInteractions: (id: number, type?: 'like' | 'comment') => {
    const qs = type ? `?type=${type}` : ''
    return req<import('./types').FacebookPostInteraction[]>(`/facebook/posts/${id}/interactions/${qs}`)
  },
  addInteraction: (id: number, data: import('./types').FacebookPostInteractionCreate) =>
    req<import('./types').FacebookPostInteraction>(`/facebook/posts/${id}/interactions/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  listCommentPlans: (id: number) =>
    req<import('./types').FacebookCommentPlan[]>(`/facebook/posts/${id}/comment-plans/`),
  createCommentPlan: (id: number, data: import('./types').FacebookCommentPlanCreate) =>
    req<import('./types').FacebookCommentPlan>(`/facebook/posts/${id}/comment-plans/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateCommentPlan: (id: number, planId: number, data: Partial<import('./types').FacebookCommentPlanCreate>) =>
    req<import('./types').FacebookCommentPlan>(`/facebook/posts/${id}/comment-plans/${planId}/`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteCommentPlan: (id: number, planId: number) =>
    req<void>(`/facebook/posts/${id}/comment-plans/${planId}/`, { method: 'DELETE' }),
  approveAllCommentPlans: (id: number) =>
    req<{ approved: number }>(`/facebook/posts/${id}/comment-plans/approve-all/`, { method: 'POST' }),
  dispatchComments: (id: number, data: import('./types').FacebookDispatchCommentsRequest) =>
    req<import('./types').FacebookDispatchCommentsResponse>(`/facebook/posts/${id}/dispatch-comments/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  generateComment: (postContent: string, existingComments: string[]) =>
    req<{ comment: string }>('/facebook/generate-comment/', {
      method: 'POST',
      body: JSON.stringify({ post_content: postContent, existing_comments: existingComments }),
    }),
  listCommentedInteractions: (params?: { date_from?: string; date_to?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string][],
      ).toString()
      : ''
    return req<import('./types').FacebookCommentedInteraction[]>(`/facebook/posts/commented-interactions${qs}`)
  },
  markReplayDispatched: (ids: number[], dispatched = true) =>
    req<{ updated: number; dispatched: boolean }>(`/facebook/posts/mark-replay-dispatched/`, {
      method: 'POST',
      body: JSON.stringify({ ids, dispatched }),
    }),
  deleteCommentedInteractions: (ids: number[]) =>
    req<{ deleted: number }>(`/facebook/posts/delete-interactions/`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  listPostComments: (id: number) =>
    req<import('./types').FacebookPostUserComment[]>(`/facebook/posts/${id}/post-comments/`),
  fetchComments: (id: number, options?: { max_comments?: number; include_replies?: boolean; num_sessions?: number }) =>
    req<import('./types').FacebookFetchCommentsResponse>(`/facebook/posts/${id}/fetch-comments/`, {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    }),
  clusterComments: (id: number) =>
    req<import('./types').FacebookCommentClusterResponse>(`/facebook/posts/${id}/cluster-comments/`, { method: 'POST', body: '{}' }),
  digComment: (postId: number, interactionId: number, commentPlanId?: number | null) =>
    req<import('./types').FacebookDigCommentResponse>(`/facebook/posts/${postId}/dig-comment/`, {
      method: 'POST',
      body: JSON.stringify({ interaction_id: interactionId, comment_plan_id: commentPlanId ?? null }),
    }),
}

export const workflowsApi = {
  list: () => req<Workflow[]>('/workflows/'),
  listByProfile: (profileId: number) => req<Workflow[]>(`/workflows/?profile=${profileId}`),
  listByDevice: (deviceId: number) => req<Workflow[]>(`/workflows/?device=${deviceId}`),
  get: (id: number) => req<Workflow>(`/workflows/${id}/`),
  create: (data: WorkflowCreate) =>
    req<Workflow>('/workflows/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<WorkflowCreate>) =>
    req<Workflow>(`/workflows/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/workflows/${id}/`, { method: 'DELETE' }),
  run: (id: number) =>
    req<WorkflowRun>(`/workflows/${id}/run/`, { method: 'POST' }),
}

export const workflowTriggersApi = {
  list: (workflowId: number) =>
    req<WorkflowTrigger[]>(`/workflows/${workflowId}/triggers/`),
  create: (workflowId: number, data: WorkflowTriggerCreate) =>
    req<WorkflowTrigger>(`/workflows/${workflowId}/triggers/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (workflowId: number, triggerId: number, data: Partial<WorkflowTriggerCreate>) =>
    req<WorkflowTrigger>(`/workflows/${workflowId}/triggers/${triggerId}/`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (workflowId: number, triggerId: number) =>
    req<void>(`/workflows/${workflowId}/triggers/${triggerId}/`, { method: 'DELETE' }),
}

export const workflowStepsApi = {
  list: (workflowId: number) => req<WorkflowStep[]>(`/workflows/${workflowId}/steps/`),
  create: (workflowId: number, data: WorkflowStepCreate) =>
    req<WorkflowStep>(`/workflows/${workflowId}/steps/`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (workflowId: number, stepId: number, data: Partial<WorkflowStepCreate>) =>
    req<WorkflowStep>(`/workflows/${workflowId}/steps/${stepId}/`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (workflowId: number, stepId: number) =>
    req<void>(`/workflows/${workflowId}/steps/${stepId}/`, { method: 'DELETE' }),
}

export const workflowRunsApi = {
  list: (workflowId: number) => req<WorkflowRun[]>(`/workflows/${workflowId}/runs/`),
  get: (workflowId: number, runId: number) =>
    req<WorkflowRun>(`/workflows/${workflowId}/runs/${runId}/`),
  cancel: (workflowId: number, runId: number) =>
    req<WorkflowRun>(`/workflows/${workflowId}/runs/${runId}/cancel/`, { method: 'POST' }),
}

export const eventsApi = {
  list: () => req<SystemEventDef[]>('/events/'),
}

export const chatSettingsApi = {
  get: () => req<import('./types').ChatSettings>('/auth/chat-settings/'),
  update: (data: Partial<import('./types').ChatSettings>) =>
    req<import('./types').ChatSettings>('/auth/chat-settings/', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
}

// ─── AI Scenario v3 API ──────────────────────────────────────────────────────
// Endpoints khớp `mobile-control/content_scenario/views.py`

interface ScenarioGenerateInput {
  brief: string
  duration_target_seconds: number
  shot_count_target?: number
  genre?: import('./types').ScenarioGenre
  brand_override?: string
  file?: File | null
  paste_text?: string
  /** v3.2.1 Option 3D — UUID FE sinh, gửi cùng generate request. Khi cancel,
   * FE POST /cancel/ với cùng UUID này → BE SET Redis flag → orchestrator
   * raise ScenarioCancelled → return 499. */
  request_id?: string
}

function buildScenarioFormData(input: ScenarioGenerateInput): FormData {
  const fd = new FormData()
  fd.append('brief', input.brief)
  fd.append('duration_target_seconds', String(input.duration_target_seconds))
  if (input.shot_count_target != null) {
    fd.append('shot_count_target', String(input.shot_count_target))
  }
  if (input.genre) fd.append('genre', input.genre)
  if (input.brand_override) fd.append('brand_override', input.brand_override)
  if (input.file) fd.append('file', input.file)
  if (input.paste_text) fd.append('paste_text', input.paste_text)
  // v3.2.1 Option 3D
  if (input.request_id) fd.append('request_id', input.request_id)
  return fd
}

export const charactersApi = {
  list: (params?: { page?: number; page_size?: number; search?: string }) => {
    const search = new URLSearchParams()
    if (params?.page != null) search.set('page', String(params.page))
    if (params?.page_size != null) search.set('page_size', String(params.page_size))
    if (params?.search) search.set('search', params.search)
    const query = search.toString()
    return req<PaginatedResponse<Character>>(`/characters/${query ? `?${query}` : ''}`)
  },

  create: (payload: {
    name: string
    source_image?: string
    face_prompt?: string
    nation?: string
    media?: string[]
    scenes?: string[]
  }) =>
    req<Character>('/characters/', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  get: (id: number) => req<Character>(`/characters/${id}/`),

  // The four appearance blocks are PATCHable so the brief builder can pin a
  // character down once and reuse it verbatim across every scene.
  update: (id: number, payload: { name?: string } & Partial<CharacterBlocks>) =>
    req<Character>(`/characters/${id}/`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  addMedia: (id: number, payload: { media?: string[]; scenes?: string[] }) =>
    req<Character>(`/characters/${id}/add-media/`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Ẩn (hoặc bỏ ẩn) một ảnh trong media/scenes — KHÔNG xoá, chỉ gắn cờ hidden.
  // Ảnh ẩn bị lọc khỏi gallery và khỏi việc chọn đăng bài, nhưng vẫn còn trong DB.
  hideMedia: (id: number, payload: { url: string; kind: 'media' | 'scenes'; hidden?: boolean }) =>
    req<Character>(`/characters/${id}/hide-media/`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Fetch the character's source face as a base64 data URI (server-side from
  // the private bucket) so it can be reused as the swap source when adding more.
  getSourceImage: (id: number) =>
    req<{ image: string }>(`/characters/${id}/source-image/`),

  // Fetch a non-CORS storage image (legacy Cloudfly) as a base64 data URI so the
  // editor can load it without tainting the canvas. SeaweedFS images load directly
  // in the browser; this is only the fallback for hosts lacking CORS.
  proxyImage: (url: string) =>
    req<{ image: string }>(`/characters/proxy-image/`, { method: 'POST', body: JSON.stringify({ url }) }),

  // Append a generated video (by external genvideo URL) to the character.
  addVideo: (id: number, videoUrl: string) =>
    req<Character>(`/characters/${id}/add-video/`, {
      method: 'POST',
      body: JSON.stringify({ video_url: videoUrl }),
    }),

  // Fire-and-forget: poll a genvideo task in the background and append the
  // finished video to the character when ready (generation takes minutes).
  watchVideoTask: (id: number, genvideoTaskId: string) =>
    req<{ status: string; genvideo_task_id: string }>(`/characters/${id}/watch-video-task/`, {
      method: 'POST',
      body: JSON.stringify({ genvideo_task_id: genvideoTaskId }),
    }),

  // AI-generate cinematic scene-video prompt suggestions (for the "hoạt cảnh"
  // flow). Calling again returns a fresh set ("Tạo lại").
  suggestScenePrompts: (id: number, size: 'tiktok' | 'youtube', topic: string) =>
    req<{ prompts: string[] }>(`/characters/${id}/suggest-scene-prompts/`, {
      method: 'POST',
      body: JSON.stringify({ size, topic }),
    }),

  // Post a character's photos to a social platform — now or on a schedule.
  // Posts selected character media (by URL) and/or freshly uploaded images,
  // with caption + hashtags, to the chosen platform target. When `scheduled_at`
  // is a future ISO time the backend queues a CharacterScheduledPost instead of
  // firing immediately (returns the scheduled-post record then).
  postPhotos: (data: {
    platform?: CharacterPostPlatform
    media_urls?: string[]
    images?: File[]
    caption?: string
    hashtags?: string[]
    character_id?: number | null
    scheduled_at?: string | null
    // TikTok target
    device_id?: number | null
    profile_id?: number | null
    // Facebook targets
    fb_profile_id?: number | null
    fb_page_id?: number | null
    fb_group_id?: number | null
  }) => {
    const fd = new FormData()
    fd.append('platform', data.platform ?? 'tiktok')
    fd.append('media_urls', JSON.stringify(data.media_urls ?? []))
    fd.append('hashtags', JSON.stringify(data.hashtags ?? []))
    if (data.caption) fd.append('caption', data.caption)
    if (data.character_id != null) fd.append('character_id', String(data.character_id))
    if (data.scheduled_at) fd.append('scheduled_at', data.scheduled_at)
    if (data.device_id != null) fd.append('device_id', String(data.device_id))
    if (data.profile_id != null) fd.append('profile_id', String(data.profile_id))
    if (data.fb_profile_id != null) fd.append('fb_profile_id', String(data.fb_profile_id))
    if (data.fb_page_id != null) fd.append('fb_page_id', String(data.fb_page_id))
    if (data.fb_group_id != null) fd.append('fb_group_id', String(data.fb_group_id))
    ;(data.images ?? []).forEach((f) => fd.append('images', f))
    return reqForm<{
      task_id?: number
      device_serial_id?: string
      fb_post_id?: string
      image_count?: number
      // present when scheduled
      id?: number
      status?: string
      scheduled_at?: string
    }>('/characters/post-photos/', fd)
  },

  // Set a Facebook Page's avatar and/or cover from the character's images.
  // Returns per-target {ok, error?} so the UI can report partial success.
  changePageImage: (data: {
    fb_page_id: number
    avatar_url?: string
    cover_url?: string
    avatar_crop?: { x: number; y: number; w: number; h: number } | null
    cover_crop?: { x: number; y: number; w: number; h: number } | null
  }) =>
    req<{ results: { avatar?: { ok: boolean; error?: string }; cover?: { ok: boolean; error?: string } } }>(
      '/characters/change-page-image/',
      { method: 'POST', body: JSON.stringify(data) },
    ),

  destroy: (id: number) =>
    req<void>(`/characters/${id}/`, { method: 'DELETE' }),
}

export type CharacterPostPlatform =
  | 'tiktok'
  | 'facebook_profile'
  | 'facebook_page'
  | 'facebook_group'

export const characterScheduledPostsApi = {
  list: (params?: { character?: number; status?: string }) => {
    const qs = new URLSearchParams()
    if (params?.character != null) qs.set('character', String(params.character))
    if (params?.status) qs.set('status', params.status)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return req<CharacterScheduledPost[]>(`/character-scheduled-posts/${suffix}`)
  },
  cancel: (id: number) =>
    req<CharacterScheduledPost>(`/character-scheduled-posts/${id}/cancel/`, { method: 'POST' }),
}

export const contentScenariosApi = {
  previewIntent: (input: Pick<ScenarioGenerateInput, 'brief' | 'file' | 'paste_text'>) => {
    const fd = new FormData()
    fd.append('brief', input.brief)
    if (input.file) fd.append('file', input.file)
    if (input.paste_text) fd.append('paste_text', input.paste_text)
    return reqForm<import('./types').ScenarioPreviewIntentResponse>(
      '/content-scenarios/preview-intent/',
      fd,
    )
  },

  generate: (input: ScenarioGenerateInput, signal?: AbortSignal) =>
    reqForm<import('./types').ScenarioGenerateResponse>(
      '/content-scenarios/generate/',
      buildScenarioFormData(input),
      signal,
    ),

  /** v3.2.1 Option 3D — TRUE cancel generate đang chạy.
   *
   * Gọi endpoint này TRƯỚC khi AbortController.abort() — BE SET Redis flag,
   * agent_teams orchestrator check signal trước mỗi LLM call → raise
   * ScenarioCancelled → return 499. Tiết kiệm ~50-70% LLM cost nếu cancel sớm.
   *
   * Lưu ý: cancel là best-effort. Nếu signal đến TRONG khi LLM đang chạy
   * (OpenAI/Gemini API không support cancel mid-call), call đó tiếp tục đến
   * hết, nhưng NEXT layer sẽ raise.
   */
  cancelGenerate: (request_id: string) =>
    req<{ request_id: string; signalled: boolean; detail: string }>(
      '/content-scenarios/cancel/',
      { method: 'POST', body: JSON.stringify({ request_id }) },
    ),

  save: (payload: {
    scenario: import('./types').ScenarioJSON
    source_file_name?: string
    intent_json?: import('./types').ScenarioIntent
  }) =>
    req<import('./types').ContentScenarioItem>('/content-scenarios/save/', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  list: (params?: { page?: number; page_size?: number; search?: string }) =>
    req<import('./types').PaginatedResponse<import('./types').ContentScenarioItem>>(
      withQuery('/content-scenarios/', params),
    ),
  get: (id: number) =>
    req<import('./types').ContentScenarioItem>(`/content-scenarios/${id}/`),
  update: (id: number, data: Partial<{ title: string; brief: string }>) =>
    req<import('./types').ContentScenarioItem>(`/content-scenarios/${id}/`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: number) =>
    req<void>(`/content-scenarios/${id}/`, { method: 'DELETE' }),

  // Dispatch an async video render (video-agent-worker via Kafka). Poll
  // videoStatus until video_status is 'completed' (video_url is presigned).
  generateVideo: (id: number) =>
    req<{ task_id: string; video_status: string }>(
      `/content-scenarios/${id}/generate-video/`, { method: 'POST' },
    ),
  videoStatus: (id: number) =>
    req<{ video_status: string; video_url: string; video_error: string; video_task_id: string }>(
      `/content-scenarios/${id}/video-status/`,
    ),

  updateShot: (id: number, shot_id: number, fields: Record<string, unknown>) =>
    req<import('./types').ScenarioShot>(`/content-scenarios/${id}/update-shot/`, {
      method: 'PATCH',
      body: JSON.stringify({ shot_id, fields }),
    }),
  updateCharacter: (id: number, character_name: string, fields: Record<string, unknown>) =>
    req<{ character: import('./types').ScenarioCharacter }>(
      `/content-scenarios/${id}/update-character/`,
      { method: 'PATCH', body: JSON.stringify({ character_name, fields }) },
    ),

  restoreShot: (id: number, shot_id: number) =>
    req<import('./types').ScenarioShot>(`/content-scenarios/${id}/restore-shot/`, {
      method: 'PATCH',
      body: JSON.stringify({ shot_id }),
    }),
  restoreAll: (id: number) =>
    req<import('./types').ContentScenarioItem>(`/content-scenarios/${id}/restore-all/`, {
      method: 'PATCH',
      body: '{}',
    }),

  audits: (id: number) =>
    req<import('./types').ScenarioAuditLogItem[]>(`/content-scenarios/${id}/audits/`),

  scriptChat: {
    list: (id: number) =>
      req<import('./types').ScenarioChatMessage[]>(`/content-scenarios/${id}/script-chat/`),
    /** POST script-chat — v3.2.1: trả enriched response với 3 trường transient
     * (structured_actions, proposed_options, clarification_question) để FE render. */
    send: (id: number, payload: { body: string; target_shots?: number[]; target_character?: string }) =>
      req<import('./types').ScriptChatSendResponse>(`/content-scenarios/${id}/script-chat/`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  previewScriptChat: (payload: {
    scenario: import('./types').ScenarioJSON
    history?: Array<{ sender: string; body: string; target_shots?: number[]; target_character?: string }>
    body: string
    target_shots?: number[]
    target_character?: string
    brand_override?: string
  }) =>
    req<import('./types').ScenarioChatTurnResponse>('/content-scenarios/preview-script-chat/', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getBrandPrompt: () =>
    req<import('./types').ScenarioBrandPromptResponse>('/content-scenarios/brand-prompt/'),
  setBrandPrompt: (system_prompt: string) =>
    req<{ system_prompt: string }>('/content-scenarios/brand-prompt/', {
      method: 'POST',
      body: JSON.stringify({ system_prompt }),
    }),

  // ─── v3.2 — Nhóm A: Graph mutation toolkit ───────────────────────────────
  insertShot: (id: number, after_shot_id: number, brief: string) =>
    req<import('./types').ScenarioShot>(`/content-scenarios/${id}/insert-shot/`, {
      method: 'POST',
      body: JSON.stringify({ after_shot_id, brief }),
    }),

  /** delete-shot: nếu shot bị xoá là anchor của shot khác → BE trả 409 với
   * payload { orphans, reanchor_candidates } → FE show OrphanResolutionModal.
   * Sau khi user chọn → call lại với `orphan_resolution`. */
  deleteShot: (id: number, shot_id: number, orphan_resolution?: string) =>
    req<{ deleted_shot_id: number; orphans_handled: number }>(
      `/content-scenarios/${id}/delete-shot/`,
      {
        method: 'POST',
        body: JSON.stringify({ shot_id, orphan_resolution }),
      },
    ),

  // v3.2.2 Phase 0 — fix bug #2 (xoá character không có modal)
  deleteCharacter: (id: number, name: string, replace_in_shots_with?: string | null) =>
    req<{
      deleted_character: string
      affected_shot_ids: number[]
      replaced_with: string
    }>(
      `/content-scenarios/${id}/delete-character/`,
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          replace_in_shots_with: replace_in_shots_with ?? '',
        }),
      },
    ),

  // v3.2.2 Phase 2 — 4 verb tool mới
  addCharacter: (id: number, payload: {
    name: string; age: string; outfit_style: string;
    ethnicity?: string; voice_id_hint?: string;
  }) =>
    req<{added_character: Record<string, string>; registry: any[]}>(
      `/content-scenarios/${id}/add-character/`,
      {method: 'POST', body: JSON.stringify(payload)},
    ),

  moveShot: (id: number, shot_id: number, new_position: number) =>
    req<{
      moved_shot_id: number; from_order: number; to_order: number;
      anchor_break_warning: boolean;
    }>(
      `/content-scenarios/${id}/move-shot/`,
      {method: 'POST', body: JSON.stringify({shot_id, new_position})},
    ),

  duplicateShot: (id: number, shot_id: number) =>
    req<{
      duplicated_shot_id: number; duplicated_from: number; shot_order: number;
    }>(
      `/content-scenarios/${id}/duplicate-shot/`,
      {method: 'POST', body: JSON.stringify({shot_id})},
    ),

  batchUpdateShots: (id: number, updates: Array<{shot_id: number; fields: Record<string, unknown>}>) =>
    req<{batch_results: Array<{shot_id: number; updated_fields?: string[]; error?: string}>; count: number}>(
      `/content-scenarios/${id}/batch-update-shots/`,
      {method: 'POST', body: JSON.stringify({updates})},
    ),

  // v3.2.2 Phase 2 — Plan & Execute
  executePlan: (id: number, plan_id: number, step_indices?: number[]) =>
    req<{
      plan_id: number; status: string;
      steps: Array<{
        description: string; tool_name: string; status: string;
        result?: unknown; error?: string | null;
      }>;
      completed_steps: number; failed_steps: number;
    }>(
      `/content-scenarios/${id}/plans/${plan_id}/execute/`,
      {method: 'POST', body: JSON.stringify(step_indices ? {step_indices} : {})},
    ),

  cancelPlan: (id: number, plan_id: number) =>
    req<{plan_id: number; status: string}>(
      `/content-scenarios/${id}/plans/${plan_id}/cancel/`,
      {method: 'POST', body: '{}'},
    ),

  // v3.2.2 Phase 3 — Cross-shot scoring (5 dimension)
  scanScenario: (id: number) =>
    req<{
      scores: import('./types').ScenarioScores
      strengths: string[]
      weaknesses: string[]
      recommendations: string[]
    }>(
      `/content-scenarios/${id}/scan/`,
      {method: 'POST', body: '{}'},
    ),

  reorderShots: (id: number, new_order: number[]) =>
    req<import('./types').ContentScenarioItem>(`/content-scenarios/${id}/reorder-shots/`, {
      method: 'POST',
      body: JSON.stringify({ new_order }),
    }),

  optimizeWhole: (id: number, variant_brief?: string) =>
    req<{
      scenario: import('./types').ScenarioJSON
      warnings: string[]
      iterations_used: number
      final_avg_score: number
    }>(`/content-scenarios/${id}/optimize-whole/`, {
      method: 'POST',
      body: JSON.stringify({ variant_brief: variant_brief || '' }),
    }),

  // ─── v3.2 — Nhóm C: Generate variant + Export xlsx ───────────────────────
  generateVariant: (id: number, payload: {
    brief?: string
    variant_prompt?: string
    duration_target_seconds?: number
    shot_count_target?: number
    genre?: import('./types').ScenarioGenre
  }) =>
    req<import('./types').ScenarioGenerateResponse>(
      `/content-scenarios/${id}/generate-variant/`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  // ─── v3.2.1 Phase 4 — Human Approval lifecycle ──────────────────────────
  listApprovals: (id: number, status?: import('./types').ApprovalStatus) =>
    req<import('./types').PendingApprovalRow[]>(
      withQuery(`/content-scenarios/${id}/approvals/`, status ? { status } : undefined),
    ),

  resolveApproval: (id: number, approval_id: number, action: 'approve' | 'reject') =>
    req<import('./types').ResolveApprovalResponse>(
      `/content-scenarios/${id}/approvals/${approval_id}/resolve/`,
      { method: 'POST', body: JSON.stringify({ action }) },
    ),

  resolveProposal: (id: number, messageId: number, key: string, status: 'applied' | 'rejected') =>
    req<{ message_id: number; resolved_actions: Record<string, { status: 'applied' | 'rejected'; at: string }> }>(
      `/content-scenarios/${id}/chat-messages/${messageId}/resolve/`,
      { method: 'POST', body: JSON.stringify({ key, status }) }
    ),

  // ─── v3.2.1 Phase 5 — Shot rollback từ audit history ───────────────────
  shotHistory: (id: number, shot_id?: number, limit = 50) =>
    req<import('./types').ScenarioHistoryEntry[]>(
      withQuery(`/content-scenarios/${id}/history/`,
        { ...(shot_id !== undefined ? { shot_id } : {}), limit }),
    ),

  restoreFromAudit: (id: number, audit_id: number) =>
    req<import('./types').ScenarioShot>(
      `/content-scenarios/${id}/restore-from-audit/`,
      { method: 'POST', body: JSON.stringify({ audit_id }) },
    ),

  // ─── v3.2.1 Phase 3 — SSE streaming chat ────────────────────────────────
  /**
   * Stream chat refine qua Server-Sent Events. Caller cung cấp onEvent callback
   * sẽ được gọi cho mỗi event {event_name, data}. Trả về AbortController để caller
   * có thể cancel stream giữa chừng.
   *
   * Tại sao dùng fetch + ReadableStream thay vì native EventSource? EventSource
   * KHÔNG support custom headers → phải header JWT qua Authorization → cần fetch.
   */
  streamChat: (
    id: number,
    payload: { body: string; target_shots?: number[]; target_character?: string; request_id?: string },
    onEvent: (event: string, data: any) => void,
  ): { promise: Promise<void>; abort: () => void } => {
    const controller = new AbortController()
    const promise = (async () => {
      const token = getAccessToken()
      const res = await fetch(`${BASE}/api/content-scenarios/${id}/script-chat-stream/`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw createApiError(res.status, res.statusText, text)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Parse SSE events: separator '\n\n'
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''  // last (potentially incomplete) chunk
        for (const evt of events) {
          if (!evt.trim()) continue
          // Lines: 'event: <name>' và 'data: <json>'
          const eventMatch = evt.match(/^event:\s*(.+)$/m)
          const dataMatch = evt.match(/^data:\s*(.+)$/m)
          if (eventMatch && dataMatch) {
            try {
              onEvent(eventMatch[1].trim(), JSON.parse(dataMatch[1]))
            } catch (e) {
              console.warn('[streamChat] bad SSE event:', evt, e)
            }
          }
        }
      }
    })()
    return { promise, abort: () => controller.abort() }
  },

  /** Export scenario sang .xlsx. Trả về URL blob để trigger download. */
  exportXlsx: async (id: number): Promise<{ blob: Blob; filename: string }> => {
    const token = getAccessToken()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    // BUG FIX v3.2.1: `?format=xlsx` collide với DRF content negotiation → 404.
    // Dùng `?as=xlsx` để né.
    const res = await fetch(`${BASE}/api/content-scenarios/${id}/export/?as=xlsx`, { headers })
    if (!res.ok) {
      const raw = await res.text().catch(() => res.statusText)
      throw new Error(raw || res.statusText)
    }
    const blob = await res.blob()
    // Parse Content-Disposition filename
    const cd = res.headers.get('Content-Disposition') || ''
    const match = cd.match(/filename="?([^";]+)"?/i)
    const filename = match?.[1] || `scenario-${id}.xlsx`
    return { blob, filename }
  },
}

// ─── Chatbot TikTok Inbox (Phase 2.3) ────────────────────────────────────────
// Backend endpoints xem mobile-control/tiktok/inbox_views.py + urls.py.
// Types `Tiktok*Inbox*` import ở top của file.

export const tiktokInboxApi = {
  /** GET /api/tiktok-conversations/?device_id=X[&limit=200] */
  listConversations: (deviceId: number, limit?: number): Promise<TiktokConversationListResponse> =>
    req(withQuery('/tiktok-conversations/', { device_id: deviceId, limit })),

  /** GET /api/tiktok-conversations/detail/?device_id=X&peer_handle=Y */
  getConversationDetail: (deviceId: number, peerHandle: string): Promise<TiktokConversationDetail> =>
    req(withQuery('/tiktok-conversations/detail/', {
      device_id: deviceId, peer_handle: peerHandle,
    })),

  /** GET /api/tiktok-conversations/messages/?device_id=X&peer_handle=Y&limit=50&before=<id> */
  listMessages: (deviceId: number, peerHandle: string, opts?: {
    limit?: number; before?: number | null;
  }): Promise<TiktokMessagesPage> =>
    req(withQuery('/tiktok-conversations/messages/', {
      device_id: deviceId,
      peer_handle: peerHandle,
      limit: opts?.limit,
      before: opts?.before ?? undefined,
    })),

  /** GET /api/tiktok-peer-mute/?device_id=X[&is_active=true] */
  listPeerMutes: (deviceId: number, onlyActive?: boolean): Promise<TiktokPeerMute[]> =>
    req(withQuery('/tiktok-peer-mute/', {
      device_id: deviceId,
      is_active: onlyActive ? 'true' : undefined,
    })),

  /** POST /api/tiktok-peer-mute/ */
  createPeerMute: (payload: TiktokPeerMuteCreate): Promise<TiktokPeerMute> =>
    req('/tiktok-peer-mute/', { method: 'POST', body: JSON.stringify(payload) }),

  /** PATCH /api/tiktok-peer-mute/{id}/ */
  updatePeerMute: (id: number, patch: Partial<TiktokPeerMuteCreate>): Promise<TiktokPeerMute> =>
    req(`/tiktok-peer-mute/${id}/`, { method: 'PATCH', body: JSON.stringify(patch) }),

  /** DELETE /api/tiktok-peer-mute/{id}/ */
  deletePeerMute: (id: number): Promise<void> =>
    req(`/tiktok-peer-mute/${id}/`, { method: 'DELETE' }),
}

// ── WebSites (WordPress publishing) ──────────────────────────────────────────
export const websitesApi = {
  list: () => req<import('./types').Website[]>('/websites/'),
  get: (id: number) => req<import('./types').Website>(`/websites/${id}/`),
  create: (data: import('./types').WebsiteCreate) =>
    req<import('./types').Website>('/websites/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').WebsiteCreate>) =>
    req<import('./types').Website>(`/websites/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/websites/${id}/`, { method: 'DELETE' }),
  testConnection: (id: number) =>
    req<{ detail: string; wp_user: string }>(`/websites/${id}/test-connection/`, { method: 'POST' }),
  taxonomies: (id: number) =>
    req<{ categories: import('./types').WebsiteTerm[]; tags: import('./types').WebsiteTerm[] }>(`/websites/${id}/taxonomies/`),
  listMedia: (id: number, search?: string) =>
    req<{ media: import('./types').WebsiteMedia[] }>(`/websites/${id}/media/${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  uploadMedia: (id: number, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return reqForm<{ id: number; source_url: string }>(`/websites/${id}/upload-media/`, fd)
  },
}

export const websitePostsApi = {
  list: (websiteId?: number, statusFilter?: string) => {
    const qs = new URLSearchParams()
    if (websiteId != null) qs.set('website', String(websiteId))
    if (statusFilter) qs.set('status', statusFilter)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return req<import('./types').WebsitePost[]>(`/website-posts/${suffix}`)
  },
  create: (data: import('./types').WebsitePostCreate) =>
    req<import('./types').WebsitePost>('/website-posts/', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<import('./types').WebsitePostCreate>) =>
    req<import('./types').WebsitePost>(`/website-posts/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => req<void>(`/website-posts/${id}/`, { method: 'DELETE' }),
  publishNow: (id: number) =>
    req<import('./types').WebsitePost>(`/website-posts/${id}/publish-now/`, { method: 'POST' }),
  import: (data: { website: number; sheet_url?: string; wp_status?: string; use_ai?: boolean; posts?: Array<{ title: string; content?: string; thumbnail?: string; body_image?: string; scheduled_at?: string | null; wp_status?: string }> }) =>
    req<{ created: number; skipped: number; errors?: Array<{ row: number; error: string }> }>(`/website-posts/import/`, { method: 'POST', body: JSON.stringify(data) }),
  aiGenerate: (data: { website: number; topic: string; count?: number; wp_status?: string }) =>
    req<{ created: number }>(`/website-posts/ai-generate/`, { method: 'POST', body: JSON.stringify(data) }),
  regenerate: (id: number, data?: { topic?: string; brief?: string; keep_images?: boolean }) =>
    req<import('./types').WebsitePost>(`/website-posts/${id}/regenerate/`, { method: 'POST', body: JSON.stringify(data || {}) }),
}
