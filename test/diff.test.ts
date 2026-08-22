import { describe, expect, it } from 'vitest'
import { renderEditorDiff, renderToolDiff, parseToolArguments } from '../src/render/diff.ts'

describe('renderToolDiff', () => {
  it('renders edit tool old/new replacement', () => {
    const body = renderToolDiff('edit', {
      file_path: 'src/a.ts',
      old_string: 'foo()',
      new_string: 'bar()',
    })
    expect(body).toBe(['--- a/src/a.ts', '+++ b/src/a.ts', '@@ edit @@', '-foo()', '+bar()'].join('\n'))
  })

  it('renders write tool content as all-added', () => {
    const body = renderToolDiff('write', { file_path: 'new.md', content: 'a\nb' })
    expect(body).toBe(['--- a/new.md', '+++ b/new.md', '@@ edit @@', '+a', '+b'].join('\n'))
  })

  it('covers str_replace_editor naming too', () => {
    const body = renderToolDiff('str_replace_editor', {
      file_path: 'x.md',
      old_string: 'x',
      new_string: 'y',
    })
    expect(body).toContain('-x')
    expect(body).toContain('+y')
  })

  it('returns null for non-editor tools', () => {
    expect(renderToolDiff('bash', { command: 'ls' })).toBeNull()
    expect(renderToolDiff('read', { file_path: 'a' })).toBeNull()
  })

  it('returns null for editor tool without mutation fields', () => {
    expect(renderToolDiff('edit', { file_path: 'a' })).toBeNull()
  })
})

describe('renderEditorDiff', () => {
  it('renders old/new replacement as a diff body', () => {
    const body = renderEditorDiff({
      file_path: 'docs/readme.md',
      old_string: 'use `https://api.deepseeki.com` for the China endpoint',
      new_string: 'official host for the China endpoint',
    })
    expect(body).toBe(
      [
        '--- a/docs/readme.md',
        '+++ b/docs/readme.md',
        '@@ str_replace @@',
        '-use `https://api.deepseeki.com` for the China endpoint',
        '+official host for the China endpoint',
      ].join('\n'),
    )
  })

  it('renders create (file_text, no old_string) as all-added', () => {
    const body = renderEditorDiff({ command: 'create', file_path: 'a.txt', file_text: 'line1\nline2' })
    expect(body).toBe(
      ['--- a/a.txt', '+++ b/a.txt', '@@ str_replace @@', '+line1', '+line2'].join('\n'),
    )
  })

  it('returns null when nothing replaceable', () => {
    expect(renderEditorDiff(null)).toBeNull()
    expect(renderEditorDiff({ command: 'view', file_path: 'a.txt' })).toBeNull()
    expect(renderEditorDiff('string')).toBeNull()
  })
})

describe('parseToolArguments', () => {
  it('parses valid JSON', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 })
  })
  it('returns null on invalid JSON', () => {
    expect(parseToolArguments('not json')).toBeNull()
  })
})
