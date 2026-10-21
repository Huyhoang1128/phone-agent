/**
 * Hint card cho user khi cấu hình Workflow TikTok trong [WorkflowDetailPage].
 *
 * Hiển thị 2 mode:
 * - `mode='trigger'` — list event_type preset + JSON `event_filter` để copy.
 * - `mode='action'` — list action template (n8n / mobile agent) + JSON
 *   `action_config` để copy.
 *
 * Backend chưa expose UI text-edit cho 2 field này — user copy JSON rồi paste
 * qua Django admin / API tạm thời cho MVP M. Phase L sẽ build visual editor.
 */
import { useState } from 'react'
import { Music2, Copy, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  TIKTOK_EVENT_TYPE_PRESETS,
  TIKTOK_ACTION_PRESETS,
} from '@/lib/tiktokWorkflowPresets'

interface TiktokWorkflowHintProps {
  mode: 'trigger' | 'action'
  className?: string
}

function CopyableJson({ value, label }: { value: unknown; label: string }) {
  const [copied, setCopied] = useState(false)
  const json = JSON.stringify(value, null, 2)
  function copy() {
    void navigator.clipboard.writeText(json).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="rounded-md border border-border bg-muted/40">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-muted"
        >
          {copied
            ? (<><Check className="size-3 text-green-600" /> Đã copy</>)
            : (<><Copy className="size-3" /> Copy</>)}
        </button>
      </div>
      <pre className="overflow-x-auto px-2 py-1 text-[11px] leading-snug">
        <code>{json}</code>
      </pre>
    </div>
  )
}

export function TiktokWorkflowHint({ mode, className }: TiktokWorkflowHintProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className={cn('rounded-lg border border-pink-300 bg-pink-50 dark:border-pink-700/50 dark:bg-pink-900/10', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-pink-900 dark:text-pink-100"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <Music2 className="size-4" />
        {mode === 'trigger'
          ? 'TikTok preset: event_filter (Chatbot DM/Comment)'
          : 'TikTok preset: action_config (gọi n8n + tạo Mobile Agent task)'}
      </button>

      {open && (
        <div className="space-y-3 border-t border-pink-300 px-3 py-3 dark:border-pink-700/50">
          {mode === 'trigger' && (
            <>
              <p className="text-xs text-muted-foreground">
                Khi cấu hình Trigger với <code className="font-mono">event = device.notify</code>,
                paste 1 trong các JSON dưới vào <code className="font-mono">event_filter</code> của
                trigger qua admin/API. Backend (Phase 2.1) tự classify notification → match filter.
              </p>
              {TIKTOK_EVENT_TYPE_PRESETS.map((p) => (
                <div key={p.id} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold">{p.label_vi}</span>
                    <span className="text-[11px] text-muted-foreground">{p.id}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{p.description_vi}</p>
                  <CopyableJson value={p.eventFilter} label="event_filter" />
                </div>
              ))}
            </>
          )}

          {mode === 'action' && (
            <>
              <p className="text-xs text-muted-foreground">
                Khi action_type = <code className="font-mono">custom</code>, paste 1 trong các JSON
                dưới vào <code className="font-mono">action_config</code> của step qua admin/API.
                Backend Phase 2.2 dispatcher đọc <code className="font-mono">action_config.type</code> → chạy handler tương ứng.
              </p>
              {TIKTOK_ACTION_PRESETS.map((p) => (
                <div key={p.id} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold">{p.label_vi}</span>
                    <span className="text-[11px] text-muted-foreground">{p.id}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{p.description_vi}</p>
                  <CopyableJson value={p.actionConfig} label="action_config" />
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
