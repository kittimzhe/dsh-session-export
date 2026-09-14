/**
 * Evidence manifest for transcript exports.
 *
 * A manifest is a small JSON sidecar that records, for every artifact one
 * `/transcript` run produced: the file path, its byte size, and a SHA-256
 * digest. It makes the export *verifiable*: anyone holding the artifacts can
 * recompute the digests and prove the files are exactly what the generator
 * wrote — integrity, not reproducibility (report bytes embed generation
 * timestamps).
 *
 * Pure functions only: hashing takes artifact *contents*, writing belongs to
 * the caller.
 *
 * @module dsh-session-export/manifest
 */
import { createHash } from 'node:crypto'
import type { MaskMode } from './mask.ts'

/** One produced artifact as recorded in the manifest. */
export interface ManifestArtifact {
  /** Path exactly as reported to the user (relative or absolute). */
  readonly path: string
  /** Byte length of the artifact content (UTF-8). */
  readonly bytes: number
  /** Lowercase hex SHA-256 of the artifact content. */
  readonly sha256: string
}

/** Which view of the session the run exported. */
export interface ManifestScope {
  /** Number of rendered entries after filters. */
  readonly entries: number
  /** True when `--errors-only` was applied. */
  readonly errorsOnly: boolean
  /** Epoch-ms lower bound from `--last`, when given. */
  readonly since?: number
  /** True when `--full` (log-only appendix) was applied. */
  readonly full: boolean
}

/** The manifest document (JSON-serializable, stable key order). */
export interface ExportManifest {
  readonly generator: string
  readonly createdAt: number
  readonly session: { readonly id: string; readonly createdAt: number }
  readonly scope: ManifestScope
  readonly mask: { readonly mode: 'off' | MaskMode }
  readonly artifacts: readonly ManifestArtifact[]
}

/** SHA-256 (lowercase hex) of a string's UTF-8 bytes. */
export function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Describe one artifact for the manifest. */
export function describeArtifact(path: string, content: string): ManifestArtifact {
  return { path, bytes: Buffer.byteLength(content, 'utf8'), sha256: sha256Text(content) }
}

function sha256Binary(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Like {@link describeArtifact} but for binary content; sha256 runs over the raw bytes. */
export function describeBinaryArtifact(path: string, data: Uint8Array): ManifestArtifact {
  return { path, bytes: data.length, sha256: sha256Binary(data) }
}

/** Assemble the manifest document. */
export function buildManifest(input: {
  generator: string
  createdAt: number
  session: { id: string; createdAt: number }
  scope: ManifestScope
  mask: { mode: 'off' | MaskMode }
  artifacts: readonly ManifestArtifact[]
}): ExportManifest {
  return {
    generator: input.generator,
    createdAt: input.createdAt,
    session: { id: input.session.id, createdAt: input.session.createdAt },
    scope: {
      entries: input.scope.entries,
      errorsOnly: input.scope.errorsOnly,
      ...(input.scope.since !== undefined ? { since: input.scope.since } : {}),
      full: input.scope.full,
    },
    mask: { mode: input.mask.mode },
    artifacts: input.artifacts.map((artifact) => ({ ...artifact })),
  }
}

/** Render the manifest as stable, diff-friendly JSON (2-space, trailing newline). */
export function renderManifest(manifest: ExportManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Recompute and compare digests for artifacts held as strings. */
export function verifyManifest(
  manifest: ExportManifest,
  artifacts: ReadonlyMap<string, string>,
): { ok: boolean; checked: number; mismatches: string[] } {
  const mismatches: string[] = []
  let checked = 0
  for (const artifact of manifest.artifacts) {
    const content = artifacts.get(artifact.path)
    if (content === undefined) {
      mismatches.push(`${artifact.path}: missing`)
      continue
    }
    checked += 1
    const actual = describeArtifact(artifact.path, content)
    if (actual.sha256 !== artifact.sha256) mismatches.push(`${artifact.path}: sha256 mismatch`)
    else if (actual.bytes !== artifact.bytes) mismatches.push(`${artifact.path}: size mismatch`)
  }
  return { ok: mismatches.length === 0, checked, mismatches }
}
