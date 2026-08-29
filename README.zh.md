# dsh-session-export

[English](README.md) | 中文

[![CI](https://github.com/kittimzhe/dsh-session-export/actions/workflows/test.yml/badge.svg)](https://github.com/kittimzhe/dsh-session-export/actions/workflows/test.yml) [![npm version](https://img.shields.io/npm/v/dsh-session-export)](https://www.npmjs.com/package/dsh-session-export) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供会话导出：`/transcript` 把会话的 Markdown/JSON 转录**写到 Host 文件系统**，`/archive` 把原始会话日志写成逐会话 ZIP——两个命令都落到本机路径，且支持任意持久化后端（JSONL 或 SQLite）。

## 为什么需要它

官方 `@deepseek-ai/dsh-session-log-export` 通过浏览器下载原始 JSONL/zstd ZIP，且仅支持 JSONL 后端。本插件补上它明确推迟的部分：

| | 官方 `/export` | 本插件 `/transcript` |
|---|---|---|
| 输出 | 原始日志 ZIP（浏览器下载） | **写入 Host 路径的 Markdown / JSON** |
| 持久化后端 | 仅 JSONL | **`ctx.sessionQuery` 之后的任意后端**（JSONL、SQLite…） |
| 内容 | 机器工件 | **人类转录**：消息流、工具调用、编辑器 diff、子代理谱系、token 汇总 |

转录语义遵循 `@deepseek-ai/dsh-session/surface`：本插件渲染 **append-origin 表面事件**——用户真实看到过的全部内容——而不是模型可见表面（后者的 compaction 替换会抹掉用户已经读过的对话）。

`/archive` 补的是官方的第二个缺口：浏览器 `/export` **依赖 raw-artifact 后端**——SQLite 持久化声明 `supportsRawArtifacts: false`，所以 SQLite 部署根本拿不到导出。`/archive` 通过 `sessionQuery.readSession`（与后端无关）读到完整、replay 校验过的日志，把每个会话写成一个 ZIP（`session.jsonl` + `manifest.json`），并支持 `--all` 批量与 `--since` 时间范围。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/transcript` | 导出当前会话 → `<会话 cwd>/dsh-transcripts/transcript-<id8>-<时间戳>.md` |
| `/transcript <path>` | 写入指定路径（缺 `.md` 后缀时自动追加） |
| `/transcript --out <path>` | 同上，但取该 flag 之后整行作为路径（允许空格） |
| `/transcript --id <sessionId>` | 导出另一个会话 |
| `/transcript --json` / `--md` | 选择输出格式（可同时）；默认 `--md` |
| `/transcript --full` | 附上 log-only 事件附录（命令生命周期、compaction 标记） |

与所有 `ctx.commands` 命令一样，`/transcript` 运行在人类命令平面：结果不进模型历史，零 token 消耗。

## 归档

| 输入 | 结果 |
|---|---|
| `/archive` | 归档当前会话（含子代理后代）→ `<cwd>/.dsh-archives/dsh-session-<id8>-<日期>.zip` |
| `/archive --id <sessionId>` | 归档指定会话（默认含后代，加 `--no-descendants` 排除） |
| `/archive --all` | 归档当前项目目录下的全部会话 |
| `/archive --since 7d` | 限定 `--all` 只取最近 7 天创建的会话（`7d`/`12h`/`30m`/`90s`） |
| `/archive --out <dir>` | 写入指定目录（取该 flag 之后整行；默认 `.dsh-archives/`） |
| `/archive --no-descendants` | 排除子代理子会话 |

每个 ZIP 内含 `session.jsonl`（完整原始事件日志，replay 校验、1:1）与 `manifest.json`（id、时间戳、cwd、事件数、谱系）。`/archive` 同样跑在人类命令平面，零 token。单个会话读取失败会跳过并汇总，不打断整批。

## 安装（树外插件）

从 npm 安装：

```sh
dsh plugin --profile web add dsh-session-export
```

或从 GitHub 安装：

```sh
dsh plugin --profile web add github:kittimzhe/dsh-session-export
```

然后在 profile 的 `cordis.patch.yml` 中加一行（该行依赖 `commands` 与 `sessionQuery` 服务，shipped profile 均已挂载）：

```yaml
- id: session-export
  name: 'dsh-session-export'
```

## Markdown 内容

- 头部元信息表：会话 id、项目、创建时间、agent preset、消息/工具调用计数、token 汇总、生成器
- 谱系：祖先链 + 递归子代理后代树
- 按日志序的转录：用户消息、助手消息（provider/model 溯源、token 用量、可折叠 reasoning）、工具调用（参数截断；`str_replace_editor` 渲染为 ```diff 块）、工具结果（带错误标记）
- `--full`：log-only 事件附录

## 配置

插件行 config（均可选）：

```yaml
- id: session-export
  name: 'dsh-session-export'
  config:
    defaultDir: /绝对/输出/目录      # 默认：会话 cwd + dsh-transcripts/
    argCharLimit: 512               # 工具参数渲染上限
    resultCharLimit: 2048           # 工具结果渲染上限
    archiveDir: /绝对/输出/目录      # 默认：会话 cwd + .dsh-archives/
    includeDescendants: true        # /archive --id 默认含后代
    maxSessionsPerRun: 100          # /archive --all 安全上限
```

## 已知限制

- 导出经由可信 `ctx.sessionQuery` 缝；未挂载该服务的组合无法使用本插件。
- token 汇总只累加各 assistant 消息的 `usage` 记录；适配器未上报 usage 的步骤计零。
- fenced 块内不做转义；diff 内容自身以 `+`/`-` 开头的行会渲染为更多 diff 行（对 diff 视图可接受）。
- `/archive` 只导出、不恢复：DSH 没有写侧会话缝，因此 ZIP 是备份，不是往返。

## 许可

MIT
