/**
 * dsh-session-export — session export for DeepSeek Harness.
 *
 * Registers two human commands (via ctx.commands): `/transcript` renders a
 * human-readable Markdown/JSON transcript, and `/archive` writes raw session
 * logs as per-session ZIPs. Both read through the trusted ctx.sessionQuery
 * seam, so any persistence backend (JSONL or SQLite) works without touching
 * raw artifacts — unlike the official browser `/export`, which requires a
 * raw-artifact backend and thus excludes SQLite deployments.
 *
 * Transcript semantics (per @deepseek-ai/dsh-session/surface): render
 * append-origin surface events — everything the user actually saw — rather
 * than the model-visible surface, whose compaction replacements would erase
 * conversation the user already read.
 */
import type { Context, Disposable } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createExportTool } from './exportTool.ts'
import { executeTranscript, type TranscriptConfig } from './command.ts'
import { executeArchive, type ArchiveConfig } from './archive.ts'
import { executeStats } from './statsCommand.ts'
import { executeBundle } from './bundleCommand.ts'
import { resolvePreset, type PresetName } from './presets.ts'

export const name = 'session-export'
export const inject = ['commands', 'sessionQuery']

export type { TranscriptConfig } from './command.ts'
export { parseTranscriptArgs, USAGE, buildEntries, buildTotals, buildLogOnly, id8 } from './command.ts'
export type { ArchiveConfig, ArchiveArgs } from './archive.ts'
export { parseArchiveArgs, ARCHIVE_USAGE, buildArchiveFromLog } from './archive.ts'
export { executeBundle, parseBundleArgs, BUNDLE_USAGE } from './bundleCommand.ts'
export type { BundleArgs, BundleConfig } from './bundleCommand.ts'
export { renderMarkdown, defaultMarkdownOptions } from './render/markdown.ts'
export type { MarkdownRenderOptions } from './render/markdown.ts'
export { renderJson } from './render/json.ts'
export { renderHtml, defaultHtmlOptions } from './render/html.ts'
export type { HtmlRenderOptions, ReportLang } from './render/html.ts'
export { renderLineageMermaid, renderTimelineMermaid } from './render/mermaid.ts'
export { computeStats, formatStatsCard, sparkline, formatDuration } from './stats.ts'
export { maskEntries, maskText } from './mask.ts'
export type { MaskMode, MaskOptions } from './mask.ts'
export { sha256Text, describeArtifact, buildManifest, renderManifest, verifyManifest } from './manifest.ts'
export type { ExportManifest, ManifestArtifact, ManifestScope } from './manifest.ts'
export type { StatsCardOptions } from './stats.ts'
export { parseStatsArgs, STATS_USAGE } from './statsCommand.ts'
export { resolvePreset, PRESETS } from './presets.ts'
export type { PresetName } from './presets.ts'
export { createExportTool, EXPORT_TOOL_DESCRIPTION } from './exportTool.ts'
export type { ExportEngine, ExportToolResult } from './exportTool.ts'
export { renderEditorDiff, renderToolDiff, parseToolArguments } from './render/diff.ts'
export type {
  LineageInfo,
  LineageNode,
  LogOnlyLine,
  RenderInput,
  SessionStats,
  ToolStat,
  TranscriptEntry,
  TranscriptTotals,
  CostEstimate,
  PricingConfig,
} from './types.ts'
export { buildZip } from './util/zip.ts'
export type { ZipEntry } from './util/zip.ts'

/** Combined plugin configuration (flat, backward compatible with v0.1.0). */
export type SessionExportConfig = TranscriptConfig & ArchiveConfig & {
  /** One-line policy pack shortcut: 'baseline' (default), 'compliance', or 'full'. Preset defaults are applied first; explicit config rows override. */
  readonly preset?: PresetName
}

/** Plugin entry: mount the /transcript and /archive commands. */
export function apply(ctx: Context, config?: SessionExportConfig): void {
  const resolved = resolvePreset(config)
  ctx.effect(
    function* () {
      yield ctx.commands.register({
        name: 'transcript',
        description: 'Export this session (or another, via --id) as a Markdown/JSON transcript to a host path',
        handler: (invocation) => executeTranscript(ctx, invocation, resolved),
      })
      yield ctx.commands.register({
        name: 'archive',
        description: 'Archive raw session logs (any backend, incl. SQLite) as per-session ZIPs to a host path',
        handler: (invocation) => executeArchive(ctx, invocation, resolved),
      })
      yield ctx.commands.register({
        name: 'stats',
        description: 'Print a session stats card (messages, tools, tokens, duration, cost) — no files written',
        handler: (invocation) => executeStats(ctx, invocation, resolved),
      })
      yield ctx.commands.register({
        name: 'bundle',
        description: 'Pack one session into a review ZIP: transcript + raw archive + manifest',
        handler: (invocation) => executeBundle(ctx, invocation, resolved),
      })
    },
    'session-export lifecycle',
  )

  // Model-facing evidence handoff (recall hit → full report). Opt-in: the
  // tools registry is not part of this plugin's inject list, so access it
  // defensively and skip silently when the composition has none.
  if (config?.exposeTool === true) {
    ctx.effect(
      function* () {
        const tools = (ctx as { tools?: { register(tool: ToolDefinition): Disposable } }).tools
        if (tools == null || typeof tools.register !== 'function') return
        yield tools.register(createExportTool(resolved, ctx.sessionQuery))
      },
      'session-export tool lifecycle',
    )
  }
}
