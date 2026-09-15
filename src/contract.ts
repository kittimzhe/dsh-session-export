/**
 * Output contract — team-level constraints the model (or a single run)
 * cannot weaken.
 *
 * A preset can pin the shape of every export: {@link Contract} fields set
 * here override whatever the caller passes at runtime. `compliance` pins
 * masking on, `full` pins hash-masking on; both may pin the allowed
 * output formats and the destination directory. When a command runs
 * under a contract and its requested arguments violate it, the command
 * fails fast with a human-readable explanation instead of quietly
 * producing weaker evidence.
 *
 * @module dsh-session-export/contract
 */
import type { TranscriptConfig } from './command.ts'

/** Formats the transcript pipeline can render. */
export type ExportFormat = 'markdown' | 'json' | 'html'

const ALL_FORMATS: readonly ExportFormat[] = ['markdown', 'json', 'html']

/** Team-pinned output constraints. All fields optional; unset = not pinned. */
export interface Contract {
  /** Masking must end up enabled; `--no-mask` style overrides are rejected. */
  readonly requireMask?: boolean
  /** Masking must use this mode; conflicting per-run modes are rejected. */
  readonly requireMaskMode?: 'mask' | 'hash'
  /** Only these output formats may be produced. */
  readonly allowedFormats?: readonly ExportFormat[]
  /** Artifacts may only be written under this directory. */
  readonly pinnedDir?: string
}

/** Transcript-level knobs the contract can override at resolution time. */
interface MaskableConfig {
  readonly mask?: boolean
  readonly maskMode?: 'mask' | 'hash'
}

/**
 * Overlay the contract on top of user config / CLI arguments.
 *
 * Contract fields win wherever set; everything else passes through.
 * Returns a new object; never mutates inputs.
 */
export function applyContract<C extends MaskableConfig>(contract: Contract, requested: C): C {
  const overlay: Record<string, unknown> = {}
  if (contract.requireMask === true) overlay.mask = true
  if (contract.requireMaskMode !== undefined) overlay.maskMode = contract.requireMaskMode
  return { ...requested, ...overlay } as C
}

/**
 * Check requested output formats against the contract.
 * @returns An error string when a requested format is not allowed.
 */
export function checkFormats(contract: Contract, requested: readonly ExportFormat[]): string | undefined {
  const allowed = contract.allowedFormats
  if (allowed === undefined || requested.length === 0) return undefined
  const bad = requested.filter((f) => !allowed.includes(f))
  if (bad.length === 0) return undefined
  return `output contract: format${bad.length === 1 ? '' : 's'} ${bad.join(', ')} not allowed (allowed: ${allowed.join(', ')})`
}

/**
 * Check a requested output path against the pinned directory.
 * @returns An error string when the path escapes the pinned directory.
 */
export function checkPinnedDir(contract: Contract, outPath: string | undefined): string | undefined {
  if (contract.pinnedDir === undefined || outPath === undefined) return undefined
  const normalizedPin = contract.pinnedDir.replace(/\/+$/, '')
  const normalizedOut = outPath.replace(/\/+$/, '')
  if (normalizedOut === normalizedPin || normalizedOut.startsWith(`${normalizedPin}/`)) return undefined
  return `output contract: artifacts may only be written under ${contract.pinnedDir} (requested: ${outPath})`
}

/** Human-readable contract summary for error tails. */
export function describeContract(contract: Contract): string {
  const parts: string[] = []
  if (contract.requireMask === true) parts.push('mask required')
  if (contract.requireMaskMode !== undefined) parts.push(`maskMode=${contract.requireMaskMode}`)
  if (contract.allowedFormats !== undefined) parts.push(`formats: ${contract.allowedFormats.join('|')}`)
  if (contract.pinnedDir !== undefined) parts.push(`dir: ${contract.pinnedDir}`)
  if (parts.length === 0) return 'output contract: none'
  return `output contract: ${parts.join('; ')}`
}

/** Parse a format token into ExportFormat; undefined when unknown. */
export function parseExportFormat(token: string): ExportFormat | undefined {
  return ALL_FORMATS.find((f) => f === token)
}

/** Re-export so consumers can build config objects carrying contracts. */
export type { TranscriptConfig }
