#!/usr/bin/env node
/**
 * 全量语法检查。 SPEC ADR-701（CI 的 build 阶段）。
 *
 * 检查所有自有 JS/MJS 文件能否被 Node 解析。
 * 为什么不用 tsc：客户端文件是宿主 ModuleLoader 形态（零 import、非 ESM 模块），
 * tsc 会报大量假错误；用 `node --check` 更贴合实际加载方式。
 *
 * 用法：
 * node scripts/check-syntax.mjs
 *
 * 退出码：0 通过 / 1 有语法错误 / 2 脚本错误
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..'))

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'dist',
  'dist-dev',
  'out',
  'coverage',
  '.ipynb_checkpoints',
  'vendor'
])

const CHECK_EXT = new Set(['.js', '.mjs', '.cjs'])

async function collect(dir, acc = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await collect(full, acc)
    } else if (entry.isFile() && CHECK_EXT.has(extname(entry.name).toLowerCase())) {
      acc.push(full)
    }
  }
  return acc
}

async function main() {
  const files = await collect(REPO_ROOT)
  const failures = []

  for (const file of files) {
    try {
      execFileSync('node', ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const output = (error.stderr || error.stdout || '').toString()
      failures.push({ file: relative(REPO_ROOT, file), detail: output.split('\n').slice(0, 6).join('\n') })
    }
  }

  console.log(`[check-syntax] 检查了 ${files.length} 个文件`)

  if (failures.length) {
    console.error(`\n❌ ${failures.length} 个文件有语法错误：\n`)
    for (const f of failures) {
      console.error(`─── ${f.file} ───`)
      console.error(f.detail)
      console.error('')
    }
    process.exit(1)
  }

  console.log('[check-syntax] ✅ 全部通过')
}

main().catch((error) => {
  console.error('[check-syntax] 脚本错误:', error?.message || error)
  process.exit(2)
})
