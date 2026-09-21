# dsh-session-export

[English](https://github.com/kittimzhe/dsh-session-export/blob/main/README.md) | 中文

[![CI](https://github.com/kittimzhe/dsh-session-export/actions/workflows/test.yml/badge.svg)](https://github.com/kittimzhe/dsh-session-export/actions/workflows/test.yml) [![npm version](https://img.shields.io/npm/v/dsh-session-export)](https://www.npmjs.com/package/dsh-session-export) [![npm downloads](https://img.shields.io/npm/dm/dsh-session-export)](https://www.npmjs.com/package/dsh-session-export) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/kittimzhe/dsh-session-export/blob/main/LICENSE)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**确定性的会话证据报告**：`/transcript` 把会话写成**单文件 HTML 报告**或 Markdown/JSON 转录，`/stats` 在终端打印统计卡，`/archive` 把原始会话日志写成逐会话 ZIP——全部落到本机路径，且支持任意持久化后端（JSONL 或 SQLite）。

**通过 `ctx.sessionQuery` 直读会话日志本身——无旁路采集、无驻留内存、无数据漂移。** 装插件之前的历史会话照样能导。

## 快速开始

**环境要求**：Node.js 20 或 22 · 挂载了 `commands` 与 `sessionQuery` 服务的 DeepSeek Harness profile（官方 `web` / `agent` profile 均满足）。

```sh
dsh plugin --profile web add dsh-session-export
```

装好后在任意会话里：

```text
/transcript        # 当前会话的单文件 HTML 复盘报告
/stats             # 终端统计卡片 + 成本估算
```

完整细节（GitHub 安装方式、`cordis.patch.yml` 片段、配置项）见下文「安装」一节。

## 项目定位

`dsh-session-export` 是**会话证据层**，不是记忆优化器。

- 核心价值是**可审计**（发生了什么、顺序如何、失败点在哪）。
- 核心价值是**可复现**（稳定输出、可移植文件、确定性渲染）。
- 核心价值是**可运维**（批量归档、落 Host 路径、可打印交付物）。

如果你的主要目标是上下文压缩或语义记忆，优先用记忆框架；如果主要目标是复盘取证、代码评审和事故复盘，优先用本插件。

## 竞品视角

| 能力重心 | 官方 `/export` | 旁路监听型导出 | 记忆框架类插件 | `dsh-session-export` |
|---|---|---|---|---|
| 主要产物 | 原始日志下载 | 可读转录文本 | 记忆/上下文优化结果 | **证据级会话复盘报告** |
| 数据来源 | 原始日志包 | 旁路事件流 | 推导后的记忆结构 | **会话主日志（`sessionQuery`）** |
| 历史覆盖 | 受后端限制 | 无补录常不完整 | 通常按召回策略选取 | **全量历史（含装插件前会话）** |
| 持久化后端 | 仅 JSONL | 监听器见到的 | 框架各异 | **任意后端（JSONL、SQLite…）** |
| 统计 | — | 面板计数器 | 框架各异 | **`/stats` 卡片 + 成本估算 + 工具排行** |
| 谱系 / diff / 时间轴 | — | — | — | **Mermaid 谱系、编辑器 diff、轮次时间轴** |
| 批量 | — | — | — | **`/archive --all --since`** |
| 运维交付 | 浏览器 ZIP | 常见单次导出 | 记忆状态/索引 | **HTML/MD/JSON + `/stats` + `/archive`** |

## 功能优化路线图

- **P1：报告对比模式** —— 对两次导出生成结构化差异报告（v1.6.0 已交付 → `/diff <id1> <id2>`）。
- **P1：团队策略包** —— 统一脱敏、保留期、导出契约的配置预设（v1.5.0 已交付 → `preset: 'compliance' | 'full'`）。
- **P2：交接打包** —— 一条命令打包报告 + 原始归档 + 清单，直连评审流程（v1.4.0 已交付 → `/bundle`）。

## 为什么需要它

官方 `@deepseek-ai/dsh-session-log-export` 通过浏览器下载原始 JSONL/zstd ZIP，且仅支持 JSONL 后端；官方 `@deepseek-ai/dsh-session-stats` 提供基础统计投影。两者是毛坯层，本插件是建在其上的证据层——确定性复盘报告、SHA-256 清单、脱敏、策略包、输出契约、`/diff` 与 `/bundle`（见上方对比表）。

转录语义遵循 `@deepseek-ai/dsh-session/surface`：本插件渲染 **append-origin 表面事件**——用户真实看到过的全部内容——而不是模型可见表面（后者的 compaction 替换会抹掉用户已经读过的对话）。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/transcript` | 导出当前会话 → `<会话 cwd>/dsh-transcripts/transcript-<id8>-<时间戳>.md` |
| `/transcript --html` | **单文件 HTML 报告**：KPI 卡片、轮次时间轴、工具排行、错误高亮、暗/亮主题、打印转 PDF |
| `/transcript --json` / `--md` / `--html` | 任意组合输出格式 |
| `/transcript <path>` / `--out <path>` | 写入指定路径（`--out` 后允许空格） |
| `/transcript --id <sessionId>` | 导出另一个会话 |
| `/transcript --last 30m` | **部分导出**：最近 30 分钟的条目（`7d`/`12h`/`30m`/`90s`） |
| `/transcript --errors-only` | **调试视图**：报错的工具结果 ± 两条上下文 |
| `/transcript --mask` | **脱敏**：遮蔽 API key、Bearer token、私钥、邮箱等 |
| `/transcript --mask-hash` | **确定性脱敏**：密文变 `#xxxxxxxx` 摘要——同密钥同标记，相等性在脱敏后仍可判 |
| `/transcript --manifest` | **证据清单**：为本次每个导出物写 `.manifest.json` 边车（字节数 + SHA-256） |
| `/transcript --full` | 附上 log-only 事件附录 + Mermaid 轮次时间轴 |
| `/stats` | **终端统计卡**：消息、轮次、时长、工具调用（含失败）、token、成本、工具排行、sparkline——不写文件 |
| `/archive` | 归档当前会话（含子代理后代）→ 逐会话 ZIP |
| `/archive --all --since 7d` | 批量归档最近 7 天的全部会话 |
| `/diff <id1> <id2>` | **会话对比**：比较两场会话——公共前缀、独有尾部、stats 差量（终端或 `--html` 报告） |
| `/bundle` | **一键审查 ZIP**：转录报告 + 原始 JSONL 归档 + sha256 证据清单，为审计/审查流程设计 |
| `/bundle --mask --manifest` | 脱敏转录 + 证据清单 |
| `/bundle --no-archive` | 仅转录报告（不含原始归档） |

与所有 `ctx.commands` 命令一样，四个命令都运行在人类命令平面：结果不进模型历史，零 token 消耗。

## HTML 报告长什么样

![HTML 报告（亮色主题）](https://github.com/kittimzhe/dsh-session-export/raw/main/docs/samples/report-light.png)
![HTML 报告（中文）](https://github.com/kittimzhe/dsh-session-export/raw/main/docs/samples/report-zh.png)
![HTML 报告（暗色主题）](https://github.com/kittimzhe/dsh-session-export/raw/main/docs/samples/report-dark.png)

`/transcript --html` 写出一个自包含文件——不引外部 CSS/JS，离线可开：

- **KPI 卡片**：消息数、工具调用（失败数标红）、token 进/出、时长、轮次、成本
- **轮次时间轴**：每轮一条彩色横条，按墙钟占比着色
- **工具排行**：横向条形图 + 每工具失败数
- **Token sparkline**：内嵌 SVG，每条 assistant 消息的输出 token 分布
- **错误焦点**：失败的工具结果红边框 + 横幅 + 自动展开；页头一键跳到第一个失败
- **JSON 语法高亮**：工具参数与 JSON 结果按 token 着色（key 蓝/字符串绿/数字琥珀）——不引外部高亮库
- **中英双语**：`lang: zh` 整份报告中文显示，默认英文
- **原生 tooltip**：悬停 KPI 卡、时间轴条、sparkline 柱看明细
- **原生折叠**：工具参数/结果与 reasoning 收进 `<details>`
- **按轮折叠**：转录按轮分组可折叠（时长 · 条数 · ⚠ 旗标）；长报告有粘性工具栏（TOC 芯片 + 实时搜索，`/` 聚焦）
- **复制按钮**：工具参数/结果/diff/推理块一键复制
- **暗/亮主题**：跟随系统 `prefers-color-scheme`，可切换且记忆
- **打印 → PDF**：`@media print` 规则；打印时自动展开全部折叠——Cmd+P 一步归档

Markdown 输出新增 **Mermaid 谱系图**（GitHub/VSCode 原生渲染），`--full` 时附 Mermaid 轮次甘特图。

## 成本估算

配置一次价格表，之后每次导出/统计都显示估算成本：

```yaml
- id: session-export
  name: 'dsh-session-export'
  config:
    pricing:
      inputPerMillion: 0.27   # 每百万输入 token 单价
      outputPerMillion: 1.10  # 每百万输出 token 单价
      currency: '$'           # 货币标签
```

## 安装（out-of-tree 插件）

从 npm：

```sh
dsh plugin --profile web add dsh-session-export
```

或从 GitHub：

```sh
dsh plugin --profile web add github:kittimzhe/dsh-session-export
```

然后在 profile 的 `cordis.patch.yml` 加一行（需要 `commands` 与 `sessionQuery` 服务，官方 profile 均已挂载）：

```yaml
- id: session-export
  name: 'dsh-session-export'
```

## 配置

插件行 config（全部可选）：

```yaml
- id: session-export
  name: 'dsh-session-export'
  config:
    preset: compliance                 # 一行策略包：'baseline'（默认）、'compliance'、'full'
    defaultDir: /absolute/output/dir   # 默认：会话 cwd + dsh-transcripts/
    argCharLimit: 512                  # 工具参数渲染上限
    resultCharLimit: 2048              # 工具结果渲染上限
    lang: zh                           # HTML 报告标签语言：默认 'en'，可 'zh'
    mask: true                         # 默认脱敏（--mask 按次开启）
    maskMode: hash                     # 替换模式：'mask'（占位符，默认）或 'hash'（确定性摘要）
    manifest: true                     # 默认写 .manifest.json 边车（--manifest 按次开启）
    maskPatterns: ['OPS-\d+']          # 额外脱敏正则
    pricing: { inputPerMillion: 0.27, outputPerMillion: 1.10, currency: '$' }
    archiveDir: /absolute/output/dir   # 默认：会话 cwd + .dsh-archives/
    includeDescendants: true           # /archive --id 默认含后代
    maxSessionsPerRun: 100             # /archive --all 安全上限
```

## Markdown 里有什么

- 表头：会话 id、项目、创建时间、agent preset、消息/工具调用数（含失败）、token 汇总、时长、成本、生成器
- 谱系：Mermaid 图 + 祖先链与子代理后代树
- 按日志顺序的转录：用户消息、assistant 消息（provider/model 出处、token 用量、可折叠 reasoning）、工具调用（参数截断；`str_replace_editor` 渲染成 ```diff 块）、工具结果（错误感知）
- `--full`：Mermaid 轮次时间轴 + log-only 事件附录

## 已知限制

- 导出走受信的 `ctx.sessionQuery` 接缝；没有该服务的组合无法挂载本插件。
- 报告字节不可复现（内嵌生成时间戳）；`--manifest` 提供的是完整性校验（逐导出物 SHA-256），而非可复现性。
- Token 汇总按 assistant 消息的 `usage` 记录累加；适配器未上报 usage 的步骤计零。
- 成本为牌价估算；未建模缓存命中折扣（`cacheReadTokens` 不单独计价）。
- 脱敏基于模式匹配、尽力而为：覆盖常见凭据形态，不保证遮蔽所有可能的秘密。
- Markdown 代码块内部不做转义；diff 内容自带 `+`/`-` 行首时会渲染为附加 diff 行（diff 视图可接受）。
- `/archive` 只出不进：DSH 没有写侧会话接缝，ZIP 是备份不是往返。

## 开发

工具模块的本地类型检查需要 `@deepseek-ai/dsh-tools`（`^0.1.1-rc.2`，可选 peer）可解析。其传递依赖 `@deepseek-ai/dsh-agent@0.1.1` 线当前已从 npm 下架，全新安装拉不下来。运行自检脚本验证（并自动修复）环境：

```bash
npm run doctor
```

它会自动从同级检出链接 `@deepseek-ai/dsh-tools`；手动等价操作：

```bash
ln -s ../dsh-session-recall/node_modules/@deepseek-ai/dsh-tools node_modules/@deepseek-ai/dsh-tools
```

## 许可

MIT

## 社区

- [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [行为准则](CODE_OF_CONDUCT.md)
