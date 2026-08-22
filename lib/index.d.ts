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
/** Everything a renderer needs, fully detached from cordis. */
interface RenderInput {
  readonly header: SessionHeader;
  readonly entries: readonly TranscriptEntry[];
  readonly lineage?: LineageInfo;
  readonly logOnly?: readonly LogOnlyLine[];
  readonly totals: TranscriptTotals;
  readonly generator: string;
  readonly generatedAt: number;
}
//#endregion
//#region src/command.d.ts
declare const USAGE = "Usage: /transcript [path] [--id <sessionId>] [--out <path>] [--json] [--md] [--full]";
interface TranscriptArgs {
  readonly sessionId?: string;
  readonly outPath?: string;
  readonly json: boolean;
  readonly md: boolean;
  readonly full: boolean;
}
/** Parse raw command input; returns args or a usage-error string. */
declare function parseTranscriptArgs(rawInput: string): TranscriptArgs | string;
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
}
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
//#region src/index.d.ts
declare const name = "session-export";
declare const inject: string[];
/** Plugin entry: mount the /transcript command. */
declare function apply(ctx: Context, config?: TranscriptConfig): void;
//#endregion
export { type LineageInfo, type LineageNode, type LogOnlyLine, type MarkdownRenderOptions, type RenderInput, type TranscriptConfig, type TranscriptEntry, type TranscriptTotals, USAGE, apply, buildEntries, buildLogOnly, buildTotals, defaultMarkdownOptions, inject, name, parseToolArguments, parseTranscriptArgs, renderEditorDiff, renderJson, renderMarkdown, renderToolDiff };