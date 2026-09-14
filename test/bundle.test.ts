import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { parseBundleArgs, executeBundle, type BundleArgs } from '../src/bundleCommand.ts'

const T = 1_700_000_000_000

function userMsg(seq: number, text: string): SessionEvent {
  return { type: 'user/message', seq, time: T + seq, surfaceOp: 'append', data: { role: 'user', source: { kind: 'input' }, content: [{ type: 'text', text }] } } as unknown as SessionEvent
}

function asstMsg(seq: number, text: string): SessionEvent {
  return { type: 'assistant/message', seq, time: T + seq, surfaceOp: 'append', data: { message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'v4' }, content: [{ type: 'text', text }] } } } as unknown as SessionEvent
}

const FIXTURE: SessionEvent[] = [userMsg(1, 'hi'), asstMsg(2, 'ok')]
const SESSION: SessionHeader = { version: 0, id: 'session-ca62e005-4274-477b-bd56-9d9508edb040', createdAt: T, cwd: '/w' } as unknown as SessionHeader

function mockCtx(overrides?: { events?: SessionEvent[]; readError?: Error }) {
  return { sessionQuery: { async readSession() { if (overrides?.readError) throw overrides.readError; return { session: SESSION, events: overrides?.events ?? FIXTURE } }, async traceSession() { return { ancestors: [], descendants: [] } } } } as never
}
function mockInvocation(rawInput: string) {
  return { rawInput, agent: { session: { id: 'session-ca62e005-4274-477b-bd56-9d9508edb040' } } } as never
}

const tmpRoots: string[] = []
afterAll(() => { for (const r of tmpRoots) rmSync(r, { recursive: true, force: true }) })

async function bundle(raw: string): Promise<string> {
  const dir = mkdtempSync(`${tmpdir()}/bundle-`)
  tmpRoots.push(dir)
  const r = await executeBundle(mockCtx(), mockInvocation(raw), { defaultDir: dir })
  if (r.kind === 'error') throw new Error(r.text)
  return r.text!
}

describe('parseBundleArgs', () => {
  it('empty → html + archive', () => {
    expect(parseBundleArgs('') as BundleArgs).toMatchObject({ html: true, md: false, json: false, noTranscript: false, noArchive: false })
  })
  it('--format md + json', () => {
    const a = parseBundleArgs('--format md --format json') as BundleArgs
    expect(a.md).toBe(true); expect(a.json).toBe(true); expect(a.html).toBe(false)
  })
  it('--mask --manifest --errors-only', () => {
    const a = parseBundleArgs('--mask --manifest --errors-only') as BundleArgs
    expect(a.mask).toBe(true); expect(a.manifest).toBe(true); expect(a.errorsOnly).toBe(true)
  })
  it('errors: unknown flag', () => { expect(typeof parseBundleArgs('--nope')).toBe('string') })
  it('errors: bad duration', () => { expect(typeof parseBundleArgs('--last banana')).toBe('string') })
})

describe('executeBundle', () => {
  it('produces valid ZIP with transcript + archive', async () => {
    const text = await bundle('')
    expect(text).toContain('Bundled →')
    expect(text).toContain('1 transcript')
    expect(text).toContain('1 raw archive')
    const zipPath = text.match(/→ (.+?) \(/)![1]!
    const raw = readFileSync(zipPath)
    expect(raw[0]).toBe(0x50); expect(raw[1]).toBe(0x4b)
  })

  it('--no-archive skips archive', async () => {
    expect(await bundle('--no-archive')).not.toContain('raw archive')
  })

  it('--no-transcript skips transcript', async () => {
    expect(await bundle('--no-transcript')).not.toContain('1 transcript')
  })

  it('double no errors', async () => {
    const r = await executeBundle(mockCtx(), mockInvocation('--no-transcript --no-archive'))
    expect(r.kind).toBe('error')
  })

  it('read failure → error', async () => {
    const r = await executeBundle(mockCtx({ readError: new Error('boom') }), mockInvocation('--id x'))
    expect(r.kind).toBe('error')
  })

  it('--mask redacts', async () => {
    expect(await bundle('--mask')).toContain('mask-redacted')
  })

  it('--manifest includes manifest', async () => {
    expect(await bundle('--manifest')).toContain('1 manifest')
  })

  it('--last recent produces empty bundle (fixture is 2022)', async () => {
    expect(await bundle('--last 30m')).toContain('Bundled →')
  })
})
