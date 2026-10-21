import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useClipboard(timeout = 2000) {
  const [copied, setCopied] = useState<string | null>(null)
  async function copy(text: string, id: string) {
    await navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), timeout)
  }
  return { copied, copy }
}

function CodeBlock({ id, code, lang = 'bash' }: { id: string; code: string; lang?: string }) {
  const { copied, copy } = useClipboard()
  return (
    <div className="relative rounded-lg border border-border bg-zinc-950 text-zinc-100">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-1.5">
        <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wide">{lang}</span>
        <button
          onClick={() => copy(code, id)}
          className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {copied === id ? <Check className="size-3.5 text-green-400" /> : <Copy className="size-3.5" />}
          {copied === id ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function Section({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <section id={id} className="scroll-mt-20">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 border-b border-border pb-2 text-left"
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
        <h2 className="text-base font-semibold">{title}</h2>
      </button>
      {open && <div className="mt-4 flex flex-col gap-4">{children}</div>}
    </section>
  )
}

function Endpoint({
  method,
  path,
  summary,
  description,
  authRequired,
  queryParams,
  requestBody,
  responseBody,
  exampleRequest,
  exampleResponse,
}: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  summary: string
  description?: string
  authRequired?: boolean
  queryParams?: { name: string; type: string; required?: boolean; description: string }[]
  requestBody?: { name: string; type: string; required?: boolean; description: string }[]
  responseBody?: string
  exampleRequest?: string
  exampleResponse?: string
}) {
  const [open, setOpen] = useState(false)
  const { copied, copy } = useClipboard()
  const methodColor: Record<string, string> = {
    GET: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    POST: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    PATCH: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    DELETE: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  }
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } }}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors cursor-pointer"
      >
        <span
          className={`shrink-0 rounded px-2 py-0.5 text-xs font-bold uppercase ${methodColor[method]}`}
        >
          {method}
        </span>
        <code className="flex-1 text-sm font-mono">{path}</code>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void copy(path, `${method}-${path}`) }}
          className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          title="Copy endpoint path"
        >
          {copied === `${method}-${path}` ? <Check className="size-3.5 text-green-400" /> : <Copy className="size-3.5" />}
        </button>
        <span className="hidden sm:block text-sm text-muted-foreground">{summary}</span>
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
      </div>

      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3 flex flex-col gap-4">
          {description && <p className="text-sm text-muted-foreground">{description}</p>}

          {authRequired !== false && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              <span className="font-semibold">🔑 Authentication required</span>
              <span>— pass <code className="font-mono">Authorization: Api-Key sk-…</code> header</span>
            </div>
          )}

          {queryParams && queryParams.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground tracking-wide">Query Parameters</h4>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-1 pr-4 font-medium">Name</th>
                    <th className="pb-1 pr-4 font-medium">Type</th>
                    <th className="pb-1 pr-4 font-medium">Required</th>
                    <th className="pb-1 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {queryParams.map((p) => (
                    <tr key={p.name} className="border-b border-border/50 align-top">
                      <td className="py-1.5 pr-4 font-mono text-xs">{p.name}</td>
                      <td className="py-1.5 pr-4 text-xs text-muted-foreground">{p.type}</td>
                      <td className="py-1.5 pr-4 text-xs">{p.required ? <span className="text-red-500">Yes</span> : 'No'}</td>
                      <td className="py-1.5 text-xs text-muted-foreground">{p.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {requestBody && requestBody.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground tracking-wide">Request Body (JSON)</h4>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-1 pr-4 font-medium">Field</th>
                    <th className="pb-1 pr-4 font-medium">Type</th>
                    <th className="pb-1 pr-4 font-medium">Required</th>
                    <th className="pb-1 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {requestBody.map((f) => (
                    <tr key={f.name} className="border-b border-border/50 align-top">
                      <td className="py-1.5 pr-4 font-mono text-xs">{f.name}</td>
                      <td className="py-1.5 pr-4 text-xs text-muted-foreground">{f.type}</td>
                      <td className="py-1.5 pr-4 text-xs">{f.required ? <span className="text-red-500">Yes</span> : 'No'}</td>
                      <td className="py-1.5 text-xs text-muted-foreground">{f.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {responseBody && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground tracking-wide">Response</h4>
              <p className="text-xs text-muted-foreground">{responseBody}</p>
            </div>
          )}

          {exampleRequest && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground tracking-wide">Example Request</h4>
              <CodeBlock id={`req-${method}-${path}`} code={exampleRequest} lang="shell" />
            </div>
          )}

          {exampleResponse && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground tracking-wide">Example Response</h4>
              <CodeBlock id={`res-${method}-${path}`} code={exampleResponse} lang="json" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? window.location.origin

export default function ApiDocsPage() {
  const { t } = useTranslation()

  return (
    <div className="mx-auto max-w-3xl flex flex-col gap-8 pb-16">
      {/* Hero */}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">{t('apiDocs.title')}</h1>
        <p className="text-muted-foreground">{t('apiDocs.subtitle')}</p>
      </div>

      {/* Authentication */}
      <Section id="authentication" title={t('apiDocs.authTitle')}>
        <p className="text-sm text-muted-foreground">
          {t('apiDocs.authDesc')}
        </p>
        <CodeBlock
          id="auth-header"
          code={`Authorization: Api-Key sk-<your-api-key>`}
          lang="http"
        />
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {t('apiDocs.authNote')}
        </div>
      </Section>

      {/* Base URL */}
      <Section id="base-url" title={t('apiDocs.baseUrlTitle')}>
        <p className="text-sm text-muted-foreground">{t('apiDocs.baseUrlDesc')}</p>
        <CodeBlock id="base-url" code={`${BASE_URL}/api/tiktok/`} lang="url" />
      </Section>

      {/* Video Object */}
      <Section id="video-object" title={t('apiDocs.videoObjectTitle')}>
        <p className="text-sm text-muted-foreground">{t('apiDocs.videoObjectDesc')}</p>
        <CodeBlock
          id="video-object"
          code={JSON.stringify(
            {
              id: 1,
              keywords: ['#dance', '#viral'],
              video_url: 'https://www.tiktok.com/@user/video/123456789',
              caption: 'Original TikTok caption text (nullable)',
              content: 'Processed content description',
              status: 'pending',
              video_process_task_id: null,
              owner_id: 42,
              team_id: null,
              existing_comments: [],
              created_at: '2024-01-15T08:30:00Z',
              updated_at: '2024-01-15T08:30:00Z',
            },
            null,
            2,
          )}
          lang="json"
        />
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-1 pr-4 font-medium">Field</th>
              <th className="pb-1 pr-4 font-medium">Type</th>
              <th className="pb-1 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {[
              { name: 'id', type: 'integer', desc: 'Unique video ID (read-only)' },
              { name: 'keywords', type: 'string[]', desc: 'List of hashtag keywords associated with the video' },
              { name: 'video_url', type: 'string (URL)', desc: 'Public TikTok video URL' },
              { name: 'caption', type: 'string | null', desc: 'Original caption of the TikTok video. Can be null or blank.' },
              { name: 'content', type: 'string', desc: 'Processed content description, written back by the video analysis service via /api/tiktok/update-content/' },
              { name: 'status', type: 'string (enum)', desc: 'Processing status: pending | liked | commented | shared | reposted' },
              { name: 'video_process_task_id', type: 'string | null', desc: 'Task ID returned by the external video analysis service after calling /api/tiktok/{id}/process-video/ (read-only, set automatically)' },
              { name: 'owner_id', type: 'integer', desc: 'ID of the user who owns this video (read-only)' },
              { name: 'team_id', type: 'integer | null', desc: 'Optional team ID to associate the video with' },
              { name: 'existing_comments', type: 'any[]', desc: 'Existing comments on the video from other people (not from agents). Free-form JSON array — structure depends on the data source. Defaults to an empty list.' },
              { name: 'created_at', type: 'datetime (ISO 8601)', desc: 'When the record was created (read-only)' },
              { name: 'updated_at', type: 'datetime (ISO 8601)', desc: 'When the record was last updated (read-only)' },
            ].map((r) => (
              <tr key={r.name} className="border-b border-border/50 align-top">
                <td className="py-1.5 pr-4 font-mono text-xs">{r.name}</td>
                <td className="py-1.5 pr-4 text-xs text-muted-foreground">{r.type}</td>
                <td className="py-1.5 text-xs text-muted-foreground">{r.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Endpoints */}
      <Section id="endpoints" title={t('apiDocs.endpointsTitle')}>

        {/* List */}
        <Endpoint
          method="GET"
          path="/api/tiktok/"
          summary="List videos"
          description="Returns a paginated list of all TikTok videos that belong to the authenticated user."
          queryParams={[
            { name: 'status', type: 'string', description: 'Filter by status: pending | liked | commented | shared | reposted' },
            { name: 'date_from', type: 'date (YYYY-MM-DD)', description: 'Only return videos created on or after this date' },
            { name: 'date_to', type: 'date (YYYY-MM-DD)', description: 'Only return videos created on or before this date' },
            { name: 'search', type: 'string', description: 'Full-text search across content and video_url fields' },
            { name: 'ordering', type: 'string', description: 'Sort results by field. Prefix with - for descending. Options: created_at, updated_at, status' },
          ]}
          responseBody="200 OK — JSON array of Video objects"
          exampleRequest={`curl "${BASE_URL}/api/tiktok/?status=pending&ordering=-created_at" \\
  -H "Authorization: Api-Key sk-<your-api-key>"`}
          exampleResponse={JSON.stringify(
            [
              {
                id: 1,
                keywords: ['#dance', '#viral'],
                video_url: 'https://www.tiktok.com/@user/video/111',
                caption: null,
                content: 'Amazing dance video!',
                status: 'pending',
                video_process_task_id: null,
                owner_id: 42,
                team_id: null,
                existing_comments: [],
                created_at: '2024-01-15T08:30:00Z',
                updated_at: '2024-01-15T08:30:00Z',
              },
            ],
            null,
            2,
          )}
        />

        {/* Create */}
        <Endpoint
          method="POST"
          path="/api/tiktok/"
          summary="Create a video"
          description="Add a new TikTok video entry. The video is automatically assigned to the user associated with the API key."
          requestBody={[
            { name: 'keywords', type: 'string[]', required: false, description: 'List of hashtag keywords (e.g. ["#viral", "#dance"])' },
            { name: 'video_url', type: 'string (URL)', required: false, description: 'Public TikTok video URL (max 2048 chars)' },
            { name: 'caption', type: 'string | null', required: false, description: 'Original caption of the TikTok video. Accepts null or blank.' },
            { name: 'content', type: 'string', required: false, description: 'Processed content description text' },
            { name: 'status', type: 'string (enum)', required: false, description: 'Initial status. Defaults to pending' },
            { name: 'team_id', type: 'integer | null', required: false, description: 'Optional team ID' },
            { name: 'existing_comments', type: 'any[]', required: false, description: 'Existing comments from other people on the video. Free-form JSON array. Defaults to [].' },
          ]}
          responseBody="201 Created — the newly created Video object"
          exampleRequest={`curl -X POST "${BASE_URL}/api/tiktok/" \\
  -H "Authorization: Api-Key sk-<your-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "keywords": ["#dance", "#viral"],
    "video_url": "https://www.tiktok.com/@user/video/123456789",
    "caption": "Check this out 🔥",
    "content": "Amazing dance video!"
  }'`}
          exampleResponse={JSON.stringify(
            {
              id: 2,
              keywords: ['#dance', '#viral'],
              video_url: 'https://www.tiktok.com/@user/video/123456789',
              caption: 'Check this out 🔥',
              content: 'Amazing dance video!',
              status: 'pending',
              video_process_task_id: null,
              owner_id: 42,
              team_id: null,
              existing_comments: [],
              created_at: '2024-01-15T09:00:00Z',
              updated_at: '2024-01-15T09:00:00Z',
            },
            null,
            2,
          )}
        />

        {/* Retrieve */}
        <Endpoint
          method="GET"
          path="/api/tiktok/{id}/"
          summary="Retrieve a video"
          description="Get the details of a single TikTok video by its ID. You can only access videos that belong to you."
          responseBody="200 OK — the Video object"
          exampleRequest={`curl "${BASE_URL}/api/tiktok/2/" \\
  -H "Authorization: Api-Key sk-<your-api-key>"`}
          exampleResponse={JSON.stringify(
            {
              id: 2,
              keywords: ['#dance', '#viral'],
              video_url: 'https://www.tiktok.com/@user/video/123456789',
              caption: 'Check this out 🔥',
              content: 'Amazing dance video!',
              status: 'liked',
              video_process_task_id: 'dabc14a4b66f4c1996f93b44ffaf4e8f',
              owner_id: 42,
              team_id: null,
              existing_comments: [],
              created_at: '2024-01-15T09:00:00Z',
              updated_at: '2024-01-15T10:00:00Z',
            },
            null,
            2,
          )}
        />

        {/* Update */}
        <Endpoint
          method="PATCH"
          path="/api/tiktok/{id}/"
          summary="Update a video"
          description="Partially update a TikTok video. Only the fields you include in the request body will be changed."
          requestBody={[
            { name: 'keywords', type: 'string[]', required: false, description: 'Replace the keywords list' },
            { name: 'video_url', type: 'string (URL)', required: false, description: 'Update the TikTok URL' },
            { name: 'caption', type: 'string | null', required: false, description: 'Update the caption. Pass null to clear.' },
            { name: 'content', type: 'string', required: false, description: 'Update the processed content description' },
            { name: 'status', type: 'string (enum)', required: false, description: 'Update status: pending | liked | commented | shared | reposted' },
            { name: 'team_id', type: 'integer | null', required: false, description: 'Associate with a team or set null to remove' },
            { name: 'existing_comments', type: 'any[]', required: false, description: 'Replace the list of existing comments from other people on the video. Free-form JSON array.' },
          ]}
          responseBody="200 OK — the updated Video object"
          exampleRequest={`curl -X PATCH "${BASE_URL}/api/tiktok/2/" \\
  -H "Authorization: Api-Key sk-<your-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"status": "liked"}'`}
          exampleResponse={JSON.stringify(
            {
              id: 2,
              keywords: ['#dance', '#viral'],
              video_url: 'https://www.tiktok.com/@user/video/123456789',
              caption: 'Check this out 🔥',
              content: 'Amazing dance video!',
              status: 'liked',
              video_process_task_id: null,
              owner_id: 42,
              team_id: null,
              existing_comments: [],
              created_at: '2024-01-15T09:00:00Z',
              updated_at: '2024-01-15T10:30:00Z',
            },
            null,
            2,
          )}
        />

        {/* Delete */}
        <Endpoint
          method="DELETE"
          path="/api/tiktok/{id}/"
          summary="Delete a video"
          description="Permanently delete a TikTok video. This action cannot be undone."
          responseBody="204 No Content"
          exampleRequest={`curl -X DELETE "${BASE_URL}/api/tiktok/2/" \\
  -H "Authorization: Api-Key sk-<your-api-key>"`}
        />

        <Endpoint
          method="POST"
          path="/api/tiktok/keyword-lists/{id}/add-keyword/"
          summary="Append keyword(s) to a saved keyword list"
          description="Add one or many keywords to an existing keyword list. Incoming values are trimmed, duplicates are ignored case-insensitively, and the response includes only the newly added keywords."
          requestBody={[
            { name: 'keyword', type: 'string', required: false, description: 'Single keyword to append to the list.' },
            { name: 'keywords', type: 'string[]', required: false, description: 'Optional batch of keywords to append in one request.' },
          ]}
          responseBody="200 OK — { added_keywords, keyword_list }"
          exampleRequest={`curl -X POST "${BASE_URL}/api/tiktok/keyword-lists/12/add-keyword/" \\
  -H "Authorization: Api-Key sk-<your-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "keyword": "city break",
    "keywords": ["food tour", "travel hacks"]
  }'`}
          exampleResponse={JSON.stringify(
            {
              added_keywords: ['city break', 'food tour', 'travel hacks'],
              keyword_list: {
                id: 12,
                name: 'Travel ideas',
                topic: 'travel',
                keywords: ['beach', 'city break', 'food tour', 'travel hacks'],
                dispatched_keywords: ['beach'],
                owner_id: 42,
                team_id: null,
                team_name: null,
                team_permission: 'view',
                created_at: '2024-01-15T09:00:00Z',
                updated_at: '2024-01-15T10:30:00Z',
              },
            },
            null,
            2,
          )}
        />

        {/* Process Video */}
        <Endpoint
          method="POST"
          path="/api/tiktok/{id}/process-video/"
          summary="Queue video for analysis"
          description="Submit the video to the external analysis service (genvideo). The service returns a task_id which is automatically saved to video_process_task_id on the video record. The task runs asynchronously — use the task_id to poll for completion on the analysis service side."
          responseBody="200 OK — { task_id, video }"
          exampleRequest={`curl -X POST "${BASE_URL}/api/tiktok/2/process-video/" \\
  -H "Authorization: Api-Key sk-<your-api-key>"`}
          exampleResponse={JSON.stringify(
            {
              task_id: 'dabc14a4b66f4c1996f93b44ffaf4e8f',
              video: {
                id: 2,
                keywords: ['#dance', '#viral'],
                video_url: 'https://www.tiktok.com/@demo_creator2/video/7100000000000000002',
                caption: null,
                content: '',
                status: 'pending',
                video_process_task_id: 'dabc14a4b66f4c1996f93b44ffaf4e8f',
                owner_id: 42,
                team_id: null,
                existing_comments: [],
                created_at: '2024-01-15T09:00:00Z',
                updated_at: '2024-01-15T10:30:00Z',
              },
            },
            null,
            2,
          )}
        />

        {/* Update Content */}
        <Endpoint
          method="POST"
          path="/api/tiktok/update-content/"
          summary="Update video content by task ID"
          description="Write back the content description produced by the video analysis service. Looks up the video by video_process_task_id and updates its content field. Intended to be called from an external webhook or callback once the analysis task completes."
          requestBody={[
            { name: 'video_process_task_id', type: 'string', required: true, description: 'The task_id previously returned by /api/tiktok/{id}/process-video/' },
            { name: 'content', type: 'string', required: true, description: 'Content description produced by the video analysis service' },
          ]}
          responseBody="200 OK — the updated Video object"
          exampleRequest={`curl -X POST "${BASE_URL}/api/tiktok/update-content/" \\
  -H "Authorization: Api-Key sk-<your-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "video_process_task_id": "dabc14a4b66f4c1996f93b44ffaf4e8f",
    "content": "This is an energetic dance video featuring a trending TikTok challenge."
  }'`}
          exampleResponse={JSON.stringify(
            {
              id: 2,
              keywords: ['#dance', '#viral'],
              video_url: 'https://www.tiktok.com/@demo_creator2/video/7100000000000000002',
              caption: null,
              content: 'This is an energetic dance video featuring a trending TikTok challenge.',
              status: 'pending',
              video_process_task_id: 'dabc14a4b66f4c1996f93b44ffaf4e8f',
              owner_id: 42,
              team_id: null,
              existing_comments: [],
              created_at: '2024-01-15T09:00:00Z',
              updated_at: '2024-01-15T11:00:00Z',
            },
            null,
            2,
          )}
        />

        {/* Update Comment Plan */}
        <Endpoint
          method="POST"
          path="/api/tiktok/update-comment-plan/"
          summary="Update comment plan by video link or comment plan id"
          description="Update comment plans in tiktok_tiktokcommentplan by video_link, comment_plan_id, or both. At least one filter (video_link or comment_plan_id) is required. At least one updatable field (comment_link or is_commented) is required."
          requestBody={[
            { name: 'video_link', type: 'string (URL)', required: false, description: 'TikTok video link used to find matching comment plans' },
            { name: 'comment_plan_id', type: 'integer', required: false, description: 'Specific comment plan id to update' },
            { name: 'comment_link', type: 'string (URL)', required: false, description: 'New direct URL of the posted TikTok comment/reply' },
            { name: 'is_commented', type: 'boolean', required: false, description: 'Whether the comment plan has been commented' },
          ]}
          responseBody="200 OK — { updated_count, comment_plans }"
          exampleRequest={`curl -X POST "${BASE_URL}/api/tiktok/update-comment-plan/" \\
  -H "Authorization: Api-Key sk-<your-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "comment_plan_id": 99,
    "comment_link": "https://www.tiktok.com/@user/video/123456789?comment=987654321",
    "is_commented": true
  }'`}
          exampleResponse={JSON.stringify(
            {
              updated_count: 1,
              comment_plans: [
                {
                  id: 99,
                  video: 2,
                  video_link: 'https://www.tiktok.com/@user/video/123456789',
                  agent_group: null,
                  agent_group_name: null,
                  profile: null,
                  profile_name: null,
                  device: null,
                  device_name: null,
                  comment_content: 'Great video! 🔥',
                  comment_link: 'https://www.tiktok.com/@user/video/123456789?comment=987654321',
                  reply_to: '',
                  is_approved: true,
                  is_commented: true,
                  created_at: '2024-01-15T10:00:00Z',
                  updated_at: '2024-01-15T10:01:00Z',
                },
              ],
            },
            null,
            2,
          )}
        />

        {/* Record Interaction */}
        <Endpoint
          method="POST"
          path="/api/tiktok/record-interaction/"
          summary="Record a video interaction"
          description="Record that an interaction (like, comment, repost, or reply to a comment) was performed on a TikTok video. The video is identified by its URL. A new row is inserted into the tiktok_tiktokvideointeraction table."
          requestBody={[
            { name: 'video_url', type: 'string (URL)', required: true, description: 'The TikTok video link used to identify the video' },
            { name: 'interaction_type', type: 'string (enum)', required: true, description: 'Type of interaction: like | comment | repost | reply' },
            { name: 'profile_username', type: 'string', required: false, description: 'Username of the profile that performed the interaction' },
            { name: 'profile_avatar_url', type: 'string (URL)', required: false, description: 'Avatar URL of the profile' },
            { name: 'comment_content', type: 'string', required: false, description: 'Content of the comment or reply (relevant when interaction_type is comment or reply)' },
            { name: 'comment_link', type: 'string (URL)', required: false, description: 'Direct URL of the posted TikTok comment/reply' },
            { name: 'interacted_at', type: 'datetime (ISO 8601)', required: false, description: 'Timestamp of when the interaction occurred' },
          ]}
          responseBody="201 Created — the newly created Interaction object"
          exampleRequest={`curl -X POST "${BASE_URL}/api/tiktok/record-interaction/" \\
  -H "Authorization: Api-Key sk-<your-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "video_url": "https://www.tiktok.com/@user/video/123456789",
    "interaction_type": "comment",
    "profile_username": "agent_profile_01",
    "comment_content": "Great video! 🔥",
    "comment_link": "https://www.tiktok.com/@user/video/123456789?comment=987654321",
    "interacted_at": "2024-01-15T10:00:00Z"
  }'`}
          exampleResponse={JSON.stringify(
            {
              id: 7,
              interaction_type: 'comment',
              profile_username: 'agent_profile_01',
              profile_avatar_url: '',
              comment_content: 'Great video! 🔥',
              comment_link: 'https://www.tiktok.com/@user/video/123456789?comment=987654321',
              interacted_at: '2024-01-15T10:00:00Z',
              created_at: '2024-01-15T10:00:05Z',
            },
            null,
            2,
          )}
        />
      </Section>

      {/* Status values */}
      <Section id="status-values" title={t('apiDocs.statusTitle')}>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-1 pr-4 font-medium">Value</th>
              <th className="pb-1 font-medium">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {[
              { v: 'pending', m: 'Queued, not yet processed' },
              { v: 'liked', m: 'The video has been liked by the agent' },
              { v: 'commented', m: 'The agent left a comment on the video' },
              { v: 'shared', m: 'The video was shared' },
              { v: 'reposted', m: 'The video was reposted' },
            ].map((r) => (
              <tr key={r.v} className="border-b border-border/50">
                <td className="py-1.5 pr-4 font-mono text-xs">{r.v}</td>
                <td className="py-1.5 text-xs text-muted-foreground">{r.m}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Interaction types */}
      <Section id="interaction-types" title="Interaction Types">
        <p className="text-sm text-muted-foreground">
          Values accepted by the <code className="font-mono text-xs">interaction_type</code> field of{' '}
          <code className="font-mono text-xs">POST /api/tiktok/record-interaction/</code>.
        </p>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-1 pr-4 font-medium">Value</th>
              <th className="pb-1 font-medium">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {[
              { v: 'like', m: 'The agent liked the video' },
              { v: 'comment', m: 'The agent left a comment on the video' },
              { v: 'repost', m: 'The agent reposted the video' },
              { v: 'reply', m: 'The agent replied to a comment on the video' },
            ].map((r) => (
              <tr key={r.v} className="border-b border-border/50">
                <td className="py-1.5 pr-4 font-mono text-xs">{r.v}</td>
                <td className="py-1.5 text-xs text-muted-foreground">{r.m}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Error codes */}
      <Section id="errors" title={t('apiDocs.errorsTitle')}>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-1 pr-4 font-medium">HTTP Status</th>
              <th className="pb-1 font-medium">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {[
              { code: '400 Bad Request', desc: 'Validation error — check the response body for field-level details' },
              { code: '401 Unauthorized', desc: 'Missing or invalid API key' },
              { code: '403 Forbidden', desc: 'The API key does not have access to this resource' },
              { code: '404 Not Found', desc: 'Resource does not exist or belongs to another user' },
              { code: '405 Method Not Allowed', desc: 'HTTP method not supported on this endpoint' },
              { code: '500 Internal Server Error', desc: 'Unexpected server error' },
              { code: '502 Bad Gateway', desc: 'The external video analysis service returned an error or is unreachable' },
            ].map((r) => (
              <tr key={r.code} className="border-b border-border/50 align-top">
                <td className="py-1.5 pr-4 font-mono text-xs whitespace-nowrap">{r.code}</td>
                <td className="py-1.5 text-xs text-muted-foreground">{r.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <CodeBlock
          id="error-example"
          code={JSON.stringify({ detail: 'Invalid or inactive API key.' }, null, 2)}
          lang="json"
        />
      </Section>

      {/* Rate limiting note */}
      <Section id="rate-limiting" title={t('apiDocs.rateLimitTitle')}>
        <p className="text-sm text-muted-foreground">{t('apiDocs.rateLimitDesc')}</p>
      </Section>
    </div>
  )
}
