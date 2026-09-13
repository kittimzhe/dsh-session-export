/**
 * Single-file HTML report renderer — pure function over {@link RenderInput}.
 *
 * Zero external dependencies: one document with embedded CSS and a few lines
 * of inline script (theme toggle + print expansion). Sections: KPI cards,
 * turn timeline, tool ranking, error-highlighted transcript, print-friendly.
 *
 * @module dsh-session-export/render/html
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { RenderInput } from '../types.ts'
import { asAssistant, asToolResult } from '../types.ts'
import { formatDuration } from '../stats.ts'
import { parseToolArguments, renderToolDiff } from './diff.ts'
import { truncate } from '../util/truncate.ts'

export interface HtmlRenderOptions {
  readonly argCharLimit: number
  readonly resultCharLimit: number
}

export const defaultHtmlOptions: HtmlRenderOptions = {
  argCharLimit: 512,
  resultCharLimit: 2048,
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function fmtTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function id8(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8)
}

/** KPI card row: the six numbers that describe the session. */
function renderKpiGrid(input: RenderInput): string {
  const stats = input.stats
  const cards: Array<[string, string, string?]> = [
    ['Messages', String(input.totals.messages)],
    ['Tool calls', String(input.totals.toolCalls), stats && stats.failedToolCalls > 0 ? `${stats.failedToolCalls} failed` : undefined],
    ['Tokens in', fmtTokens(input.totals.inputTokens)],
    ['Tokens out', fmtTokens(input.totals.outputTokens)],
    [
      'Duration',
      stats?.durationMs !== undefined && stats.durationMs !== null ? formatDuration(stats.durationMs) : '—',
    ],
    ['Turns', stats !== undefined ? String(stats.turns) : '—'],
  ]
  const cost = stats?.cost
  if (cost !== undefined) {
    cards.push([
      'Cost ≈',
      `${cost.currency}${cost.total >= 0.01 ? cost.total.toFixed(2) : cost.total.toFixed(4)}`,
    ])
  }
  const spark = stats !== undefined ? renderSparklineSvg(stats.perAssistantTokens) : ''
  return [
    '<section class="kpi-grid">',
    ...cards.map(
      ([label, value, note]) =>
        `<div class="kpi"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${escapeHtml(value)}${
          note !== undefined ? ` <span class="kpi-note">${escapeHtml(note)}</span>` : ''
        }</div></div>`,
    ),
    spark !== '' ? `<div class="kpi kpi-wide"><div class="kpi-label">Output tokens per assistant message</div>${spark}</div>` : '',
    '</section>',
  ].join('\n')
}

/** Inline SVG bar sparkline (V10): no JS, scales to card width. */
function renderSparklineSvg(series: readonly number[]): string {
  if (series.length < 2) return ''
  const max = Math.max(...series)
  const W = 320
  const H = 40
  const gap = 2
  const barWidth = Math.max(1, (W - gap * (series.length - 1)) / series.length)
  const bars = series
    .map((value, index) => {
      const h = max === 0 ? 1 : Math.max(1, (value / max) * (H - 2))
      const x = index * (barWidth + gap)
      const y = H - h
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`
    })
    .join('')
  return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="output tokens per assistant message">${bars}</svg>`
}

/** Turn timeline (V3): one horizontal bar per user→next-user span, colored by duration share. */
function renderTimeline(input: RenderInput): string {
  const entries = input.entries
  const starts = entries.filter((entry) => entry.message.role === 'user' && entry.message.source.kind !== 'tool')
  const durationMs = input.stats?.durationMs
  if (starts.length < 2 || durationMs === undefined || durationMs === null) return ''
  const totalMs = durationMs
  const rows = starts.map((start, index) => {
    const end = starts[index + 1]?.time ?? entries[entries.length - 1]?.time ?? start.time
    const ms = Math.max(0, end - start.time)
    const pct = totalMs === 0 ? 0 : (ms / totalMs) * 100
    const hue = 200 - Math.min(160, (pct / 100) * 160)
    return `<div class="tl-row"><span class="tl-label">Turn ${index + 1}</span><div class="tl-track"><div class="tl-bar" style="width:${pct.toFixed(1)}%;background:hsl(${hue.toFixed(0)},65%,50%)"></div></div><span class="tl-dur">${escapeHtml(formatDuration(ms))}</span></div>`
  })
  return `<section class="card"><h2>Turn timeline</h2>${rows.join('')}</section>`
}

/** Tool ranking bars (V4). */
function renderToolRanking(input: RenderInput): string {
  const breakdown = input.stats?.toolBreakdown ?? []
  if (breakdown.length === 0) return ''
  const max = breakdown[0]?.calls ?? 1
  const rows = breakdown.slice(0, 8).map((tool) => {
    const pct = (tool.calls / max) * 100
    const fail = tool.failures > 0 ? ` <span class="fail">${tool.failures}✗</span>` : ''
    return `<div class="tool-row"><span class="tool-name" title="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</span><div class="tool-track"><div class="tool-bar" style="width:${pct.toFixed(1)}%"></div></div><span class="tool-count">${tool.calls}${fail}</span></div>`
  })
  return `<section class="card"><h2>Tool calls</h2>${rows.join('')}</section>`
}

function renderBlocks(blocks: readonly ContentBlock[], options: HtmlRenderOptions): string[] {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'reasoning') {
      parts.push(
        `<details class="reasoning"><summary>Reasoning</summary><pre>${escapeHtml(block.text.trim())}</pre></details>`,
      )
    } else if (block.type === 'text') {
      parts.push(`<div class="msg-text">${escapeHtml(block.text.trim())}</div>`)
    } else if (block.type === 'tool-call') {
      const parsed = parseToolArguments(block.arguments)
      const diff = renderToolDiff(block.name, parsed)
      if (diff) {
        parts.push(
          `<details class="tool"><summary>🔧 ${escapeHtml(block.name)}</summary><pre class="diff">${escapeHtml(truncate(diff, options.resultCharLimit))}</pre></details>`,
        )
      } else {
        parts.push(
          `<details class="tool"><summary>🔧 ${escapeHtml(block.name)}</summary><pre><code>${escapeHtml(truncate(block.arguments, options.argCharLimit))}</code></pre></details>`,
        )
      }
    } else if ('content' in block) {
      const inner = block.content
        .map((inner2) => (inner2.type === 'text' ? inner2.text : `(${JSON.stringify(inner2.type)})`))
        .join('\n')
      parts.push(
        `<details class="tool-result"${block.isError === true ? ' open' : ''}><summary>🧾 result</summary><pre>${escapeHtml(truncate(inner, options.resultCharLimit))}</pre></details>`,
      )
    } else {
      parts.push(`<div class="unsupported">(${escapeHtml(JSON.stringify(block.type))})</div>`)
    }
  }
  return parts
}

function renderEntry(entry: RenderInput['entries'][number], options: HtmlRenderOptions): string {
  const time = escapeHtml(fmtTime(entry.time))
  const message = entry.message
  // Order matches buildEntries: assistant, then tool-result, then user —
  // tool-result messages carry role 'user' with a tool source.
  if (message.role === 'assistant') {
    const assistant = asAssistant(message)
    const provenance = assistant !== undefined ? `${assistant.source.provider} / ${assistant.source.model}` : ''
    const usage =
      entry.usage !== undefined
        ? ` · ${fmtTokens(entry.usage.inputTokens)} in / ${fmtTokens(entry.usage.outputTokens)} out`
        : ''
    const body = renderBlocks(message.content, options).join('\n')
    return `<article class="entry assistant"><header>🤖 Assistant <span class="prov">${escapeHtml(provenance)}${escapeHtml(usage)}</span> <time>${time}</time></header>${body}</article>`
  }
  const toolResult = asToolResult(message)
  if (toolResult !== undefined) {
    const isError = entry.error !== undefined || toolResult.content.some((block) => block.isError === true)
    const errorLine =
      entry.error !== undefined
        ? `<div class="error-banner">Tool failed: <code>${escapeHtml(entry.error.name)}</code> (<code>${escapeHtml(entry.error.code)}</code>)</div>`
        : ''
    const body = renderBlocks(toolResult.content, options).join('\n')
    return `<article class="entry tool-result${isError ? ' error' : ''}"><header>🧾 Tool result <code>${escapeHtml(id8(String(toolResult.source.callId)))}</code>${isError ? ' <span class="fail">⚠ ERROR</span>' : ''} <time>${time}</time></header>${errorLine}${body}</article>`
  }
  const body = renderBlocks(message.content, options).join('\n')
  return `<article class="entry user"><header>👤 User <time>${time}</time></header>${body}</article>`
}

function renderFilterNote(input: RenderInput): string {
  if (input.filterNote === undefined) return ''
  return `<div class="filter-note">⚠ ${escapeHtml(input.filterNote)}</div>`
}

const CSS = `
:root{color-scheme:light;--bg:#f6f7f9;--card:#fff;--ink:#1a1d21;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--fail:#dc2626;--bar:#93c5fd}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#111317;--card:#1a1d23;--ink:#e5e7eb;--muted:#9ca3af;--line:#2a2e35;--accent:#60a5fa;--fail:#f87171;--bar:#3b82f6}}
[data-theme=dark]{color-scheme:dark;--bg:#111317;--card:#1a1d23;--ink:#e5e7eb;--muted:#9ca3af;--line:#2a2e35;--accent:#60a5fa;--fail:#f87171;--bar:#3b82f6}
*{box-sizing:border-box}
body{margin:0 auto;max-width:960px;padding:24px 20px 64px;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
h1{font-size:22px;margin:0 0 2px}
h2{font-size:15px;margin:0 0 12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.meta{color:var(--muted);font-size:13px;margin-bottom:18px}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:18px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.kpi-value{font-size:22px;font-weight:700;margin-top:2px}
.kpi-note{font-size:12px;color:var(--fail);font-weight:400}
.kpi-wide{grid-column:1/-1}
.sparkline{width:100%;height:40px;margin-top:8px;fill:var(--accent);opacity:.75}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:14px 0}
.tl-row,.tool-row{display:flex;align-items:center;gap:10px;margin:6px 0}
.tl-label,.tool-name{width:110px;flex:none;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl-track,.tool-track{flex:1;height:12px;background:var(--line);border-radius:6px;overflow:hidden}
.tl-bar,.tool-bar{height:100%;border-radius:6px}
.tool-bar{background:var(--accent);opacity:.8}
.tl-dur,.tool-count{width:86px;flex:none;text-align:right;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.fail{color:var(--fail);font-weight:700}
.entry{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0}
.entry.user{border-left-color:#10b981}
.entry.assistant{border-left-color:var(--accent)}
.entry.tool-result{border-left-color:var(--bar)}
.entry.error{border-left-color:var(--fail);border-color:var(--fail)}
.entry header{font-size:12px;color:var(--muted);margin-bottom:6px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.entry time{margin-left:auto;font-variant-numeric:tabular-nums}
.prov{font-style:italic}
.msg-text{white-space:pre-wrap}
pre{background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;overflow-x:auto;font-size:12.5px;line-height:1.5}
pre.diff{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
details{margin:6px 0}
summary{cursor:pointer;font-size:13px;color:var(--muted)}
details[open] summary{color:var(--ink)}
.error-banner{background:rgba(220,38,38,.1);border:1px solid var(--fail);color:var(--fail);border-radius:8px;padding:8px 12px;margin:6px 0;font-size:13px}
.filter-note{background:rgba(217,119,6,.12);border:1px solid #d97706;color:#b45309;border-radius:8px;padding:8px 12px;margin:12px 0;font-size:13px}
footer{margin-top:28px;color:var(--muted);font-size:12px}
.theme-toggle{position:fixed;top:14px;right:16px;z-index:9;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px}
[data-theme=light]{color-scheme:light}
[data-theme=dark]{color-scheme:dark}
@media print{.theme-toggle{display:none}body{background:#fff;color:#000;max-width:100%}.entry,.card,.kpi{break-inside:avoid;border-color:#bbb}pre{background:#f3f4f6}}
`

/** Render the complete single-file HTML report. */
export function renderHtml(input: RenderInput, options?: Partial<HtmlRenderOptions>): string {
  const opts = { ...defaultHtmlOptions, ...options }
  const h = input.header
  const entries = input.entries.map((entry) => renderEntry(entry, opts)).join('\n')
  const title = `DSH session ${id8(h.id)} — transcript`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<button class="theme-toggle" type="button" aria-label="Toggle color theme">◐ theme</button>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${escapeHtml(h.cwd ?? '')} · created ${escapeHtml(h.createdAt ? fmtTime(h.createdAt) : '?')}${h.agentPreset !== undefined ? ` · ${escapeHtml(h.agentPreset)}` : ''}</div>
${renderFilterNote(input)}
${renderKpiGrid(input)}
${renderTimeline(input)}
${renderToolRanking(input)}
<section class="card"><h2>Transcript</h2>
${entries}
</section>
<footer>Generated by ${escapeHtml(input.generator)} at ${escapeHtml(fmtTime(input.generatedAt))} — print to PDF for archival copies.</footer>
<script>
(function(){
  var b=document.querySelector('.theme-toggle');
  var saved=null;try{saved=localStorage.getItem('dsh-theme')}catch(e){}
  if(saved){document.documentElement.dataset.theme=saved}
  b.addEventListener('click',function(){
    var cur=document.documentElement.dataset.theme||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
    var next=cur==='dark'?'light':'dark';
    document.documentElement.dataset.theme=next;
    try{localStorage.setItem('dsh-theme',next)}catch(e){}
  });
  window.addEventListener('beforeprint',function(){
    var d=document.querySelectorAll('details');for(var i=0;i<d.length;i++){d[i].open=true}
  });
})();
</script>
</body>
</html>
`
}
