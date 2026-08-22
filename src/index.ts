/**
 * dsh-session-export — human-readable session transcript export for DeepSeek
 * Harness.
 *
 * Registers the `/transcript` human command (via ctx.commands) and reads
 * sessions through the trusted ctx.sessionQuery seam, so any persistence
 * backend (JSONL or SQLite) works without touching raw artifacts.
 *
 * Transcript semantics (per @deepseek-ai/dsh-session/surface): render
 * append-origin surface events — everything the user actually saw — rather
 * than the model-visible surface, whose compaction replacements would erase
 * conversation the user already read.
 */
import type { Context } from '@deepseek-ai/cordis'
import { executeTranscript, type TranscriptConfig } from './command.ts'

export const name = 'session-export'
export const inject = ['commands', 'sessionQuery']

export type { TranscriptConfig } from './command.ts'
export { parseTranscriptArgs, USAGE, buildEntries, buildTotals, buildLogOnly } from './command.ts'
export { renderMarkdown, defaultMarkdownOptions } from './render/markdown.ts'
export type { MarkdownRenderOptions } from './render/markdown.ts'
export { renderJson } from './render/json.ts'
export { renderEditorDiff, renderToolDiff, parseToolArguments } from './render/diff.ts'
export type { LineageInfo, LineageNode, LogOnlyLine, RenderInput, TranscriptEntry, TranscriptTotals } from './types.ts'

/** Plugin entry: mount the /transcript command. */
export function apply(ctx: Context, config?: TranscriptConfig): void {
  ctx.effect(
    function* () {
      yield ctx.commands.register({
        name: 'transcript',
        description: 'Export this session (or another, via --id) as a Markdown/JSON transcript to a host path',
        handler: (invocation) => executeTranscript(ctx, invocation, config),
      })
    },
    'session-export lifecycle',
  )
}
