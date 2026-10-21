/**
 * Editor cho `WorkflowStep.action_config` JSON khi action_type='custom'.
 *
 * 2 mode:
 * - **Form preset** (recommended cho non-IT): dropdown chọn type
 *   (`CALL_N8N_WORKFLOW` / `CREATE_MOBILE_AGENT_TASK`) → render form fields
 *   tương ứng (webhook_url, goal_template, ...).
 * - **JSON advanced**: textarea raw JSON, validate syntax client-side.
 *   Cho power users / custom action types khác.
 *
 * Khi chuyển mode hoặc đổi preset → auto-fill JSON từ template.
 * Trên Save: parent đọc `value` (action_config object đã parsed).
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, AlertCircle, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  TIKTOK_ACTION_PRESETS,
  type TiktokActionPreset,
} from '@/lib/tiktokWorkflowPresets'

type ActionType = '' | 'CALL_N8N_WORKFLOW' | 'CREATE_MOBILE_AGENT_TASK' | 'OTHER'

export interface ChatbotActionConfigEditorProps {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>, isValid: boolean) => void
  className?: string
}

function presetFor(type: ActionType): TiktokActionPreset | undefined {
  if (type === 'CALL_N8N_WORKFLOW' || type === 'CREATE_MOBILE_AGENT_TASK') {
    return TIKTOK_ACTION_PRESETS.find((p) => p.id === type)
  }
  return undefined
}

function detectInitialType(value: Record<string, unknown>): ActionType {
  const t = (value?.type as string | undefined) || ''
  if (t === 'CALL_N8N_WORKFLOW' || t === 'CREATE_MOBILE_AGENT_TASK') return t
  if (t) return 'OTHER'
  return ''
}

export function ChatbotActionConfigEditor({
  value,
  onChange,
  className,
}: ChatbotActionConfigEditorProps) {
  const [actionType, setActionType] = useState<ActionType>(() => detectInitialType(value))
  const [jsonText, setJsonText] = useState<string>(() =>
    Object.keys(value || {}).length > 0 ? JSON.stringify(value, null, 2) : '{}',
  )
  const [parseError, setParseError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(true)

  // Validate JSON on every change of jsonText
  useEffect(() => {
    try {
      const parsed = JSON.parse(jsonText)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setParseError('Phải là JSON object {...}')
        onChange({}, false)
        return
      }
      setParseError(null)
      onChange(parsed as Record<string, unknown>, true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setParseError(`JSON sai cú pháp: ${msg}`)
      onChange({}, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsonText])

  function applyPreset(type: ActionType) {
    setActionType(type)
    if (type === 'CALL_N8N_WORKFLOW' || type === 'CREATE_MOBILE_AGENT_TASK') {
      const preset = presetFor(type)
      if (preset) {
        setJsonText(JSON.stringify(preset.actionConfig, null, 2))
      }
    } else if (type === '') {
      setJsonText('{}')
    }
    // 'OTHER' → giữ jsonText hiện tại
  }

  const preset = useMemo(() => presetFor(actionType), [actionType])

  return (
    <fieldset className={cn(
      'rounded-lg border border-pink-300 bg-pink-50/40 p-4 dark:border-pink-700/50 dark:bg-pink-900/10',
      className,
    )}>
      <legend className="px-1 text-sm font-semibold text-pink-900 dark:text-pink-100">
        🎯 Cấu hình action (Chatbot TikTok / Custom)
      </legend>

      <div className="mt-2 flex flex-col gap-3">
        {/* Dropdown: action type preset */}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Loại action</span>
          <select
            value={actionType}
            onChange={(e) => applyPreset(e.target.value as ActionType)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">-- Chọn loại action --</option>
            <option value="CALL_N8N_WORKFLOW">
              📞 Gọi n8n workflow (gen reply / xử lý ngoài)
            </option>
            <option value="CREATE_MOBILE_AGENT_TASK">
              🤖 Tạo Mobile Agent task (worker gõ tin trên phone)
            </option>
            <option value="OTHER">⚙️ Custom JSON khác (advanced)</option>
          </select>
          {preset && (
            <span className="text-xs text-muted-foreground">{preset.description_vi}</span>
          )}
        </label>

        {/* JSON textarea */}
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            {showAdvanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            <span>JSON action_config (chỉnh sửa trực tiếp)</span>
          </button>
          {showAdvanced && (
            <>
              <textarea
                rows={16}
                spellCheck={false}
                className={cn(
                  'rounded-lg border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring',
                  parseError ? 'border-destructive' : 'border-border',
                )}
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                placeholder='{\n  "type": "CALL_N8N_WORKFLOW",\n  "webhook_url": "..."\n}'
              />
              <div className="flex items-center gap-1.5 text-xs">
                {parseError ? (
                  <>
                    <AlertCircle className="size-3.5 text-destructive" />
                    <span className="text-destructive">{parseError}</span>
                  </>
                ) : (
                  <>
                    <Check className="size-3.5 text-green-600" />
                    <span className="text-green-600">JSON hợp lệ ✓</span>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Per-type quick hints */}
        {actionType === 'CALL_N8N_WORKFLOW' && (
          <p className="text-xs text-muted-foreground">
            💡 <strong>Cần chỉnh</strong>: <code>webhook_url</code> (URL n8n production của bạn) +
            các template variable <code>{`{{ trigger.X }}`}</code> tham chiếu payload trigger.
          </p>
        )}
        {actionType === 'CREATE_MOBILE_AGENT_TASK' && (
          <p className="text-xs text-muted-foreground">
            💡 <strong>Cần chỉnh</strong>: <code>goal_template</code> (instruction cho Mobile Agent) +
            <code>extra_payload</code> (data gửi cho worker). Template variable <code>{`{{ context.step0.reply_text }}`}</code> trỏ output Step trước.
          </p>
        )}
      </div>
    </fieldset>
  )
}
