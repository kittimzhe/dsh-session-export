#!/usr/bin/env node
// Dev-environment self-check for dsh-session-export.
// Run with `npm run doctor`. Exits non-zero when the environment is not ready.
import { existsSync, lstatSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (m) => console.log(`  ✅ ${m}`)
const bad = (m) => { failures++; console.log(`  ❌ ${m}`) }

console.log('dsh-session-export doctor\n')

// 1. Node version (CI covers 20/22)
const major = Number(process.versions.node.split('.')[0])
if (major >= 20) ok(`Node ${process.versions.node}`)
else bad(`Node ${process.versions.node} — this repo targets Node 20/22`)

// 2. Dependencies installed
if (existsSync(resolve(root, 'node_modules'))) ok('node_modules present (npm ci has run)')
else bad('node_modules missing — run `npm ci`')

// 3. @deepseek-ai/dsh-tools (optional peer; needed for full typecheck of the tool module).
//    Its transitive @deepseek-ai/dsh-agent@0.1.1 line is unpublished, so a fresh
//    install cannot pull it — link it from a sibling checkout when available.
const toolsPath = resolve(root, 'node_modules/@deepseek-ai/dsh-tools')
const sibling = resolve(root, '../dsh-session-recall/node_modules/@deepseek-ai/dsh-tools')
if (existsSync(toolsPath)) {
  ok('@deepseek-ai/dsh-tools resolvable')
} else if (existsSync(sibling)) {
  try {
    try { lstatSync(toolsPath); unlinkSync(toolsPath) } catch { /* no stale entry */ }
    symlinkSync(sibling, toolsPath, 'dir')
    ok('linked @deepseek-ai/dsh-tools from sibling dsh-session-recall')
  } catch (err) {
    bad(`failed to link dsh-tools: ${err.message}`)
  }
} else {
  bad('@deepseek-ai/dsh-tools not resolvable and no sibling checkout found — see README "Development"')
}

console.log(failures ? `\n${failures} issue(s) found` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
