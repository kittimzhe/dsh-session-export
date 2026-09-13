// Generates docs/samples/sample.md + sample.html from a synthetic session.
// Run: node scripts/gen-samples.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { computeStats, renderHtml, renderMarkdown } from '../lib/index.js'

const base = Date.parse('2026-09-12T09:00:00Z')
const id = (n) => `m${n}`
const user = (seq, time, text) => ({
  seq, time, kind: 'user',
  message: { id: id(seq), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const assistant = (seq, time, blocks, outputTokens) => ({
  seq, time, kind: 'assistant',
  message: { id: id(seq), role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v3.2' }, content: blocks },
  usage: { inputTokens: 3120 + seq * 140, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
})
const toolCall = (n, name, args) => ({ type: 'tool-call', id: `call-${n}`, name, arguments: args })
const toolResult = (seq, time, callId, text, isError, error) => ({
  seq, time, kind: 'tool-result',
  message: { id: id(seq), role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: isError === true, content: [{ type: 'text', text }] }] },
  ...(error !== undefined ? { error } : {}),
})

const entries = [
  user(1, base, '帮我排查一下这个沙箱里 /command 为什么报 EPERM，凭证参数是 {"uid": 1000, "gid": 1000}'),
  assistant(2, base + 4_000, [
    { type: 'reasoning', text: 'EPERM 在 fork/exec 路径上通常来自 setgroups/setgid/setuid——先看 execd 的凭证构造。' },
    { type: 'text', text: '先看内核拒绝点。非 nil Credential 会让 child 无条件调 setgroups，而 setgroups 要求 CAP_SETGID——即使 id 与当前进程完全一致。' },
    toolCall(1, 'bash', '{"command":"grep -n Credential /proc/.../command.go | head -5"}'),
  ], 420),
  toolResult(3, base + 9_000, 'call-1', '104: func buildCredential(uid, gid *uint32) (*syscall.Credential, error) {\n110:  cred := &syscall.Credential{}'),
  assistant(4, base + 21_000, [
    { type: 'text', text: '根因定位：同身份请求也走了完整凭证切换。修复方案是加同身份快路径。' },
    toolCall(2, 'str_replace_editor', '{"command":"str_replace","path":"command.go","old_str":"cred := &syscall.Credential{}","new_str":"if sameIdentityRequest(uid, gid) { return nil, nil }\\ncred := &syscall.Credential{}"}'),
  ], 510),
  toolResult(5, base + 24_000, 'call-2', 'The file command.go has been edited. Here\'s the result of running `cat -n` on a snippet:\n109\tif sameIdentityRequest(uid, gid) {'),
  user(6, base + 30_000, '跑一下测试验证'),
  assistant(7, base + 33_000, [
    toolCall(3, 'bash', '{"command":"go test ./pkg/runtime/ -run TestBuildCredential"}'),
  ], 180),
  toolResult(8, base + 61_000, 'call-3', 'command not found: timeout', true, { name: 'ENOENT', code: 'not_found' }),
  assistant(9, base + 64_000, [
    { type: 'text', text: '环境里没有 timeout 命令，换成直接跑（工具超时由宿主控制）：' },
    toolCall(4, 'bash', '{"command":"go test ./pkg/runtime/ -run TestBuildCredential -v"}'),
  ], 150),
  toolResult(10, base + 96_000, 'call-4', 'ok  \tgithub.com/alibaba/opensandbox/execd\t0.496s\n--- PASS: TestBuildCredential_NilIdentityReturnsNil (0.00s)\n--- PASS: TestBuildCredential_SameIdentityReturnsNil (0.00s)'),
  user(11, base + 120_000, '好，写 PR 描述发出去。另外把结果发我邮箱 mengzhe@example.com'),
]

const totals = {
  messages: entries.length,
  toolCalls: entries.filter((e) => e.message.role === 'assistant').flatMap((e) => e.message.content).filter((b) => b.type === 'tool-call').length,
  inputTokens: entries.reduce((sum, e) => sum + (e.usage?.inputTokens ?? 0), 0),
  outputTokens: entries.reduce((sum, e) => sum + (e.usage?.outputTokens ?? 0), 0),
}

const input = {
  header: { id: 'session-9e52da42-e585-4163-a4bc-56cb8b372ff1', createdAt: base, cwd: '~/work/OpenSandbox', agentPreset: 'default' },
  entries,
  totals,
  stats: computeStats(entries, { inputPerMillion: 0.27, outputPerMillion: 1.1, currency: '$' }),
  lineage: {
    ancestors: [],
    descendants: [{ id: 'session-3cd71d7e', createdAt: base + 40_000, origin: 'subagent', children: [] }],
  },
  generator: 'dsh-session-export v1.0.0',
  generatedAt: base + 200_000,
}

mkdirSync('docs/samples', { recursive: true })
writeFileSync('docs/samples/sample.html', renderHtml(input))
writeFileSync('docs/samples/sample.md', renderMarkdown(input))
console.log('✅ docs/samples/sample.html + sample.md 已生成')
