import { describe, expect, it } from 'vitest'
import { maskText, maskEntries } from '../src/mask.ts'
import type { TranscriptEntry } from '../src/types.ts'

describe('maskText built-in rules', () => {
  it('masks bearer headers but keeps the scheme', () => {
    expect(maskText('Authorization: Bearer abc123XYZ-_+/==')).toBe('Authorization: Bearer [REDACTED]')
  })

  it('masks common prefixed API keys', () => {
    expect(maskText('key sk-abcdefghijklmnopqrstuvwxyz')).toBe('key [REDACTED]')
    expect(maskText('ghp_' + 'a'.repeat(30))).toBe('[REDACTED]')
    expect(maskText('AKIA' + 'A'.repeat(16))).toBe('[REDACTED]')
    expect(maskText('xoxb-' + 'a'.repeat(12))).toBe('[REDACTED]')
  })

  it('leaves short non-key strings intact', () => {
    expect(maskText('sk-short')).toBe('sk-short')
    expect(maskText('plain text 123')).toBe('plain text 123')
  })

  it('masks emails', () => {
    expect(maskText('contact me at jacky.zhao.biz@gmail.com please')).toBe(
      'contact me at [EMAIL] please',
    )
  })

  it('masks private key blocks wholesale', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----'
    expect(maskText(key)).toBe('[PRIVATE KEY REDACTED]')
  })

  it('applies extra user patterns', () => {
    expect(maskText('ticket OPS-1234', { extraPatterns: ['OPS-\\d+'] })).toBe('ticket [REDACTED]')
  })

  it('skips invalid extra patterns without failing', () => {
    expect(maskText('OPS-1234', { extraPatterns: ['(['] })).toBe('OPS-1234')
  })
})

describe('maskEntries', () => {
  it('masks text, reasoning, and tool arguments without mutating the input', () => {
    const original: TranscriptEntry = {
      seq: 1,
      time: 0,
      kind: 'assistant',
      message: {
        id: 'm1' as never,
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' } as never,
        content: [
          { type: 'text', text: 'mail me at a@b.io' },
          { type: 'reasoning', text: 'token ghp_' + 'b'.repeat(30) },
          { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{"cmd":"echo sk-abcdefghijklmnopqrst"}' },
        ],
      },
    }
    const masked = maskEntries([original])
    expect(original.message.content[0]).toMatchObject({ type: 'text', text: 'mail me at a@b.io' })
    const blocks = masked[0]?.message.content
    expect(blocks?.[0]).toMatchObject({ type: 'text', text: 'mail me at [EMAIL]' })
    expect(blocks?.[1]).toMatchObject({ type: 'reasoning', text: 'token [REDACTED]' })
    expect(blocks?.[2]).toMatchObject({ type: 'tool-call', arguments: '{"cmd":"echo [REDACTED]"}' })
    expect(masked[0]?.message.role).toBe('assistant')
  })

  it('masks nested tool-result text blocks', () => {
    const entry: TranscriptEntry = {
      seq: 2,
      time: 0,
      kind: 'tool-result',
      message: {
        id: 'm2' as never,
        role: 'user',
        source: { kind: 'tool', callId: 'c1' as never } as never,
        content: [
          { type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: 'user jack@example.com' }] },
        ],
      },
    }
    const masked = maskEntries([entry])
    const outer = masked[0]?.message.content[0]
    expect(outer).toMatchObject({
      type: 'tool-result',
      content: [{ type: 'text', text: 'user [EMAIL]' }],
    })
  })
})
