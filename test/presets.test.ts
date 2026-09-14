import { describe, expect, it } from 'vitest'
import { resolvePreset, PRESETS } from '../src/presets.ts'
import type { PresetName } from '../src/presets.ts'

describe('PRESETS', () => {
  it('covers all declared preset names', () => {
    for (const name of Object.keys(PRESETS)) {
      expect(PRESETS[name as PresetName]).toBeDefined()
    }
  })

  it('baseline is empty', () => {
    expect(PRESETS.baseline).toEqual({})
  })

  it('compliance enables mask (plain) + manifest', () => {
    expect(PRESETS.compliance).toMatchObject({ mask: true, maskMode: 'mask', manifest: true })
  })

  it('full enables mask (hash) + manifest', () => {
    expect(PRESETS.full).toMatchObject({ mask: true, maskMode: 'hash', manifest: true })
  })
})

describe('resolvePreset', () => {
  it('defaults to baseline when no preset given', () => {
    const result = resolvePreset({})
    expect(result.mask).toBeUndefined()
    expect(result.manifest).toBeUndefined()
  })

  it('applies compliance defaults', () => {
    const result = resolvePreset({ preset: 'compliance' })
    expect(result.mask).toBe(true)
    expect(result.manifest).toBe(true)
    expect(result.maskMode).toBe('mask')
  })

  it('applies full defaults', () => {
    const result = resolvePreset({ preset: 'full' })
    expect(result.mask).toBe(true)
    expect(result.manifest).toBe(true)
    expect(result.maskMode).toBe('hash')
  })

  it('explicit config wins over preset', () => {
    const result = resolvePreset({ preset: 'compliance', mask: false, maskMode: 'hash' })
    expect(result.mask).toBe(false)
    expect(result.maskMode).toBe('hash')
    expect(result.manifest).toBe(true) // still from preset
  })

  it('fully explicit config overrides everything', () => {
    const result = resolvePreset({ preset: 'full', mask: false, maskMode: 'mask', manifest: false })
    expect(result.mask).toBe(false)
    expect(result.maskMode).toBe('mask')
    expect(result.manifest).toBe(false)
  })

  it('throws on unknown preset', () => {
    expect(() => resolvePreset({ preset: 'nope' as never })).toThrow(/Unknown preset/)
  })
})