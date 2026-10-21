import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

type ToastVariant = 'success' | 'error' | 'info'

interface Toast {
  id: number
  message: string
  variant: ToastVariant
}

interface ToastContextValue {
  showToast: (message: string, variant: ToastVariant) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)
const TOAST_VARIANT_CLASS: Record<ToastVariant, string> = {
  success: 'bg-green-500',
  error: 'bg-red-500',
  info: 'bg-blue-500',
}
const TOAST_VARIANT_ICON: Record<ToastVariant, ReactNode> = {
  success: (
    <svg className="size-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
    </svg>
  ),
  error: (
    <svg className="size-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
    </svg>
  ),
  info: (
    <svg className="size-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M18 10A8 8 0 114 10a8 8 0 0114 0zm-8.75-3.25a.75.75 0 111.5 0v.5a.75.75 0 11-1.5 0v-.5zM10 9a.75.75 0 00-.75.75v3a.75.75 0 001.5 0v-3A.75.75 0 0010 9z" clipRule="evenodd" />
    </svg>
  ),
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const showToast = useCallback((message: string, variant: ToastVariant) => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev, { id, message, variant }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 3000)
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 items-end">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={
              `flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium text-white shadow-lg animate-in fade-in slide-in-from-bottom-2 ` +
              TOAST_VARIANT_CLASS[toast.variant]
            }
          >
            {TOAST_VARIANT_ICON[toast.variant]}
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
