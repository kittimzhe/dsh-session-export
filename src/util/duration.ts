/**
 * Duration-string parsing shared by `/transcript --last` and `/archive --since`.
 *
 * @module dsh-session-export/util/duration
 */

/**
 * Parse `7d`/`12h`/`30m`/`90s` into an epoch-millisecond lower bound
 * (now minus the duration).
 * @param input - Raw token as typed by the user.
 * @returns The lower-bound epoch milliseconds, or null when malformed.
 */
export function parseDurationBound(input: string): number | null {
  const match = /^(\d+)\s*([smhd])$/.exec(input.trim())
  if (match === null) return null
  const n = Number(match[1])
  const unit = match[2]
  const ms = unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000
  return Date.now() - ms
}
