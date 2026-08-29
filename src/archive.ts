/**
 * `/archive` command — raw session-log archive to a host path, for
 * backup / migration / CI.
 *
 * The official browser `/export` needs a per-session raw-artifact backend
 * (SQLite persistence declares `supportsRawArtifacts: false`, so SQLite
 * deployments get no export at all). This command instead reads the complete,
 * replay-validated log through `sessionQuery.readSession` — backend-agnostic —
 * and writes one per-session ZIP (`session.jsonl` + `manifest.json`) to a
 * directory, with per-session failure isolation.
 *
 * @module dsh-session-export/archive
 */
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import { id8 } from './command.ts'
import { atomicWriteBytes } from './util/atomicWrite.ts'
import { buildZip } from './util/zip.ts'

export const ARCHIVE_USAGE = 'Usage: /archive [--id <sessionId>] [--all] [--since <duration>] [--out <dir>] [--no-descendants]'

export interface ArchiveArgs {
  readonly sessionId?: string
  readonly all: boolean
  readonly since?: number
  readonly outDir?: string
  readonly noDescendants: boolean
}

export interface ArchiveConfig {
  /** Output directory used when `/archive` is run without `--out` (default `<cwd>/.dsh-archives`). */
  readonly archiveDir?: string
  /** Include subagent descendants when archiving a single session (default true). */
  readonly includeDescendants?: boolean
  /** Safety cap on one `/archive --all` run (default 100). */
  readonly maxSessionsPerRun?: number
}

const TOOL = 'dsh-session-export'
const TOOL_VERSION = '0.2.0'

interface ArchiveManifest {
  readonly schemaVersion: 1
  readonly tool: string
  readonly toolVersion: string
  readonly sessionId: string
  readonly id8: string
  readonly createdAt: number
  readonly exportedAt: number
  readonly eventCount: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
}

/** Slice an event to its canonical raw JSONL form (type/seq/time/data + surface fields). */
function eventToJsonlLine(event: SessionEvent): string {
  const line: Record<string, unknown> = { type: event.type, seq: event.seq, time: event.time, data: event.data }
  if ('sourceEventSeqs' in event && event.sourceEventSeqs !== undefined) line.sourceEventSeqs = event.sourceEventSeqs
  if ('surfaceOp' in event && event.surfaceOp !== undefined) line.surfaceOp = event.surfaceOp
  return JSON.stringify(line)
}

function dateSlug(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** `7d`/`12h`/`30m`/`90s` → epoch-millisecond lower bound, or a usage error. */
function parseDuration(input: string): number | string {
  const match = /^(\d+)\s*([smhd])$/.exec(input.trim())
  if (match === null) return `--since expects a duration like 7d, 12h, 30m, or 90s.\n${ARCHIVE_USAGE}`
  const n = Number(match[1])
  const ms = match[2] === 's' ? n * 1000 : match[2] === 'm' ? n * 60_000 : match[2] === 'h' ? n * 3_600_000 : n * 86_400_000
  return Date.now() - ms
}

/** Parse raw command input; returns args or a usage-error string. */
export function parseArchiveArgs(rawInput: string): ArchiveArgs | string {
  const trimmed = rawInput.trim()
  if (trimmed.length === 0) return { all: false, noDescendants: false }

  const args: { sessionId?: string; all: boolean; since?: number; outDir?: string; noDescendants: boolean } = {
    all: false,
    noDescendants: false,
  }

  const outIndex = trimmed.indexOf('--out')
  let tokenSource = trimmed
  if (outIndex !== -1) {
    const rest = trimmed.slice(outIndex + '--out'.length).trim()
    if (rest.length === 0) return `--out requires a directory path.\n${ARCHIVE_USAGE}`
    args.outDir = rest
    tokenSource = trimmed.slice(0, outIndex).trim()
  }

  const tokens = tokenSource.length === 0 ? [] : tokenSource.split(/\s+/)
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token === undefined) break
    if (token === '--id') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return `--id requires a session id value.\n${ARCHIVE_USAGE}`
      if (args.sessionId !== undefined) return `--id may be given only once.\n${ARCHIVE_USAGE}`
      args.sessionId = value
      i += 2
      continue
    }
    if (token === '--all') {
      args.all = true
      i += 1
      continue
    }
    if (token === '--since') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return `--since requires a duration (e.g. 7d, 12h, 30m).\n${ARCHIVE_USAGE}`
      const parsed = parseDuration(value)
      if (typeof parsed === 'string') return parsed
      args.since = parsed
      i += 2
      continue
    }
    if (token === '--no-descendants') {
      args.noDescendants = true
      i += 1
      continue
    }
    if (token.startsWith('--')) return `Unknown option: ${token}\n${ARCHIVE_USAGE}`
    return `Unexpected argument: ${token}\n${ARCHIVE_USAGE}`
  }
  return args
}

/** Target session + flattened descendant headers for a lineage archive. */
async function collectWithDescendants(
  ctx: Context,
  sessionId: SessionId,
  includeDescendants: boolean,
): Promise<SessionHeader[]> {
  const trace = await ctx.sessionQuery.traceSession(sessionId)
  const headers: SessionHeader[] = [trace.target.header]
  if (!includeDescendants) return headers
  const walk = (nodes: readonly SessionLineageNode[]): void => {
    for (const node of nodes) {
      headers.push(node.session.header)
      walk(node.descendants)
    }
  }
  walk(trace.descendants)
  return headers
}

/** Build one session's archive ZIP; returns the bytes and the event count. */
async function buildArchiveZip(ctx: Context, header: SessionHeader): Promise<{ zip: Uint8Array; eventCount: number }> {
  const log = await ctx.sessionQuery.readSession(header.id)
  const jsonl = log.events.map(eventToJsonlLine).join('\n') + (log.events.length > 0 ? '\n' : '')
  const manifest: ArchiveManifest = {
    schemaVersion: 1,
    tool: TOOL,
    toolVersion: TOOL_VERSION,
    sessionId: log.session.id,
    id8: id8(log.session.id),
    createdAt: log.session.createdAt,
    exportedAt: Date.now(),
    eventCount: log.events.length,
    ...(log.session.cwd !== undefined ? { cwd: log.session.cwd } : {}),
    ...(log.session.parentSession !== undefined ? { parentSession: log.session.parentSession } : {}),
    ...(log.session.origin !== undefined ? { origin: log.session.origin } : {}),
    ...(log.session.delegationDepth !== undefined ? { delegationDepth: log.session.delegationDepth } : {}),
  }
  const zip = buildZip([
    { name: 'session.jsonl', data: new TextEncoder().encode(jsonl) },
    { name: 'manifest.json', data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) },
  ])
  return { zip, eventCount: log.events.length }
}

/** Execute `/archive` against the session-query seam. */
export async function executeArchive(
  ctx: Context,
  invocation: CommandInvocation,
  config?: ArchiveConfig,
): Promise<CommandResult> {
  const parsed = parseArchiveArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }
  const args = parsed

  const ownCwd = invocation.agent.session.header?.cwd
  const outDir = args.outDir ?? config?.archiveDir ?? `${ownCwd ?? process.cwd()}/.dsh-archives`
  const includeDescendants = (config?.includeDescendants ?? true) && !args.noDescendants
  const maxSessions = config?.maxSessionsPerRun ?? 100

  let targets: SessionHeader[]
  try {
    if (args.sessionId !== undefined) {
      targets = await collectWithDescendants(ctx, SessionId(String(args.sessionId)), includeDescendants)
    } else if (args.all || args.since !== undefined) {
      const records = await ctx.sessionQuery.listSessions()
      let headers = records.map((record) => record.header)
      if (ownCwd !== undefined) headers = headers.filter((header) => header.cwd === ownCwd)
      const since = args.since
      if (since !== undefined) headers = headers.filter((header) => header.createdAt >= since)
      targets = headers
    } else {
      targets = await collectWithDescendants(ctx, invocation.agent.session.id, includeDescendants)
    }
  } catch (error) {
    return { kind: 'error', text: `Could not list sessions to archive: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (targets.length === 0) return { kind: 'success', text: 'No sessions matched; nothing archived.' }
  if (targets.length > maxSessions) {
    return {
      kind: 'error',
      text: `Refusing to archive ${targets.length} sessions (max ${maxSessions} per run); narrow with --since or --id.`,
    }
  }

  const written: string[] = []
  const failures: Array<{ id: string; reason: string }> = []
  let totalEvents = 0
  for (const header of targets) {
    try {
      const { zip, eventCount } = await buildArchiveZip(ctx, header)
      const path = `${outDir}/dsh-session-${id8(header.id)}-${dateSlug(Date.now())}.zip`
      await atomicWriteBytes(path, zip)
      written.push(path)
      totalEvents += eventCount
    } catch (error) {
      failures.push({ id: id8(header.id), reason: error instanceof Error ? error.message : String(error) })
    }
  }

  if (written.length === 0) {
    const detail = failures.map((f) => `${f.id}: ${f.reason}`).join('; ')
    return { kind: 'error', text: `Archived nothing — all ${failures.length} sessions failed. ${detail}` }
  }

  const summary =
    written.length === 1
      ? `Archived ${totalEvents} events → ${written[0]}`
      : `Archived ${written.length} sessions (${totalEvents} events) → ${outDir}`
  if (failures.length === 0) return { kind: 'success', text: summary }
  const failDetail = failures.map((f) => `${f.id}: ${f.reason}`).join('; ')
  return { kind: 'success', text: `${summary}; ${failures.length} failed — ${failDetail}` }
}