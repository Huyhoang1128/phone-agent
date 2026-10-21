/**
 * "Tạo video" — generate a video from a character's media via the genvideo
 * service. Two types (toggle at top, available for all 3 platforms):
 *   - "Video có chữ"   → text overlay video (/api/text-videos, unchanged).
 *   - "Video hoạt cảnh" → cinematic scene clip (/api/script-to-video): a prompt
 *     + reference image, ≤5s, size tiktok|youtube. Prompt suggestions are AI-
 *     generated and can be regenerated.
 *
 * Generation is slow (minutes), so this fires and returns immediately: the
 * backend polls genvideo in the background (charactersApi.watchVideoTask) and
 * appends the finished video to the character's video gallery when ready.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, RefreshCw, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { charactersApi, profilesApi, tiktokApi } from '@/lib/api'
import type { Character, Profile } from '@/lib/types'

interface Props {
  character: Character
  onClose: () => void
}

const STYLES = [
  { value: 'healing', label: 'Healing' },
  { value: 'edu', label: 'Giáo dục' },
  { value: 'confession', label: 'Confession' },
  { value: 'vlog', label: 'Vlog' },
  { value: 'luxury', label: 'Sang trọng' },
]
const DURATIONS = ['5', '10', '15']
const SCENE_DURATIONS = ['3', '5']
const BOOMERANG_DURATIONS = ['5', '15', '30']
// Fixed prompt for the "boomerang" (natural-action) video via the genvideo
// unlimited endpoint — the subject performs one complete, meaningful action.
const BOOMERANG_PROMPT =
  'Your goal is to animate the image by creating ONE complete, natural action that best matches the visual context. Do not generate idle motion only. The subject must perform a meaningful action that is appropriate for the scene and any visible objects. The action should unfold naturally from start to finish over several seconds, using realistic body movement, facial expressions, and interaction with the environment. The action should feel like a real-life moment rather than a pose. Preserve the original composition and identity while making the scene come alive through purposeful movement.'
// Quick-fill topic ideas for the scene-video prompt generator.
const TOPIC_SUGGESTIONS = [
  'Tư vấn thẩm mỹ',
  'Dạo phố / du lịch',
  'Review sản phẩm',
  'Khoảnh khắc đời thường',
  'Phong cách sang trọng',
  'Chia sẻ kiến thức',
]
const DEFAULT_MUSIC_PATH = '/app/sample/music/tiktok_music_8f60231e.mp3'

type VideoType = 'text' | 'scene' | 'boomerang'

export default function CreateVideoModal({ character, onClose }: Props) {
  const { showToast } = useToast()

  const [platform, setPlatform] = useState<'facebook' | 'youtube' | 'tiktok'>('tiktok')
  const [videoType, setVideoType] = useState<VideoType>('text')
  const [profileId, setProfileId] = useState<number | null>(null)
  const [contentText, setContentText] = useState('')
  const [background, setBackground] = useState('')
  // Any character image is usable as reference: ảnh gốc + swapped media + raw
  // scenes (deduped by URL), so scene-only characters aren't stuck with no options.
  const refImages = [
    ...(character.source_image_url ? [{ url: character.source_image_url, created_at: '' }] : []),
    ...character.media,
    ...character.scenes,
  ].filter((m, i, arr) => arr.findIndex((x) => x.url === m.url) === i)
  const [refImageUrl, setRefImageUrl] = useState<string>(refImages[0]?.url ?? '')
  const [musicType, setMusicType] = useState<'default' | 'custom'>('default')
  const [musicPath, setMusicPath] = useState(DEFAULT_MUSIC_PATH)
  const [musicFile, setMusicFile] = useState<File | null>(null)
  const [style, setStyle] = useState('healing')
  const [duration, setDuration] = useState('15')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // ── Scene ("hoạt cảnh") state ────────────────────────────────────────────
  const [scenePrompt, setScenePrompt] = useState('')
  const [sceneTopic, setSceneTopic] = useState('')
  const [sceneSize, setSceneSize] = useState<'tiktok' | 'youtube'>('youtube')
  const [sceneDuration, setSceneDuration] = useState('5')
  const [boomerangDuration, setBoomerangDuration] = useState('15')
  const [suggesting, setSuggesting] = useState(false)

  const { data: profiles = [] } = useQuery<Profile[]>({ queryKey: ['profiles'], queryFn: () => profilesApi.list() })

  async function loadSuggestions() {
    if (!sceneTopic.trim()) { showToast('Hãy nhập chủ đề trước.', 'error'); return }
    setSuggesting(true)
    try {
      const { prompts } = await charactersApi.suggestScenePrompts(character.id, sceneSize, sceneTopic.trim())
      if (prompts[0]) setScenePrompt(prompts[0])
      else showToast('AI chưa tạo được prompt, thử lại.', 'error')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không tạo được gợi ý prompt.', 'error')
    } finally {
      setSuggesting(false)
    }
  }

  async function handleGenerate() {
    setError('')
    if (videoType === 'boomerang') {
      setSubmitting(true)
      try {
        const { genvideo_task_id, estimated_seconds } = await tiktokApi.generateSceneVideo({
          prompt: BOOMERANG_PROMPT,
          ref_image_url: refImageUrl || undefined,
          duration: Number(boomerangDuration),
          size: sceneSize,
          mode: 'boomerang',
        })
        await charactersApi.watchVideoTask(character.id, genvideo_task_id)
        const mins = estimated_seconds ? Math.ceil(estimated_seconds / 60) : null
        showToast(
          mins
            ? `Đang tạo video boomerang (~${mins} phút) ở chế độ nền — xong sẽ tự lưu vào nhân vật.`
            : 'Đang tạo video boomerang ở chế độ nền — xong sẽ tự lưu vào nhân vật.',
          'success',
        )
        onClose()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Tạo video thất bại.'
        setError(message)
        showToast(message, 'error')
      } finally {
        setSubmitting(false)
      }
      return
    }
    if (videoType === 'scene') {
      if (!scenePrompt.trim()) { setError('Hãy nhập hoặc chọn prompt cho video hoạt cảnh.'); return }
      setSubmitting(true)
      try {
        const { genvideo_task_id, estimated_seconds } = await tiktokApi.generateSceneVideo({
          prompt: scenePrompt.trim(),
          ref_image_url: refImageUrl || undefined,
          duration: Number(sceneDuration),
          size: sceneSize,
        })
        // Hand the task to the backend to poll & save into the gallery.
        await charactersApi.watchVideoTask(character.id, genvideo_task_id)
        const mins = estimated_seconds ? Math.ceil(estimated_seconds / 60) : null
        showToast(
          mins
            ? `Đang tạo video hoạt cảnh (~${mins} phút) ở chế độ nền — xong sẽ tự lưu vào nhân vật.`
            : 'Đang tạo video hoạt cảnh ở chế độ nền — xong sẽ tự lưu vào nhân vật.',
          'success',
        )
        onClose()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Tạo video thất bại.'
        setError(message)
        showToast(message, 'error')
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (!contentText.trim()) { setError('Hãy nhập nội dung video.'); return }
    setSubmitting(true)
    try {
      const { genvideo_task_id, estimated_seconds } = await tiktokApi.generateTextVideo({
        content_text: contentText.trim(),
        background_description: background.trim() || undefined,
        concept_music: musicType === 'default' && musicPath ? musicPath : undefined,
        music_file: musicType === 'custom' && musicFile ? musicFile : undefined,
        style: style || undefined,
        duration: duration ? Number(duration) : undefined,
        ref_image_url: refImageUrl || undefined,
        animation: true,
      })
      // Hand the task to the backend to poll & save in the background.
      await charactersApi.watchVideoTask(character.id, genvideo_task_id)
      const mins = estimated_seconds ? Math.ceil(estimated_seconds / 60) : null
      showToast(
        mins
          ? `Đang tạo video (~${mins} phút) ở chế độ nền — xong sẽ tự lưu vào nhân vật.`
          : 'Đang tạo video ở chế độ nền — xong sẽ tự lưu vào nhân vật.',
        'success',
      )
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tạo video thất bại.'
      setError(message)
      showToast(message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Tạo video</h2>
            <p className="mt-1 text-xs text-muted-foreground">Tạo video từ ảnh của “{character.name || 'nhân vật'}”. Video sẽ được tạo ở chế độ nền và tự lưu vào nhân vật khi xong.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 overflow-auto p-5">
          {/* Platform */}
          <div className="grid grid-cols-3 gap-2">
            {(['facebook', 'youtube', 'tiktok'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlatform(p)}
                className={`rounded-lg border px-3 py-2 text-sm font-medium capitalize transition ${
                  platform === p ? 'border-foreground bg-muted/40' : 'border-border hover:bg-muted/20'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Video type — two parts, available for all 3 platforms */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Loại video</label>
            <div className="grid grid-cols-3 gap-2">
              {([
                { value: 'text', label: 'Video có chữ' },
                { value: 'scene', label: 'Video hoạt cảnh' },
                { value: 'boomerang', label: 'Video boomerang' },
              ] as const).map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setVideoType(t.value)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                    videoType === t.value ? 'border-primary bg-primary/10 text-foreground' : 'border-border hover:bg-muted/20'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Channel/profile */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Chọn kênh (profile)</label>
            <select
              value={profileId ?? ''}
              onChange={(e) => setProfileId(e.target.value ? Number(e.target.value) : null)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">— Chọn profile —</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {videoType === 'text' && (
            <>
              {/* Content text */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Nội dung video (text overlay)</label>
                <textarea
                  value={contentText}
                  onChange={(e) => setContentText(e.target.value)}
                  rows={4}
                  placeholder="Nội dung / lời thoại hiển thị trên video..."
                  className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {/* Background description */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Ảnh nền (mô tả)</label>
                <textarea
                  value={background}
                  onChange={(e) => setBackground(e.target.value)}
                  rows={2}
                  placeholder="Mô tả bối cảnh / ảnh nền..."
                  className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </>
          )}
          {videoType === 'scene' && (
            <>
              {/* Topic → AI prompt suggestions */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Chủ đề video</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={sceneTopic}
                    onChange={(e) => setSceneTopic(e.target.value)}
                    placeholder="VD: tư vấn nâng ngực, dạo phố Đà Nẵng, review cà phê..."
                    className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={loadSuggestions}
                    disabled={suggesting || !sceneTopic.trim()}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition hover:bg-muted disabled:opacity-60"
                  >
                    {suggesting ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                    {scenePrompt ? 'Tạo lại' : 'Tạo prompt'}
                  </button>
                </div>
                {/* Quick-fill topic ideas */}
                <div className="flex flex-wrap gap-1.5">
                  {TOPIC_SUGGESTIONS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setSceneTopic(t)}
                      className={`rounded-full border px-2.5 py-1 text-xs transition hover:bg-muted/40 ${sceneTopic === t ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground'}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Nhập (hoặc chọn) chủ đề rồi bấm “Tạo prompt” để AI viết prompt hoạt cảnh vào ô bên dưới.</p>
              </div>

              {/* Scene prompt + AI suggestions */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Prompt hoạt cảnh</label>
                <textarea
                  value={scenePrompt}
                  onChange={(e) => setScenePrompt(e.target.value)}
                  rows={4}
                  placeholder="Mô tả chuyển động camera / bối cảnh (tiếng Anh cho kết quả tốt nhất)..."
                  className="resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                {suggesting && <p className="text-xs text-muted-foreground">Đang tạo prompt…</p>}
              </div>

              {/* Size + duration */}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Kích thước (size)</label>
                  <div className="inline-flex w-full overflow-hidden rounded-lg border border-border text-xs">
                    {(['youtube', 'tiktok'] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSceneSize(s)}
                        className={`flex-1 px-2.5 py-2 font-medium capitalize transition-colors ${sceneSize === s ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Độ dài (giây)</label>
                  <select value={sceneDuration} onChange={(e) => setSceneDuration(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
                    {SCENE_DURATIONS.map((d) => <option key={d} value={d}>{`${d}s`}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}

          {videoType === 'boomerang' && (
            <>
              <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                Video boomerang: AI tự tạo <b>một hành động tự nhiên</b> từ ảnh nhân vật (không cần nhập prompt). Chọn cỡ + độ dài rồi bấm Tạo video.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Kích thước (size)</label>
                  <div className="inline-flex w-full overflow-hidden rounded-lg border border-border text-xs">
                    {(['youtube', 'tiktok'] as const).map((s) => (
                      <button key={s} type="button" onClick={() => setSceneSize(s)} className={`flex-1 px-2.5 py-2 font-medium capitalize transition-colors ${sceneSize === s ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}>{s}</button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Độ dài (giây)</label>
                  <select value={boomerangDuration} onChange={(e) => setBoomerangDuration(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
                    {BOOMERANG_DURATIONS.map((d) => <option key={d} value={d}>{`${d}s`}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}

          {/* Reference image — common to both types (any character image) */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Ảnh tham chiếu (ảnh nhân vật)</label>
            {refImages.length > 0 ? (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {refImages.map((m, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setRefImageUrl(m.url)}
                    className={`aspect-square overflow-hidden rounded-lg border-2 transition ${refImageUrl === m.url ? 'border-primary' : 'border-transparent hover:border-border'}`}
                  >
                    <img src={m.url} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Nhân vật chưa có ảnh để tham chiếu.</p>
            )}
          </div>

          {videoType === 'text' && (
            <>
              {/* Music */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Nhạc nền</label>
                <div className="inline-flex w-fit overflow-hidden rounded-lg border border-border text-xs">
                  {(['default', 'custom'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMusicType(m)}
                      className={`px-2.5 py-1 font-medium transition-colors ${musicType === m ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}
                    >
                      {m === 'default' ? 'Mặc định' : 'Tuỳ chỉnh'}
                    </button>
                  ))}
                </div>
                {musicType === 'default' ? (
                  <input
                    type="text"
                    value={musicPath}
                    onChange={(e) => setMusicPath(e.target.value)}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground outline-none focus:ring-2 focus:ring-ring"
                  />
                ) : (
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(e) => setMusicFile(e.target.files?.[0] ?? null)}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
                  />
                )}
              </div>

              {/* Style + duration */}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Style video</label>
                  <select value={style} onChange={(e) => setStyle(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
                    {STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium">Độ dài (giây)</label>
                  <select value={duration} onChange={(e) => setDuration(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring">
                    {DURATIONS.map((d) => <option key={d} value={d}>{`${d}s`}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={onClose}>Hủy</Button>
          <Button onClick={handleGenerate} disabled={submitting} className="gap-1.5">
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            Tạo video
          </Button>
        </div>
      </div>
    </div>
  )
}
