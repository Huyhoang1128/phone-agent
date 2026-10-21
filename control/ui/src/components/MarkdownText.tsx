/**
 * MarkdownText — minimal markdown renderer for AI chat replies.
 *
 * Handles ONLY:
 *   - **bold**   → <strong>
 *   - *italic*   → <em>      (single-asterisk only, not ** so order matters)
 *   - `code`     → <code>
 *   - line breaks via whitespace-pre-wrap on the wrapper
 *
 * Intentionally tiny so we don't need react-markdown (~30KB). The AI's
 * system prompt allows only these light markdown features; anything else
 * (headings, lists, code blocks) is rendered as plain text — that's a
 * feature, not a bug: keeps chat readable on small bubbles.
 */
import React from 'react'

const TOKEN_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g

interface Props {
  text: string
  className?: string
}

export function MarkdownText({ text, className }: Props) {
  // Split by tokens BUT keep separators so we can rebuild. The regex above
  // is grouped so split() yields alternating plain / token chunks.
  const parts = text.split(TOKEN_RE)
  const nodes: React.ReactNode[] = []
  parts.forEach((part, i) => {
    if (!part) return
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      nodes.push(<strong key={i}>{part.slice(2, -2)}</strong>)
    } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      nodes.push(<em key={i}>{part.slice(1, -1)}</em>)
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      nodes.push(
        <code
          key={i}
          className="rounded bg-muted/60 px-1 py-px font-mono text-[0.9em]"
        >
          {part.slice(1, -1)}
        </code>,
      )
    } else {
      nodes.push(part)
    }
  })
  return <span className={`whitespace-pre-wrap ${className ?? ''}`}>{nodes}</span>
}
