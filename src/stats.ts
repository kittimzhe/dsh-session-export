/**
 * Session statistics: computation over {@link TranscriptEntry} lists and a
 * terminal stats card for `/stats`.
 *
 * @module dsh-session-export/stats
 */
import type { PricingConfig, SessionStats, ToolStat, TranscriptEntry } from './types.ts'

/** Format a duration in milliseconds as a compact human label. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/**
 * Compute session-wide statistics from transcript entries.
 * @param entries - Transcript entries in log order.
 * @param pricing - Optional price table; cost fields appear only when both
 *   per-million rates are set.
 * @returns Aggregated statistics.
 */
export function computeStats(entries: readonly TranscriptEntry[], pricing?: PricingConfig): SessionStats {
  let turns = 0
  let toolCalls = 0
  let failedToolCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  const perTool = new Map<string, ToolStat>()
  const perAssistantTokens: number[] = []
  /** callId → tool name, populated from assistant tool-call blocks. */
  const callTool = new Map<string, string>()

  for (const entry of entries) {
    if (entry.message.role === 'user' && entry.message.source.kind !== 'tool') turns += 1
    if (entry.message.role === 'assistant') {
      for (const block of entry.message.content) {
        if (block.type === 'tool-call') {
          toolCalls += 1
          callTool.set(String(block.id), block.name)
          const previous = perTool.get(block.name)
          perTool.set(block.name, {
            name: block.name,
            calls: (previous?.calls ?? 0) + 1,
            failures: previous?.failures ?? 0,
          })
        }
      }
      if (entry.usage !== undefined) {
        inputTokens += entry.usage.inputTokens
        outputTokens += entry.usage.outputTokens
        perAssistantTokens.push(entry.usage.outputTokens)
      } else {
        perAssistantTokens.push(0)
      }
    }
    if (entry.error !== undefined) {
      failedToolCalls += 1
      const name = callTool.get(String(entry.message.source.kind === 'tool' ? entry.message.source.callId : ''))
      if (name !== undefined) {
        const stat = perTool.get(name)
        if (stat !== undefined) perTool.set(name, { ...stat, failures: stat.failures + 1 })
      }
    }
  }

  const first = entries[0]
  const last = entries[entries.length - 1]
  const startedAt = first?.time ?? null
  const endedAt = last?.time ?? null

  const currency = pricing?.currency ?? '$'
  const cost =
    pricing?.inputPerMillion !== undefined && pricing?.outputPerMillion !== undefined
      ? {
          input: (inputTokens / 1_000_000) * pricing.inputPerMillion,
          output: (outputTokens / 1_000_000) * pricing.outputPerMillion,
          total: 0,
          currency,
        }
      : undefined
  if (cost !== undefined) cost.total = cost.input + cost.output

  return {
    messages: entries.length,
    turns,
    toolCalls,
    failedToolCalls,
    inputTokens,
    outputTokens,
    durationMs: startedAt !== null && endedAt !== null && endedAt > startedAt ? endedAt - startedAt : null,
    startedAt,
    endedAt,
    toolBreakdown: [...perTool.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    perAssistantTokens,
    ...(cost !== undefined ? { cost } : {}),
  }
}

/** Sparkline glyph ramp (Unicode block elements, low → high). */
const SPARK_RAMP = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

/**
 * Render a numeric series as a compact sparkline string.
 * @param series - Numbers (zero-safe; all-zero renders as a flat line).
 * @returns One glyph per value.
 */
export function sparkline(series: readonly number[]): string {
  if (series.length === 0) return ''
  const max = Math.max(...series)
  return series
    .map((value) => SPARK_RAMP[max === 0 ? 0 : Math.min(SPARK_RAMP.length - 1, Math.floor((value / max) * SPARK_RAMP.length))])
    .join('')
}

/** Box-drawing bar ramp for tool rankings. */
const BAR_GLYPH = '█'

/**
 * Render a horizontal bar of `filled`/`total` cells.
 * @param filled - Filled cell count (clamped to total).
 * @param total - Total cell count.
 */
export function bar(filled: number, total: number): string {
  const n = Math.max(0, Math.min(total, filled))
  return BAR_GLYPH.repeat(n) + '·'.repeat(Math.max(0, total - n))
}

export interface StatsCardOptions {
  /** Emit ANSI color escapes (default false — plain text everywhere). */
  readonly color?: boolean
}

function dim(text: string, color: boolean): string {
  return color ? `\x1b[2m${text}\x1b[22m` : text
}
function bold(text: string, color: boolean): string {
  return color ? `\x1b[1m${text}\x1b[22m` : text
}
function red(text: string, color: boolean): string {
  return color ? `\x1b[31m${text}\x1b[39m` : text
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtCost(n: number): string {
  if (n >= 1) return n.toFixed(2)
  if (n >= 0.01) return n.toFixed(3)
  return n.toFixed(4)
}

/**
 * Format statistics as a terminal card.
 * @param stats - Computed session statistics.
 * @param options - Card options.
 * @returns Multi-line card text (no trailing newline).
 */
export function formatStatsCard(stats: SessionStats, options?: StatsCardOptions): string {
  const color = options?.color === true
  const lines: string[] = []
  const W = 52

  lines.push(`┌${'─'.repeat(W)}┐`)
  const row = (label: string, value: string) => {
    const text = `│ ${bold(label, color)} ${value}`
    lines.push(`${text}${' '.repeat(Math.max(0, W + 1 - visibleWidth(text)))}│`)
  }

  const duration = stats.durationMs !== null ? formatDuration(stats.durationMs) : '—'
  row('Messages', `${stats.messages}`)
  row('Turns', `${stats.turns}`)
  row('Duration', duration)
  const failedNote = stats.failedToolCalls > 0 ? ` (${red(`${stats.failedToolCalls} failed`, color)})` : ''
  row('Tool calls', `${stats.toolCalls}${failedNote}`)
  row('Tokens', `${fmtTokens(stats.inputTokens)} in / ${fmtTokens(stats.outputTokens)} out`)
  if (stats.cost !== undefined) {
    const c = stats.cost
    row(
      'Cost ≈',
      `${c.currency}${fmtCost(c.total)} (in ${c.currency}${fmtCost(c.input)} / out ${c.currency}${fmtCost(c.output)})`,
    )
  }
  if (stats.perAssistantTokens.length > 1) {
    row('Output/turn', sparkline(stats.perAssistantTokens))
  }
  if (stats.toolBreakdown.length > 0) {
    lines.push(`│${'─'.repeat(W)}│`)
    const maxCalls = stats.toolBreakdown[0]?.calls ?? 1
    for (const tool of stats.toolBreakdown.slice(0, 6)) {
      const cells = 18
      const filled = Math.round((tool.calls / maxCalls) * cells)
      const failNote = tool.failures > 0 ? ` ${red(`${tool.failures}✗`, color)}` : ''
      row(tool.name, `${bar(filled, cells)} ${tool.calls}${failNote}`)
    }
  }
  lines.push(`└${'─'.repeat(W)}┘`)
  return lines.join('\n')
}

/** Visible width of a string with ANSI escapes and box glyphs stripped. */
function visibleWidth(text: string): number {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('')
    .reduce((width, char) => width + (char.charCodeAt(0) >= 0x1100 ? 2 : 1), 0)
}
