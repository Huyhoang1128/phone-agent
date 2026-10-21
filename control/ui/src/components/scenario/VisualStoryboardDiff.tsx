import { useState } from 'react'
import { AlertTriangle, Check, Clock, X, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ScenarioPatch, DataImpactClass } from '@/lib/types'

interface VisualStoryboardDiffProps {
  patch: ScenarioPatch
  onApply: (p: ScenarioPatch) => Promise<boolean>
  state?: 'idle' | 'applying' | 'applied' | 'error' | 'discarded'
  onStateChange?: (s: 'idle' | 'applying' | 'applied' | 'error' | 'discarded') => void
  disabled?: boolean
}

const PROPERTY_LABELS: Record<string, string> = {
  background: 'Setting bối cảnh',
  character_pose: 'Diễn xuất & Pose',
  kinetic_action: 'Động tác nhân vật',
  camera_articulation: 'Cú máy & Góc máy',
  voice_over: 'Lời thoại (Voice Over)',
  music_hint: 'Nhạc nền / Âm nhạc',
  funnel_part: 'Phần phễu Marketing',
  brand_mention: 'Nhắc thương hiệu',
  prop_description: 'Đạo cụ trong khung hình',
  texture_and_lighting: 'Ánh sáng & Màu sắc',
  continuity_mode: 'Chế độ liền mạch',
  name: 'Tên nhân vật',
  age: 'Độ tuổi',
  outfit_style: 'Trang phục',
  voice_id_hint: 'Giọng nói (Voice ID)',
  ethnicity: 'Ngoại hình / Sắc tộc',
}

export function VisualStoryboardDiff({
  patch,
  onApply,
  state: propState,
  onStateChange,
  disabled = false,
}: VisualStoryboardDiffProps) {
  const [localState, setLocalState] = useState<'idle' | 'applying' | 'applied' | 'error' | 'discarded'>('idle')
  const state = propState !== undefined ? propState : localState

  const setState = (s: 'idle' | 'applying' | 'applied' | 'error' | 'discarded') => {
    if (onStateChange) {
      onStateChange(s)
    } else {
      setLocalState(s)
    }
  }

  async function handleApply() {
    setState('applying')
    const ok = await onApply(patch)
    setState(ok ? 'applied' : 'error')
    if (!ok) {
      setTimeout(() => setState('idle'), 2000)
    }
  }

  const isApplied = state === 'applied'
  const isApplying = state === 'applying'
  const isDiscarded = state === 'discarded'

  if (isDiscarded) {
    return (
      <div className="w-full text-center text-xs text-muted-foreground italic py-1 border border-dashed border-border rounded-lg bg-muted/10">
        Đã bỏ qua đề xuất chỉnh sửa phân cảnh này
      </div>
    )
  }

  const before = (patch.before || {}) as Record<string, any>
  const after = (patch.after || {}) as Record<string, any>
  const changedKeys = Object.keys(after).filter((k) => {
    const b = String(before[k] ?? '').trim()
    const a = String(after[k] ?? '').trim()
    return a && a !== b
  })

  if (changedKeys.length === 0) {
    return null
  }

  // Phân loại mức tác động (safe / expensive / destructive)
  // safe: chỉ đổi pose, thoại, ánh sáng
  // expensive: đổi camera movement lớn hoặc nhạc nền
  // destructive: xóa nhân vật, đổi bối cảnh cấu trúc
  const hasBackgroundChange = changedKeys.includes('background')
  const hasVoiceOverChange = changedKeys.includes('voice_over')
  
  const impact: DataImpactClass = hasBackgroundChange 
    ? 'destructive' 
    : (hasVoiceOverChange ? 'expensive' : 'safe')

  const borderStyles = {
    safe: 'border-sky-300 dark:border-sky-800 bg-sky-50/25 dark:bg-sky-950/5',
    expensive: 'border-amber-300 dark:border-amber-800 bg-amber-50/25 dark:bg-amber-950/5',
    destructive: 'border-red-300 dark:border-red-800 bg-red-50/25 dark:bg-red-950/5',
  }[impact]

  const badgeStyles = {
    safe: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    expensive: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    destructive: 'bg-red-500/10 text-red-600 dark:text-red-400',
  }[impact]

  const impactLabel = {
    safe: 'Đề xuất nghệ thuật (An toàn)',
    expensive: 'Tối ưu âm thoại (Trung bình)',
    destructive: 'Thay đổi bối cảnh lớn (Cần duyệt kỹ)',
  }[impact]

  const ImpactIcon = {
    safe: Zap,
    expensive: Clock,
    destructive: AlertTriangle,
  }[impact]

  return (
    <div className={`w-full rounded-xl border ${borderStyles} overflow-hidden shadow-sm transition-all duration-200 mt-2`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/65">
        <div className="flex items-center gap-1.5">
          <ImpactIcon className="size-3.5" />
          <span className="text-[11px] font-semibold">
            {patch.kind === 'shot'
              ? `Đề xuất chỉnh sửa Shot ${patch.shot_id}`
              : `Chỉnh sửa Nhân vật "${patch.character_name}"`}
          </span>
        </div>
        <span className={`text-[9px] font-medium px-2 py-0.5 rounded-full ${badgeStyles}`}>
          {impactLabel}
        </span>
      </div>

      {/* Side-by-side comparison table */}
      <div className="divide-y divide-border/60 bg-card/40">
        {changedKeys.map((key) => {
          const label = PROPERTY_LABELS[key] || key
          const oldValue = String(before[key] || '').trim() || '(Trống)'
          const newValue = String(after[key] || '').trim()

          return (
            <div key={key} className="p-2.5 text-xs">
              <div className="font-semibold text-[10px] text-muted-foreground uppercase mb-1">
                {label}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {/* Old value column */}
                <div className="rounded border border-red-200/50 bg-red-500/5 p-2 text-muted-foreground leading-relaxed dark:border-red-950/20">
                  <div className="text-[9px] font-bold text-red-500 mb-0.5 uppercase">✕ Hiện tại</div>
                  <div className="line-through opacity-85">{oldValue}</div>
                </div>

                {/* New value column */}
                <div className="rounded border border-emerald-200/50 bg-emerald-500/5 p-2 text-foreground leading-relaxed dark:border-emerald-950/20">
                  <div className="text-[9px] font-bold text-emerald-500 mb-0.5 uppercase">✅ Đề xuất đạo diễn</div>
                  <div className="font-medium">{newValue}</div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Action footer */}
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border bg-card/65">
        {isApplied ? (
          <div className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
            <Check className="size-4 animate-bounce" />
            Đã áp dụng thay đổi thành công
          </div>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setState('discarded')}
              disabled={isApplying || disabled}
              className="h-7 text-[10px] text-muted-foreground hover:text-red-500 px-2"
            >
              <X className="size-3 mr-1" />
              Bỏ qua đề xuất
            </Button>
            <Button
              size="sm"
              onClick={handleApply}
              disabled={isApplying || disabled}
              className="h-7 text-[10px] bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-3.5"
            >
              {isApplying ? (
                <>
                  <Clock className="size-3 animate-spin mr-1" />
                  Đang xử lý...
                </>
              ) : (
                <>
                  <Check className="size-3 mr-1" />
                  Áp dụng thay đổi
                </>
              )}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
