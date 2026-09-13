/**
 * Mermaid diagram builders: lineage tree and turn timeline, rendered as
 * fenced code blocks that GitHub and VSCode display natively.
 *
 * @module dsh-session-export/render/mermaid
 */
import type { LineageInfo, LineageNode, TranscriptEntry } from '../types.ts'

function id8(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8)
}

/** Sanitize a label for Mermaid node text (quotes + brackets break the DSL). */
function mermaidLabel(text: string): string {
  return text.replace(/["\[\]{}()<>]/g, '').trim()
}

/**
 * Render the lineage (ancestors + descendants + self) as a `graph TD` block.
 * @param lineage - Lineage info from `traceSession`.
 * @param selfId - This session's id (rendered as the highlighted root).
 * @returns The Mermaid block, or null when the lineage is empty.
 */
export function renderLineageMermaid(lineage: LineageInfo, selfId: string): string | null {
  if (lineage.ancestors.length === 0 && lineage.descendants.length === 0) return null
  const lines: string[] = ['graph TD']

  const node = (id: string): string => `s${id8(id).replace(/[^a-zA-Z0-9]/g, '')}`

  const chain = [...lineage.ancestors.map((a) => a.id)].reverse()
  let previous: string | undefined
  for (const ancestorId of chain) {
    const current = node(ancestorId)
    lines.push(`  ${current}["${mermaidLabel(id8(ancestorId))}"]`)
    if (previous !== undefined) lines.push(`  ${previous} --> ${current}`)
    previous = current
  }
  const self = node(selfId)
  lines.push(`  ${self}("${mermaidLabel(id8(selfId))} ← this session")`)
  if (previous !== undefined) lines.push(`  ${previous} --> ${self}`)

  const walk = (list: readonly LineageNode[], parent: string): void => {
    for (const child of list) {
      const current = node(child.id)
      const label = child.origin === 'subagent' ? `${id8(child.id)} subagent` : id8(child.id)
      lines.push(`  ${current}["${mermaidLabel(label)}"]`)
      lines.push(`  ${parent} --> ${current}`)
      walk(child.children, current)
    }
  }
  walk(lineage.descendants, self)

  lines.push('  classDef self fill:#fde68a,stroke:#d97706,stroke-width:2px')
  lines.push(`  class ${self} self`)
  return lines.join('\n')
}

/**
 * Render per-turn durations as a `gantt` block. A turn spans from one user
 * message to the next (the last turn ends at the final entry).
 * @param entries - Transcript entries in log order.
 * @returns The Mermaid block, or null with fewer than two turns.
 */
export function renderTimelineMermaid(entries: readonly TranscriptEntry[]): string | null {
  const turnStarts = entries.filter((entry) => entry.message.role === 'user' && entry.message.source.kind !== 'tool')
  if (turnStarts.length < 2) return null

  const bounds = turnStarts.map((start, index) => {
    const end = turnStarts[index + 1]?.time ?? entries[entries.length - 1]?.time ?? start.time
    return { index, start: start.time, end }
  })

  const lines: string[] = ['gantt', '  dateFormat X', '  axisFormat %H:%M', '  title Turn timeline']
  for (const turn of bounds) {
    const durationS = Math.max(0, Math.round((turn.end - turn.start) / 1000))
    lines.push(`  Turn ${turn.index + 1} :t${turn.index + 1}, ${Math.round(turn.start / 1000)}, ${durationS}s`)
  }
  return lines.join('\n')
}
