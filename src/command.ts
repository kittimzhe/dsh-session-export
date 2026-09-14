/**
 * `/transcript` command grammar and execution.
 *
 * Grammar (command-owned, per dsh-commands: consumers own their grammar):
 *   /transcript [path] [--id <sessionId>] [--out <path…>]
 *               [--json] [--md] [--html] [--full]
 *               [--last <duration>] [--errors-only] [--mask] [--mask-hash]
 *               [--manifest]
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
import { renderHtml } from './render/html.ts'
import { computeStats } from './stats.ts'
import { maskEntries } from './mask.ts'
import { buildManifest, describeArtifact, renderManifest } from './manifest.ts'
import type { PricingConfig } from './types.ts'
import { parseDurationBound } from './util/duration.ts'
import { atomicWriteFile } from './util/atomicWrite.ts'

export const USAGE =
  'Usage: /transcript [path] [--id <sessionId>] [--out <path>] [--json] [--md] [--html] [--full] [--last <duration>] [--errors-only] [--mask] [--mask-hash] [--manifest]'

export interface TranscriptArgs {
  readonly sessionId?: string
  readonly outPath?: string
  readonly json: boolean
  readonly md: boolean
  readonly html: boolean
  readonly full: boolean
  /** Epoch-millisecond lower bound from `--last`. */
  readonly since?: number
  readonly errorsOnly: boolean
  readonly mask: boolean
  /** `--mask-hash`: redact with deterministic digests instead of placeholders. */
  readonly maskHash: boolean
  /** `--manifest`: write a `.manifest.json` sidecar with per-artifact sha256. */
  readonly manifest: boolean
}

/** Parse raw command input; returns args or a usage-error string. */
export function parseTranscriptArgs(rawInput: string): TranscriptArgs | string {
  const trimmed = rawInput.trim()
  if (trimmed.length === 0) return { json: false, md: true, html: false, full: false, errorsOnly: false, mask: false, maskHash: false, manifest: false }
  const tokens = trimmed.split(/\s+/)
  const args: {
    sessionId?: string
    outPath?: string
    json: boolean
    md: boolean
    html: boolean
    full: boolean
    since?: number
    errorsOnly: boolean
    mask: boolean
    maskHash: boolean
    manifest: boolean
  } = {
    json: false,
    md: false,
    html: false,
    full: false,
    errorsOnly: false,
    mask: false,
    maskHash: false,
    manifest: false,
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
    if (token === '--html') {
      args.html = true
      i += 1
      continue
    }
    if (token === '--mask') {
      args.mask = true
      i += 1
      continue
    }
    if (token === '--mask-hash') {
      args.mask = true
      args.maskHash = true
      i += 1
      continue
    }
    if (token === '--manifest') {
      args.manifest = true
      i += 1
      continue
    }
    if (token === '--errors-only') {
      args.errorsOnly = true
      i += 1
      continue
    }
    if (token === '--last') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return `--last requires a duration (e.g. 30m, 12h, 7d).\n${USAGE}`
      const bound = parseDurationBound(value)
      if (bound === null) return `--last expects a duration like 30m, 12h, or 7d.\n${USAGE}`
      args.since = bound
      i += 2
      continue
    }
    if (token.startsWith('--')) return `Unknown option: ${token}\n${USAGE}`
    if (positional !== undefined) return `Unexpected extra positional argument: ${token}\n${USAGE}`
    positional = token
    i += 1
  }
  if (args.outPath === undefined) args.outPath = positional
  if (!args.json && !args.md && !args.html) args.md = true
  return args
}

export function id8(id: string): string {
  // Web-profile session ids carry a 'session-' prefix; strip it so the
  // file slug keeps the meaningful uuid head instead of 'session-'.
  return id.replace(/^session-/, '').slice(0, 8)
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
  /** Redact likely secrets in rendered output (default false; `--mask` turns it on per run). */
  readonly mask?: boolean
  /** Replacement mode when masking: fixed placeholders (`mask`, default) or deterministic digests (`hash`). */
  readonly maskMode?: 'mask' | 'hash'
  /** Write a `.manifest.json` sidecar with per-artifact sha256 (default false; `--manifest` turns it on per run). */
  readonly manifest?: boolean
  /** UI label language for the HTML report (default 'en'). */
  readonly lang?: 'en' | 'zh'
  /** Extra masking regex sources applied alongside the built-in rules. */
  readonly maskPatterns?: readonly string[]
  /** Token price table; cost rows appear only when both rates are set. */
  readonly pricing?: PricingConfig
}

const GENERATOR = 'dsh-session-export v1.2.0'

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

  let entries = buildEntries(log.events)

  // --errors-only: keep failed tool results plus a two-entry context window.
  if (args.errorsOnly) {
    const keep = new Set<number>()
    entries.forEach((entry, index) => {
      if (entry.error !== undefined) {
        for (let w = Math.max(0, index - 2); w <= Math.min(entries.length - 1, index + 2); w += 1) keep.add(w)
      }
    })
    entries = entries.filter((_, index) => keep.has(index))
  }
  // --last: keep entries at or after the duration lower bound.
  if (args.since !== undefined) {
    entries = entries.filter((entry) => entry.time >= (args.since as number))
  }

  const filterNote =
    args.errorsOnly && args.since !== undefined
      ? 'Filtered view: failed tool results with context, further limited by --last'
      : args.errorsOnly
        ? 'Filtered view: failed tool results with a two-entry context window (--errors-only)'
        : args.since !== undefined
          ? 'Filtered view: entries within --last'
          : undefined

  const totals = buildTotals(entries)
  const stats = computeStats(entries, config?.pricing)
  const maskOn = args.mask || config?.mask === true
  const maskMode: 'off' | 'mask' | 'hash' = !maskOn ? 'off' : args.maskHash ? 'hash' : (config?.maskMode ?? 'mask')
  const renderedEntries = maskOn ? maskEntries(entries, { extraPatterns: config?.maskPatterns, mode: maskMode === 'hash' ? 'hash' : 'mask' }) : entries
  const input: RenderInput = {
    header: log.session,
    entries: renderedEntries,
    ...(lineage !== undefined ? { lineage } : {}),
    ...(args.full ? { logOnly: buildLogOnly(log.events) } : {}),
    totals,
    stats,
    ...(filterNote !== undefined ? { filterNote } : {}),
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
  if (args.html) {
    const path =
      defaultPath !== undefined
        ? `${defaultPath}.html`
        : args.outPath !== undefined && (args.md || args.json)
          ? requireExtension(args.outPath.replace(/\.(md|json)$/i, ''), '.html')
          : requireExtension(args.outPath, '.html')
    outputs.push({ path, content: renderHtml(input, config) })
  }
  if (args.json) {
    const path =
      defaultPath !== undefined
        ? `${defaultPath}.json`
        : args.outPath !== undefined && (args.md || args.html)
          ? requireExtension(args.outPath.replace(/\.(md|html)$/i, ''), '.json')
          : requireExtension(args.outPath, '.json')
    outputs.push({ path, content: renderJson(input) })
  }

  const manifestOn = args.manifest || config?.manifest === true
  let manifestPath: string | undefined
  if (manifestOn) {
    manifestPath =
      defaultPath !== undefined
        ? `${defaultPath}.manifest.json`
        : `${(args.outPath ?? 'transcript').replace(/\.(md|html|json)$/i, '')}.manifest.json`
  }

  try {
    for (const output of outputs) {
      await atomicWriteFile(output.path, output.content)
    }
    if (manifestPath !== undefined) {
      const manifest = buildManifest({
        generator: GENERATOR,
        createdAt: input.generatedAt,
        session: { id: log.session.id, createdAt: log.session.createdAt },
        scope: {
          entries: entries.length,
          errorsOnly: args.errorsOnly,
          ...(args.since !== undefined ? { since: args.since } : {}),
          full: args.full,
        },
        mask: { mode: maskMode },
        artifacts: outputs.map((output) => describeArtifact(output.path, output.content)),
      })
      await atomicWriteFile(manifestPath, renderManifest(manifest))
    }
  } catch (error) {
    return {
      kind: 'error',
      text: `Failed to write transcript: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const written = outputs.map((output) => output.path).join(', ')
  const manifestNote = manifestPath !== undefined ? ` (+ ${manifestPath})` : ''
  const maskNote = maskMode !== 'off' ? `, ${maskMode}-redacted` : ''
  return {
    kind: 'success',
    text: `Exported ${totals.messages} messages (${totals.toolCalls} tool calls, ${totals.inputTokens + totals.outputTokens} tokens${maskNote}) → ${written}${manifestNote}`,
  }
}

function requireExtension(path: string | undefined, ext: string): string {
  if (path === undefined) throw new Error('output path required')
  return path.toLowerCase().endsWith(ext) ? path : `${path}${ext}`
}
