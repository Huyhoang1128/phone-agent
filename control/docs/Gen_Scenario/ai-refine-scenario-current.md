# AI Refine của AI Scenario — Thiết kế & Luồng hoạt động HIỆN TRẠNG

> **Mục đích**: tài liệu này mô tả ĐÚNG NHƯ CODE đang chạy trên branch `feature/ai-scenario-v3.2.2`
> (commits Phase 0-3 + Phase 4 hotfix + 3D TRUE cancel, hiện uncommitted local). Dùng để **bàn giao**
> cho người khác làm tiếp.
>
> **Phân biệt**: "AI Refine của AI Scenario" = chat panel bên trái trang
> [`/content-scenarios/:id`](../../ui/src/pages/ContentScenarioDetailPage.tsx) và
> [`/content-scenarios/draft`](../../ui/src/pages/ContentScenarioDraftPage.tsx).
> KHÔNG nhầm với `ai-refine-system.md` (v1 cũ — Content/frames qua n8n).
>
> Ngày cập nhật: 2026-06-02.

---

## Mục lục

- [0. TL;DR cho người mới](#0-tldr-cho-người-mới)
- [1. Versions roadmap &amp; vị trí v3.2.2](#1-versions-roadmap--vị-trí-v322)
- [2. Hai trang dùng AI Refine](#2-hai-trang-dùng-ai-refine)
- [3. Big picture — 3 panel layout](#3-big-picture--3-panel-layout)
- [4. End-to-end flow — 1 lượt chat](#4-end-to-end-flow--1-lượt-chat)
- [5. Toolkit 20 tools — chi tiết](#5-toolkit-20-tools--chi-tiết)
- [6. Context Engine 3 lớp](#6-context-engine-3-lớp)
- [7. Plan &amp; Execute](#7-plan--execute)
- [8. Approval contract — Safe/Destructive/Expensive](#8-approval-contract--safedestructiveexpensive)
- [9. Anti-Hallucinate Pattern (Phase 4)](#9-anti-hallucinate-pattern-phase-4)
- [10. 3D — TRUE cancel pipeline qua Redis](#10-3d--true-cancel-pipeline-qua-redis)
- [11. Telemetry — AiRefineEvent](#11-telemetry--airefineevent)
- [12. Persona prompt structure](#12-persona-prompt-structure)
- [13. DB schema](#13-db-schema)
- [14. API endpoints](#14-api-endpoints)
- [15. Frontend components](#15-frontend-components)
- [16. Patch merge BE post-process](#16-patch-merge-be-post-process)
- [17. Multi-tenant brand voice](#17-multi-tenant-brand-voice)
- [18. Multi-model infra](#18-multi-model-infra)
- [19. Known issues / future patches (v3.2.3+)](#19-known-issues--future-patches-v323)
- [20. Files map](#20-files-map)

---

## 0. TL;DR cho người mới

- **AI Refine = chat panel bên trái + 20 tool** AI có thể gọi để refine kịch bản (gồm shot + character + plan + scoring + meta).
- AI có **Context Engine 3 lớp** (Layer 1 summary + Layer 2 focus + Layer 3 retrieval) → không còn "đoán mò" về camera/lighting/pose.
- AI có thể **lập plan nhiều bước** (`propose_plan`) cho yêu cầu phức tạp ("tăng chiều sâu nhân vật cho toàn kịch bản") → FE render PlanCard với numbered steps → user approve → BE execute sequential.
- **Approval reframe** từ "dangerous tool labels" → **3 nhóm theo data impact**: Safe (auto execute) / Destructive (modal confirm) / Expensive (modal + cost warning).
- **Anti-Hallucinate Pattern (Phase 4)**: AI BẮT BUỘC gọi tool khi user dùng động từ hành động (xoá/sửa/thêm/đổi/...) — `tool_choice='required'` + `respond_with_text` tool cho trường hợp text-only.
- **3D TRUE cancel**: user click "Hủy" trong khi AI đang generate → BE SET Redis flag → orchestrator raise `ScenarioCancelled` ở layer boundary tiếp theo → return HTTP 499 → tiết kiệm ~50-70% LLM cost.
- **Telemetry `AiRefineEvent`**: mỗi turn chat log tool_names, tokens, latency, loop_iterations.

---

## 1. Versions roadmap & vị trí v3.2.2

Roadmap chính thức ([§3 doc gốc](ai-scenario-v3-thiet-ke.md#3-roadmap-các-v)):

```
v3.1 MVP ──► v3.2 ──► v3.3 (RESERVED) ──► v4 (RESERVED)
generate    refine    Media Server         DirectorAgent
JSON        toolkit   real_footage         render video
```

| Version          | Status                                           | Nội dung                                                                                               |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| v3.1             | ✅ Shipped                                       | Generate JSON MVP                                                                                       |
| v3.2             | ✅ Merged PR #296                                | Refine toolkit (insert/delete/reorder/optimize_whole), cap I=2, export xlsx                             |
| v3.2.1           | ✅ Shipped                                       | AI Director Mode HYBRID (Agno + ReAct + SSE — 5 phase)                                                 |
| **v3.2.2** | **🚧 Current branch — uncommitted local** | **AI Refine upgrade: Context Engine + Plan&Execute + Toolset patch + Anti-Hallucinate + Scoring** |
| 3D               | **🚧 Merged vào v3.2.2 working dir**      | TRUE cancel pipeline qua Redis                                                                          |
| v3.2.3+          | Reserved                                         | Future patches — xem §19                                                                              |
| v3.3             | Reserved                                         | Media Server (KHÔNG dùng cho AI Refine)                                                               |
| v4               | Reserved                                         | Render video DirectorAgent (KHÔNG dùng)                                                               |

**Branch hiện tại**: `feature/ai-scenario-v3.2.2`.
**Commits đã ship local** (chưa push):

```
c87664e feat(v3.2.2/phase3): Measurable cross-shot scoring (scan_scenario)
afcfb57 feat(v3.2.2/phase2): Plan & Execute + Toolset expansion + Approval reframe
170a305 feat(v3.2.2/phase1): Context Engine 3-tier + Read Tools + Telemetry
b1b6075 feat(v3.2.2/phase0): fix 5 AI Refine bug + dọn anti-pattern
b2fa302 docs(v3.2.2): baseline plan + hiện trạng AI Refine + user opinions
```

**Working dir uncommitted** (Phase 4 hotfix + 3D combined):

```
M  agent-teams/{routes,teams}/scenario/*  (3D — request_id, check_cancel)
M  docker-compose.dev.yml                  (3D — redis service)
M  mobile-control/content_scenario/views.py (Phase 4 hotfix + 3D /cancel/ action)
M  ui/src/{lib/api.ts, components/scenario/ScenarioGenerateModal.tsx} (3D)
?? agent-teams/utils/cancel.py            (3D — check_cancel/signal_cancel)
?? docs/Gen_Scenario/ai-scenario-v3-2-1-2A-PROGRESS.md (2A SSE defer doc)
```

---

## 2. Hai trang dùng AI Refine

| Trang                                       | URL                          | File FE                                                                            | Phân biệt                                                                                                                                                                                                                      |
| ------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Draft** (vừa generate, chưa lưu) | `/content-scenarios/draft` | [`ContentScenarioDraftPage.tsx`](../../ui/src/pages/ContentScenarioDraftPage.tsx)   | `scenarioId=0` placeholder. Chat dùng `POST /preview-script-chat/` (STATELESS, local state). Plan execute / approval row KHÔNG persist DB. Click "Thực hiện" trên insert_shot → toast "chỉ khả dụng sau khi lưu".  |
| **Detail** (đã save DB)             | `/content-scenarios/:id`   | [`ContentScenarioDetailPage.tsx`](../../ui/src/pages/ContentScenarioDetailPage.tsx) | Chat dùng `POST /script-chat/` (JSON) hoặc `POST /script-chat-stream/` (SSE — Daphne buffer chưa fix). DB-backed chat thread. Approval row persist. Plan persist `ContentScenarioPlan`. Tất cả mutation chạy thật. |

---

## 3. Big picture — 3 panel layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ HEADER: title · genre · duration · N shots · [Phân tích] [Tối ưu] [Export]│
├────────────┬────────────────────────────────────────┬───────────────────┤
│            │                                        │                   │
│ AI REFINE  │  TIMELINE (Shot 1 ─ Shot N badges)     │ NHÂN VẬT REGISTRY│
│ (CHAT)     │  ─────────────────────────────────     │                   │
│            │                                        │ • Linh            │
│ bubble     │  Shot 1  [Hook] [@Linh] [Cảnh mới]    │   25 tuổi · VN    │
│ user/AI    │   VOICE_OVER:  ...                     │   outfit: ...     │
│            │   HÀNH ĐỘNG:    ...                    │   voice: ...      │
│ chips:     │   > Kỹ thuật & hình ảnh (6 field)      │                   │
│ @shot/char │     ▼ Nhân vật trong khung [v]         │ • Bác sĩ          │
│            │     • Góc máy [editable]               │   30 tuổi · VN    │
│ gợi ý      │     • Bối cảnh / Tư thế / Đạo cụ ...   │                   │
│ nhanh      │  ─────────────────────────────────     │ • Mai 24 tuổi     │
│            │  + Chèn shot sau Shot 1                │                   │
│ textarea   │                                        │ THUỘC TÍNH CHUNG  │
│ [Send]     │  Shot 2  [Vấn đề] [@Bác sĩ] [Neo 1]    │ THUỘC TÍNH META   │
│            │   ...                                  │                   │
├────────────┴────────────────────────────────────────┴───────────────────┤
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
  320px         minmax(0, 1fr)                          280px
```

**Panel collapse persist** ở localStorage:

- `scenario.panel.chat.collapsed`
- `scenario.panel.properties.collapsed`

**Cards trong chat bubble** (render bởi [`ScenarioChatProposalCards.tsx`](../../ui/src/components/scenario/ScenarioChatProposalCards.tsx)):

- `ClarificationCard` (amber, question)
- `ProposedOptionsCard` (violet, options list)
- `StructuredActionCard` (sky/red/amber theo `data_impact_class`)
- `PlanCard` (indigo, numbered steps + execute button) — Phase 2 new
- `AnalysisCard` (violet, 5 score bars) — Phase 3 new
- `PatchCard` inline (sky, diff before/after)

---

## 4. End-to-end flow — 1 lượt chat

```
1) FE [ScenarioChatPanel]
   ├─ chatInput = "đổi character trẻ hơn 25 tuổi"
   ├─ targetCharacter = "Linh"
   ├─ targetShots = []
   └─ POST /api/content-scenarios/7/script-chat/
        { body, target_shots, target_character }

2) BE Django [content_scenario/views.py:script_chat]
   ├─ Lưu user_message (ContentScenarioChatMessage)
   ├─ Load history (last 30 turns)
   ├─ Resolve brand_prompt (3-layer fallback)
   ├─ Build scenario_dict (serializer)
   ├─ Build agno_session_id = "scenario:{user_id}:{scenario_id}"
   ├─ start = time.monotonic()
   ├─ result = _process_scenario_chat_turn(...)  ← BRAIN
   ├─ _record_ai_refine_event(...)  ← Phase 1 telemetry
   ├─ Save assistant_message
   └─ Return JSON {user_message, assistant_message, structured_actions,
                    proposed_options, clarification_question}

3) BE [_process_scenario_chat_turn] — BRAIN ───────────────────────────
   ├─ Build SYSTEM PROMPT (Phase 1+4 tiered + few-shot):
   │   - EXPERT PERSONA "AI Director 15 năm" (multi-tenant generic)
   │   - BRAND VOICE (đầy đủ text, 3-layer fallback)
   │   - Layer 1 SUMMARY (luôn có, ~200 token cho 20 shot):
   │      Title · Genre · Duration · N shots
   │      Funnel arc: Hook → Vấn đề → Giải pháp → CTA
   │      Anchor chain: 1 · 2←1 · 3(B) · 4←2 · ...
   │      Brand_mention coverage: none×4, soft×1, strong×1
   │      Characters: Linh(25), Bác sĩ(30), Mai(24)
   │   - Layer 2 FOCUS SHOTS (nếu target_shots set, full 14 field/shot)
   │   - Layer 2 FOCUS CHARACTER (nếu target_character set, full 5 field)
   │   - TOOLKIT (20 tool descriptions)
   │   - QUY TẮC QUYẾT ĐỊNH (10 rules, gồm Rule 10 anti-hallucinate)
   │   - VÍ DỤ TUÂN THỦ (8 few-shot ✅/❌ — VD 1-8)
   │   - HƯỚNG DẪN PROACTIVE
   │   - QUY TẮC CỨNG
   │
   ├─ Build STICKY CONTEXT REMINDER (nếu target_shots/target_character):
   │   "Target shots: [3]. Khi gọi apply_shot_patch, shot_ids = [3]."
   │
   ├─ Append last 30 history turns (tag inline [@Shot N] cho context xuyên history)
   ├─ Append current user turn với tag
   │
   ├─ Detect intent:
   │   - looks_like_choice: "OK"/"đi"/"chốt"/digit → tool required
   │   - has_action_intent (Phase 4): xoá/sửa/thêm/đổi/... → tool required
   │   - force_tool = bool(target+choice) or has_action_intent
   │
   ├─ MULTI-TURN LOOP (Phase 1, max 4 iter, cap 5 read tools/turn):
   │   while iter < 4:
   │     completion = openai.chat.completions.create(
   │       model = gpt-4o-mini (env SCENARIO_CHAT_MODEL)
   │       tools = SCENARIO_TOOLS (20 functionDef)
   │       tool_choice = 'required' if (force_tool and iter==0) else 'auto'
   │       temperature = 0.7, max_tokens = 600
   │     )
   │     track tokens_input + tokens_output
   │     read_calls = filter(tool_calls, name in READ_TOOLS)
   │     non_read = filter(tool_calls, name not in READ_TOOLS)
   │
   │     if non_read or no tool_calls or hit MAX_READ:
   │       final_msg = msg
   │       break
   │
   │     # All tool_calls are reads → execute + append result + continue loop
   │     for tc in read_calls:
   │       result = _handle_read_tool(tc, scenario_dict, cache)
   │       messages.append({role: 'tool', tool_call_id: tc.id, content: json})
   │       read_tool_count += 1
   │
   ├─ Dispatch final_msg tool_calls:
   │   apply_shot_patch       → _handle_apply_shot_patch (call agent_teams)
   │   apply_character_patch  → _handle_apply_character_patch
   │   insert_shot            → structured_action SAFE (requires_approval=False)
   │   delete_shot            → structured_action DESTRUCTIVE + approval row
   │   delete_character       → structured_action DESTRUCTIVE + approval row
   │   reorder_shots          → DESTRUCTIVE + approval row
   │   optimize_whole_scenario→ EXPENSIVE + approval row
   │   add_character          → SAFE structured_action
   │   move_shot              → SAFE
   │   duplicate_shot         → SAFE
   │   batch_update_shots     → SAFE (cap N=5)
   │   propose_plan           → persist ContentScenarioPlan + structured_action plan_proposed
   │   read_*                 → (handled in loop)
   │   scan_scenario          → call _handle_scan_scenario → cross_shot_analysis action
   │   ask_clarification      → set clarification_question
   │   propose_options        → set proposed_options
   │   respond_with_text      → override assistant_text với message
   │
   ├─ Safety net (line ~1454+): nếu 0 tool + 0 patch + 0 action + text "đã X xong"
   │   → replace text với "Mình chưa có kết quả cụ thể..." (chống false claim)
   │
   ├─ Patch merge (Phase 0): _merge_patches_by_shot(patches) — gộp patches
   │   cùng shot_id thành 1 patch với union field set
   │
   └─ Return dict:
      { assistant, patches (merged), structured_actions, proposed_options,
        clarification_question, llm_model, _telemetry: {tokens_in, tokens_out,
        read_tool_calls, loop_iterations} }

4) FE nhận response
   ├─ Push user_message + assistant_message vào messages[]
   ├─ Tách transient outputs vào chatTransients[message_id]
   ├─ Render bubble + cards dưới bubble
   └─ Reset input, giữ chips
```

### Variation: SSE chat-stream

`POST /script-chat-stream/` trả `text/event-stream`. Events: `thinking`/`tool_result`/`action_proposed`/`options_proposed`/`clarification`/`final`/`done`.

⚠ **Daphne buffer issue**: events bị batch flush ở cuối (xem [`ai-scenario-v3-2-1-2A-PROGRESS.md` §8](ai-scenario-v3-2-1-2A-PROGRESS.md)). Defer fix sang v3.2.3+ (threading + heartbeat hoặc switch uvicorn).

---

## 5. Toolkit 20 tools — chi tiết

Tăng từ 8 (v3.2.1) → 20 (v3.2.2 Phase 4 hotfix).

### 5.1 Bảng tổng quan

| #  | Tool                        | Loại   | data_impact                | Side-effect                                            | FE UI                                                |
| -- | --------------------------- | ------- | -------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| 1  | `apply_shot_patch`        | content | safe                       | Forward agent_teams `/scenario/refine-shot` → patch | PatchCard inline với diff                           |
| 2  | `apply_character_patch`   | content | safe                       | Forward `/scenario/refine-character` → patch        | PatchCard                                            |
| 3  | `delete_character` ⭐     | content | **destructive**      | structured_action + approval row                       | Card đỏ + Approve/Reject                           |
| 4  | `insert_shot`             | content | safe                       | structured_action (no approval)                        | Card sky + Thực hiện                               |
| 5  | `delete_shot`             | content | **destructive**      | + approval row + orphan check                          | Card đỏ + Approve/Reject + orphan modal            |
| 6  | `reorder_shots`           | content | **destructive**      | + approval row                                         | Card đỏ                                            |
| 7  | `optimize_whole_scenario` | content | **expensive**        | + approval row + rerun ~30s                            | Card amber + cost warning                            |
| 8  | `add_character` ⭐        | content | safe                       | structured_action                                      | Card sky + Thực hiện                               |
| 9  | `move_shot` ⭐            | content | safe (anchor warn)         | structured_action                                      | Card sky + warn anchor break                         |
| 10 | `duplicate_shot` ⭐       | content | safe                       | structured_action                                      | Card sky                                             |
| 11 | `batch_update_shots` ⭐   | content | safe (cap=5)               | structured_action                                      | Card sky + list shot affected                        |
| 12 | `propose_plan` ⭐         | plan    | safe (inherit step impact) | persist ContentScenarioPlan + structured_action        | **PlanCard** (indigo) numbered steps + Execute |
| 13 | `read_shot` ⭐            | read    | safe                       | Inline handler, cache trong turn                       | (no UI, AI dùng nội bộ)                           |
| 14 | `read_character` ⭐       | read    | safe                       | Inline handler                                         | (no UI)                                              |
| 15 | `read_scenario` ⭐        | read    | safe                       | Inline handler                                         | (no UI)                                              |
| 16 | `read_voice_overs` ⭐     | read    | safe                       | Inline handler                                         | (no UI)                                              |
| 17 | `scan_scenario` ⭐        | scoring | safe (1 LLM call ~5-8s)    | 1 LLM call gpt-4o-mini structured output               | **AnalysisCard** 5 score bars                  |
| 18 | `ask_clarification`       | meta    | safe                       | text-only                                              | Card amber với (a)(b)(c)                            |
| 19 | `propose_options`         | meta    | safe                       | text-only                                              | Card violet với options list                        |
| 20 | `respond_with_text` ⭐    | meta    | safe                       | override assistant_text                                | (no card — text bubble bình thường)              |

⭐ = mới ở v3.2.2 (12 tool mới).

### 5.2 Constants quan trọng

```python
# views.py
DANGEROUS_TOOLS = {'delete_shot', 'delete_character', 'optimize_whole_scenario', 'reorder_shots'}
META_TOOLS = {'ask_clarification', 'propose_options', 'respond_with_text'}
READ_TOOLS = {'read_shot', 'read_character', 'read_scenario', 'read_voice_overs'}

# v3.2.2 Phase 2 — Approval reframe (replace DANGEROUS_TOOLS gradually)
IMPACT_SAFE = 'safe'
IMPACT_DESTRUCTIVE = 'destructive'
IMPACT_EXPENSIVE = 'expensive'

TOOL_IMPACT_MAP: dict[str, str] = {
    'apply_shot_patch': IMPACT_SAFE,
    'apply_character_patch': IMPACT_SAFE,
    'insert_shot': IMPACT_SAFE,
    'add_character': IMPACT_SAFE,
    'move_shot': IMPACT_SAFE,
    'duplicate_shot': IMPACT_SAFE,
    'batch_update_shots': IMPACT_SAFE,
    'read_shot': IMPACT_SAFE,
    'read_character': IMPACT_SAFE,
    'read_scenario': IMPACT_SAFE,
    'read_voice_overs': IMPACT_SAFE,
    'scan_scenario': IMPACT_SAFE,
    'delete_shot': IMPACT_DESTRUCTIVE,
    'delete_character': IMPACT_DESTRUCTIVE,
    'reorder_shots': IMPACT_DESTRUCTIVE,
    'optimize_whole_scenario': IMPACT_EXPENSIVE,
    'ask_clarification': IMPACT_SAFE,
    'propose_options': IMPACT_SAFE,
    'respond_with_text': IMPACT_SAFE,
    'propose_plan': IMPACT_SAFE,  # inherit từ steps
}
```

---

## 6. Context Engine 3 lớp

**Phase 1 fix** root cause "Context Blindness" — AI giờ thấy đủ data, không đoán mò.

### Layer 1 — Summary (LUÔN có trong system prompt, ~200 token)

[`views.py:_build_layer1_summary`](../../mobile-control/content_scenario/views.py):

```
─── KỊCH BẢN — TÓM TẮT L1 ───
  Title: Khám Phá Lợi Ích Của Sữa Chua
  Genre: seeding · Duration: 30s · 8 shots
  Funnel arc: Hook → Hook → Hook → Vấn đề → Giải pháp → Giải pháp → CTA → CTA
  Anchor chain: 1 · 2←1 · 3(B) · 4 · 5←4 · 6(B) · 7 · 8
  Brand_mention coverage: none×6, soft×1, strong×1
  Characters: Linh(25), Bác sĩ(30), Mai(24)
  (Cần CHI TIẾT field shot/character? → gọi read_shot/read_character/...)
```

### Layer 2 — Focus Shot/Character (chỉ khi target_shots / target_character set)

[`views.py:_build_layer2_focus_shots`](../../mobile-control/content_scenario/views.py):

```
─── SHOT FOCUS — CHI TIẾT L2 ───

  Shot 3 (Giải pháp):
    voice_over: "Sữa chua thực phẩm tốt cho sức khỏe..."
    kinetic_action: "Linh múc sữa chua bằng thìa..."
    character_in_frame: Linh
    continuity_mode: B_ROLL_CUT (anchor_from: None)
    camera_articulation: "Close-up, STATIC"
    background: "Bàn ăn sáng với hộp sữa chua"
    character_pose: "Ngồi nghiêng nhẹ, tay cầm thìa"
    prop_description: "Hộp sữa chua + thìa kim loại"
    texture_and_lighting: "Ánh sáng tự nhiên cửa sổ, tone ấm"
    music_hint: "Nhạc nhẹ nhàng, vui tươi"
    brand_mention: soft
    prompt_injection: ""
    warnings: []
```

### Layer 3 — Retrieval Tools (AI tự pull khi cần)

4 tool: `read_shot`, `read_character`, `read_scenario`, `read_voice_overs`.

**Cache trong cùng turn** (`read_cache: dict`) — `read_shot(3)` lần 2 trong cùng tool loop = reuse.
**Cap**: 5 read calls/turn (`MAX_READ_TOOL_CALLS_PER_TURN`). Vượt → system warning chèn vào messages "đã đọc quá nhiều, ra quyết định với data đã có".
**Result size cap**: 1500 chars/result (`MAX_READ_RESULT_CHARS`) — tránh nổ token.

**Multi-turn loop** (line ~1875): AI có thể đọc 1-5 lần trước khi quyết định action. Max 4 iterations.

---

## 7. Plan & Execute

**Phase 2 feature**: yêu cầu phức tạp → AI lập plan multi-step → FE PlanCard → user approve → BE execute sequential.

### 7.1 Khi nào AI gọi `propose_plan`?

Trigger keywords trong persona prompt rule 7:

- Multi-shot: "shot 2, 5, 7" / "shot 2 và 5"
- Cross-shot coordination: "toàn bộ", "tổng thể", "chiều sâu", "refactor"
- Complex emotional: "tăng đồng cảm", "tạo sự kết nối"

Few-shot VD 2 trong persona enforce: "BẮT KỲ khi nào user liệt kê >1 shot → BẮT BUỘC propose_plan, KHÔNG fragmented N tool call riêng".

### 7.2 Plan flow

```
1) User: "tăng chiều sâu nhân vật cho toàn kịch bản"
2) AI gọi propose_plan(
     goal="Tăng đồng cảm với nhân vật chính",
     analysis="Hook hiện chưa có pain point. Voice shot 2-3 mô tả khô khan...",
     steps=[
       {description: "Sửa hook shot 1 — thêm pain point", tool_name: "apply_shot_patch", ...},
       {description: "Tăng cảm xúc voice shot 2-3", tool_name: "apply_shot_patch", ...},
       {description: "Đổi pose shot 4 thể hiện vulnerable", tool_name: "apply_shot_patch", ...},
     ]
   )

3) BE [_process_scenario_chat_turn dispatch case]:
   ├─ Persist ContentScenarioPlan row (status='proposed')
   ├─ Compute max_impact từ steps (safe/destructive/expensive)
   └─ Return structured_action {
        kind: 'plan_proposed',
        plan_id: 1,
        goal, analysis, steps,
        data_impact_class: max_impact,
        requires_approval: max_impact != 'safe',
      }

4) FE render PlanCard (indigo theme):
   ┌─ AI ĐỀ XUẤT KẾ HOẠCH ─────────────┐
   │ Tăng đồng cảm với nhân vật chính │
   │ 📊 Phân tích: Hook hiện chưa...   │
   │                                   │
   │ 1. ⏰ Sửa hook shot 1 — thêm pain │
   │    (apply_shot_patch)             │
   │ 2. ⏰ Tăng cảm xúc voice shot 2-3 │
   │    (apply_shot_patch)             │
   │ 3. ⏰ Đổi pose shot 4 vulnerable  │
   │    (apply_shot_patch)             │
   │                                   │
   │ [Phê duyệt & execute] [Hủy]       │
   └───────────────────────────────────┘

5) User click "Phê duyệt & execute":
   POST /content-scenarios/{id}/plans/{plan_id}/execute/

6) BE [execute_plan action]:
   ├─ Set plan.status = 'executing', plan.executed_at = now
   ├─ For each step in plan.steps:
   │   step.status = 'running'; save
   │   try:
   │     result = _execute_plan_step(sc, user, step.tool_name, step.args, jwt_auth)
   │     step.status = 'done'; step.result = result; completed += 1
   │   except Exception as exc:
   │     step.status = 'failed'; step.error = str(exc); failed += 1
   │     # Best-effort: continue next step (KHÔNG rollback)
   │
   ├─ plan.status = 'completed' if failed==0 else 'failed'
   └─ Return {plan_id, status, steps, completed_steps, failed_steps}

7) FE update PlanCard với steps[].status realtime (poll vì sync trả 1 lần,
   Daphne SSE buffer chưa fix).
```

### 7.3 Plan execute step dispatch

[`views.py:_execute_plan_step`](../../mobile-control/content_scenario/views.py): dispatch theo `tool_name` → call BE handler tương ứng:

- `apply_shot_patch` → forward agent_teams + apply patch
- `apply_character_patch` → idem
- `insert_shot` / `delete_shot` / `move_shot` / `duplicate_shot` → direct DB ops
- `add_character` / `delete_character` → direct DB ops
- `batch_update_shots` / `reorder_shots` → direct DB ops

**Best-effort rollback**: step fail → keep done steps, mark plan FAILED. User restore manual qua audit log nếu muốn.

---

## 8. Approval contract — Safe/Destructive/Expensive

**Phase 2 reframe** từ "dangerous tool" (developer-centric) → 3 nhóm theo data impact (user-centric).

### Schema mới

```typescript
// FE types.ts
type DataImpactClass = 'safe' | 'destructive' | 'expensive'

interface StructuredActionXxx {
  kind: '...'
  ...args
  requires_approval: boolean      // backward compat
  data_impact_class?: DataImpactClass  // v3.2.2 Phase 2 mới
  approval_id?: number
}
```

### FE logic [`ScenarioChatProposalCards.tsx`](../../ui/src/components/scenario/ScenarioChatProposalCards.tsx)

```typescript
const impact = action.data_impact_class || fallback_by_kind
const isSafe = impact === 'safe'
const isExpensive = impact === 'expensive'
const needsConfirm = !isSafe  // destructive OR expensive

// Accent màu
isExpensive → amber border + cost warning
isDestructive → red border + Approve/Reject buttons
isSafe → sky border + 1 nút "Thực hiện" (auto execute)
```

### Mapping cụ thể

| Tool                                                                         | data_impact_class      | FE UI                                                                      |
| ---------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| apply_*, insert_shot, add_*, move_shot, duplicate_shot, batch_update_shots | safe                   | sky card + auto execute                                                    |
| delete_shot, delete_character, reorder_shots                                 | destructive            | red card + Approve/Reject + orphan modal nếu cần                         |
| optimize_whole_scenario                                                      | expensive              | amber card + cost/duration warning                                         |
| propose_plan                                                                 | inherit max của steps | PlanCard với indigo (safe-ish) hoặc amber/red theo step nguy hiểm nhất |

---

## 9. Anti-Hallucinate Pattern (Phase 4)

**Bug context**: AI text "Tôi sẽ X — xem dưới đây để confirm" mà KHÔNG gọi tool → 0 structured_action → user kẹt. Xuất hiện ở Test 1, 2, 4, Image 12 trong [`docs/ai_refine_bug/`](../ai_refine_bug/).

### 3 cơ chế chống Hallucinate

**1. Tool `respond_with_text(message)` — text-only qua tool framework**

```python
RESPOND_WITH_TEXT_TOOL = {
    'name': 'respond_with_text',
    'description': 'Trả text khi user HỎI/THẢO LUẬN không cần action...',
    'parameters': {'message': {'type': 'string'}},
}
# Dispatch case
elif name == 'respond_with_text':
    msg = str(args.get('message') or '').strip()
    if msg: assistant_text = msg
```

→ AI không thể "bypass tool framework" trả text-only — phải chọn 1 trong 20 tool, kể cả khi không action.

**2. Action keyword detection + force `tool_choice='required'`**

```python
ACTION_KEYWORDS_VI = (
    'sửa', 'chỉnh', 'đổi', 'thay', 'cập nhật', 'update', 'cải thiện', 'refine',
    'xoá', 'xóa', 'bỏ', 'remove', 'delete',
    'thêm', 'chèn', 'insert', 'add', 'tạo mới', 'tạo thêm',
    'tăng', 'giảm', 'mạnh hơn', 'nhẹ hơn', 'rõ hơn',
    'di chuyển', 'chuyển', 'move', 'đảo', 'reorder', 'sắp xếp',
    'duplicate', 'copy', 'sao chép', 'nhân đôi',
    'tối ưu', 'optimize', 'viết lại', 'rewrite', 'refactor',
    'phân tích', 'chấm điểm', 'đánh giá', 'thế nào', 'có gì cần cải thiện',
    'tất cả', 'toàn bộ', 'mọi', 'từng',
)

def _detect_action_intent(user_body: str) -> bool:
    return any(kw in user_body.lower() for kw in ACTION_KEYWORDS_VI)

# Trong _process_scenario_chat_turn
has_action_intent = _detect_action_intent(user_body)
force_tool = (bool(target+choice) and looks_like_choice) or has_action_intent
# OpenAI call: tool_choice='required' if force_tool and iter==0 else 'auto'
```

→ AI BẮT BUỘC chọn 1 tool ở iteration đầu khi detect action keyword.

**3. 8 few-shot examples + Rule 10 trong persona prompt**

Rule 10:

```
🔥 ANTI-HALLUCINATE: NẾU bạn nói "Tôi sẽ X" / "Xem dưới đây để confirm" →
BẮT BUỘC kèm tool call ngay TURN này. TUYỆT ĐỐI KHÔNG text-only mô tả intent
rồi để user đoán. Nếu HỎI/THẢO LUẬN không cần action → GỌI respond_with_text.
```

8 ví dụ ✅/❌:

- VD 1: delete_character với replace
- VD 2: 🚨 BẮT BUỘC propose_plan cho multi-shot (KHÔNG fragmented)
- VD 3: single-shot camera adjust → apply_shot_patch
- VD 4: multi-field cùng shot → 1 apply_shot_patch
- VD 5: complex cross-shot → propose_plan
- VD 6: hỏi mở → respond_with_text
- VD 7: hỏi scenario thế nào → scan_scenario
- VD 8: xoá single shot → delete_shot

### Smoke verify

```
"xoa nhan vat Linh"       → kind=delete_character ✅
"bo shot 2, 4, 6"          → kind=plan_proposed (3 step) ✅
"vì sao hook quan trọng?"  → respond_with_text → text về Hook ✅
```

---

## 10. 3D — TRUE cancel pipeline qua Redis

**Vấn đề**: user click "Hủy" trong khi AI generate (~25s) → FE abort fetch nhưng BE vẫn tiếp tục chạy → tốn LLM cost.

**Giải pháp 3D**: cross-service cancel signal qua Redis.

### Architecture

```
┌─────────────┐    1. Sinh kịch bản (request_id=UUID)   ┌────────────┐
│  FE Modal   │ ────────────────────────────────────────►│  Django    │
│             │                                          │            │
│             │    2. User click Hủy:                    │            │
│             │    POST /cancel/{request_id}             │            │
│             │ ────────────────────────────────────────►│            │
│             │                                          │            │
│             │    3. AbortController.abort() FE         │ SET Redis  │
│             │       — fetch terminate                  │ scenario:  │
│             │       — toast "Đã hủy"                   │ cancel:    │
│             │                                          │ {req_id}=1 │
└─────────────┘                                          └──────┬─────┘
                                                                │ 4. forward to agent_teams
                                                                │    với request_id
                                                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  agent_teams orchestrator                                            │
│  Layer 1 _extract_text_from_upload                                   │
│  ├─ check_cancel(request_id, "L1") → Redis GET                       │
│  ├─ if SET → raise ScenarioCancelled → return HTTP 499               │
│  Layer 2 _agent_teams_post(/parse-intent)                            │
│  ├─ check_cancel(request_id, "L2")                                   │
│  Layer 3 _agent_teams_post(/generate)                                │
│  ├─ check_cancel(request_id, "L3a")  # trước Explore                 │
│  ├─ Scripter Explore (~5s)                                           │
│  ├─ check_cancel(request_id, "L3b")  # trước Reviewer                │
│  ├─ 5 Reviewer parallel (~3-5s)                                      │
│  ├─ check_cancel(request_id, "L3c")  # trước Enhance                 │
│  ├─ Scripter Enhance (~5s)                                           │
│  └─ check_cancel(request_id, "L3d")  # trước Consolidator            │
└──────────────────────────────────────────────────────────────────────┘
```

### Files involved

- [`agent-teams/utils/cancel.py`](../../agent-teams/utils/cancel.py) — `check_cancel/signal_cancel/ScenarioCancelled` (new)
- [`agent-teams/routes/scenario.py`](../../agent-teams/routes/scenario.py) — Pydantic schema +`request_id`, catch `ScenarioCancelled` → HTTPException 499
- [`agent-teams/teams/scenario/orchestrator.py`](../../agent-teams/teams/scenario/orchestrator.py) — `check_cancel` ở 6-8 layer boundaries
- [`mobile-control/content_scenario/views.py`](../../mobile-control/content_scenario/views.py):
  - `_agent_teams_post` accept `request_id` kwarg → forward
  - `_scenario_signal_cancel(request_id, ttl=60)` — SET Redis key
  - Action `POST /cancel/` → call signal_cancel
- [`ui/src/lib/api.ts`](../../ui/src/lib/api.ts) — `cancelGenerate(request_id)` method
- [`ui/src/components/scenario/ScenarioGenerateModal.tsx`](../../ui/src/components/scenario/ScenarioGenerateModal.tsx) — `crypto.randomUUID()` request_id, POST cancel trước abort
- [`docker-compose.dev.yml`](../../docker-compose.dev.yml) — redis service mới

### Verified behavior

User click Hủy ~5s sau khi bắt đầu gen → Redis SET → orchestrator check Layer 3a/b/c → raise → return 499 → Django propagate → FE toast "Đã hủy". LLM cost tiết kiệm ~50-70% (Reviewer + Enhance chưa chạy).

---

## 11. Telemetry — AiRefineEvent

**Phase 1 feature**: log mỗi turn chat để debug + optimize prompt.

### Model

```python
# content_scenario/models.py
class AiRefineEvent(models.Model):
    scenario = FK(ContentScenario, null=True, blank=True)
    owner = FK(User)
    tool_names = JSONField(default=list)         # ['apply_shot_patch', 'read_tool', ...]
    read_tool_count = IntegerField(default=0)
    loop_iterations = IntegerField(default=1)
    tokens_input = IntegerField(default=0)
    tokens_output = IntegerField(default=0)
    llm_model = CharField(max_length=80, blank=True)
    patches_count = IntegerField(default=0)
    structured_actions_count = IntegerField(default=0)
    has_proposed_options = BooleanField(default=False)
    has_clarification = BooleanField(default=False)
    target_shots = JSONField(default=list)
    target_character = CharField(max_length=120, blank=True)
    duration_ms = IntegerField(default=0)
    created_at = DateTimeField(auto_now_add=True, db_index=True)
```

### Persistence

Helper `_record_ai_refine_event(...)` được call sau mỗi `_process_scenario_chat_turn` ở 3 sites:

- `script_chat` (POST /script-chat/)
- `script_chat_stream` (SSE)
- `preview_script_chat` (DraftPage stateless)

Try/except không block chat — telemetry fail OK.

### Query patterns

```python
# Tool frequency (top 10)
from django.db.models import Count
events = AiRefineEvent.objects.values('tool_names')
# Flatten + count manually (JSONField)

# Avg latency per scenario
AiRefineEvent.objects.values('scenario').annotate(avg=Avg('duration_ms'))

# Token cost per scenario/day
from django.db.models import Sum
AiRefineEvent.objects.values('scenario', 'created_at__date').annotate(
    total_in=Sum('tokens_input'), total_out=Sum('tokens_output')
)
```

Dashboard FE chưa có — defer v3.2.3+ Observability.

---

## 12. Persona prompt structure

Hàm `_build_chat_system_prompt(scenario_dict, brand_prompt, target_shots, target_character)` ở [`views.py`](../../mobile-control/content_scenario/views.py) (line ~1185+).

### Cấu trúc

```
1. EXPERT PERSONA
   "Bạn là AI Director — đạo diễn video marketing senior 15 năm..."
   - Multi-tenant generic (bỏ "Dr Đình Khanh" hard-code BUG-7)
   - PHONG CÁCH: chủ động, đồng nghiệp, lý do, ý ngầm, không generic

2. BRAND VOICE
   {brand_prompt}   ← 3-layer fallback (user override → team → default)

3. LAYER 1 SUMMARY
   {layer1_text}    ← funnel arc + anchor chain + brand coverage + chars

4. LAYER 2 FOCUS (optional)
   {layer2_shots_text}   ← full 14 field/shot nếu target_shots
   {layer2_char_text}    ← full 5 field nếu target_character

5. TOOLKIT (20 tool)
   Nhóm theo loại: SỬA NỘI DUNG, ĐỔI CẤU TRÚC, KẾ HOẠCH, ĐỌC, CHẤM ĐIỂM, META

6. QUY TẮC QUYẾT ĐỊNH (10 rules)
   1. Intent rõ + simple → tool ngay
   2. Target mơ hồ → ask_clarification (a)(b)(c)
   3. User hỏi mở → propose_options
   4. User chốt hướng → tool tương ứng
   5. User hỏi/thảo luận → trả text (≤150 từ)
   6. CONTEXT: read_shot/character trước khi patch field ngoài focus
   7. PLAN: yêu cầu phức tạp (>2 shot, "tổng thể") → propose_plan
   8. BATCH: gộp fields cùng shot vào 1 apply_shot_patch
   9. SCAN: "kịch bản thế nào?" → scan_scenario
   10. 🔥 ANTI-HALLUCINATE: NÓI "Tôi sẽ X" → BẮT BUỘC kèm tool call

7. VÍ DỤ TUÂN THỦ (8 few-shot ✅/❌)
   VD 1-8 (xem §9)

8. HƯỚNG DẪN PROACTIVE
   - Sau mỗi tool call, scan voice ≤25 từ / anchor break / AIDA arc

9. QUY TẮC CỨNG
   - Trả tiếng Việt ≤200 từ
   - KHÔNG dấu "-"
   - KHÔNG bịa character/sản phẩm
   - KHÔNG dùng từ "modal/popup/click/button"
   - Voice ≤5 giây (~25 từ)
   - Medical claim thận trọng
```

### Sticky context reminder (separate system message)

```python
def _build_context_reminder(target_shots, target_character) -> str:
    # Chỉ build khi có target_shots/target_character
    return "CONTEXT REMINDER: Target shots [3]. ... Target character 'Linh'..."
```

Inserted SAU system prompt, TRƯỚC history. Mục đích: nhắc AI shot_ids/character_name khi user gõ ngắn ("OK", "1", "chốt").

---

## 13. DB schema

```python
# content_scenario/models.py

class ContentScenario              # 1 row per kịch bản
    owner, title, brief, duration_target_seconds, shot_count_target, genre
    intent_json, character_registry (JSON list), origin_data, source_file_name
    created_at, updated_at

class ContentScenarioShot          # N rows per scenario
    scenario (FK), shot_id, shot_order
    funnel_part, character_in_frame, continuity_mode (NEW_SCENE|FRAME_ANCHOR|B_ROLL_CUT)
    anchor_source_shot (self-FK, ON DELETE SET_NULL)
    voice_over, kinetic_action, camera_articulation, background,
    character_pose, prop_description, texture_and_lighting, music_hint,
    brand_mention (none|soft|strong), prompt_injection, warnings (JSON list)

class ContentScenarioChatMessage   # chat thread
    scenario (FK), owner, sender (USER|ASSISTANT), body
    target_shots (JSON list int), target_character
    attached_patches (JSON list), llm_model

class ContentScenarioAuditLog      # all mutations
    scenario, actor, action (enum), shot_id, character_name,
    fields_changed (JSON), previous_value (JSON), created_at

class ContentScenarioPendingApproval  # v3.2.1 Phase 4 — Human approval
    scenario, owner, tool_name, tool_args (JSON), status (pending|approved|rejected),
    resolved_at, resolved_by, created_at

class AiRefineEvent                # v3.2.2 Phase 1 — Telemetry (xem §11)

class ContentScenarioPlan          # v3.2.2 Phase 2 — Plan & Execute
    scenario, owner, goal, analysis, steps (JSON), status,
    completed_steps, failed_steps, created_at, executed_at, completed_at
```

### Migrations history

| Migration | Phase      | Nội dung                         |
| --------- | ---------- | --------------------------------- |
| 0001-0003 | v3.1-3.2.1 | Initial + features cũ            |
| 0004      | v3.2.2 P0  | AuditAction.DELETE_CHARACTER enum |
| 0005      | v3.2.2 P1  | AiRefineEvent table               |
| 0006      | v3.2.2 P2  | ContentScenarioPlan table         |

---

## 14. API endpoints

Base: `/api/content-scenarios/`

### Tạo / lưu / list / detail

- `GET /` — list scenarios
- `GET /{id}/` — detail
- `POST /generate/` — Layer 1+2+3 → ScenarioJSON (preview, chưa lưu)
- `POST /preview-intent/` — Layer 1+2 → IntentJSON preview
- `POST /save/` — lưu ScenarioJSON → DB
- `DELETE /{id}/` — xoá scenario
- `PATCH /{id}/` — update metadata
- `POST /cancel/` — 3D cancel by request_id

### Sửa nội dung

- `PATCH /{id}/update-shot/` — update 1 shot
- `PATCH /{id}/update-character/` — update 1 character

### Toolkit v3.2 + v3.2.2

- `POST /{id}/insert-shot/` — chèn shot mới (agent_teams gen content)
- `POST /{id}/delete-shot/` — xoá + orphan handling (Chốt #14)
- `POST /{id}/reorder-shots/` — đảo thứ tự
- `POST /{id}/optimize-whole/` — rerun pipeline
- `POST /{id}/delete-character/` — **v3.2.2 P0**
- `POST /{id}/add-character/` — **v3.2.2 P2**
- `POST /{id}/move-shot/` — **v3.2.2 P2**
- `POST /{id}/duplicate-shot/` — **v3.2.2 P2**
- `POST /{id}/batch-update-shots/` — **v3.2.2 P2** (cap N=5)

### Plan & Execute (v3.2.2 P2)

- `POST /{id}/plans/{plan_id}/execute/` — execute plan steps sequential
- `POST /{id}/plans/{plan_id}/cancel/` — cancel plan

### Scoring (v3.2.2 P3)

- `POST /{id}/scan/` — chấm 5 dimension scenario

### Chat

- `GET/POST /{id}/script-chat/` — DB-backed chat thread
- `POST /{id}/script-chat-stream/` — SSE streaming chat
- `POST /preview-script-chat/` — stateless chat (cho DraftPage)

### Approval

- `POST /{id}/approvals/{approval_id}/resolve/` — approve/reject

### History / Audit

- `GET /{id}/history/` — list shot history snapshots
- `POST /{id}/restore-from-audit/` — restore từ audit row
- `GET /{id}/audits/` — list audit log
- `PATCH /{id}/restore-shot/` — restore 1 shot
- `PATCH /{id}/restore-all/` — restore all

### Export

- `POST /{id}/generate-variant/` — sinh variant (v3.2)
- `GET /{id}/export/?as=xlsx` — export xlsx (Chốt #17)

### Brand voice

- `GET /brand-prompt/` — get effective brand prompt

---

## 15. Frontend components

| Component                     | File                                                                             | Phase            | Vai trò                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `ContentScenarioDetailPage` | [DetailPage.tsx](../../ui/src/pages/ContentScenarioDetailPage.tsx)                  | base             | 3-panel layout, state holder, dispatch mutations                             |
| `ContentScenarioDraftPage`  | [DraftPage.tsx](../../ui/src/pages/ContentScenarioDraftPage.tsx)                    | base             | Draft preview (chưa save)                                                   |
| `ScenarioChatPanel`         | [ChatPanel.tsx](../../ui/src/components/scenario/ScenarioChatPanel.tsx)             | base             | Bubble + input + chips + suggested prompts                                   |
| `ChatBubble`                | (in ChatPanel)                                                                   | base             | User/AI bubble với avatar + timestamp                                       |
| `PatchCard`                 | (in ChatPanel)                                                                   | base             | Inline diff before/after + Áp dụng button                                  |
| `ScenarioChatProposalCards` | [ProposalCards.tsx](../../ui/src/components/scenario/ScenarioChatProposalCards.tsx) | base+P0+P2+P3    | Dispatch 10 action kinds                                                     |
| `ClarificationCard`         | (in ProposalCards)                                                               | base             | Question card amber                                                          |
| `ProposedOptionsCard`       | (in ProposalCards)                                                               | base             | Options card violet                                                          |
| `StructuredActionCard`      | (in ProposalCards)                                                               | base+P2          | Universal action card với impact-based UI                                   |
| `PlanCard`                  | (in ProposalCards)                                                               | **P2 new** | Multi-step plan với execute button + step status realtime                   |
| `AnalysisCard`              | (in ProposalCards)                                                               | **P3 new** | 5 score bar chart + strengths/weaknesses/recommendations                     |
| `ScenarioTimeline`          | [Timeline.tsx](../../ui/src/components/scenario/ScenarioTimeline.tsx)               | base             | Horizontal shot badges                                                       |
| `ScenarioShotCard`          | [ShotCard.tsx](../../ui/src/components/scenario/ScenarioShotCard.tsx)               | base+P0          | Progressive disclosure: 2 core field + 6 advanced field + character selector |
| `FieldEditor`               | (in ShotCard)                                                                    | base             | Textarea inline debounced save                                               |
| `FieldSelector`             | (in ShotCard)                                                                    | **P0 new** | Dropdown cho `character_in_frame`                                          |
| `ScenarioPropertiesPanel`   | [PropsPanel.tsx](../../ui/src/components/scenario/ScenarioPropertiesPanel.tsx)      | base             | Right panel: characters registry + meta                                      |
| `CharacterCard`             | (in PropsPanel)                                                                  | base             | Per-character collapsible card                                               |
| `ScenarioShotHistoryModal`  | [HistoryModal.tsx](../../ui/src/components/scenario/ScenarioShotHistoryModal.tsx)   | base             | Per-shot rollback từ audit log                                              |
| `ScenarioGenerateModal`     | [GenerateModal.tsx](../../ui/src/components/scenario/ScenarioGenerateModal.tsx)     | base+3D          | Modal sinh kịch bản với AbortController + 3D cancel                       |

### TypeScript types

[`ui/src/lib/types.ts`](../../ui/src/lib/types.ts) — 10 `StructuredAction*` interfaces + `DataImpactClass` type + `ScenarioScores` + `PlanStep`.

### API client

[`ui/src/lib/api.ts`](../../ui/src/lib/api.ts) — `contentScenariosApi` object với ~30 method:

- `generate`, `previewIntent`, `save`, `list`, `get`, `update`, `delete`
- `updateShot`, `updateCharacter`, `restoreShot`, `restoreAll`
- `insertShot`, `deleteShot`, `reorderShots`, `optimizeWhole`
- `deleteCharacter`, `addCharacter`, `moveShot`, `duplicateShot`, `batchUpdateShots` (v3.2.2)
- `executePlan`, `cancelPlan`, `scanScenario` (v3.2.2)
- `streamChat`, `streamGenerate` (SSE)
- `cancelGenerate` (3D)
- `exportXlsx`, `generateVariant`

---

## 16. Patch merge BE post-process

**Phase 0 fix** bug #5 (3 patch trùng cùng shot).

```python
# views.py:_merge_patches_by_shot (line ~700)
def _merge_patches_by_shot(patches: list[dict]) -> list[dict]:
    """Gộp patches cùng shot_id thành 1 patch với union field set.

    before: GIỮ key SỚM NHẤT (giá trị gốc của shot)
    after: LẤY key MUỘN NHẤT (tool_call sau override trước)
    Patches kind != 'shot' (character patches) giữ nguyên không merge.
    """
    grouped, others = {}, []
    for p in patches:
        if p.get('kind') != 'shot':
            others.append(p); continue
        sid = p.get('shot_id')
        if sid not in grouped:
            grouped[sid] = {'kind': 'shot', 'shot_id': sid, 'before': {}, 'after': {}}
        for k, v in (p.get('before') or {}).items():
            if k not in grouped[sid]['before']:
                grouped[sid]['before'][k] = v
        for k, v in (p.get('after') or {}).items():
            grouped[sid]['after'][k] = v
    return list(grouped.values()) + others
```

Apply ngay trước return của `_process_scenario_chat_turn`.

→ Nếu AI vẫn lỡ gọi `apply_shot_patch` nhiều lần cho cùng shot (Phase 4 prompt chống nhưng không 100%), BE merge an toàn → FE chỉ thấy 1 PatchCard.

---

## 17. Multi-tenant brand voice

3-layer fallback:

```
Layer 1 (request-level): user gõ "brand_override" trong modal AI Scenario
   ↓ fallback if empty
Layer 2 (team-level): FeatureSystemPrompt với feature_id='ai_scenario_v3', team_id=user.team
   ↓ fallback if empty
Layer 3 (hardcoded default): "Brand voice generic — KHÔNG bias industry"
   (BUG-7 fix: bỏ "Dr Đình Khanh" hard-code khỏi default)
```

Resolved bởi `_resolve_brand_prompt(user, override)` trong [`views.py`](../../mobile-control/content_scenario/views.py).

Persona prompt KHÔNG còn nhắc "Dr Đình Khanh" — chỉ generic "AI Director seeding marketing đa ngành (mỹ phẩm, F&B, FMCG, giáo dục, du lịch, sức khỏe, lifestyle)".

---

## 18. Multi-model infra

Per-role env vars (default gpt-4o-mini, fallback an toàn):

```bash
# .env hoặc docker-compose env
SCENARIO_PARSER_MODEL=openai:gpt-4o-mini         # Layer 2 Parser
SCENARIO_SCRIPTER_MODEL=openai:gpt-4o-mini       # Layer 3 Explore + Enhance
SCENARIO_REVIEWER_MODEL=openai:gpt-4o-mini       # 5 Reviewer
SCENARIO_CONSOLIDATOR_MODEL=openai:gpt-4o-mini   # Fallback
SCENARIO_CHAT_MODEL=gpt-4o-mini                  # AI Refine chat
SCENARIO_SCAN_MODEL=gpt-4o-mini                  # v3.2.2 P3 scan
SCENARIO_THINK_MODEL=openai:gpt-4o-mini          # v3.2.1 thinking
SCENARIO_REFLECT_MODEL=openai:gpt-4o-mini        # v3.2.1 reflect
OPENAI_API_KEY=sk-...
```

Format `provider:model_id` (vd `openai:gpt-4o-mini`, `anthropic:claude-3-haiku`, `google:gemini-pro`). Factory pattern ở agent_teams.

→ Để swap model: chỉ đổi env var + restart. KHÔNG đụng code.

---

## 19. Known issues / future patches (v3.2.3+)

| #  | Issue                                                                                                               | Mức độ | Sub-version mở rộng                                           |
| -- | ------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------- |
| 1  | Daphne SSE buffer — chat-stream events batch flush cuối, không streaming thật                                   | Med       | v3.2.x Daphne fix (threading+heartbeat hoặc switch uvicorn)    |
| 2  | Plan execute sync (~30s) — Daphne SSE chưa fix nên không có realtime progress bar                              | Med       | Cùng v3.2.x Daphne fix                                         |
| 3  | Chat history cluttered khi user xoá nhiều shot — N delete cards rời                                             | Low       | v3.2.4 UX Redesign (4-panel?) hoặc collapse resolved           |
| 4  | Tool dư chưa có: rename_character, merge_character, split_shot, merge_shots, optimize_hook/cta/story_arc/emotion | Low       | v3.2.3 Tool Expansion (chỉ khi user request use case cụ thể) |
| 5  | AnalysisCard chỉ có 5 dimension score — chưa có story arc diagram / emotion plot                               | Low       | v3.2.5 Deep Analysis (hoặc DROP)                               |
| 6  | Plan rollback best-effort — step fail keep done steps, không atomic                                               | Low       | v3.2.6 Atomic Plan (nếu incident data loss)                    |
| 7  | propose_plan max 10 steps, batch_update_shots cap N=5                                                               | Low       | v3.2.7 Larger limits                                            |
| 8  | Telemetry chỉ DB, chưa có dashboard real-time                                                                    | Low       | v3.2.8 Observability (Loki/Prometheus)                          |
| 9  | propose_plan miss — đôi khi AI vẫn fragment thay vì plan (Phase 4 prompt cải thiện nhưng không 100%)       | Med       | Strengthen few-shot tiếp hoặc 2-stage LLM (v4 territory)      |
| 10 | Hallucinate Pattern còn 5-10% — Phase 4 fix ~90% nhưng AI vẫn có thể bypass                                   | Low       | Safety net reflection loop (Fix B trong discussion)             |

→ Note: tên "v3.2.3+" / "v3.2.x" KHÔNG dùng "v3.3" (reserve Media Server) hay "v4" (reserve render video DirectorAgent).

---

## 20. Files map

### Backend (Python/Django)

| File                                                                                     | Vai trò                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`content_scenario/models.py`](../../mobile-control/content_scenario/models.py)           | 7 model: ContentScenario, Shot, ChatMessage, AuditLog, PendingApproval, AiRefineEvent, ContentScenarioPlan                                                                                                                                                                                         |
| [`content_scenario/serializers.py`](../../mobile-control/content_scenario/serializers.py) | DRF serializers                                                                                                                                                                                                                                                                                    |
| [`content_scenario/views.py`](../../mobile-control/content_scenario/views.py)             | ~3700 lines: tool defs (20),`_process_scenario_chat_turn` brain, `_build_chat_system_prompt`, dispatch handlers, 30+ action endpoints, helpers (_merge_patches_by_shot, _detect_action_intent, _execute_plan_step, _handle_scan_scenario, _record_ai_refine_event, _scenario_signal_cancel...) |
| [`content_scenario/urls.py`](../../mobile-control/content_scenario/urls.py)               | URL routing                                                                                                                                                                                                                                                                                        |
| [`content_scenario/migrations/`](../../mobile-control/content_scenario/migrations/)       | 6 migrations (0001-0006)                                                                                                                                                                                                                                                                           |

### Backend (Agent teams)

| File                                                                                            | Vai trò                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`agent-teams/teams/scenario/orchestrator.py`](../../agent-teams/teams/scenario/orchestrator.py) | Layer 3 pipeline: Scripter Explore → 5 Reviewer → Enhance. Có check_cancel ở 6-8 boundaries (3D).                                                               |
| [`agent-teams/routes/scenario.py`](../../agent-teams/routes/scenario.py)                         | FastAPI routes: parse-intent, generate, refine-shot, refine-character, optimize-whole. Pydantic schema có `request_id` (3D). Catch `ScenarioCancelled` → 499. |
| [`agent-teams/utils/cancel.py`](../../agent-teams/utils/cancel.py)                               | 3D —`check_cancel(request_id, layer)`, `signal_cancel`, `is_cancelled`, `ScenarioCancelled` exception                                                      |
| [`agent-teams/agents/scenario/`](../../agent-teams/agents/scenario/)                             | Agno agent definitions (8 agents)                                                                                                                                   |

### Frontend (React/TypeScript)

| File                                                                                                                        | Vai trò                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`ui/src/pages/ContentScenarioDetailPage.tsx`](../../ui/src/pages/ContentScenarioDetailPage.tsx)                             | Main saved scenario page — 3-panel + state + mutations                                |
| [`ui/src/pages/ContentScenarioDraftPage.tsx`](../../ui/src/pages/ContentScenarioDraftPage.tsx)                               | Draft preview                                                                          |
| [`ui/src/components/scenario/ScenarioChatPanel.tsx`](../../ui/src/components/scenario/ScenarioChatPanel.tsx)                 | Chat bubble + input + chips + suggested prompts                                        |
| [`ui/src/components/scenario/ScenarioChatProposalCards.tsx`](../../ui/src/components/scenario/ScenarioChatProposalCards.tsx) | 5 card types: Clarification, ProposedOptions, StructuredAction, PlanCard, AnalysisCard |
| [`ui/src/components/scenario/ScenarioShotCard.tsx`](../../ui/src/components/scenario/ScenarioShotCard.tsx)                   | Per-shot card với FieldEditor + FieldSelector                                         |
| [`ui/src/components/scenario/ScenarioPropertiesPanel.tsx`](../../ui/src/components/scenario/ScenarioPropertiesPanel.tsx)     | Right panel: characters + meta                                                         |
| [`ui/src/components/scenario/ScenarioTimeline.tsx`](../../ui/src/components/scenario/ScenarioTimeline.tsx)                   | Horizontal shot navigation                                                             |
| [`ui/src/components/scenario/ScenarioShotHistoryModal.tsx`](../../ui/src/components/scenario/ScenarioShotHistoryModal.tsx)   | Per-shot rollback modal                                                                |
| [`ui/src/components/scenario/ScenarioGenerateModal.tsx`](../../ui/src/components/scenario/ScenarioGenerateModal.tsx)         | Generate modal với AbortController + 3D cancel                                        |
| [`ui/src/lib/types.ts`](../../ui/src/lib/types.ts)                                                                           | TypeScript types (~20 interface)                                                       |
| [`ui/src/lib/api.ts`](../../ui/src/lib/api.ts)                                                                               | `contentScenariosApi` — ~30 method                                                  |

### Infrastructure

| File                                                    | Vai trò                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`docker-compose.dev.yml`](../../docker-compose.dev.yml) | Services: backend (daphne :8030), agent_teams (uvicorn :7777), frontend (nginx :5173), redis (3D), postgres |
| [`docker-compose.yml`](../../docker-compose.yml)         | Prod stack                                                                                                  |

### Docs

| File                                                                                                      | Vai trò                                                                      |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`ai-scenario-v3-thiet-ke.md`](ai-scenario-v3-thiet-ke.md)                                                 | **Spec gốc** v3 — design quyết định, roadmap official              |
| [`ai-scenario-v3-2-1-PROGRESS.md`](ai-scenario-v3-2-1-PROGRESS.md)                                         | v3.2.1 5-phase implementation log                                             |
| [`ai-scenario-v3-2-1-2A-PROGRESS.md`](ai-scenario-v3-2-1-2A-PROGRESS.md)                                   | 2A SSE defer (Daphne buffer bug)                                              |
| [`ai-scenario-v3-2-2-refine-upgrade-plan.md`](ai-scenario-v3-2-2-refine-upgrade-plan.md)                   | **v3.2.2 plan** chi tiết 4 Phase + 10 OQ chốt                         |
| **`ai-refine-scenario-current.md`** (file này)                                                   | **Bàn giao** — thiết kế HIỆN TẠI sau v3.2.2 + 3D + Phase 4 hotfix |
| [`ai_refine_bug/mô_tả_bug.md`](../ai_refine_bug/mô_tả_bug.md)                                          | 11 bug screenshots + test plan + test results                                 |
| [`nâng_cấp_ai_refine_(ai_scenario)-my_opinion.md`](nâng_cấp_ai_refine_(ai_scenario)-my_opinion.md)     | User opinion 1 (input cho v3.2.2 plan)                                        |
| [`nâng_cấp_ai_refine_(ai_scenario)-my_opinion_2.md`](nâng_cấp_ai_refine_(ai_scenario)-my_opinion_2.md) | User opinion 2 (synthesized)                                                  |

---

## 21. Cách restart / deploy nhanh

```bash
cd /c/MyCode/Chatbot/mobile-agent-control

# Restart backend (sau code Python)
docker compose -f docker-compose.dev.yml restart backend
sleep 8  # đợi Daphne ready

# Restart agent_teams (sau code agent-teams/)
docker compose -f docker-compose.dev.yml restart agent_teams
sleep 6

# Rebuild frontend (sau code FE)
docker compose -f docker-compose.dev.yml up -d --build --no-deps frontend

# Apply migrations
docker compose -f docker-compose.dev.yml exec backend python manage.py migrate

# Check Django syntax
docker compose -f docker-compose.dev.yml exec backend python manage.py check

# Get JWT cho test curl
JWT=$(docker compose -f docker-compose.dev.yml exec -T backend python manage.py shell -c "
from rest_framework_simplejwt.tokens import RefreshToken
from django.contrib.auth.models import User
u = User.objects.get(username='ducnam')
print(str(RefreshToken.for_user(u).access_token))" 2>&1 | tail -1)

# Smoke test chat
curl -s -X POST "http://localhost:8030/api/content-scenarios/7/script-chat/" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"body":"xoa nhan vat Linh"}' | jq

# FE build smoke (Windows)
cd ui && npm run build
```

---

## 22. Cách kiểm tra telemetry

```bash
docker compose -f docker-compose.dev.yml exec backend python manage.py shell -c "
from content_scenario.models import AiRefineEvent
qs = AiRefineEvent.objects.order_by('-id')[:5]
for e in qs:
    print(f'id={e.id} sc={e.scenario_id} tools={e.tool_names} read={e.read_tool_count} '
          f'iter={e.loop_iterations} tokens={e.tokens_input}/{e.tokens_output} '
          f'ms={e.duration_ms} dt={e.created_at}')
"
```

---

## 23. Cách add tool mới (bàn giao guide)

1. **Define tool** trong `views.py`:

```python
NEW_TOOL = {
    'type': 'function',
    'function': {
        'name': 'new_tool_name',
        'description': '...',
        'parameters': {...},
    },
}
```

2. **Add vào registry**: `SCENARIO_TOOLS.append(NEW_TOOL)` + `TOOL_IMPACT_MAP['new_tool_name'] = IMPACT_SAFE`.
3. **Add dispatch case** trong `_process_scenario_chat_turn`:

```python
elif name == 'new_tool_name':
    structured_actions.append({
        'kind': 'new_tool_name', ...args,
        'requires_approval': False, 'data_impact_class': IMPACT_SAFE,
    })
```

4. **Add BE endpoint** (`@action(detail=True, methods=['post'], url_path='new-tool-name')`).
5. **Add FE TypeScript type** trong [`types.ts`](../../ui/src/lib/types.ts).
6. **Add FE api method** trong [`api.ts`](../../ui/src/lib/api.ts).
7. **Add FE card label/icon** trong [`ScenarioChatProposalCards.tsx`](../../ui/src/components/scenario/ScenarioChatProposalCards.tsx) switch case + dispatch handler trong DetailPage `handleExecuteApproved`.
8. **Update persona prompt**: thêm tool vào toolkit list + few-shot example.
9. **Add to plan dispatch** `_execute_plan_step` nếu plan có thể call tool này.
10. **Migration** nếu có DB schema change.
11. **Test fixture** + smoke test.

---

## 24. Kết — bàn giao cho người tiếp theo

Doc này mô tả **đầy đủ thiết kế hiện tại** sau khi ship v3.2.2 + 3D + Phase 4 hotfix. Người tiếp theo có thể:

- **Đọc §1-4** để hiểu tổng quan + flow chat.
- **Đọc §5** để biết toolkit đầy đủ.
- **Đọc §6-11** để hiểu features mới (Context, Plan, Approval, Anti-Hallucinate, 3D, Telemetry).
- **Đọc §13-15** để biết schema BE/FE.
- **Đọc §19** để biết items pending (v3.2.3+).
- **Đọc §23** khi cần add tool mới.

**Khi commit Phase 4 + 3D** (sau khi user verify E2E), recommend tách 2 commit để dễ rollback:

```bash
# Commit 1: Phase 4 hotfix
git add mobile-control/content_scenario/views.py docs/ai_refine_bug/mô_tả_bug.md
git commit -m "fix(v3.2.2/phase4-hotfix): chống Hallucinate + force propose_plan"

# Commit 2: 3D TRUE cancel (cherry-pick từ stash cũ hoặc tạo từ working dir)
git add agent-teams/ docker-compose.dev.yml ui/src/lib/api.ts \
        ui/src/components/scenario/ScenarioGenerateModal.tsx \
        mobile-control/content_scenario/views.py
git commit -m "feat(v3.2.2/3D): TRUE cancel pipeline qua Redis"

# Push origin (CHỈ user push)
git push -u origin feature/ai-scenario-v3.2.2
```

Liên hệ thắc mắc: xem doc cùng folder hoặc [memory project_gen_content_scriptstudio.md](../../../../Users/NamBoDoi/.claude/projects/c--MyCode/memory/project_gen_content_scriptstudio.md).
