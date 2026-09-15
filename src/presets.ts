/**
 * Team-level presets — one-line shortcuts for common policy packs.
 *
 * A preset provides defaults; any explicit config row the user writes
 * (mask, manifest, maskMode, etc.) overrides it. The preset only fills
 * in the blanks.
 *
 * Register new presets by adding entries to {@link PRESETS} and
 * extending {@link PresetName}.
 */
import type { TranscriptConfig } from './command.ts'
import type { Contract } from './contract.ts'

/** Built-in preset names. */
export type PresetName = 'baseline' | 'compliance' | 'full'

/** Named presets — each is a partial TranscriptConfig whose fields act as fallback defaults. */
export const PRESETS: Readonly<Record<PresetName, Partial<TranscriptConfig>>> = {
  /** No special defaults; everything is opt-in. */
  baseline: {},
  /** Audit / evidence: mask secrets, write manifest sidecars, prune after 90 days; masking is contract-pinned. */
  compliance: {
    mask: true,
    maskMode: 'mask',
    manifest: true,
    retentionDays: 90,
    contract: {
      requireMask: true,
      requireMaskMode: 'mask',
    } satisfies Contract,
  },
  /** Maximal evidence: hash-mask, manifest, prune after 1 year; hash masking is contract-pinned. */
  full: {
    mask: true,
    maskMode: 'hash',
    manifest: true,
    retentionDays: 365,
    contract: {
      requireMask: true,
      requireMaskMode: 'hash',
    } satisfies Contract,
  },
}

/**
 * Resolve a named preset against explicit config.
 *
 * The preset fills in defaults first; the caller's config overrides
 * everything. Returns a new object; never mutates the input.
 */
export function resolvePreset<C extends { preset?: PresetName }>(
  config?: C,
): C & Partial<TranscriptConfig> {
  const presetName = config?.preset ?? 'baseline'
  const preset = PRESETS[presetName]
  if (preset === undefined) {
    throw new Error(
      `Unknown preset "${presetName}". Valid presets: ${Object.keys(PRESETS).join(', ')}`,
    )
  }
  return { ...preset, ...config } as C & Partial<TranscriptConfig>
}