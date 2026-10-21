/**
 * Website detail — list / create / import / schedule posts for one website.
 * Posts are pushed to WordPress (publish or draft). A post with a future
 * scheduled_at is auto-published by the backend scheduler; otherwise use the
 * "Đăng ngay" button.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Bold, ChevronDown, ExternalLink, FileUp, Heading2, Heading3, Images, ImagePlus, Italic, List, Loader2, Pencil, Plus, RefreshCw, Search, Send, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { websitePostsApi, websitesApi } from '@/lib/api'
import type { Website, WebsiteMedia, WebsitePost, WebsitePostCreate, WebsitePostWpStatus } from '@/lib/types'

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  pending: { text: 'Chờ đăng', cls: 'bg-amber-500/10 text-amber-600' },
  published: { text: 'Đã đăng', cls: 'bg-emerald-500/10 text-emerald-600' },
  failed: { text: 'Lỗi', cls: 'bg-red-500/10 text-red-600' },
  cancelled: { text: 'Đã huỷ', cls: 'bg-muted text-muted-foreground' },
}

export default function WebsiteDetailPage() {
  const { id } = useParams()
  const websiteId = Number(id)
  const navigate = useNavigate()
  const { showToast } = useToast()
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [editPost, setEditPost] = useState<WebsitePost | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)

  const { data: website } = useQuery<Website>({ queryKey: ['website', websiteId], queryFn: () => websitesApi.get(websiteId), enabled: !!websiteId })
  const { data: posts = [], isLoading } = useQuery<WebsitePost[]>({
    queryKey: ['website-posts', websiteId],
    queryFn: () => websitePostsApi.list(websiteId),
    enabled: !!websiteId,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['website-posts', websiteId] })

  const publishMutation = useMutation({
    mutationFn: (postId: number) => websitePostsApi.publishNow(postId),
    onSuccess: () => { invalidate(); showToast('Đã đăng bài.', 'success') },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Đăng thất bại.', 'error'),
  })
  const deleteMutation = useMutation({
    mutationFn: (postId: number) => websitePostsApi.delete(postId),
    onSuccess: () => { invalidate(); showToast('Đã xoá bài.', 'success') },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Xoá thất bại.', 'error'),
  })

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <button onClick={() => navigate('/websites')} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> WebSites
      </button>
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{website?.name ?? 'Website'}</h1>
          {website && <a href={website.base_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-muted-foreground hover:underline">{website.base_url} <ExternalLink className="size-3" /></a>}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAiOpen(true)}><Sparkles className="size-4" /> Tạo bằng AI</Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setImportOpen(true)}><FileUp className="size-4" /> Import từ Sheet</Button>
          <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}><Plus className="size-4" /> Tạo bài</Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : posts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">Chưa có bài nào.</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Tiêu đề</th>
                <th className="px-3 py-2 font-medium">Trạng thái</th>
                <th className="px-3 py-2 font-medium">WP</th>
                <th className="px-3 py-2 font-medium">Lịch đăng</th>
                <th className="px-3 py-2 font-medium text-right">Hành động</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-medium">{p.title}</div>
                    {p.error_msg && <div className="text-xs text-destructive">{p.error_msg}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_LABEL[p.status]?.cls ?? ''}`}>{STATUS_LABEL[p.status]?.text ?? p.status}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{p.wp_status === 'draft' ? 'Nháp' : 'Công khai'}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{p.scheduled_at ? new Date(p.scheduled_at).toLocaleString() : '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      {p.status === 'published' && p.post_url ? (
                        <a href={p.post_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted">Mở bài <ExternalLink className="size-3" /></a>
                      ) : (
                        <button
                          onClick={() => publishMutation.mutate(p.id)}
                          disabled={publishMutation.isPending && publishMutation.variables === p.id}
                          className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                        >
                          {publishMutation.isPending && publishMutation.variables === p.id ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Đăng ngay
                        </button>
                      )}
                      {p.status !== 'published' && (
                        <button onClick={() => setEditPost(p)} title="Chỉnh sửa" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="size-3.5" /></button>
                      )}
                      <button onClick={() => { if (confirm('Xoá bài này?')) deleteMutation.mutate(p.id) }} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"><Trash2 className="size-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && <PostModal websiteId={websiteId} onClose={() => setCreateOpen(false)} onSaved={invalidate} />}
      {editPost && <PostModal key={editPost.id} websiteId={websiteId} post={editPost} onClose={() => setEditPost(null)} onSaved={invalidate} />}
      {importOpen && <ImportModal websiteId={websiteId} onClose={() => setImportOpen(false)} onSaved={invalidate} />}
      {aiOpen && <AiGenerateModal websiteId={websiteId} onClose={() => setAiOpen(false)} onSaved={invalidate} />}
    </div>
  )
}

const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'

function WpStatusToggle({ value, onChange }: { value: WebsitePostWpStatus; onChange: (v: WebsitePostWpStatus) => void }) {
  return (
    <div className="inline-flex w-fit overflow-hidden rounded-lg border border-border text-xs">
      {(['publish', 'draft'] as const).map((s) => (
        <button key={s} type="button" onClick={() => onChange(s)} className={`px-3 py-1.5 font-medium transition-colors ${value === s ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}>
          {s === 'publish' ? 'Đăng công khai' : 'Lưu nháp'}
        </button>
      ))}
    </div>
  )
}

/** Convert an ISO timestamp to a value usable by <input type="datetime-local"> (local time). */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface RichEditorHandle { insertHtml: (html: string) => void }

/** Word-like WYSIWYG editor over a contentEditable div. Emits HTML via onChange.
 * The image button saves the caret first (the file dialog steals focus) then
 * calls onPickImage; the parent inserts the resulting <figure> via insertHtml(). */
const RichEditor = forwardRef<RichEditorHandle, { value: string; onChange: (html: string) => void; onPickImage: () => void; busy?: boolean }>(
  function RichEditor({ value, onChange, onPickImage, busy }, ref) {
    const el = useRef<HTMLDivElement>(null)
    const savedRange = useRef<Range | null>(null)
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

    // Reflect external value (initial mount + programmatic replace like regenerate /
    // image insert) without clobbering the caret while the user is typing.
    useEffect(() => {
      const node = el.current
      if (node && node.innerHTML !== value) node.innerHTML = value || ''
    }, [value])

    // Close the right-click menu on any outside interaction.
    useEffect(() => {
      if (!menu) return
      const close = () => setMenu(null)
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
      window.addEventListener('mousedown', close)
      window.addEventListener('scroll', close, true)
      window.addEventListener('keydown', onKey)
      return () => { window.removeEventListener('mousedown', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', onKey) }
    }, [menu])

    const saveRange = () => {
      const sel = window.getSelection()
      if (sel && sel.rangeCount && el.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange()
    }
    const restoreRange = () => {
      const sel = window.getSelection()
      if (savedRange.current && sel) { sel.removeAllRanges(); sel.addRange(savedRange.current) }
    }
    const emit = () => { if (el.current) onChange(el.current.innerHTML) }
    const exec = (cmd: string, arg?: string) => { el.current?.focus(); document.execCommand(cmd, false, arg); emit() }

    function onContextMenu(e: React.MouseEvent) {
      const sel = window.getSelection()
      const hasText = !!sel && !sel.isCollapsed && !!el.current?.contains(sel.anchorNode)
      if (!hasText) return // no selection → let the browser's native menu appear
      e.preventDefault()
      saveRange()
      setMenu({ x: e.clientX, y: e.clientY })
    }
    function menuExec(cmd: string, arg?: string) {
      el.current?.focus(); restoreRange()
      document.execCommand(cmd, false, arg)
      emit(); setMenu(null)
    }

    useImperativeHandle(ref, () => ({
      insertHtml(html: string) {
        const node = el.current
        if (!node) return
        node.focus(); restoreRange()
        document.execCommand('insertHTML', false, html)
        savedRange.current = null
        emit()
      },
    }), [])

    const MENU: Array<[string, React.ReactNode, () => void]> = [
      ['Đậm', <Bold className="size-3.5" />, () => menuExec('bold')],
      ['Nghiêng', <Italic className="size-3.5" />, () => menuExec('italic')],
      ['Gạch chân', <span className="text-xs underline">U</span>, () => menuExec('underline')],
      ['Tiêu đề lớn', <Heading2 className="size-3.5" />, () => menuExec('formatBlock', '<h2>')],
      ['Tiêu đề nhỏ', <Heading3 className="size-3.5" />, () => menuExec('formatBlock', '<h3>')],
      ['Đoạn văn', <span className="text-xs">P</span>, () => menuExec('formatBlock', '<p>')],
      ['Danh sách', <List className="size-3.5" />, () => menuExec('insertUnorderedList')],
      ['Xoá định dạng', <span className="text-xs">⌫</span>, () => menuExec('removeFormat')],
    ]

    return (
      <div className="flex flex-col">
        <div className="flex flex-wrap items-center gap-1 rounded-t-lg border border-b-0 border-border bg-muted/30 p-1.5">
          <FmtBtn title="In đậm" onClick={() => exec('bold')}><Bold className="size-3.5" /></FmtBtn>
          <FmtBtn title="In nghiêng" onClick={() => exec('italic')}><Italic className="size-3.5" /></FmtBtn>
          <FmtBtn title="Tiêu đề lớn" onClick={() => exec('formatBlock', '<h2>')}><Heading2 className="size-3.5" /></FmtBtn>
          <FmtBtn title="Tiêu đề nhỏ" onClick={() => exec('formatBlock', '<h3>')}><Heading3 className="size-3.5" /></FmtBtn>
          <FmtBtn title="Đoạn văn" onClick={() => exec('formatBlock', '<p>')}>P</FmtBtn>
          <FmtBtn title="Danh sách" onClick={() => exec('insertUnorderedList')}><List className="size-3.5" /></FmtBtn>
          <span className="mx-1 h-5 w-px bg-border" />
          <FmtBtn title="Chèn ảnh tại vị trí con trỏ" onClick={() => { saveRange(); onPickImage() }}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}
          </FmtBtn>
          <span className="ml-auto pr-1 text-[11px] text-muted-foreground">Bôi đen chữ rồi bấm chuột phải để định dạng nhanh</span>
        </div>
        <div
          ref={el}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          onBlur={saveRange}
          onContextMenu={onContextMenu}
          data-placeholder="Soạn nội dung như trên Word: bôi chọn chữ rồi bấm định dạng (hoặc chuột phải), đặt con trỏ rồi bấm ảnh để chèn vào đúng chỗ…"
          className="min-h-[460px] flex-1 overflow-auto rounded-b-lg border border-border bg-background px-4 py-3 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)] [&_h2]:my-2 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:my-2 [&_h3]:text-lg [&_h3]:font-semibold [&_img]:my-2 [&_img]:max-w-full [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
        />
        {menu && (
          <div
            className="fixed z-[80] min-w-[180px] overflow-hidden rounded-lg border border-border bg-card py-1 shadow-xl"
            style={{ top: menu.y, left: menu.x }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {MENU.map(([label, icon, fn]) => (
              <button key={label} type="button" onClick={fn} className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-muted">
                <span className="flex w-4 justify-center text-muted-foreground">{icon}</span> {label}
              </button>
            ))}
            <div className="my-1 h-px bg-border" />
            <button type="button" onClick={() => { setMenu(null); onPickImage() }} className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-muted">
              <span className="flex w-4 justify-center text-muted-foreground"><ImagePlus className="size-3.5" /></span> Chèn ảnh ở đây
            </button>
          </div>
        )}
      </div>
    )
  },
)

function PostModal({ websiteId, post, onClose, onSaved }: { websiteId: number; post?: WebsitePost; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!post
  const { showToast } = useToast()
  const [title, setTitle] = useState(post?.title ?? '')
  const [content, setContent] = useState(post?.content ?? '')
  const [excerpt, setExcerpt] = useState(post?.excerpt ?? '')
  const [slug, setSlug] = useState(post?.slug ?? '')
  const [imageUrl, setImageUrl] = useState(post?.featured_media_id ? '' : (post?.image_url ?? ''))
  const [wpStatus, setWpStatus] = useState<WebsitePostWpStatus>(post?.wp_status ?? 'publish')
  const [scheduledAt, setScheduledAt] = useState(post?.scheduled_at ? toLocalInput(post.scheduled_at) : '')
  const [cats, setCats] = useState<number[]>(post?.categories ?? [])
  const [tags, setTags] = useState<number[]>(post?.tags ?? [])
  const [error, setError] = useState('')
  const [taxRequested, setTaxRequested] = useState(false)

  // Lazy: only fetch categories/tags when the user opens a picker.
  const { data: tax, isLoading: taxLoading, isError: taxError } = useQuery({
    queryKey: ['website-taxonomies', websiteId],
    queryFn: () => websitesApi.taxonomies(websiteId),
    enabled: taxRequested,
  })

  const toggle = (arr: number[], setArr: (v: number[]) => void, id: number) =>
    setArr(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id])

  const mutation = useMutation({
    mutationFn: (data: WebsitePostCreate) => (isEdit ? websitePostsApi.update(post!.id, data) : websitePostsApi.create(data)),
    onSuccess: () => { onSaved(); showToast(isEdit ? 'Đã lưu thay đổi.' : (scheduledAt ? 'Đã lên lịch bài.' : 'Đã tạo bài (bấm Đăng ngay để đăng).'), 'success'); onClose() },
    onError: (e) => { const m = e instanceof Error ? e.message : 'Lưu thất bại.'; setError(m); showToast(m, 'error') },
  })

  // Re-generate the article content with AI (edit mode only — needs a saved post).
  const regen = useMutation({
    mutationFn: () => websitePostsApi.regenerate(post!.id),
    onSuccess: (p) => { setContent(p.content); if (p.excerpt) setExcerpt(p.excerpt); showToast('Đã tạo lại nội dung.', 'success') },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Tạo lại nội dung thất bại.', 'error'),
  })

  const [featuredMediaId, setFeaturedMediaId] = useState<number | null>(post?.featured_media_id ?? null)
  const [imagePreview, setImagePreview] = useState(post?.image_url ?? '')
  const [uploading, setUploading] = useState(false)
  const [mediaPickerFor, setMediaPickerFor] = useState<'content' | 'featured' | null>(null)
  const [pendingImg, setPendingImg] = useState<string | null>(null)
  const [imgCaption, setImgCaption] = useState('')
  const [imgSize, setImgSize] = useState<'small' | 'medium' | 'large'>('medium')
  const editorRef = useRef<RichEditorHandle>(null)

  // A pick from the media library: featured image, or the in-article image (which
  // then goes through the caption/size step before being inserted at the caret).
  function onPickMedia(m: WebsiteMedia) {
    if (mediaPickerFor === 'featured') {
      setFeaturedMediaId(m.id); setImagePreview(m.source_url); setImageUrl('')
    } else {
      setPendingImg(m.source_url); setImgCaption('')
    }
    setMediaPickerFor(null)
  }

  function confirmInsertImage() {
    if (!pendingImg) return
    const cap = imgCaption.trim()
    const maxW = imgSize === 'small' ? '360px' : imgSize === 'medium' ? '640px' : '100%'
    const imgStyle = `display:block;margin:0 auto;width:100%;max-width:${maxW};height:auto;`
    const fig = `<figure class="wp-block-image aligncenter" style="text-align:center;margin:1.5em auto;"><img src="${pendingImg}" alt="" style="${imgStyle}"/>${cap ? `<figcaption style="text-align:center;font-style:italic;font-size:1em;color:#666;margin-top:.5em;">${cap}</figcaption>` : ''}</figure><p><br/></p>`
    editorRef.current?.insertHtml(fig)
    setPendingImg(null); setImgCaption('')
  }

  async function handleUpload(file?: File | null) {
    if (!file) return
    setUploading(true); setError('')
    try {
      const r = await websitesApi.uploadMedia(websiteId, file)
      setFeaturedMediaId(r.id)
      setImagePreview(r.source_url)
      setImageUrl('')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Upload ảnh thất bại.', 'error')
    } finally { setUploading(false) }
  }
  function clearImage() { setFeaturedMediaId(null); setImagePreview(''); setImageUrl('') }

  function handleSave() {
    if (!title.trim()) { setError('Nhập tiêu đề.'); return }
    setError('')
    mutation.mutate({
      website: websiteId,
      title: title.trim(),
      content,
      excerpt: excerpt.trim() || undefined,
      slug: slug.trim() || undefined,
      image_url: imageUrl.trim() || undefined,
      featured_media_id: featuredMediaId,
      categories: cats,
      tags,
      wp_status: wpStatus,
      scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
    })
  }

  const previewSrc = imagePreview || imageUrl.trim()

  return (
    <ModalShell title={isEdit ? 'Chỉnh sửa bài viết' : 'Tạo bài viết'} onClose={onClose} onSave={handleSave} saving={mutation.isPending} saveLabel={isEdit ? 'Lưu thay đổi' : 'Lưu'} fullscreen>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">Tiêu đề</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputCls} text-base`} placeholder="Tiêu đề bài viết" />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {/* Left — nội dung */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Nội dung</label>
              {isEdit && (
                <button type="button" onClick={() => regen.mutate()} disabled={regen.isPending} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted disabled:opacity-60">
                  {regen.isPending ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} Tạo lại nội dung
                </button>
              )}
            </div>
            <RichEditor ref={editorRef} value={content} onChange={setContent} onPickImage={() => setMediaPickerFor('content')} />
          </div>
          {(post?.source_images?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Ảnh từ Sheet — đặt con trỏ vào chỗ muốn chèn rồi bấm 1 ảnh</label>
              <div className="flex flex-wrap gap-2 rounded-lg border border-border bg-muted/20 p-2">
                {post!.source_images.map((u, i) => (
                  <button key={i} type="button" onClick={() => { setPendingImg(u); setImgCaption('') }} title="Chèn ảnh này vào vị trí con trỏ" className="h-20 w-20 overflow-hidden rounded-md border border-border transition hover:ring-2 hover:ring-ring">
                    <img src={u} alt="" loading="lazy" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Mô tả ngắn (excerpt)</label>
            <textarea value={excerpt} onChange={(e) => setExcerpt(e.target.value)} rows={3} className={`${inputCls} resize-y`} placeholder="Tóm tắt hiển thị ở danh sách bài..." />
          </div>
        </div>

        {/* Right — ảnh, slug, phân loại, đăng */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Ảnh đại diện</label>
            {previewSrc ? (
              <div className="relative">
                <img src={previewSrc} alt="" className="h-44 w-full rounded-lg border border-border object-cover" />
                <button type="button" onClick={clearImage} className="absolute right-2 top-2 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"><X className="size-3.5" /></button>
              </div>
            ) : (
              <label className="flex h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border text-sm text-muted-foreground transition hover:bg-muted/30">
                {uploading ? <Loader2 className="size-6 animate-spin" /> : <ImagePlus className="size-7" />}
                <span>{uploading ? 'Đang tải ảnh…' : 'Tải ảnh từ máy'}</span>
                <input type="file" accept="image/*" className="hidden" disabled={uploading} onChange={(e) => handleUpload(e.target.files?.[0])} />
              </label>
            )}
            <input value={imageUrl} onChange={(e) => { setImageUrl(e.target.value); setFeaturedMediaId(null); setImagePreview('') }} className={inputCls} placeholder="hoặc dán URL ảnh public…" disabled={!!featuredMediaId} />
            <button type="button" onClick={() => setMediaPickerFor('featured')} className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
              <Images className="size-3.5" /> Chọn từ thư viện ảnh
            </button>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Slug (đường dẫn)</label>
            <input value={slug} onChange={(e) => setSlug(e.target.value)} className={inputCls} placeholder="vd: lam-dep-da-mua-he" />
            <p className="text-xs text-muted-foreground">Phần đuôi URL của bài. Để trống → WordPress tự tạo từ tiêu đề.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <TermSelect label="Danh mục" terms={tax?.categories} selected={cats} onToggle={(id) => toggle(cats, setCats, id)} loading={taxLoading} error={taxError} onOpen={() => setTaxRequested(true)} />
            <TermSelect label="Thẻ" terms={tax?.tags} selected={tags} onToggle={(id) => toggle(tags, setTags, id)} loading={taxLoading} error={taxError} onOpen={() => setTaxRequested(true)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5"><label className="text-sm font-medium">Chế độ đăng</label><WpStatusToggle value={wpStatus} onChange={setWpStatus} /></div>
            <div className="flex flex-col gap-1.5"><label className="text-sm font-medium">Lịch đăng (tuỳ chọn)</label><input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className={inputCls} /></div>
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}

      {mediaPickerFor && <MediaPicker websiteId={websiteId} onPick={onPickMedia} onClose={() => setMediaPickerFor(null)} />}

      {/* Caption step for inline content image (replaces the browser prompt) */}
      {pendingImg && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl">
            <h3 className="mb-3 text-sm font-semibold">Chèn ảnh vào bài</h3>
            <img src={pendingImg} alt="" className="mb-3 max-h-56 w-full rounded-lg border border-border object-contain" />
            <label className="text-sm font-medium">Chú thích ảnh (tuỳ chọn)</label>
            <input value={imgCaption} onChange={(e) => setImgCaption(e.target.value)} className={`${inputCls} mt-1`} placeholder="VD: khi làm đẹp vùng kín không còn là chuyện ‘tế nhị’" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') confirmInsertImage() }} />
            <p className="mt-1 text-xs text-muted-foreground">Chú thích sẽ căn giữa, in nghiêng dưới ảnh.</p>
            <div className="mt-3">
              <label className="text-sm font-medium">Cỡ ảnh</label>
              <div className="mt-1 inline-flex overflow-hidden rounded-lg border border-border text-xs">
                {([['small', 'Nhỏ'], ['medium', 'Vừa'], ['large', 'Lớn']] as const).map(([v, lbl]) => (
                  <button key={v} type="button" onClick={() => setImgSize(v)} className={`px-3 py-1.5 font-medium transition-colors ${imgSize === v ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}>{lbl}</button>
                ))}
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setPendingImg(null); setImgCaption('') }}>Bỏ</Button>
              <Button onClick={confirmInsertImage}>Chèn vào bài</Button>
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  )
}

function FmtBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick} className="inline-flex min-w-[28px] items-center justify-center rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground">
      {children}
    </button>
  )
}

function TermSelect({ label, terms, selected, onToggle, loading, error, onOpen }: { label: string; terms?: { id: number; name: string }[]; selected: number[]; onToggle: (id: number) => void; loading: boolean; error: boolean; onOpen: () => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const list = terms || []
  const selNames = list.filter((t) => selected.includes(t.id))
  const filtered = q ? list.filter((t) => t.name.toLowerCase().includes(q.toLowerCase())) : list

  return (
    <div className="flex flex-col gap-1.5" ref={ref}>
      <label className="text-sm font-medium">{label}</label>
      <div className="relative">
        <button type="button" onClick={() => { const n = !open; setOpen(n); if (n) onOpen() }} className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm hover:bg-muted/30">
          <span className="truncate text-muted-foreground">{selected.length ? `${selected.length} đã chọn` : `Chọn ${label.toLowerCase()}`}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
        {open && (
          <div className="absolute left-0 right-0 z-30 mt-1 rounded-lg border border-border bg-card shadow-lg">
            <div className="p-2"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm…" className={`${inputCls} text-xs`} autoFocus /></div>
            <div className="max-h-44 overflow-auto px-2 pb-2">
              {loading ? <p className="px-1 py-2 text-xs text-muted-foreground">Đang tải…</p>
                : error ? <p className="px-1 py-2 text-xs text-destructive">Không tải được.</p>
                : filtered.length === 0 ? <p className="px-1 py-2 text-xs text-muted-foreground">Không có.</p>
                : filtered.map((t) => (
                  <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/40">
                    <input type="checkbox" checked={selected.includes(t.id)} onChange={() => onToggle(t.id)} />
                    <span dangerouslySetInnerHTML={{ __html: t.name }} />
                  </label>
                ))}
            </div>
          </div>
        )}
      </div>
      {selNames.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selNames.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-foreground">
              <span dangerouslySetInnerHTML={{ __html: t.name }} />
              <button type="button" onClick={() => onToggle(t.id)} className="text-muted-foreground hover:text-destructive">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ImportModal({ websiteId, onClose, onSaved }: { websiteId: number; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useToast()
  const [sheetUrl, setSheetUrl] = useState('')
  const [wpStatus, setWpStatus] = useState<WebsitePostWpStatus>('draft')
  const [useAi, setUseAi] = useState(true)
  const [error, setError] = useState('')
  const [rowErrors, setRowErrors] = useState<Array<{ row: number; error: string }>>([])

  const mutation = useMutation({
    mutationFn: () => websitePostsApi.import({ website: websiteId, sheet_url: sheetUrl.trim(), wp_status: wpStatus, use_ai: useAi }),
    onSuccess: (r) => {
      onSaved()
      showToast(`Đã import ${r.created} bài${r.skipped ? `, bỏ qua ${r.skipped}` : ''}.`, 'success')
      if (r.errors && r.errors.length) { setRowErrors(r.errors) } else { onClose() }
    },
    onError: (e) => { const m = e instanceof Error ? e.message : 'Import thất bại.'; setError(m); showToast(m, 'error') },
  })

  function handleImport() {
    if (!/docs\.google\.com\/spreadsheets\/d\//.test(sheetUrl.trim())) { setError('Dán link Google Sheet hợp lệ.'); return }
    setError(''); setRowErrors([])
    mutation.mutate()
  }

  return (
    <ModalShell title="Import từ Google Sheets" onClose={onClose} onSave={handleImport} saving={mutation.isPending} saveLabel="Import">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">Google Sheets URL</label>
        <input value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} className={inputCls} placeholder="https://docs.google.com/spreadsheets/d/.../edit" />
        <p className="text-xs text-muted-foreground">Sheet share “Anyone with the link → Viewer”. Header không phân biệt hoa thường.</p>
        <pre className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">{`Cột bắt buộc: title  (alias: tiêu đề / chủ đề / topic)

Cột tuỳ chọn:
• content      — nội dung (alias: nội dung / body)
• excerpt      — mô tả ngắn (alias: mô tả / tóm tắt)
• slug         — đường dẫn (alias: đường dẫn)
• categories   — danh mục, ghi theo TÊN, cách nhau dấu phẩy (alias: danh mục / chuyên mục)
• tags         — thẻ, ghi theo TÊN, cách nhau dấu phẩy (alias: thẻ)
• scheduled_at — ngày đăng (alias: ngày / lịch đăng / thời gian)
• wp_status    — publish | draft (alias: trạng thái)

2 cột ẢNH (nhận link public HOẶC Google Drive file/thư mục):
• thumbnail     — ảnh đại diện (alias: ảnh / image_url / featured / ảnh bìa)
• ảnh trong bài — ảnh chèn vào nội dung (alias: body_image / ảnh nội dung)
  → Ảnh được tải lên thư viện media của website, hiện ở khu "Ảnh từ Sheet"
    khi Sửa bài để bạn tự chọn vị trí chèn.
• Drive folder (cần GOOGLE_API_KEY): https://drive.google.com/drive/folders/<id>
  → lấy hết ảnh trong folder.

Định dạng:
• content text thường: dòng trống ngắt đoạn; "# Tiêu đề", "**đậm**",
  "*nghiêng*", "- gạch đầu dòng" tự chuyển sang HTML (dán HTML vẫn được).
• scheduled_at ngày-trước, ví dụ 17/06/2026 9:32 (hoặc 2026-06-17 09:32).
• Cột ngoài danh sách trên sẽ bị bỏ qua.`}</pre>
      </div>
      <label className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3 text-sm">
        <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} className="mt-0.5" />
        <span>
          <b>AI tự viết nội dung</b> từ chủ đề mỗi dòng (bài sẽ <b>lưu nháp</b>).
          <span className="block text-xs text-muted-foreground">Khi bật: cột content (nếu có) là yêu cầu thêm cho AI; AI tự chọn danh mục/thẻ có sẵn. Ảnh từ sheet (thumbnail + ảnh trong bài) được lưu vào khu “Ảnh từ Sheet” để bạn tự chèn khi Sửa bài; thumbnail vẫn làm ảnh đại diện.</span>
        </span>
      </label>
      <div className="flex flex-col gap-1.5"><label className="text-sm font-medium">Chế độ đăng mặc định</label><WpStatusToggle value={wpStatus} onChange={setWpStatus} /></div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {rowErrors.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <p className="mb-1 font-medium text-amber-600">Một số dòng có cảnh báo (bài vẫn được tạo nếu có tiêu đề):</p>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {rowErrors.slice(0, 12).map((er, i) => <li key={i}>Dòng {er.row}: {er.error}</li>)}
          </ul>
        </div>
      )}
    </ModalShell>
  )
}

function AiGenerateModal({ websiteId, onClose, onSaved }: { websiteId: number; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useToast()
  const [topic, setTopic] = useState('')
  const [count, setCount] = useState('3')
  const [error, setError] = useState('')

  const mutation = useMutation({
    mutationFn: () => websitePostsApi.aiGenerate({
      website: websiteId,
      topic: topic.trim(),
      count: Math.min(Math.max(parseInt(count, 10) || 1, 1), 5),
    }),
    onSuccess: (r) => { onSaved(); showToast(`AI đã tạo ${r.created} bài (lưu nháp).`, 'success'); onClose() },
    onError: (e) => { const m = e instanceof Error ? e.message : 'Tạo bằng AI thất bại.'; setError(m); showToast(m, 'error') },
  })

  function handleGenerate() {
    if (!topic.trim()) { setError('Nhập chủ đề.'); return }
    setError('')
    mutation.mutate()
  }

  return (
    <ModalShell title="Tạo bài bằng AI" onClose={onClose} onSave={handleGenerate} saving={mutation.isPending} saveLabel="Tạo">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">Chủ đề</label>
        <textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={3} className={inputCls} placeholder="VD: Cách chăm sóc da mùa hè cho người da dầu" />
        <p className="text-xs text-muted-foreground">AI tự viết tiêu đề, nội dung (HTML), mô tả, slug và chọn <b>danh mục/thẻ có sẵn</b> của website. Bài luôn <b>lưu nháp</b> — bạn mở Sửa để chèn ảnh, chỉnh lại rồi mới đăng.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">Số bài (1–5)</label>
        <input type="number" min={1} max={5} value={count} onChange={(e) => setCount(e.target.value)} className={`${inputCls} w-24`} />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </ModalShell>
  )
}

/** Pick an image from the website's WordPress media library, or upload a new one
 * (which lands in the library and is selected immediately). Returns the chosen
 * media item to the caller. */
function MediaPicker({ websiteId, onPick, onClose }: { websiteId: number; onPick: (m: WebsiteMedia) => void; onClose: () => void }) {
  const { showToast } = useToast()
  const qc = useQueryClient()
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  const [uploading, setUploading] = useState(false)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['website-media', websiteId, search],
    queryFn: () => websitesApi.listMedia(websiteId, search),
  })
  const items = data?.media ?? []

  async function handleUpload(file?: File | null) {
    if (!file) return
    setUploading(true)
    try {
      const r = await websitesApi.uploadMedia(websiteId, file)
      qc.invalidateQueries({ queryKey: ['website-media', websiteId] })
      onPick({ id: r.id, source_url: r.source_url, thumb: r.source_url, title: file.name })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Upload ảnh thất bại.', 'error')
    } finally { setUploading(false) }
  }

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-border bg-card shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold"><Images className="size-4" /> Thư viện ảnh</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
        </div>
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setSearch(term.trim()) }} placeholder="Tìm ảnh theo tên… (Enter)" className={`${inputCls} pl-8`} />
          </div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted">
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Tải ảnh mới
            <input type="file" accept="image/*" className="hidden" disabled={uploading} onChange={(e) => { handleUpload(e.target.files?.[0]); e.target.value = '' }} />
          </label>
        </div>
        <div className="flex-1 overflow-auto p-5">
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : isError ? (
            <p className="py-12 text-center text-sm text-destructive">Không tải được thư viện ảnh. Kiểm tra kết nối WordPress của website.</p>
          ) : items.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">Chưa có ảnh nào. Bấm “Tải ảnh mới” để thêm.</p>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
              {items.map((m) => (
                <button key={m.id} type="button" onClick={() => onPick(m)} title={m.title || 'Chọn ảnh này'} className="group relative aspect-square overflow-hidden rounded-lg border border-border hover:ring-2 hover:ring-ring">
                  <img src={m.thumb || m.source_url} alt={m.title} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ModalShell({ title, children, onClose, onSave, saving, saveLabel = 'Lưu', wide = false, fullscreen = false }: { title: string; children: React.ReactNode; onClose: () => void; onSave: () => void; saving: boolean; saveLabel?: string; wide?: boolean; fullscreen?: boolean }) {
  return (
    <div className={fullscreen ? 'fixed inset-0 z-[60] flex flex-col bg-background' : 'fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4'}>
      <div className={fullscreen ? 'flex h-full w-full flex-col' : `flex max-h-[95vh] min-h-[60vh] w-full flex-col rounded-2xl border border-border bg-card shadow-xl ${wide ? 'max-w-6xl' : 'max-w-lg'}`}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            {fullscreen && (
              <button onClick={onClose} title="Quay lại" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
                <ArrowLeft className="size-4" /> Quay lại
              </button>
            )}
            <h2 className="text-base font-semibold">{title}</h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
        </div>
        <div className="flex-1 overflow-auto">
          <div className={`flex flex-col gap-3 p-5 ${fullscreen ? 'mx-auto w-full max-w-7xl' : ''}`}>{children}</div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={onClose}>Hủy</Button>
          <Button onClick={onSave} disabled={saving} className="gap-1.5">{saving && <Loader2 className="size-3.5 animate-spin" />} {saveLabel}</Button>
        </div>
      </div>
    </div>
  )
}
