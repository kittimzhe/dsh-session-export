# dsh-session-export

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-session-export)](https://www.npmjs.com/package/dsh-session-export) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Human-readable session transcript export for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the `/transcript` command writes a Markdown (and/or JSON) transcript of a session to a **host path** — no browser download, no raw-log decoding.

## Why

The shipped `@deepseek-ai/dsh-session-log-export` downloads a raw JSONL/zstd ZIP through the browser and supports the JSONL backend only. This plugin covers what it explicitly defers:

| | official `/export` | this plugin `/transcript` |
|---|---|---|
| Output | raw log ZIP (browser download) | **Markdown / JSON written to a host path** |
| Persistence backends | JSONL only | **any backend behind `ctx.sessionQuery`** (JSONL, SQLite, …) |
| Content | machine artifacts | **human transcript**: messages, tool calls, editor diffs, subagent lineage, token totals |

Transcript semantics follow `@deepseek-ai/dsh-session/surface`: the plugin renders **append-origin surface events** — everything the user actually saw — instead of the model-visible surface, whose compaction replacements would erase conversation the user already read.

## Command contract

| Input | Result |
|---|---|
| `/transcript` | Export the current session → `<session cwd>/dsh-transcripts/transcript-<id8>-<timestamp>.md` |
| `/transcript <path>` | Write to the given path (`.md` appended when missing) |
| `/transcript --out <path>` | Like positional, but the rest of the line is the path (spaces allowed) |
| `/transcript --id <sessionId>` | Export another session |
| `/transcript --json` / `--md` | Pick the output format(s); default `--md` |
| `/transcript --full` | Append the log-only events appendix (command lifecycles, compaction markers) |

Like every `ctx.commands` command, `/transcript` runs on the human-command plane: the result never enters model history and costs zero tokens.

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

## What the Markdown contains

- Header table: session id, project, created, agent preset, message/tool-call counts, token totals, generator
- Lineage: ancestor chain and recursive subagent descendant tree
- Transcript in log order: user messages, assistant messages (provider/model provenance, token usage, collapsible reasoning), tool calls (arguments truncated; `str_replace_editor` rendered as ```diff blocks), tool results (error-aware)
- `--full`: log-only events appendix

## Configuration

Plugin row config (all optional):

```yaml
- id: session-export
  name: 'dsh-session-export'
  config:
    defaultDir: /absolute/output/dir   # default: session cwd + dsh-transcripts/
    argCharLimit: 512                  # rendered tool-argument cap
    resultCharLimit: 2048              # rendered tool-result cap
```

## Known limitations

- Exports run through the trusted `ctx.sessionQuery` seam; a composition without it cannot mount this plugin.
- Token totals sum per-assistant-message `usage` records; steps whose adapter reported no usage contribute zero.
- Markdown escapes nothing inside fenced blocks; a diff whose own lines start with `+`/`-` renders as additional diff lines (acceptable for a diff view).

## License

MIT
