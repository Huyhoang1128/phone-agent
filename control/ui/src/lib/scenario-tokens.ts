/**
 * AI Scenario v3.2.1 — Design tokens (đề_xuất_tinh_chỉnh_giao_diện.md UX-1).
 *
 * Tập trung color/spacing/typography để mọi component scenario (DetailPage,
 * ChatProposalCards, ShotHistoryModal, Timeline, ShotCard, PropertiesPanel)
 * dùng CÙNG palette + spacing — bỏ ad-hoc Tailwind class scattered.
 *
 * Convention dùng Tailwind class string (không runtime CSS-in-JS) để tooling
 * Tailwind purge vẫn detect được.
 */

// ─── Color tokens (semantic) ─────────────────────────────────────────────────

export const colors = {
  // Primary — Indigo (theo đề xuất user UI/UX doc)
  primary: {
    bg: 'bg-indigo-600',
    bgHover: 'hover:bg-indigo-700',
    bgSoft: 'bg-indigo-500/10 dark:bg-indigo-500/15',
    text: 'text-indigo-700 dark:text-indigo-300',
    textOn: 'text-white',
    border: 'border-indigo-500/30 dark:border-indigo-500/40',
  },
  success: {
    bgSoft: 'bg-emerald-500/10 dark:bg-emerald-500/15',
    text: 'text-emerald-700 dark:text-emerald-300',
    border: 'border-emerald-500/30',
  },
  warning: {
    bgSoft: 'bg-amber-500/10 dark:bg-amber-500/15',
    text: 'text-amber-700 dark:text-amber-300',
    border: 'border-amber-500/40',
  },
  danger: {
    bgSoft: 'bg-red-500/10 dark:bg-red-500/15',
    text: 'text-red-700 dark:text-red-300',
    border: 'border-red-500/30',
  },
  // Funnel part — visual differentiation per shot
  funnel: {
    Hook: 'bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-500/30',
    'Vấn đề': 'bg-rose-500/15 text-rose-700 dark:text-rose-200 border-rose-500/30',
    'Giải pháp': 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-500/30',
    CTA: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-200 border-indigo-500/30',
    'B-roll': 'bg-slate-500/15 text-slate-700 dark:text-slate-200 border-slate-500/30',
  } as const,
} as const

// ─── Spacing tokens ──────────────────────────────────────────────────────────

export const spacing = {
  cardPadding: 'p-4',        // 16px theo đề xuất
  sectionGap: 'space-y-6',    // 24px between sections
  shotGap: 'space-y-8',       // 32px between shots
  fieldGap: 'space-y-3',      // 12px between fields trong shot
} as const

// ─── Typography tokens ───────────────────────────────────────────────────────

export const typography = {
  pageTitle: 'text-base font-semibold tracking-tight',
  sectionTitle: 'text-sm font-semibold',
  shotTitle: 'text-sm font-semibold',
  fieldLabel: 'text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
  fieldValue: 'text-sm leading-relaxed',
  fieldValueLarge: 'text-base leading-relaxed',  // cho voice_over (core field)
  helperText: 'text-[11px] italic text-muted-foreground',
  metaText: 'text-[11px] text-muted-foreground',
} as const

// ─── Layout tokens ───────────────────────────────────────────────────────────

export const layout = {
  // 3-panel widths (resizable later — UX-7)
  chatPanelWidth: 'w-[320px]',
  propertiesPanelWidth: 'w-[280px]',
  // Card surfaces — bỏ border cứng, dùng subtle bg
  cardSurface: 'rounded-lg bg-card border border-border/60',
  cardSurfaceSubtle: 'rounded-lg bg-muted/40 border border-border/40',
  cardSurfaceHover: 'transition hover:border-indigo-400/60 hover:shadow-sm',
  // Input — bỏ border-only, dùng bg subtle
  inputSurface:
    'w-full rounded-md bg-muted/40 px-3 py-2 text-sm leading-relaxed border border-transparent ' +
    'focus:bg-background focus:border-indigo-500/50 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 ' +
    'transition placeholder:text-muted-foreground/60',
  textareaSurface:
    'w-full resize-none rounded-md bg-muted/40 px-3 py-2 text-sm leading-relaxed border border-transparent ' +
    'focus:bg-background focus:border-indigo-500/50 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 ' +
    'transition placeholder:text-muted-foreground/60',
} as const

// ─── Helper: get funnel pill className ───────────────────────────────────────

export function funnelPillClass(funnel?: string | null): string {
  if (!funnel) return 'bg-muted text-muted-foreground border-border'
  const map = colors.funnel as Record<string, string>
  return map[funnel] || 'bg-muted text-muted-foreground border-border'
}

// ─── Helper: continuity_mode label + color ───────────────────────────────────

export function continuityChipClass(mode: string): string {
  switch (mode) {
    case 'NEW_SCENE':
      return 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-400/30'
    case 'FRAME_ANCHOR':
      return 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-400/30'
    case 'B_ROLL_CUT':
      return 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-400/30'
    default:
      return 'bg-muted text-muted-foreground border-border'
  }
}
