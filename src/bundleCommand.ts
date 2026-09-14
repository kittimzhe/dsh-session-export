/**
 * `/bundle` — pack one session into a single review ZIP.
 *
 * A one-command handoff: transcript report(s) + raw JSONL archive +
 * sha256 evidence manifest, all in one timestamped ZIP. Designed for
 * review workflows, audit trails, and sharing evidence after a recall
 * hit.
 *
 * The bundle reuses the existing transcript and archive kernels
 * in-memory — no temp directory, no I/O until the final ZIP write.
 */
import type { Context, Disposable } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  GENERATOR,
  buildEntries,
  buildTotals,
  id8,
  timestampSlug,
  toLineageInfo,
  transcriptBasePath,
} from './command.ts'
import type { TranscriptConfig } from './command.ts'
import { buildArchiveFromLog } from './archive.ts'
import { buildZip } from './util/zip.ts'
import { renderMarkdown } from './render/markdown.ts'
import { renderJson } from './render/json.ts'
import { renderHtml } from './render/html.ts'
import { computeStats } from './stats.ts'
import { maskEntries } from './mask.ts'
import type { RenderInput } from './types.ts'
import { parseDurationBound } from './util/duration.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from './util/atomicWrite.ts'
import { buildManifest, describeBinaryArtifact, renderManifest } from './manifest.ts'

/** /bundle = zip: no extra config beyond what /transcript and /archive already share. */
export type BundleConfig = TranscriptConfig

export interface BundleArgs {
  sessionId?: string
  md: boolean
  html: boolean
  json: boolean
  errorsOnly: boolean
  since?: number
  mask: boolean
  manifest: boolean
  noTranscript: boolean
  noArchive: boolean
  outPath?: string
}

export const BUNDLE_USAGE = [
  'Usage: /bundle [options]',
  '',
  'Pack one session into a review ZIP: transcript report(s) + raw JSONL archive + manifest.',
  '',
  'Options:',
  '  --id <id>           Session id (default: current session).',
  '  --format <f>        Transcript format: md, html, json (default: html; repeatable).',
  '  --errors-only       Keep only failed-tool rows with two-entry context.',
  '  --last <dur>        Keep entries within this duration (e.g. 30m, 12h, 7d).',
  '  --mask              Redact likely secrets from the transcript.',
  '  --manifest          Include a sha256 evidence manifest in the bundle.',
  '  --no-transcript     Skip the transcript (archive ZIP + manifest only).',
  '  --no-archive        Skip the raw archive (transcript only).',
  '  --out <path>        Write the bundle ZIP to this path.',
].join('\n')

/** Parse `/bundle` arguments. Returns a string on error. */
export function parseBundleArgs(rest: string): BundleArgs | string {
  const args: BundleArgs = { md: false, html: false, json: false, errorsOnly: false, mask: false, manifest: false, noTranscript: false, noArchive: false }
  const tokens = rest.trim().length === 0 ? [] : rest.trim().split(/\s+/)
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] as string
    if (token === undefined) break
    if (token === '--id') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return `--id requires a session id value.\n${BUNDLE_USAGE}`
      if (args.sessionId !== undefined) return `--id may be given only once.\n${BUNDLE_USAGE}`
      args.sessionId = value
      i += 2
      continue
    }
    if (token === '--format') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return `--format requires a format (md, html, or json).\n${BUNDLE_USAGE}`
      switch (value) {
        case 'md': args.md = true; break
        case 'html': args.html = true; break
        case 'json': args.json = true; break
        default: return `Unknown format "${value}". Use md, html, or json.\n${BUNDLE_USAGE}`
      }
      i += 2
      continue
    }
    if (token === '--last') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return `--last requires a duration (e.g. 30m, 12h, 7d).\n${BUNDLE_USAGE}`
      const bound = parseDurationBound(value)
      if (bound === null) return `Invalid duration "${value}". Use e.g. 30m, 12h, 7d.\n${BUNDLE_USAGE}`
      args.since = bound
      i += 2
      continue
    }
    if (token === '--errors-only') { args.errorsOnly = true; i += 1; continue }
    if (token === '--mask') { args.mask = true; i += 1; continue }
    if (token === '--manifest') { args.manifest = true; i += 1; continue }
    if (token === '--no-transcript') { args.noTranscript = true; i += 1; continue }
    if (token === '--no-archive') { args.noArchive = true; i += 1; continue }
    if (token === '--out') {
      const restLine = tokens.slice(i + 1).join(' ')
      if (restLine.trim().length === 0) return `--out requires a file path.\n${BUNDLE_USAGE}`
      args.outPath = restLine.trim()
      i = tokens.length
      continue
    }
    return `Unknown option: ${token}\n${BUNDLE_USAGE}`
  }

  // Default: html transcript + archive
  if (!args.md && !args.html && !args.json) args.html = true
  return args
}

/** Execute `/bundle` — read, build, zip, write. */
export async function executeBundle(
  ctx: Context,
  invocation: CommandInvocation,
  config?: BundleConfig,
): Promise<CommandResult> {
  const parsed = parseBundleArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }
  const args = parsed

  if (args.noTranscript && args.noArchive) {
    return { kind: 'error', text: 'At least one of transcript or archive is required.\n' + BUNDLE_USAGE }
  }

  const sessionIdRaw = args.sessionId ?? invocation.agent.session.id
  const sessionId = SessionId(sessionIdRaw)

  let log: { session: SessionHeader; events: SessionEvent[] }
  try {
    log = await ctx.sessionQuery.readSession(sessionId)
  } catch (error) {
    return { kind: 'error', text: `Could not read session ${sessionIdRaw}: ${error instanceof Error ? error.message : String(error)}` }
  }

  // ── lineage ──
  let lineage: RenderInput['lineage']
  try {
    lineage = toLineageInfo(await ctx.sessionQuery.traceSession(sessionId))
  } catch {
    lineage = undefined
  }

  // ── transcript entries ──
  let entries = buildEntries(log.events)

  // --errors-only: keep failed tool results plus a two-entry context window
  if (args.errorsOnly) {
    const keep = new Set<number>()
    entries.forEach((entry, index) => {
      if (entry.error !== undefined) {
        for (let w = Math.max(0, index - 2); w <= Math.min(entries.length - 1, index + 2); w += 1) keep.add(w)
      }
    })
    entries = entries.filter((_, index) => keep.has(index))
  }
  if (args.since !== undefined) entries = entries.filter((entry) => entry.time >= args.since!)

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
  const maskMode: 'off' | 'mask' | 'hash' = !maskOn ? 'off' : (config?.maskMode ?? 'mask')
  const renderedEntries = maskOn ? maskEntries(entries, { extraPatterns: config?.maskPatterns, mode: maskMode === 'hash' ? 'hash' : 'mask' }) : entries
  const input: RenderInput = {
    header: log.session,
    entries: renderedEntries,
    ...(lineage !== undefined ? { lineage } : {}),
    totals,
    stats,
    ...(filterNote !== undefined ? { filterNote } : {}),
    generator: GENERATOR,
    generatedAt: Date.now(),
  }

  // ── build bundle entries ──
  const bundleEntries: Array<{ name: string; data: Uint8Array }> = []
  const formatNames: string[] = []

  if (!args.noTranscript) {
    if (args.md) { bundleEntries.push({ name: 'transcript.md', data: new TextEncoder().encode(renderMarkdown(input, config)) }); formatNames.push('md') }
    if (args.html) { bundleEntries.push({ name: 'transcript.html', data: new TextEncoder().encode(renderHtml(input, config)) }); formatNames.push('html') }
    if (args.json) { bundleEntries.push({ name: 'transcript.json', data: new TextEncoder().encode(renderJson(input)) }); formatNames.push('json') }
  }

  if (!args.noArchive) {
    const archive = buildArchiveFromLog(log)
    bundleEntries.push({ name: 'archive.zip', data: archive.zip })
  }

  if (args.manifest || config?.manifest === true) {
    const manifest = buildManifest({
      generator: GENERATOR,
      createdAt: input.generatedAt,
      session: { id: log.session.id, createdAt: log.session.createdAt },
      scope: {
        entries: entries.length,
        errorsOnly: args.errorsOnly,
        ...(args.since !== undefined ? { since: args.since } : {}),
        full: false,
      },
      mask: { mode: maskMode },
      artifacts: bundleEntries.map((entry) => describeBinaryArtifact(entry.name, entry.data)),
    })
    bundleEntries.push({ name: 'manifest.json', data: new TextEncoder().encode(renderManifest(manifest)) })
  }

  const bundleZip = buildZip(bundleEntries)

  // ── write ──
  const baseDir = config?.defaultDir ?? log.session.cwd ?? process.cwd()
  const outPath =
    args.outPath ?? `${baseDir}/dsh-transcripts/bundle-${id8(sessionIdRaw)}-${timestampSlug(Date.now())}.zip`

  try {
    await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, Buffer.from(bundleZip))
  } catch (error) {
    return { kind: 'error', text: `Failed to write bundle: ${error instanceof Error ? error.message : String(error)}` }
  }

  const parts: string[] = []
  if (formatNames.length > 0) parts.push(`${formatNames.length} transcript${formatNames.length > 1 ? 's' : ''} (${formatNames.join('/')})`)
  if (!args.noArchive) parts.push('1 raw archive')
  if (args.manifest || config?.manifest === true) parts.push('1 manifest')
  const maskNote = maskMode !== 'off' ? `, ${maskMode}-redacted` : ''
  return {
    kind: 'success',
    text: `Bundled → ${outPath} (${parts.join(' + ')}${maskNote})`,
  }
}