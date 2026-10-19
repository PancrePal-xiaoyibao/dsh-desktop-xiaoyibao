#!/usr/bin/env node
/**
 * 把本仓库的插件包就位到 vendor 的 node_modules。
 *
 * 为什么需要这一步（而不是直接在 vendor 里存副本）：
 *   · 根 `packages/` 是**唯一事实源**（源码 + 测试都在那里）
 *   · 打包时 electron-builder 按 `node_modules/**` 收集依赖
 *   · 若在 vendor 里再存一份 56MB 的青囊快照 → 仓库双份存储
 *
 * 因此：源码只存一份，打包前用本脚本「就位」。
 * 这与真实安装语义一致（npm install 也是把包放进 node_modules）。
 *
 * ── 就位的两个目的地（缺一不可）────────────────────────────────────
 *   ① vendor/dsh-desktop-main/packages/dsh-xyb-*  （**打包用**）
 *      electron-builder 的 build.files 从项目内相对路径取源 → 进产物
 *   ② vendor/dsh-desktop-main/node_modules/dsh-xyb-*  （**dev 运行用**）
 *      宿主启动时用 createRequire(anchor).resolve(包名) 解析 patch.yml 的
 *      insert 条目（src/main/state/host-plugin-sources.ts）。只放进 packages/
 *      时，dev（npm run dev）解析不到 → 启动即爆：
 *        Desktop host plugin source resolution failed for dsh-xyb-qingnang
 *      上游自己的插件是 npm `file:` 依赖，npm install 会自动建同样的链接。
 *      链接指向 packages/ 同一份源码，不产生副本；node_modules 已被 gitignore。
 *
 * 用法：
 *   node scripts/prepare-vendor-plugins.mjs           # 就位 + 建链接
 *   node scripts/prepare-vendor-plugins.mjs --check   # 只校验是否已就位
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..'))
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

/**
 * 就位目标：**vendor 项目内的 packages/**。
 *
 * 为什么不是 node_modules：
 *   electron-builder 按**依赖树**收集 node_modules，会剪掉未声明为 dependency 的包。
 *   我们的三个插件不是 vendor/package.json 的依赖 → 被剪掉 → 产物里没有 → 插件不加载
 *   （实测：解包 CI 产物，app.asar 里搜 xyb 零命中）。
 *
 * 为什么用 packages/：
 *   上游对 dsh-ppt / dsh-ppt-composer 用的就是 `{from:'<项目内路径>', to:'node_modules/...'}`
 *   映射。我们的插件原在**仓库根** packages/，对 vendor 而言是仓库外，路径解析失败。
 *   就位到 vendor 项目内的 packages/ 后，from 可写成项目内相对路径，与上游一致。
 *
 * 该目录已被 .gitignore（vendor/dsh-desktop-main/packages/dsh-xyb-*），不产生重复提交。
 */
const VENDOR_ROOT = join(REPO_ROOT, 'vendor', 'dsh-desktop-main')
const VENDOR_PACKAGES = join(VENDOR_ROOT, 'packages')
const VENDOR_NODE_MODULES = join(VENDOR_ROOT, 'node_modules')

/** 需要就位的插件包（本项目自有） */
const PLUGINS = ['dsh-xyb-branding', 'dsh-xyb-workbench', 'dsh-xyb-qingnang']

/** 递归复制。**只在顶层跳过** node_modules / .git / test（青囊快照内部自带 vendor/node_modules，必须保留）。 */
async function copyTree(src, dest, depth = 0) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  let files = 0
  for (const entry of entries) {
    // 仅顶层跳过：包自身的 node_modules（依赖由 electron-builder 处理）、.git、test（不进产物）
    if (depth === 0 && (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'test')) continue
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      files += await copyTree(from, to, depth + 1)
    } else if (entry.isSymbolicLink()) {
      continue
    } else if (entry.isFile()) {
      await fs.copyFile(from, to)
      files += 1
    }
  }
  return files
}

async function countFiles(dir) {
  let n = 0
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.isDirectory()) n += await countFiles(join(dir, entry.name))
    else if (entry.isFile()) n += 1
  }
  return n
}

/** 源包的文件数（同样只在顶层跳过 node_modules / .git / test，与 copyTree 保持一致） */
async function countSourceFiles(dir, depth = 0) {
  let n = 0
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (depth === 0 && (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'test')) continue
    if (entry.isDirectory()) n += await countSourceFiles(join(dir, entry.name), depth + 1)
    else if (entry.isFile()) n += 1
  }
  return n
}

/**
 * 目录内容指纹：相对路径 → sha256。
 *
 * 为什么必须比内容（真实事故，2026-10-17）：原来的 `--check` 只比“文件个数”，
 * 源与就位副本数量相同但**内容旧**（改了客户端却没重跑就位）也会判通过，
 * 于是打包版发出去的是旧界面。内容哈希比对能直接抓到这种过期。
 * 跳过规则与 copyTree 一致（仅顶层跳 node_modules / .git / test）。
 */
async function hashTree(dir, rel = '', out = new Map()) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (rel === '' && (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'test')) continue
    const full = join(dir, entry.name)
    const key = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) await hashTree(full, key, out)
    else if (entry.isFile()) out.set(key, createHash('sha256').update(await fs.readFile(full)).digest('hex'))
  }
  return out
}

/** 比较两份指纹，返回差异分类。 */
function diffTrees(source, target) {
  const changed = []
  const missing = []
  const extra = []
  for (const [key, hash] of source) {
    if (!target.has(key)) missing.push(key)
    else if (target.get(key) !== hash) changed.push(key)
  }
  for (const key of target.keys()) if (!source.has(key)) extra.push(key)
  return { changed, missing, extra }
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 在 vendor 的 node_modules 里为本项目插件建链接（**dev 运行必需**，原因见文件头）。
 * Windows 用 junction（无需管理员权限/开发者模式），其余平台用目录符号链接。
 */
async function linkIntoNodeModules(name) {
  await fs.mkdir(VENDOR_NODE_MODULES, { recursive: true })
  const target = join(VENDOR_PACKAGES, name)
  const link = join(VENDOR_NODE_MODULES, name)
  await fs.rm(link, { recursive: true, force: true })
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

/** 校验 node_modules 链接是否存在且指向 packages/ 就位的同一目录。返回问题描述或 null。 */
async function checkNodeModulesLink(name) {
  const link = join(VENDOR_NODE_MODULES, name)
  try {
    const stat = await fs.lstat(link)
    if (!stat.isSymbolicLink()) return '存在但不是链接（可能是独立副本）'
    const [real, expected] = await Promise.all([
      fs.realpath(link),
      fs.realpath(join(VENDOR_PACKAGES, name))
    ])
    return real === expected ? null : `链接指向 ${real}（期望 ${expected}）`
  } catch {
    return '链接不存在（dev 运行会启动失败）'
  }
}

async function main() {
  const checkOnly = process.argv.includes('--check')
  let problems = 0

  for (const name of PLUGINS) {
    const source = join(PACKAGES_DIR, name)
    const target = join(VENDOR_PACKAGES, name)

    if (!(await exists(source))) {
      console.error(`❌ 源包不存在: ${source}`)
      problems += 1
      continue
    }

    if (checkOnly) {
      const sourceHashes = await hashTree(source)
      const targetHashes = await hashTree(target)
      const { changed, missing, extra } = diffTrees(sourceHashes, targetHashes)
      const linkProblem = await checkNodeModulesLink(name)
      const ok =
        sourceHashes.size > 0 &&
        missing.length === 0 &&
        changed.length === 0 &&
        extra.length === 0 &&
        !linkProblem
      console.log(
        `${ok ? '✓' : '❌'} ${name}: 源 ${sourceHashes.size} 文件 / 目标 ${targetHashes.size} 文件` +
          (changed.length ? ` / **内容过期** ${changed.length} 个（例：${changed.slice(0, 3).join('、')}）` : '') +
          (missing.length ? ` / 缺 ${missing.length} 个` : '') +
          (extra.length ? ` / 多 ${extra.length} 个` : '') +
          (linkProblem ? ` / node_modules ${linkProblem}` : '')
      )
      if (!ok) problems += 1
      continue
    }

    await fs.rm(target, { recursive: true, force: true })
    const files = await copyTree(source, target)
    await linkIntoNodeModules(name)
    console.log(
      `✓ ${name}: 就位 ${files} 文件 → vendor/dsh-desktop-main/packages/${name}（并在 node_modules 建链接）`
    )
  }

  if (checkOnly) {
    if (problems) {
      console.error(`\n[prepare-vendor-plugins] ${problems} 个包未就位；请运行：node scripts/prepare-vendor-plugins.mjs`)
      process.exit(1)
    }
    console.log('\n[prepare-vendor-plugins] 全部已就位')
    return
  }

  console.log('\n[prepare-vendor-plugins] 完成')
  console.log('注：packages/dsh-xyb-* 与 node_modules/dsh-xyb-* 均为生成物（已被 gitignore），不会重复提交。')
}

main().catch((error) => {
  console.error('[prepare-vendor-plugins] 失败:', error?.message || error)
  process.exit(1)
})
