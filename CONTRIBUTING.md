# Contributing / 贡献指南

Thanks for your interest in improving `dsh-session-export`! / 感谢你对 `dsh-session-export` 的贡献兴趣！

## Reporting issues / 提交 issue

1. Search existing issues first — avoid duplicates. / 先搜索已有 issue，避免重复。
2. Include: plugin version (`npm ls dsh-session-export`), DSH version, Node version (20/22), and a minimal reproduction. / 请附上：插件版本、DSH 版本、Node 版本（20/22）与最小复现步骤。
3. For security vulnerabilities, do **not** open a public issue — see [SECURITY.md](SECURITY.md). / 安全漏洞请勿开公开 issue，见 [SECURITY.md](SECURITY.md)。

## Pull requests / PR 规范

- One PR per concern; keep the diff reviewable. / 一个 PR 只做一件事，保持可审阅的 diff。
- Conventional commit titles (`feat:` / `fix:` / `docs:` / `chore:` / `test:` / `ci:`). / 使用约定式提交前缀。
- Behavior changes require tests; docs changes require no test but must update **both** `README.md` and `README.zh.md` in sync. / 行为变更必须带测试；文档变更无需测试，但 `README.md` 与 `README.zh.md` 必须同步修改。
- CI (Node 20/22) must be green before review. / 合入前 CI（Node 20/22）必须全绿。

## Development setup / 开发环境

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run bundle      # tsdown -> lib/
```

Releases are cut by the maintainer (version bump + tag + GitHub Release + `npm publish`). / 版本发布由维护者执行（版本号 + tag + GitHub Release + `npm publish`）。

## License / 许可

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE). / 提交贡献即表示你同意贡献内容以 [MIT 许可](LICENSE)发布。
