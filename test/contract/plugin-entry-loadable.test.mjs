/**
 * 插件入口可加载性测试。**跨包契约测试**。
 *
 * 为什么必须有这个测试（真实事故）：
 *   2026-10-15 Windows 安装包启动即崩，报 `readSettings is not defined`。
 *   根因：`export const __internals = { readSettings }` ——
 *   `readSettings` 定义在 `apply()` 的**闭包内**（它需要 `getRoot`/`ctx`），
 *   在模块级引用直接抛 ReferenceError → 插件加载失败 → **整个应用打不开**。
 *
 *   而当时所有测试都是**绿的**，因为：
 *     · 单元测试只 import `lib/` 下的纯函数，不 import 插件入口
 *     · 语法检查 `node --check` 只查语法，不查作用域引用
 *     · CI 的 smoke 只验「装了、启动了」，不验「Harness 里的插件真的激活了」
 *
 *   这类 bug 的后果最严重（应用完全不可用），却最难被现有测试发现。
 *   因此单独立一条：**逐个 import 每个插件的服务端入口，断言不抛错**。
 *
 * 覆盖什么：
 *   · 模块级作用域引用错误（本次事故）
 *   · 顶层 import 缺失/路径错
 *   · 语法错误（虽然 --check 也查，这里再兜一层）
 *   · 必需导出（apply / inject）存在
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const PACKAGES = join(REPO_ROOT, 'packages')

async function listPlugins() {
  const entries = await fs.readdir(PACKAGES, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory() && e.name.startsWith('dsh-xyb-')).map((e) => e.name)
}

test('每个插件的服务端入口都能被 import（抓模块级作用域引用错误）', async () => {
  const plugins = await listPlugins()
  assert.ok(plugins.length >= 3, `应至少有 3 个插件，实际 ${plugins.length}`)

  const failures = []
  for (const name of plugins) {
    const entry = join(PACKAGES, name, 'index.js')
    try {
      // 真实 import（不是 --check），这样才能触发模块级求值
      await import(pathToFileURL(entry).href)
    } catch (error) {
      failures.push(`${name}: ${error?.message || error}`)
    }
  }

  assert.deepEqual(
    failures,
    [],
    `以下插件入口 import 失败（会导致 Harness 启动失败、应用打不开）：\n  ${failures.join('\n  ')}`
  )
})

test('每个插件入口都导出 apply 与 inject（宿主加载协议）', async () => {
  const plugins = await listPlugins()
  const failures = []

  for (const name of plugins) {
    const entry = join(PACKAGES, name, 'index.js')
    try {
      const mod = await import(pathToFileURL(entry).href)
      if (typeof mod.apply !== 'function') failures.push(`${name}: 缺少 export function apply`)
      if (!Array.isArray(mod.inject)) failures.push(`${name}: 缺少 export const inject（必须是数组）`)
    } catch (error) {
      failures.push(`${name}: import 抛错 —— ${error?.message || error}`)
    }
  }

  assert.deepEqual(failures, [], `插件导出契约不合格：\n  ${failures.join('\n  ')}`)
})

test('__internals 导出的名字必须在模块级作用域可见', async () => {
  // 这条是本次事故的**精确回归**：
  // __internals 是模块级对象，它的值在模块求值时就要解析；
  // 若引用了 apply() 闭包内的东西，import 时立刻抛 ReferenceError。
  const plugins = await listPlugins()
  const failures = []

  for (const name of plugins) {
    const entry = join(PACKAGES, name, 'index.js')
    const source = await fs.readFile(entry, 'utf8')
    const match = source.match(/export const __internals\s*=\s*\{([^}]*)\}/)
    if (!match) continue

    // 提取导出名（忽略 `key: undefined` 这类显式赋值）
    const names = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.includes(':') ? null : s)) // `a: undefined` 这种是字面量，不解析标识符
      .filter(Boolean)

    for (const symbol of names) {
      // 该符号必须在模块级有定义（function / const / let / var / class / import）
      const moduleLevel = new RegExp(
        `^(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+${symbol}\\b|^import\\s+.*\\b${symbol}\\b`,
        'm'
      )
      if (!moduleLevel.test(source)) {
        failures.push(
          `${name}: __internals 导出了 "${symbol}"，但它不在模块级作用域` +
            `（若它定义在 apply() 闭包内，import 会抛 ReferenceError → 应用打不开）`
        )
      }
    }
  }

  assert.deepEqual(failures, [], `__internals 存在闭包作用域引用：\n  ${failures.join('\n  ')}`)
})

test('客户端入口零 import、零 JSX（宿主加载协议）', async () => {
  const plugins = await listPlugins()
  const failures = []

  for (const name of plugins) {
    const clientPath = join(PACKAGES, name, 'client.js')
    let source
    try {
      source = await fs.readFile(clientPath, 'utf8')
    } catch {
      failures.push(`${name}: 缺少 client.js`)
      continue
    }

    const importLines = source.split('\n').filter((l) => /^\s*import\s/.test(l))
    if (importLines.length) {
      failures.push(`${name}: client.js 含 ${importLines.length} 处 import（宿主客户端是 __ModuleLoader__ 形态）`)
    }
    if (/<[A-Z][a-zA-Z0-9]*[\s/>]|<\/[A-Z][a-zA-Z0-9]*>/.test(source)) {
      failures.push(`${name}: client.js 含疑似 JSX（宿主不替插件构建）`)
    }
    if (!source.includes('__ModuleLoader__')) {
      failures.push(`${name}: client.js 未使用 window.__ModuleLoader__.load`)
    }
  }

  assert.deepEqual(failures, [], `客户端入口契约不合格：\n  ${failures.join('\n  ')}`)
})
