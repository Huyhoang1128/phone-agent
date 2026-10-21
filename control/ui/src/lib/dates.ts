// Centralised date formatting. All times in the app are displayed in
// Asia/Ho_Chi_Minh (GMT+7), independent of the browser's timezone.

export const VIETNAM_TZ = 'Asia/Ho_Chi_Minh'

type DateInput = string | number | Date | null | undefined

function toDate(value: DateInput): Date | null {
  if (value == null || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Date + time in Vietnam time. Falls back to `fallback` when value is null/invalid. */
export function formatDateTime(value: DateInput, fallback = '—'): string {
  const d = toDate(value)
  if (!d) return fallback
  return d.toLocaleString(undefined, { timeZone: VIETNAM_TZ })
}

/** Date only in Vietnam time. */
export function formatDate(value: DateInput, fallback = '—'): string {
  const d = toDate(value)
  if (!d) return fallback
  return d.toLocaleDateString(undefined, { timeZone: VIETNAM_TZ })
}

/** Time only in Vietnam time. */
export function formatTime(value: DateInput, fallback = '—'): string {
  const d = toDate(value)
  if (!d) return fallback
  return d.toLocaleTimeString(undefined, { timeZone: VIETNAM_TZ })
}

/** Custom-options format in Vietnam time (timezone is always overridden to VN). */
export function formatWithOptions(
  value: DateInput,
  options: Intl.DateTimeFormatOptions,
  fallback = '—',
): string {
  const d = toDate(value)
  if (!d) return fallback
  return d.toLocaleString(undefined, { ...options, timeZone: VIETNAM_TZ })
}

// ─── <input type="datetime-local"> helpers ────────────────────────────────────
// `datetime-local` is naive (no timezone). We want users to always pick wall-clock
// times in Vietnam, regardless of the browser's locale.

/** Vietnam has no DST, so the offset is constant at +07:00. */
const VN_OFFSET = '+07:00'

/** Convert a UTC ISO string to a "YYYY-MM-DDTHH:mm" value for <input type="datetime-local">,
 *  interpreting the value in Vietnam time. */
export function toLocalInputValue(value: DateInput): string {
  const d = toDate(value)
  if (!d) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VIETNAM_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  // Some locales return "24" for midnight in hour12:false; normalise to "00".
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`
}

/** Convert a "YYYY-MM-DDTHH:mm" value from <input type="datetime-local">
 *  (interpreted as Vietnam time) to a UTC ISO string. */
export function fromLocalInputValue(localValue: string): string {
  if (!localValue) return ''
  const d = new Date(`${localValue}${VN_OFFSET}`)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}
