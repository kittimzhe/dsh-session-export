/**
 * The model-facing `transcript_export` tool — the recall → export evidence
 * handoff.
 *
 * The `/transcript` command is user-invoked; a model that just found a past
 * session through `recall` cannot run commands. This tool exposes the same
 * export kernel (entries, masking, renderers, manifest) as a typed tool so
 * the model can hand a hit session off to a full evidence report. It is
 * opt-in: it only registers when the plugin row sets `exposeTool: true`.
 *
 * Deliberately narrower than the command: one format per call, no custom
 * output path (files always land in the standard `dsh-transcripts`
 * directory or the configured `defaultDir`), timestamped names so nothing
 * is ever overwritten.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  GENERATOR,
  buildEntries,
  buildSessionManifest,
  buildTotals,
  toLineageInfo,
  transcriptBasePath,
} from './command.ts'
import type { SessionTraceLike, TranscriptConfig } from './command.ts'
import { renderMarkdown } from './render/markdown.ts'
import { renderJson } from './render/json.ts'
import { renderHtml } from './render/html.ts'
import { computeStats } from './stats.ts'
import { maskEntries } from './mask.ts'
import type { RenderInput } from './types.ts'
import { parseDurationBound } from './util/duration.ts'
import { atomicWriteFile } from './util/atomicWrite.ts'
import { renderManifest } from './manifest.ts'

/** The ctx.sessionQuery surface this tool consumes (structural, for testability). */
export interface ExportEngine {
  readSession(sessionId: SessionId): Promise<{ session: SessionHeader; events: SessionEvent[] }>
  traceSession(sessionId: SessionId): Promise<SessionTraceLike>
}

export const EXPORT_TOOL_DESCRIPTION = [
  'Write a full transcript report of one past or current session to a host file — Markdown, styled single-file HTML, or JSON — with optional secret redaction and a sha256 evidence manifest.',
  'Use it when the user asks to save, export, or archive a session report, or right after a recall hit when they want the full evidence for that session.',
  'Files land in the dsh-transcripts directory of the session cwd (or the configured defaultDir); names are timestamped so existing files are never overwritten.',
  'Returns the written paths plus message / tool-call / token totals.',
].join(' ')

/** The tool's canonical result, validated against the output schema. */
export interface ExportToolResult {
  sessionId: string
  format: 'md' | 'html' | 'json'
  written: string[]
  manifest: string | null
  messages: number
  toolCalls: number
  tokens: number
  maskMode: 'off' | 'mask' | 'hash'
  error: string | null
}

function exportError(sessionId: string, format: ExportToolResult['format'], message: string): ExportToolResult {
  return {
    sessionId,
    format,
    written: [],
    manifest: null,
    messages: 0,
    toolCalls: 0,
    tokens: 0,
    maskMode: 'off',
    error: message,
  }
}

function renderResultText(result: ExportToolResult): string {
  if (result.error !== null) return `transcript_export failed: ${result.error}`
  const manifestNote = result.manifest !== null ? ` (+ ${result.manifest})` : ''
  const maskNote = result.maskMode !== 'off' ? `, ${result.maskMode}-redacted` : ''
  return (
    `Exported ${result.messages} messages (${result.toolCalls} tool calls, ${result.tokens} tokens${maskNote}) ` +
    `→ ${result.written.join(', ')}${manifestNote}`
  )
}

const nullableString = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const

const exportOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string' },
    format: { type: 'string', enum: ['md', 'html', 'json'] },
    written: { type: 'array', items: { type: 'string' } },
    manifest: nullableString,
    messages: { type: 'integer' },
    toolCalls: { type: 'integer' },
    tokens: { type: 'integer' },
    maskMode: { type: 'string', enum: ['off', 'mask', 'hash'] },
    error: nullableString,
  },
} as const

/**
 * Build the `transcript_export` ToolDefinition around a sessionQuery engine.
 * Pure construction — no registration happens here.
 */
export function createExportTool(config?: TranscriptConfig, engine?: ExportEngine): ToolDefinition {
  return defineTool({
    name: 'transcript_export',
    description: EXPORT_TOOL_DESCRIPTION,
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    parameters: {
      session_id: { type: 'string', required: true, description: 'Id of the session to export (e.g. a recall hit sessionId).' },
      format: { type: 'string', description: "Output format: 'html' (default), 'md', or 'json'." },
      mask: { type: 'boolean', description: 'Redact likely secrets (API keys, bearer tokens, private keys, emails) from the report.' },
      manifest: { type: 'boolean', description: 'Also write a .manifest.json sidecar with the artifact sha256.' },
      last: { type: 'string', description: 'Limit to entries from the recent past, e.g. 30m / 12h / 7d.' },
    },
    output: {
      schema: exportOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderResultText(value as ExportToolResult) }],
    },
    async execute(args: { session_id?: string; format?: string; mask?: boolean; manifest?: boolean; last?: string }): Promise<ExportToolResult> {
      const format: ExportToolResult['format'] = args.format === 'md' || args.format === 'json' ? args.format : 'html'
      const sessionIdRaw = args.session_id ?? ''
      if (sessionIdRaw === '') return exportError(sessionIdRaw, format, 'session_id is required.')
      if (engine == null) return exportError(sessionIdRaw, format, 'no sessionQuery engine was wired into this plugin instance.')

      let since: number | undefined
      if (args.last !== undefined && args.last !== '') {
        const bound = parseDurationBound(args.last)
        if (bound === null) return exportError(sessionIdRaw, format, `last expects a duration like 30m, 12h, or 7d (got "${args.last}").`)
        since = bound
      }

      const sessionId = SessionId(sessionIdRaw)
      let log: { session: SessionHeader; events: SessionEvent[] }
      try {
        log = await engine.readSession(sessionId)
      } catch (error) {
        return exportError(sessionIdRaw, format, `could not read session ${sessionIdRaw}: ${error instanceof Error ? error.message : String(error)}`)
      }

      let lineage: RenderInput['lineage']
      try {
        lineage = toLineageInfo(await engine.traceSession(sessionId))
      } catch {
        lineage = undefined
      }

      let entries = buildEntries(log.events)
      if (since !== undefined) entries = entries.filter((entry) => entry.time >= since)

      const filterNote = since !== undefined ? 'Filtered view: entries within last' : undefined
      const totals = buildTotals(entries)
      const stats = computeStats(entries, config?.pricing)
      const maskOn = args.mask === true || config?.mask === true
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

      const baseDir = config?.defaultDir ?? log.session.cwd ?? process.cwd()
      const base = transcriptBasePath(baseDir, sessionIdRaw)
      const path = `${base}.${format}`
      const content = format === 'md' ? renderMarkdown(input, config) : format === 'json' ? renderJson(input) : renderHtml(input, config)
      const outputs = [{ path, content }]

      const manifestOn = args.manifest === true || config?.manifest === true
      const manifestPath = manifestOn ? `${base}.manifest.json` : undefined

      try {
        await atomicWriteFile(path, content)
        if (manifestPath !== undefined) {
          const manifest = buildSessionManifest({
            createdAt: input.generatedAt,
            session: log.session,
            scope: { entries: entries.length, errorsOnly: false, ...(since !== undefined ? { since } : {}), full: false },
            mask: { mode: maskMode },
            outputs,
          })
          await atomicWriteFile(manifestPath, renderManifest(manifest))
        }
      } catch (error) {
        return exportError(sessionIdRaw, format, `failed to write transcript: ${error instanceof Error ? error.message : String(error)}`)
      }

      return {
        sessionId: sessionIdRaw,
        format,
        written: [path],
        manifest: manifestPath ?? null,
        messages: totals.messages,
        toolCalls: totals.toolCalls,
        tokens: totals.inputTokens + totals.outputTokens,
        maskMode,
        error: null,
      }
    },
  })
}
