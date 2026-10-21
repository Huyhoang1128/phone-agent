import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ExternalLink, Loader2, PlaySquare, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { contentsApi } from '@/lib/api'
import type { ContentItem, GeneratedScriptFrame } from '@/lib/types'

type VideoLayout = 'tiktok' | 'youtube'

const VIDEO_LAYOUTS: Array<{ value: VideoLayout; ratioClass: string }> = [
  { value: 'tiktok', ratioClass: 'aspect-[9/16]' },
  { value: 'youtube', ratioClass: 'aspect-video' },
]

function getLayoutRatioClass(layout: VideoLayout) {
  return VIDEO_LAYOUTS.find((item) => item.value === layout)?.ratioClass ?? 'aspect-video'
}

function parseSourceUrls(frame: GeneratedScriptFrame): string[] {
  const urlRegex = /(https?:\/\/[^\s,]+)/gi
  const textPool = [frame.Source, frame.Footage, frame.Text]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')

  const urls = textPool.match(urlRegex) ?? []
  return Array.from(new Set(urls.map((url) => url.replace(/[).,;]+$/, ''))))
}

function getPreviewType(url: string): 'image' | 'video' | 'embed' | 'link' {
  const normalized = url.toLowerCase()
  if (/(\.png|\.jpg|\.jpeg|\.webp|\.gif)(\?|$)/.test(normalized)) return 'image'
  if (/(\.mp4|\.webm|\.mov|\.m4v)(\?|$)/.test(normalized)) return 'video'
  if (normalized.includes('youtube.com') || normalized.includes('youtu.be') || normalized.includes('tiktok.com')) {
    return 'embed'
  }
  return 'link'
}

function toEmbeddableUrl(url: string): string {
  if (url.includes('youtube.com/watch')) {
    try {
      const parsed = new URL(url)
      const id = parsed.searchParams.get('v')
      if (id) return `https://www.youtube.com/embed/${id}`
    } catch {
      return url
    }
  }

  if (url.includes('youtu.be/')) {
    try {
      const parsed = new URL(url)
      const id = parsed.pathname.replace('/', '')
      if (id) return `https://www.youtube.com/embed/${id}`
    } catch {
      return url
    }
  }

  return url
}

export default function ConvertScriptToVideoPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [layout, setLayout] = useState<VideoLayout>('tiktok')

  const { data: item, isLoading } = useQuery<ContentItem>({
    queryKey: ['contents', id],
    queryFn: () => contentsApi.get(Number(id)),
    enabled: Boolean(id),
  })

  const ratioClass = getLayoutRatioClass(layout)

  const frames = useMemo(() => {
    if (!item || !Array.isArray(item.frames)) return []
    return item.frames
  }, [item])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground">{t('content.detailNotFound')}</p>
        <Button variant="outline" onClick={() => navigate('/content')}>
          <ArrowLeft className="mr-2 size-4" />
          {t('content.backToList')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(`/content/${item.id}`)} aria-label={t('content.convert.backToDetail')}>
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="truncate text-xl font-semibold">{t('content.convert.pageTitle')}</h1>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">{t('content.convert.forContent')}: {item.title}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {VIDEO_LAYOUTS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={layout === option.value ? 'default' : 'outline'}
              onClick={() => setLayout(option.value)}
              className="gap-2"
            >
              <Video className="size-4" />
              {option.value === 'tiktok' ? t('content.convert.layoutTiktok') : t('content.convert.layoutYoutube')}
            </Button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('content.convert.framePreviewTitle')}</h2>
        {frames.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('content.noFrames')}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {frames.map((frame, index) => {
              const sourceUrls = parseSourceUrls(frame)

              return (
                <div key={index} className="rounded-lg border border-border bg-background p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                      Frame {String(frame.Frame ?? index + 1)}
                    </span>
                    {frame['Phần'] && (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                        {String(frame['Phần'])}
                      </span>
                    )}
                  </div>

                  {frame.Voice && (
                    <p className="mb-1 text-sm">
                      <span className="font-medium">Voice: </span>
                      {String(frame.Voice)}
                    </p>
                  )}

                  {frame.Footage && (
                    <p className="mb-2 text-xs text-muted-foreground">
                      <span className="font-medium">Footage: </span>
                      {String(frame.Footage)}
                    </p>
                  )}

                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    {t('content.convert.frameSourcesLabel')}
                  </p>

                  {sourceUrls.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('content.convert.noSourcePreview')}</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      {sourceUrls.map((url) => {
                        const previewType = getPreviewType(url)
                        return (
                          <div key={url} className="rounded-lg border border-border bg-card p-2">
                            {(previewType === 'image' || previewType === 'video' || previewType === 'embed') && (
                              <div className={`mb-2 w-full overflow-hidden rounded-md bg-black/80 ${ratioClass}`}>
                                {previewType === 'image' && (
                                  <img
                                    src={url}
                                    alt={t('content.convert.sourcePreviewAlt')}
                                    className="h-full w-full object-cover"
                                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                                  />
                                )}
                                {previewType === 'video' && (
                                  <video src={url} controls className="h-full w-full object-cover" />
                                )}
                                {previewType === 'embed' && (
                                  <iframe
                                    src={toEmbeddableUrl(url)}
                                    title={t('content.convert.sourcePreviewAlt')}
                                    className="h-full w-full"
                                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                    allowFullScreen
                                  />
                                )}
                              </div>
                            )}

                            {previewType === 'link' && (
                              <div className={`mb-2 flex w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/40 ${ratioClass}`}>
                                <PlaySquare className="size-6 text-muted-foreground" />
                              </div>
                            )}

                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex max-w-full items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <ExternalLink className="size-3.5 shrink-0" />
                              <span className="truncate">{url}</span>
                            </a>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
