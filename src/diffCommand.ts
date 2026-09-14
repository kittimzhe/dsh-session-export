/**
 * `/diff` — compare two sessions and generate a structured delta report.
 *
 * Finds the longest common prefix (LCP) by entry-level content hashing,
 * then reports what diverged: metadata delta, stats delta, and tails
 * unique to each session. Terminal output is the default; `--html`
 * writes a styled single-file HTML report.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { buildEntries, buildTotals, GENERATOR } from './command.ts'
import type { TranscriptConfig } from './command.ts'
import type { TranscriptEntry, TranscriptTotals } from './types.ts'
import { computeStats } from './stats.ts'
import { renderHtml } from './render/html.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface DiffArgs {
  sessionIdA: string
  sessionIdB: string
  html: boolean
  outPath?: string
}

export interface DiffTotals {
  a: TranscriptTotals
  b: TranscriptTotals
  delta: { messages: number; toolCalls: number; inputTokens: number; outputTokens: number }
}

export interface DiffResult {
  sessionA: { id: string; createdAt: number; cwd?: string }
  sessionB: { id: string; createdAt: number; cwd?: string }
  totalA: number
  totalB: number
  commonPrefixLen: number
  tailA: TranscriptEntry[]
  tailB: TranscriptEntry[]
  totals: DiffTotals
}

export const DIFF_USAGE = [
  'Usage: /diff <id1> <id2>',
  '       /diff --id <id1> --other <id2>',
  '',
  'Compare two sessions and show what diverged.',
  '',
  'Options:',
  '  --html    Write a styled single-file HTML diff report (terminal summary by default).',
  '  --out <path>   Write the HTML report to this path.',
].join('\n')

/** Parse `/diff` arguments. Returns a string on error. */
export function parseDiffArgs(rest: string): DiffArgs | string {
  const tokens = rest.trim().length === 0 ? [] : rest.trim().split(/\s+/)
  const positional: string[] = []
  const result: DiffArgs = { sessionIdA: '', sessionIdB: '', html: false, outPath: undefined }
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] as string
    if (token === undefined) break
    if (token === '--id') {
      const v = tokens[i + 1]
      if (v === undefined || v.startsWith('--')) return `--id requires a session id value.\n${DIFF_USAGE}`
      result.sessionIdA = v
      i += 2
      continue
    }
    if (token === '--other') {
      const v = tokens[i + 1]
      if (v === undefined || v.startsWith('--')) return `--other requires a session id value.\n${DIFF_USAGE}`
      result.sessionIdB = v
      i += 2
      continue
    }
    if (token === '--html') {
      result.html = true
      i += 1
      continue
    }
    if (token === '--out') {
      const rest = tokens.slice(i + 1).join(' ')
      if (rest.trim().length === 0) return `--out requires a path value.\n${DIFF_USAGE}`
      result.outPath = rest.trim()
      i = tokens.length
      continue
    }
    if (token.startsWith('--')) return `Unknown option: ${token}\n${DIFF_USAGE}`
    positional.push(token)
    i += 1
  }
  // Positional args fill sessionIdA, sessionIdB if not set by flags
  if (result.sessionIdA === '' && positional.length > 0) result.sessionIdA = positional.shift()!
  if (result.sessionIdB === '' && positional.length > 0) result.sessionIdB = positional.shift()!
  if (result.sessionIdA === '' || result.sessionIdB === '') return `Two session ids are required.\n${DIFF_USAGE}`
  return result
}

/** Extract the concatenated text from a transcript entry's content blocks. */
function extractText(entry: TranscriptEntry): string {
  return entry.message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
}

/** Create a stable content fingerprint for one entry — used for LCP matching. */
export function entryFingerprint(entry: TranscriptEntry): string {
  const text = entry.message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
  return `${entry.kind}:${entry.error !== undefined ? 'ERR' : ''}:${text}`
}

/** Compute the diff of two entry arrays. */
export function diffSessions(
  entriesA: readonly TranscriptEntry[],
  entriesB: readonly TranscriptEntry[],
): { commonPrefixLen: number; tailA: TranscriptEntry[]; tailB: TranscriptEntry[] } {
  let commonPrefixLen = 0
  const minLen = Math.min(entriesA.length, entriesB.length)
  for (let k = 0; k < minLen; k += 1) {
    if (entryFingerprint(entriesA[k]!) !== entryFingerprint(entriesB[k]!)) break
    commonPrefixLen += 1
  }
  return {
    commonPrefixLen,
    tailA: entriesA.slice(commonPrefixLen),
    tailB: entriesB.slice(commonPrefixLen),
  }
}

/** Render a compact terminal diff summary. */
export function renderTerminalDiff(result: DiffResult): string {
  const { sessionA, sessionB, commonPrefixLen, tailA, tailB, totalA, totalB, totals } = result

  const header = [
    '=== Session Diff ===',
    '',
    `A: ${sessionA.id}  (${new Date(sessionA.createdAt).toISOString()})${sessionA.cwd !== undefined ? `  cwd: ${sessionA.cwd}` : ''}`,
    `B: ${sessionB.id}  (${new Date(sessionB.createdAt).toISOString()})${sessionB.cwd !== undefined ? `  cwd: ${sessionB.cwd}` : ''}`,
    '',
    `Entries:  A=${totalA}  B=${totalB}  common=${commonPrefixLen}`,
    `Unique:   A=${tailA.length}  B=${tailB.length}`,
  ].join('\n')

  const stats = [
    '',
    '--- Stats Delta ---',
    `Messages:    A=${totals.a.messages}  B=${totals.b.messages}  Δ=${formatDelta(totals.delta.messages)}`,
    `Tool calls:  A=${totals.a.toolCalls}  B=${totals.b.toolCalls}  Δ=${formatDelta(totals.delta.toolCalls)}`,
    `Input tok:   A=${totals.a.inputTokens.toLocaleString()}  B=${totals.b.inputTokens.toLocaleString()}  Δ=${formatDelta(totals.delta.inputTokens)}`,
    `Output tok:  A=${totals.a.outputTokens.toLocaleString()}  B=${totals.b.outputTokens.toLocaleString()}  Δ=${formatDelta(totals.delta.outputTokens)}`,
  ].join('\n')

  let tailSection = ''
  if (tailA.length > 0) {
    tailSection += `\n\n--- A-only tail (${tailA.length} entries) ---\n`
    for (let i = 0; i < Math.min(tailA.length, 20); i += 1) {
      const entry = tailA[i]!
      const icon = entry.kind === 'assistant' ? '🤖' : entry.kind === 'tool-result' ? '🔧' : '👤'
      tailSection += `  ${icon} ${entry.kind} | ${extractText(entry).slice(0, 80)}${extractText(entry).length > 80 ? '…' : ''}\n`
    }
    if (tailA.length > 20) tailSection += `  … and ${tailA.length - 20} more\n`
  }
  if (tailB.length > 0) {
    tailSection += `\n--- B-only tail (${tailB.length} entries) ---\n`
    for (let i = 0; i < Math.min(tailB.length, 20); i += 1) {
      const entry = tailB[i]!
      const icon = entry.kind === 'assistant' ? '🤖' : entry.kind === 'tool-result' ? '🔧' : '👤'
      tailSection += `  ${icon} ${entry.kind} | ${extractText(entry).slice(0, 80)}${extractText(entry).length > 80 ? '…' : ''}\n`
    }
    if (tailB.length > 20) tailSection += `  … and ${tailB.length - 20} more\n`
  }

  return header + stats + tailSection
}

function formatDelta(n: number): string {
  if (n === 0) return '0'
  return n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString()
}

/** Execute `/diff` — read two sessions, compute diff, render. */
export async function executeDiff(
  ctx: Context,
  invocation: CommandInvocation,
  config?: TranscriptConfig,
): Promise<CommandResult> {
  const parsed = parseDiffArgs(invocation.rawInput)
  if (typeof parsed === 'string') return { kind: 'error', text: parsed }
  const args = parsed

  const sidA = SessionId(args.sessionIdA)
  const sidB = SessionId(args.sessionIdB)

  let logA: { session: SessionHeader; events: SessionEvent[] }
  let logB: { session: SessionHeader; events: SessionEvent[] }
  try {
    ;[logA, logB] = await Promise.all([ctx.sessionQuery.readSession(sidA), ctx.sessionQuery.readSession(sidB)])
  } catch (error) {
    return { kind: 'error', text: `Could not read sessions: ${error instanceof Error ? error.message : String(error)}` }
  }

  const entriesA = buildEntries(logA.events)
  const entriesB = buildEntries(logB.events)
  const diff = diffSessions(entriesA, entriesB)

  const totalsA = buildTotals(entriesA)
  const totalsB = buildTotals(entriesB)
  const statsA = computeStats(entriesA, config?.pricing)
  const statsB = computeStats(entriesB, config?.pricing)

  const result: DiffResult = {
    sessionA: { id: logA.session.id, createdAt: logA.session.createdAt, cwd: logA.session.cwd },
    sessionB: { id: logB.session.id, createdAt: logB.session.createdAt, cwd: logB.session.cwd },
    totalA: entriesA.length,
    totalB: entriesB.length,
    commonPrefixLen: diff.commonPrefixLen,
    tailA: diff.tailA,
    tailB: diff.tailB,
    totals: {
      a: totalsA,
      b: totalsB,
      delta: {
        messages: totalsB.messages - totalsA.messages,
        toolCalls: totalsB.toolCalls - totalsA.toolCalls,
        inputTokens: totalsB.inputTokens - totalsA.inputTokens,
        outputTokens: totalsB.outputTokens - totalsA.outputTokens,
      },
    },
  }

  if (args.html) {
    const html = renderDiffHtml(result, config)
    const outPath = args.outPath ?? `${logA.session.cwd ?? process.cwd()}/dsh-transcripts/diff-${Date.now()}.html`
    try {
      await mkdir(dirname(outPath), { recursive: true })
      await writeFile(outPath, html, 'utf8')
      return { kind: 'success', text: `Diff report written → ${outPath}` }
    } catch (error) {
      return { kind: 'error', text: `Failed to write diff report: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  return { kind: 'success', text: renderTerminalDiff(result) }
}

/** Build a minimal single-file HTML diff report using the shared HTML report CSS conventions. */
function renderDiffHtml(result: DiffResult, config?: TranscriptConfig): string {
  const tailA = result.tailA
  const tailB = result.tailB
  const commonLen = result.commonPrefixLen

  const entryHtml = (entry: TranscriptEntry, side: string): string => {
    const cls = entry.error !== undefined ? 'entry error' : 'entry'
    return `<div class="${cls} side-${side}"><span class="kind">${esc(entry.kind)}</span> <span class="time">${new Date(entry.time).toISOString()}</span><pre>${esc(extractText(entry))}</pre>${entry.error !== undefined ? `<div class="error-msg">${esc(entry.error.code)}</div>` : ''}</div>`
  }

  const tailAHtml = tailA.slice(0, 50).map((e) => entryHtml(e, 'a')).join('\n')
  const tailBHtml = tailB.slice(0, 50).map((e) => entryHtml(e, 'b')).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session Diff — A vs B</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 960px; margin: 0 auto; padding: 1rem; color: #1a1a1a; background: #fafafa; }
  header { margin-bottom: 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0; }
  .meta { color: #666; font-size: 0.875rem; margin-top: 0.25rem; }
  .summary { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; }
  .summary table { width: 100%; border-collapse: collapse; }
  .summary td, .summary th { padding: 0.375rem 0.5rem; font-size: 0.875rem; text-align: left; }
  .delta-pos { color: #16a34a; }
  .delta-neg { color: #dc2626; }
  h2 { font-size: 1rem; margin: 1.25rem 0 0.5rem; }
  .entry { background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 0.75rem; margin-bottom: 0.5rem; }
  .entry.error { border-color: #fca5a5; background: #fef2f2; }
  .entry.side-a { border-left: 3px solid #3b82f6; }
  .entry.side-b { border-left: 3px solid #ef4444; }
  .kind { font-weight: 600; font-size: 0.8rem; color: #888; text-transform: uppercase; }
  .time { font-size: 0.75rem; color: #999; margin-left: 0.5rem; }
  pre { margin: 0.25rem 0 0; white-space: pre-wrap; font-size: 0.875rem; }
  .error-msg { color: #dc2626; font-size: 0.8rem; margin-top: 0.25rem; }
</style>
</head>
<body>
<header>
  <h1>Session Diff</h1>
  <div class="meta">${esc(result.sessionA.id)} vs ${esc(result.sessionB.id)}</div>
</header>
<div class="summary">
  <table>
    <tr><th></th><th>A</th><th>B</th><th>Δ</th></tr>
    <tr><td>Entries</td><td>${result.totalA}</td><td>${result.totalB}</td><td class="${result.totalB !== result.totalA ? 'delta-pos' : ''}">${result.totalB - result.totalA > 0 ? '+' : ''}${result.totalB - result.totalA}</td></tr>
    <tr><td>Common prefix</td><td colspan="2">${commonLen}</td><td></td></tr>
    <tr><td>Messages</td><td>${result.totals.a.messages}</td><td>${result.totals.b.messages}</td><td class="${result.totals.delta.messages !== 0 ? (result.totals.delta.messages > 0 ? 'delta-pos' : 'delta-neg') : ''}">${formatDelta(result.totals.delta.messages)}</td></tr>
    <tr><td>Tool calls</td><td>${result.totals.a.toolCalls}</td><td>${result.totals.b.toolCalls}</td><td class="${result.totals.delta.toolCalls !== 0 ? (result.totals.delta.toolCalls > 0 ? 'delta-pos' : 'delta-neg') : ''}">${formatDelta(result.totals.delta.toolCalls)}</td></tr>
    <tr><td>Input tokens</td><td>${result.totals.a.inputTokens.toLocaleString()}</td><td>${result.totals.b.inputTokens.toLocaleString()}</td><td>${formatDelta(result.totals.delta.inputTokens)}</td></tr>
    <tr><td>Output tokens</td><td>${result.totals.a.outputTokens.toLocaleString()}</td><td>${result.totals.b.outputTokens.toLocaleString()}</td><td>${formatDelta(result.totals.delta.outputTokens)}</td></tr>
  </table>
</div>
${tailA.length > 0 ? `<h2>Only in A (${tailA.length} entries${tailA.length > 50 ? ', showing first 50' : ''})</h2>\n${tailAHtml}` : ''}
${tailB.length > 0 ? `<h2>Only in B (${tailB.length} entries${tailB.length > 50 ? ', showing first 50' : ''})</h2>\n${tailBHtml}` : ''}
${commonLen === result.totalA && commonLen === result.totalB ? '<p style="color:#16a34a">✅ Sessions are identical.</p>' : ''}
<p style="color:#999;font-size:0.75rem;margin-top:2rem">generated by ${GENERATOR}</p>
</body>
</html>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}