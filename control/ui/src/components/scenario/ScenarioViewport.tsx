/**
 * v3.2.2 Phase 3 — Storyboard Viewport Canvas (CapCut/TikTok style 9:16).
 * 
 * Mô phỏng trực quan phân cảnh kịch bản đang chọn:
 * - Gradient màu nền động dựa theo bối cảnh.
 * - Icon hình học động biểu thị tư thế/hành động chính.
 * - Hiển thị phụ đề chạy dọc đồng bộ với voice_over.
 */
import { useMemo } from 'react'
import { Film, Smartphone, Volume2 } from 'lucide-react'

import type { ScenarioShot } from '@/lib/types'

interface Props {
  shot: ScenarioShot | undefined
}

export function ScenarioViewport({ shot }: Props) {
  const { bgClass, lightingOverlay } = useMemo(() => {
    if (!shot) return { bgClass: 'from-slate-900 to-indigo-950', lightingOverlay: '' }

    const bgLower = (shot.background || '').toLowerCase()
    const lightLower = (shot.texture_and_lighting || '').toLowerCase()

    let bg = 'from-slate-900 to-indigo-950'
    let overlay = ''

    // Map keywords to background gradients
    if (bgLower.includes('bếp') || bgLower.includes('kitchen') || bgLower.includes('sữa chua') || bgLower.includes('yoghurt')) {
      bg = 'from-amber-100/30 via-orange-100/20 to-amber-200/10 dark:from-amber-950/40 dark:to-orange-950/20'
    } else if (bgLower.includes('phòng khám') || bgLower.includes('clinic') || bgLower.includes('bác sĩ') || bgLower.includes('doctor')) {
      bg = 'from-teal-100/30 via-cyan-100/20 to-teal-200/10 dark:from-teal-950/40 dark:to-cyan-950/20'
    } else if (bgLower.includes('phòng khách') || bgLower.includes('living') || bgLower.includes('coffee') || bgLower.includes('cafe')) {
      bg = 'from-amber-200/20 via-stone-100/10 to-stone-200/10 dark:from-amber-950/30 dark:to-stone-900/60'
    } else if (bgLower.includes('phòng ngủ') || bgLower.includes('bedroom') || bgLower.includes('tối') || bgLower.includes('đêm')) {
      bg = 'from-slate-950 via-slate-900 to-blue-950/60'
    }

    // Map keywords to lighting overlays
    if (lightLower.includes('tự nhiên') || lightLower.includes('nắng') || lightLower.includes('sáng')) {
      overlay = 'bg-gradient-to-tr from-transparent via-white/5 to-white/20'
    } else if (lightLower.includes('ấm') || lightLower.includes('tone ấm')) {
      overlay = 'bg-amber-500/10'
    } else if (lightLower.includes('neon') || lightLower.includes('tối')) {
      overlay = 'bg-indigo-500/10'
    }

    return { bgClass: bg, lightingOverlay: overlay }
  }, [shot])

  const characterPoseMarkup = useMemo(() => {
    if (!shot) return null
    const pLower = (shot.character_pose || '').toLowerCase()
    const aLower = (shot.kinetic_action || '').toLowerCase()

    // Smiling face avatar
    if (pLower.includes('cười') || pLower.includes('mỉm cười') || aLower.includes('cười') || aLower.includes('mỉm cười')) {
      return (
        <div className="flex flex-col items-center gap-2">
          <svg className="w-14 h-14 text-indigo-500 dark:text-indigo-400 drop-shadow-md animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" strokeLinecap="round" />
            <line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          <span className="text-[9px] uppercase tracking-wider font-semibold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-full">Smiling</span>
        </div>
      )
    }

    // Scooping/Pouring hands
    if (aLower.includes('đổ') || aLower.includes('múc') || aLower.includes('rót') || aLower.includes('cầm')) {
      return (
        <div className="flex flex-col items-center gap-2">
          <svg className="w-16 h-16 text-amber-600 dark:text-amber-400 drop-shadow-md" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 11h16a1 1 0 0 1 1 1v2a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6v-2a1 1 0 0 1 1-1z" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 4c1-1 3 0 3 2s-1 3-3 2c-1.5 1.5-2 3-2 3l-1.5-1.5s1.5-.5 3.5-3.5z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[9px] uppercase tracking-wider font-semibold text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full">Pouring / scooping</span>
        </div>
      )
    }

    // Sitting pose
    if (pLower.includes('ngồi')) {
      return (
        <div className="flex flex-col items-center gap-2">
          <svg className="w-14 h-14 text-teal-600 dark:text-teal-400 drop-shadow-md" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="5" r="2.5" />
            <path d="M12 7.5v6.5h3.5m-3.5 0v3.5h-2.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M7.5 14h4.5" strokeLinecap="round" />
          </svg>
          <span className="text-[9px] uppercase tracking-wider font-semibold text-teal-500 bg-teal-500/10 px-2 py-0.5 rounded-full">Sitting</span>
        </div>
      )
    }

    // Default standing figure
    return (
      <div className="flex flex-col items-center gap-2">
        <svg className="w-14 h-14 text-slate-500 dark:text-slate-400 drop-shadow-md" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M18 21a6 6 0 0 0-12 0" strokeLinecap="round" />
          <circle cx="12" cy="10" r="4" />
          <path d="M12 2v4" strokeLinecap="round" />
        </svg>
        <span className="text-[9px] uppercase tracking-wider font-semibold text-slate-500 bg-slate-500/10 px-2 py-0.5 rounded-full">Active scene</span>
      </div>
    )
  }, [shot])

  return (
    <div className="w-full bg-card border-b border-border p-3 flex justify-center items-center gap-6 select-none relative overflow-hidden shrink-0">

      {/* ── Viewport screen (9:16) ─────────────────────────────────────── */}
      <div className="relative w-44 h-72 rounded-2xl border-4 border-slate-950 dark:border-slate-800 bg-black shadow-2xl overflow-hidden flex flex-col justify-between p-3 shrink-0">

        {/* Top meta tags */}
        <div className="flex justify-between items-center z-10">
          <span className="bg-slate-950/80 text-[8px] text-white/80 font-bold px-1.5 py-0.5 rounded-md backdrop-blur-sm">
            {shot ? `SHOT ${shot.shot_id}` : 'NO SHOT'}
          </span>
          <span className="bg-indigo-600/80 text-[8px] text-white font-bold px-1.5 py-0.5 rounded-md backdrop-blur-sm">
            9:16 Live
          </span>
        </div>

        {/* Dynamic gradient background */}
        <div className={`absolute inset-0 bg-gradient-to-b ${bgClass} transition-all duration-300`} />

        {/* Dynamic lighting overlay */}
        {lightingOverlay && <div className={`absolute inset-0 ${lightingOverlay} transition-all duration-300 pointer-events-none`} />}

        {/* Center illustration */}
        <div className="flex-1 flex items-center justify-center z-10">
          {shot ? characterPoseMarkup : (
            <div className="flex flex-col items-center gap-1.5 text-muted-foreground/40">
              <Smartphone className="size-8 stroke-[1]" />
              <span className="text-[10px] italic">No active viewport</span>
            </div>
          )}
        </div>

        {/* Live Subtitles overlay */}
        <div className="z-10 bg-black/60 backdrop-blur-sm p-1.5 rounded-lg border border-white/5 text-center min-h-[36px] flex items-center justify-center">
          <p className="text-[9px] leading-relaxed text-amber-300 font-medium line-clamp-2">
            {shot?.voice_over ? `"${shot.voice_over}"` : '...'}
          </p>
        </div>
      </div>

      {/* ── Viewport Metadata Panel (Cột mô tả bối cảnh bên phải) ──────── */}
      <div className="flex-1 min-w-0 max-w-sm self-stretch flex flex-col justify-between py-1 text-xs">
        <div className="space-y-2.5">
          <div className="flex items-center gap-1.5">
            <Film className="size-3.5 text-indigo-500" />
            <span className="font-semibold text-foreground uppercase text-[10px] tracking-wide">
              Storyboard Inspector
            </span>
          </div>

          {shot ? (
            <div className="space-y-1.5">
              <div>
                <span className="text-[9px] font-bold text-muted-foreground uppercase block">Bối cảnh:</span>
                <span className="text-foreground font-medium text-[11px] block truncate">{shot.background || '—'}</span>
              </div>
              <div>
                <span className="text-[9px] font-bold text-muted-foreground uppercase block">Tư thế nhân vật:</span>
                <span className="text-foreground font-medium text-[11px] block truncate">{shot.character_pose || '—'}</span>
              </div>
              <div className="flex gap-4">
                <div>
                  <span className="text-[9px] font-bold text-muted-foreground uppercase block">Ánh sáng:</span>
                  <span className="text-foreground font-medium text-[11px] block truncate">{shot.texture_and_lighting || '—'}</span>
                </div>
                <div>
                  <span className="text-[9px] font-bold text-muted-foreground uppercase block">Âm thanh/Nhạc:</span>
                  <span className="text-foreground font-medium text-[11px] block truncate">{shot.music_hint || '—'}</span>
                </div>
              </div>
            </div>
          ) : (
            <p className="italic text-muted-foreground/60 text-[11px]">
              Chưa có phân cảnh nào được chọn để hiển thị thông số camera.
            </p>
          )}
        </div>

        {shot?.voice_over && (
          <div className="mt-2 bg-muted/30 p-2 rounded-lg border border-border/40 flex items-start gap-1.5">
            <Volume2 className="size-3.5 text-indigo-500 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <span className="text-[8px] font-bold text-indigo-600 dark:text-indigo-400 uppercase block tracking-wider">Voiceover Track</span>
              <p className="text-[11px] text-muted-foreground italic truncate">{shot.voice_over}</p>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}
