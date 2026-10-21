import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Clock3,
  ExternalLink,
  FileText,
  Globe,
  RefreshCw,
  Search,
  Smartphone,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { crawlSourcesApi } from '@/lib/api'
import type { CrawlRun, CrawlRunStatus, CrawlSource, CrawlContentSnapshot, PaginatedResponse } from '@/lib/types'

const RUN_STATUS_VARIANT: Record<CrawlRunStatus, 'warning' | 'success' | 'danger'> = {
  running: 'warning',
  success: 'success',
  failed: 'danger',
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
}

function RunStatusBadge({ status }: { status: CrawlRunStatus }) {
  return <Badge variant={RUN_STATUS_VARIANT[status]}>{status}</Badge>
}

export default function CrawlSourceDetailPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const params = useParams<{ id: string }>()
  const sourceId = Number(params.id)

  const [snapshotPage, setSnapshotPage] = useState(1)
  const [snapshotSearch, setSnapshotSearch] = useState('')
  const [contentType, setContentType] = useState('')
  const [hasMedia, setHasMedia] = useState<'' | 'true' | 'false'>('')
  const [crawledAfter, setCrawledAfter] = useState('')
  const [crawledBefore, setCrawledBefore] = useState('')
  const [runPage, setRunPage] = useState(1)
  const [runStatus, setRunStatus] = useState('')
  const [runSearch, setRunSearch] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)

  const { data: source, isLoading: sourceLoading, refetch: refetchSource } = useQuery<CrawlSource>({
    queryKey: ['crawl-source', sourceId],
    queryFn: () => crawlSourcesApi.get(sourceId),
    enabled: Number.isFinite(sourceId),
  })

  const { data: snapshots, isLoading: snapshotsLoading, refetch: refetchSnapshots } = useQuery<PaginatedResponse<CrawlContentSnapshot>>({
    queryKey: ['crawl-source-snapshots', sourceId, snapshotPage, snapshotSearch, contentType, hasMedia, crawledAfter, crawledBefore],
    queryFn: () => crawlSourcesApi.listSnapshots(sourceId, {
      page: snapshotPage,
      page_size: 10,
      search: snapshotSearch,
      content_type: contentType,
      has_media: hasMedia === '' ? '' : hasMedia === 'true',
      crawled_after: crawledAfter || undefined,
      crawled_before: crawledBefore || undefined,
    }),
    enabled: Number.isFinite(sourceId),
  })

  const { data: runs, isLoading: runsLoading, refetch: refetchRuns } = useQuery<PaginatedResponse<CrawlRun>>({
    queryKey: ['crawl-source-runs', sourceId, runPage, runStatus, runSearch],
    queryFn: () => crawlSourcesApi.listRuns(sourceId, {
      page: runPage,
      page_size: 10,
      status: runStatus,
      search: runSearch,
    }),
    enabled: Number.isFinite(sourceId),
  })

  const selectedRun = useMemo(() => {
    const items = runs?.results ?? []
    if (items.length === 0) return null
    return items.find((item) => item.id === selectedRunId) ?? items[0]
  }, [runs?.results, selectedRunId])

  if (sourceLoading) {
    return <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
  }

  if (!source) {
    return <div className="py-10 text-center text-sm text-destructive">{t('common.saveError')}</div>
  }

  const snapshotResults = snapshots?.results ?? []
  const runResults = runs?.results ?? []

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate('/content', { state: { tab: 'source' } })}>
            <ArrowLeft className="size-4" />
            {t('content.crawl.backToSources')}
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => {
            refetchSource()
            refetchSnapshots()
            refetchRuns()
          }}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <a href={source.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" />
              {t('content.crawl.viewWeb')}
            </a>
          </Button>
          <Button variant="outline" disabled>
            {t('content.crawl.triggerSoon')}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={source.is_active ? 'success' : 'muted'}>
                {source.is_active ? t('content.crawl.active') : t('content.crawl.inactive')}
              </Badge>
              {source.latest_run_status && <RunStatusBadge status={source.latest_run_status} />}
              <Badge variant="info">{t(`content.crawl.sourceType.${source.source_type}`)}</Badge>
            </div>
            <h1 className="mt-3 text-xl font-semibold">{source.url}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Clock3 className="size-3.5" />
                {t('content.crawl.fieldFrequency')}: {source.crawl_frequency_minutes} {t('content.crawl.freqUnit')}
              </span>
              {source.device_name && (
                <span className="inline-flex items-center gap-1">
                  <Smartphone className="size-3.5" />
                  {source.device_name}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Globe className="size-3.5" />
                {t('content.crawl.updatedAt')}: {formatDateTime(source.updated_at)}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:min-w-80">
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">{t('content.crawl.totalSnapshots')}</p>
              <p className="mt-1 text-xl font-semibold">{source.snapshot_count}</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">{t('content.crawl.totalRuns')}</p>
              <p className="mt-1 text-xl font-semibold">{source.run_count}</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">{t('content.crawl.lastSuccess')}</p>
              <p className="mt-1 text-sm font-medium">{formatDateTime(source.last_success_at)}</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">{t('content.crawl.lastFailure')}</p>
              <p className="mt-1 text-sm font-medium">{formatDateTime(source.last_failure_at)}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-sm font-semibold">{t('content.crawl.snapshotSection')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('content.crawl.snapshotSectionDesc')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('content.crawl.searchLabel')}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={snapshotSearch}
                  onChange={(event) => {
                    setSnapshotPage(1)
                    setSnapshotSearch(event.target.value)
                  }}
                  placeholder={t('content.crawl.searchPlaceholder')}
                  className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('content.crawl.filterType')}
              <input
                value={contentType}
                onChange={(event) => {
                  setSnapshotPage(1)
                  setContentType(event.target.value)
                }}
                placeholder={t('content.crawl.filterTypePlaceholder')}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('content.crawl.filterMedia')}
              <select
                value={hasMedia}
                onChange={(event) => {
                  setSnapshotPage(1)
                  setHasMedia(event.target.value as '' | 'true' | 'false')
                }}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">{t('content.crawl.filterAll')}</option>
                <option value="true">{t('content.crawl.filterHasMedia')}</option>
                <option value="false">{t('content.crawl.filterNoMedia')}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('content.crawl.filterFromDate')}
              <input
                type="date"
                value={crawledAfter}
                onChange={(event) => {
                  setSnapshotPage(1)
                  setCrawledAfter(event.target.value)
                }}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('content.crawl.filterToDate')}
              <input
                type="date"
                value={crawledBefore}
                onChange={(event) => {
                  setSnapshotPage(1)
                  setCrawledBefore(event.target.value)
                }}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          {snapshotsLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : snapshotResults.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t('content.crawl.snapshotEmpty')}</div>
          ) : (
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">{t('content.crawl.tableTitle')}</th>
                  <th className="px-4 py-3">{t('content.crawl.tableType')}</th>
                  <th className="px-4 py-3">{t('content.crawl.tableCrawledAt')}</th>
                  <th className="px-4 py-3">{t('content.crawl.tableUpdatedAt')}</th>
                  <th className="px-4 py-3">{t('content.crawl.tableMedia')}</th>
                  <th className="px-4 py-3 text-right">{t('content.crawl.tableActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {snapshotResults.map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td className="px-4 py-3 align-top">
                      <div className="min-w-72">
                        <p className="font-medium">{snapshot.title || snapshot.content_url}</p>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{snapshot.summary || '—'}</p>
                        <a
                          href={snapshot.content_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="size-3" />
                          <span className="truncate">{snapshot.content_url}</span>
                        </a>
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top text-xs text-muted-foreground">{snapshot.content_type || '—'}</td>
                    <td className="px-4 py-3 align-top text-xs text-muted-foreground">{formatDateTime(snapshot.crawled_at)}</td>
                    <td className="px-4 py-3 align-top text-xs text-muted-foreground">{formatDateTime(snapshot.last_updated_at)}</td>
                    <td className="px-4 py-3 align-top text-xs text-muted-foreground">{snapshot.media_count}</td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex justify-end gap-2">
                        <Button asChild size="sm" variant="outline">
                          <Link to={`/content/crawl-snapshots/${snapshot.id}`}>
                            <FileText className="size-3.5" />
                            {t('content.crawl.viewDetail')}
                          </Link>
                        </Button>
                        <Button asChild size="sm" variant="outline">
                          <a href={snapshot.content_url} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="size-3.5" />
                            {t('content.crawl.viewWeb')}
                          </a>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('content.crawl.paginationSummary', { count: snapshots?.count ?? 0 })}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={!snapshots?.previous} onClick={() => setSnapshotPage((page) => Math.max(1, page - 1))}>
              {t('common.previous', { defaultValue: 'Previous' })}
            </Button>
            <span>{snapshotPage}</span>
            <Button size="sm" variant="outline" disabled={!snapshots?.next} onClick={() => setSnapshotPage((page) => page + 1)}>
              {t('common.next', { defaultValue: 'Next' })}
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-sm font-semibold">{t('content.crawl.runSection')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('content.crawl.runSectionDesc')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('content.crawl.runStatusFilter')}
              <select
                value={runStatus}
                onChange={(event) => {
                  setRunPage(1)
                  setRunStatus(event.target.value)
                }}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">{t('content.crawl.filterAll')}</option>
                <option value="running">running</option>
                <option value="success">success</option>
                <option value="failed">failed</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
              {t('content.crawl.searchRunLabel')}
              <input
                value={runSearch}
                onChange={(event) => {
                  setRunPage(1)
                  setRunSearch(event.target.value)
                }}
                placeholder={t('content.crawl.searchRunPlaceholder')}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          {runsLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : runResults.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t('content.crawl.runEmpty')}</div>
          ) : (
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">{t('content.crawl.tableStartedAt')}</th>
                  <th className="px-4 py-3">{t('content.crawl.tableStatus')}</th>
                  <th className="px-4 py-3">{t('content.crawl.tableDuration')}</th>
                  <th className="px-4 py-3">{t('content.crawl.tableItemCount')}</th>
                  <th className="px-4 py-3">{t('content.crawl.tableTriggeredBy')}</th>
                  <th className="px-4 py-3 text-right">{t('content.crawl.tableActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runResults.map((run) => (
                  <tr key={run.id} className={selectedRun?.id === run.id ? 'bg-muted/20' : undefined}>
                    <td className="px-4 py-3 align-top text-xs text-muted-foreground">{formatDateTime(run.started_at)}</td>
                    <td className="px-4 py-3 align-top"><RunStatusBadge status={run.status} /></td>
                    <td className="px-4 py-3 align-top text-xs text-muted-foreground">{formatDuration(run.duration_seconds)}</td>
                    <td className="px-4 py-3 align-top text-xs text-muted-foreground">
                      {t('content.crawl.runCountBreakdown', {
                        total: run.item_count,
                        added: run.new_item_count,
                        updated: run.updated_item_count,
                      })}
                    </td>
                    <td className="px-4 py-3 align-top text-xs text-muted-foreground">{run.triggered_by || '—'}</td>
                    <td className="px-4 py-3 align-top text-right">
                      <Button size="sm" variant="outline" onClick={() => setSelectedRunId(run.id)}>
                        {t('content.crawl.viewRunDetail')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('content.crawl.paginationSummary', { count: runs?.count ?? 0 })}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={!runs?.previous} onClick={() => setRunPage((page) => Math.max(1, page - 1))}>
              {t('common.previous', { defaultValue: 'Previous' })}
            </Button>
            <span>{runPage}</span>
            <Button size="sm" variant="outline" disabled={!runs?.next} onClick={() => setRunPage((page) => page + 1)}>
              {t('common.next', { defaultValue: 'Next' })}
            </Button>
          </div>
        </div>

        {selectedRun && (
          <div className="mt-4 rounded-lg border border-border bg-background p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">{t('content.crawl.runDetailTitle')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(selectedRun.started_at)}</p>
              </div>
              <RunStatusBadge status={selectedRun.status} />
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">{t('content.crawl.tableItemCount')}</p>
                <p className="mt-1 text-sm font-medium">{selectedRun.item_count}</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">{t('content.crawl.tableDuration')}</p>
                <p className="mt-1 text-sm font-medium">{formatDuration(selectedRun.duration_seconds)}</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">{t('content.crawl.tableTriggeredBy')}</p>
                <p className="mt-1 text-sm font-medium">{selectedRun.triggered_by || '—'}</p>
              </div>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('content.crawl.runError')}</p>
                <div className="mt-2 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  {selectedRun.error_message || t('content.crawl.runNoError')}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('content.crawl.runSummaryPayload')}</p>
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  {JSON.stringify(selectedRun.summary ?? {}, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
