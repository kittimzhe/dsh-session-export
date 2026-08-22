import { describe, expect, it } from 'vitest'
import { parseTranscriptArgs, USAGE, id8 } from '../src/command.ts'

describe('id8 slug', () => {
  it('strips the web-profile session- prefix before slicing', () => {
    expect(id8('session-ca62e005-4274-477b-bd56-9d9508edb040')).toBe('ca62e005')
  })

  it('slices ids without the prefix as-is', () => {
    expect(id8('parent-session-id-1')).toBe('parent-s')
    expect(id8('short')).toBe('short')
  })
})

describe('parseTranscriptArgs', () => {
  it('empty input defaults to markdown of the current session', () => {
    expect(parseTranscriptArgs('')).toEqual({ json: false, md: true, full: false })
    expect(parseTranscriptArgs('   ')).toEqual({ json: false, md: true, full: false })
  })

  it('positional path becomes outPath', () => {
    const result = parseTranscriptArgs('./out.md')
    expect(result).toEqual({ outPath: './out.md', json: false, md: true, full: false })
  })

  it('--id consumes the next token', () => {
    const result = parseTranscriptArgs('--id abc123')
    expect(result).toEqual({ sessionId: 'abc123', json: false, md: true, full: false })
  })

  it('--id requires a value', () => {
    expect(parseTranscriptArgs('--id')).toBe(`--id requires a session id value.\n${USAGE}`)
    expect(parseTranscriptArgs('--id --json')).toBe(`--id requires a session id value.\n${USAGE}`)
  })

  it('--out consumes the rest of the line (spaces allowed)', () => {
    const result = parseTranscriptArgs('--json --out /tmp/my transcripts/a.md')
    expect(result).toEqual({ outPath: '/tmp/my transcripts/a.md', json: true, md: false, full: false })
  })

  it('--json alone selects json only', () => {
    expect(parseTranscriptArgs('--json')).toEqual({ json: true, md: false, full: false })
  })

  it('--json --md selects both', () => {
    expect(parseTranscriptArgs('--json --md')).toEqual({ json: true, md: true, full: false })
  })

  it('--full flag parses', () => {
    expect(parseTranscriptArgs('--full')).toEqual({ json: false, md: true, full: true })
  })

  it('combined flags and positional path', () => {
    const result = parseTranscriptArgs('out.md --id sid1 --full')
    expect(result).toEqual({ sessionId: 'sid1', outPath: 'out.md', json: false, md: true, full: true })
  })

  it('unknown flag errors with usage', () => {
    expect(parseTranscriptArgs('--nope')).toBe(`Unknown option: --nope\n${USAGE}`)
  })

  it('second positional errors', () => {
    expect(parseTranscriptArgs('a.md b.md')).toBe(`Unexpected extra positional argument: b.md\n${USAGE}`)
  })
})
