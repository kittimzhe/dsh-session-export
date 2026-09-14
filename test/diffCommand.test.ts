import { describe, expect, it } from 'vitest'
import { parseDiffArgs, entryFingerprint, diffSessions, renderTerminalDiff, type DiffResult } from '../src/diffCommand.ts'
import type { TranscriptEntry } from '../src/types.ts'

function entry(kind: 'user' | 'assistant' | 'tool-result', text: string, time = 1_700_000_000_000): TranscriptEntry {
  return {
    seq: 1,
    time,
    kind,
    message: { role: kind === 'assistant' ? 'assistant' : 'user', source: { kind: kind === 'tool-result' ? 'tool' : 'input' }, content: [{ type: 'text', text }] },
  } as unknown as TranscriptEntry
}

function errEntry(text: string): TranscriptEntry {
  return { ...entry('tool-result', text), error: { name: 'E', code: 'BOOM' } }
}

describe('parseDiffArgs', () => {
  it('positional ids', () => {
    const r = parseDiffArgs('abc def') as { sessionIdA: string; sessionIdB: string; html: boolean }
    expect(r.sessionIdA).toBe('abc')
    expect(r.sessionIdB).toBe('def')
    expect(r.html).toBe(false)
  })

  it('--id and --other', () => {
    const r = parseDiffArgs('--id aaa --other bbb --html') as { sessionIdA: string; sessionIdB: string; html: boolean }
    expect(r.sessionIdA).toBe('aaa')
    expect(r.sessionIdB).toBe('bbb')
    expect(r.html).toBe(true)
  })

  it('--out captures spaces', () => {
    const r = parseDiffArgs('a b --out /tmp/my diff.html') as { outPath: string }
    expect(r.outPath).toBe('/tmp/my diff.html')
  })

  it('errors on single id', () => { expect(typeof parseDiffArgs('abc')).toBe('string') })
  it('errors on zero ids', () => { expect(typeof parseDiffArgs('')).toBe('string') })
})

describe('entryFingerprint', () => {
  it('same text same fp', () => {
    expect(entryFingerprint(entry('user', 'hi'))).toBe(entryFingerprint(entry('user', 'hi')))
  })
  it('diff kind diff fp', () => {
    expect(entryFingerprint(entry('user', 'x'))).not.toBe(entryFingerprint(entry('assistant', 'x')))
  })
  it('error marks differ', () => {
    expect(entryFingerprint(entry('tool-result', 'x'))).not.toBe(entryFingerprint(errEntry('x')))
  })
})

describe('diffSessions', () => {
  it('identical → full prefix', () => {
    const a = [entry('user', 'hi'), entry('assistant', 'ok')]
    const r = diffSessions(a, a)
    expect(r.commonPrefixLen).toBe(2)
    expect(r.tailA).toHaveLength(0)
    expect(r.tailB).toHaveLength(0)
  })

  it('diverges at first mismatch', () => {
    const a = [entry('user', 'hi'), entry('assistant', 'a')]
    const b = [entry('user', 'hi'), entry('assistant', 'b')]
    const r = diffSessions(a, b)
    expect(r.commonPrefixLen).toBe(1)
    expect((r.tailA[0]!.message.content[0]! as { type: 'text'; text: string }).text).toBe('a')
    expect((r.tailB[0]!.message.content[0]! as { type: 'text'; text: string }).text).toBe('b')
  })

  it('shorter caps prefix', () => {
    const a = [entry('user', '1'), entry('assistant', '2'), entry('user', '3')]
    const b = [entry('user', '1')]
    const r = diffSessions(a, b)
    expect(r.commonPrefixLen).toBe(1)
    expect(r.tailA).toHaveLength(2)
    expect(r.tailB).toHaveLength(0)
  })
})

describe('renderTerminalDiff', () => {
  const base: DiffResult = {
    sessionA: { id: 's-a', createdAt: 1_700_000_000_000 },
    sessionB: { id: 's-b', createdAt: 1_700_000_000_001 },
    totalA: 5, totalB: 6, commonPrefixLen: 3,
    tailA: [entry('user', 'extra a'), entry('assistant', 'more a')],
    tailB: [entry('user', 'extra b')],
    totals: {
      a: { messages: 3, toolCalls: 1, inputTokens: 100, outputTokens: 200 },
      b: { messages: 4, toolCalls: 1, inputTokens: 120, outputTokens: 210 },
      delta: { messages: 1, toolCalls: 0, inputTokens: 20, outputTokens: 10 },
    },
  }

  it('renders header with session ids', () => {
    const text = renderTerminalDiff(base)
    expect(text).toContain('s-a')
    expect(text).toContain('s-b')
    expect(text).toContain('Session Diff')
  })

  it('renders common prefix', () => {
    expect(renderTerminalDiff(base)).toContain('common=3')
  })

  it('renders tail sections', () => {
    const text = renderTerminalDiff(base)
    expect(text).toContain('A-only tail')
    expect(text).toContain('B-only tail')
  })

  it('renders stats delta', () => {
    const text = renderTerminalDiff(base)
    expect(text).toContain('Stats Delta')
    expect(text).toContain('+1')
  })
})
