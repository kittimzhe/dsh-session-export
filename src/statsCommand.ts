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

export const STATS_USAGE = 'Usage: /stats [--id <sessionId>]'

export interface StatsArgs {
  readonly sessionId?: string
}

/** Parse raw command input; returns args or a usage-error string. */
export function parseStatsArgs(rawInput: string): StatsArgs | string {
  const trimmed = rawInput.trim()
  if (trimmed.length === 0) return {}
  const tokens = trimmed.split(/\s+/)
  const args: { sessionId?: string } = {}
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
  return { kind: 'success', text: formatStatsCard(stats) }
}
