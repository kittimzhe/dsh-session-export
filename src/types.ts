/**
 * Intermediate, renderer-facing types. The plugin adapts upstream session
 * events into these once; renderers stay pure and testable on plain data.
 *
 * @module dsh-session-export/types
 */
import type {
  AssistantMessage,
  Message,
  TokenUsage,
  ToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

/** One surface event projected to the message the user actually saw. */
export interface TranscriptEntry {
  /** Raw-log sequence number of the source event. */
  readonly seq: number
  /** Event time in epoch milliseconds. */
  readonly time: number
  /** Presentation classification derived from the message itself. */
  readonly kind: 'user' | 'assistant' | 'tool-result'
  /** The derived immutable message (never null here — adapter drops nulls). */
  readonly message: Message
  /** Token accounting, present on `assistant/message` events that reported usage. */
  readonly usage?: TokenUsage
  /** Structured tool error, present on failed `tool/result` events. */
  readonly error?: { name: string; code: string }
}

/** One log-only event summarized for the `--full` appendix. */
export interface LogOnlyLine {
  readonly seq: number
  readonly time: number
  readonly type: string
  /** Short human summary; renderers never assume its shape. */
  readonly summary?: string
}

/** Lineage subset the renderers need (detached upstream records). */
export interface LineageInfo {
  /** Parents from the immediate parent outward. */
  readonly ancestors: readonly { readonly id: string; readonly createdAt: number; readonly origin?: string }[]
  /** Recursive descendant trees rooted at this session's direct children. */
  readonly descendants: readonly LineageNode[]
}

/** One node of the descendant tree. */
export interface LineageNode {
  readonly id: string
  readonly createdAt: number
  readonly origin?: string
  readonly children: readonly LineageNode[]
}

/** Aggregate totals for the transcript header. */
export interface TranscriptTotals {
  readonly messages: number
  readonly toolCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Per-tool call accounting. */
export interface ToolStat {
  readonly name: string
  readonly calls: number
  readonly failures: number
}

/** Price table applied to token totals (per one million tokens). */
export interface PricingConfig {
  readonly inputPerMillion?: number
  readonly outputPerMillion?: number
  /** Currency label rendered next to the estimate, e.g. `'$'` or `'¥'`. */
  readonly currency?: string
}

/** Token-cost estimate derived from usage totals. */
export interface CostEstimate {
  readonly input: number
  readonly output: number
  readonly total: number
  readonly currency: string
}

/** Session-wide statistics computed from transcript entries. */
export interface SessionStats {
  readonly messages: number
  readonly turns: number
  readonly toolCalls: number
  readonly failedToolCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** Wall-clock span from first to last entry; null with fewer than two entries. */
  readonly durationMs: number | null
  readonly startedAt: number | null
  readonly endedAt: number | null
  /** Tools sorted by descending call count. */
  readonly toolBreakdown: readonly ToolStat[]
  /** Output tokens per assistant message, in log order (sparkline series). */
  readonly perAssistantTokens: readonly number[]
  readonly cost?: CostEstimate
}

/** Everything a renderer needs, fully detached from cordis. */
export interface RenderInput {
  readonly header: SessionHeader
  readonly entries: readonly TranscriptEntry[]
  readonly lineage?: LineageInfo
  readonly logOnly?: readonly LogOnlyLine[]
  readonly totals: TranscriptTotals
  /** Extended statistics; renderers may omit sections when absent. */
  readonly stats?: SessionStats
  /** Human-readable note when the entry set was filtered (`--last`, `--errors-only`). */
  readonly filterNote?: string
  readonly generator: string
  readonly generatedAt: number
}

/** Narrow helpers so renderers do not re-derive classifications. */
export function asAssistant(message: Message): AssistantMessage | undefined {
  return message.role === 'assistant' && message.source.kind === 'model'
    ? (message as AssistantMessage)
    : undefined
}

export function asToolResult(message: Message): ToolResultMessage | undefined {
  return message.source.kind === 'tool' ? (message as ToolResultMessage) : undefined
}
