/**
 * Sensitive-data masking for rendered exports.
 *
 * Applied as a pre-pass over {@link TranscriptEntry} text fields so every
 * renderer (Markdown, HTML, JSON) benefits and JSON stays structurally valid:
 * replacement markers contain no quotes or backslashes.
 *
 * Two replacement modes: `mask` (fixed placeholders — the default) and `hash`
 * (deterministic `#xxxxxxxx` digest of the matched secret: the same secret
 * always yields the same marker, so equality survives redaction without the
 * content leaking).
 *
 * @module dsh-session-export/mask
 */
import { createHash } from 'node:crypto'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { TranscriptEntry } from './types.ts'

/** How matched secrets are replaced. */
export type MaskMode = 'mask' | 'hash'

interface MaskRule {
  readonly name: string
  readonly pattern: RegExp
  readonly replacement: string
}

/**
 * Built-in rules. Ordered most-specific first; order matters only for rules
 * that can overlap (Bearer header text also matching a prefixed key).
 */
const BUILTIN_RULES: readonly MaskRule[] = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[PRIVATE KEY REDACTED]',
  },
  {
    name: 'bearer',
    pattern: /\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g,
    replacement: '$1[REDACTED]',
  },
  {
    name: 'prefixed-key',
    pattern:
      /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    replacement: '[REDACTED]',
  },
  {
    name: 'email',
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g,
    replacement: '[EMAIL]',
  },
]

export interface MaskOptions {
  /** Extra user-supplied patterns (source strings) applied after the builtins. */
  readonly extraPatterns?: readonly string[]
  /** Replacement mode: fixed placeholders (`mask`, default) or deterministic digests (`hash`). */
  readonly mode?: MaskMode
}

function compileRules(options?: MaskOptions): readonly MaskRule[] {
  const extra = (options?.extraPatterns ?? []).map((source, index) => {
    try {
      return { name: `extra-${index}`, pattern: new RegExp(source, 'g'), replacement: '[REDACTED]' }
    } catch {
      // An invalid user pattern is skipped; a silent skip keeps the export
      // running — the surrounding tool result already carries the raw text.
      return null
    }
  })
  return [...BUILTIN_RULES, ...(extra.filter((rule): rule is MaskRule => rule !== null))]
}

/**
 * Mask one free-text value in place under the compiled rules.
 * @param text - Raw text.
 * @param rules - Compiled rules.
 * @returns Masked text (the same reference when nothing matched).
 */
function applyRules(text: string, rules: readonly MaskRule[], mode: MaskMode): string {
  let out = text
  for (const rule of rules) {
    if (mode === 'hash') {
      // groups[0] is the full match; groups[1], when the rule defines it, is the
      // retained literal prefix (e.g. "Bearer ") that must stay verbatim.
      out = out.replace(rule.pattern, (...groups: string[]) => {
        const full = groups[0] ?? ''
        // Only a real capture group counts as a retained prefix; without one,
        // groups[1] is the match offset (a number) and must be ignored.
        const prefix = typeof groups[1] === 'string' ? groups[1] : ''
        return prefix + hashMarker(full.slice(prefix.length))
      })
    } else {
      out = out.replace(rule.pattern, rule.replacement)
    }
  }
  return out
}

/** Deterministic short digest marker: same secret → same marker, forever. */
function hashMarker(secret: string): string {
  return `#${createHash('sha256').update(secret).digest('hex').slice(0, 8)}`
}

/**
 * Mask user-visible text inside a message's content blocks. Structural
 * fields (ids, names, kinds) stay verbatim so tool-call/result pairing
 * and lineage references keep resolving.
 * @param message - Message to mask (mutated in place for efficiency).
 * @param rules - Compiled rules.
 */
function maskMessage(message: Message, rules: readonly MaskRule[], mode: MaskMode): void {
  for (const block of message.content) {
    if (block.type === 'text' || block.type === 'reasoning') {
      block.text = applyRules(block.text, rules, mode)
    } else if (block.type === 'tool-call') {
      block.arguments = applyRules(block.arguments, rules, mode)
    } else if ('content' in block) {
      for (const inner of block.content) {
        if (inner.type === 'text') inner.text = applyRules(inner.text, rules, mode)
      }
    }
  }
}

/**
 * Mask a read-only entry list into a new array with masked copies.
 * @param entries - Original entries (never mutated).
 * @param options - Mask options.
 * @returns New entry array with masked message content; entry/ordering metadata unchanged.
 */
export function maskEntries(
  entries: readonly TranscriptEntry[],
  options?: MaskOptions,
): TranscriptEntry[] {
  const rules = compileRules(options)
  const mode = options?.mode ?? 'mask'
  return entries.map((entry) => ({
    ...entry,
    message: (() => {
      const copy = structuredClone(entry.message)
      maskMessage(copy, rules, mode)
      return copy
    })(),
  }))
}

/**
 * Mask a bare string (exported for tests and direct use).
 * @param text - Raw text.
 * @param options - Mask options.
 * @returns Masked text.
 */
export function maskText(text: string, options?: MaskOptions): string {
  return applyRules(text, compileRules(options), options?.mode ?? 'mask')
}
