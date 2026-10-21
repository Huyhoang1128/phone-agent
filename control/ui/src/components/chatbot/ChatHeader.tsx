/**
 * Header chat detail: peer name + status indicator (Active / Paused) + Pause AI
 * button (Phase 2.3.6).
 *
 * Pause UX (theo OQ#3 chốt): 1-click default 24h, dropdown nhỏ cho 1h/24h/7d/∞.
 */
import { useState } from 'react'
import { ShieldOff, Shield, ChevronDown, Loader2 } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { tiktokInboxApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { TiktokConversationDetail } from '@/lib/types'

interface DurationOption {
  label: string
  // Số giờ, null = vô thời hạn
  hours: number | null
}

const DURATION_OPTIONS: DurationOption[] = [
  { label: '1 giờ', hours: 1 },
  { label: '24 giờ (mặc định)', hours: 24 },
  { label: '7 ngày', hours: 24 * 7 },
  { label: 'Vô thời hạn', hours: null },
]

function computeMutedUntil(hours: number | null): string | null {
  if (hours == null) return null
  const d = new Date(Date.now() + hours * 3600 * 1000)
  return d.toISOString()
}

export interface ChatHeaderProps {
  detail: TiktokConversationDetail | null
  isLoading: boolean
}

export function ChatHeader({ detail, isLoading }: ChatHeaderProps) {
  const qc = useQueryClient()
  const [menuOpen, setMenuOpen] = useState(false)

  const muteMutation = useMutation({
    mutationFn: (hours: number | null) => tiktokInboxApi.createPeerMute({
      device: detail!.device_id,
      peer_handle: detail!.peer_handle,
      muted_until: computeMutedUntil(hours),
      note: hours == null ? 'Pause vô thời hạn từ UI' : `Pause ${hours}h từ UI`,
    }),
    onSuccess: () => {
      setMenuOpen(false)
      qc.invalidateQueries({ queryKey: ['tiktok-conv-detail', detail?.device_id, detail?.peer_handle] })
      qc.invalidateQueries({ queryKey: ['tiktok-conversations', detail?.device_id] })
    },
  })

  const unmuteMutation = useMutation({
    mutationFn: () => tiktokInboxApi.deletePeerMute(detail!.mute_id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tiktok-conv-detail', detail?.device_id, detail?.peer_handle] })
      qc.invalidateQueries({ queryKey: ['tiktok-conversations', detail?.device_id] })
    },
  })

  if (isLoading || !detail) {
    return (
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="size-9 animate-pulse rounded-full bg-muted" />
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      </div>
    )
  }

  const isMuted = detail.is_muted
  const indicator = isMuted ? '⏸' : '🟢'
  const status = isMuted ? 'AI Đang tạm dừng' : 'AI Đang hoạt động'

  return (
    <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-base font-semibold">
        {detail.peer_handle.charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{detail.peer_handle}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{indicator}</span>
          <span>{status}</span>
          <span>·</span>
          <span>{detail.message_count} tin</span>
        </div>
      </div>

      {isMuted ? (
        <button
          onClick={() => unmuteMutation.mutate()}
          disabled={unmuteMutation.isPending}
          className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          title={detail.mute_note || 'Bỏ tạm dừng AI cho peer này'}
        >
          {unmuteMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Shield className="size-3.5" />}
          Bật lại AI
        </button>
      ) : (
        <div className="relative">
          <button
            onClick={() => menuOpen ? muteMutation.mutate(24) : setMenuOpen(true)}
            disabled={muteMutation.isPending}
            className="flex items-center gap-1.5 rounded-md bg-yellow-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-600 disabled:opacity-50"
            title="Tạm dừng AI auto-reply cho peer này (mặc định 24h)"
          >
            {muteMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldOff className="size-3.5" />}
            Tạm dừng AI
            <ChevronDown
              className={cn('size-3.5 transition-transform', menuOpen && 'rotate-180')}
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}
            />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-44 rounded-md border border-border bg-popover shadow-lg">
              {DURATION_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => muteMutation.mutate(opt.hours)}
                  disabled={muteMutation.isPending}
                  className="block w-full px-3 py-2 text-left text-xs hover:bg-muted"
                >
                  {opt.label}
                </button>
              ))}
              <button
                onClick={() => setMenuOpen(false)}
                className="block w-full border-t border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted"
              >
                Hủy
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
