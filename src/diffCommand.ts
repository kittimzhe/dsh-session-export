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

/** Change classification for one divergent region. */
export type ChangeKind = 'added' | 'removed' | 'changed'

/** One classified divergence block between the two sessions. */
export interface ChangeBlock {
  readonly kind: ChangeKind
  /** Index range in A's entries (changed: the A side; removed: the A-only run). */
  readonly rangeA: readonly [number, number]
  /** Index range in B's entries (changed: the B side; added: the B-only run). */
  readonly rangeB: readonly [number, number]
  readonly entriesA: readonly TranscriptEntry[]
  readonly entriesB: readonly TranscriptEntry[]
}

export interface DiffResult {
  sessionA: { id: string; createdAt: number; cwd?: string }
  sessionB: { id: string; createdAt: number; cwd?: string }
  totalA: number
  totalB: number
  commonPrefixLen: number
  commonSuffixLen: number
  tailA: TranscriptEntry[]
  tailB: TranscriptEntry[]
  totals: DiffTotals
  /** Classified divergence blocks (middle region only), in log order. */
  changes: readonly ChangeBlock[]
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
): { commonPrefixLen: number; commonSuffixLen: number; tailA: TranscriptEntry[]; tailB: TranscriptEntry[]; changes: ChangeBlock[] } {
  let commonPrefixLen = 0
  const minLen = Math.min(entriesA.length, entriesB.length)
  for (let k = 0; k < minLen; k += 1) {
    if (entryFingerprint(entriesA[k]!) !== entryFingerprint(entriesB[k]!)) break
    commonPrefixLen += 1
  }
  // Common suffix: walk backwards from both ends, without crossing the prefix.
  let commonSuffixLen = 0
  while (
    commonSuffixLen < entriesA.length - commonPrefixLen &&
    commonSuffixLen < entriesB.length - commonPrefixLen &&
    entryFingerprint(entriesA[entriesA.length - 1 - commonSuffixLen]!) ===
      entryFingerprint(entriesB[entriesB.length - 1 - commonSuffixLen]!)
  ) {
    commonSuffixLen += 1
  }
  const midA = entriesA.slice(commonPrefixLen, entriesA.length - commonSuffixLen)
  const midB = entriesB.slice(commonPrefixLen, entriesB.length - commonSuffixLen)

  return {
    commonPrefixLen,
    commonSuffixLen,
    tailA: entriesA.slice(commonPrefixLen),
    tailB: entriesB.slice(commonPrefixLen),
    changes: classifyChanges(midA, midB, commonPrefixLen),
  }
}

/**
 * Classify the divergent middle region into added / removed / changed blocks.
 *
 * A simple alternating-run heuristic: identical entries align the cursor;
 * a run present on one side only is added/removed; simultaneous divergent
 * runs on both sides pair up as one "changed" block.
 */
function classifyChanges(midA: readonly TranscriptEntry[], midB: readonly TranscriptEntry[], prefixLen: number): ChangeBlock[] {
  const blocks: ChangeBlock[] = []
  let ia = 0
  let ib = 0
  while (ia < midA.length || ib < midB.length) {
    // advance over matching entries
    if (ia < midA.length && ib < midB.length && entryFingerprint(midA[ia]!) === entryFingerprint(midB[ib]!)) {
      ia += 1
      ib += 1
      continue
    }
    // find the next re-alignment point
    const startA = ia
    const startB = ib
    let runA = 0
    while (ia + runA < midA.length && (ib >= midB.length || entryFingerprint(midA[ia + runA]!) !== entryFingerprint(midB[ib]!))) runA += 1
    let runB = 0
    while (ib + runB < midB.length && (ia + runA >= midA.length || entryFingerprint(midB[ib + runB]!) !== entryFingerprint(midA[ia + runA - 1] ?? midA[startA]!))) runB += 1
    // simpler fallback: single-side runs
    if (runA === 0 && runB === 0) break
    if (runA > 0 && runB === 0) {
      blocks.push({ kind: 'removed', rangeA: [prefixLen + startA, prefixLen + startA + runA - 1], rangeB: [prefixLen + startB - 1, prefixLen + startB - 1], entriesA: midA.slice(startA, startA + runA), entriesB: [] })
      ia += runA
    } else if (runA === 0 && runB > 0) {
      blocks.push({ kind: 'added', rangeA: [prefixLen + startA - 1, prefixLen + startA - 1], rangeB: [prefixLen + startB, prefixLen + startB + runB - 1], entriesA: [], entriesB: midB.slice(startB, startB + runB) })
      ib += runB
    } else {
      blocks.push({ kind: 'changed', rangeA: [prefixLen + startA, prefixLen + startA + runA - 1], rangeB: [prefixLen + startB, prefixLen + startB + runB - 1], entriesA: midA.slice(startA, startA + runA), entriesB: midB.slice(startB, startB + runB) })
      ia += runA
      ib += runB
    }
  }
  return blocks
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
    `Entries:  A=${totalA}  B=${totalB}  common-prefix=${commonPrefixLen}  common-suffix=${result.commonSuffixLen}`,
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

  let changeSection = ''
  if (result.changes.length > 0) {
    changeSection += '\n\n--- Changes (middle region, classified) ---\n'
    for (let i = 0; i < Math.min(result.changes.length, 20); i += 1) {
      const c = result.changes[i]!
      const icon = c.kind === 'added' ? '＋' : c.kind === 'removed' ? '－' : '±'
      const label = c.kind === 'added' ? `B[${c.rangeB[0]}..${c.rangeB[1]}]` : c.kind === 'removed' ? `A[${c.rangeA[0]}..${c.rangeA[1]}]` : `A[${c.rangeA[0]}..${c.rangeA[1]}]↔B[${c.rangeB[0]}..${c.rangeB[1]}]`
      changeSection += `  ${icon} ${c.kind.padEnd(8)} ${label}  (${String(c.entriesA.length)}A/${String(c.entriesB.length)}B entries)\n`
    }
    if (result.changes.length > 20) changeSection += `  … and ${result.changes.length - 20} more\n`
  }

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

  return header + stats + changeSection + tailSection
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
    commonSuffixLen: diff.commonSuffixLen,
    tailA: diff.tailA,
    tailB: diff.tailB,
    changes: diff.changes,
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

  const kindBadge = (k: ChangeKind): string => k === 'added' ? '<span class="badge added">＋ added</span>' : k === 'removed' ? '<span class="badge removed">－ removed</span>' : '<span class="badge changed">± changed</span>'
  const changesSection = result.changes.length > 0
    ? `<h2>Changes (${result.changes.length} block${result.changes.length === 1 ? '' : 's'})</h2>\n` + result.changes.slice(0, 30).map((c) =>
        `<div class="change-block">${kindBadge(c.kind)} <span class="range">A[${c.rangeA[0]}..${c.rangeA[1]}] ↔ B[${c.rangeB[0]}..${c.rangeB[1]}]</span>\n${
          c.entriesA.length > 0 ? `<div class="change-side">A:</div>${c.entriesA.slice(0, 10).map((e) => entryHtml(e, 'a')).join('')}` : ''
        }${
          c.entriesB.length > 0 ? `<div class="change-side">B:</div>${c.entriesB.slice(0, 10).map((e) => entryHtml(e, 'b')).join('')}` : ''
        }</div>`
      ).join('\n') + (result.changes.length > 30 ? `<p class="more">… and ${result.changes.length - 30} more blocks</p>` : '')
    : ''

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
  .change-block { background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 0.75rem; margin-bottom: 0.75rem; }
  .badge { font-size: 0.75rem; font-weight: 600; padding: 0.125rem 0.375rem; border-radius: 4px; margin-right: 0.5rem; }
  .badge.added { background: #dcfce7; color: #15803d; }
  .badge.removed { background: #fee2e2; color: #b91c1c; }
  .badge.changed { background: #fef9c3; color: #a16207; }
  .range { font-size: 0.8rem; color: #666; }
  .change-side { font-size: 0.75rem; font-weight: 600; color: #888; margin: 0.375rem 0 0.25rem; }
  .change-block .entry { margin-top: 0.25rem; }
  .more { color: #999; font-size: 0.8rem; }
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
    <tr><td>Common suffix</td><td colspan="2">${result.commonSuffixLen}</td><td></td></tr>
    <tr><td>Messages</td><td>${result.totals.a.messages}</td><td>${result.totals.b.messages}</td><td class="${result.totals.delta.messages !== 0 ? (result.totals.delta.messages > 0 ? 'delta-pos' : 'delta-neg') : ''}">${formatDelta(result.totals.delta.messages)}</td></tr>
    <tr><td>Tool calls</td><td>${result.totals.a.toolCalls}</td><td>${result.totals.b.toolCalls}</td><td class="${result.totals.delta.toolCalls !== 0 ? (result.totals.delta.toolCalls > 0 ? 'delta-pos' : 'delta-neg') : ''}">${formatDelta(result.totals.delta.toolCalls)}</td></tr>
    <tr><td>Input tokens</td><td>${result.totals.a.inputTokens.toLocaleString()}</td><td>${result.totals.b.inputTokens.toLocaleString()}</td><td>${formatDelta(result.totals.delta.inputTokens)}</td></tr>
    <tr><td>Output tokens</td><td>${result.totals.a.outputTokens.toLocaleString()}</td><td>${result.totals.b.outputTokens.toLocaleString()}</td><td>${formatDelta(result.totals.delta.outputTokens)}</td></tr>
  </table>
</div>
${changesSection}
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