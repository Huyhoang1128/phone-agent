/**
 * AI Scenario v3.2.1 — Detail (saved) page (`/content-scenarios/:id`).
 *
 * UX refactor theo `docs/Gen_Scenario/đề_xuất_tinh_chỉnh_giao_diện.md`:
 *   - UX-1: Design tokens (lib/scenario-tokens.ts)
 *   - UX-2: Top toolbar — breadcrumb + 2 primary + dropdown "More"
 *   - UX-3: Timeline ngang sticky (components/scenario/ScenarioTimeline.tsx)
 *   - UX-4: Shot card progressive disclosure (ScenarioShotCard.tsx)
 *   - UX-5: Chat bubble redesign (ScenarioChatPanel.tsx)
 *   - UX-6: Properties panel right (ScenarioPropertiesPanel.tsx)
 *   - UX-7: Collapsible 3 panels với localStorage persist
 */
import { useEffect, useRef, useState } from 'react'
import i18next from 'i18next'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Copy, FileSpreadsheet, Loader2, MoreHorizontal, Play, Plus, RefreshCw, RotateCcw, Sparkles, Video, X,
  Eye, EyeOff
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import OrphanResolutionModal from '@/components/scenario/OrphanResolutionModal'
import { ScenarioChatPanel } from '@/components/scenario/ScenarioChatPanel'
import { ScenarioPropertiesPanel } from '@/components/scenario/ScenarioPropertiesPanel'
import { ScenarioShotCard } from '@/components/scenario/ScenarioShotCard'
import { ScenarioShotHistoryModal } from '@/components/scenario/ScenarioShotHistoryModal'
import { ScenarioTimeline } from '@/components/scenario/ScenarioTimeline'
import ScenarioVariantModal from '@/components/scenario/ScenarioVariantModal'
import { ScenarioViewport } from '@/components/scenario/ScenarioViewport'
import { useToast } from '@/context/ToastContext'
import { contentScenariosApi } from '@/lib/api'
import { copyTextToClipboard } from '@/lib/clipboard'
import { typography } from '@/lib/scenario-tokens'
import type {
  ContentScenarioItem, ProposedOptionsPayload, ScenarioChatMessage, ScenarioPatch, StructuredAction,
} from '@/lib/types'

// ─── Local types ─────────────────────────────────────────────────────────────

interface ChatTransient {
  structured_actions: StructuredAction[]
  proposed_options: ProposedOptionsPayload | null
  clarification_question: string | null
  // v4.0 fields
  thinking?: string
  artistic_checks?: import('@/lib/types').ArtisticCheckPayload[]
}

interface OrphanState {
  open: boolean
  deletingShotId: number
  orphans: Array<{ shot_id: number; character_in_frame: string }>
  reanchorCandidates: Array<{ shot_id: number; character_in_frame: string; continuity_mode: string }>
}

// ─── Panel collapse — localStorage persistence (UX-7) ────────────────────────

const LS_KEYS = {
  chatCollapsed: 'scenario.panel.chat.collapsed',
  propsCollapsed: 'scenario.panel.properties.collapsed',
} as const

function loadPanelState(key: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function savePanelState(key: string, collapsed: boolean) {
  try {
    window.localStorage.setItem(key, collapsed ? '1' : '0')
  } catch {
    /* noop */
  }
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function ContentScenarioDetailPage() {
  const { t } = useTranslation()
  const { id: idParam } = useParams<{ id: string }>()
  const id = Number(idParam)
  const navigate = useNavigate()
  const { showToast } = useToast()
  const qc = useQueryClient()

  // ── State ─────────────────────────────────────────────────────────────────
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [targetShots, setTargetShots] = useState<number[]>([])
  const [targetCharacter, setTargetCharacter] = useState('')
  const [variantModalOpen, setVariantModalOpen] = useState(false)
  const [insertAfterShotId, setInsertAfterShotId] = useState<number | null>(null)
  const [insertBrief, setInsertBrief] = useState('')
  const [optimizeWholeBrief, setOptimizeWholeBrief] = useState('')
  const [optimizeWholeOpen, setOptimizeWholeOpen] = useState(false)
  const [orphanState, setOrphanState] = useState<OrphanState>({
    open: false, deletingShotId: 0, orphans: [], reanchorCandidates: [],
  })
  const [chatTransients, setChatTransients] = useState<Record<number, ChatTransient>>({})
  const [shotHistoryFor, setShotHistoryFor] = useState<number | null>(null)
  const [activeShotId, setActiveShotId] = useState<number | null>(null)

  // v4.0 stream states
  const [streamingMessage, setStreamingMessage] = useState<ScenarioChatMessage | null>(null)
  const abortControllerRef = useRef<(() => void) | null>(null)
  const activeRequestIdRef = useRef<string>('')

  // Clean up streaming on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current()
      }
    }
  }, [])

  const [chatWidth, setChatWidth] = useState(320)
  const [propsWidth, setPropsWidth] = useState(280)
  const [viewportVisible, setViewportVisible] = useState(true)

  const handleMouseDown = (e: React.MouseEvent, direction: 'left' | 'right') => {
    e.preventDefault()
    const startX = e.clientX
    const startChatWidth = chatWidth
    const startPropsWidth = propsWidth

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX
      if (direction === 'left') {
        const newWidth = Math.max(200, Math.min(600, startChatWidth + deltaX))
        setChatWidth(newWidth)
      } else {
        const newWidth = Math.max(200, Math.min(600, startPropsWidth - deltaX))
        setPropsWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  // UX-7 — Collapsible panels
  const [chatCollapsed, setChatCollapsed] = useState(() => loadPanelState(LS_KEYS.chatCollapsed))
  const [propsCollapsed, setPropsCollapsed] = useState(() => loadPanelState(LS_KEYS.propsCollapsed))
  useEffect(() => savePanelState(LS_KEYS.chatCollapsed, chatCollapsed), [chatCollapsed])
  useEffect(() => savePanelState(LS_KEYS.propsCollapsed, propsCollapsed), [propsCollapsed])

  // UX-2 — More dropdown
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    if (moreOpen) document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [moreOpen])

  // ── Queries ───────────────────────────────────────────────────────────────
  const { data: scenario, isLoading } = useQuery<ContentScenarioItem>({
    queryKey: ['scenario', id],
    queryFn: () => contentScenariosApi.get(id),
    enabled: !!id,
    staleTime: 30000, // 30s cache freshness cho scenario data
  })

  const { data: chatMessages = [] } = useQuery<ScenarioChatMessage[]>({
    queryKey: ['scenario', id, 'chat'],
    queryFn: () => contentScenariosApi.scriptChat.list(id),
    enabled: !!id,
    staleTime: 60000, // Ngăn refetch ngầm ghi đè optimistic update trong lúc stream
  })

  // ── AI video render (async via video-agent-worker) ────────────────────────
  const { data: video } = useQuery({
    queryKey: ['scenario', id, 'video'],
    queryFn: () => contentScenariosApi.videoStatus(id),
    enabled: !!id,
    // Poll while a render is in flight; stop once it settles.
    refetchInterval: (q) => (q.state.data?.video_status === 'processing' ? 4000 : false),
  })
  const generateVideoMut = useMutation({
    mutationFn: () => contentScenariosApi.generateVideo(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scenario', id, 'video'] })
      showToast(t('content.aiScenario.video.started', { defaultValue: 'Đã gửi yêu cầu tạo video.' }), 'success')
    },
    onError: (e: Error) => showToast(e.message || 'Tạo video thất bại', 'error'),
  })
  const videoRendering = generateVideoMut.isPending || video?.video_status === 'processing'

  // ── Mutations ─────────────────────────────────────────────────────────────
  const updateShotMut = useMutation({
    mutationFn: ({ shot_id, fields }: { shot_id: number; fields: Record<string, unknown> }) =>
      contentScenariosApi.updateShot(id, shot_id, fields),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scenario', id] }),
  })

  const updateCharacterMut = useMutation({
    mutationFn: ({ character_name, fields }: { character_name: string; fields: Record<string, unknown> }) =>
      contentScenariosApi.updateCharacter(id, character_name, fields),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scenario', id] })
      showToast(t('content.aiScenario.saveSuccess'), 'success')
    },
    onError: (e: Error) => showToast(e.message || 'Apply character failed', 'error'),
  })

  const restoreShotMut = useMutation({
    mutationFn: (shot_id: number) => contentScenariosApi.restoreShot(id, shot_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scenario', id] })
      showToast(t('content.aiScenario.saveSuccess'), 'success')
    },
  })

  const restoreAllMut = useMutation({
    mutationFn: () => contentScenariosApi.restoreAll(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scenario', id] })
      showToast(t('content.aiScenario.saveSuccess'), 'success')
    },
  })

  const insertShotMut = useMutation({
    mutationFn: ({ after_shot_id, brief }: { after_shot_id: number; brief: string }) =>
      contentScenariosApi.insertShot(id, after_shot_id, brief),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scenario', id] })
      showToast(t('content.aiScenario.insertShotSuccess'), 'success')
      setInsertAfterShotId(null)
      setInsertBrief('')
    },
    onError: (e: Error) => showToast(e.message || t('content.aiScenario.insertShotFailed'), 'error'),
  })

  const deleteShotMut = useMutation({
    mutationFn: ({ shot_id, orphan_resolution }: { shot_id: number; orphan_resolution?: string }) =>
      contentScenariosApi.deleteShot(id, shot_id, orphan_resolution),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scenario', id] })
      showToast(t('content.aiScenario.saveSuccess'), 'success')
      setOrphanState({ open: false, deletingShotId: 0, orphans: [], reanchorCandidates: [] })
    },
    onError: (err: Error) => {
      try {
        const parsed = JSON.parse(err.message)
        if (parsed?.orphans && parsed?.reanchor_candidates) {
          setOrphanState({
            open: true,
            deletingShotId: deleteShotMut.variables?.shot_id ?? 0,
            orphans: parsed.orphans,
            reanchorCandidates: parsed.reanchor_candidates,
          })
          return
        }
      } catch { /* fall through */ }
      showToast(err.message || 'Delete failed', 'error')
    },
  })

  const optimizeWholeMut = useMutation({
    mutationFn: (variant_brief: string) => contentScenariosApi.optimizeWhole(id, variant_brief),
    onSuccess: (data) => {
      navigate('/content-scenarios/draft', {
        state: {
          scenario: data.scenario,
          intent_json: scenario?.intent_json || {},
          source_file_name: scenario?.source_file_name || '',
          warning: data.warnings.length ? data.warnings.join(' | ') : null,
        },
      })
      showToast(t('content.aiScenario.optimizeWholeSuccess'), 'success')
      setOptimizeWholeOpen(false)
      setOptimizeWholeBrief('')
    },
    onError: (e: Error) => showToast(e.message || t('content.aiScenario.optimizeWholeFailed'), 'error'),
  })

  // ── Handlers ──────────────────────────────────────────────────────────────
  async function handleExportXlsx() {
    try {
      const { blob, filename } = await contentScenariosApi.exportXlsx(id)
      if (blob.size < 100) throw new Error(`File trả về quá nhỏ (${blob.size} bytes) — BE có thể đã fail`)
      const isXlsx = blob.type.includes('spreadsheet') || blob.type.includes('octet-stream') || blob.type === ''
      if (!isXlsx) {
        const text = await blob.text()
        throw new Error(`File không phải .xlsx (type=${blob.type}): ${text.slice(0, 200)}`)
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
      const sizeKb = (blob.size / 1024).toFixed(1)
      showToast(
        t('content.aiScenario.exportXlsxSuccessDetail', {
          defaultValue: '{{base}} ({{filename}}, {{size}} KB). Mở file → có 2 sheet "Characters" + "Shots".',
          base: t('content.aiScenario.exportXlsxSuccess'),
          filename,
          size: sizeKb,
        }),
        'success',
      )
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('content.aiScenario.exportXlsxFailed'), 'error')
    }
  }

  async function sendChat(overrideText?: string) {
    const body = (typeof overrideText === 'string' ? overrideText : chatInput).trim()
    if (!body) return
    setChatSending(true)
    setChatInput('')

    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
    activeRequestIdRef.current = requestId

    // Optimistic Update: Thêm USER message tạm thời vào cache
    const userTempMsg: ScenarioChatMessage = {
      id: -Date.now(),
      scenario: id,
      owner: 0,
      sender: 'USER',
      body: body,
      target_shots: targetShots,
      target_character: targetCharacter,
      attached_patches: [],
      llm_model: '',
      created_at: new Date().toISOString(),
    }
    qc.setQueryData<ScenarioChatMessage[]>(['scenario', id, 'chat'], (old) => [...(old || []), userTempMsg])

    const tempMsgId = -9999
    const tempMsg: ScenarioChatMessage = {
      id: tempMsgId,
      scenario: id,
      owner: 0,
      sender: 'ASSISTANT',
      body: '',
      target_shots: targetShots,
      target_character: targetCharacter,
      attached_patches: [],
      llm_model: 'gpt-4o-mini',
      created_at: new Date().toISOString(),
    }
    setStreamingMessage(tempMsg)
    setChatTransients((prev) => ({
      ...prev,
      [tempMsgId]: {
        structured_actions: [],
        proposed_options: null,
        clarification_question: null,
        thinking: 'Đang kết nối tới Đạo diễn...',
        artistic_checks: [],
      },
    }))

    let bufferedThinking = ''
    let bufferedReply = ''
    let isThinkingUpdated = false
    let isReplyUpdated = false

    const flushInterval = setInterval(() => {
      if (isThinkingUpdated) {
        const textToAppend = bufferedThinking
        bufferedThinking = ''
        isThinkingUpdated = false
        setChatTransients((prev) => {
          const old = prev[tempMsgId] || { structured_actions: [], proposed_options: null, clarification_question: null }
          return {
            ...prev,
            [tempMsgId]: {
              ...old,
              thinking: (old.thinking === 'Đang kết nối tới Đạo diễn...' ? '' : (old.thinking || '')) + textToAppend,
            }
          }
        })
      }

      if (isReplyUpdated) {
        const nextBody = bufferedReply
        isReplyUpdated = false
        setStreamingMessage((prev) => {
          if (!prev) return null
          return {
            ...prev,
            body: nextBody,
          }
        })
      }
    }, 80)

    try {
      const { promise, abort } = contentScenariosApi.streamChat(id, {
        body,
        target_shots: targetShots,
        target_character: targetCharacter,
        request_id: requestId,
      }, (event, data) => {
        if (event === 'thinking') {
          const process = data?.thinking_process || data?.text || ''
          bufferedThinking += process
          isThinkingUpdated = true
        } else if (event === 'artistic_check') {
          setChatTransients((prev) => {
            const old = prev[tempMsgId] || { structured_actions: [], proposed_options: null, clarification_question: null }
            const checks = old.artistic_checks || []
            return {
              ...prev,
              [tempMsgId]: {
                ...old,
                artistic_checks: [...checks, data as any],
              }
            }
          })
        } else if (event === 'creative_directing') {
          const tool = data?.tool
          const shotId = data?.shot_id || data?.to_shot_id
          const patch = data?.patch

          if (tool === 'propose_creative_treatment') {
            const act: StructuredAction = {
              kind: 'plan_proposed',
              goal: data.creative_goal || '',
              analysis: data.artistic_analysis || '',
              steps: (data.creative_steps || []).map((step: any) => ({
                description: step.creative_description || '',
                tool_name: 'propose_creative_treatment',
                status: 'pending',
              })),
              requires_approval: false,
            }
            setChatTransients((prev) => {
              const old = prev[tempMsgId] || { structured_actions: [], proposed_options: null, clarification_question: null }
              return {
                ...prev,
                [tempMsgId]: {
                  ...old,
                  structured_actions: [...old.structured_actions, act],
                }
              }
            })
          } else if (data?.kind === 'character' && data?.character_name && data?.patch && scenario?.character_registry) {
            const charName = data.character_name
            const patchChanges = data.patch
            if (data.is_new === true) {
              const act: StructuredAction = {
                kind: 'add_character',
                name: charName,
                age: patchChanges.age || '',
                outfit_style: patchChanges.outfit_style || '',
                ethnicity: patchChanges.ethnicity || '',
                voice_id_hint: patchChanges.voice_id_hint || '',
                requires_approval: true,
                data_impact_class: 'safe',
              }
              setChatTransients((prev) => {
                const old = prev[tempMsgId] || { structured_actions: [], proposed_options: null, clarification_question: null }
                const filtered = old.structured_actions.filter(a => !(a.kind === 'add_character' && (a as any).name === charName))
                return {
                  ...prev,
                  [tempMsgId]: {
                    ...old,
                    structured_actions: [...filtered, act],
                  }
                }
              })
            } else {
              const originalChar = scenario.character_registry.find(c => c.name === charName) || { name: charName }
              const before = { ...originalChar }
              const after = { ...originalChar, ...patchChanges }
              const newPatch: ScenarioPatch = {
                kind: 'character',
                character_name: charName,
                before,
                after,
              }
              setStreamingMessage((prev) => {
                if (!prev) return null
                const filtered = prev.attached_patches.filter(p => !(p.kind === 'character' && p.character_name === charName))
                return {
                  ...prev,
                  attached_patches: [...filtered, newPatch],
                }
              })
            }
          } else if (data?.kind === 'structural' && data?.op) {
            let actKind: any = null
            if (data.op === 'delete-shot') actKind = 'delete_shot'
            else if (data.op === 'insert-shot') actKind = 'insert_shot'
            else if (data.op === 'reorder-shots') actKind = 'reorder_shots'
            else if (data.op === 'move-shot') actKind = 'move_shot'
            else if (data.op === 'duplicate-shot') actKind = 'duplicate_shot'

            if (actKind) {
              const act: StructuredAction = {
                kind: actKind,
                requires_approval: true,
                data_impact_class: data.impact || 'destructive',
                ...data.args,
              }
              setChatTransients((prev) => {
                const old = prev[tempMsgId] || { structured_actions: [], proposed_options: null, clarification_question: null }
                const filtered = old.structured_actions.filter(a => !(a.kind === actKind && JSON.stringify(a) === JSON.stringify(act)))
                return {
                  ...prev,
                  [tempMsgId]: {
                    ...old,
                    structured_actions: [...filtered, act],
                  }
                }
              })
            }
          } else if (shotId && patch && scenario?.shots) {
            const originalShot = scenario.shots.find(s => s.shot_id === shotId)
            if (originalShot) {
              const before: Record<string, any> = {}
              const after: Record<string, any> = {}
              for (const [key, val] of Object.entries(patch)) {
                if (key in originalShot) {
                  before[key] = (originalShot as any)[key]
                  after[key] = val
                }
              }
              const newPatch: ScenarioPatch = {
                kind: 'shot',
                shot_id: shotId,
                before,
                after,
              }
              setStreamingMessage((prev) => {
                if (!prev) return null
                const filtered = prev.attached_patches.filter(p => !(p.kind === 'shot' && p.shot_id === shotId))
                return {
                  ...prev,
                  attached_patches: [...filtered, newPatch],
                }
              })
            }
          }
        } else if (event === 'reply') {
          bufferedReply = data?.message || ''
          isReplyUpdated = true
        } else if (event === 'clarification') {
          setChatTransients((prev) => {
            const old = prev[tempMsgId] || { structured_actions: [], proposed_options: null, clarification_question: null }
            return {
              ...prev,
              [tempMsgId]: {
                ...old,
                clarification_question: data?.question || '',
                proposed_options: data?.options && data.options.length > 0 ? {
                  preamble: '',
                  options: data.options.map((opt: string) => ({ label: opt, description: '' }))
                } : null
              }
            }
          })
        } else if (event === 'options') {
          setChatTransients((prev) => {
            const old = prev[tempMsgId] || { structured_actions: [], proposed_options: null, clarification_question: null }
            return {
              ...prev,
              [tempMsgId]: {
                ...old,
                proposed_options: {
                  preamble: data?.intro || '',
                  options: (data?.options || []).map((opt: any) => ({
                    label: opt.label || '',
                    description: opt.description || ''
                  }))
                }
              }
            }
          })
        } else if (event === 'plan_created' && data) {
          setChatTransients((prev) => {
            const old = prev[tempMsgId] || { structured_actions: [], proposed_options: null, clarification_question: null }
            const filtered = old.structured_actions.filter(
              a => !(a.kind === 'plan_proposed' && ((a as any).plan_id === data.plan_id || !(a as any).plan_id))
            )
            return {
              ...prev,
              [tempMsgId]: {
                ...old,
                structured_actions: [...filtered, data],
              }
            }
          })
        } else if (event === 'diagnosis' && data) {
          const act: StructuredAction = {
            kind: 'diagnosis',
            ...data
          } as any
          setChatTransients((prev) => {
            const old = prev[tempMsgId] || { structured_actions: [], proposed_options: null, clarification_question: null }
            return {
              ...prev,
              [tempMsgId]: {
                ...old,
                structured_actions: [...old.structured_actions, act],
              }
            }
          })
        } else if (event === 'final') {
          isThinkingUpdated = false
          isReplyUpdated = false
          setStreamingMessage((prev) => {
            if (!prev) return null
            return {
              ...prev,
              body: data?.assistant || '',
              llm_model: data?.llm_model || prev.llm_model,
            }
          })
        } else if (event === 'cancelled') {
          showToast(data?.message || 'Đã dừng chẩn đoán.', 'info')
        } else if (event === 'error') {
          let msg = data?.message
          const code = data?.code
          if (code === 'quota_exceeded') {
            msg = msg || 'Hệ thống AI đã hết hạn mức sử dụng, vui lòng thử lại sau.'
          } else if (code === 'rate_limited') {
            msg = msg || 'Hệ thống đang quá tải, vui lòng thử lại sau.'
          } else if (code === 'auth_error') {
            msg = msg || 'Lỗi xác thực hệ thống AI, vui lòng kiểm tra cấu hình key.'
          } else if (code === 'engine_error') {
            msg = msg || 'Lỗi hệ thống AI, vui lòng thử lại sau.'
          }
          showToast(msg || 'Lỗi stream', 'error')
        }
      })

      abortControllerRef.current = abort
      await promise
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        showToast(e instanceof Error ? e.message : 'Lỗi kết nối chat', 'error')
      }
    } finally {
      clearInterval(flushInterval)
      if (isThinkingUpdated) {
        const textToAppend = bufferedThinking
        setChatTransients((prev) => {
          const old = prev[tempMsgId] || { structured_actions: [], proposed_options: null, clarification_question: null }
          return {
            ...prev,
            [tempMsgId]: {
              ...old,
              thinking: (old.thinking === 'Đang kết nối tới Đạo diễn...' ? '' : (old.thinking || '')) + textToAppend,
            }
          }
        })
      }
      if (isReplyUpdated) {
        const nextBody = bufferedReply
        setStreamingMessage((prev) => {
          if (!prev) return null
          return {
            ...prev,
            body: nextBody,
          }
        })
      }

      setChatSending(false)
      setStreamingMessage(null)
      abortControllerRef.current = null
      setChatInput('')

      await Promise.all([
        qc.invalidateQueries({ queryKey: ['scenario', id, 'chat'] }),
        qc.invalidateQueries({ queryKey: ['scenario', id] }),
      ])
    }
  }

  function handleStop() {
    if (abortControllerRef.current) {
      abortControllerRef.current()
      abortControllerRef.current = null
    }
    const rid = activeRequestIdRef.current
    if (rid) {
      contentScenariosApi.cancelGenerate(rid).catch((e) => {
        console.warn('[handleStop] cancel failed:', e)
      })
      activeRequestIdRef.current = ''
    }
    setChatSending(false)
    setStreamingMessage(null)
    setChatInput('')
    showToast(t('content.aiScenario.chatCancelled', { defaultValue: 'Đã dừng chẩn đoán.' }), 'info')
  }

  function handlePickOption(label: string) {
    setChatInput(`Đi theo hướng: ${label}`)
  }

  async function handleExecuteInsert(action: Extract<StructuredAction, { kind: 'insert_shot' }>) {
    await insertShotMut.mutateAsync({ after_shot_id: action.after_shot_id, brief: action.brief })
  }

  async function handleExecuteApproved(action: StructuredAction) {
    const invalidate = () => qc.invalidateQueries({ queryKey: ['scenario', id] })
    const ok = (msg?: string) => { invalidate(); showToast(msg || t('content.aiScenario.saveSuccess'), 'success') }
    const fail = (e: unknown, fallback: string) => { showToast(e instanceof Error ? e.message : fallback, 'error'); throw e }

    if (action.kind === 'delete_shot') {
      await deleteShotMut.mutateAsync({ shot_id: action.shot_id })
    } else if (action.kind === 'reorder_shots') {
      await contentScenariosApi.reorderShots(id, action.new_order).then(() => ok()).catch((e) => fail(e, 'Reorder failed'))
    } else if (action.kind === 'optimize_whole_scenario') {
      await optimizeWholeMut.mutateAsync(action.variant_brief)
    } else if (action.kind === 'delete_character') {
      await contentScenariosApi.deleteCharacter(id, action.character_name, action.replace_in_shots_with)
        .then(() => ok()).catch((e) => fail(e, 'Delete character failed'))
    } else if (action.kind === 'insert_shot') {
      // v3.2.2 Phase 2 — fallback path (cũng có onExecuteInsert riêng)
      await contentScenariosApi.insertShot(id, action.after_shot_id, action.brief)
        .then(() => ok()).catch((e) => fail(e, 'Insert shot failed'))
    } else if (action.kind === 'add_character') {
      await contentScenariosApi.addCharacter(id, {
        name: action.name, age: action.age, outfit_style: action.outfit_style,
        ethnicity: action.ethnicity || undefined, voice_id_hint: action.voice_id_hint || undefined,
      }).then(() => ok()).catch((e) => fail(e, 'Add character failed'))
    } else if (action.kind === 'move_shot') {
      await contentScenariosApi.moveShot(id, action.shot_id, action.new_position)
        .then(() => ok()).catch((e) => fail(e, 'Move shot failed'))
    } else if (action.kind === 'duplicate_shot') {
      await contentScenariosApi.duplicateShot(id, action.shot_id)
        .then(() => ok()).catch((e) => fail(e, 'Duplicate shot failed'))
    } else if (action.kind === 'batch_update_shots') {
      await contentScenariosApi.batchUpdateShots(id, action.updates)
        .then(() => ok()).catch((e) => fail(e, 'Batch update failed'))
    }
    // plan_proposed có PlanCard riêng tự handle, không qua dispatch này
  }

  async function applyPatch(p: ScenarioPatch): Promise<boolean> {
    try {
      if (p.kind === 'shot') {
        await updateShotMut.mutateAsync({ shot_id: p.shot_id, fields: p.after as Record<string, unknown> })
        return true
      } else if (p.kind === 'character') {
        await updateCharacterMut.mutateAsync({
          character_name: p.character_name, fields: p.after as Record<string, unknown>,
        })
        return true
      }
      return false
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Apply patch failed', 'error')
      return false
    }
  }

  function handleRestoreAll() {
    if (!confirm(t('content.aiScenario.restoreAllConfirm'))) return
    restoreAllMut.mutate()
  }

  async function copyJson() {
    const shots = scenario!.shots || []
    const json = {
      title: scenario!.title,
      duration_target_seconds: scenario!.duration_target_seconds,
      // v3.2.2 fix: dùng actual shot count (shots.length) thay vì shot_count_target
      // (field cũ chỉ là TARGET lúc generate, không reflect số shot hiện tại sau
      // khi user insert/delete).
      shot_count: shots.length,
      genre: scenario!.genre,
      global_character_registry: scenario!.character_registry,
      shots,
    }
    const ok = await copyTextToClipboard(JSON.stringify(json, null, 2))
    if (ok) {
      showToast(t('content.aiScenario.copyJsonSuccess'), 'success')
    } else {
      showToast('Copy failed', 'error')
    }
  }

  // ── Guards ────────────────────────────────────────────────────────────────
  if (!id) return <div className="p-8 text-sm text-muted-foreground">Invalid scenario id.</div>
  if (isLoading || !scenario) return <div className="p-8 text-sm text-muted-foreground">Loading...</div>

  const shots = scenario.shots || []
  const updatedAt = new Date(scenario.updated_at)
  const updatedAgo = formatTimeAgo(updatedAt)

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col -mx-4 -my-4 sm:-mx-6 sm:-my-6">
      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* UX-2 — Top toolbar: breadcrumb + 2 primary + dropdown more */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      <header className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-2.5">
        {/* Left — Breadcrumb + title + meta */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            onClick={() => navigate('/content?tab=scenario')}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition"
            aria-label={t('common.back', { defaultValue: 'Quay lại' })}
          >
            <ChevronLeft className="size-4" />
          </button>
          <div className="min-w-0">
            <h1 className={`${typography.pageTitle} truncate`}>{scenario.title || t('content.aiScenario.untitled', { defaultValue: '(Không tên)' })}</h1>
            <p className="text-[11px] text-muted-foreground">
              {scenario.genre} · {scenario.duration_target_seconds}s · {shots.length} shots ·{' '}
              {t('content.aiScenario.savedAgo', { defaultValue: 'Đã lưu {{ago}}', ago: updatedAgo })}
            </p>
          </div>
        </div>

        {/* Right — Primary actions + More dropdown */}
        <div className="flex items-center gap-1.5">
          <Button
            size="sm" onClick={() => setOptimizeWholeOpen(true)} disabled={optimizeWholeMut.isPending}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <Sparkles className="mr-1 size-3.5" />
            {t('content.aiScenario.optimizeWholeAction')}
          </Button>
          <Button size="sm" variant="outline" onClick={handleExportXlsx}>
            <FileSpreadsheet className="mr-1 size-3.5" />
            {t('content.aiScenario.exportXlsx')}
          </Button>
          {Number.isFinite(id) && id > 0 && (
            <>
              <Button
                size="sm" variant="outline"
                onClick={() => generateVideoMut.mutate()}
                disabled={videoRendering}
              >
                {videoRendering
                  ? <Loader2 className="mr-1 size-3.5 animate-spin" />
                  : <Video className="mr-1 size-3.5" />}
                {videoRendering
                  ? t('content.aiScenario.video.rendering', { defaultValue: 'Đang tạo video...' })
                  : t('content.aiScenario.video.create', { defaultValue: 'Tạo video' })}
              </Button>
              {video?.video_status === 'completed' && video.video_url && (
                <a
                  href={video.video_url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  <Play className="size-3.5" />
                  {t('content.aiScenario.video.watch', { defaultValue: 'Xem video' })}
                </a>
              )}
            </>
          )}
          <div className="relative" ref={moreRef}>
            <Button size="sm" variant="ghost" onClick={() => setMoreOpen(v => !v)} aria-label="More actions">
              <MoreHorizontal className="size-4" />
            </Button>
            {moreOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 min-w-[180px] rounded-lg border border-border bg-card shadow-lg py-1">
                <MenuItem icon={<RefreshCw className="size-3.5" />} onClick={() => { setMoreOpen(false); setVariantModalOpen(true) }}>
                  {t('content.aiScenario.variant.action')}
                </MenuItem>
                <MenuItem icon={<Copy className="size-3.5" />} onClick={() => { setMoreOpen(false); copyJson() }}>
                  {t('content.aiScenario.copyJson')}
                </MenuItem>
                <MenuItem
                  icon={<RotateCcw className="size-3.5" />}
                  onClick={() => { setMoreOpen(false); handleRestoreAll() }}
                  disabled={restoreAllMut.isPending}
                  danger
                >
                  {t('content.aiScenario.restoreAll')}
                </MenuItem>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Optimize whole inline panel (giữ nguyên từ v3.2) */}
      {optimizeWholeOpen && (
        <div className="border-b border-emerald-400/40 bg-emerald-500/5 px-4 py-3">
          <div className="flex items-start gap-2">
            <Sparkles className="size-4 text-emerald-600 mt-1" />
            <div className="flex-1">
              <div className="text-sm font-medium">{t('content.aiScenario.optimizeWholeTitle')}</div>
              <p className="text-xs text-muted-foreground mt-0.5">{t('content.aiScenario.optimizeWholeDescription')}</p>
              <textarea
                value={optimizeWholeBrief}
                onChange={(e) => setOptimizeWholeBrief(e.target.value)}
                placeholder={t('content.aiScenario.optimizeWholeBriefPlaceholder')}
                rows={2} disabled={optimizeWholeMut.isPending}
                className="mt-2 w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs"
              />
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => optimizeWholeMut.mutate(optimizeWholeBrief.trim())} disabled={optimizeWholeMut.isPending}>
                  {optimizeWholeMut.isPending
                    ? <><Loader2 className="mr-1 size-3.5 animate-spin" />{t('content.aiScenario.optimizeWholeRunning')}</>
                    : t('content.aiScenario.optimizeWholeStart')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOptimizeWholeOpen(false)} disabled={optimizeWholeMut.isPending}>{t('common.cancel', { defaultValue: 'Huỷ' })}</Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════════════ */}
      {/* UX-7 — Resizable Panels Workspace (Phase 1) */}
      {/* ═════════════════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {/* ─── LEFT: Chat panel (UX-5) ──────────────────────────────────────── */}
        <div
          className="relative flex min-h-0 flex-col overflow-hidden border-r border-border bg-background shrink-0"
          style={{ width: chatCollapsed ? '40px' : `${chatWidth}px` }}
        >
          {chatCollapsed ? (
            <CollapsedPanelBar
              icon={<Sparkles className="size-4" />}
              label={t('content.aiScenario.chatPanelTitle')}
              onExpand={() => setChatCollapsed(false)}
              side="left"
            />
          ) : (
            <>
              <button
                onClick={() => setChatCollapsed(true)}
                className="absolute top-2 right-2 z-20 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('content.aiScenario.collapse', { defaultValue: 'Thu gọn' })}
              >
                <ChevronsLeft className="size-3.5" />
              </button>
              <ScenarioChatPanel
                scenarioId={id}
                messages={streamingMessage ? [...chatMessages, streamingMessage] : chatMessages}
                transients={chatTransients}
                chatInput={chatInput}
                setChatInput={setChatInput}
                chatSending={chatSending}
                onSend={sendChat}
                onStop={handleStop}
                targetShots={targetShots}
                targetCharacter={targetCharacter}
                onClearShot={(s) => setTargetShots((arr) => arr.filter((x) => x !== s))}
                onClearCharacter={() => setTargetCharacter('')}
                onApplyPatch={applyPatch}
                onPickOption={handlePickOption}
                onExecuteApproved={handleExecuteApproved}
                onExecuteInsert={handleExecuteInsert}
              />
            </>
          )}
        </div>

        {/* Left Drag Resizer Handle */}
        {!chatCollapsed && (
          <div
            className="w-1 cursor-col-resize bg-border hover:bg-indigo-500/50 active:bg-indigo-600 transition-colors shrink-0 z-10"
            onMouseDown={(e) => handleMouseDown(e, 'left')}
          />
        )}

        {/* ─── CENTER: Shots List (UX-4 compact cards) ──────────────────────── */}
        <div className="flex-1 flex min-h-0 flex-col bg-background overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/20 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className={typography.sectionTitle}>{t('content.aiScenario.shotPanelTitle')}</span>
              <button
                onClick={() => setViewportVisible(v => !v)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                title={viewportVisible ? 'Ẩn màn hình Storyboard' : 'Hiện màn hình Storyboard'}
              >
                {viewportVisible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
            <button
              onClick={() => setInsertAfterShotId(0)}
              className="inline-flex items-center gap-0.5 text-[11px] text-indigo-600 hover:underline"
            >
              <Plus className="size-3" />
              {t('content.aiScenario.insertShotAction')} đầu
            </button>
          </div>

          {viewportVisible && shots.length > 0 && (
            <ScenarioViewport shot={scenario.shots?.find(s => s.shot_id === activeShotId) || shots[0]} />
          )}

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 custom-scrollbar">
            {shots.length === 0 && (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {t('content.aiScenario.shotsEmpty', { defaultValue: 'Chưa có shot nào.' })}
                </p>
              </div>
            )}
            {shots.map((shot, idx) => (
              <div key={shot.shot_id}>
                <ScenarioShotCard
                  shot={shot}
                  isActive={activeShotId === shot.shot_id}
                  onAskAi={() => { setTargetShots([shot.shot_id]); setActiveShotId(shot.shot_id) }}
                  onSelect={() => setActiveShotId(shot.shot_id)}
                  onRestore={() => restoreShotMut.mutate(shot.shot_id)}
                  onOpenHistory={() => setShotHistoryFor(shot.shot_id)}
                  onDelete={() => deleteShotMut.mutate({ shot_id: shot.shot_id })}
                  isDeleting={deleteShotMut.isPending && deleteShotMut.variables?.shot_id === shot.shot_id}
                />
                {idx < shots.length - 1 && (
                  <button
                    onClick={() => setInsertAfterShotId(shot.shot_id)}
                    className="mt-2 w-full text-center text-[10px] text-muted-foreground hover:text-indigo-600 py-1.5 border border-dashed border-border rounded hover:border-indigo-400/60 transition"
                  >
                    <Plus className="inline size-2.5 mr-0.5" />
                    {t('content.aiScenario.insertShotAction')} sau Shot {shot.shot_id}
                  </button>
                )}
              </div>
            ))}
            {shots.length > 0 && (
              <button
                onClick={() => setInsertAfterShotId(shots[shots.length - 1].shot_id)}
                className="w-full text-center text-xs text-indigo-600 hover:underline py-2 border border-dashed border-indigo-400/40 rounded hover:bg-indigo-500/5 transition"
              >
                <Plus className="inline size-3 mr-1" />
                {t('content.aiScenario.insertShotAction')} cuối
              </button>
            )}
          </div>
        </div>

        {/* Right Drag Resizer Handle */}
        {!propsCollapsed && (
          <div
            className="w-1 cursor-col-resize bg-border hover:bg-indigo-500/50 active:bg-indigo-600 transition-colors shrink-0 z-10"
            onMouseDown={(e) => handleMouseDown(e, 'right')}
          />
        )}

        {/* ─── RIGHT: Properties panel (UX-6 & Inspector Tab) ────────────────── */}
        <div
          className="relative flex min-h-0 flex-col overflow-hidden border-l border-border bg-background shrink-0"
          style={{ width: propsCollapsed ? '40px' : `${propsWidth}px` }}
        >
          {propsCollapsed ? (
            <CollapsedPanelBar
              icon={<Sparkles className="size-4" />}
              label={t('content.aiScenario.propertiesPanelTitle', { defaultValue: 'Thuộc tính' })}
              onExpand={() => setPropsCollapsed(false)}
              side="right"
            />
          ) : (
            <>
              <button
                onClick={() => setPropsCollapsed(true)}
                className="absolute top-2 left-2 z-20 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('content.aiScenario.collapse', { defaultValue: 'Thu gọn' })}
              >
                <ChevronsRight className="size-3.5" />
              </button>
              <ScenarioPropertiesPanel
                scenario={scenario}
                onAskAiCharacter={(name) => setTargetCharacter(name)}
                activeShotId={activeShotId}
                onUpdateShot={(shotId, fields) => updateShotMut.mutate({ shot_id: shotId, fields })}
                onAskAiShot={(shotId) => { setTargetShots([shotId]); setActiveShotId(shotId) }}
                onRestoreShot={(shotId) => restoreShotMut.mutate(shotId)}
                onOpenShotHistory={(shotId) => setShotHistoryFor(shotId)}
                onDeleteShot={(shotId) => deleteShotMut.mutate({ shot_id: shotId })}
                isDeletingShot={deleteShotMut.isPending}
              />
            </>
          )}
        </div>
      </div>

      {/* ─── BOTTOM: Timeline Track Panel (Phase 2) ───────────────────────── */}
      <div className="shrink-0 border-t border-border bg-card">
        <ScenarioTimeline shots={shots} activeShotId={activeShotId} onJump={setActiveShotId} />
      </div>

      {/* ── Modals ──────────────────────────────────────────────────────────── */}

      {/* Insert shot modal */}
      {insertAfterShotId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">{t('content.aiScenario.insertShotTitle', { after: insertAfterShotId })}</h3>
              <button
                onClick={() => { setInsertAfterShotId(null); setInsertBrief('') }}
                disabled={insertShotMut.isPending}
                className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="space-y-2 px-4 py-3">
              <label className="text-xs font-medium">{t('content.aiScenario.insertShotBriefLabel')}</label>
              <textarea
                value={insertBrief}
                onChange={(e) => setInsertBrief(e.target.value)}
                placeholder={t('content.aiScenario.insertShotBriefPlaceholder')}
                rows={3} disabled={insertShotMut.isPending}
                className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <Button variant="ghost" size="sm" onClick={() => { setInsertAfterShotId(null); setInsertBrief('') }} disabled={insertShotMut.isPending}>{t('common.cancel', { defaultValue: 'Huỷ' })}</Button>
              <Button size="sm" onClick={() => insertShotMut.mutate({ after_shot_id: insertAfterShotId!, brief: insertBrief.trim() })} disabled={insertShotMut.isPending || !insertBrief.trim()}>
                {insertShotMut.isPending
                  ? <><Loader2 className="mr-1 size-3.5 animate-spin" />{t('content.aiScenario.insertShotRunning')}</>
                  : <><Plus className="mr-1 size-3.5" />{t('content.aiScenario.insertShotStart')}</>}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ScenarioVariantModal open={variantModalOpen} original={scenario} onClose={() => setVariantModalOpen(false)} />

      <OrphanResolutionModal
        open={orphanState.open}
        deletingShotId={orphanState.deletingShotId}
        orphans={orphanState.orphans}
        reanchorCandidates={orphanState.reanchorCandidates}
        loading={deleteShotMut.isPending}
        onCancel={() => setOrphanState({ open: false, deletingShotId: 0, orphans: [], reanchorCandidates: [] })}
        onConfirm={(resolution) => deleteShotMut.mutate({ shot_id: orphanState.deletingShotId, orphan_resolution: resolution })}
      />

      {shotHistoryFor !== null && (
        <ScenarioShotHistoryModal
          scenarioId={id}
          shotId={shotHistoryFor}
          isOpen={shotHistoryFor !== null}
          onClose={() => setShotHistoryFor(null)}
          onRestored={() => qc.invalidateQueries({ queryKey: ['scenario', id] })}
        />
      )}
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function MenuItem({
  icon, children, onClick, disabled, danger,
}: {
  icon?: React.ReactNode
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex w-full items-center gap-2 px-3 py-1.5 text-xs transition',
        danger ? 'text-red-600 hover:bg-red-500/10' : 'text-foreground hover:bg-muted',
        disabled ? 'opacity-50 cursor-not-allowed' : '',
      ].join(' ')}
    >
      {icon}
      <span>{children}</span>
    </button>
  )
}

function CollapsedPanelBar({
  icon, label, onExpand, side,
}: {
  icon: React.ReactNode
  label: string
  onExpand: () => void
  side: 'left' | 'right'
}) {
  const { t } = useTranslation()
  const Icon = side === 'left' ? ChevronRight : ChevronLeft
  return (
    <button
      onClick={onExpand}
      className="flex h-full w-full flex-col items-center justify-start gap-2 py-3 hover:bg-muted/30 transition"
      aria-label={t('content.aiScenario.expandPanel', { defaultValue: 'Mở rộng {{label}}', label })}
    >
      <Icon className="size-4 text-muted-foreground" />
      <div className="rounded bg-muted p-1.5 text-muted-foreground">{icon}</div>
      <span
        className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
      >
        {label}
      </span>
    </button>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimeAgo(d: Date): string {
  const diff = Date.now() - d.getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return i18next.t('content.aiScenario.justNow', { defaultValue: 'vừa xong' })
  if (m < 60) return i18next.t('content.aiScenario.minutesAgo', { defaultValue: '{{n}} phút trước', n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return i18next.t('content.aiScenario.hoursAgo', { defaultValue: '{{n}} giờ trước', n: h })
  return d.toLocaleDateString()
}
