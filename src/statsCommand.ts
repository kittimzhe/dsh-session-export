/**
 * `/stats` command — print a session stats card without writing files.
 *
 * Reads through the same `ctx.sessionQuery` seam as `/transcript`, so it
 * works on any persistence backend and needs no resident recorder.
 *
 * @module dsh-session-export/statsCommand
 */
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { buildEntries, id8, type TranscriptConfig } from './command.ts'
import { computeStats, formatStatsCard } from './stats.ts'
import { atomicWriteFile } from './util/atomicWrite.ts'

export const STATS_USAGE = 'Usage: /stats [--id <sessionId>] [--json] [--out <path>]'

/** StatsArgs: --id selects the session; --json emits machine-readable output; --out writes to a file. */
export interface StatsArgs {
  readonly sessionId?: string
  readonly json?: boolean
  readonly outPath?: string
}

/** Parse raw command input; returns args or a usage-error string. */
export function parseStatsArgs(rawInput: string): StatsArgs | string {
  const trimmed = rawInput.trim()
  if (trimmed.length === 0) return {}
  const tokens = trimmed.split(/\s+/)
  const args: { sessionId?: string; json?: boolean; outPath?: string } = {}
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token === undefined) break
    if (token === '--id') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return `--id requires a session id value.\n${STATS_USAGE}`
      if (args.sessionId !== undefined) return `--id may be given only once.\n${STATS_USAGE}`
      args.sessionId = value
      i += 2
      continue
    }
    if (token === '--json') {
      if (args.json === true) return `--json may be given only once.\n${STATS_USAGE}`
      args.json = true
      i += 1
      continue
    }
    if (token === '--out') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return `--out requires a path value.\n${STATS_USAGE}`
      if (args.outPath !== undefined) return `--out may be given only once.\n${STATS_USAGE}`
      args.outPath = value
      i += 2
      continue
    }
    return `Unknown argument: ${token}\n${STATS_USAGE}`
  }
  return args
}

/** Execute the /stats command against the session-query seam. */
export async function executeStats(
  ctx: Context,
  invocation: CommandInvocation,
  config?: TranscriptConfig,
): Promise<CommandResult> {
  const parsed = parseStatsArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }

  const sessionIdRaw = parsed.sessionId ?? invocation.agent.session.id
  const sessionId = SessionId(String(sessionIdRaw))

  let events: Parameters<typeof buildEntries>[0]
  try {
    const log = await ctx.sessionQuery.readSession(sessionId)
    events = log.events
  } catch (error) {
    return {
      kind: 'error',
      text: `Could not read session ${id8(String(sessionIdRaw))}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const stats = computeStats(buildEntries(events), config?.pricing)

  if (parsed.json === true) {
    const payload = JSON.stringify({ generator: 'dsh-session-export v1.8.0', stats }, null, 2)
    if (parsed.outPath !== undefined) {
      try {
        await atomicWriteFile(parsed.outPath, payload)
      } catch (error) {
        return {
          kind: 'error',
          text: `Failed to write stats: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      return { kind: 'success', text: `Stats JSON written → ${parsed.outPath}` }
    }
    return { kind: 'success', text: payload }
  }

  if (parsed.outPath !== undefined) {
    try {
      await atomicWriteFile(parsed.outPath, formatStatsCard(stats))
    } catch (error) {
      return {
        kind: 'error',
        text: `Failed to write stats: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return { kind: 'success', text: `Stats card written → ${parsed.outPath}` }
  }

  return { kind: 'success', text: formatStatsCard(stats) }
}
