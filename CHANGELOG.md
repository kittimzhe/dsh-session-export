# Changelog

## 1.0.0 — 2026-09-13

Session replay report release: the plugin graduates from "export" to "report tooling".

### Added

- **`/transcript --html` — single-file HTML report** (zero external dependencies):
  KPI cards (messages, tool calls with failures, tokens, duration, turns, cost),
  turn timeline bars, tool ranking bars, inline-SVG token sparkline,
  error-highlighted tool results, native `<details>` folding, dark/light theme
  (system-following, toggleable, remembered), and print-to-PDF rules that
  auto-expand folds on print.
- **`/stats` command** — terminal stats card without writing files: messages,
  turns, duration, tool calls (failures attributed via callId), tokens, cost,
  per-tool ranking with bars, and an output-token sparkline. ANSI color opt-in.
- **Token cost estimation** — `pricing` config (`inputPerMillion`,
  `outputPerMillion`, `currency`); cost appears in the stats card, HTML KPI
  cards, Markdown header, and JSON output.
- **`--last <duration>`** — partial export limited to recent entries
  (`7d`/`12h`/`30m`/`90s`), same grammar as `/archive --since`.
- **`--errors-only`** — debug view: failed tool results with a two-entry
  context window; a filter note marks the output as a filtered view.
- **`--mask` / `mask` config** — redact likely secrets (Bearer headers,
  prefixed API keys, private-key blocks, emails) as a pre-render pass over
  message content, so all renderers benefit and JSON stays valid. Extra
  patterns via `maskPatterns`.
- **Mermaid diagrams in Markdown** — lineage graph (ancestor chain +
  subagent tree, self highlighted) and a turn-timeline gantt with `--full`;
  GitHub and VSCode render both natively.
- Markdown header gains duration, failed-call, and cost rows; JSON output
  gains `stats` and `filterNote`.

### Changed

- `/transcript` usage line lists the new flags; format flags compose freely
  (`--md --html --json`).
- Generator/tool version strings report 1.0.0.

### Internal

- Duration parsing shared between `/transcript --last` and `/archive --since`
  (`util/duration.ts`).
- Stats computation shared by `/stats`, HTML, Markdown, and JSON renderers.
- Test suite grown from 46 to 94 cases (stats, mask, mermaid, html, command).

## 0.2.0 — 2026-08-29

- `/archive --since <duration>` time-range filter and `--no-descendants`.
- Archive manifest lineage fields (parent session, delegation depth).

## 0.1.0 — 2026-08-23

- Initial release: `/transcript` (Markdown/JSON to a host path via
  `ctx.sessionQuery`) and `/archive` (per-session ZIPs).
