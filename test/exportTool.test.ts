import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createExportTool, type ExportEngine } from '../src/exportTool.ts'
import type { ExportToolResult } from '../src/exportTool.ts'
import type { SessionTraceLike } from '../src/command.ts'

const T = 1_700_000_000_000

function userMsg(seq: number, text: string): SessionEvent {
  return { type: 'user/message', seq, time: T + seq, surfaceOp: 'append', data: { role: 'user', source: { kind: 'input' }, content: [{ type: 'text', text }] } } as unknown as SessionEvent
}

function asstMsg(seq: number, text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: T + seq,
    surfaceOp: 'append',
    data: { message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-pro' }, content: [{ type: 'text', text }] } },
  } as unknown as SessionEvent
}

const SESSION: SessionHeader = { version: 0, id: 'session-ca62e005-4274-477b-bd56-9d9508edb040', createdAt: T, cwd: '/w' } as unknown as SessionHeader

const EVENTS: SessionEvent[] = [
  userMsg(1, 'fix the resume font'),
  asstMsg(2, 'on it, reading the css'),
  userMsg(3, 'Authorization: Bearer abc123def456ghi789jkl'),
]

function makeEngine(overrides: Partial<{ events: SessionEvent[]; trace: SessionTraceLike; fail: Error }> = {}): ExportEngine {
  return {
    async readSession() {
      if (overrides.fail !== undefined) throw overrides.fail
      return { session: SESSION, events: overrides.events ?? EVENTS }
    },
    async traceSession() {
      if (overrides.trace !== undefined) return overrides.trace
      throw new Error('no lineage')
    },
  }
}

const tmpRoots: string[] = []
afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

function tmpDefaultDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'export-tool-'))
  tmpRoots.push(dir)
  return dir
}

async function run(tool: ToolDefinition, args: Record<string, unknown>): Promise<ExportToolResult> {
  return (await tool.execute(args, { callId: 'c1', name: 'transcript_export', arguments: args, signal: new AbortController().signal } as never)) as ExportToolResult
}

describe('transcript_export tool definition', () => {
  it('declares the name, timeout, and schema-compatible output', () => {
    const tool = createExportTool(undefined, makeEngine())
    expect(tool.name).toBe('transcript_export')
    expect(tool.timeoutMs).toBe(15_000)
    const sample: ExportToolResult = {
      sessionId: 's1',
      format: 'html',
      written: ['/x/a.html'],
      manifest: null,
      messages: 3,
      toolCalls: 0,
      tokens: 10,
      maskMode: 'off',
      error: null,
    }
    expect(() => validateJsonSchemaValue((tool.output as { schema: Parameters<typeof validateJsonSchemaValue>[0] }).schema, sample)).not.toThrow()
  })
})

describe('transcript_export execute', () => {
  it('writes an HTML report with totals and no mask by default', async () => {
    const dir = tmpDefaultDir()
    const out = await run(createExportTool({ defaultDir: dir }, makeEngine()), { session_id: 'session-ca62e005-4274-477b-bd56-9d9508edb040' })
    expect(out.error).toBeNull()
    expect(out.format).toBe('html')
    expect(out.written).toHaveLength(1)
    expect(out.written[0]).toMatch(/\.html$/)
    expect(out.messages).toBe(3)
    expect(out.maskMode).toBe('off')
    const html = readFileSync(out.written[0]!, 'utf8')
    expect(html).toContain('fix the resume font')
    expect(html).toContain('Bearer abc123def456ghi789jkl')
  })

  it('honors format md and json', async () => {
    const dir = tmpDefaultDir()
    const md = await run(createExportTool({ defaultDir: dir }, makeEngine()), { session_id: 's-x', format: 'md' })
    expect(md.written[0]).toMatch(/\.md$/)
    const json = await run(createExportTool({ defaultDir: dir }, makeEngine()), { session_id: 's-x', format: 'json' })
    expect(json.written[0]).toMatch(/\.json$/)
    expect(JSON.parse(readFileSync(json.written[0]!, 'utf8')).generator).toContain('dsh-session-export v1.5.0')
  })

  it('masks secrets when asked and reports the mode', async () => {
    const dir = tmpDefaultDir()
    const out = await run(createExportTool({ defaultDir: dir }, makeEngine()), { session_id: 's-x', format: 'md', mask: true })
    expect(out.maskMode).toBe('mask')
    const md = readFileSync(out.written[0]!, 'utf8')
    expect(md).toContain('[REDACTED]')
    expect(md).not.toContain('abc123def456ghi789jkl')
  })

  it('writes a manifest sidecar with sha256 when asked', async () => {
    const dir = tmpDefaultDir()
    const out = await run(createExportTool({ defaultDir: dir }, makeEngine()), { session_id: 's-x', format: 'md', manifest: true })
    expect(out.manifest).toMatch(/\.manifest\.json$/)
    const manifest = JSON.parse(readFileSync(out.manifest!, 'utf8'))
    expect(manifest.artifacts).toHaveLength(1)
    expect(manifest.artifacts[0].path).toBe(out.written[0])
    expect(manifest.mask.mode).toBe('off')
    expect(manifest.generator).toContain('v1.5.0')
  })

  it('never overwrites: repeated exports create distinct timestamped files', async () => {
    const dir = tmpDefaultDir()
    const tool = createExportTool({ defaultDir: dir }, makeEngine())
    await run(tool, { session_id: 's-x' })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await run(tool, { session_id: 's-x' })
    const files = readdirSync(join(dir, 'dsh-transcripts'))
    expect(files.filter((f) => f.endsWith('.html'))).toHaveLength(2)
  })

  it('applies the last duration bound', async () => {
    const dir = tmpDefaultDir()
    const out = await run(createExportTool({ defaultDir: dir }, makeEngine()), { session_id: 's-x', format: 'md', last: '30m' })
    // Fixture times are from 2022; a 30m window from now must be empty.
    expect(out.messages).toBe(0)
    expect(out.error).toBeNull()
  })

  it('rejects an invalid last duration', async () => {
    const out = await run(createExportTool({ defaultDir: tmpDefaultDir() }, makeEngine()), { session_id: 's-x', last: 'banana' })
    expect(out.error).toContain('30m')
    expect(out.written).toEqual([])
  })

  it('degrades read failures to an error result', async () => {
    const out = await run(createExportTool({ defaultDir: tmpDefaultDir() }, makeEngine({ fail: new Error('nope') })), { session_id: 's-x' })
    expect(out.error).toContain('nope')
    expect(out.written).toEqual([])
  })

  it('rejects a missing session_id at the schema layer', async () => {
    const tool = createExportTool(undefined, makeEngine())
    await expect(
      tool.execute({} as never, { callId: 'c1', name: 'transcript_export', arguments: {}, signal: new AbortController().signal } as never),
    ).rejects.toThrow(/session_id/)
  })
})
