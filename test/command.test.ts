import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { executeTranscript, parseTranscriptArgs, USAGE, id8 } from '../src/command.ts'
import { atomicWriteFile } from '../src/util/atomicWrite.ts'

vi.mock('../src/util/atomicWrite.ts', () => ({ atomicWriteFile: vi.fn(async () => {}) }))

afterEach(() => vi.restoreAllMocks())

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
    expect(parseTranscriptArgs('')).toEqual({ json: false, md: true, html: false, full: false, errorsOnly: false, mask: false, maskHash: false, manifest: false })
    expect(parseTranscriptArgs('   ')).toEqual({ json: false, md: true, html: false, full: false, errorsOnly: false, mask: false, maskHash: false, manifest: false })
  })

  it('positional path becomes outPath', () => {
    const result = parseTranscriptArgs('./out.md')
    expect(result).toEqual({ outPath: './out.md', json: false, md: true, html: false, full: false, errorsOnly: false, mask: false, maskHash: false, manifest: false })
  })

  it('--id consumes the next token', () => {
    const result = parseTranscriptArgs('--id abc123')
    expect(result).toEqual({ sessionId: 'abc123', json: false, md: true, html: false, full: false, errorsOnly: false, mask: false, maskHash: false, manifest: false })
  })

  it('--id requires a value', () => {
    expect(parseTranscriptArgs('--id')).toBe(`--id requires a session id value.\n${USAGE}`)
    expect(parseTranscriptArgs('--id --json')).toBe(`--id requires a session id value.\n${USAGE}`)
  })

  it('--out consumes the rest of the line (spaces allowed)', () => {
    const result = parseTranscriptArgs('--json --out /tmp/my transcripts/a.md')
    expect(result).toEqual({ outPath: '/tmp/my transcripts/a.md', json: true, md: false, html: false, full: false, errorsOnly: false, mask: false, maskHash: false, manifest: false })
  })

  it('--json alone selects json only', () => {
    expect(parseTranscriptArgs('--json')).toEqual({ json: true, md: false, html: false, full: false, errorsOnly: false, mask: false, maskHash: false, manifest: false })
  })

  it('--json --md selects both', () => {
    expect(parseTranscriptArgs('--json --md')).toEqual({ json: true, md: true, html: false, full: false, errorsOnly: false, mask: false, maskHash: false, manifest: false })
  })

  it('--full flag parses', () => {
    expect(parseTranscriptArgs('--full')).toEqual({ json: false, md: true, html: false, full: true, errorsOnly: false, mask: false, maskHash: false, manifest: false })
  })

  it('combined flags and positional path', () => {
    const result = parseTranscriptArgs('out.md --id sid1 --full')
    expect(result).toEqual({ sessionId: 'sid1', outPath: 'out.md', json: false, md: true, html: false, full: true, errorsOnly: false, mask: false, maskHash: false, manifest: false })
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
    expect(result).toEqual({ json: false, md: false, html: true, full: false, errorsOnly: false, mask: false, maskHash: false, manifest: false })
  })

  it('--md --html selects both formats', () => {
    const result = parseTranscriptArgs('--md --html')
    expect(result).toEqual({ json: false, md: true, html: true, full: false, errorsOnly: false, mask: false, maskHash: false, manifest: false })
  })

  it('--mask parses', () => {
    const result = parseTranscriptArgs('--mask')
    expect(result).toEqual({ json: false, md: true, html: false, full: false, errorsOnly: false, mask: true, maskHash: false, manifest: false })
  })

  it('--errors-only parses', () => {
    const result = parseTranscriptArgs('--errors-only')
    expect(result).toEqual({ json: false, md: true, html: false, full: false, errorsOnly: true, mask: false, maskHash: false, manifest: false })
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

describe('v1.2 flags: --mask-hash and --manifest', () => {
  it('parses --mask-hash as mask + hash mode', () => {
    const result = parseTranscriptArgs('--html --mask-hash')
    expect(typeof result).toBe('object')
    if (typeof result === 'object') {
      expect(result).toMatchObject({ mask: true, maskHash: true, manifest: false })
    }
  })

  it('parses --manifest independently of masking', () => {
    const result = parseTranscriptArgs('--manifest')
    expect(typeof result).toBe('object')
    if (typeof result === 'object') {
      expect(result).toMatchObject({ mask: false, manifest: true, md: true })
    }
  })

  it('combines --mask-hash with other filters', () => {
    const result = parseTranscriptArgs('--html --errors-only --mask-hash --manifest')
    expect(typeof result).toBe('object')
    if (typeof result === 'object') {
      expect(result).toMatchObject({ html: true, errorsOnly: true, mask: true, maskHash: true, manifest: true })
    }
  })
})

describe('--reproducible', () => {
  const createdAt = 1_700_000_000_000
  const session = { version: 0, id: 'session-abcdefgh-1234', createdAt, cwd: '/workspace' }
  const events = [{
    type: 'user/message', seq: 1, time: createdAt + 1, surfaceOp: 'append',
    data: { role: 'user', source: { kind: 'input' }, content: [{ type: 'text', text: 'same fixture' }] },
  }]

  async function exportAt(rawInput: string, now: number, sessionEvents = events) {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.mocked(atomicWriteFile).mockClear()
    const ctx = { sessionQuery: {
      readSession: async () => ({ session, events: sessionEvents }),
      traceSession: async () => ({ ancestors: [], descendants: [] }),
    } }
    const result = await executeTranscript(ctx as never, {
      rawInput, agent: { session: { id: session.id } },
    } as never)
    expect(result.kind).toBe('success')
    return new Map(vi.mocked(atomicWriteFile).mock.calls.map(([path, content]) => [path, content]))
  }

  it('parses the flag and keeps Markdown as the default format', () => {
    expect(parseTranscriptArgs('--reproducible')).toMatchObject({ md: true, reproducible: true })
    expect(USAGE).toContain('--reproducible')
  })

  it.each(['', ' --out /workspace/report'])('pins all report bytes and manifest hashes with output suffix %j', async (out) => {
    const args = `--reproducible --md --json --html --manifest${out}`
    const first = await exportAt(args, createdAt + 60_000)
    const second = await exportAt(args, createdAt + 120_000)
    expect([...second]).toEqual([...first])
    expect(first.size).toBe(4)
    const artifact = (ext: string) => [...first].find(([path]) => path.endsWith(ext))![1]
    expect(artifact('.md')).toContain('| Exported | 1970-01-01 00:00:00Z |')
    expect(artifact('.html')).toContain('1970-01-01 00:00:00Z')
    const json = JSON.parse(artifact('.json'))
    expect(json.generatedAt).toBe(0)
    expect(json.session.createdAt).toBe(createdAt)
    expect(json.transcript[0].time).toBe(createdAt + 1)
    const manifest = JSON.parse(artifact('.manifest.json'))
    expect(manifest.createdAt).toBe(0)
    expect(manifest.artifacts).toHaveLength(3)
    for (const entry of manifest.artifacts) {
      const content = first.get(entry.path)!
      expect(entry.bytes).toBe(Buffer.byteLength(content, 'utf8'))
      expect(entry.sha256).toBe(createHash('sha256').update(content).digest('hex'))
    }
  })

  it('keeps fresh report and manifest timestamps without the flag', async () => {
    const args = '--md --html --json --manifest --out /workspace/report'
    const first = await exportAt(args, createdAt + 60_000)
    const second = await exportAt(args, createdAt + 120_000)
    for (const ext of ['md', 'html', 'json', 'manifest.json']) {
      expect(second.get(`/workspace/report.${ext}`)).not.toBe(first.get(`/workspace/report.${ext}`))
    }
    expect(JSON.parse(second.get('/workspace/report.json')!).generatedAt).toBe(createdAt + 120_000)
    expect(JSON.parse(second.get('/workspace/report.manifest.json')!).createdAt).toBe(createdAt + 120_000)
    expect(second.get('/workspace/report.md')).toContain('2023-11-14 22:15:20Z')
    expect(second.get('/workspace/report.html')).toContain('2023-11-14 22:15:20Z')
  })

  it('supports an empty session with the default Markdown format', async () => {
    const first = await exportAt('--reproducible --manifest', createdAt + 60_000, [])
    const second = await exportAt('--reproducible --manifest', createdAt + 120_000, [])
    expect([...second]).toEqual([...first])
    expect([...first.keys()].filter((path) => path.endsWith('.md'))).toHaveLength(1)
    expect(first.size).toBe(2)
  })

  it('keeps reproducible default names and report bytes stable across host time zones', async () => {
    const original = process.env.TZ
    try {
      let first: Map<string, string> | undefined
      for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Riyadh']) {
        process.env.TZ = zone
        const files = await exportAt('--reproducible --md --json --html --manifest', createdAt)
        if (first) expect([...files]).toEqual([...first])
        else first = files
      }
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })
})
