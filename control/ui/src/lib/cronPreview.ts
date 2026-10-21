/**
 * Returns a list of approximate next run timestamps for a given 5-field cron expression.
 *
 * NOTE: This is a best-effort stub. It validates the basic 5-field structure and returns
 * timestamps spaced 1 minute apart starting from now, regardless of the actual schedule.
 * For production-accurate previews, replace with a dedicated cron parser (e.g. cronstrue,
 * cron-parser, or similar).
 */
export function cronNextRuns(expr: string, count: number): string[] {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return []

  const valid = parts.every((p) => /^[\d*,\-/]+$/.test(p))
  if (!valid) return []

  const now = new Date()
  const results: string[] = []
  for (let i = 1; i <= count; i++) {
    const next = new Date(now.getTime() + i * 60_000)
    results.push(next.toLocaleString(undefined, { timeZone: 'Asia/Ho_Chi_Minh' }))
  }
  return results
}
