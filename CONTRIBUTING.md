# Contributing / 贡献指南

Thanks for your interest in improving `dsh-session-export`! / 感谢你对 `dsh-session-export` 的贡献兴趣！

## Step 0: environment self-check / 第零步：环境自检

Local type-checking of the tool module needs `@deepseek-ai/dsh-tools` (`^0.1.1-rc.2`, an optional peer) resolvable. Its transitive `@deepseek-ai/dsh-agent@0.1.1` line is currently unpublished on npm, so a fresh install cannot pull it. Run the self-check first — it verifies (and auto-fixes) your environment: / 本地类型检查需要 `@deepseek-ai/dsh-tools`（`^0.1.1-rc.2`，可选 peer）可解析。其传递依赖 `@deepseek-ai/dsh-agent@0.1.1` 目前未发布到 npm，全新安装拉不下来。先跑自检——它会验证（并自动修复）你的环境：

```bash
npm run doctor
```

It links `@deepseek-ai/dsh-tools` from a sibling checkout automatically when available; the manual equivalent: / 它会自动从兄弟仓库软链 `@deepseek-ai/dsh-tools`；手动等价操作：

```bash
ln -s ../dsh-session-recall/node_modules/@deepseek-ai/dsh-tools node_modules/@deepseek-ai/dsh-tools
```

## Source map / 源码地图

Start here before your first PR. / 第一次 PR 前先看这张表。

| Good first reads / 适合先看的文件 | Good first changes / 适合第一次 PR 的位置 |
|---|---|
| [`src/render/html.ts`](src/render/html.ts) — single-file HTML report / HTML 报告内核 | Report layout, anchors, theme details + render tests / 报告布局、锚点、主题细节与渲染测试 |
| [`src/render/markdown.ts`](src/render/markdown.ts) — Markdown transcript / Markdown 转录 | Line-level rendering fixes (escaping, diff blocks) + tests / 行级渲染修复（转义、diff 块）与测试 |
| [`src/mask.ts`](src/mask.ts) — redaction patterns and modes / 脱敏规则与模式 | New pattern categories, mode behavior + tests / 新规则类别、模式行为与测试 |
| [`src/command.ts`](src/command.ts) — command surface, arg parsing / 命令面与参数解析 | New flags for existing commands + arg tests / 现有命令的新参数与参数测试 |

[Issues labeled `good first issue`](https://github.com/kittimzhe/dsh-session-export/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) name the file to change, the definition of done, and the test to add. / 带 `good first issue` 标签的 issue 会写明改哪个文件、怎样算做完、要补什么测试。

## Reporting issues / 提交 issue

1. Search existing issues first — avoid duplicates. / 先搜索已有 issue，避免重复。
2. Include: plugin version (`npm ls dsh-session-export`), DSH version, Node version (20/22), and a minimal reproduction (a command + the output or artifact path). / 请附上：插件版本、DSH 版本、Node 版本（20/22）与最小复现（一条命令 + 输出或产物路径）。
3. For security vulnerabilities, do **not** open a public issue — see [SECURITY.md](SECURITY.md). / 安全漏洞请勿开公开 issue，见 [SECURITY.md](SECURITY.md)。

## Pull requests / PR 规范

- One PR per concern; keep the diff reviewable. / 一个 PR 只做一件事，保持可审阅的 diff。
- Conventional commit titles (`feat:` / `fix:` / `docs:` / `chore:` / `test:` / `ci:`). / 使用约定式提交前缀。
- Behavior changes require tests; docs changes require no test but must update **both** `README.md` and `README.zh.md` in sync. / 行为变更必须带测试；文档变更无需测试，但 `README.md` 与 `README.zh.md` 必须同步修改。
- Do not hardcode test counts in docs; they go stale. / 文档中不要写死测试数量，会过期。
- CI (Node 20/22) must be green before review. / 合入前 CI（Node 20/22）必须全绿。

## Development setup / 开发环境

```bash
npm ci
npm run doctor      # peer-dep self-check (see Step 0) / peer 依赖自检（见第零步）
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run bundle      # tsdown -> lib/
```

Releases are cut by the maintainer (version bump + tag + GitHub Release + `npm publish`). / 版本发布由维护者执行（版本号 + tag + GitHub Release + `npm publish`）。

## License / 许可

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE). / 提交贡献即表示你同意贡献内容以 [MIT 许可](LICENSE)发布。
