import { describe, expect, it } from 'vitest'
import { parseTranscriptArgs, selectTurns } from '../src/command.ts'
import type { TranscriptEntry } from '../src/types.ts'

function entry(seq: number, kind: TranscriptEntry['kind']): TranscriptEntry {
  return { seq, time: seq * 1000, kind, message: { id: `m${seq}`, role: 'user' } } as unknown as TranscriptEntry
}

// Layout: u a t | u a | u  (3 turns; turn 3 is an incomplete trailing turn)
function session(): TranscriptEntry[] {
  return [
    entry(1, 'user'),
    entry(2, 'assistant'),
    entry(3, 'tool-result'),
    entry(4, 'user'),
    entry(5, 'assistant'),
    entry(6, 'user'),
  ]
}

describe('parseTranscriptArgs turn flags', () => {
  it('--last-turn requires a value', () => {
    const result = parseTranscriptArgs('--last-turn')
    expect(result).toContain('--last-turn requires a positive integer')
  })

  it('--last-turns 3 parses as last-3', () => {
    const result = parseTranscriptArgs('--last-turns 3')
    expect(result).not.toBeTypeOf('string')
    if (typeof result === 'object') expect(result.turns).toEqual({ kind: 'last', n: 3 })
  })

  it('--last-turn 1 parses as last-1', () => {
    const result = parseTranscriptArgs('--last-turn 1')
    if (typeof result === 'object') expect(result.turns).toEqual({ kind: 'last', n: 1 })
    else throw new Error('expected args')
  })

  it('--last-turns rejects zero and negatives', () => {
    expect(parseTranscriptArgs('--last-turns 0')).toContain('positive integer')
    expect(parseTranscriptArgs('--last-turns -2')).toContain('positive integer')
  })

  it('--turn 42 parses as a single-turn range', () => {
    const result = parseTranscriptArgs('--turn 42')
    if (typeof result === 'object') expect(result.turns).toEqual({ kind: 'range', from: 42, to: 42 })
    else throw new Error('expected args')
  })

  it('--turns 40:42 parses as an inclusive range', () => {
    const result = parseTranscriptArgs('--turns 40:42')
    if (typeof result === 'object') expect(result.turns).toEqual({ kind: 'range', from: 40, to: 42 })
    else throw new Error('expected args')
  })

  it('--turns rejects reversed and malformed ranges', () => {
    expect(parseTranscriptArgs('--turns 42:40')).toContain('must not exceed')
    expect(parseTranscriptArgs('--turns 40-42')).toContain('inclusive range')
    expect(parseTranscriptArgs('--turns :42')).toContain('inclusive range')
  })

  it('only one turn flag may be given', () => {
    expect(parseTranscriptArgs('--turn 3 --turns 1:2')).toContain('Only one of')
  })

  it('composes with --last and --errors-only', () => {
    const result = parseTranscriptArgs('--last-turns 2 --last 5m --errors-only')
    if (typeof result === 'object') {
      expect(result.turns).toEqual({ kind: 'last', n: 2 })
      expect(result.since).not.toBeUndefined()
      expect(result.errorsOnly).toBe(true)
    } else throw new Error('expected args')
  })
})

describe('selectTurns', () => {
  it('selects the last N turns including an incomplete trailing turn', () => {
    const slice = selectTurns(session(), { kind: 'last', n: 2 })
    if (typeof slice === 'string') throw new Error(slice)
    expect(slice.entries.map((e) => e.seq)).toEqual([4, 5, 6])
    expect(slice.fromTurn).toBe(2)
    expect(slice.toTurn).toBe(3)
    expect(slice.totalTurns).toBe(3)
  })

  it('--last N larger than the turn count clamps to turn 1', () => {
    const slice = selectTurns(session(), { kind: 'last', n: 10 })
    if (typeof slice === 'string') throw new Error(slice)
    expect(slice.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(slice.fromTurn).toBe(1)
  })

  it('selects a single turn by index', () => {
    const slice = selectTurns(session(), { kind: 'range', from: 2, to: 2 })
    if (typeof slice === 'string') throw new Error(slice)
    expect(slice.entries.map((e) => e.seq)).toEqual([4, 5])
  })

  it('selects an inclusive multi-turn range', () => {
    const slice = selectTurns(session(), { kind: 'range', from: 1, to: 2 })
    if (typeof slice === 'string') throw new Error(slice)
    expect(slice.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('clamps a range whose upper bound passes the last turn', () => {
    const slice = selectTurns(session(), { kind: 'range', from: 2, to: 99 })
    if (typeof slice === 'string') throw new Error(slice)
    expect(slice.entries.map((e) => e.seq)).toEqual([4, 5, 6])
    expect(slice.toTurn).toBe(3)
  })

  it('errors when the range starts past the last turn', () => {
    expect(selectTurns(session(), { kind: 'range', from: 4, to: 5 })).toContain('out of range')
  })

  it('errors when the session has no user messages', () => {
    const noTurns = [entry(1, 'assistant'), entry(2, 'tool-result')]
    expect(selectTurns(noTurns, { kind: 'last', n: 1 })).toContain('no user messages')
  })

  it('entries before the first user message are never selected', () => {
    const withPreamble = [entry(0, 'assistant'), ...session()]
    const slice = selectTurns(withPreamble, { kind: 'last', n: 3 })
    if (typeof slice === 'string') throw new Error(slice)
    expect(slice.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })
})
