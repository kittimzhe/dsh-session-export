import { describe, expect, it } from 'vitest'
import { buildManifest, describeArtifact, renderManifest, sha256Text, verifyManifest } from '../src/manifest.ts'

const artifacts = [
  { path: 'transcript-x.md', content: '# hello\n' },
  { path: 'transcript-x.html', content: '<html>hi</html>' },
]

function manifest() {
  return buildManifest({
    generator: 'dsh-session-export v1.2.0',
    createdAt: 1_757_800_000_000,
    session: { id: 'session-abc', createdAt: 1_757_000_000_000 },
    scope: { entries: 12, errorsOnly: true, since: 1_757_700_000_000, full: false },
    mask: { mode: 'hash' },
    artifacts: artifacts.map((a) => describeArtifact(a.path, a.content)),
  })
}

describe('sha256Text', () => {
  it('produces lowercase hex of UTF-8 bytes', () => {
    expect(sha256Text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Text('中文')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('describeArtifact', () => {
  it('records path, UTF-8 byte size, and digest', () => {
    const a = describeArtifact('p.md', 'héllo')
    expect(a.path).toBe('p.md')
    expect(a.bytes).toBe(6) // h(1) é(2) l l o
    expect(a.sha256).toBe(sha256Text('héllo'))
  })
})

describe('buildManifest / renderManifest', () => {
  it('carries scope, mask mode, and one record per artifact', () => {
    const m = manifest()
    expect(m.scope.entries).toBe(12)
    expect(m.scope.since).toBe(1_757_700_000_000)
    expect(m.mask.mode).toBe('hash')
    expect(m.artifacts).toHaveLength(2)
    expect(m.artifacts[0]?.path).toBe('transcript-x.md')
  })

  it('renders stable JSON with a trailing newline and omits absent since', () => {
    const m = buildManifest({
      generator: 'g',
      createdAt: 1,
      session: { id: 's', createdAt: 1 },
      scope: { entries: 0, errorsOnly: false, full: false },
      mask: { mode: 'off' },
      artifacts: [],
    })
    const text = renderManifest(m)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).not.toContain('"since"')
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(m)))
  })

  it('omits since when undefined even in a full manifest', () => {
    const m = manifest()
    const parsed = JSON.parse(renderManifest(m)) as { scope: { since?: number } }
    expect(parsed.scope.since).toBe(1_757_700_000_000)
  })
})

describe('verifyManifest', () => {
  it('accepts untouched artifacts', () => {
    const m = manifest()
    const held = new Map(artifacts.map((a) => [a.path, a.content]))
    const v = verifyManifest(m, held)
    expect(v.ok).toBe(true)
    expect(v.checked).toBe(2)
    expect(v.mismatches).toEqual([])
  })

  it('flags tampered content by digest', () => {
    const m = manifest()
    const held = new Map([
      ['transcript-x.md', '# tampered\n'],
      ['transcript-x.html', artifacts[1]!.content],
    ])
    const v = verifyManifest(m, held)
    expect(v.ok).toBe(false)
    expect(v.mismatches).toEqual(['transcript-x.md: sha256 mismatch'])
  })

  it('flags missing artifacts', () => {
    const v = verifyManifest(manifest(), new Map())
    expect(v.ok).toBe(false)
    expect(v.mismatches).toEqual(['transcript-x.md: missing', 'transcript-x.html: missing'])
  })
})
