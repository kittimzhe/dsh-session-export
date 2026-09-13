import { describe, expect, it } from 'vitest'
import { renderHtml } from '../src/render/html.ts'
import { computeStats } from '../src/stats.ts'
import type { RenderInput, TranscriptEntry } from '../src/types.ts'

const base = 1_700_000_000_000

function entry(seq: number, time: number, message: TranscriptEntry['message'], usage?: TranscriptEntry['usage'], error?: TranscriptEntry['error']): TranscriptEntry {
  return { seq, time, kind: 'user', message, ...(usage !== undefined ? { usage } : {}), ...(error !== undefined ? { error } : {}) }
}

function buildInput(overrides?: Partial<RenderInput>): RenderInput {
  const entries: TranscriptEntry[] = [
    entry(1, base, { id: 'm1' as never, role: 'user', source: { kind: 'user' } as never, content: [{ type: 'text', text: 'hello <script>alert(1)</script>' }] }),
    entry(2, base + 1000, {
      id: 'm2' as never,
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'v3' } as never,
      content: [
        { type: 'reasoning', text: 'thinking about & <angles>' },
        { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{"cmd":"ls"}' },
      ],
    }, { inputTokens: 120, outputTokens: 80 } as never),
    entry(3, base + 2000, {
      id: 'm3' as never,
      role: 'user',
      source: { kind: 'tool', callId: 'c1' as never } as never,
      content: [{ type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: 'file-a\nfile-b' }] }],
    }),
    entry(4, base + 90_000, { id: 'm4' as never, role: 'user', source: { kind: 'user' } as never, content: [{ type: 'text', text: 'again' }] }),
    entry(5, base + 95_000, {
      id: 'm5' as never,
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'v3' } as never,
      content: [{ type: 'tool-call', id: 'c2' as never, name: 'read', arguments: '{"path":"/x"}' }],
    }),
    entry(6, base + 96_000, {
      id: 'm6' as never,
      role: 'user',
      source: { kind: 'tool', callId: 'c2' as never } as never,
      content: [{ type: 'tool-result', toolCallId: 'c2' as never, isError: true, content: [{ type: 'text', text: 'boom' }] }],
    }, undefined, { name: 'ENOENT', code: 'not_found' }),
  ]
  const totals = { messages: entries.length, toolCalls: 2, inputTokens: 120, outputTokens: 80 }
  return {
    header: { id: 'session-abcd1234', createdAt: base, cwd: '/tmp/proj' } as never,
    entries,
    totals,
    stats: computeStats(entries, { inputPerMillion: 1, outputPerMillion: 2 }),
    generator: 'dsh-session-export v1.0.0',
    generatedAt: base + 100_000,
    ...overrides,
  }
}

describe('renderHtml', () => {
  it('emits a complete single-file document', () => {
    const out = renderHtml(buildInput())
    expect(out).toContain('<!doctype html>')
    expect(out).toContain('<style>')
    expect(out).toMatch(/<\/html>\n$/)
  })

  it('escapes user-controlled text (XSS safety)', () => {
    const out = renderHtml(buildInput())
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).toContain('thinking about &amp; &lt;angles&gt;')
  })

  it('renders KPI cards including cost when pricing is present', () => {
    const out = renderHtml(buildInput())
    expect(out).toContain('kpi-grid')
    expect(out).toContain('Messages')
    expect(out).toContain('Cost ≈')
    expect(out).toContain('1m 36s')
  })

  it('renders the sparkline SVG with one rect per assistant message', () => {
    const out = renderHtml(buildInput())
    expect(out).toContain('<svg class="sparkline"')
    expect(out.match(/<rect /g)?.length).toBe(2)
  })

  it('renders the turn timeline with two turns', () => {
    const out = renderHtml(buildInput())
    expect(out).toContain('Turn timeline')
    expect(out).toContain('tl-bar')
    expect(out).toContain('Turn 1')
    expect(out).toContain('Turn 2')
  })

  it('renders tool ranking sorted by call count', () => {
    const out = renderHtml(buildInput())
    expect(out).toContain('Tool calls')
    expect(out).toContain('bash')
    expect(out).toContain('read')
  })

  it('marks error results with the error class and banner', () => {
    const out = renderHtml(buildInput())
    expect(out).toContain('class="entry tool-result error"')
    expect(out).toContain('error-banner')
    expect(out).toContain('ENOENT')
    expect(out).toContain('1 failed')
  })

  it('uses native details folding for tools and reasoning', () => {
    const out = renderHtml(buildInput())
    expect(out).toContain('<details class="tool">')
    expect(out).toContain('<details class="reasoning">')
    expect(out).toContain('<details class="tool-result" open>')
  })

  it('includes print CSS and the theme toggle script', () => {
    const out = renderHtml(buildInput())
    expect(out).toContain('@media print')
    expect(out).toContain('theme-toggle')
    expect(out).toContain('beforeprint')
    expect(out).toContain('prefers-color-scheme:dark')
    expect(out).toContain(':root:not([data-theme=light])')
    expect(out).toContain('[data-theme=dark]{color-scheme:dark')
  })

  it('shows the filter note when present', () => {
    const out = renderHtml(buildInput({ filterNote: 'Filtered view: entries within --last' }))
    expect(out).toContain('filter-note')
    expect(out).toContain('entries within --last')
  })


describe('renderHtml v1.0.0 Tier A', () => {
  it('highlights JSON tool arguments with token spans', () => {
    const out = renderHtml(buildInput())
    expect(out).toContain('class="json"')
    expect(out).toContain('hl-key')
    expect(out).toContain('hl-str')
  })

  it('escapes HTML inside highlighted JSON strings', () => {
    const full = buildInput()
    const entry: TranscriptEntry = {
      seq: 99, time: base, kind: 'assistant',
      message: { id: 'm99' as never, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } as never,
        content: [{ type: 'tool-call', id: 'c99' as never, name: 'bash', arguments: '{"cmd":"echo <b>x"}' }] },
    }
    const out = renderHtml({ ...full, entries: [entry] })
    expect(out).toContain('&lt;b&gt;')
    expect(out).not.toContain('<b>x')
  })

  it('leaves non-JSON tool arguments unhighlighted', () => {
    const full = buildInput()
    const entry: TranscriptEntry = {
      seq: 98, time: base, kind: 'assistant',
      message: { id: 'm98' as never, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } as never,
        content: [{ type: 'tool-call', id: 'c98' as never, name: 'bash', arguments: 'plain shell text --flag' }] },
    }
    const out = renderHtml({ ...full, entries: [entry] })
    expect(out).not.toContain('class="json"')
  })

  it('renders Chinese labels with lang zh and switches document lang', () => {
    const out = renderHtml(buildInput(), { lang: 'zh' })
    expect(out).toContain('lang="zh-CN"')
    expect(out).toContain('消息')
    expect(out).toContain('轮次时间轴')
    expect(out).toContain('转录')
    expect(out).toContain('工具失败：')
    expect(out).toContain('◐ 主题')
  })

  it('keeps English labels by default', () => {
    const out = renderHtml(buildInput())
    expect(out).toContain('lang="en"')
    expect(out).toContain('Turn timeline')
    expect(out).toContain('Messages')
  })

  it('adds tooltips to KPI cards, timeline bars, and sparkline rects', () => {
    const out = renderHtml(buildInput())
    expect(out).toMatch(/class="kpi" title="/)
    expect(out).toMatch(/class="tl-bar"[^>]*title="Turn 1/)
    expect(out).toMatch(/<rect[^>]*title="#1 /)
  })

  it('renders the error-jump anchor when failures exist', () => {
    const out = renderHtml(buildInput())
    expect(out).toContain('id="error-1"')
    expect(out).toContain('class="jump-error" href="#error-1"')
    expect(out).toContain('1 failed · jump to first')
  })

  it('omits the error-jump anchor when nothing failed', () => {
    const clean = buildInput()
    const entries = clean.entries.slice(0, 5)
    const out = renderHtml({ ...clean, entries, stats: computeStats(entries) })
    expect(out).not.toContain('class="jump-error"')
    expect(out).not.toContain('href="#error-')
    expect(out).not.toContain('id="error-')
  })
})


describe('renderHtml v1.1.0 Tier B', () => {
  function bigInput(): RenderInput {
    const entries: TranscriptEntry[] = []
    let seq = 0
    for (let turn = 0; turn < 5; turn += 1) {
      entries.push(entry(++seq, base + turn * 120_000, { id: `u${seq}` as never, role: 'user', source: { kind: 'user' } as never, content: [{ type: 'text', text: `request number ${turn}` }] }))
      entries.push(entry(++seq, base + turn * 120_000 + 5_000, {
        id: `a${seq}` as never, role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'v3' } as never,
        content: [{ type: 'tool-call', id: `c${seq}` as never, name: 'bash', arguments: `{"cmd":"echo ${turn}"}` }],
      }, { inputTokens: 100, outputTokens: 50 } as never))
      const callId = `c${seq}`
      entries.push(entry(++seq, base + turn * 120_000 + 9_000, {
        id: `r${seq}` as never, role: 'user', source: { kind: 'tool', callId: callId as never } as never,
        content: [{ type: 'tool-result', toolCallId: callId as never, isError: turn === 2, content: [{ type: 'text', text: `result ${turn}` }] }],
      }, undefined, turn === 2 ? { name: 'EFAIL', code: 'boom' } : undefined))
    }
    const totals = { messages: entries.length, toolCalls: 5, inputTokens: 500, outputTokens: 250 }
    return {
      header: { id: 'session-big0001', createdAt: base, cwd: '/tmp/big' } as never,
      entries,
      totals,
      stats: computeStats(entries),
      generator: 'dsh-session-export v1.1.0',
      generatedAt: base + 700_000,
    }
  }

  it('folds the transcript into per-turn details with anchors', () => {
    const out = renderHtml(bigInput())
    expect(out).toContain('<details class="turn" id="turn-1" open>')
    expect(out).toContain('<details class="turn" id="turn-5" open>')
    expect(out).toMatch(/<summary>Turn 1 <span class="turn-meta">/)
  })

  it('flags turns that contain errors', () => {
    const out = renderHtml(bigInput())
    expect(out).toMatch(/<summary>Turn 3 <span class="turn-meta">[^<]*<\/span> <span class="fail">⚠<\/span>/)
    expect(out).not.toMatch(/<summary>Turn 1 <span class="turn-meta">[^<]*<\/span> <span class="fail">/)
  })

  it('keeps the error anchor stable inside turns', () => {
    const out = renderHtml(bigInput())
    expect(out).toContain('id="error-1"')
    expect(out).toContain('class="jump-error" href="#error-1"')
  })

  it('renders the sticky toolbar for large sessions only', () => {
    const big = renderHtml(bigInput())
    expect(big).toContain('<nav class="toc" id="toc">')
    expect(big).toContain('href="#timeline"')
    expect(big).toContain('href="#tools"')
    expect(big).toContain('href="#turn-1"')
    expect(big).toContain('href="#error-1"')
    const small = renderHtml(buildInput())
    expect(small).not.toContain('<nav class="toc"')
  })

  it('renders a search box with localized placeholder', () => {
    expect(renderHtml(bigInput())).toContain('placeholder="Search transcript')
    const zh = renderHtml(bigInput(), { lang: 'zh' })
    expect(zh).toContain('搜索转录')
    expect(zh).toContain('placeholder="搜索转录')
  })

  it('adds copy buttons to tool blocks and code results', () => {
    const out = renderHtml(buildInput())
    expect(out).toMatch(/<button class="copy" type="button">copy<\/button>/)
    const zh = renderHtml(buildInput(), { lang: 'zh' })
    expect(zh).toMatch(/<button class="copy" type="button">复制<\/button>/)
  })

  it('wires the copied label into the script', () => {
    expect(renderHtml(buildInput())).toContain('var COPIED="✓ copied"')
    expect(renderHtml(buildInput(), { lang: 'zh' })).toContain('var COPIED="✓ 已复制"')
  })

  it('localizes turn summaries in zh', () => {
    const out = renderHtml(buildInput(), { lang: 'zh' })
    expect(out).toMatch(/<summary>第 1 轮 <span class="turn-meta">/)
    expect(out).toContain('3 条')
  })
})

  it('omits the sparkline for a single assistant message', () => {
    const full = buildInput()
    const single: RenderInput = { ...full, entries: full.entries.slice(0, 2), stats: computeStats(full.entries.slice(0, 2)) }
    const out = renderHtml(single)
    expect(out).not.toContain('class="sparkline"')
  })
})
