/**
 * Markdown transcript renderer — pure function over {@link RenderInput}.
 *
 * Design note (from @deepseek-ai/dsh-session/surface): the model-visible
 * surface deliberately shadows replaced ranges, so it is the WRONG source for
 * a human transcript. This plugin renders append-origin surface events —
 * everything the user actually saw, including ranges later compacted away.
 */
import type {
  AssistantMessage,
  ContentBlock,
  ToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import type { RenderInput, LineageNode } from '../types.ts'
import { asAssistant, asToolResult } from '../types.ts'
import { parseToolArguments, renderToolDiff } from './diff.ts'
import { truncate } from '../util/truncate.ts'

export interface MarkdownRenderOptions {
  readonly argCharLimit: number
  readonly resultCharLimit: number
}

export const defaultMarkdownOptions: MarkdownRenderOptions = {
  argCharLimit: 512,
  resultCharLimit: 2048,
}

function fmtTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

function id8(id: string): string {
  return id.slice(0, 8)
}

function renderHeaderBlock(input: RenderInput): string {
  const h = input.header
  const rows: Array<[string, string]> = [
    ['Session', `\`${h.id}\``],
    ['Project', h.cwd ?? '(no cwd)'],
    ['Created', h.createdAt ? fmtTime(h.createdAt) : '(unknown)'],
  ]
  if (h.agentPreset) rows.push(['Agent preset', h.agentPreset])
  rows.push(['Messages', String(input.totals.messages)])
  rows.push(['Tool calls', String(input.totals.toolCalls)])
  rows.push([
    'Tokens (in/out)',
    `${input.totals.inputTokens.toLocaleString('en-US')} / ${input.totals.outputTokens.toLocaleString('en-US')}`,
  ])
  rows.push(['Exported', fmtTime(input.generatedAt)])
  rows.push(['Generator', input.generator])
  const table = rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')
  return ['# DSH Session Transcript', '', '| Key | Value |', '|---|---|', table, ''].join('\n')
}

function renderLineageNode(node: LineageNode, depth: number): string[] {
  const origin = node.origin ? ` (${node.origin})` : ''
  const line = `${'  '.repeat(depth)}- \`${id8(node.id)}\`${origin} — created ${fmtTime(node.createdAt)}`
  return [line, ...node.children.flatMap((child) => renderLineageNode(child, depth + 1))]
}

function renderLineage(input: RenderInput): string | null {
  const lineage = input.lineage
  if (!lineage) return null
  if (lineage.ancestors.length === 0 && lineage.descendants.length === 0) return null
  const parts: string[] = ['## Lineage', '']
  if (lineage.ancestors.length > 0) {
    parts.push('Ancestors (root → this session):')
    parts.push('')
    const chain = lineage.ancestors
      .map((a) => `\`${id8(a.id)}\``)
      .concat('**this session**')
      .join(' → ')
    parts.push(chain, '')
  }
  if (lineage.descendants.length > 0) {
    parts.push('Subagent descendants:')
    parts.push('')
    for (const node of lineage.descendants) {
      parts.push(...renderLineageNode(node, 0))
    }
    parts.push('')
  }
  return parts.join('\n')
}

function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``
}

function renderAssistantMessage(
  message: AssistantMessage,
  options: MarkdownRenderOptions,
  usageNote?: string,
): string[] {
  const parts: string[] = ['### 🤖 Assistant', '']
  const provenance = `*${message.source.provider} / ${message.source.model}*`
  parts.push(usageNote ? `${provenance} — ${usageNote}` : provenance, '')
  for (const block of message.content) {
    if (block.type === 'reasoning') {
      parts.push(
        '<details>',
        '<summary>Reasoning</summary>',
        '',
        block.text.trim(),
        '',
        '</details>',
        '',
      )
    } else if (block.type === 'text') {
      parts.push(block.text.trim(), '')
    } else if (block.type === 'tool-call') {
      parts.push(`#### 🔧 Tool Call — \`${block.name}\``, '')
      const parsed = parseToolArguments(block.arguments)
      const diff = renderToolDiff(block.name, parsed)
      if (diff) {
        parts.push(fence('diff', truncate(diff, options.resultCharLimit)), '')
      } else {
        parts.push('**arguments**:', '', fence('json', truncate(block.arguments, options.argCharLimit)), '')
      }
    }
    // Unknown block kinds (merge-extensible union) render as an opaque note.
    else {
      parts.push(`> *(unsupported content block: ${JSON.stringify((block as ContentBlock).type)})*`, '')
    }
  }
  return parts
}

function renderToolResult(
  message: ToolResultMessage,
  options: MarkdownRenderOptions,
  error?: { name: string; code: string },
): string[] {
  const parts: string[] = [
    `### 🧾 Tool Result — call \`${id8(String(message.source.callId))}\`${error ? ' ⚠️ ERROR' : ''}`,
    '',
  ]
  if (error) {
    parts.push(`> Tool failed: \`${error.name}\` (\`${error.code}\`)`, '')
  }
  for (const block of message.content) {
    const inner = block.content
      .map((b) => (b.type === 'text' ? b.text : `*(block: ${JSON.stringify(b.type)})*`))
      .join('\n')
    parts.push(fence('text', truncate(inner, options.resultCharLimit)), '')
    if (block.isError) parts.push('> ⚠️ result flagged as error', '')
  }
  return parts
}

function renderEntry(entry: RenderInput['entries'][number], options: MarkdownRenderOptions): string[] {
  const assistant = asAssistant(entry.message)
  if (assistant) {
    const usageNote = entry.usage
      ? `tokens: ${entry.usage.inputTokens.toLocaleString('en-US')} in / ${entry.usage.outputTokens.toLocaleString('en-US')} out`
      : undefined
    return renderAssistantMessage(assistant, options, usageNote)
  }
  const toolResult = asToolResult(entry.message)
  if (toolResult) return renderToolResult(toolResult, options, entry.error)
  if (entry.message.role === 'user') {
    const parts: string[] = ['### 👤 User', '']
    for (const block of entry.message.content) {
      if (block.type === 'text') {
        parts.push(block.text.trim(), '')
      } else {
        parts.push(`> *(block: ${JSON.stringify((block as ContentBlock).type)})*`, '')
      }
    }
    return parts
  }
  return [`> *(unsupported message role: ${JSON.stringify(entry.message.role)})*`, '']
}

function renderLogOnly(input: RenderInput): string | null {
  if (!input.logOnly || input.logOnly.length === 0) return null
  const parts: string[] = ['## Log-only Events', '', 'Events that never joined the model surface (command lifecycles, compaction markers, …).', '']
  for (const line of input.logOnly) {
    const summary = line.summary ? ` — ${line.summary}` : ''
    parts.push(`- \`${line.seq}\` · ${fmtTime(line.time)} · \`${line.type}\`${summary}`)
  }
  parts.push('')
  return parts.join('\n')
}

/** Render the complete Markdown transcript. */
export function renderMarkdown(input: RenderInput, options?: Partial<MarkdownRenderOptions>): string {
  const opts = { ...defaultMarkdownOptions, ...options }
  const sections: Array<string | null> = [
    renderHeaderBlock(input),
    renderLineage(input),
    ['## Transcript', ''].join('\n'),
    input.entries.map((entry) => renderEntry(entry, opts).join('\n')).join('\n'),
    renderLogOnly(input),
  ]
  const doc = sections
    .filter((section): section is string => section !== null)
    .join('\n')
  return `${doc.trimEnd()}\n`
}
