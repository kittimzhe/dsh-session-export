import { describe, expect, it } from 'vitest'
import { computeStats, formatStatsCard } from '../src/stats.ts'
import { renderHtml } from '../src/render/html.ts'
import { renderMarkdown } from '../src/render/markdown.ts'
import { renderJson } from '../src/render/json.ts'
import type { PricingConfig, RenderInput, TranscriptEntry } from '../src/types.ts'

const entries: TranscriptEntry[] = [
  [1_000_000, 2_000_000, 500_000],
  [500_000, 1_000_000, 250_000],
].map(([inputTokens, cacheReadTokens, outputTokens], index) => ({
  seq: index + 1,
  time: 1_700_000_000_000 + index * 1000,
  kind: 'assistant',
  message: {
    id: `m${index}` as never,
    role: 'assistant',
    source: { kind: 'model', provider: 'deepseek', model: 'v3' } as never,
    content: [{ type: 'text', text: 'Cache pricing fixture' }],
  },
  usage: { inputTokens: inputTokens!, cacheReadTokens: cacheReadTokens!, outputTokens: outputTokens! },
}))

const pricing: PricingConfig = { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 4 }

function input(stats = computeStats(entries, pricing)): RenderInput {
  return {
    header: { id: 'session-cache123', createdAt: 1_700_000_000_000, cwd: '/workspace' } as never,
    entries,
    totals: { messages: entries.length, toolCalls: 0, inputTokens: stats.inputTokens, outputTokens: stats.outputTokens },
    stats,
    generator: 'cache-pricing-test',
    generatedAt: 1_700_000_010_000,
  }
}

describe('optional cache-read pricing (#9)', () => {
  it('prices disjoint input/cache-read/output counts across messages', () => {
    const stats = computeStats(entries, pricing)
    expect(stats.inputTokens).toBe(1_500_000)
    expect(stats.outputTokens).toBe(750_000)
    expect(stats.cost).toEqual({ input: 3, cacheRead: 1.5, output: 3, total: 7.5, currency: '$' })
  })

  it('keeps the exact two-rate object, including with reported cache reads', () => {
    expect(computeStats(entries, { inputPerMillion: 2, outputPerMillion: 4 }).cost)
      .toEqual({ input: 3, output: 3, total: 6, currency: '$' })
    expect(computeStats(entries, { inputPerMillion: 2, outputPerMillion: 4 }).cost)
      .not.toHaveProperty('cacheRead')
  })

  it('honors a zero cache-read rate', () => {
    expect(computeStats(entries, { ...pricing, cacheReadPerMillion: 0, currency: 'EUR' }).cost)
      .toEqual({ input: 3, cacheRead: 0, output: 3, total: 6, currency: 'EUR' })
  })

  it('treats missing cache usage as zero and ignores user usage', () => {
    const noCache = { ...entries[0]!, usage: { inputTokens: 10, outputTokens: 5 } }
    const user: TranscriptEntry = { ...entries[1]!, message: {
      id: 'user' as never,
      role: 'user', source: { kind: 'user' } as never, content: [{ type: 'text', text: 'hi' }],
    } }
    const cost = computeStats([noCache, user], pricing).cost!
    expect(cost.cacheRead).toBe(0)
    expect(cost.input).toBeCloseTo(0.00002)
    expect(cost.total).toBeCloseTo(0.00004)
  })

  it('handles empty and all-cache sessions without negative input cost', () => {
    expect(computeStats([], pricing).cost).toEqual({ input: 0, cacheRead: 0, output: 0, total: 0, currency: '$' })
    const cached = { ...entries[0]!, usage: { inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0 } }
    expect(computeStats([cached], pricing).cost).toEqual({ input: 0, cacheRead: 0.5, output: 0, total: 0.5, currency: '$' })
  })

  it('still requires both ordinary rates', () => {
    for (const table of [undefined, { cacheReadPerMillion: 0.5 }, { inputPerMillion: 2, cacheReadPerMillion: 0.5 }, { outputPerMillion: 4, cacheReadPerMillion: 0.5 }]) {
      expect(computeStats(entries, table).cost).toBeUndefined()
    }
  })

  it('renders all four costs in terminal, Markdown, HTML, and JSON', () => {
    const data = input()
    const terminal = formatStatsCard(data.stats!)
    expect(terminal).toContain('Cost input $3.00')
    expect(terminal).toContain('Cost cache-read $1.50')
    expect(terminal).toContain('Cost output $3.00')
    expect(terminal).toContain('Cost total ≈ $7.50')
    const md = renderMarkdown(data)
    expect(md).toContain('| Cost input | $3.0000 |')
    expect(md).toContain('| Cost cache-read | $1.5000 |')
    expect(md).toContain('| Cost output | $3.0000 |')
    expect(md).toContain('| Cost total ≈ | $7.5000 |')
    const html = renderHtml(data)
    expect(html).toContain('Cost input</div><div class="kpi-value">$3.00')
    expect(html).toContain('Cost cache-read</div><div class="kpi-value">$1.50')
    expect(html).toContain('Cost output</div><div class="kpi-value">$3.00')
    expect(html).toContain('Cost total ≈</div><div class="kpi-value">$7.50')
    expect(JSON.parse(renderJson(data)).stats.cost).toEqual(data.stats!.cost)
  })

  it('keeps cache rows absent in the default two-rate renderers', () => {
    const data = input(computeStats(entries, { inputPerMillion: 2, outputPerMillion: 4 }))
    expect(formatStatsCard(data.stats!)).toContain('Cost ≈ $6.00 (in $3.00 / out $3.00)')
    expect(renderMarkdown(data)).toContain('| Cost ≈ | $6.0000 (in $3.0000 / out $3.0000) |')
    expect(JSON.parse(renderJson(data)).stats.cost).not.toHaveProperty('cacheRead')
    for (const text of [formatStatsCard(data.stats!), renderMarkdown(data), renderHtml(data)]) {
      expect(text).not.toContain('Cost cache-read')
    }
  })
})
