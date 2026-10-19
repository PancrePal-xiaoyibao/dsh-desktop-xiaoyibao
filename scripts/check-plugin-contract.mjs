#!/usr/bin/env node
/**
 * 插件包契约校验。 SPEC §7 / 治理文档 §3.2。
 *
 * 校验宿主工作台插件契约（这是**宿主定的协议，不是技术偏好**）：
 * ① package.json 必填字段齐备（dsh.bundle.patch / dsh.client.platform / dsh.client.inject / exports）
 * ② cordis.patch.yml 可解析且 insert.name 为**包名**（不能是路径）
 * ③ 客户端文件**零 import**（写了就加载失败）
 * ④ 客户端文件**零 JSX**（宿主不替插件构建）
 * ⑤ 客户端文件用 __ModuleLoader__.load({ id, factory }) 形态
 * ⑥ peerDependencies 承载 @deepseek-ai/*（写进 dependencies 会装第二份宿主代码）
 *
 * 用法：
 * node scripts/check-plugin-contract.mjs
 * node scripts/check-plugin-contract.mjs --strict # 额外检查可加载性
 *
 * 退出码：0 通过 / 1 失败 / 2 脚本错误
 */
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..'))
const PACKAGES = join(REPO_ROOT, 'packages')

const errors = []
const warnings = []

function err(pkg, message) {
  errors.push(`[${pkg}] ${message}`)
}
function warn(pkg, message) {
  warnings.push(`[${pkg}] ${message}`)
}

async function readIfExists(path) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** 极简 YAML 校验：只检查「能解析出 insert 段且 name 是包名」 */
function checkPatchYml(pkgName, text) {
  if (!text || !text.trim()) {
    err(pkgName, 'cordis.patch.yml 为空（空文件会导致启动失败；不需要行时写 []）')
    return
  }
  if (!text.includes('insert:')) {
    err(pkgName, 'cordis.patch.yml 缺少 insert 段')
    return
  }
  // 提取所有 "name:" 行（insert 条目的包名）
  const nameLines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('name:') && !l.startsWith('name_pattern'))
  if (nameLines.length === 0) {
    err(pkgName, 'cordis.patch.yml 的 insert 段缺少 name（必须写 npm 包名）')
    return
  }
  for (const line of nameLines) {
    const value = line.slice('name:'.length).trim().replace(/^['"]|['"]$/g, '')
    if (!value) {
      err(pkgName, 'cordis.patch.yml 有空的 name')
      continue
    }
    // name 必须是包名（不能以 . 或 / 开头）
    if (value.startsWith('.') || value.startsWith('/') || value.startsWith('..')) {
      err(pkgName, `cordis.patch.yml 的 name 必须是包名，不能写路径：${value}（上游踩坑 P-05）`)
    }
  }
}

/** 客户端文件契约检查 */
function checkClient(pkgName, text) {
  if (!text) {
    err(pkgName, 'client.js 不存在（声明了 dsh.client 就必须导出客户端文件）')
    return
  }

  // ① 零 import
  const importLines = text.split('\n').filter((l) => /^\s*import\s/.test(l))
  if (importLines.length) {
    err(
      pkgName,
      `client.js 含 ${importLines.length} 处 import（宿主客户端是 __ModuleLoader__ 形态，写了就加载失败；上游踩坑 P-01）`
    )
  }

  // ② 零 JSX（粗判：出现 <大写字母开头的标签 或 </大写）
  const jsxHits = text.match(/<[A-Z][a-zA-Z0-9]*[\s/>]|<\/[A-Z][a-zA-Z0-9]*>/g)
  if (jsxHits && jsxHits.length) {
    err(pkgName, `client.js 含 ${jsxHits.length} 处疑似 JSX（宿主不替插件构建，必须用 React.createElement）`)
  }

  // ③ 必须是 ModuleLoader 形态
  if (!text.includes('__ModuleLoader__')) {
    err(pkgName, 'client.js 未使用 window.__ModuleLoader__.load（不符合宿主加载协议）')
  }
  if (!text.includes('factory')) {
    err(pkgName, 'client.js 的 ModuleLoader.load 缺少 factory（依赖必须从 factory(require) 取）')
  }

  // ④ 不得引入独立 React
  if (/require\(['"]react['"]\)/.test(text) === false && text.includes('React.createElement') === false) {
    warn(pkgName, 'client.js 未见 React 使用（确认是否真的需要 React）')
  }
  if (/from\s+['"]react['"]/.test(text)) {
    err(pkgName, 'client.js 从 react 直接 import（会出现双实例导致 hooks 报错；上游踩坑 P-02）')
  }
}

/** package.json 契约检查 */
function checkPackageJson(pkgName, pkg, isClientPlugin) {
  if (pkg.type !== 'module') err(pkgName, 'package.json 的 type 应为 "module"')

  // exports
  const exportsField = pkg.exports || {}
  if (!exportsField['.']) err(pkgName, 'exports["."] 必须指向服务端入口')
  if (isClientPlugin && !exportsField['./client']) {
    err(pkgName, 'exports["./client"] 缺失（声明了 dsh.client 就必须导出客户端文件）')
  }

  // main
  if (!pkg.main) err(pkgName, 'package.json 缺少 main')

  if (isClientPlugin) {
    const dsh = pkg.dsh || {}
    if (!dsh.bundle?.patch) {
      err(pkgName, 'dsh.bundle.patch 缺失（没有它，包只会被当普通依赖安装，不会激活插件层）')
    }
    const client = dsh.client || {}
    if (client.platform !== 'web') {
      err(pkgName, `dsh.client.platform 必须为 "web"（当前：${client.platform}）`)
    }
    if (!Array.isArray(client.inject) || client.inject.length === 0) {
      err(pkgName, 'dsh.client.inject 必须是非空数组（决定加载顺序）')
    }
  }

  // peerDependencies：@deepseek-ai/* 必须在 peer（写进 dependencies 会装第二份宿主代码）
  const deps = pkg.dependencies || {}
  const badDeps = Object.keys(deps).filter((k) => k.startsWith('@deepseek-ai/') && k !== '@deepseek-ai/schemastery')
  if (badDeps.length) {
    err(
      pkgName,
      `以下 @deepseek-ai/* 应写在 peerDependencies 而非 dependencies（会装第二份宿主代码，上游踩坑 P-06）：${badDeps.join(', ')}`
    )
  }

  // license
  if (!pkg.license) warn(pkgName, 'package.json 缺少 license 字段')
}

async function main() {
  const strict = process.argv.includes('--strict')

  let entries
  try {
    entries = await fs.readdir(PACKAGES, { withFileTypes: true })
  } catch {
    console.error('[check-plugin-contract] 找不到 packages/ 目录')
    process.exit(2)
  }

  const pluginDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('dsh-xyb-'))
  if (pluginDirs.length === 0) {
    console.error('[check-plugin-contract] 未找到任何 dsh-xyb-* 插件包')
    process.exit(2)
  }

  for (const dir of pluginDirs) {
    const pkgDir = join(PACKAGES, dir.name)
    const raw = await readIfExists(join(pkgDir, 'package.json'))
    if (!raw) {
      err(dir.name, '缺少 package.json')
      continue
    }
    let pkg
    try {
      pkg = JSON.parse(raw)
    } catch (e) {
      err(dir.name, `package.json 不是合法 JSON：${e.message}`)
      continue
    }

    const isClientPlugin = Boolean(pkg.dsh?.client)
    checkPackageJson(dir.name, pkg, isClientPlugin)

    if (isClientPlugin) {
      const patch = await readIfExists(join(pkgDir, 'cordis.patch.yml'))
      checkPatchYml(dir.name, patch)

      const client = await readIfExists(join(pkgDir, 'client.js'))
      checkClient(dir.name, client)
    }

    // 服务端入口存在性
    const serverEntry = pkg.exports?.['.'] || pkg.main
    if (serverEntry) {
      const serverText = await readIfExists(join(pkgDir, serverEntry.replace(/^\.\//, '')))
      if (!serverText) {
        err(dir.name, `服务端入口不存在：${serverEntry}`)
      } else if (strict && !serverText.includes('export function apply')) {
        warn(dir.name, '服务端入口未见 `export function apply`（确认导出形态）')
      }
    }
  }

  // ── 输出
  console.log(`[check-plugin-contract] 检查了 ${pluginDirs.length} 个插件包`)

  if (warnings.length) {
    console.log(`\n⚠️  警告 ${warnings.length} 条：`)
    for (const w of warnings) console.log(`   ${w}`)
  }

  if (errors.length) {
    console.error(`\n❌ 契约错误 ${errors.length} 条：`)
    for (const e of errors) console.error(`   ${e}`)
    process.exit(1)
  }

  console.log('\n[check-plugin-contract] ✅ 全部契约校验通过')
}

main().catch((error) => {
  console.error('[check-plugin-contract] 脚本错误:', error?.message || error)
  process.exit(2)
})
