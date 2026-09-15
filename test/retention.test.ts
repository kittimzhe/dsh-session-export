import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, utimes, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRetention, describeRetention, validateRetention } from '../src/retention.ts'
import { applyContract, checkFormats, checkPinnedDir, describeContract, parseExportFormat } from '../src/contract.ts'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'retention-'))
}

async function seedArtifact(dir: string, name: string, ageDays: number): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, 'x')
  const t = new Date(Date.now() - ageDays * 86_400_000)
  await utimes(path, t, t)
  return path
}

describe('retention', () => {
  it('validateRetention rejects bad values', () => {
    expect(validateRetention({ retentionDays: 0 })).toContain('retentionDays')
    expect(validateRetention({ retentionDays: -1 })).toContain('retentionDays')
    expect(validateRetention({ retentionMaxFiles: 0 })).toContain('retentionMaxFiles')
    expect(validateRetention({ retentionMaxFiles: 1.5 })).toContain('retentionMaxFiles')
    expect(validateRetention({ retentionDays: 30, retentionMaxFiles: 5 })).toBeUndefined()
    expect(validateRetention({})).toBeUndefined()
  })

  it('deletes artifacts older than retentionDays and keeps fresh ones', async () => {
    const dir = await makeDir()
    const old = await seedArtifact(dir, 'transcript-a-111.md', 100)
    await seedArtifact(dir, 'transcript-b-222.md', 1)
    const result = await applyRetention(dir, { retentionDays: 30 })
    expect(result.deleted.map((f) => f.path)).toEqual([old])
    expect(result.considered).toBe(2)
    const remaining = await readdir(dir)
    expect(remaining).toContain('transcript-b-222.md')
    expect(remaining).not.toContain('transcript-a-111.md')
  })

  it('enforces retentionMaxFiles by deleting oldest first', async () => {
    const dir = await makeDir()
    await seedArtifact(dir, 'transcript-old.md', 50)
    await seedArtifact(dir, 'bundle-mid-1.zip', 10)
    await seedArtifact(dir, 'transcript-new.md', 1)
    const result = await applyRetention(dir, { retentionMaxFiles: 1 })
    expect(result.deleted).toHaveLength(2)
    const remaining = await readdir(dir)
    expect(remaining).toEqual(['transcript-new.md'])
  })

  it('ignores files that are not plugin artifacts', async () => {
    const dir = await makeDir()
    await seedArtifact(dir, 'notes.md', 100)
    await seedArtifact(dir, 'archive-x-1.zip', 100)
    const result = await applyRetention(dir, { retentionDays: 30 })
    expect(result.deleted.map((f) => f.path.split('/').pop())).toEqual(['archive-x-1.zip'])
    expect(result.considered).toBe(1)
  })

  it('no-op when no options are set', async () => {
    const dir = await makeDir()
    await seedArtifact(dir, 'transcript-a-1.md', 400)
    const result = await applyRetention(dir, {})
    expect(result.deleted).toHaveLength(0)
    expect((await readdir(dir)).length).toBe(1)
  })

  it('never throws on an unreadable directory', async () => {
    const result = await applyRetention('/nonexistent-root-xyz/none', { retentionDays: 1 })
    expect(result.deleted).toHaveLength(0)
  })

  it('describeRetention formats a summary line', () => {
    const line = describeRetention({
      considered: 5,
      deleted: [
        { path: '/a/transcript-1.md', mtimeMs: 0 },
        { path: '/a/transcript-2.md', mtimeMs: 0 },
      ],
    })
    expect(line).toContain('pruned 2 old artifacts')
    expect(line).toContain('transcript-1.md')
    expect(describeRetention({ considered: 0, deleted: [] })).toBe('')
  })
})

describe('contract', () => {
  it('applyContract forces mask on', () => {
    const out = applyContract({ requireMask: true }, { mask: false })
    expect(out.mask).toBe(true)
  })

  it('applyContract forces maskMode', () => {
    const out = applyContract({ requireMaskMode: 'hash' }, { maskMode: 'mask' as const })
    expect(out.maskMode).toBe('hash')
  })

  it('applyContract passes through unpinned fields', () => {
    const out = applyContract({}, { mask: true, argCharLimit: 40 })
    expect(out.mask).toBe(true)
    expect(out.argCharLimit).toBe(40)
  })

  it('checkFormats rejects disallowed formats', () => {
    const contract = { allowedFormats: ['markdown' as const] }
    expect(checkFormats(contract, ['json'])).toContain('not allowed')
    expect(checkFormats(contract, ['markdown'])).toBeUndefined()
    expect(checkFormats({}, ['json'])).toBeUndefined()
  })

  it('checkPinnedDir rejects paths outside the pin', () => {
    const contract = { pinnedDir: '/safe/dir' }
    expect(checkPinnedDir(contract, '/safe/dir/out.md')).toBeUndefined()
    expect(checkPinnedDir(contract, '/safe/dir/sub/out.md')).toBeUndefined()
    expect(checkPinnedDir(contract, '/etc/passwd')).toContain('output contract')
    // prefix-escape: /safe dir vs /safe/dir2
    expect(checkPinnedDir({ pinnedDir: '/safe/dir' }, '/safe/dir2/out.md')).toContain('output contract')
    expect(checkPinnedDir(contract, undefined)).toBeUndefined()
  })

  it('describeContract lists all pins', () => {
    const line = describeContract({
      requireMask: true,
      requireMaskMode: 'hash',
      allowedFormats: ['markdown'],
      pinnedDir: '/evidence',
    })
    expect(line).toContain('mask required')
    expect(line).toContain('maskMode=hash')
    expect(line).toContain('markdown')
    expect(line).toContain('/evidence')
    expect(describeContract({})).toBe('output contract: none')
  })

  it('parseExportFormat recognizes known formats', () => {
    expect(parseExportFormat('markdown')).toBe('markdown')
    expect(parseExportFormat('json')).toBe('json')
    expect(parseExportFormat('html')).toBe('html')
    expect(parseExportFormat('yaml')).toBeUndefined()
  })
})
