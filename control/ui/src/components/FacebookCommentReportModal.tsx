import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { X, FileText, MessageCircle, Link2, Users, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { facebookPostsApi } from '@/lib/api'

interface Props {
  onClose: () => void
}

export default function FacebookCommentReportModal({ onClose }: Props) {
  const { t } = useTranslation()
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [applied, setApplied] = useState<{ date_from?: string; date_to?: string }>({})

  const { data: interactions, isLoading } = useQuery({
    queryKey: ['facebook-report-interactions', applied],
    queryFn: () => facebookPostsApi.listCommentedInteractions(applied),
  })

  const stats = useMemo(() => {
    const list = interactions ?? []
    const total = list.length
    const posts = new Set(list.map((i) => i.post_id)).size
    const withLink = list.filter((i) => !!i.comment_link).length
    const linkRate = total > 0 ? Math.round((withLink / total) * 100) : 0
    const profilesSet = new Set(list.map((i) => i.profile_name).filter(Boolean))
    const byProfile = new Map<string, number>()
    const byDevice = new Map<string, number>()
    for (const i of list) {
      const p = i.profile_name || '—'
      const d = i.device_name || '—'
      byProfile.set(p, (byProfile.get(p) ?? 0) + 1)
      byDevice.set(d, (byDevice.get(d) ?? 0) + 1)
    }
    return {
      total, posts, withLink, linkRate, profiles: profilesSet.size,
      byProfile: [...byProfile.entries()].sort((a, b) => b[1] - a[1]),
      byDevice: [...byDevice.entries()].sort((a, b) => b[1] - a[1]),
    }
  }, [interactions])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-3xl rounded-xl border border-border bg-card shadow-xl flex max-h-[90vh] flex-col">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">{t('facebook.report.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('facebook.report.subtitle')}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-5">
          {/* Date filter */}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('facebook.report.filterFrom')}</label>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">{t('facebook.report.filterTo')}</label>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <Button size="sm" onClick={() => setApplied({ date_from: dateFrom || undefined, date_to: dateTo || undefined })}>
              {t('facebook.report.apply')}
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t('common.loading')}
            </div>
          ) : stats.total === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t('facebook.report.empty')}</div>
          ) : (
            <>
              {/* Cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Card icon={<FileText className="size-4" />} label={t('facebook.report.cardPosts')} value={String(stats.posts)} />
                <Card icon={<MessageCircle className="size-4" />} label={t('facebook.report.cardComments')} value={String(stats.total)} />
                <Card icon={<Link2 className="size-4" />} label={t('facebook.report.cardLinkRate')} value={`${stats.withLink}/${stats.total} (${stats.linkRate}%)`} />
                <Card icon={<Users className="size-4" />} label={t('facebook.report.cardProfiles')} value={String(stats.profiles)} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Breakdown title={t('facebook.report.byProfile')} rows={stats.byProfile}
                  nameLabel={t('facebook.report.colName')} countLabel={t('facebook.report.colCount')} />
                <Breakdown title={t('facebook.report.byDevice')} rows={stats.byDevice}
                  nameLabel={t('facebook.report.colName')} countLabel={t('facebook.report.colCount')} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Card({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex items-center gap-2 text-muted-foreground">{icon}<span className="text-xs">{label}</span></div>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function Breakdown({ title, rows, nameLabel, countLabel }: { title: string; rows: [string, number][]; nameLabel: string; countLabel: string }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="border-b border-border bg-muted/40 px-4 py-2 text-sm font-medium">{title}</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="px-4 py-1.5 text-left font-medium">{nameLabel}</th>
            <th className="px-4 py-1.5 text-right font-medium">{countLabel}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(([name, count]) => (
            <tr key={name}>
              <td className="px-4 py-1.5 text-muted-foreground">{name}</td>
              <td className="px-4 py-1.5 text-right tabular-nums">{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
