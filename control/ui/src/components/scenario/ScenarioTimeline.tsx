/**
 * v3.2.2 — ScenarioTimeline dạng Multi-track (Phase 2).
 * 
 * Layout dạng bảng phân luồng tracks (như CapCut / Premiere):
 * - Hàng 1: Phân cảnh (Shot ID + Funnel Part)
 * - Hàng 2: Thuyết minh (Voice Over preview)
 * - Hàng 3: Nhân vật (Character name/initials)
 */
import { AlertTriangle, Film, Mic, User } from 'lucide-react'
import { useCallback } from 'react'

import { funnelPillClass } from '@/lib/scenario-tokens'
import type { ScenarioShot } from '@/lib/types'

interface Props {
  shots: ScenarioShot[]
  activeShotId?: number | null
  onJump: (shotId: number) => void
}

export function ScenarioTimeline({ shots, activeShotId, onJump }: Props) {
  const handleJump = useCallback(
    (shotId: number) => {
      onJump(shotId)
      const el = document.getElementById(`shot-anchor-${shotId}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    },
    [onJump],
  )

  if (shots.length === 0) return null

  return (
    <div className="bg-card px-4 py-3 border-t border-border select-none">
      <div className="flex gap-4 min-w-0">

        {/* ── Track Labels (Cột tiêu đề track bên trái) ─────────────────── */}
        <div className="flex flex-col gap-3 shrink-0 w-24 border-r border-border/60 pr-2 pt-[9px] select-none">
          <div className="h-10 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
            <Film className="size-3 text-indigo-500" />
            <span>Phân cảnh</span>
          </div>
          <div className="h-9 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
            <Mic className="size-3 text-emerald-500" />
            <span>Thuyết minh</span>
          </div>
          <div className="h-6 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
            <User className="size-3 text-sky-500" />
            <span>Nhân vật</span>
          </div>
        </div>

        {/* ── Track Grid (Dải các Shot chạy dọc sang phải) ─────────────── */}
        <div className="flex-1 flex gap-2 overflow-x-auto pb-2 custom-scrollbar">
          {shots.map((shot) => {
            const hasWarning = (shot.warnings?.length || 0) > 0
            const isActive = activeShotId === shot.shot_id

            return (
              <div
                key={shot.shot_id}
                onClick={() => handleJump(shot.shot_id)}
                className={[
                  'flex flex-col gap-3 shrink-0 w-44 p-2 rounded-lg border transition-all cursor-pointer',
                  isActive
                    ? 'border-indigo-500 bg-indigo-500/5 ring-1 ring-indigo-500/20'
                    : 'border-border/60 bg-muted/20 hover:border-indigo-400/50 hover:bg-muted/40'
                ].join(' ')}
              >
                {/* Row 1: Shot Title + Funnel Pill */}
                <div className="h-10 flex flex-col justify-between relative">
                  {hasWarning && (
                    <AlertTriangle className="absolute -top-1 -right-1 size-3 text-amber-500 animate-pulse" />
                  )}
                  <span className="text-[10px] font-bold text-muted-foreground/80">
                    Shot {shot.shot_id}
                  </span>
                  {shot.funnel_part && (
                    <span className={[
                      'rounded px-1.5 py-0.5 text-[9px] font-medium border w-max max-w-full truncate',
                      funnelPillClass(shot.funnel_part)
                    ].join(' ')}>
                      {shot.funnel_part}
                    </span>
                  )}
                </div>

                {/* Row 2: Voice Over text preview */}
                <div className="h-9 text-[10px] text-muted-foreground/90 italic leading-snug line-clamp-2 bg-background/50 border border-border/20 px-1.5 py-0.5 rounded">
                  {shot.voice_over ? `"${shot.voice_over}"` : '—'}
                </div>

                {/* Row 3: Character tag */}
                <div className="h-6 flex items-center">
                  {shot.character_in_frame && shot.character_in_frame !== 'None' ? (
                    <span className="inline-flex items-center gap-1 rounded bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 text-[9px] text-sky-700 dark:text-sky-300 font-medium truncate max-w-full">
                      @{shot.character_in_frame}
                    </span>
                  ) : (
                    <span className="text-[9px] text-muted-foreground/40 italic">None</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

      </div>
    </div>
  )
}
