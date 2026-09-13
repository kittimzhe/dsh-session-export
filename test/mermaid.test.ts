import { describe, expect, it } from 'vitest'
import { renderLineageMermaid, renderTimelineMermaid } from '../src/render/mermaid.ts'
import type { LineageInfo, TranscriptEntry } from '../src/types.ts'

const user = (time: number): TranscriptEntry => ({
  seq: 1,
  time,
  kind: 'user',
  message: { id: 'm' as never, role: 'user', source: { kind: 'user' } as never, content: [{ type: 'text', text: 'go' }] },
})

describe('renderLineageMermaid', () => {
  it('renders null for an empty lineage', () => {
    expect(renderLineageMermaid({ ancestors: [], descendants: [] }, 'self')).toBeNull()
  })

  it('renders ancestor chain into the self node', () => {
    const lineage: LineageInfo = { ancestors: [{ id: 'session-aaaa1111', createdAt: 1 }], descendants: [] }
    const out = renderLineageMermaid(lineage, 'session-bbbb2222')
    expect(out).toContain('graph TD')
    expect(out).toContain('saaaa1111')
    expect(out).toContain('← this session')
    expect(out).toContain('saaaa1111 --> sbbbb2222')
    expect(out).toContain('class sbbbb2222 self')
  })

  it('renders descendant trees recursively', () => {
    const lineage: LineageInfo = {
      ancestors: [],
      descendants: [
        {
          id: 'session-cccc3333',
          createdAt: 2,
          origin: 'subagent',
          children: [{ id: 'dddd4444', createdAt: 3, children: [] }],
        },
      ],
    }
    const out = renderLineageMermaid(lineage, 'self-id')
    expect(out).toContain('scccc3333["cccc3333 subagent"]')
    expect(out).toContain('sdddd4444')
    expect(out).toMatch(/sselfid --> scccc3333/)
    expect(out).toMatch(/scccc3333 --> sdddd4444/)
  })

  it('strips DSL-breaking characters from labels', () => {
    const lineage: LineageInfo = { ancestors: [{ id: 'evil"id', createdAt: 1 }], descendants: [] }
    const out = renderLineageMermaid(lineage, 'self')
    expect(out).not.toContain('evil"id')
    expect(out).toContain('sevilid[')
  })
})

describe('renderTimelineMermaid', () => {
  const base = 1_700_000_000_000
  it('renders null with fewer than two turns', () => {
    expect(renderTimelineMermaid([user(base)])).toBeNull()
    expect(renderTimelineMermaid([])).toBeNull()
  })

  it('emits one gantt task per turn with second-precision timestamps', () => {
    const out = renderTimelineMermaid([user(base), user(base + 60_000), user(base + 180_000)])
    expect(out).toContain('gantt')
    expect(out).toContain('dateFormat X')
    expect(out).toContain('Turn 1 :t1,')
    expect(out).toContain('Turn 3 :t3,')
    expect(out).toContain(', 60s')
    expect(out).toContain(String(Math.round(base / 1000)))
  })

  it('ends the last turn at the final entry time', () => {
    const out = renderTimelineMermaid([user(base), user(base + 10_000)])
    expect(out).toContain(', 0s')
  })
})
