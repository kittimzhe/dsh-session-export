/** Truncate long text with an explicit marker of how much was cut. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} more chars]`
}
