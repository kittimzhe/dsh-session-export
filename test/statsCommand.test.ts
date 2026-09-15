import { describe, expect, it } from 'vitest'
import { parseStatsArgs } from '../src/statsCommand.ts'

describe('parseStatsArgs', () => {
  it('returns empty for blank input', () => {
    expect(parseStatsArgs('')).toEqual({})
    expect(parseStatsArgs('   ')).toEqual({})
  })

  it('parses --id', () => {
    expect(parseStatsArgs('--id abc-123')).toEqual({ sessionId: 'abc-123' })
  })

  it('parses --json', () => {
    expect(parseStatsArgs('--json')).toEqual({ json: true })
    expect(parseStatsArgs('--id s1 --json')).toEqual({ sessionId: 's1', json: true })
  })

  it('parses --out with a path', () => {
    expect(parseStatsArgs('--out /tmp/stats.json')).toEqual({ outPath: '/tmp/stats.json' })
    expect(parseStatsArgs('--json --out ./s.json')).toEqual({ json: true, outPath: './s.json' })
  })

  it('rejects --id without a value', () => {
    expect(parseStatsArgs('--id')).toContain('--id requires')
    expect(parseStatsArgs('--id --json')).toContain('--id requires')
  })

  it('rejects --out without a value', () => {
    expect(parseStatsArgs('--out')).toContain('--out requires')
    expect(parseStatsArgs('--out --json')).toContain('--out requires')
  })

  it('rejects duplicate flags', () => {
    expect(parseStatsArgs('--json --json')).toContain('only once')
    expect(parseStatsArgs('--out a --out b')).toContain('only once')
    expect(parseStatsArgs('--id a --id b')).toContain('only once')
  })

  it('rejects unknown tokens', () => {
    expect(parseStatsArgs('--format md')).toContain('Unknown argument')
  })
})
