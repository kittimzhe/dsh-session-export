import { describe, expect, it } from 'vitest'
import { computeStats, formatDuration, formatStatsCard, sparkline, bar } from '../src/stats.ts'
import type { TranscriptEntry } from '../src/types.ts'

function entry(
  seq: number,
  time: number,
  message: TranscriptEntry['message'],
  usage?: TranscriptEntry['usage'],
  error?: TranscriptEntry['error'],
): TranscriptEntry {
  return {
    seq,
    time,
    kind: 'user',
    message,
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

const user = (seq: number, time: number): TranscriptEntry =>
  entry(seq, time, { id: `m${seq}` as never, role: 'user', source: { kind: 'user' } as never, content: [{ type: 'text', text: 'hi' }] })

const assistant = (seq: number, time: number, tools: string[], outputTokens = 100): TranscriptEntry =>
  entry(
    seq,
    time,
    {
      id: `m${seq}` as never,
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'v3' } as never,
      content: tools.map((name, index) => ({
        type: 'tool-call' as const,
        id: `call-${seq}-${index}` as never,
        name,
        arguments: '{}',
      })),
    },
    { inputTokens: 1000, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } as never,
  )

const toolResult = (seq: number, time: number, callId: string, error?: TranscriptEntry['error']): TranscriptEntry =>
  entry(seq, time, {
    id: `m${seq}` as never,
    role: 'user',
    source: { kind: 'tool', callId: callId as never } as never,
    content: [{ type: 'tool-result', toolCallId: callId as never, content: [{ type: 'text', text: 'ok' }] }],
  }, undefined, error)

describe('formatDuration', () => {
  it('formats ms/s/m/h/d tiers', () => {
    expect(formatDuration(500)).toBe('500ms')
    expect(formatDuration(59_000)).toBe('59s')
    expect(formatDuration(61_000)).toBe('1m 1s')
    expect(formatDuration(3_600_000)).toBe('1h 0m')
    expect(formatDuration(90_000_000)).toBe('1d 1h')
  })
})

describe('sparkline', () => {
  it('maps values to ramp glyphs', () => {
    expect(sparkline([0, 1, 2, 3, 4])).toBe('▁▃▅▇█')
  })

  it('flat zero series renders flat low bars', () => {
    expect(sparkline([0, 0, 0])).toBe('▁▁▁')
  })

  it('empty series renders empty string', () => {
    expect(sparkline([])).toBe('')
  })
})

describe('bar', () => {
  it('clamps to total', () => {
    expect(bar(5, 3)).toBe('███')
    expect(bar(-1, 3)).toBe('···')
    expect(bar(2, 4)).toBe('██··')
  })
})

describe('computeStats', () => {
  const base = 1_700_000_000_000
  const entries = [
    user(1, base),
    assistant(2, base + 1000, ['bash', 'read']),
    toolResult(3, base + 2000, 'call-2-0'),
    toolResult(4, base + 3000, 'call-2-1', { name: 'ENOENT', code: 'not_found' }),
    user(5, base + 60_000),
    assistant(6, base + 61_000, ['bash']),
    toolResult(7, base + 62_000, 'call-6-0'),
  ]

  it('counts messages, turns, tools, failures', () => {
    const stats = computeStats(entries)
    expect(stats.messages).toBe(7)
    expect(stats.turns).toBe(2)
    expect(stats.toolCalls).toBe(3)
    expect(stats.failedToolCalls).toBe(1)
  })

  it('attributes failures to the calling tool via callId', () => {
    const stats = computeStats(entries)
    const read = stats.toolBreakdown.find((tool) => tool.name === 'read')
    expect(read).toEqual({ name: 'read', calls: 1, failures: 1 })
    const bash = stats.toolBreakdown.find((tool) => tool.name === 'bash')
    expect(bash).toEqual({ name: 'bash', calls: 2, failures: 0 })
  })

  it('sorts tool breakdown by descending calls', () => {
    const stats = computeStats(entries)
    expect(stats.toolBreakdown.map((tool) => tool.name)).toEqual(['bash', 'read'])
  })

  it('computes duration and token series', () => {
    const stats = computeStats(entries)
    expect(stats.durationMs).toBe(62_000)
    expect(stats.inputTokens).toBe(2000)
    expect(stats.outputTokens).toBe(200)
    expect(stats.perAssistantTokens).toEqual([100, 100])
  })

  it('cost appears only with a full price table', () => {
    expect(computeStats(entries).cost).toBeUndefined()
    const priced = computeStats(entries, { inputPerMillion: 1, outputPerMillion: 2, currency: '¥' })
    expect(priced.cost).toMatchObject({ currency: '¥' })
    expect(priced.cost?.input).toBeCloseTo(0.002, 10)
    expect(priced.cost?.output).toBeCloseTo(0.0004, 10)
    expect(priced.cost?.total).toBeCloseTo(0.0024, 10)
  })

  it('single entry has null duration', () => {
    expect(computeStats([user(1, base)]).durationMs).toBeNull()
  })
})

describe('formatStatsCard', () => {
  const stats = computeStats(
    [
      user(1, 1_700_000_000_000),
      assistant(2, 1_700_000_060_000, ['bash', 'bash', 'read']),
      toolResult(3, 1_700_000_061_000, 'call-2-0'),
      toolResult(4, 1_700_000_062_000, 'call-2-1', { name: 'EACCES', code: 'denied' }),
    ],
    { inputPerMillion: 0.5, outputPerMillion: 1.5 },
  )

  it('renders rows inside a box without ANSI by default', () => {
    const card = formatStatsCard(stats)
    expect(card).toContain('┌')
    expect(card).toContain('└')
    expect(card).not.toContain('\x1b[')
    expect(card).toContain('Messages')
    expect(card).toContain('Duration')
    expect(card).toContain('1m')
    expect(card).toContain('1 failed')
    expect(card).toContain('Cost ≈')
  })

  it('renders the tool ranking with bars', () => {
    const card = formatStatsCard(stats)
    expect(card).toContain('bash')
    expect(card).toContain('█')
    expect(card).toContain('1✗')
  })

  it('color mode emits ANSI escapes', () => {
    expect(formatStatsCard(stats, { color: true })).toContain('\x1b[')
  })
})
