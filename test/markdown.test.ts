import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/render/markdown.ts'
import { renderJson } from '../src/render/json.ts'
import type { RenderInput, TranscriptEntry } from '../src/types.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

function userMessage(text: string): Message {
  return { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as unknown as Message
}

function assistantMessage(text: string, toolCall?: { name: string; args: string }): Message {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text }]
  if (toolCall) {
    content.push({ type: 'tool-call', id: 'call-1', name: toolCall.name, arguments: toolCall.args })
  }
  return {
    id: 'm2',
    role: 'assistant',
    content: content as never,
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-pro' },
  } as unknown as Message
}

function toolResult(text: string): Message {
  return {
    id: 'm3',
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text }] }],
    source: { kind: 'tool', callId: 'call-1' },
  } as unknown as Message
}

function entry(seq: number, message: Message, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  const kind: TranscriptEntry['kind'] =
    message.role === 'assistant' ? 'assistant' : message.source.kind === 'tool' ? 'tool-result' : 'user'
  return { seq, time: 1_700_000_000_000, kind, message, ...extra }
}

function input(entries: TranscriptEntry[], extra: Partial<RenderInput> = {}): RenderInput {
  return {
    header: {
      version: 0,
      id: '5712d6f0-d9b6-40e9-a060-11578030c2b8',
      createdAt: 1_700_000_000_000,
      cwd: '/tmp/project',
      agentPreset: 'standard',
    } as RenderInput['header'],
    entries,
    totals: { messages: entries.length, toolCalls: 1, inputTokens: 100, outputTokens: 50 },
    generator: 'dsh-session-export v0.1.0',
    generatedAt: 1_760_000_000_000,
    ...extra,
  }
}

describe('renderMarkdown', () => {
  it('renders header metadata table', () => {
    const md = renderMarkdown(input([entry(1, userMessage('hello'))]))
    expect(md).toContain('# DSH Session Transcript')
    expect(md).toContain('| Session | `5712d6f0-d9b6-40e9-a060-11578030c2b8` |')
    expect(md).toContain('| Project | /tmp/project |')
    expect(md).toContain('| Agent preset | standard |')
    expect(md).toContain('| Tokens (in/out) | 100 / 50 |')
  })

  it('renders user and assistant messages with provenance', () => {
    const md = renderMarkdown(
      input([entry(1, userMessage('check links')), entry(2, assistantMessage('all good'))]),
    )
    expect(md).toContain('### 👤 User')
    expect(md).toContain('check links')
    expect(md).toContain('### 🤖 Assistant')
    expect(md).toContain('*deepseek / deepseek-v4-pro*')
    expect(md).toContain('all good')
  })

  it('renders str_replace_editor tool call as diff block', () => {
    const args = JSON.stringify({
      file_path: 'docs/tui.md',
      old_string: 'old line',
      new_string: 'new line',
    })
    const md = renderMarkdown(input([entry(1, assistantMessage('editing', { name: 'str_replace_editor', args }))]))
    expect(md).toContain('#### 🔧 Tool Call — `str_replace_editor`')
    expect(md).toContain('```diff')
    expect(md).toContain('-old line')
    expect(md).toContain('+new line')
  })

  it('renders tool result with call correlation', () => {
    const md = renderMarkdown(input([entry(1, toolResult('done: 0'))]))
    expect(md).toContain('### 🧾 Tool Result — call `call-1`')
    expect(md).toContain('done: 0')
  })

  it('renders reasoning inside details', () => {
    const message = {
      id: 'm2',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking hard' },
        { type: 'text', text: 'answer' },
      ],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-pro' },
    } as unknown as Message
    const md = renderMarkdown(input([entry(1, message)]))
    expect(md).toContain('<details>')
    expect(md).toContain('thinking hard')
    expect(md).toContain('answer')
  })

  it('renders lineage when present', () => {
    const md = renderMarkdown(
      input([entry(1, userMessage('hi'))], {
        lineage: {
          ancestors: [{ id: 'parent-session-id-1', createdAt: 1_600_000_000_000 }],
          descendants: [
            { id: 'child-session-id-1', createdAt: 1_700_000_000_000, origin: 'subagent', children: [] },
          ],
        },
      }),
    )
    expect(md).toContain('## Lineage')
    expect(md).toContain('`parent-s` → **this session**')
    expect(md).toContain('`child-se` (subagent)')
  })

  it('omits lineage section when absent', () => {
    const md = renderMarkdown(input([entry(1, userMessage('hi'))]))
    expect(md).not.toContain('## Lineage')
  })

  it('renders log-only appendix for --full', () => {
    const md = renderMarkdown(
      input([entry(1, userMessage('hi'))], {
        logOnly: [{ seq: 0, time: 1_700_000_000_000, type: 'command/run', summary: '/transcript' }],
      }),
    )
    expect(md).toContain('## Log-only Events')
    expect(md).toContain('`command/run`')
    expect(md).toContain('/transcript')
  })
})

describe('renderJson', () => {
  it('produces a versioned structured document', () => {
    const json = renderJson(input([entry(1, userMessage('hi'))]))
    const doc = JSON.parse(json)
    expect(doc.format).toBe('dsh-session-transcript')
    expect(doc.formatVersion).toBe(1)
    expect(doc.session.id).toBe('5712d6f0-d9b6-40e9-a060-11578030c2b8')
    expect(doc.transcript).toHaveLength(1)
    expect(doc.transcript[0].kind).toBe('user')
  })
})
