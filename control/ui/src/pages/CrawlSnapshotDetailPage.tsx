import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ExternalLink, Globe, Link2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { crawlContentSnapshotsApi } from '@/lib/api'
import type { CrawlContentSnapshot } from '@/lib/types'

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

export default function CrawlSnapshotDetailPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const params = useParams<{ id: string }>()
  const snapshotId = Number(params.id)

  const { data: snapshot, isLoading, refetch } = useQuery<CrawlContentSnapshot>({
    queryKey: ['crawl-snapshot', snapshotId],
    queryFn: () => crawlContentSnapshotsApi.get(snapshotId),
    enabled: Number.isFinite(snapshotId),
  })

  if (isLoading) {
    return <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
  }

  if (!snapshot) {
    return <div className="py-10 text-center text-sm text-destructive">{t('common.saveError')}</div>
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => navigate(snapshot.crawl_source_id ? `/content/crawl-sources/${snapshot.crawl_source_id}` : '/content')}
          >
            <ArrowLeft className="size-4" />
            {t('content.crawl.backToSourceDetail')}
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => refetch()}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <a href={snapshot.content_url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" />
              {t('content.crawl.viewWeb')}
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href={snapshot.source_index_url} target="_blank" rel="noopener noreferrer">
              <Globe className="size-4" />
              {t('content.crawl.viewSourceIndex')}
            </a>
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="info">{snapshot.content_type || 'page'}</Badge>
              <Badge variant="muted">{t('content.crawl.mediaCount', { count: snapshot.media_count })}</Badge>
            </div>
            <h1 className="mt-3 text-xl font-semibold">{snapshot.title || snapshot.content_url}</h1>
            <a
              href={snapshot.content_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex max-w-full items-center gap-1 truncate text-sm text-muted-foreground hover:text-foreground"
            >
              <Link2 className="size-4" />
              <span className="truncate">{snapshot.content_url}</span>
            </a>
            {snapshot.summary && <p className="mt-3 text-sm text-muted-foreground">{snapshot.summary}</p>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:w-[360px]">
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">{t('content.crawl.firstCrawledAt')}</p>
              <p className="mt-1 text-sm font-medium">{formatDateTime(snapshot.first_crawled_at)}</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">{t('content.crawl.lastUpdated')}</p>
              <p className="mt-1 text-sm font-medium">{formatDateTime(snapshot.last_updated_at)}</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">{t('content.crawl.checksum')}</p>
              <p className="mt-1 break-all text-sm font-medium">{snapshot.checksum || '—'}</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs text-muted-foreground">{t('content.crawl.version')}</p>
              <p className="mt-1 break-all text-sm font-medium">{snapshot.version || '—'}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="flex flex-col gap-6">
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">{t('content.crawl.metadataSection')}</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs text-muted-foreground">{t('content.crawl.sourceIndex')}</p>
                <p className="mt-1 break-all text-sm">{snapshot.source_index_url}</p>
              </div>
              <div className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs text-muted-foreground">{t('content.crawl.contentUrl')}</p>
                <p className="mt-1 break-all text-sm">{snapshot.content_url}</p>
              </div>
              <div className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs text-muted-foreground">{t('content.crawl.lastCrawledAt')}</p>
                <p className="mt-1 text-sm">{formatDateTime(snapshot.crawled_at)}</p>
              </div>
              <div className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs text-muted-foreground">{t('content.crawl.linkedSource')}</p>
                {snapshot.crawl_source_id ? (
                  <Link className="mt-1 inline-flex text-sm text-primary hover:underline" to={`/content/crawl-sources/${snapshot.crawl_source_id}`}>
                    #{snapshot.crawl_source_id}
                  </Link>
                ) : (
                  <p className="mt-1 text-sm">—</p>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">{t('content.crawl.contentSection')}</h2>
            <div className="mt-4 rounded-lg border border-border bg-background p-4">
              <pre className="whitespace-pre-wrap break-words text-sm text-foreground">
                {snapshot.content_body || '—'}
              </pre>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">{t('content.crawl.mediaSection')}</h2>
            <div className="mt-4 flex flex-col gap-3">
              {snapshot.media_file_urls.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('content.crawl.mediaEmpty')}</p>
              ) : (
                snapshot.media_file_urls.map((mediaUrl) => (
                  <a
                    key={mediaUrl}
                    href={mediaUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg border border-border bg-background p-3 text-sm text-primary hover:underline"
                  >
                    {mediaUrl}
                  </a>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold">{t('content.crawl.payloadSection')}</h2>
            <pre className="mt-4 max-h-[480px] overflow-auto rounded-lg border border-border bg-background p-4 text-xs text-muted-foreground">
              {JSON.stringify(snapshot.payload ?? {}, null, 2)}
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}
