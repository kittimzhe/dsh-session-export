## 1.7.0 — 2026-09-15

Policy pack completion: retention + output contract + stats export.

- **Retention** (`src/retention.ts`): `retentionDays` / `retentionMaxFiles` config — every successful `/transcript` run prunes old artifacts in the output directory (age cap, count cap, oldest first). Best-effort: stat/unlink failures never fail the export. Summary line appended on prune.
- **Output contract** (`src/contract.ts`): `contract` config — team-pinned constraints the model cannot weaken per run: `requireMask`, `requireMaskMode`, `allowedFormats`, `pinnedDir`. Violations fail fast with a readable explanation. `/transcript` overlays the contract after arg parsing and validates formats + destination before writing.
- **Presets upgraded**: `compliance` now pins mask-on + 90-day retention; `full` pins hash-mask + 365-day retention. Both enforce their mask mode as a contract.
- **/stats --json / --out**: machine-readable stats payload (`{generator, stats}`) to stdout or file; `--out` without `--json` writes the terminal card.
- 22 new tests (retention sweep semantics, contract overlay/checks, stats parser). 196/196 total, tsc clean.

# Changelog

## 1.2.0 — 2026-09-13

Evidence integrity release: the "deterministic evidence" positioning becomes verifiable.

- **`--manifest`** — write a `.manifest.json` sidecar for a `/transcript` run: generator, session identity, applied scope (entries, `--errors-only`, `--last`, `--full`), mask mode, and for every artifact the path, UTF-8 byte size, and SHA-256. `verifyManifest()` is exported so downstream tooling can recompute digests and prove the files are exactly what the generator wrote. Config `manifest: true` turns it on by default.
- **`--mask-hash`** — deterministic redaction: matched secrets become `#xxxxxxxx` (first 8 hex of SHA-256). The same secret always yields the same marker, so equality survives redaction without content leaking. `Bearer` prefixes stay verbatim; only the token digests. Config `maskMode: 'mask' | 'hash'` sets the default mode for `--mask`.
- Success message now reports redaction mode and the manifest path.
- README: shipped the P0 roadmap items; absolute LICENSE links (npm-page link fix).

## 1.1.0 — 2026-09-13

Report navigation and ergonomics release.

### Added

- **Per-turn folding** — the transcript groups into collapsible turn
  sections (turn number · duration · entry count); turns containing
  failures are flagged ⚠ in the summary.
- **Sticky toolbar** — for reports with 4+ turns or 12+ entries: TOC chips
  (top / timeline / tools / T1…Tn / ⚠ errors) plus a live search box.
- **Transcript search** — client-side, case-insensitive; filters entries,
  auto-expands matching turns, shows a match count; `/` focuses, `Esc`
  clears. Zero network, zero dependencies.
- **Copy buttons** — one-click copy for tool arguments, results, diffs,
  and reasoning blocks (Clipboard API with `execCommand` fallback;
  hover-revealed, hidden in print).
- Section anchors (`#timeline`, `#tools`, `#turn-N`) for deep-linking.

## 1.0.1 — 2026-09-13

- README language switcher now uses absolute GitHub URLs — the 中文 link
  works on the npm package page (npm hosts README.md only).
- Version strings report 1.0.1.

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
- **JSON syntax highlighting** — tool arguments and JSON results get token
  colors in the HTML report (pattern-based, zero dependencies).
- **Bilingual HTML labels** — `lang: zh | en` config (default `en`).
- **Native tooltips** — KPI cards, timeline bars, and sparkline bars carry
  `title` details; no script needed.
- **Error-jump anchor** — one click from the header to the first failed tool
  result, with smooth scroll and target highlight.
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
