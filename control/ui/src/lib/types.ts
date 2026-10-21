export type TaskStatus = 'pending_approval' | 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type TaskType = 'generic'
export type ScheduleType = 'interval' | 'cron' | 'once'
export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'failed'
export type ExecutionStatus = 'success' | 'failure' | 'retry'
export type TeamRole = 'owner' | 'admin' | 'member'
export type TeamPermission = 'view' | 'edit'

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: number
  username: string
  email: string
  first_name: string
  last_name: string
  display_name: string
  avatar_url: string
}

export interface AuthTokens {
  access: string
  refresh: string
}

export interface LoginResponse {
  user: AuthUser
  access: string
  refresh: string
}

// ─── Teams ───────────────────────────────────────────────────────────────────

export interface TeamMember {
  id: number
  user_id: number
  username: string
  email: string
  display_name: string
  role: TeamRole
  joined_at: string
}

export interface Team {
  id: number
  name: string
  description: string
  created_by: number | null
  member_count: number
  my_role: TeamRole | null
  created_at: string
  updated_at: string
}

export interface TeamDetail extends Team {
  members: TeamMember[]
}

export interface TeamCreate {
  name: string
  description?: string
}

// ─── Shared resource fields ───────────────────────────────────────────────────

export interface OwnedResource {
  owner_id: number | null
  team_id: number | null
  team_name: string | null
  team_permission: TeamPermission
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export interface Task extends OwnedResource {
  id: number
  name: string
  description: string
  task_type: TaskType
  status: TaskStatus
  payload: Record<string, unknown>
  result: TaskEvent[]
  device_id?: number | null
  device_serial?: string
  llm_model?: string
  steps?: number
  finished_at?: string
  created_at: string
}

export interface TaskEvent {
  task_id: number
  device_serial_id?: string
  content: string
  status: string
  payload?: Record<string, unknown>
}

export interface TaskCreate {
  name: string
  description: string
  task_type: TaskType
  status: TaskStatus
  payload: Record<string, unknown>
}

export interface Schedule {
  id: number
  task: Task
  profile: number | null
  profile_name?: string | null
  schedule_type: ScheduleType
  status: ScheduleStatus
  run_at?: string
  interval_seconds?: number
  cron_expression?: string
  max_retries: number
  retry_count: number
  retry_delay_seconds: number
  next_run_at?: string
  last_run_at?: string
  created_at: string
}

export interface ScheduleCreate {
  task: number
  profile?: number | null
  schedule_type: ScheduleType
  max_retries: number
  retry_delay_seconds: number
  run_at?: string
  interval_seconds?: number | null
  cron_expression?: string
}

export interface ScheduleExecution {
  id: number
  schedule: number
  started_at: string
  finished_at?: string
  result_status: ExecutionStatus
  error_message?: string
}

export type DeviceType = 'personal' | 'emulator' | 'agent' | 'mobilerun'
export type DeviceStatus = 'online' | 'offline' | 'connected'

export interface DeviceActiveSession {
  id: number
  user_id: number
  username: string
  display_name: string
  claimed_at: string
}

export interface ConnectedDevice {
  serial: string
  identifier: string
}

export interface ConnectedDevicesResponse {
  devices: ConnectedDevice[]
}

export interface DeviceProfile {
  id: number
  name: string
}

export interface Device extends OwnedResource {
  id: number
  name: string
  device_type: DeviceType
  status: DeviceStatus
  /** Set by the socket/ADB worker. Not populated from the add-device form. */
  identifier: string
  /** Hardware serial entered via the add-device form. Used for availability checks. */
  device_serial_id: string
  screen_width: number | null
  screen_height: number | null
  hardware_info: Record<string, unknown>
  active_session: DeviceActiveSession | null
  available: boolean
  profiles: DeviceProfile[]
  worker_id: string | null
  /** TCS-v2 Sprint 2 (#2): soft-delete flag. False = đã xóa (filtered khỏi list mặc định). */
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface DeviceCreate {
  name: string
  device_type: DeviceType
  status: DeviceStatus
  device_serial_id: string
  identifier?: string
}

export interface Credential extends OwnedResource {
  id: number
  app_name: string
  username: string
  notes: string
  created_at: string
  updated_at: string
}

export interface CredentialCreate {
  app_name: string
  username: string
  password: string
  notes: string
}

export type AppPlatform = 'android' | 'ios'

export interface MobileApp extends OwnedResource {
  id: number
  name: string
  package_name: string
  platform: AppPlatform
  apk_file_url: string | null
  version: string
  description: string
  created_at: string
  updated_at: string
}

export interface ProfileFile {
  id: number
  name: string
  file_url: string | null
  created_at: string
}

export interface ProfileMemory {
  id: number
  key: string
  value: string
  tags: string[]
  updated_at: string
}

export interface ProfileRoutine {
  id: number
  schedule_time: string
  action: string
  cron_expression: string
  created_at: string
  updated_at: string
}

export interface Profile extends OwnedResource {
  id: number
  name: string
  goal: string
  topic: string
  topics: string[]
  topic_history: Array<{ topic: string; updated_at?: string }>
  topic_audit_logs: Array<{
    action: string
    actor_id?: number | null
    created_at?: string
    updated_at?: string
    topic?: string
    topics?: string[]
    generated_topics?: string[]
    metadata?: Record<string, unknown>
  }>
  personality: string
  website_url: string
  proxy_host: string
  proxy_port: number | null
  proxy_username: string
  proxy_password: string
  device: number | null
  device_detail: Device | null
  apps: number[]
  apps_detail: MobileApp[]
  credentials: number[]
  credentials_detail: Credential[]
  files: ProfileFile[]
  routines: ProfileRoutine[]
  created_at: string
  updated_at: string
}

export interface ProfileCreate {
  name: string
  goal?: string
  topic?: string
  topics?: string[]
  personality?: string
  website_url?: string
  proxy_host?: string
  proxy_port?: number | null
  proxy_username?: string
  proxy_password?: string
  device?: number | null
  apps?: number[]
  credentials?: number[]
}

// Install/uninstall lifecycle of one app on a profile's device.
export type AppInstallStatus =
  | 'pending'
  | 'installing'
  | 'installed'
  | 'uninstall_pending'
  | 'uninstalling'
  | 'uninstalled'
  | 'failed'

export interface ProfileAppInstallation {
  id: number
  profile: number
  app: number
  app_detail: MobileApp
  device: number | null
  status: AppInstallStatus
  command_id: string
  error_message: string
  requested_by_id: number | null
  created_at: string
  updated_at: string
}

export interface ProfileContentItem {
  id: number
  title: string
  source_url: string
  video_url: string
  description: string
  tags: string[]
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

// ─── Agent Groups ─────────────────────────────────────────────────────────────

export type AgentGroupMemberRole = 'leader' | 'worker' | 'observer'

export interface AgentGroupMember {
  id: number
  device: number
  device_name: string
  device_status: string
  device_type: string
  device_identifier: string
  device_serial_id: string
  device_worker_id: string | null
  device_profile_name: string
  role: AgentGroupMemberRole
  added_at: string
}

export interface AgentGroup extends OwnedResource {
  id: number
  name: string
  description: string
  system_prompt: string
  goal: string
  members: AgentGroupMember[]
  member_count: number
  created_at: string
  updated_at: string
}

export interface AgentGroupCreate {
  name: string
  description?: string
  system_prompt?: string
  goal?: string
}

export interface AgentGroupMemberCreate {
  device: number
  role: AgentGroupMemberRole
}

// ─── Agent Group Shared Resources ────────────────────────────────────────────

export interface AgentGroupSharedMemory {
  id: number
  key: string
  value: string
  updated_at: string
}

export interface AgentGroupSharedFile {
  id: number
  name: string
  file_url: string | null
  uploaded_at: string
}

export interface AgentGroupSharedState {
  id: number
  key: string
  value: unknown
  updated_at: string
}

// ─── Proxies ─────────────────────────────────────────────────────────────────

export type ProxyProtocol = 'socks5' | 'http'

export interface Proxy {
  id: number
  name: string
  protocol: ProxyProtocol
  host: string
  port: number | null
  username: string
  password: string
  created_at: string
  updated_at: string
}

export interface ProxyCreate {
  name: string
  protocol: ProxyProtocol
  host: string
  port?: number | null
  username?: string
  password?: string
}

// ─── API Keys ─────────────────────────────────────────────────────────────────

export interface ApiKey {
  id: number
  name: string
  key_prefix: string
  /** Populated only on creation response; null on subsequent fetches */
  full_key: string | null
  owner_id: number | null
  is_active: boolean
  last_used_at: string | null
  created_at: string
}

export interface ApiKeyCreate {
  name: string
}

// ─── FB Hack (hacklike17) keys + reaction boost ───────────────────────────────
export interface FbHackKey {
  id: number
  name: string
  key_masked: string
  is_active: boolean
  last_used_at: string | null
  created_at: string
  updated_at: string
}

export interface FbHackKeyCreate {
  name: string
  token: string
}

export interface FbHackLikeParams {
  hack_key: number
  url: string
  count: number
  reactions: string[]
  speed: string | number
  uid?: string
  server?: string
  speed_server_2?: string
  note?: string
  /** Link the buff to a scheduled post so the backend records how much it was buffed. */
  scheduled_post_id?: number
  scheduled_post_kind?: 'profile' | 'page'
}

export interface FbHackLikeResponse {
  status: number
  msg: string
  order_id?: number
  original?: number
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export interface Webhook {
  id: number
  name: string
  url: string
  events: string[]
  is_active: boolean
  owner_id: number | null
  created_at: string
  updated_at: string
}

export interface WebhookCreate {
  name: string
  url: string
  secret?: string
  events?: string[]
  is_active?: boolean
}

// ─── Content ───────────────────────────────────────────────────────────────────

// Where a Content record originated.
//   'manual'    — typed in via the "Nội dung mới" form.
//   'generated' — produced by the "Gen Content" AI flow (carries kb_name /
//                 od_number / parent_scenario_filename / frames).
export type ContentSourceType = 'manual' | 'generated'

// One frame inside a generated script. Keys mirror the n8n payload (kept
// in Vietnamese on purpose — they round-trip back to operators in that form).
export interface GeneratedScriptFrame {
  Frame?: number
  Phần?: string
  Voice?: string
  Text?: string
  Visual?: string
  Music?: string
  Footage?: string
  Source?: string
  Time?: string
  Note?: string
  [key: string]: unknown
}

// Gen mode flag — drives the edit-lock on Footage/Time/Note in
// ContentDetailPage and is enforced server-side by /update-frame.
export type ContentMode = 'real_footage' | 'ai_video'

export interface CharacterMedia {
  url: string
  created_at: string
}

/** Output sizes gpt-image accepts. '1024x1536' is the tallest frame available —
 *  a brief asking for "9:16" gets this (2:3); the model has no true 9:16. */
export type OpenAIImageSize = '1024x1024' | '1024x1536' | '1536x1024'

export type OpenAIImageQuality = 'low' | 'medium' | 'high'

/** Which model renders an image. 'openai' = the gpt-image path (default, unchanged);
 *  'seedream45' / 'grok' route to fal.ai. Used by the "Tạo ảnh nhanh" flow. */
export type ImageProvider = 'openai' | 'seedream45' | 'grok'

/** The blocks of a photoshoot brief that stay CONSTANT for a character. */
export interface CharacterBlocks {
  subject: string
  hair: string
  nails: string
  face_makeup: string
}

export interface Character extends OwnedResource {
  id: number
  name: string
  source_image_url: string
  /** Legacy single-blob description. Characters created before the block split
   *  have only this; the four block fields below are empty for them. */
  face_prompt: string
  nation: string
  subject: string
  hair: string
  nails: string
  face_makeup: string
  media: CharacterMedia[]
  media_count: number
  scenes: CharacterMedia[]
  scenes_count: number
  videos: CharacterMedia[]
  videos_count: number
  created_at: string
  updated_at: string
}

export interface CharacterScheduledPost {
  id: number
  character: number
  character_name: string
  platform: 'tiktok' | 'facebook_profile' | 'facebook_page' | 'facebook_group'
  image_urls: string[]
  caption: string
  hashtags: string[]
  device: number | null
  device_name: string | null
  profile: number | null
  profile_name: string | null
  fb_profile: number | null
  fb_profile_name: string | null
  fb_page: number | null
  fb_page_name: string | null
  fb_group: number | null
  fb_group_name: string | null
  scheduled_at: string
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'cancelled'
  error_msg: string
  task: number | null
  owner_id: number
  created_at: string
  updated_at: string
}

export interface ContentItem extends OwnedResource {
  id: number
  title: string
  video_url: string
  image_urls: string[] | null
  text_content: string | null
  file_url: string | null
  script: string
  source_type: ContentSourceType
  kb_name: string
  od_number: string
  parent_scenario_filename: string
  frames: GeneratedScriptFrame[]
  // Snapshot of frames at generation time; restored by the "Khôi phục bản
  // gốc" button. Read-only from the FE (only save_generated writes it).
  origin_frames: GeneratedScriptFrame[]
  mode: ContentMode
  created_at: string
  updated_at: string
}

// A single candidate frame patch the AI proposed via the
// `apply_frame_patch` tool. `before` is the snapshot of the AI-editable
// fields at chat time; `after` is the refined version. Apply replaces
// fields on Content.frames[frame_index-1] (post-save) or on
// generatedScripts[i].frames[frame_index-1] (preview).
export interface FramePatch {
  frame_index: number
  before: { Voice?: string; Text?: string; Visual?: string; Music?: string }
  after:  { Voice?: string; Text?: string; Visual?: string; Music?: string }
}

// One turn in the per-Content AI-refine chat thread. ASSISTANT turns may
// carry `attached_patches`: when non-empty, the FE renders a Apply/Discard
// card inline in the bubble (Phase 5 — replaces the standalone refine modal).
export interface ScriptChatMessage {
  id: number
  content: number
  owner: number
  sender: 'USER' | 'ASSISTANT'
  body: string
  frame_target: number | null
  llm_model: string
  attached_patches: FramePatch[]
  created_at: string
}

// 4 reviewer focuses the user can pick in the RefineModal.
export type ReviewerFocus = 'style' | 'brand' | 'content' | 'structure'

// Body for PATCH /update-frame/. op='update' carries `fields`;
// op='restore_frame' just needs the index; op='restore_all' is whole-KB.
export interface UpdateFramePayload {
  op?: 'update' | 'restore_frame' | 'restore_all'
  frame_index?: number
  fields?: Partial<GeneratedScriptFrame>
}

export interface ContentItemCreate {
  title: string
  video_url?: string
  image_urls?: string[] | null
  text_content?: string | null
  file_url?: string | null
  script?: string
}

export interface FeatureSystemPrompt {
  id: number
  feature_id: string
  system_prompt: string
  user_id: number | null
  is_default: boolean
  used_default?: boolean
  created_at: string
  updated_at: string
}

export interface RepostAiRewriteRequest {
  feature_id?: string
  mode: 'rewrite' | 'create'
  source_text: string
  instruction?: string
}

export interface RepostAiRewriteResponse {
  feature_id: string
  mode: 'rewrite' | 'create'
  content: string
  used_default_prompt: boolean
}

// One script returned by POST /api/contents/generate-scripts/.
export interface GeneratedScript {
  kb_name: string
  od_number: string
  frames: GeneratedScriptFrame[]
}

// Whole response body of POST /api/contents/generate-scripts/. The backend
// also echoes the uploaded filename so the FE can pass it back to save-generated.
export interface GenerateScriptsResponse {
  scripts: GeneratedScript[]
  total: number
  status: string
  parent_scenario_filename?: string
}

export type CrawlSourceType = 'web' | 'facebook' | 'tiktok' | 'youtube' | 'threads'
export type CrawlRunStatus = 'running' | 'success' | 'failed'

export interface CrawlSource extends OwnedResource {
  id: number
  url: string
  source_type: CrawlSourceType
  device_id: number | null
  device_name: string | null
  crawl_frequency_minutes: number
  is_active: boolean
  snapshot_count: number
  run_count: number
  successful_run_count: number
  failed_run_count: number
  latest_run_id: number | null
  latest_run_status: CrawlRunStatus | null
  latest_run_started_at: string | null
  latest_run_finished_at: string | null
  latest_run_item_count: number
  last_success_at: string | null
  last_failure_at: string | null
  created_at: string
  updated_at: string
}

export interface CrawlSourceCreate {
  url: string
  source_type: CrawlSourceType
  device_id?: number | null
  crawl_frequency_minutes: number
  is_active?: boolean
}

export interface CrawlRun {
  id: number
  crawl_source_id: number | null
  source_url: string
  status: CrawlRunStatus
  started_at: string
  finished_at: string | null
  duration_seconds: number | null
  item_count: number
  new_item_count: number
  updated_item_count: number
  triggered_by: string
  error_message: string
  summary: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface CrawlContentSnapshot {
  id: number
  crawl_source_id: number | null
  content_id: number | null
  latest_run_id: number | null
  source_index_url: string
  content_url: string
  content_type: string
  title: string
  summary: string
  content_body: string
  payload: Record<string, unknown>
  media_file_urls: string[]
  media_count: number
  checksum: string
  version: string
  first_crawled_at: string
  crawled_at: string
  last_updated_at: string
  created_at: string
  updated_at: string
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}

// ─── Device Notifications ─────────────────────────────────────────────────────

export interface DeviceNotification {
  id: number
  device_id: number | null
  identifier: string
  package: string
  title: string
  text: string
  notification_id: number | null
  tag: string
  is_ongoing: boolean
  post_time: number | null
  key: string
  event_timestamp: string | null
  raw_data: Record<string, unknown>
  received_at: string
}

// ─── TikTok ──────────────────────────────────────────────────────────────────

export type TiktokVideoStatus = 'pending' | 'liked' | 'commented' | 'shared' | 'reposted'

export interface TiktokVideo {
  id: number
  keywords: string[]
  video_url: string
  caption: string | null
  content: string
  status: TiktokVideoStatus
  video_process_task_id: string | null
  owner_id: number | null
  team_id: number | null
  existing_comments?: string[]
  created_at: string
  updated_at: string
}

export interface TiktokVideoCreate {
  keywords: string[]
  video_url?: string
  caption?: string | null
  content?: string
  status?: TiktokVideoStatus
  team_id?: number | null
}

export interface TiktokDispatchCommentsRequest {
  video_url: string
  content: string
  keywords: string[]
  agent_group: number
  devices: number[]
}

export interface TiktokDispatchCommentsResponse {
  detail: string
  payload: TiktokDispatchCommentsRequest
  comment_plans: TiktokCommentPlan[]
}

export interface TiktokChannelResearchVideo {
  id: number
  url: string
  title: string
  description: string
  hashtags: string[]
  duration: number
  view_count: number
  like_count: number
  comment_count: number
  share_count: number
  published_at: string | null
  video_process_task_id: string | null
  analyzed_content: string
  is_understand_video?: boolean
  understand_text_overlay?: string
  understand_content_text?: string
  understand_background_description?: string
  understand_style_analysis?: string
  understand_video_style?: string
  music_path?: string
  understand_video_analysis?: {
    main_story?: string
    emotional_tone?: string
    key_value?: string
    audience_insight?: string
  } | null
}

export interface TiktokChannelResearchResponse {
  channel_url: string
  count: number
  videos: TiktokChannelResearchVideo[]
  last_crawled_at: string | null
  cache_hit: boolean
}

export interface TiktokChannelKeywordExtractionResponse {
  channel_url: string
  count: number
  keywords: string[]
}

export type TeamPermissionValue = 'view' | 'edit'

export type TiktokInteractionType = 'like' | 'comment'

export interface TiktokVideoInteraction {
  id: number
  interaction_type: TiktokInteractionType
  profile_username: string
  profile_avatar_url: string
  comment_content: string
  interacted_at: string | null
  created_at: string
}

export interface TiktokCommentedInteraction {
  id: number
  comment_plan_id: number | null
  video_id: number
  video_url: string
  video_link: string
  comment_content: string
  comment_link: string
  profile: number | null
  profile_name: string | null
  device: number | null
  device_name: string | null
  interacted_at: string | null
  replay_task_dispatched: boolean
  dig_comment_dispatched: boolean
  created_at: string
}

export interface TiktokVideoUserComment {
  id: number
  cid: string
  user_id: string
  nickname: string
  text: string
  create_time: string | null
  parent_cid: string
  comment_link: string | null
}

export interface TiktokFetchCommentsResponse {
  saved: number
  total: number
  comments: TiktokVideoUserComment[]
}

export interface TiktokCommentClusterPoint {
  cid?: string
  text: string
  normalized_text?: string
  x: number | null
  y: number | null
  cluster: number | null
}

export interface TiktokCommentClusterResponse {
  video_id: number
  source_comments: number
  count: number
  model: string
  n_clusters: number
  points: TiktokCommentClusterPoint[]
  cluster_labels?: Record<string, string>
}

export interface TiktokDigCommentResponse {
  matched: boolean
  comment_link: string | null
  similarity: number
  interaction_id: number
  comment_plan_id: number | null
  updated_plan?: boolean
  detail?: string
}

export interface TiktokVideoInteractionCreate {
  interaction_type: TiktokInteractionType
  profile_username?: string
  profile_avatar_url?: string
  comment_content?: string
  interacted_at?: string | null
}

export type TiktokCommentPlanSender = 'user' | 'assistant'

export interface TiktokCommentPlan {
  id: number
  video: number
  video_link: string
  agent_group: number | null
  agent_group_name: string | null
  profile: number | null
  profile_name: string | null
  device: number | null
  device_name: string | null
  comment_content: string
  comment_link: string
  reply_to: string
  is_approved: boolean
  is_commented: boolean
  execution_status: 'idle' | 'scheduled' | 'running' | 'completed' | 'failed'
  execution_retry_count: number
  execution_last_error: string
  created_at: string
  updated_at: string
}

export interface TiktokCommentPlanCreate {
  video_link?: string
  agent_group?: number | null
  profile?: number | null
  device?: number | null
  comment_content: string
  comment_link?: string
  reply_to?: string
  is_approved?: boolean
  is_commented?: boolean
}

export interface TiktokCommentPlanExecuteClusterResponse {
  detail: string
  root_plan_id: number
  scheduled_plan_id: number | null
  task_id: number | null
}

export interface TiktokCommentPlanChatMessage {
  id: number
  video: number
  agent_group: number | null
  agent_group_name: string | null
  sender: TiktokCommentPlanSender
  content: string
  created_at: string
}

export interface TiktokCommentPlanChatMessageCreate {
  agent_group?: number | null
  sender?: TiktokCommentPlanSender
  content: string
}

export interface KeywordList {
  id: number
  name: string
  topic: string
  keywords: string[]
  dispatched_keywords: string[]
  saved_keywords: string[]
  owner_id: number | null
  team_id: number | null
  team_name: string | null
  team_permission: TeamPermissionValue
  created_at: string
  updated_at: string
}

export interface KeywordListCreate {
  name: string
  topic: string
  keywords: string[]
}

export interface KeywordGenerateRequest {
  topic: string
  count: number
  existing_keywords?: string[]
}

export interface KeywordGenerateResponse {
  keywords: string[]
}

export interface KeywordSearchVideoAuthor {
  uid?: string
  unique_id?: string
  nickname?: string
  sec_uid?: string
}

export interface KeywordSearchVideo {
  video_id: string
  desc: string
  create_time: number | null
  author: KeywordSearchVideoAuthor
  stats: Record<string, string>
  video_url: string
  is_existing: boolean
}

export interface KeywordSearchVideosResponse {
  keyword: string
  count: number
  partial: boolean
  videos: KeywordSearchVideo[]
}

export interface KeywordSaveSearchVideosResponse {
  keyword: string
  list_id: number
  saved: number
  existing: number
  total: number
  video_ids: number[]
}

// ─── Facebook ────────────────────────────────────────────────────────────────

export type FacebookPageStatus = 'active' | 'paused' | 'archived'

export interface FacebookPage {
  id: number
  name: string
  page_url: string
  page_uid: string
  page_token: string
  category: string
  description: string
  follower_count: number
  status: FacebookPageStatus
  owner_id: number | null
  team_id: number | null
  created_at: string
  updated_at: string
}

export interface FacebookPageCreate {
  name: string
  page_url?: string
  page_uid?: string
  page_token?: string
  category?: string
  description?: string
  follower_count?: number
  status?: FacebookPageStatus
  team_id?: number | null
}

export type FacebookGroupStatus = 'active' | 'paused' | 'archived'

export interface FacebookGroup {
  id: number
  name: string
  group_url: string
  group_uid: string
  group_token: string
  description: string
  member_count: number
  admin_profile: number | null
  admin_profile_name: string | null
  admin_fb_profile: number | null
  admin_fb_profile_name: string | null
  default_poster_fb_profile: number | null
  default_poster_fb_profile_name: string | null
  status: FacebookGroupStatus
  owner_id: number | null
  team_id: number | null
  created_at: string
  updated_at: string
}

export interface FacebookGroupCreate {
  name: string
  group_url?: string
  group_uid?: string
  group_token?: string
  description?: string
  member_count?: number
  admin_profile?: number | null
  admin_fb_profile?: number | null
  default_poster_fb_profile?: number | null
  status?: FacebookGroupStatus
  team_id?: number | null
}

export interface FacebookGroupPost {
  id: number
  group: number
  group_name: string
  post_url: string
  image_url: string
  image_urls: string[]
  caption: string | null
  content: string
  keywords: string[]
  status: FacebookPostStatus
  owner_id: number | null
  created_at: string
  updated_at: string
}

export interface FacebookGroupPostCreate {
  group: number
  post_url?: string
  image_url?: string
  image_urls?: string[]
  caption?: string | null
  content?: string
  keywords?: string[]
  status?: FacebookPostStatus
}

export type FacebookGroupPendingMemberPostStatus =
  | 'queued'
  | 'processing'
  | 'approved'
  | 'rejected'
  | 'failed'

export type FacebookGroupPendingTab = 'approval' | 'maybe_spam'

export type FacebookSeedingInteractionType = 'like' | 'comment' | 'reply'

export type FacebookSeedingActionStatus =
  | 'pending'
  | 'dispatched'
  | 'done'
  | 'failed'

interface FacebookSeedingActionBase {
  id: number
  post: number
  actor_fb_profile: number | null
  actor_fb_profile_name: string | null
  interaction_type: FacebookSeedingInteractionType
  comment_content: string
  reply_target_username: string
  reply_target_snippet: string
  ai_prompt: string
  status: FacebookSeedingActionStatus
  fb_comment_id: string
  error_msg: string
  task: number | null
  created_at: string
  updated_at: string
}

export type FacebookProfilePostSeedingAction = FacebookSeedingActionBase
export type FacebookGroupPostSeedingAction = FacebookSeedingActionBase

export interface FacebookGroupPendingMemberPost {
  id: number
  group: number
  group_name: string
  post_fb_id: string
  post_url: string
  author_name: string
  author_uid: string
  content: string
  image_urls: string[]
  posted_at: string | null
  status: FacebookGroupPendingMemberPostStatus
  pending_tab: FacebookGroupPendingTab
  error_msg: string
  owner_id: number | null
  created_at: string
  updated_at: string
}

export interface FacebookGroupScheduledPost {
  id: number
  group: number
  group_name: string
  content: string
  image_urls: string[]
  image_description: string
  topic: string
  scheduled_at: string
  status: FacebookScheduledPostStatus
  is_approved: boolean
  poster_fb_profile: number | null
  poster_fb_profile_name: string | null
  fb_post_id: string
  error_msg: string
  owner_id: number | null
  created_at: string
  updated_at: string
}

export interface FacebookGroupScheduledPostCreate {
  group: number
  content: string
  image_urls?: string[]
  image_description?: string
  topic?: string
  scheduled_at: string
  status?: FacebookScheduledPostStatus
  poster_fb_profile?: number | null
}

export interface FacebookCompetitorPost {
  post_url: string
  content: string
  image_url: string
  posted_at: string | null
  reactions_count: number
  comments_count: number
  shares_count: number
  engagement_total: number
}

export interface FacebookCompetitorAnalysis {
  count: number
  posts: FacebookCompetitorPost[]
}

export type FacebookProfileStatus = 'active' | 'paused' | 'archived'

export interface FacebookProfile {
  id: number
  name: string
  profile_url: string
  profile_uid: string
  profile_token: string
  description: string
  friend_count: number
  status: FacebookProfileStatus
  owner_id: number | null
  team_id: number | null
  // Phoneagent publish target
  device: number | null
  device_serial: string
  device_name: string
  account_name: string
  created_at: string
  updated_at: string
}

export interface FacebookProfileCreate {
  name: string
  profile_url?: string
  profile_uid?: string
  profile_token?: string
  description?: string
  friend_count?: number
  status?: FacebookProfileStatus
  team_id?: number | null
  device?: number | null
  account_name?: string
}

export interface FacebookProfilePost {
  id: number
  profile: number
  profile_name: string
  post_url: string
  image_url: string
  image_urls: string[]
  caption: string | null
  content: string
  keywords: string[]
  status: FacebookPostStatus
  owner_id: number | null
  created_at: string
  updated_at: string
}

export interface FacebookProfilePostCreate {
  profile: number
  post_url?: string
  image_url?: string
  image_urls?: string[]
  caption?: string | null
  content?: string
  keywords?: string[]
  status?: FacebookPostStatus
}

export interface FacebookProfileScheduledPost {
  id: number
  profile: number
  profile_name: string
  content: string
  image_urls: string[]
  image_description: string
  topic: string
  ai_prompt: string
  ai_rewritten_content: string
  scheduled_at: string
  status: FacebookScheduledPostStatus
  target_group: number | null
  target_group_name: string | null
  is_approved: boolean
  fb_post_id: string
  error_msg: string
  buffed_like_total: number
  buffed_at: string | null
  owner_id: number | null
  created_at: string
  updated_at: string
}

export interface FacebookProfileScheduledPostCreate {
  profile: number
  content: string
  image_urls?: string[]
  image_description?: string
  topic?: string
  ai_prompt?: string
  scheduled_at: string
  status?: FacebookScheduledPostStatus
  target_group?: number | null
}

export type FacebookProfileMediaActionType = 'change_avatar' | 'change_cover' | 'post_story'

export interface FacebookProfileScheduledMediaAction {
  id: number
  profile: number
  profile_name: string
  action_type: FacebookProfileMediaActionType
  image_url: string
  scheduled_at: string
  status: FacebookScheduledPostStatus
  error_msg: string
  owner_id: number | null
  created_at: string
  updated_at: string
}

export type FacebookPostStatus = 'pending' | 'liked' | 'commented' | 'shared'

export interface FacebookPost {
  id: number
  page: number
  page_name: string
  post_url: string
  image_url: string
  image_urls: string[]
  caption: string | null
  content: string
  keywords: string[]
  status: FacebookPostStatus
  owner_id: number | null
  created_at: string
  updated_at: string
}

export interface FacebookPostCreate {
  page: number
  post_url?: string
  image_url?: string
  image_urls?: string[]
  caption?: string | null
  content?: string
  keywords?: string[]
  status?: FacebookPostStatus
}

export type FacebookScheduledPostStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'cancelled'

export interface FacebookScheduledPost {
  id: number
  page: number
  page_name: string
  content: string
  image_urls: string[]
  image_description: string
  topic: string
  scheduled_at: string
  status: FacebookScheduledPostStatus
  fb_post_id: string
  error_msg: string
  buffed_like_total: number
  buffed_at: string | null
  owner_id: number | null
  created_at: string
  updated_at: string
}

export interface FacebookScheduledPostCreate {
  page: number
  content: string
  image_urls?: string[]
  image_description?: string
  topic?: string
  scheduled_at: string
  status?: FacebookScheduledPostStatus
}

export type FacebookInteractionType = 'like' | 'comment' | 'share' | 'reply'

export interface FacebookPostInteraction {
  id: number
  interaction_type: FacebookInteractionType
  profile_username: string
  profile_avatar_url: string
  comment_content: string
  comment_link: string
  interacted_at: string | null
  replay_task_dispatched: boolean
  dig_comment_dispatched: boolean
  created_at: string
}

export interface FacebookPostInteractionCreate {
  interaction_type: FacebookInteractionType
  profile_username?: string
  profile_avatar_url?: string
  comment_content?: string
  comment_link?: string
  interacted_at?: string | null
}

export interface FacebookCommentPlan {
  id: number
  post: number
  post_link: string
  agent_group: number | null
  agent_group_name: string | null
  profile: number | null
  profile_name: string | null
  device: number | null
  device_name: string | null
  comment_content: string
  comment_link: string
  reply_to: string
  is_approved: boolean
  is_commented: boolean
  execution_status: 'idle' | 'scheduled' | 'running' | 'completed' | 'failed'
  execution_retry_count: number
  execution_last_error: string
  created_at: string
  updated_at: string
}

export interface FacebookCommentPlanCreate {
  post_link?: string
  agent_group?: number | null
  profile?: number | null
  device?: number | null
  comment_content: string
  comment_link?: string
  reply_to?: string
  is_approved?: boolean
  is_commented?: boolean
}

// Comment plan on a published scheduled post (TikTok-style flow). The comment is
// posted by the FB account on `device` (actor_fb_profile).
export interface FacebookScheduledCommentPlan {
  id: number
  scheduled_post: number
  post_link: string
  agent_group: number | null
  agent_group_name: string | null
  device: number | null
  device_name: string | null
  actor_fb_profile: number | null
  actor_name: string | null
  comment_content: string
  comment_link: string
  reply_to: string
  is_approved: boolean
  is_commented: boolean
  execution_status: 'idle' | 'scheduled' | 'running' | 'completed' | 'failed'
  execution_retry_count: number
  execution_last_error: string
  created_at: string
  updated_at: string
}

export interface FacebookScheduledDispatchCommentsResponse {
  detail: string
  comment_plans: FacebookScheduledCommentPlan[]
}

export interface FacebookPostUserComment {
  id: number
  cid: string
  user_id: string
  nickname: string
  text: string
  create_time: string | null
  parent_cid: string
  comment_link: string | null
}

export interface FacebookFetchCommentsResponse {
  saved: number
  total: number
  comments: FacebookPostUserComment[]
}

export interface FacebookCommentClusterResponse {
  source_comments: number
  count: number
  model: string
  n_clusters: number
  points: TiktokCommentClusterPoint[]
  cluster_labels?: Record<string, string>
}

export interface FacebookDigCommentResponse {
  matched: boolean
  comment_link: string | null
  similarity: number
  interaction_id: number
  comment_plan_id: number | null
  updated_plan?: boolean
  detail?: string
}

export interface FacebookDispatchCommentsRequest {
  comment_content: string
  agent_group?: number | null
  devices?: number[]
  reply_to?: string
  auto_approve?: boolean
}

export interface FacebookDispatchCommentsResponse {
  detail: string
  comment_plans: FacebookCommentPlan[]
}

export interface FacebookCommentedInteraction {
  id: number
  comment_plan_id: number | null
  post_id: number
  post_url: string
  page_id: number | null
  page_name: string | null
  comment_content: string
  comment_link: string
  profile: number | null
  profile_name: string | null
  device: number | null
  device_name: string | null
  interacted_at: string | null
  replay_task_dispatched: boolean
  dig_comment_dispatched: boolean
  created_at: string
}

// ─── Workflows ───────────────────────────────────────────────────────────────

export type WorkflowStatus = 'active' | 'inactive'
export type TriggerType = 'periodic' | 'event' | 'webhook'
export type PeriodicScheduleType = 'once' | 'interval' | 'cron'
export type EventSourceType = 'device' | 'team' | 'user'
export type WorkflowStepActionType = 'create_task' | 'create_schedule' | 'custom'
export type WorkflowStepInputSourceType = 'trigger'

export interface SystemEventDef {
  name: string
  label: string
  source_type: EventSourceType
}

export interface WorkflowStepTaskConfig {
  name: string
  description: string
  task_type: TaskType
  status: TaskStatus
  payload: Record<string, unknown>
  device_id: number | null
}

export interface WorkflowStepScheduleConfig {
  profile_id: number | null
  schedule_type: ScheduleType
  run_at: string | null
  interval_seconds: number | null
  cron_expression: string
  max_retries: number
  retry_delay_seconds: number
  is_active: boolean
}

export interface WorkflowStepActionConfig {
  task?: WorkflowStepTaskConfig
  schedule?: WorkflowStepScheduleConfig
}

export interface WorkflowStepInputBinding {
  source_type: WorkflowStepInputSourceType
  source_path: string
  target_path: string
}

export interface WorkflowTrigger {
  id: number
  workflow: number
  trigger_type: TriggerType
  is_active: boolean
  periodic_schedule_type: PeriodicScheduleType | ''
  run_at: string | null
  interval_seconds: number | null
  cron_expression: string
  event_name: string
  event_source_type: EventSourceType | ''
  event_source_id: number | null
  event_filter: Record<string, unknown>
  webhook_token: string
  next_run_at: string | null
  last_triggered_at: string | null
  created_at: string
  updated_at: string
}

export interface WorkflowStep {
  id: number
  workflow: number
  name: string
  description: string
  sort_order: number
  action_type: WorkflowStepActionType
  action_config: WorkflowStepActionConfig
  input_bindings: WorkflowStepInputBinding[]
  created_at: string
  updated_at: string
}

export interface Workflow extends OwnedResource {
  id: number
  name: string
  description: string
  status: WorkflowStatus
  profile_id: number | null
  profile_name: string | null
  device_id: number | null
  device_name: string | null
  steps: WorkflowStep[]
  triggers: WorkflowTrigger[]
  created_at: string
  updated_at: string
}

export interface WorkflowCreate {
  name: string
  description: string
  status?: WorkflowStatus
  profile?: number | null
  device?: number | null
}

export interface WorkflowTriggerCreate {
  trigger_type: TriggerType
  is_active?: boolean
  periodic_schedule_type?: PeriodicScheduleType | ''
  run_at?: string | null
  interval_seconds?: number | null
  cron_expression?: string
  event_name?: string
  event_source_type?: EventSourceType | ''
  event_source_id?: number | null
  event_filter?: Record<string, unknown>
  webhook_secret?: string
}

export interface WorkflowStepCreate {
  name: string
  description?: string
  sort_order?: number
  action_type?: WorkflowStepActionType
  action_config?: WorkflowStepActionConfig
  input_bindings?: WorkflowStepInputBinding[]
}

export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface WorkflowRun {
  id: number
  workflow: number
  trigger: number | null
  run_number: number
  status: WorkflowRunStatus
  triggered_by: string
  trigger_payload: Record<string, unknown>
  started_at: string | null
  finished_at: string | null
  error_message: string
  created_at: string
  updated_at: string
}

// ─── Chat Settings ───────────────────────────────────────────────────────────

export interface AgentPlanItem {
  device_id: number
  device_name: string
  role: AgentGroupMemberRole
  task: string
}

export type AgentGroupPlanStatus = 'pending' | 'approved' | 'rejected'

export interface AgentGroupPlan {
  id: number
  group: number
  goal: string
  plan: AgentPlanItem[]
  status: AgentGroupPlanStatus
  created_by: number | null
  created_at: string
  updated_at: string
}

export interface ChatSettings {
  templates: string[]
  llm_model: string
}

// ─── AI Scenario v3 ─────────────────────────────────────────────────────────
// Doc: docs/Gen_Scenario/ai-scenario-v3-thiet-ke.md §6 (Schema)

export type ScenarioGenre = 'seeding' | 'testimonial' | 'educational' | 'brand_story'
export type ScenarioMode = 'ai_video' | 'real_footage'
export type ContinuityMode = 'NEW_SCENE' | 'FRAME_ANCHOR' | 'B_ROLL_CUT'
export type BrandMention = 'none' | 'soft' | 'strong'
export type FunnelPart = 'Hook' | 'Vấn đề' | 'Giải pháp' | 'CTA' | 'B-roll' | ''
export type ChatSender = 'USER' | 'ASSISTANT'
export type ScenarioAuditAction =
  | 'generate' | 'update_shot' | 'refine_shot' | 'update_character'
  | 'restore_shot' | 'restore_all'

export interface ScenarioCharacter {
  name: string
  age?: string
  ethnicity?: string
  outfit_style?: string
  voice_id_hint?: string
}

export interface ScenarioShot {
  id?: number                           // DB pk (read-only, có khi saved)
  shot_id: number                       // logical, dùng cho anchor reference
  shot_order: number
  character_in_frame: string            // '' = None
  continuity_mode: ContinuityMode
  anchor_source_id: number | null       // logical shot_id, null nếu không neo
  prompt_injection: string
  background: string
  character_pose: string
  kinetic_action: string
  camera_articulation: string
  prop_description: string
  texture_and_lighting: string
  voice_over: string
  music_hint: string
  funnel_part: FunnelPart
  brand_mention: BrandMention
  warnings?: string[]                   // soft warning từ CODE-enforce (OQ7)
}

// IntentJSON output từ Parser Agent (Layer 2)
export interface ScenarioIntent {
  detected_format?: string
  brand_hints?: string[]
  character_hints?: Array<{ name?: string; outfit_hint?: string; age_hint?: string }>
  scene_intent?: Array<{ order: number; purpose: string; summary: string }>
  voice_samples?: string[]
  style_hints?: string
  duration_hint_seconds?: number | null
  raw_truncated?: string
}

// ScenarioJSON output từ ScripterAgent (Layer 3)
export interface ScenarioJSON {
  title: string
  duration_target_seconds: number
  shot_count_target: number
  genre: ScenarioGenre
  global_character_registry: ScenarioCharacter[]
  shots: ScenarioShot[]
}

// Persisted ContentScenario (saved DB record)
export interface ContentScenarioItem {
  id: number
  title: string
  brief: string
  duration_target_seconds: number
  shot_count_target: number
  shot_count?: number
  genre: ScenarioGenre
  source_file_name?: string
  intent_json?: ScenarioIntent
  character_registry: ScenarioCharacter[]
  mode: ScenarioMode
  origin_data?: { character_registry?: ScenarioCharacter[]; shots?: ScenarioShot[] }
  shots?: ScenarioShot[]
  owner_id?: number | null
  team_id?: number | null
  team_name?: string | null
  team_permission?: TeamPermission
  created_at: string
  updated_at: string
}

// Refine patch types
export interface ShotPatch {
  kind: 'shot'
  shot_id: number
  before: Partial<Record<keyof ScenarioShot, string>>
  after: Partial<Record<keyof ScenarioShot, string>>
}

export interface CharacterPatch {
  kind: 'character'
  character_name: string
  before: Partial<ScenarioCharacter>
  after: Partial<ScenarioCharacter>
}

export type ScenarioPatch = ShotPatch | CharacterPatch

// Chat message
export interface ScenarioChatMessage {
  id: number
  scenario: number
  owner: number
  sender: ChatSender
  body: string
  target_shots: number[]
  target_character: string
  attached_patches: ScenarioPatch[]
  structured_actions?: StructuredAction[]
  artistic_checks?: ArtisticCheckPayload[]
  resolved_actions?: Record<string, { status: 'applied' | 'rejected'; at: string }>
  llm_model: string
  created_at: string
}

// Audit log entry
export interface ScenarioAuditLogItem {
  id: number
  scenario: number
  action: ScenarioAuditAction
  shot_id: number | null
  character_name: string
  fields_changed: Record<string, unknown>
  previous_value: Record<string, unknown>
  actor_id: number | null
  actor_username: string | null
  created_at: string
}

// API request/response payloads
export interface ScenarioGenerateResponse {
  scenario: ScenarioJSON
  intent_json: ScenarioIntent
  source_file_name: string
  warning?: string | null
}

export interface ScenarioPreviewIntentResponse {
  intent_json: ScenarioIntent
  raw_text_preview: string
  warning?: string | null
}

// v3.2.1 — Structured actions (cho insert/delete/reorder/optimize_whole)
export interface StructuredActionInsertShot {
  kind: 'insert_shot'
  after_shot_id: number
  brief: string
  requires_approval: boolean
  data_impact_class?: DataImpactClass
}
export interface StructuredActionDeleteShot {
  kind: 'delete_shot'
  shot_id: number
  requires_approval: boolean
  approval_id?: number  // v3.2.1 Phase 4 — gắn với PendingApproval row
  data_impact_class?: DataImpactClass
}
export interface StructuredActionReorderShots {
  kind: 'reorder_shots'
  new_order: number[]
  requires_approval: boolean
  approval_id?: number
  data_impact_class?: DataImpactClass
}
export interface StructuredActionOptimizeWhole {
  kind: 'optimize_whole_scenario'
  variant_brief: string
  requires_approval: boolean
  approval_id?: number
  data_impact_class?: DataImpactClass
}
// v3.2.2 Phase 0 — fix bug #2 (xoá character không có modal)
export interface StructuredActionDeleteCharacter {
  kind: 'delete_character'
  character_name: string
  replace_in_shots_with: string | null
  requires_approval: boolean
  approval_id?: number
  data_impact_class?: DataImpactClass
}
// v3.2.2 Phase 2 — 4 verb tool mới
export interface StructuredActionAddCharacter {
  kind: 'add_character'
  name: string
  age: string
  outfit_style: string
  ethnicity: string
  voice_id_hint: string
  requires_approval: boolean
  data_impact_class?: DataImpactClass
}
export interface StructuredActionMoveShot {
  kind: 'move_shot'
  shot_id: number
  new_position: number
  requires_approval: boolean
  data_impact_class?: DataImpactClass
}
export interface StructuredActionDuplicateShot {
  kind: 'duplicate_shot'
  shot_id: number
  requires_approval: boolean
  data_impact_class?: DataImpactClass
}
export interface StructuredActionBatchUpdateShots {
  kind: 'batch_update_shots'
  updates: Array<{shot_id: number; fields: Record<string, unknown>}>
  requires_approval: boolean
  data_impact_class?: DataImpactClass
}
// v3.2.2 Phase 2 — Plan & Execute
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export interface PlanStep {
  description: string
  tool_name: string
  tool_args_preview?: Record<string, unknown>
  status: PlanStepStatus
  result?: unknown
  error?: string | null
}
export interface StructuredActionPlanProposed {
  kind: 'plan_proposed'
  plan_id?: number
  goal: string
  analysis: string
  steps: PlanStep[]
  requires_approval: boolean
  data_impact_class?: DataImpactClass
}

// v3.2.2 Phase 2 — Approval data impact class (FE quyết định modal qua field này)
export type DataImpactClass = 'safe' | 'destructive' | 'expensive'

// v3.2.2 Phase 3 — Cross-shot scoring (scan_scenario tool output)
export interface ScenarioScores {
  cinematic: number
  kinetic: number
  continuity: number
  brand: number
  style: number
}
export interface StructuredActionCrossShotAnalysis {
  kind: 'cross_shot_analysis'
  scores: ScenarioScores | Record<string, number>
  strengths: string[]
  weaknesses: string[]
  recommendations: string[]
  error?: string
  requires_approval: boolean
  data_impact_class?: DataImpactClass
}

export interface DiagnosisFinding {
  target: string
  target_kind: 'transition' | 'shot'
  problem: string
  suggestion: string
}

export interface StructuredActionDiagnosis {
  kind: 'diagnosis'
  focus: string
  focus_label?: string
  reviewer: string
  shots_examined: number[]
  score: number
  scores: Record<string, number>
  issues: string[]
  fixes: string[]
  findings?: DiagnosisFinding[]
  cached?: boolean
  requires_approval: boolean
}

export type StructuredAction =
  | StructuredActionInsertShot
  | StructuredActionDeleteShot
  | StructuredActionReorderShots
  | StructuredActionOptimizeWhole
  | StructuredActionDeleteCharacter
  | StructuredActionAddCharacter
  | StructuredActionMoveShot
  | StructuredActionDuplicateShot
  | StructuredActionBatchUpdateShots
  | StructuredActionPlanProposed
  | StructuredActionCrossShotAnalysis
  | StructuredActionDiagnosis

// v3.2.1 — Proposed options (AI đề xuất 2-3 hướng cho user pick)
export interface ProposedOption {
  label: string
  description: string
}
export interface ProposedOptionsPayload {
  preamble: string
  options: ProposedOption[]
}

export interface ScenarioChatTurnResponse {
  assistant: string
  patches: ScenarioPatch[]
  llm_model: string
  // v3.2.1 — AI Director Mode outputs
  structured_actions?: StructuredAction[]
  proposed_options?: ProposedOptionsPayload | null
  clarification_question?: string | null
}

// v3.2.1 — Enriched response của POST /script-chat/ (preview-script-chat dùng
// ScenarioChatTurnResponse, còn DB-backed endpoint trả thêm message objects).
export interface ScriptChatSendResponse {
  user_message: ScenarioChatMessage
  assistant_message: ScenarioChatMessage
  structured_actions: StructuredAction[]
  proposed_options: ProposedOptionsPayload | null
  clarification_question: string | null
}

export interface ScenarioBrandPromptResponse {
  system_prompt: string
  is_default: boolean
  default_preview: string
}

// v3.2.1 Phase 4 — Human Approval lifecycle
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed'

export interface PendingApprovalRow {
  id: number
  tool_name: 'delete_shot' | 'reorder_shots' | 'optimize_whole_scenario'
  tool_args: Record<string, unknown>
  status: ApprovalStatus
  created_at: string
  resolved_at: string | null
  execution_result?: Record<string, unknown>
}

export interface ResolveApprovalResponse {
  id: number
  status: ApprovalStatus
  tool_name: string
  tool_args: Record<string, unknown>
  resolved_at: string
  execute_endpoint: string | null
}

// v3.2.1 Phase 5 — Audit history cho rollback per-shot
export interface ScenarioHistoryEntry {
  audit_id: number
  action: string
  shot_id: number | null
  character_name: string
  created_at: string
  actor_id: number | null
  // UX-E: 2 summary + 2 full payload — FE render diff before → after
  previous_value_summary: string           // shot TRƯỚC change (restore về đây)
  fields_changed_summary: string           // shot SAU change (audit ghi lại đổi gì)
  previous_value: Record<string, string>
  fields_changed: Record<string, string>
}

// v3.2.1 Phase 3 — SSE stream event types
// v4.0 — Cập nhật các event type cho Creative Director Agent
export type SSEChatEventType =
  | 'thinking'
  | 'artistic_check'
  | 'creative_directing'
  | 'final'
  | 'done'
  | 'error'

export interface SSEChatEvent {
  event: SSEChatEventType
  data: Record<string, unknown>
}

export interface ArtisticCheckPayload {
  reviewer: string
  score: number
  warnings: string[]
  analysis?: string
  shot_id?: number | null
  scores?: Record<string, number>
  issues?: string[]
  fixes?: string[]
  cached?: boolean
}

export interface CreativeDirectingPayload {
  tool: string
  shot_id?: number
  patch?: Record<string, unknown>
  creative_goal?: string
  artistic_analysis?: string
  creative_steps?: Array<{
    step_number: number
    step_goal: string
    affected_shot_ids: number[]
    creative_description: string
  }>
}

// ─── Chatbot TikTok Inbox (Phase 2.3) ────────────────────────────────────────
// Endpoint design.md mục 13. KHÔNG nhầm với TiktokVideo / TiktokInteraction
// (đó là TikTok marketing crawl, không liên quan chatbot DM).

export type TiktokMessageDirection = 'user' | 'bot' | 'system'
export type TiktokMessageSource = 'notification' | 'agent_observed' | 'agent_sent'
export type TiktokChannel = 'tiktok_dm' | 'tiktok_comment'

export interface TiktokConversationItem {
  peer_handle: string
  last_message_at: string
  last_message_content: string
  last_message_type: TiktokMessageDirection
  last_message_channel: TiktokChannel
  last_message_is_preview: boolean
  message_count: number
  is_muted: boolean
  muted_until: string | null
}

export interface TiktokConversationListResponse {
  device_id: number
  device_name: string
  total: number
  limit: number
  conversations: TiktokConversationItem[]
}

export interface TiktokConversationDetail {
  device_id: number
  device_name: string
  peer_handle: string
  message_count: number
  first_message_at: string
  last_message_at: string
  channels: TiktokChannel[]
  is_muted: boolean
  mute_id: number | null
  muted_until: string | null
  mute_note: string
}

export interface TiktokInboxMessage {
  id: number
  peer_handle: string
  channel: TiktokChannel
  content: string
  message_type: TiktokMessageDirection
  source: TiktokMessageSource
  is_preview: boolean
  source_task_id: number | null
  source_notification_id: number | null
  video_id: string | null
  created_at: string
}

export interface TiktokMessagesPage {
  device_id: number
  peer_handle: string
  limit: number
  has_more: boolean
  next_before: number | null
  messages: TiktokInboxMessage[]
}

export interface TiktokPeerMute {
  id: number
  device: number
  peer_handle: string
  muted_until: string | null
  note: string
  is_active: boolean
  created_by_id: number | null
  created_at: string
  updated_at: string
}

export interface TiktokPeerMuteCreate {
  device: number
  peer_handle: string
  muted_until?: string | null
  note?: string
}

// WebSocket payloads (decoded từ ws message JSON)
export type TiktokInboxWsEventType = 'message.created' | 'peer_mute.changed'

export interface TiktokInboxMessageCreatedEvent {
  event_type: 'message.created'
  payload: {
    device_id: number
    peer_handle: string
    message: TiktokInboxMessage
  }
}

export interface TiktokInboxPeerMuteChangedEvent {
  event_type: 'peer_mute.changed'
  payload: {
    device_id: number
    peer_handle: string
    action: 'created' | 'updated' | 'deleted'
    mute: TiktokPeerMute
  }
}

export type TiktokInboxWsEvent = TiktokInboxMessageCreatedEvent | TiktokInboxPeerMuteChangedEvent

// ── WebSites (WordPress publishing) ──────────────────────────────────────────
export interface Website {
  id: number
  name: string
  site_type: 'wordpress'
  base_url: string
  wp_username: string
  has_credentials: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface WebsiteCreate {
  name: string
  base_url: string
  wp_username?: string
  wp_app_password?: string
  site_type?: 'wordpress'
  is_active?: boolean
}

export type WebsitePostWpStatus = 'publish' | 'draft'
export type WebsitePostStatus = 'pending' | 'published' | 'failed' | 'cancelled'

export interface WebsitePost {
  id: number
  website: number
  website_name: string
  title: string
  content: string
  excerpt: string
  slug: string
  image_url: string
  featured_media_id: number | null
  categories: number[]
  tags: number[]
  wp_status: WebsitePostWpStatus
  status: WebsitePostStatus
  scheduled_at: string | null
  wp_post_id: string
  post_url: string
  error_msg: string
  source_images: string[]
  created_at: string
  updated_at: string
}

export interface WebsitePostCreate {
  website: number
  title: string
  content?: string
  excerpt?: string
  slug?: string
  image_url?: string
  featured_media_id?: number | null
  categories?: number[]
  tags?: number[]
  wp_status?: WebsitePostWpStatus
  scheduled_at?: string | null
}

export interface WebsiteTerm { id: number; name: string }
export interface WebsiteMedia { id: number; source_url: string; thumb: string; title: string }
