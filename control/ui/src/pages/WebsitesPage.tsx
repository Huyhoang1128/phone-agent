/**
 * WebSites — manage websites to publish posts to (v1: WordPress via REST API).
 * Add a site with its URL + WordPress username + Application Password, test the
 * connection, then open a site to create / import / schedule posts.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, Loader2, Plus, Plug, Trash2, X, ExternalLink, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { websitesApi } from '@/lib/api'
import type { Website, WebsiteCreate } from '@/lib/types'

export default function WebsitesPage() {
  const { showToast } = useToast()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Website | null>(null)

  const { data: websites = [], isLoading } = useQuery<Website[]>({
    queryKey: ['websites'],
    queryFn: () => websitesApi.list(),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => websitesApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['websites'] }); showToast('Đã xoá website.', 'success') },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Xoá thất bại.', 'error'),
  })

  const testMutation = useMutation({
    mutationFn: (id: number) => websitesApi.testConnection(id),
    onSuccess: (r) => showToast(`${r.detail} (${r.wp_user})`, 'success'),
    onError: (e) => showToast(e instanceof Error ? e.message : 'Kết nối thất bại.', 'error'),
  })

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">WebSites</h1>
          <p className="text-sm text-muted-foreground">Đăng bài lên website của bạn (hỗ trợ WordPress).</p>
        </div>
        <Button size="sm" onClick={() => { setEditing(null); setModalOpen(true) }} className="gap-1.5">
          <Plus className="size-4" /> Thêm website
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : websites.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          Chưa có website nào. Bấm “Thêm website” để bắt đầu.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {websites.map((w) => (
            <div key={w.id} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Globe className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{w.name}</div>
                    <a href={w.base_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate text-xs text-muted-foreground hover:underline">
                      {w.base_url} <ExternalLink className="size-3" />
                    </a>
                  </div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${w.has_credentials ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'}`}>
                  {w.has_credentials ? 'Đã có key' : 'Thiếu key'}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => navigate(`/websites/${w.id}`)}>Mở</Button>
                <Button size="sm" variant="outline" className="gap-1" disabled={testMutation.isPending} onClick={() => testMutation.mutate(w.id)}>
                  {testMutation.isPending && testMutation.variables === w.id ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />} Test kết nối
                </Button>
                <Button size="sm" variant="ghost" className="gap-1" onClick={() => { setEditing(w); setModalOpen(true) }}><Pencil className="size-3.5" /></Button>
                <Button size="sm" variant="ghost" className="gap-1 text-destructive" onClick={() => { if (confirm(`Xoá website "${w.name}"?`)) deleteMutation.mutate(w.id) }}><Trash2 className="size-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <WebsiteModal website={editing} onClose={() => setModalOpen(false)} />
      )}
    </div>
  )
}

function WebsiteModal({ website, onClose }: { website: Website | null; onClose: () => void }) {
  const { showToast } = useToast()
  const qc = useQueryClient()
  const isEdit = !!website
  const [name, setName] = useState(website?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(website?.base_url ?? '')
  const [username, setUsername] = useState(website?.wp_username ?? '')
  const [appPassword, setAppPassword] = useState('')
  const [error, setError] = useState('')

  const mutation = useMutation({
    mutationFn: (data: Partial<WebsiteCreate>) =>
      isEdit ? websitesApi.update(website!.id, data) : websitesApi.create(data as WebsiteCreate),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['websites'] })
      showToast(isEdit ? 'Đã cập nhật website.' : 'Đã thêm website.', 'success')
      onClose()
    },
    onError: (e) => { const m = e instanceof Error ? e.message : 'Lưu thất bại.'; setError(m); showToast(m, 'error') },
  })

  function handleSave() {
    if (!name.trim() || !baseUrl.trim()) { setError('Nhập tên và URL website.'); return }
    if (!/^https?:\/\//.test(baseUrl.trim())) { setError('URL phải bắt đầu bằng http:// hoặc https://'); return }
    setError('')
    const data: Partial<WebsiteCreate> = {
      name: name.trim(),
      base_url: baseUrl.trim(),
      site_type: 'wordpress',
      wp_username: username.trim(),
    }
    if (appPassword.trim()) data.wp_app_password = appPassword.trim()
    mutation.mutate(data)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="flex w-full max-w-lg flex-col rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold">{isEdit ? 'Sửa website' : 'Thêm website'}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
        </div>
        <div className="flex flex-col gap-3 p-5">
          <Field label="Tên website">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Làm đẹp đời sống" className={inputCls} />
          </Field>
          <Field label="URL website">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://lamdepdoisong24h.com" className={inputCls} />
          </Field>
          <Field label="WordPress username">
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" className={inputCls} />
          </Field>
          <Field label={isEdit ? 'Application Password (để trống nếu giữ nguyên)' : 'Application Password'}>
            <input type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} placeholder="xxxx xxxx xxxx xxxx" className={inputCls} />
            <p className="mt-1 text-xs text-muted-foreground">Tạo trong WP: Users → Profile → Application Passwords.</p>
          </Field>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={onClose}>Hủy</Button>
          <Button onClick={handleSave} disabled={mutation.isPending} className="gap-1.5">
            {mutation.isPending && <Loader2 className="size-3.5 animate-spin" />} Lưu
          </Button>
        </div>
      </div>
    </div>
  )
}

const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
    </div>
  )
}
