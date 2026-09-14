import { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { Context } from "@deepseek-ai/cordis";
import "@deepseek-ai/dsh-commands";
import { Message, TokenUsage } from "@deepseek-ai/dsh-llm";
//#region src/types.d.ts
/** One surface event projected to the message the user actually saw. */
interface TranscriptEntry {
  /** Raw-log sequence number of the source event. */
  readonly seq: number;
  /** Event time in epoch milliseconds. */
  readonly time: number;
  /** Presentation classification derived from the message itself. */
  readonly kind: 'user' | 'assistant' | 'tool-result';
  /** The derived immutable message (never null here — adapter drops nulls). */
  readonly message: Message;
  /** Token accounting, present on `assistant/message` events that reported usage. */
  readonly usage?: TokenUsage;
  /** Structured tool error, present on failed `tool/result` events. */
  readonly error?: {
    name: string;
    code: string;
  };
}
/** One log-only event summarized for the `--full` appendix. */
interface LogOnlyLine {
  readonly seq: number;
  readonly time: number;
  readonly type: string;
  /** Short human summary; renderers never assume its shape. */
  readonly summary?: string;
}
/** Lineage subset the renderers need (detached upstream records). */
interface LineageInfo {
  /** Parents from the immediate parent outward. */
  readonly ancestors: readonly {
    readonly id: string;
    readonly createdAt: number;
    readonly origin?: string;
  }[];
  /** Recursive descendant trees rooted at this session's direct children. */
  readonly descendants: readonly LineageNode[];
}
/** One node of the descendant tree. */
interface LineageNode {
  readonly id: string;
  readonly createdAt: number;
  readonly origin?: string;
  readonly children: readonly LineageNode[];
}
/** Aggregate totals for the transcript header. */
interface TranscriptTotals {
  readonly messages: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}
/** Per-tool call accounting. */
interface ToolStat {
  readonly name: string;
  readonly calls: number;
  readonly failures: number;
}
/** Price table applied to token totals (per one million tokens). */
interface PricingConfig {
  readonly inputPerMillion?: number;
  readonly outputPerMillion?: number;
  /** Currency label rendered next to the estimate, e.g. `'$'` or `'¥'`. */
  readonly currency?: string;
}
/** Token-cost estimate derived from usage totals. */
interface CostEstimate {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly currency: string;
}
/** Session-wide statistics computed from transcript entries. */
interface SessionStats {
  readonly messages: number;
  readonly turns: number;
  readonly toolCalls: number;
  readonly failedToolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Wall-clock span from first to last entry; null with fewer than two entries. */
  readonly durationMs: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** Tools sorted by descending call count. */
  readonly toolBreakdown: readonly ToolStat[];
  /** Output tokens per assistant message, in log order (sparkline series). */
  readonly perAssistantTokens: readonly number[];
  readonly cost?: CostEstimate;
}
/** Everything a renderer needs, fully detached from cordis. */
interface RenderInput {
  readonly header: SessionHeader;
  readonly entries: readonly TranscriptEntry[];
  readonly lineage?: LineageInfo;
  readonly logOnly?: readonly LogOnlyLine[];
  readonly totals: TranscriptTotals;
  /** Extended statistics; renderers may omit sections when absent. */
  readonly stats?: SessionStats;
  /** Human-readable note when the entry set was filtered (`--last`, `--errors-only`). */
  readonly filterNote?: string;
  readonly generator: string;
  readonly generatedAt: number;
}
//#endregion
//#region src/command.d.ts
declare const USAGE = "Usage: /transcript [path] [--id <sessionId>] [--out <path>] [--json] [--md] [--html] [--full] [--last <duration>] [--errors-only] [--mask] [--mask-hash] [--manifest]";
interface TranscriptArgs {
  readonly sessionId?: string;
  readonly outPath?: string;
  readonly json: boolean;
  readonly md: boolean;
  readonly html: boolean;
  readonly full: boolean;
  /** Epoch-millisecond lower bound from `--last`. */
  readonly since?: number;
  readonly errorsOnly: boolean;
  readonly mask: boolean;
  /** `--mask-hash`: redact with deterministic digests instead of placeholders. */
  readonly maskHash: boolean;
  /** `--manifest`: write a `.manifest.json` sidecar with per-artifact sha256. */
  readonly manifest: boolean;
}
/** Parse raw command input; returns args or a usage-error string. */
declare function parseTranscriptArgs(rawInput: string): TranscriptArgs | string;
declare function id8(id: string): string;
/** Adapt append-origin surface events to renderer entries (drop nulls). */
declare function buildEntries(events: readonly SessionEvent[]): TranscriptEntry[];
/** Summarize log-only events for the --full appendix. */
declare function buildLogOnly(events: readonly SessionEvent[]): LogOnlyLine[];
declare function buildTotals(entries: readonly TranscriptEntry[]): TranscriptTotals;
interface TranscriptConfig {
  /** Directory used when no explicit path is given. */
  readonly defaultDir?: string;
  /** Character limit for rendered tool arguments. */
  readonly argCharLimit?: number;
  /** Character limit for rendered tool results. */
  readonly resultCharLimit?: number;
  /** Redact likely secrets in rendered output (default false; `--mask` turns it on per run). */
  readonly mask?: boolean;
  /** Replacement mode when masking: fixed placeholders (`mask`, default) or deterministic digests (`hash`). */
  readonly maskMode?: 'mask' | 'hash';
  /** Write a `.manifest.json` sidecar with per-artifact sha256 (default false; `--manifest` turns it on per run). */
  readonly manifest?: boolean;
  /** UI label language for the HTML report (default 'en'). */
  readonly lang?: 'en' | 'zh';
  /** Extra masking regex sources applied alongside the built-in rules. */
  readonly maskPatterns?: readonly string[];
  /** Token price table; cost rows appear only when both rates are set. */
  readonly pricing?: PricingConfig;
}
//#endregion
//#region src/archive.d.ts
declare const ARCHIVE_USAGE = "Usage: /archive [--id <sessionId>] [--all] [--since <duration>] [--out <dir>] [--no-descendants]";
interface ArchiveArgs {
  readonly sessionId?: string;
  readonly all: boolean;
  readonly since?: number;
  readonly outDir?: string;
  readonly noDescendants: boolean;
}
interface ArchiveConfig {
  /** Output directory used when `/archive` is run without `--out` (default `<cwd>/.dsh-archives`). */
  readonly archiveDir?: string;
  /** Include subagent descendants when archiving a single session (default true). */
  readonly includeDescendants?: boolean;
  /** Safety cap on one `/archive --all` run (default 100). */
  readonly maxSessionsPerRun?: number;
}
/** Parse raw command input; returns args or a usage-error string. */
declare function parseArchiveArgs(rawInput: string): ArchiveArgs | string;
//#endregion
//#region src/render/markdown.d.ts
interface MarkdownRenderOptions {
  readonly argCharLimit: number;
  readonly resultCharLimit: number;
}
declare const defaultMarkdownOptions: MarkdownRenderOptions;
/** Render the complete Markdown transcript. */
declare function renderMarkdown(input: RenderInput, options?: Partial<MarkdownRenderOptions>): string;
//#endregion
//#region src/render/json.d.ts
/** Render the complete JSON transcript document. */
declare function renderJson(input: RenderInput): string;
//#endregion
//#region src/render/html.d.ts
/** Report label language; English is the default. */
type ReportLang = 'en' | 'zh';
interface HtmlRenderOptions {
  readonly argCharLimit: number;
  readonly resultCharLimit: number;
  /** UI label language for the report (default `'en'`). */
  readonly lang?: ReportLang;
}
declare const defaultHtmlOptions: HtmlRenderOptions;
/** Render the complete single-file HTML report. */
declare function renderHtml(input: RenderInput, options?: Partial<HtmlRenderOptions>): string;
//#endregion
//#region src/render/mermaid.d.ts
/**
 * Render the lineage (ancestors + descendants + self) as a `graph TD` block.
 * @param lineage - Lineage info from `traceSession`.
 * @param selfId - This session's id (rendered as the highlighted root).
 * @returns The Mermaid block, or null when the lineage is empty.
 */
declare function renderLineageMermaid(lineage: LineageInfo, selfId: string): string | null;
/**
 * Render per-turn durations as a `gantt` block. A turn spans from one user
 * message to the next (the last turn ends at the final entry).
 * @param entries - Transcript entries in log order.
 * @returns The Mermaid block, or null with fewer than two turns.
 */
declare function renderTimelineMermaid(entries: readonly TranscriptEntry[]): string | null;
//#endregion
//#region src/stats.d.ts
/** Format a duration in milliseconds as a compact human label. */
declare function formatDuration(ms: number): string;
/**
 * Compute session-wide statistics from transcript entries.
 * @param entries - Transcript entries in log order.
 * @param pricing - Optional price table; cost fields appear only when both
 *   per-million rates are set.
 * @returns Aggregated statistics.
 */
declare function computeStats(entries: readonly TranscriptEntry[], pricing?: PricingConfig): SessionStats;
/**
 * Render a numeric series as a compact sparkline string.
 * @param series - Numbers (zero-safe; all-zero renders as a flat line).
 * @returns One glyph per value.
 */
declare function sparkline(series: readonly number[]): string;
interface StatsCardOptions {
  /** Emit ANSI color escapes (default false — plain text everywhere). */
  readonly color?: boolean;
}
/**
 * Format statistics as a terminal card.
 * @param stats - Computed session statistics.
 * @param options - Card options.
 * @returns Multi-line card text (no trailing newline).
 */
declare function formatStatsCard(stats: SessionStats, options?: StatsCardOptions): string;
//#endregion
//#region src/mask.d.ts
/** How matched secrets are replaced. */
type MaskMode = 'mask' | 'hash';
interface MaskOptions {
  /** Extra user-supplied patterns (source strings) applied after the builtins. */
  readonly extraPatterns?: readonly string[];
  /** Replacement mode: fixed placeholders (`mask`, default) or deterministic digests (`hash`). */
  readonly mode?: MaskMode;
}
/**
 * Mask a read-only entry list into a new array with masked copies.
 * @param entries - Original entries (never mutated).
 * @param options - Mask options.
 * @returns New entry array with masked message content; entry/ordering metadata unchanged.
 */
declare function maskEntries(entries: readonly TranscriptEntry[], options?: MaskOptions): TranscriptEntry[];
/**
 * Mask a bare string (exported for tests and direct use).
 * @param text - Raw text.
 * @param options - Mask options.
 * @returns Masked text.
 */
declare function maskText(text: string, options?: MaskOptions): string;
//#endregion
//#region src/manifest.d.ts
/** One produced artifact as recorded in the manifest. */
interface ManifestArtifact {
  /** Path exactly as reported to the user (relative or absolute). */
  readonly path: string;
  /** Byte length of the artifact content (UTF-8). */
  readonly bytes: number;
  /** Lowercase hex SHA-256 of the artifact content. */
  readonly sha256: string;
}
/** Which view of the session the run exported. */
interface ManifestScope {
  /** Number of rendered entries after filters. */
  readonly entries: number;
  /** True when `--errors-only` was applied. */
  readonly errorsOnly: boolean;
  /** Epoch-ms lower bound from `--last`, when given. */
  readonly since?: number;
  /** True when `--full` (log-only appendix) was applied. */
  readonly full: boolean;
}
/** The manifest document (JSON-serializable, stable key order). */
interface ExportManifest {
  readonly generator: string;
  readonly createdAt: number;
  readonly session: {
    readonly id: string;
    readonly createdAt: number;
  };
  readonly scope: ManifestScope;
  readonly mask: {
    readonly mode: 'off' | MaskMode;
  };
  readonly artifacts: readonly ManifestArtifact[];
}
/** SHA-256 (lowercase hex) of a string's UTF-8 bytes. */
declare function sha256Text(content: string): string;
/** Describe one artifact for the manifest. */
declare function describeArtifact(path: string, content: string): ManifestArtifact;
/** Assemble the manifest document. */
declare function buildManifest(input: {
  generator: string;
  createdAt: number;
  session: {
    id: string;
    createdAt: number;
  };
  scope: ManifestScope;
  mask: {
    mode: 'off' | MaskMode;
  };
  artifacts: readonly ManifestArtifact[];
}): ExportManifest;
/** Render the manifest as stable, diff-friendly JSON (2-space, trailing newline). */
declare function renderManifest(manifest: ExportManifest): string;
/** Recompute and compare digests for artifacts held as strings. */
declare function verifyManifest(manifest: ExportManifest, artifacts: ReadonlyMap<string, string>): {
  ok: boolean;
  checked: number;
  mismatches: string[];
};
//#endregion
//#region src/statsCommand.d.ts
declare const STATS_USAGE = "Usage: /stats [--id <sessionId>]";
interface StatsArgs {
  readonly sessionId?: string;
}
/** Parse raw command input; returns args or a usage-error string. */
declare function parseStatsArgs(rawInput: string): StatsArgs | string;
//#endregion
//#region src/render/diff.d.ts
/**
 * Render `str_replace_editor` tool-call arguments as a unified-diff-looking
 * fenced block. Only that tool's argument shape is understood; every other
 * tool falls back to pretty-printed JSON in the markdown renderer.
 */
/** Parse the raw JSON arguments string of a tool call; null when not JSON. */
declare function parseToolArguments(raw: string): unknown | null;
/**
 * Build a ```diff fenced body for an editor replacement, or null when the
 * arguments do not describe one.
 */
declare function renderEditorDiff(args: unknown): string | null;
/**
 * Render a tool call's arguments as a diff body when the tool is a known
 * file-mutating editor (`str_replace_editor`, `edit`, or `write`); null for
 * anything else or for arguments that describe no mutation. Deployment tool
 * names differ (package names vs registered names), so all three are covered.
 */
declare function renderToolDiff(toolName: string, args: unknown): string | null;
//#endregion
//#region src/util/zip.d.ts
interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}
/** Build one DEFLATE-compressed ZIP archive over the given entries. */
declare function buildZip(entries: readonly ZipEntry[], nowMs?: number): Uint8Array;
//#endregion
//#region src/index.d.ts
declare const name = "session-export";
declare const inject: string[];
/** Combined plugin configuration (flat, backward compatible with v0.1.0). */
type SessionExportConfig = TranscriptConfig & ArchiveConfig;
/** Plugin entry: mount the /transcript and /archive commands. */
declare function apply(ctx: Context, config?: SessionExportConfig): void;
//#endregion
export { ARCHIVE_USAGE, type ArchiveArgs, type ArchiveConfig, type CostEstimate, type ExportManifest, type HtmlRenderOptions, type LineageInfo, type LineageNode, type LogOnlyLine, type ManifestArtifact, type ManifestScope, type MarkdownRenderOptions, type MaskMode, type MaskOptions, type PricingConfig, type RenderInput, type ReportLang, STATS_USAGE, SessionExportConfig, type SessionStats, type StatsCardOptions, type ToolStat, type TranscriptConfig, type TranscriptEntry, type TranscriptTotals, USAGE, type ZipEntry, apply, buildEntries, buildLogOnly, buildManifest, buildTotals, buildZip, computeStats, defaultHtmlOptions, defaultMarkdownOptions, describeArtifact, formatDuration, formatStatsCard, id8, inject, maskEntries, maskText, name, parseArchiveArgs, parseStatsArgs, parseToolArguments, parseTranscriptArgs, renderEditorDiff, renderHtml, renderJson, renderLineageMermaid, renderManifest, renderMarkdown, renderTimelineMermaid, renderToolDiff, sha256Text, sparkline, verifyManifest };