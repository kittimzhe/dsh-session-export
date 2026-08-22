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

/** Everything a renderer needs, fully detached from cordis. */
export interface RenderInput {
  readonly header: SessionHeader
  readonly entries: readonly TranscriptEntry[]
  readonly lineage?: LineageInfo
  readonly logOnly?: readonly LogOnlyLine[]
  readonly totals: TranscriptTotals
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
