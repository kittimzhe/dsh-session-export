/**
 * Retention — automatic pruning of old export artifacts.
 *
 * A team can cap how long generated evidence lives on disk. After every
 * successful write, each command runs {@link applyRetention} against the
 * directory it just wrote into: files older than `retentionDays` are
 * deleted, and when more than `retentionMaxFiles` artifacts remain, the
 * oldest are dropped until the cap is met. Pruning is best-effort —
 * failures to stat or unlink never fail the export itself.
 *
 * @module dsh-session-export/retention
 */
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Artifact filename prefixes this plugin generates. */
const ARTIFACT_PREFIXES = ['transcript-', 'archive-', 'bundle-', 'diff-'] as const

/** Suffixes (with extension) that identify generated artifacts. */
const ARTIFACT_SUFFIXES = ['.md', '.json', '.zip', '.manifest.json'] as const

/** Whether a filename looks like one of this plugin's artifacts. */
function isArtifact(name: string): boolean {
  const prefix = ARTIFACT_PREFIXES.some((p) => name.startsWith(p))
  if (!prefix) return false
  return ARTIFACT_SUFFIXES.some((s) => name.endsWith(s))
}

/** One pruned file, as reported in the summary line. */
export interface PrunedFile {
  readonly path: string
  readonly mtimeMs: number
}

/** Result of one retention sweep. */
export interface RetentionResult {
  /** Files deleted this sweep (already unlinked; failures skipped). */
  readonly deleted: readonly PrunedFile[]
  /** Number of files considered (matched artifact pattern in dir). */
  readonly considered: number
}

/** Retention knobs; both optional, at least one must be set to prune anything. */
export interface RetentionOptions {
  /** Delete artifacts older than this many days. */
  readonly retentionDays?: number
  /** Keep at most this many artifacts (oldest deleted first). */
  readonly retentionMaxFiles?: number
}

/** Validate retention options; returns an error string when misconfigured. */
export function validateRetention(options: RetentionOptions): string | undefined {
  const { retentionDays, retentionMaxFiles } = options
  if (retentionDays !== undefined && (!Number.isFinite(retentionDays) || retentionDays <= 0)) {
    return `retentionDays must be a positive number (got ${String(retentionDays)})`
  }
  if (retentionMaxFiles !== undefined && (!Number.isFinite(retentionMaxFiles) || retentionMaxFiles < 1 || !Number.isInteger(retentionMaxFiles))) {
    return `retentionMaxFiles must be an integer >= 1 (got ${String(retentionMaxFiles)})`
  }
  return undefined
}

/**
 * Prune generated artifacts in `dir` according to `options`.
 *
 * Never throws: unreadable directories, unstat-able files, and unlink
 * failures are skipped silently — retention must not break an export.
 * The directory is created when missing so callers need not pre-create.
 *
 * @param dir - Directory to sweep (e.g. `<cwd>/dsh-transcripts`).
 * @param options - Days / max-files caps; unset caps are not enforced.
 * @returns The deletion summary for the command's tail line.
 */
export async function applyRetention(dir: string, options: RetentionOptions): Promise<RetentionResult> {
  const empty: RetentionResult = { deleted: [], considered: 0 }
  if (options.retentionDays === undefined && options.retentionMaxFiles === undefined) return empty
  const problem = validateRetention(options)
  if (problem !== undefined) return empty

  try {
    await mkdir(dir, { recursive: true })
  } catch {
    return empty
  }

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return empty
  }

  const candidates: PrunedFile[] = []
  for (const name of names) {
    if (!isArtifact(name)) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (info.isFile()) candidates.push({ path, mtimeMs: info.mtimeMs })
    } catch {
      // unstat-able: skip
    }
  }
  if (candidates.length === 0) return { deleted: [], considered: 0 }

  const cutoff = options.retentionDays !== undefined ? Date.now() - options.retentionDays * 86_400_000 : undefined
  const toDelete = new Set<string>()

  if (cutoff !== undefined) {
    for (const file of candidates) {
      if (file.mtimeMs < cutoff) toDelete.add(file.path)
    }
  }

  if (options.retentionMaxFiles !== undefined) {
    const survivors = candidates
      .filter((f) => !toDelete.has(f.path))
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    const excess = survivors.length - options.retentionMaxFiles
    for (let i = 0; i < excess; i += 1) {
      const victim = survivors[i]
      if (victim !== undefined) toDelete.add(victim.path)
    }
  }

  const deleted: PrunedFile[] = []
  for (const victim of toDelete) {
    try {
      await unlink(victim)
      const record = candidates.find((c) => c.path === victim)
      if (record !== undefined) deleted.push(record)
    } catch {
      // unlink failure: skip
    }
  }
  return { deleted, considered: candidates.length }
}

/** Render the one-line retention summary appended after a successful export. */
export function describeRetention(result: RetentionResult): string {
  if (result.deleted.length === 0) return ''
  const names = result.deleted.map((f) => f.path.split('/').pop() ?? f.path)
  const preview = names.slice(0, 3).join(', ')
  const extra = names.length > 3 ? ` (+${names.length - 3} more)` : ''
  return `retention: pruned ${String(names.length)} old artifact${names.length === 1 ? '' : 's'} — ${preview}${extra}`
}
