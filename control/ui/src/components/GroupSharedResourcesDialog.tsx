import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { X, Plus, Trash2, Upload, BrainCircuit } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/context/ToastContext'
import { agentGroupsApi } from '@/lib/api'
import type { AgentGroupSharedMemory, AgentGroupSharedFile, AgentGroupSharedState } from '@/lib/types'

type Tab = 'memory' | 'files' | 'state'

interface Props {
  groupId: number
  groupName: string
  onClose: () => void
}

export function GroupSharedResourcesDialog({ groupId, groupName, onClose }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { showToast } = useToast()
  const [tab, setTab] = useState<Tab>('memory')

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4">
      <div className="flex w-full max-w-2xl flex-col rounded-t-2xl sm:rounded-xl border border-border bg-background shadow-xl max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <BrainCircuit className="size-4 text-primary" />
            <h2 className="text-base font-semibold">{t('agentGroups.sharedResources')}</h2>
            <span className="text-sm text-muted-foreground">— {groupName}</span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border px-5 pt-3">
          {(['memory', 'files', 'state'] as Tab[]).map((t_) => (
            <button
              key={t_}
              onClick={() => setTab(t_)}
              className={`pb-2.5 px-3 text-sm font-medium transition-colors border-b-2 ${
                tab === t_
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(`agentGroups.tab${t_.charAt(0).toUpperCase() + t_.slice(1)}`)}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'memory' && (
            <MemoryTab groupId={groupId} qc={qc} showToast={showToast} t={t} />
          )}
          {tab === 'files' && (
            <FilesTab groupId={groupId} qc={qc} showToast={showToast} t={t} />
          )}
          {tab === 'state' && (
            <StateTab groupId={groupId} qc={qc} showToast={showToast} t={t} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Memory Tab ─────────────────────────────────────────────────────────────────

function MemoryTab({
  groupId,
  qc,
  showToast,
  t,
}: {
  groupId: number
  qc: ReturnType<typeof useQueryClient>
  showToast: (msg: string, type: 'success' | 'error') => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [formError, setFormError] = useState('')

  const { data: items = [], isLoading } = useQuery<AgentGroupSharedMemory[]>({
    queryKey: ['agent-group-memory', groupId],
    queryFn: () => agentGroupsApi.listSharedMemory(groupId),
  })

  const setMutation = useMutation({
    mutationFn: () => agentGroupsApi.setSharedMemory(groupId, key.trim(), value),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-group-memory', groupId] })
      setKey('')
      setValue('')
      setFormError('')
      showToast(t('common.saveSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message, 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => agentGroupsApi.deleteSharedMemory(groupId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-group-memory', groupId] })
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!key.trim()) {
      setFormError(t('agentGroups.keyRequired'))
      return
    }
    setMutation.mutate()
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
        <p className="text-xs font-medium text-muted-foreground">{t('agentGroups.addMemory')}</p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder={t('agentGroups.keyPlaceholder')}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="h-8 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="text"
            placeholder={t('agentGroups.valuePlaceholder')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 flex-[2] rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <Button type="submit" size="sm" disabled={setMutation.isPending}>
            <Plus className="size-3.5" />
          </Button>
        </div>
        {formError && <p className="text-xs text-destructive">{formError}</p>}
      </form>

      {isLoading ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('agentGroups.noMemory')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{t('agentGroups.colKey')}</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{t('agentGroups.colValue')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t border-border hover:bg-muted/40">
                <td className="px-3 py-2 font-mono text-xs font-medium">{item.key}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground break-all">{item.value}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => deleteMutation.mutate(item.id)}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    aria-label={t('common.delete')}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Files Tab ──────────────────────────────────────────────────────────────────

function FilesTab({
  groupId,
  qc,
  showToast,
  t,
}: {
  groupId: number
  qc: ReturnType<typeof useQueryClient>
  showToast: (msg: string, type: 'success' | 'error') => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [formError, setFormError] = useState('')

  const { data: items = [], isLoading } = useQuery<AgentGroupSharedFile[]>({
    queryKey: ['agent-group-files', groupId],
    queryFn: () => agentGroupsApi.listSharedFiles(groupId),
  })

  const uploadMutation = useMutation({
    mutationFn: () => {
      if (!selectedFile) throw new Error('No file selected')
      const name = fileName.trim() || selectedFile.name
      return agentGroupsApi.uploadSharedFile(groupId, name, selectedFile)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-group-files', groupId] })
      setFileName('')
      setSelectedFile(null)
      setFormError('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      showToast(t('common.createSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message, 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => agentGroupsApi.deleteSharedFile(groupId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-group-files', groupId] })
    },
  })

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    setSelectedFile(file)
    if (file && !fileName) setFileName(file.name)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedFile) {
      setFormError(t('agentGroups.fileRequired'))
      return
    }
    uploadMutation.mutate()
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
        <p className="text-xs font-medium text-muted-foreground">{t('agentGroups.uploadFile')}</p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder={t('agentGroups.fileNamePlaceholder')}
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            className="h-8 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <label className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground hover:bg-muted">
            <Upload className="size-3.5" />
            {selectedFile ? selectedFile.name : t('agentGroups.chooseFile')}
            <input ref={fileInputRef} type="file" className="sr-only" onChange={handleFileChange} />
          </label>
          <Button type="submit" size="sm" disabled={!selectedFile || uploadMutation.isPending}>
            <Plus className="size-3.5" />
          </Button>
        </div>
        {formError && <p className="text-xs text-destructive">{formError}</p>}
      </form>

      {isLoading ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('agentGroups.noFiles')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{t('agentGroups.colFileName')}</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{t('agentGroups.colUploaded')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t border-border hover:bg-muted/40">
                <td className="px-3 py-2 text-xs font-medium">
                  {item.file_url ? (
                    <a href={item.file_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      {item.name}
                    </a>
                  ) : (
                    item.name
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {new Date(item.uploaded_at).toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' })}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => deleteMutation.mutate(item.id)}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    aria-label={t('common.delete')}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── State Tab ──────────────────────────────────────────────────────────────────

function StateTab({
  groupId,
  qc,
  showToast,
  t,
}: {
  groupId: number
  qc: ReturnType<typeof useQueryClient>
  showToast: (msg: string, type: 'success' | 'error') => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [key, setKey] = useState('')
  const [rawValue, setRawValue] = useState('')
  const [jsonError, setJsonError] = useState('')
  const [formError, setFormError] = useState('')

  const { data: items = [], isLoading } = useQuery<AgentGroupSharedState[]>({
    queryKey: ['agent-group-state', groupId],
    queryFn: () => agentGroupsApi.listSharedState(groupId),
  })

  const setMutation = useMutation({
    mutationFn: (parsed: unknown) => agentGroupsApi.setSharedState(groupId, key.trim(), parsed),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-group-state', groupId] })
      setKey('')
      setRawValue('')
      setJsonError('')
      setFormError('')
      showToast(t('common.saveSuccess'), 'success')
    },
    onError: (err: Error) => {
      setFormError(err.message)
      showToast(err.message, 'error')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => agentGroupsApi.deleteSharedState(groupId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-group-state', groupId] })
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!key.trim()) {
      setFormError(t('agentGroups.keyRequired'))
      return
    }
    let parsed: unknown = rawValue
    if (rawValue.trim()) {
      try {
        parsed = JSON.parse(rawValue)
        setJsonError('')
      } catch {
        setJsonError(t('agentGroups.invalidJson'))
        return
      }
    }
    setMutation.mutate(parsed)
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
        <p className="text-xs font-medium text-muted-foreground">{t('agentGroups.addState')}</p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder={t('agentGroups.keyPlaceholder')}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="h-8 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="text"
            placeholder={t('agentGroups.jsonValuePlaceholder')}
            value={rawValue}
            onChange={(e) => { setRawValue(e.target.value); setJsonError('') }}
            className={`h-8 flex-[2] rounded-lg border bg-background px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring ${jsonError ? 'border-destructive' : 'border-border'}`}
          />
          <Button type="submit" size="sm" disabled={setMutation.isPending}>
            <Plus className="size-3.5" />
          </Button>
        </div>
        {(formError || jsonError) && <p className="text-xs text-destructive">{jsonError || formError}</p>}
      </form>

      {isLoading ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('agentGroups.noState')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/50">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{t('agentGroups.colKey')}</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{t('agentGroups.colValue')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t border-border hover:bg-muted/40">
                <td className="px-3 py-2 font-mono text-xs font-medium">{item.key}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground break-all">
                  {JSON.stringify(item.value)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => deleteMutation.mutate(item.id)}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    aria-label={t('common.delete')}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
