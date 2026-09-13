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
    expect(parseTranscriptArgs('')).toEqual({ json: false, md: true, html: false, full: false, errorsOnly: false, mask: false })
    expect(parseTranscriptArgs('   ')).toEqual({ json: false, md: true, html: false, full: false, errorsOnly: false, mask: false })
  })

  it('positional path becomes outPath', () => {
    const result = parseTranscriptArgs('./out.md')
    expect(result).toEqual({ outPath: './out.md', json: false, md: true, html: false, full: false, errorsOnly: false, mask: false })
  })

  it('--id consumes the next token', () => {
    const result = parseTranscriptArgs('--id abc123')
    expect(result).toEqual({ sessionId: 'abc123', json: false, md: true, html: false, full: false, errorsOnly: false, mask: false })
  })

  it('--id requires a value', () => {
    expect(parseTranscriptArgs('--id')).toBe(`--id requires a session id value.\n${USAGE}`)
    expect(parseTranscriptArgs('--id --json')).toBe(`--id requires a session id value.\n${USAGE}`)
  })

  it('--out consumes the rest of the line (spaces allowed)', () => {
    const result = parseTranscriptArgs('--json --out /tmp/my transcripts/a.md')
    expect(result).toEqual({ outPath: '/tmp/my transcripts/a.md', json: true, md: false, html: false, full: false, errorsOnly: false, mask: false })
  })

  it('--json alone selects json only', () => {
    expect(parseTranscriptArgs('--json')).toEqual({ json: true, md: false, html: false, full: false, errorsOnly: false, mask: false })
  })

  it('--json --md selects both', () => {
    expect(parseTranscriptArgs('--json --md')).toEqual({ json: true, md: true, html: false, full: false, errorsOnly: false, mask: false })
  })

  it('--full flag parses', () => {
    expect(parseTranscriptArgs('--full')).toEqual({ json: false, md: true, html: false, full: true, errorsOnly: false, mask: false })
  })

  it('combined flags and positional path', () => {
    const result = parseTranscriptArgs('out.md --id sid1 --full')
    expect(result).toEqual({ sessionId: 'sid1', outPath: 'out.md', json: false, md: true, html: false, full: true, errorsOnly: false, mask: false })
  })

  it('unknown flag errors with usage', () => {
    expect(parseTranscriptArgs('--nope')).toBe(`Unknown option: --nope\n${USAGE}`)
  })

  it('second positional errors', () => {
    expect(parseTranscriptArgs('a.md b.md')).toBe(`Unexpected extra positional argument: b.md\n${USAGE}`)
  })
})

describe('parseTranscriptArgs v1.0.0 flags', () => {
  it('--html selects html only', () => {
    const result = parseTranscriptArgs('--html')
    expect(result).toEqual({ json: false, md: false, html: true, full: false, errorsOnly: false, mask: false })
  })

  it('--md --html selects both formats', () => {
    const result = parseTranscriptArgs('--md --html')
    expect(result).toEqual({ json: false, md: true, html: true, full: false, errorsOnly: false, mask: false })
  })

  it('--mask parses', () => {
    const result = parseTranscriptArgs('--mask')
    expect(result).toEqual({ json: false, md: true, html: false, full: false, errorsOnly: false, mask: true })
  })

  it('--errors-only parses', () => {
    const result = parseTranscriptArgs('--errors-only')
    expect(result).toEqual({ json: false, md: true, html: false, full: false, errorsOnly: true, mask: false })
  })

  it('--last consumes a duration into an epoch bound', () => {
    const result = parseTranscriptArgs('--last 30m')
    expect(typeof result).toBe('object')
    if (typeof result === 'object' && result !== null && 'since' in result) {
      expect(result.since).toBeGreaterThan(Date.now() - 31 * 60_000)
      expect(result.since).toBeLessThanOrEqual(Date.now())
    } else {
      throw new Error('expected since field')
    }
  })

  it('--last rejects a malformed duration', () => {
    expect(parseTranscriptArgs('--last')).toBe(`--last requires a duration (e.g. 30m, 12h, 7d).\n${USAGE}`)
    expect(parseTranscriptArgs('--last banana')).toBe(`--last expects a duration like 30m, 12h, or 7d.\n${USAGE}`)
  })

  it('full combination: html + errors-only + last + id', () => {
    const result = parseTranscriptArgs('--id sid9 --html --errors-only --last 2h')
    expect(typeof result).toBe('object')
    if (typeof result === 'object' && result !== null && !('since' in result && typeof result.since === 'undefined')) {
      expect(result).toMatchObject({ sessionId: 'sid9', html: true, errorsOnly: true })
    }
  })
})
