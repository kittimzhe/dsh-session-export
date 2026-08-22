/**
 * Render `str_replace_editor` tool-call arguments as a unified-diff-looking
 * fenced block. Only that tool's argument shape is understood; every other
 * tool falls back to pretty-printed JSON in the markdown renderer.
 */

interface StrReplaceEditorArgs {
  command?: string
  file_path?: string
  old_string?: string
  new_string?: string
  file_text?: string
}

/** Parse the raw JSON arguments string of a tool call; null when not JSON. */
export function parseToolArguments(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function diffLine(prefix: '-' | '+', line: string): string {
  return `${prefix}${line}`
}

/**
 * Build a ```diff fenced body for an editor replacement, or null when the
 * arguments do not describe one.
 */
export function renderEditorDiff(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const a = args as StrReplaceEditorArgs
  const hasOld = typeof a.old_string === 'string'
  const hasNew = typeof a.new_string === 'string'
  const hasFileText = typeof a.file_text === 'string'
  if (!hasNew && !hasFileText) return null

  const header = typeof a.file_path === 'string' ? a.file_path : '(unknown file)'
  const lines: string[] = [`--- a${pathPrefix(header)}`, `+++ b${pathPrefix(header)}`, '@@ str_replace @@']
  if (hasOld && a.old_string !== undefined) {
    for (const line of a.old_string.split('\n')) lines.push(diffLine('-', line))
  }
  const added = hasFileText ? a.file_text : a.new_string
  if (added !== undefined) {
    for (const line of added.split('\n')) lines.push(diffLine('+', line))
  }
  return lines.join('\n')
}

/** Diff header prefix: 'a/' for relative paths, 'a' + path for absolute ones. */
function pathPrefix(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

/** Tool names whose arguments describe file mutations worth a diff view. */
const DIFF_TOOL_NAMES = new Set(['str_replace_editor', 'edit', 'write'])

interface EditLikeArgs {
  file_path?: string
  old_string?: string
  new_string?: string
  content?: string
  file_text?: string
}

/**
 * Render a tool call's arguments as a diff body when the tool is a known
 * file-mutating editor (`str_replace_editor`, `edit`, or `write`); null for
 * anything else or for arguments that describe no mutation. Deployment tool
 * names differ (package names vs registered names), so all three are covered.
 */
export function renderToolDiff(toolName: string, args: unknown): string | null {
  if (!DIFF_TOOL_NAMES.has(toolName)) return null
  if (typeof args !== 'object' || args === null) return null
  const a = args as EditLikeArgs
  const header = typeof a.file_path === 'string' ? a.file_path : '(unknown file)'
  const lines: string[] = [`--- a${pathPrefix(header)}`, `+++ b${pathPrefix(header)}`, '@@ edit @@']
  if (typeof a.old_string === 'string') {
    for (const line of a.old_string.split('\n')) lines.push(diffLine('-', line))
  }
  const added = typeof a.new_string === 'string'
    ? a.new_string
    : typeof a.file_text === 'string'
      ? a.file_text
      : typeof a.content === 'string'
        ? a.content
        : undefined
  if (added === undefined) return null
  for (const line of added.split('\n')) lines.push(diffLine('+', line))
  return lines.join('\n')
}
