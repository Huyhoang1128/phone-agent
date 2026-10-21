/**
 * Clipboard helper với fallback cho HTTP context.
 *
 * `navigator.clipboard.writeText()` chỉ work ở secure context (HTTPS hoặc
 * localhost). Prod chạy HTTP → API undefined → throw. Fallback dùng
 * `document.execCommand('copy')` (deprecated nhưng vẫn work mọi browser).
 *
 * Usage:
 *   const ok = await copyTextToClipboard(text)
 *   if (ok) showToast('Copied', 'success')
 *   else showToast('Copy failed', 'error')
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  // Modern API (HTTPS / localhost)
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to fallback
    }
  }

  // Fallback: hidden textarea + execCommand
  // Deprecated nhưng vẫn work mọi browser hiện tại, không yêu cầu secure context.
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '-9999px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  try {
    const ok = document.execCommand('copy')
    return ok
  } catch {
    return false
  } finally {
    document.body.removeChild(ta)
  }
}
