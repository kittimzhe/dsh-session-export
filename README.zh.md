# dsh-session-export

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供人类可读的会话转录导出：`/transcript` 命令把会话的 Markdown（或 JSON）转录**直接写到 Host 文件系统**——不需要浏览器下载，也不解码原始日志。

## 为什么需要它

官方 `@deepseek-ai/dsh-session-log-export` 通过浏览器下载原始 JSONL/zstd ZIP，且仅支持 JSONL 后端。本插件补上它明确推迟的部分：

| | 官方 `/export` | 本插件 `/transcript` |
|---|---|---|
| 输出 | 原始日志 ZIP（浏览器下载） | **写入 Host 路径的 Markdown / JSON** |
| 持久化后端 | 仅 JSONL | **`ctx.sessionQuery` 之后的任意后端**（JSONL、SQLite…） |
| 内容 | 机器工件 | **人类转录**：消息流、工具调用、编辑器 diff、子代理谱系、token 汇总 |

转录语义遵循 `@deepseek-ai/dsh-session/surface`：本插件渲染 **append-origin 表面事件**——用户真实看到过的全部内容——而不是模型可见表面（后者的 compaction 替换会抹掉用户已经读过的对话）。

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

## 安装（树外插件）

从 GitHub 安装（无需 npm 发布）：

```sh
dsh plugin --profile web add github:kittimzhe/dsh-session-export
```

或 npm 发布后：

```sh
dsh plugin --profile web add dsh-session-export
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
```

## 已知限制

- 导出经由可信 `ctx.sessionQuery` 缝；未挂载该服务的组合无法使用本插件。
- token 汇总只累加各 assistant 消息的 `usage` 记录；适配器未上报 usage 的步骤计零。
- fenced 块内不做转义；diff 内容自身以 `+`/`-` 开头的行会渲染为更多 diff 行（对 diff 视图可接受）。

## 许可

MIT
