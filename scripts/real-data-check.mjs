/**
 * Real-data validation harness (dev-only, not shipped).
 *
 * Loads a REAL session log from ~/.dsh/sessions through the same upstream
 * decode path the persistence backend uses (zstd frames + packed chunk rows),
 * then runs this plugin's full render pipeline and writes the transcript.
 *
 * Usage: node scripts/real-data-check.mjs <path-to-session.jsonl.zstd> [out.md]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { decodeStorageRecord } from '@deepseek-ai/dsh-session'
import {
  buildEntries,
  buildTotals,
  buildLogOnly,
  renderMarkdown,
  renderJson,
} from '../lib/index.js'

const input = process.argv[2]
if (!input) {
  console.error('usage: node scripts/real-data-check.mjs <session.jsonl.zstd> [out.md]')
  process.exit(1)
}

/**
 * Decompress a concatenation of independent zstd frames (the JSONL backend's
 * on-disk format: one checksummed frame per durable append batch). Node's
 * public API decodes only the first frame, so split on the zstd magic number
 * and decode each frame separately.
 */
function decompressFrames(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let pos = 0
  for (;;) {
    const idx = buffer.indexOf(MAGIC, pos)
    if (idx === -1) break
    starts.push(idx)
    pos = idx + 4
  }
  if (starts.length === 0) throw new Error('no zstd frames found')
  const chunks = []
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch (error) {
      // A torn final frame is normal for a live session still being appended;
      // the official backend truncates the same way. Any non-final frame
      // failure is a real defect, so rethrow there.
      if (i !== starts.length - 1) throw error
      console.warn(`(torn final frame at byte ${start} skipped — live session)`)
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

const compressed = readFileSync(input)
const text = decompressFrames(compressed)
const lines = text.split('\n').filter((line) => line.length > 0)

const header = JSON.parse(lines[0] ?? '{}')
const events = []
for (let i = 1; i < lines.length; i += 1) {
  events.push(...decodeStorageRecord(JSON.parse(lines[i] ?? 'null')))
}

console.log(`session: ${header.id}`)
console.log(`storage lines: ${lines.length - 1} → decoded events: ${events.length}`)
console.log(`cwd: ${header.cwd ?? '(none)'} · preset: ${header.agentPreset ?? '(none)'} · version: ${header.version}`)

const entries = buildEntries(events)
const totals = buildTotals(entries)
const logOnly = buildLogOnly(events)
console.log(
  `entries: ${entries.length} (user ${entries.filter((e) => e.kind === 'user').length}, ` +
    `assistant ${entries.filter((e) => e.kind === 'assistant').length}, ` +
    `tool-result ${entries.filter((e) => e.kind === 'tool-result').length})`,
)
console.log(`tool calls: ${totals.toolCalls} · tokens in/out: ${totals.inputTokens}/${totals.outputTokens}`)
console.log(`log-only events: ${logOnly.length}`)

const inputDoc = {
  header,
  entries,
  logOnly,
  totals,
  generator: 'dsh-session-export v0.1.0 (real-data-check)',
  generatedAt: Date.now(),
}

const md = renderMarkdown(inputDoc)
const json = renderJson(inputDoc)
const outBase = process.argv[3] ?? '/tmp/dsh-transcript-real.md'
writeFileSync(outBase, md)
writeFileSync(outBase.replace(/\.md$/, '.json'), json)
console.log(`wrote: ${outBase} (${md.length} chars) + .json (${json.length} chars)`)
console.log('--- first 60 lines of markdown ---')
console.log(md.split('\n').slice(0, 60).join('\n'))
