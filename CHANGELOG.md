## 1.8.6 — 2026-10-10

Connection-string redaction (via #8 by varshith84).

- Database connection URLs (`postgres/redis/rediss/mysql` schemes) in exported output now have their credentials redacted: handles URL-encoded passwords, IPv6 hosts, and multi-colon passwords.
- A lookbehind guard keeps passwordless URLs (`user@host`) from being mistaken for emails.
- First external contribution to land in the package.

## 1.8.5 — 2026-10-03

Docs polish round (no runtime changes).

- Install detail completed: requirements, GitHub install route, the `cordis.patch.yml` row.
- Contributor block links the open-gap issues directly; sample outputs aligned with the shipped version.
- Community section; bilingual issue templates (`.github/ISSUE_TEMPLATE/`).
- English/Chinese README sections kept in sync.

## 1.8.4 — 2026-10-02

Contributor-first docs release.

- README (en/zh): one-liner → install → try-once → toolchain table → 6-line contributor block; competitive/config sections moved below the fold.
- "all four" corrected to the five human-plane commands (`/transcript` `/stats` `/archive` `/bundle` `/diff`).
- Roadmap replaced by Current gaps linked to issues #5–#7; shipped roadmap items remain in the CHANGELOG.
- `npm run doctor` + `@deepseek-ai/dsh-tools` softlink moved to CONTRIBUTING Step 0.
- CHANGELOG backfilled for 1.8.1–1.8.3 (missing entries below).
- README.zh.md gains the Model-facing tool (v1.3) section + official ecosystem note; GitHub issue templates added.

## 1.8.3 — 2026-09-26

Peers aligned with harness 0.1.5-rc.3; test fixture header on the v3 SessionHeader schema.

## 1.8.2 — 2026-09-21

Governance docs (CONTRIBUTING/SECURITY/CoC), CI bundle/pack verification, quick-start docs, npm repository metadata + doctor self-check, session-toolchain cross-promo.

## 1.8.1 — 2026-09-19

CI test workflow green end-to-end (optional-peer installs, legacy-peer-deps for the mixed rc lines); docs clarifying the relationship to official plugins and near-name packages.

## 1.8.0 — 2026-09-15

Semantic diff: common suffix + change classification.

- `/diff` now strips the common suffix as well as the prefix, so shared endings (e.g. the same closing turns after a mid-session divergence) no longer pollute the "only in A/B" tails.
- The divergent middle region is classified into `added` / `removed` / `changed` blocks with entry index ranges on both sides — alternating-run alignment over entry fingerprints.
- Terminal output gains a "Changes (middle region, classified)" section with ＋/－/± markers; the HTML report gains color-coded change blocks with badges and per-side entry previews.
- Summary lines now show both common-prefix and common-suffix counts.
- 6 new tests. 202/202 total, tsc clean.

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
