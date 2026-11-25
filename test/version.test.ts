import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { GENERATOR } from '../src/command.ts'
import { VERSION } from '../src/version.ts'

describe('version guard', () => {
  it('src/version.ts VERSION matches package.json version', async () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string }
    expect(pkg.version).toBe(VERSION)
  })

  it('GENERATOR stamps the current version, not a stale literal', () => {
    expect(GENERATOR).toBe(`dsh-session-export v${VERSION}`)
  })
})
