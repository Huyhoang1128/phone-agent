/**
 * Phase 2.3.7 — preset templates cho user khi cấu hình Workflow TikTok.
 *
 * Backend reference:
 * - `mobile-control/tiktok/notification_presets.yaml` (Phase 2.1) định nghĩa
 *   event_type catalog. Khi 1 thông báo TikTok đến → matcher gán event_type
 *   → enrich vào payload `dispatch_event` → `WorkflowTrigger.event_filter`
 *   deep-match `{event_type: 'tiktok_dm'}` → tạo WorkflowRun.
 * - `mobile-control/workflow/runner/actions/n8n.py` (Phase 2.2) action
 *   `CALL_N8N_WORKFLOW` schema.
 * - `mobile-control/workflow/runner/actions/mobile_agent.py` (Phase 2.2) action
 *   `CREATE_MOBILE_AGENT_TASK` schema.
 *
 * UI chưa cho edit event_filter / action_config trực tiếp; user copy JSON từ
 * preset rồi paste qua admin/API. Phase L sẽ build full visual editor.
 */

export interface TiktokEventTypePreset {
  id: string
  label_vi: string
  // event_filter JSON để gán vào WorkflowTrigger
  eventFilter: Record<string, unknown>
  description_vi: string
}

export const TIKTOK_EVENT_TYPE_PRESETS: TiktokEventTypePreset[] = [
  {
    id: 'tiktok_dm',
    label_vi: 'TikTok – Tin nhắn DM mới',
    eventFilter: { event_type: 'tiktok_dm' },
    description_vi: 'Khách inbox cho tài khoản bot. Phổ biến nhất.',
  },
  {
    id: 'tiktok_comment_single',
    label_vi: 'TikTok – Bình luận trên video bot',
    eventFilter: { event_type: 'tiktok_comment_single' },
    description_vi: 'Comment cụ thể trên video do bot đăng.',
  },
  {
    id: 'tiktok_comment_batch',
    label_vi: 'TikTok – Tổng hợp nhiều bình luận',
    eventFilter: { event_type: 'tiktok_comment_batch' },
    description_vi: 'Thông báo gộp "Bạn có N bình luận mới".',
  },
  {
    id: 'tiktok_follow',
    label_vi: 'TikTok – Có follower mới',
    eventFilter: { event_type: 'tiktok_follow' },
    description_vi: 'User mới follow bot. MVP M chưa auto thank-you DM.',
  },
]

export interface TiktokActionPreset {
  id: 'CALL_N8N_WORKFLOW' | 'CREATE_MOBILE_AGENT_TASK'
  label_vi: string
  description_vi: string
  // action_config JSON skeleton — user fill in webhook_url / goal_template
  actionConfig: Record<string, unknown>
}

export const TIKTOK_ACTION_PRESETS: TiktokActionPreset[] = [
  {
    id: 'CALL_N8N_WORKFLOW',
    label_vi: 'Gọi n8n webhook (gen reply)',
    description_vi: 'POST tới n8n workflow để generate reply text. Đặt step TRƯỚC khi gửi tin.',
    actionConfig: {
      type: 'CALL_N8N_WORKFLOW',
      webhook_url: 'https://n8n.example.com/webhook/tiktok-dm-reply',
      timeout_seconds: 120,
      retry_count: 3,
      retry_backoff_seconds: [2, 5, 10],
      payload_template: {
        device_id: '{{ trigger.event_source_id }}',
        peer_handle: '{{ trigger.peer_handle }}',
        current_message: '{{ trigger.content }}',
        conversation_history: '{{ trigger.history }}',
        brand_voice: 'Thân thiện, chuyên nghiệp, kêu gọi inbox',
      },
      response_mapping: {
        reply_text: '$.reply_text',
      },
    },
  },
  {
    id: 'CREATE_MOBILE_AGENT_TASK',
    label_vi: 'Tạo task Mobile Agent (gửi tin DM)',
    description_vi: 'Đặt SAU step gọi n8n. Mobile agent sẽ mở app TikTok và gõ reply.',
    actionConfig: {
      type: 'CREATE_MOBILE_AGENT_TASK',
      agent: 'tiktok',
      duration_minutes: 3,
      name_template: 'TikTok auto-reply DM {{ trigger.peer_handle }}',
      goal_template: [
        'Mở app TikTok, vào hộp thư.',
        'Tìm conversation với "{{ trigger.peer_handle }}".',
        'Đọc 3 tin nhắn gần nhất.',
        'NẾU tin cuối từ bạn (bot) trùng với "{{ context.step1.reply_text }}" (case-insensitive, trim)',
        '  → KHÔNG GỬI, báo result: SKIPPED_ALREADY_SENT.',
        'NGƯỢC LẠI → gõ "{{ context.step1.reply_text }}" rồi bấm send.',
        'Sau khi gửi, đọc lại để confirm tin xuất hiện. Báo result: SENT_CONFIRMED.',
      ].join('\n'),
      extra_payload: {
        peer_handle: '{{ trigger.peer_handle }}',
        reply_text: '{{ context.step1.reply_text }}',
        channel: 'tiktok_dm',
      },
    },
  },
]
