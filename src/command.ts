/**
 * `/transcript` command grammar and execution.
 *
 * Grammar (command-owned, per dsh-commands: consumers own their grammar):
 *   /transcript [path] [--id <sessionId>] [--out <path…>]
 *               [--json] [--md] [--full]
 */
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-query'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, isAppendSurfaceEvent, deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { LogOnlyLine, LineageInfo, LineageNode, RenderInput, TranscriptEntry, TranscriptTotals } from './types.ts'
import { renderMarkdown } from './render/markdown.ts'
import { renderJson } from './render/json.ts'
import { atomicWriteFile } from './util/atomicWrite.ts'

export const USAGE = 'Usage: /transcript [path] [--id <sessionId>] [--out <path>] [--json] [--md] [--full]'

export interface TranscriptArgs {
  readonly sessionId?: string
  readonly outPath?: string
  readonly json: boolean
  readonly md: boolean
  readonly full: boolean
}

/** Parse raw command input; returns args or a usage-error string. */
export function parseTranscriptArgs(rawInput: string): TranscriptArgs | string {
  const trimmed = rawInput.trim()
  if (trimmed.length === 0) return { json: false, md: true, full: false }
  const tokens = trimmed.split(/\s+/)
  const args: { sessionId?: string; outPath?: string; json: boolean; md: boolean; full: boolean } = {
    json: false,
    md: false,
    full: false,
  }
  let positional: string | undefined
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token === undefined) break
    if (token === '--id') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return `--id requires a session id value.\n${USAGE}`
      if (args.sessionId !== undefined) return `--id may be given only once.\n${USAGE}`
      args.sessionId = value
      i += 2
      continue
    }
    if (token === '--out') {
      const rest = trimmed.slice(trimmed.indexOf('--out') + '--out'.length).trim()
      if (rest.length === 0) return `--out requires a path value.\n${USAGE}`
      args.outPath = rest
      break
    }
    if (token === '--json') {
      args.json = true
      i += 1
      continue
    }
    if (token === '--md') {
      args.md = true
      i += 1
      continue
    }
    if (token === '--full') {
      args.full = true
      i += 1
      continue
    }
    if (token.startsWith('--')) return `Unknown option: ${token}\n${USAGE}`
    if (positional !== undefined) return `Unexpected extra positional argument: ${token}\n${USAGE}`
    positional = token
    i += 1
  }
  if (args.outPath === undefined) args.outPath = positional
  if (!args.json && !args.md) args.md = true
  return args
}

function id8(id: string): string {
  return id.slice(0, 8)
}

function timestampSlug(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Adapt append-origin surface events to renderer entries (drop nulls). */
export function buildEntries(events: readonly SessionEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const event of events) {
    if (!isAppendSurfaceEvent(event)) continue
    const message: Message | null = deriveEventMessage(event)
    if (message === null) continue
    const data = event.data as { usage?: TranscriptEntry['usage']; error?: TranscriptEntry['error'] }
    const kind: TranscriptEntry['kind'] =
      message.role === 'assistant' ? 'assistant' : message.source.kind === 'tool' ? 'tool-result' : 'user'
    entries.push({
      seq: event.seq,
      time: event.time,
      kind,
      message,
      ...(event.type === 'assistant/message' && data.usage !== undefined ? { usage: data.usage } : {}),
      ...(event.type === 'tool/result' && data.error !== undefined ? { error: data.error } : {}),
    })
  }
  return entries
}

const LOG_ONLY_SUMMARY_TYPES = new Set(['command/run', 'command/done', 'compaction/start', 'compaction/end'])

/** Summarize log-only events for the --full appendix. */
export function buildLogOnly(events: readonly SessionEvent[]): LogOnlyLine[] {
  const lines: LogOnlyLine[] = []
  for (const event of events) {
    if (!LOG_ONLY_SUMMARY_TYPES.has(event.type)) continue
    const data = event.data as { name?: string; kind?: string; text?: string }
    let summary: string | undefined
    if (event.type === 'command/run' && typeof data.name === 'string') summary = `/${data.name}`
    if (event.type === 'command/done' && typeof data.kind === 'string') summary = `/${String((data as { name?: string }).name ?? '')} → ${data.kind}`.trim()
    if (event.type === 'command/done' && typeof data.text === 'string' && data.text.length > 0) {
      summary = `${summary ?? ''} — ${data.text.slice(0, 80)}`.trim()
    }
    lines.push({ seq: event.seq, time: event.time, type: event.type, ...(summary !== undefined ? { summary } : {}) })
  }
  return lines
}

export function buildTotals(entries: readonly TranscriptEntry[]): TranscriptTotals {
  let toolCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const entry of entries) {
    if (entry.message.role === 'assistant') {
      for (const block of entry.message.content) {
        if (block.type === 'tool-call') toolCalls += 1
      }
      if (entry.usage !== undefined) {
        inputTokens += entry.usage.inputTokens
        outputTokens += entry.usage.outputTokens
      }
    }
  }
  return { messages: entries.length, toolCalls, inputTokens, outputTokens }
}

function toLineageNode(node: { session: { header: SessionHeader }; descendants: unknown[] }): LineageNode {
  const children = Array.isArray(node.descendants) ? (node.descendants as Array<{ session: { header: SessionHeader }; descendants: unknown[] }>) : []
  return {
    id: node.session.header.id,
    createdAt: node.session.header.createdAt,
    ...(node.session.header.origin !== undefined ? { origin: node.session.header.origin } : {}),
    children: children.map(toLineageNode),
  }
}

export interface TranscriptConfig {
  /** Directory used when no explicit path is given. */
  readonly defaultDir?: string
  /** Character limit for rendered tool arguments. */
  readonly argCharLimit?: number
  /** Character limit for rendered tool results. */
  readonly resultCharLimit?: number
}

const GENERATOR = 'dsh-session-export v0.1.0'

/** Execute the /transcript command against the session-query seam. */
export async function executeTranscript(
  ctx: Context,
  invocation: CommandInvocation,
  config?: TranscriptConfig,
): Promise<CommandResult> {
  const parsed = parseTranscriptArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }
  const args = parsed

  const sessionIdRaw = args.sessionId ?? invocation.agent.session.id
  const sessionId = SessionId(String(sessionIdRaw))

  let log: { session: SessionHeader; events: SessionEvent[] }
  try {
    log = await ctx.sessionQuery.readSession(sessionId)
  } catch (error) {
    return {
      kind: 'error',
      text: `Could not read session ${id8(String(sessionIdRaw))}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let lineage: LineageInfo | undefined
  try {
    const trace = await ctx.sessionQuery.traceSession(sessionId)
    lineage = {
      ancestors: trace.ancestors.map((record) => ({
        id: record.header.id,
        createdAt: record.header.createdAt,
        ...(record.header.origin !== undefined ? { origin: record.header.origin } : {}),
      })),
      descendants: trace.descendants.map(toLineageNode),
    }
  } catch {
    lineage = undefined
  }

  const entries = buildEntries(log.events)
  const totals = buildTotals(entries)
  const input: RenderInput = {
    header: log.session,
    entries,
    ...(lineage !== undefined ? { lineage } : {}),
    ...(args.full ? { logOnly: buildLogOnly(log.events) } : {}),
    totals,
    generator: GENERATOR,
    generatedAt: Date.now(),
  }

  const baseDir = config?.defaultDir ?? log.session.cwd ?? process.cwd()
  const outputs: Array<{ path: string; content: string }> = []
  const slug = `transcript-${id8(String(sessionIdRaw))}-${timestampSlug(Date.now())}`
  const defaultPath = args.outPath !== undefined ? undefined : `${baseDir}/dsh-transcripts/${slug}`

  if (args.md) {
    const path = defaultPath !== undefined ? `${defaultPath}.md` : requireExtension(args.outPath, '.md')
    outputs.push({ path, content: renderMarkdown(input, config) })
  }
  if (args.json) {
    const path =
      defaultPath !== undefined
        ? `${defaultPath}.json`
        : args.outPath !== undefined && args.md
          ? requireExtension(args.outPath.replace(/\.md$/i, ''), '.json')
          : requireExtension(args.outPath, '.json')
    outputs.push({ path, content: renderJson(input) })
  }

  try {
    for (const output of outputs) {
      await atomicWriteFile(output.path, output.content)
    }
  } catch (error) {
    return {
      kind: 'error',
      text: `Failed to write transcript: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const written = outputs.map((output) => output.path).join(', ')
  return {
    kind: 'success',
    text: `Exported ${totals.messages} messages (${totals.toolCalls} tool calls, ${totals.inputTokens + totals.outputTokens} tokens) → ${written}`,
  }
}

function requireExtension(path: string | undefined, ext: string): string {
  if (path === undefined) throw new Error('output path required')
  return path.toLowerCase().endsWith(ext) ? path : `${path}${ext}`
}
