import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { X, FileBarChart2, MessageCircle, Video, Tag, Stethoscope, Link2 } from 'lucide-react'
import { tiktokApi } from '@/lib/api'
import type { TiktokCommentedInteraction } from '@/lib/types'
import { Button } from '@/components/ui/button'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractTagMentions(text: string): string[] {
  return Array.from(text.matchAll(/@[\w.]+/g)).map((m) => m[0])
}

function hasDoctorMention(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes('bác sĩ') ||
    lower.includes('bac si') ||
    lower.includes('bacsi') ||
    lower.includes('bsck') ||
    /\bbs\b/.test(lower) ||
    lower.includes('@doctor') ||
    lower.includes('doctor') ||
    lower.includes('physician')
  )
}

// ─── Bar Chart ────────────────────────────────────────────────────────────────

function BarChart({ data }: { data: { label: string; count: number }[] }) {
  const max = Math.max(...data.map((d) => d.count), 1)
  return (
    <div className="flex flex-col gap-2">
      {data.map(({ label, count }) => (
        <div key={label} className="flex items-center gap-2">
          <span
            className="w-28 shrink-0 truncate text-right text-xs text-muted-foreground"
            title={label}
          >
            {label}
          </span>
          <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
            <div
              className="h-full rounded bg-primary/70 transition-all duration-300"
              style={{ width: `${(count / max) * 100}%` }}
            />
          </div>
          <span className="w-6 text-right text-xs font-medium tabular-nums">{count}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface TiktokCommentReportModalProps {
  onClose: () => void
}

export default function TiktokCommentReportModal({ onClose }: TiktokCommentReportModalProps) {
  const { t } = useTranslation()

  const [mode, setMode] = useState<'single' | 'range'>('range')
  const [reportDate, setReportDate] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const queryDateFrom = mode === 'single' ? reportDate : dateFrom
  const queryDateTo = mode === 'single' ? reportDate : dateTo
  const hasFilter = mode === 'single' ? !!reportDate : !!(dateFrom || dateTo)

  // Use the same data source as the Comment tab table (commented interactions)
  // so every figure here — including the link-display rate — matches that
  // table. The comment_link stored on TiktokCommentPlan can be stale.
  const { data: comments = [], isLoading } = useQuery<TiktokCommentedInteraction[]>({
    queryKey: ['tiktok-comment-report', mode, queryDateFrom, queryDateTo],
    queryFn: () =>
      tiktokApi.listCommentedInteractions({
        date_from: queryDateFrom || undefined,
        date_to: queryDateTo || undefined,
      }),
    enabled: hasFilter,
  })

  const stats = useMemo(() => {
    const uniqueVideos = new Set(comments.map((p) => p.video_link).filter(Boolean)).size
    const total = comments.length

    const byProfile = new Map<string, number>()
    const byDevice = new Map<string, number>()
    let tagMentions = 0
    let doctorMentions = 0
    let withLink = 0

    for (const comment of comments) {
      const content = comment.comment_content ?? ''

      const profile = comment.profile_name || '—'
      byProfile.set(profile, (byProfile.get(profile) ?? 0) + 1)

      const device = comment.device_name || '—'
      byDevice.set(device, (byDevice.get(device) ?? 0) + 1)

      if (extractTagMentions(content).length > 0) tagMentions++
      if (hasDoctorMention(content)) doctorMentions++
      if ((comment.comment_link ?? '').trim()) withLink++
    }

    return {
      uniqueVideos,
      total,
      tagMentions,
      doctorMentions,
      withLink,
      linkRate: total > 0 ? Math.round((withLink / total) * 100) : 0,
      byProfile: Array.from(byProfile.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
      byDevice: Array.from(byDevice.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
    }
  }, [comments])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <FileBarChart2 className="size-4 text-primary" />
            <h2 className="text-base font-semibold">{t('tiktok.reportTitle')}</h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
          {/* Date mode selector */}
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <button
                onClick={() => setMode('single')}
                className={[
                  'flex-1 rounded-lg border py-2 text-sm font-medium transition-colors',
                  mode === 'single'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted',
                ].join(' ')}
              >
                {t('tiktok.reportModeSingle')}
              </button>
              <button
                onClick={() => setMode('range')}
                className={[
                  'flex-1 rounded-lg border py-2 text-sm font-medium transition-colors',
                  mode === 'range'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted',
                ].join(' ')}
              >
                {t('tiktok.reportModeRange')}
              </button>
            </div>

            {mode === 'single' ? (
              <div className="flex items-center gap-2">
                <label className="shrink-0 text-xs text-muted-foreground">{t('tiktok.reportDate')}</label>
                <input
                  type="date"
                  value={reportDate}
                  onChange={(e) => setReportDate(e.target.value)}
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="shrink-0 text-xs text-muted-foreground">{t('tiktok.filterFrom')}</label>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="shrink-0 text-xs text-muted-foreground">{t('tiktok.filterTo')}</label>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Loading */}
          {isLoading && (
            <div className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
          )}

          {/* No filter selected yet */}
          {!isLoading && !hasFilter && (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <FileBarChart2 className="size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('tiktok.reportSelectDate')}</p>
            </div>
          )}

          {/* Report data */}
          {!isLoading && hasFilter && (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <div className="flex flex-col gap-1 rounded-xl border border-border bg-muted/30 px-4 py-3">
                  <Video className="size-4 text-muted-foreground" />
                  <p className="mt-1 text-xs text-muted-foreground">{t('tiktok.reportVideosCommented')}</p>
                  <p className="text-xl font-semibold tabular-nums">{stats.uniqueVideos}</p>
                </div>
                <div className="flex flex-col gap-1 rounded-xl border border-border bg-muted/30 px-4 py-3">
                  <MessageCircle className="size-4 text-muted-foreground" />
                  <p className="mt-1 text-xs text-muted-foreground">{t('tiktok.reportTotalComments')}</p>
                  <p className="text-xl font-semibold tabular-nums">{stats.total}</p>
                </div>
                <div className="flex flex-col gap-1 rounded-xl border border-border bg-muted/30 px-4 py-3">
                  <Tag className="size-4 text-muted-foreground" />
                  <p className="mt-1 text-xs text-muted-foreground">{t('tiktok.reportTagMentions')}</p>
                  <p className="text-xl font-semibold tabular-nums">{stats.tagMentions}</p>
                </div>
                <div className="flex flex-col gap-1 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-800 dark:bg-blue-900/20">
                  <Stethoscope className="size-4 text-blue-600 dark:text-blue-400" />
                  <p className="mt-1 text-xs text-blue-600 dark:text-blue-400">{t('tiktok.reportDoctorMentions')}</p>
                  <p className="text-xl font-semibold tabular-nums text-blue-700 dark:text-blue-300">
                    {stats.doctorMentions}
                  </p>
                </div>
                <div className="flex flex-col gap-1 rounded-xl border border-border bg-muted/30 px-4 py-3">
                  <Link2 className="size-4 text-muted-foreground" />
                  <p className="mt-1 text-xs text-muted-foreground">{t('tiktok.reportLinkRate')}</p>
                  <p className="text-xl font-semibold tabular-nums">{stats.linkRate}%</p>
                </div>
              </div>

              {stats.total === 0 && (
                <div className="flex flex-col items-center gap-2 py-4">
                  <MessageCircle className="size-7 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">{t('tiktok.reportNoData')}</p>
                </div>
              )}

              {stats.total > 0 && (
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  {/* By Profile */}
                  <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
                    <h3 className="text-sm font-semibold">{t('tiktok.reportByProfile')}</h3>
                    {stats.byProfile.length > 0 ? (
                      <BarChart data={stats.byProfile} />
                    ) : (
                      <p className="text-xs text-muted-foreground">{t('tiktok.reportNoData')}</p>
                    )}
                  </div>

                  {/* By Device */}
                  <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
                    <h3 className="text-sm font-semibold">{t('tiktok.reportByDevice')}</h3>
                    {stats.byDevice.length > 0 ? (
                      <BarChart data={stats.byDevice} />
                    ) : (
                      <p className="text-xs text-muted-foreground">{t('tiktok.reportNoData')}</p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 justify-end border-t border-border px-5 py-4">
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </div>
  )
}
