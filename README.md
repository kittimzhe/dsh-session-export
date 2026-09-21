# dsh-session-export

English | [中文](https://github.com/kittimzhe/dsh-session-export/blob/main/README.zh.md)

[![CI](https://github.com/kittimzhe/dsh-session-export/actions/workflows/test.yml/badge.svg)](https://github.com/kittimzhe/dsh-session-export/actions/workflows/test.yml) [![npm version](https://img.shields.io/npm/v/dsh-session-export)](https://www.npmjs.com/package/dsh-session-export) [![npm downloads](https://img.shields.io/npm/dm/dsh-session-export)](https://www.npmjs.com/package/dsh-session-export) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/kittimzhe/dsh-session-export/blob/main/LICENSE)

Deterministic session evidence reports for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): `/transcript` writes a **styled single-file HTML report** or Markdown/JSON transcript, `/stats` prints a terminal stats card, and `/archive` writes raw session logs as per-session ZIPs — all to a **host path**, on any persistence backend (JSONL or SQLite).

**Reads the session log itself through `ctx.sessionQuery` — no recorder, no resident memory, no drift.** Sessions that existed before the plugin was installed export just as well as live ones.

## Quick Start

**Requirements**: Node.js 20 or 22 · a DeepSeek Harness profile that mounts the `commands` and `sessionQuery` services (the shipped `web` / `agent` profiles qualify).

```sh
dsh plugin --profile web add dsh-session-export
```

Then, inside any session:

```text
/transcript        # single-file HTML replay report of the current session
/stats             # terminal stats card with cost estimate
```

Full details — GitHub install route, `cordis.patch.yml` snippet, configuration — in [Install](#install-out-of-tree-plugin) below.

## Positioning

`dsh-session-export` is a **session evidence layer**, not a memory optimizer.

- It focuses on **auditability** (what happened, in which order, with what failures).
- It focuses on **reproducibility** (stable outputs, portable files, deterministic render).
- It focuses on **operations** (batch archive, host-path artifacts, print-ready reports).

If your primary goal is context compression or long-term semantic memory, use a memory framework; if your primary goal is evidence, review, and postmortem quality, use this plugin.

## Competitive context

| Capability focus | Official `/export` | Recorder-style exporter | Memory frameworks | `dsh-session-export` |
|---|---|---|---|---|
| Primary outcome | Raw artifact download | Human-readable transcript | Context/memory optimization | **Evidence-grade replay report** |
| Data source | Raw log package | Side-channel listener | Derived memory structures | **Canonical session log (`sessionQuery`)** |
| Historical coverage | Backend-limited | Often partial without backfill | Usually selective recall | **Full history (incl. pre-install sessions)** |
| Persistence backends | JSONL only | What the listener saw | Framework-specific | **Any backend (JSONL, SQLite, …)** |
| Stats | — | In-panel counters | Framework-specific | **`/stats` card + cost estimate + tool ranking** |
| Lineage / diffs / timeline | — | — | — | **Mermaid lineage, editor diffs, turn timeline** |
| Batch | — | — | — | **`/archive --all --since`** |
| Operational artifacts | Browser ZIP | Usually one-off exports | Memory state / indexes | **HTML/MD/JSON + `/stats` + `/archive` ZIPs** |

Official ecosystem note (2026-09): the official `@deepseek-ai/dsh-session-log-export` (browser download of raw JSONL/zstd ZIP, JSONL backend only) and `@deepseek-ai/dsh-session-stats` (base stats projection) are the raw-utility layer; this plugin is the evidence layer built on top — deterministic replay reports, SHA-256 manifests, redaction, policy packs, output contracts, `/diff` and `/bundle`.

## Roadmap

- **P1: report diff mode** — compare two exports and generate a structured session delta report (shipped in v1.6.0 → `/diff <id1> <id2>`).
- **P1: policy pack** — team-level presets for masking, retention, and output contract (shipped in v1.5.0 → `preset: 'compliance' | 'full'`).
- **P2: bundle handoff** — one command to package replay report + raw archive + manifest for review workflows (shipped in v1.4.0 → `/bundle`).

## Why

The shipped `@deepseek-ai/dsh-session-log-export` downloads a raw JSONL/zstd ZIP through the browser and supports the JSONL backend only. This plugin covers what it explicitly defers (see the table above).

Transcript semantics follow `@deepseek-ai/dsh-session/surface`: the plugin renders **append-origin surface events** — everything the user actually saw — instead of the model-visible surface, whose compaction replacements would erase conversation the user already read.

## Commands

| Input | Result |
|---|---|
| `/transcript` | Export the current session → `<session cwd>/dsh-transcripts/transcript-<id8>-<timestamp>.md` |
| `/transcript --html` | **Single-file HTML report**: KPI cards, turn timeline, tool ranking, error highlighting, dark/light theme, print-to-PDF |
| `/transcript --json` / `--md` / `--html` | Pick any combination of formats |
| `/transcript <path>` / `--out <path>` | Write to the given path (spaces allowed after `--out`) |
| `/transcript --id <sessionId>` | Export another session |
| `/transcript --last 30m` | **Partial export**: entries from the last 30 minutes (`7d`/`12h`/`30m`/`90s`) |
| `/transcript --errors-only` | **Debug view**: failed tool results with a two-entry context window |
| `/transcript --mask` | **Redact likely secrets** (API keys, bearer tokens, private keys, emails) from the output |
| `/transcript --mask-hash` | **Deterministic redaction**: secrets become `#xxxxxxxx` digests — same secret → same marker, equality survives redaction |
| `/transcript --manifest` | **Evidence manifest**: write a `.manifest.json` sidecar with byte size + SHA-256 for every artifact of this run |
| `/transcript --full` | Append log-only events + Mermaid turn timeline |
| `/stats` | **Terminal stats card**: messages, turns, duration, tool calls (with failures), tokens, cost, per-tool ranking, sparkline — no files written |
| `/bundle` | **Review ZIP**: transcript report(s) + raw JSONL archive + sha256 evidence manifest — one command for audit/review workflows |
| `/bundle --mask --manifest` | Redacted transcript + evidence manifest |
| `/bundle --no-archive` | Transcript-only review pack |
| `/archive` | Archive the current session (incl. subagent descendants) → per-session ZIP |
| `/archive --all --since 7d` | Batch-archive every session from the last 7 days |
| `/diff <id1> <id2>` | **Session diff**: compare two sessions — common prefix, unique tails, stats delta (terminal or `--html` report) |

Like every `ctx.commands` command, all four run on the human-command plane: results never enter model history and cost zero tokens.

## Model-facing tool (v1.3)

Set `exposeTool: true` to register `transcript_export` — the same export kernel as a typed tool the model can call. The intended bridge: a `dsh-session-recall` hit returns a `sessionId`; the model hands it to `transcript_export` and the user gets a full evidence report on disk. One format per call (`html` default, `md` / `json`), optional `mask` / `manifest` / `last`; files always land in the standard `dsh-transcripts` directory (or `defaultDir`), with timestamped names that never overwrite. The tool is opt-in because it puts a host-file write in the model's hands.

## The HTML report

![HTML report (light theme)](https://github.com/kittimzhe/dsh-session-export/raw/main/docs/samples/report-light.png)
![HTML report (dark theme)](https://github.com/kittimzhe/dsh-session-export/raw/main/docs/samples/report-dark.png)

`/transcript --html` writes one self-contained file — no external CSS/JS, opens offline:

- **KPI cards**: messages, tool calls (failed highlighted), tokens in/out, duration, turns, cost
- **Turn timeline**: one colored bar per turn, proportional to wall-clock share
- **Tool ranking**: horizontal bars with per-tool failure counts
- **Token sparkline**: inline SVG, output tokens per assistant message
- **Error focus**: failed tool results get a red border, banner, and auto-open; a header link jumps straight to the first failure
- **JSON syntax highlighting**: tool arguments and JSON results get token colors (keys blue, strings green, numbers amber) — no external highlighter
- **Bilingual labels**: `lang: zh` renders the entire report in Chinese; default is English
- **Native tooltips**: hover KPI cards, timeline bars, and sparkline bars for details
- **Native folding**: tool arguments/results and reasoning in `<details>`
- **Per-turn folding**: the transcript groups into collapsible turns (duration · entry count · ⚠ flag); the sticky toolbar gives TOC chips + live search (`/` to focus) for long reports
- **Copy buttons**: one click to copy any tool argument/result/diff/reasoning block
- **Dark/light theme**: follows `prefers-color-scheme`, toggle button, remembered
- **Print → PDF**: `@media print` rules; printing auto-expands all folds — archival copies in one Cmd+P

Markdown output gains a **Mermaid lineage graph** (GitHub/VSCode render it natively) and a Mermaid turn-timeline gantt with `--full`.

## Cost estimation

Set a price table once and every export/stats run shows the estimated cost:

```yaml
- id: session-export
  name: 'dsh-session-export'
  config:
    pricing:
      inputPerMillion: 0.27   # your per-1M-input-token price
      outputPerMillion: 1.10  # your per-1M-output-token price
      currency: '$'           # label rendered next to the estimate
```

## Install (out-of-tree plugin)

From npm:

```sh
dsh plugin --profile web add dsh-session-export
```

Or from GitHub:

```sh
dsh plugin --profile web add github:kittimzhe/dsh-session-export
```

Then add to the profile's `cordis.patch.yml` (the row requires `commands` and `sessionQuery` services, which the shipped profiles already mount):

```yaml
- id: session-export
  name: 'dsh-session-export'
```

## Configuration

Plugin row config (all optional):

```yaml
- id: session-export
  name: 'dsh-session-export'
  config:
    preset: compliance                 # one-line policy pack: 'baseline' (default), 'compliance', 'full'
    defaultDir: /absolute/output/dir   # default: session cwd + dsh-transcripts/
    argCharLimit: 512                  # rendered tool-argument cap
    resultCharLimit: 2048              # rendered tool-result cap
    lang: zh                           # HTML report labels: 'en' (default) or 'zh'
    mask: true                         # redact secrets by default (--mask per run)
    maskMode: hash                     # replacement mode: 'mask' (placeholders, default) or 'hash' (deterministic digests)
    maskPatterns: ['OPS-\d+']          # extra masking regexes
    manifest: true                     # write a .manifest.json sidecar by default (--manifest per run)
    exposeTool: true                   # register the model-facing transcript_export tool (default false)
    pricing: { inputPerMillion: 0.27, outputPerMillion: 1.10, currency: '$' }
    archiveDir: /absolute/output/dir   # default: session cwd + .dsh-archives/
    includeDescendants: true           # /archive --id default
    maxSessionsPerRun: 100             # safety cap on /archive --all
```

## What the Markdown contains

- Header table: session id, project, created, agent preset, message/tool-call counts (failures), token totals, duration, cost, generator
- Lineage: Mermaid graph + ancestor chain and recursive subagent descendant tree
- Transcript in log order: user messages, assistant messages (provider/model provenance, token usage, collapsible reasoning), tool calls (arguments truncated; `str_replace_editor` rendered as ```diff blocks), tool results (error-aware)
- `--full`: Mermaid turn timeline + log-only events appendix

## Known limitations

- Exports run through the trusted `ctx.sessionQuery` seam; a composition without it cannot mount this plugin.
- Report bytes are not reproducible (embedded generation timestamps); `--manifest` provides integrity (SHA-256 per artifact), not reproducibility.
- Token totals sum per-assistant-message `usage` records; steps whose adapter reported no usage contribute zero.
- Cost is an estimate from list prices; cache-hit discounts are not modeled (`cacheReadTokens` is not priced separately).
- Masking is pattern-based and best-effort: it redacts common credential shapes, not all possible secrets.
- Markdown escapes nothing inside fenced blocks; a diff whose own lines start with `+`/`-` renders as additional diff lines (acceptable for a diff view).
- `/archive` is export-only: there is no restore/import because DSH exposes no write-side session seam, so the ZIP is a backup, not a round-trip.

## Development

Local type-checking of the tool module needs `@deepseek-ai/dsh-tools` (`^0.1.1-rc.2`, an optional peer) resolvable. Its transitive `@deepseek-ai/dsh-agent@0.1.1` line is currently unpublished on npm, so a fresh install cannot pull it — link the package from a checkout that already has it (e.g. a sibling `dsh-session-recall`):

```bash
ln -s ../dsh-session-recall/node_modules/@deepseek-ai/dsh-tools node_modules/@deepseek-ai/dsh-tools
```

## License

MIT

## Community

- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)
