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

  it('omits the sparkline for a single assistant message', () => {
    const full = buildInput()
    const single: RenderInput = { ...full, entries: full.entries.slice(0, 2), stats: computeStats(full.entries.slice(0, 2)) }
    const out = renderHtml(single)
    expect(out).not.toContain('class="sparkline"')
  })
})
