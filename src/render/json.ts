/** Structured JSON transcript renderer — machine-readable replay-friendly output. */
import type { RenderInput, TranscriptEntry } from '../types.ts'

function serializeEntry(entry: TranscriptEntry): unknown {
  return {
    seq: entry.seq,
    time: entry.time,
    kind: entry.kind,
    role: entry.message.role,
    source: entry.message.source,
    content: entry.message.content,
    ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  }
}

/** Render the complete JSON transcript document. */
export function renderJson(input: RenderInput): string {
  const doc = {
    format: 'dsh-session-transcript',
    formatVersion: 1,
    generator: input.generator,
    generatedAt: input.generatedAt,
    session: input.header,
    totals: input.totals,
    ...(input.lineage !== undefined ? { lineage: input.lineage } : {}),
    transcript: input.entries.map(serializeEntry),
    ...(input.logOnly !== undefined ? { logOnly: input.logOnly } : {}),
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}
