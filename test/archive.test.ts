import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { ARCHIVE_USAGE, executeArchive, parseArchiveArgs } from '../src/archive.ts'
import { buildZip } from '../src/util/zip.ts'

function header(id: string, overrides: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id: id as never, createdAt: 1_700_000_000_000, ...overrides } as SessionHeader
}

function event(seq: number, type = 'user/message', time = 1_700_000_000_000 + seq): SessionEvent {
  return { type, seq, time, data: { role: 'user', content: [{ type: 'text', text: `line ${seq}` }] } } as unknown as SessionEvent
}

/** Walk local file headers (no data descriptors) until the central directory. */
function extractEntries(zip: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(zip)
  const out = new Map<string, Uint8Array>()
  let offset = 0
  while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8)
    const compressed = buf.readUInt32LE(offset + 18)
    const raw = buf.readUInt32LE(offset + 22)
    const nameLen = buf.readUInt16LE(offset + 26)
    const extraLen = buf.readUInt16LE(offset + 28)
    const name = buf.toString('utf8', offset + 30, offset + 30 + nameLen)
    const dataStart = offset + 30 + nameLen + extraLen
    const packed = buf.subarray(dataStart, dataStart + compressed)
    const restored = method === 8 ? inflateRawSync(packed) : Buffer.from(packed)
    expect(restored.length).toBe(raw)
    out.set(name, restored)
    offset = dataStart + compressed
  }
  return out
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe('parseArchiveArgs', () => {
  it('empty input defaults to the current session (no all/since)', () => {
    expect(parseArchiveArgs('')).toEqual({ all: false, noDescendants: false })
    expect(parseArchiveArgs('   ')).toEqual({ all: false, noDescendants: false })
  })

  it('--id consumes the next token', () => {
    expect(parseArchiveArgs('--id abc123')).toEqual({ sessionId: 'abc123', all: false, noDescendants: false })
  })

  it('--id requires a value', () => {
    expect(parseArchiveArgs('--id')).toBe(`--id requires a session id value.\n${ARCHIVE_USAGE}`)
    expect(parseArchiveArgs('--id --all')).toBe(`--id requires a session id value.\n${ARCHIVE_USAGE}`)
  })

  it('--all parses', () => {
    expect(parseArchiveArgs('--all')).toEqual({ all: true, noDescendants: false })
  })

  it('--since parses durations into an epoch lower bound', () => {
    const result = parseArchiveArgs('--since 7d')
    expect(result).not.toBeTypeOf('string')
    if (typeof result !== 'string') {
      expect(result.all).toBe(false)
      const sevenDays = 7 * 86_400_000
      expect(result.since).toBeGreaterThan(Date.now() - sevenDays - 1000)
      expect(result.since).toBeLessThan(Date.now() - sevenDays + 1000)
    }
  })

  it('--since rejects malformed durations', () => {
    expect(parseArchiveArgs('--since 7')).toBe(`--since expects a duration like 7d, 12h, 30m, or 90s.\n${ARCHIVE_USAGE}`)
    expect(parseArchiveArgs('--since')).toBe(`--since requires a duration (e.g. 7d, 12h, 30m).\n${ARCHIVE_USAGE}`)
  })

  it('--out consumes the rest of the line', () => {
    const result = parseArchiveArgs('--all --out /tmp/my archives')
    expect(result).toEqual({ all: true, outDir: '/tmp/my archives', noDescendants: false })
  })

  it('--out requires a value', () => {
    expect(parseArchiveArgs('--out')).toBe(`--out requires a directory path.\n${ARCHIVE_USAGE}`)
  })

  it('--no-descendants parses', () => {
    expect(parseArchiveArgs('--id s1 --no-descendants')).toEqual({ sessionId: 's1', all: false, noDescendants: true })
  })

  it('unknown flags and stray positionals error with usage', () => {
    expect(parseArchiveArgs('--nope')).toBe(`Unknown option: --nope\n${ARCHIVE_USAGE}`)
    expect(parseArchiveArgs('stray')).toBe(`Unexpected argument: stray\n${ARCHIVE_USAGE}`)
  })
})

describe('buildZip', () => {
  it('produces an extractable ZIP with readable entries', () => {
    const zip = buildZip([
      { name: 'session.jsonl', data: new TextEncoder().encode('{"seq":1}\n') },
      { name: 'manifest.json', data: new TextEncoder().encode('{"eventCount":1}\n') },
    ])
    expect(zip[0]).toBe(0x50) // 'P'
    expect(zip[1]).toBe(0x4b) // 'K'
    const entries = extractEntries(zip)
    expect(new TextDecoder().decode(entries.get('session.jsonl'))).toBe('{"seq":1}\n')
    expect(new TextDecoder().decode(entries.get('manifest.json'))).toBe('{"eventCount":1}\n')
  })
})

describe('executeArchive', () => {
  function makeCtx(targets: readonly SessionHeader[]): Context {
    return {
      sessionQuery: {
        readSession: async (id: string) => ({ session: header(id), events: [event(1), event(2)] }),
        listSessions: async () => targets.map((h) => ({ header: h, live: false, persisted: true })),
        traceSession: async (id: string) => ({
          target: { header: header(id), live: false, persisted: true },
          ancestors: targets.filter((h) => h.id !== id),
          descendants: [],
        }),
      },
    } as unknown as Context
  }

  const invocation = {
    rawInput: '',
    agent: { session: { id: 'current-session', header: { cwd: '/proj' } } },
  } as unknown as CommandInvocation

  it('archives a --id session into one ZIP carrying session.jsonl + manifest.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-archive-test-'))
    cleanups.push(async () => rm(dir, { recursive: true, force: true }))

    const result = await executeArchive(makeCtx([header('target-1')]), { ...invocation, rawInput: `--id target-1 --out ${dir}` })
    expect(result.kind).toBe('success')

    const files = await readdir(dir)
    expect(files.length).toBe(1)
    const zipName = files[0] ?? ''
    expect(zipName).toMatch(/^dsh-session-target-1-\d{8}\.zip$/)

    const entries = extractEntries(await readFile(join(dir, zipName)))
    const jsonl = new TextDecoder().decode(entries.get('session.jsonl'))
    expect(jsonl.split('\n').filter((l) => l.length > 0).length).toBe(2)
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')))
    expect(manifest.eventCount).toBe(2)
    expect(manifest.sessionId).toBe('target-1')
  })

  it('returns a usage error for a malformed flag', async () => {
    const result = await executeArchive(makeCtx([]), { ...invocation, rawInput: '--bogus' })
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('Unknown option')
  })

  it('reports no-op when nothing matches', async () => {
    const result = await executeArchive(makeCtx([]), { ...invocation, rawInput: '--all --out /tmp' })
    expect(result).toEqual({ kind: 'success', text: 'No sessions matched; nothing archived.' })
  })
})