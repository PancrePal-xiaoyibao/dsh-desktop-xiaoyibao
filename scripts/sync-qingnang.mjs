#!/usr/bin/env node
/**
 * 青囊快照同步脚本。 SPEC ADR-901。
 *
 * 从青囊仓库把**必要部分**复制到 `packages/dsh-xyb-qingnang/vendor/qingnang/`，
 * 并生成 `SNAPSHOT.json` 记录来源、版本与校验值。
 *
 * 用法：
 * node scripts/sync-qingnang.mjs # 用默认源路径（可用 QINGNANG_SOURCE 环境变量覆盖）
 * node scripts/sync-qingnang.mjs --source <路径> # 指定青囊仓库路径
 * node scripts/sync-qingnang.mjs --check # 只校验现有快照，不复制
 *
 * 设计意图（ADR-901）：
 * · 只取「运行必需」，不取测试/开发环境/运行时数据/本机画像
 * · 记录 commit 与 pack_version，使升级可追溯
 * · 生成校验值，使快照可验证完整
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..'))
// 默认源路径可用环境变量覆盖（不同机器上青囊仓库位置不同）。
// **不得硬编码本机绝对路径**（脱敏铁律）。
const DEFAULT_SOURCE = process.env.QINGNANG_SOURCE || join(REPO_ROOT, '..', 'QingNang')
const TARGET = join(REPO_ROOT, 'packages', 'dsh-xyb-qingnang', 'vendor', 'qingnang')

/** 必须复制的内容（ADR-901 清单） */
const INCLUDED = [
  'scripts',
  'skills',
  'mcp-servers/manifest.json',
  'MANIFEST.json',
  'LICENSE',
  'vendor/node_modules'
]

/** 明确排除的内容 */
const EXCLUDED = [
  'tests',
  'cache',
  'data',
  '.venv',
  'node_modules',
  'package-lock.json',
  '.ipynb_checkpoints',
  'skills/qingnang/HOST_PROFILE.md',
  'skills/qingnang/references/private'
]

/** 同步时额外跳过的文件名（避免把本机信息带入） */
const SKIP_FILE_NAMES = new Set(['HOST_PROFILE.md', '.DS_Store'])

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, check: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source' && argv[i + 1]) {
      args.source = argv[++i]
    } else if (argv[i] === '--check') {
      args.check = true
    }
  }
  return args
}

async function exists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** 递归复制，跳过排除项与敏感文件名；返回 { files, bytes, list } */
async function copyFiltered(src, dest, base = src, acc = { files: 0, bytes: 0, list: [] }) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    const rel = relative(base, from)

    if (SKIP_FILE_NAMES.has(entry.name)) continue
    if (EXCLUDED.includes(rel) || EXCLUDED.includes(entry.name)) continue

    if (entry.isDirectory()) {
      await copyFiltered(from, to, base, acc)
    } else if (entry.isSymbolicLink()) {
      // 跳过符号链接（跨平台/打包不稳定）
      continue
    } else if (entry.isFile()) {
      await fs.copyFile(from, to)
      const size = (await fs.stat(to)).size
      acc.files += 1
      acc.bytes += size
      acc.list.push({ path: rel.replace(/\\/g, '/'), size })
    }
  }
  return acc
}

/** 计算校验值：文件路径 + 大小的排序后摘要（稳定、跨平台） */
function checksumOf(list) {
  const sorted = [...list].sort((a, b) => a.path.localeCompare(b.path))
  const hash = createHash('sha256')
  for (const item of sorted) {
    hash.update(`${item.path}:${item.size}\n`)
  }
  return hash.digest('hex').slice(0, 32)
}

function gitCommit(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const source = resolve(args.source)

  if (!(await exists(source))) {
    console.error(`[sync-qingnang] 源目录不存在: ${source}`)
    process.exit(2)
  }

  const manifestPath = join(source, 'MANIFEST.json')
  if (!(await exists(manifestPath))) {
    console.error(`[sync-qingnang] 源目录缺少 MANIFEST.json: ${source}`)
    process.exit(2)
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))

  if (args.check) {
    const snapPath = join(TARGET, 'SNAPSHOT.json')
    if (!(await exists(snapPath))) {
      console.error('[sync-qingnang] 快照不存在')
      process.exit(1)
    }
    const snap = JSON.parse(await fs.readFile(snapPath, 'utf8'))
    console.log(`[sync-qingnang] 现有快照：packVersion=${snap.packVersion} commit=${snap.commit} files=${snap.fileCount}`)

    // 逐项校验：必需路径存在
    let missing = 0
    for (const rel of INCLUDED) {
      const p = join(TARGET, rel)
      if (!(await exists(p))) {
        console.error(`  ❌ 缺少必需路径: ${rel}`)
        missing += 1
      }
    }
    // 逐项校验：本机画像不得存在
    if (await exists(join(TARGET, 'skills', 'qingnang', 'HOST_PROFILE.md'))) {
      console.error('  ❌ 快照包含本机画像 HOST_PROFILE.md（必须排除）')
      missing += 1
    }
    if (missing) process.exit(1)
    console.log('[sync-qingnang] 校验通过')
    return
  }

  // ── 复制
  console.log(`[sync-qingnang] 源: ${source}`)
  console.log(`[sync-qingnang] 目标: ${TARGET}`)

  await fs.rm(TARGET, { recursive: true, force: true })
  await fs.mkdir(TARGET, { recursive: true })

  const acc = { files: 0, bytes: 0, list: [] }
  for (const rel of INCLUDED) {
    const from = join(source, rel)
    if (!(await exists(from))) {
      console.warn(`  ⚠️  跳过（源中不存在）: ${rel}`)
      continue
    }
    const to = join(TARGET, rel)
    const stat = await fs.stat(from)
    if (stat.isDirectory()) {
      await copyFiltered(from, to, source, acc)
    } else {
      await fs.mkdir(dirname(to), { recursive: true })
      await fs.copyFile(from, to)
      acc.files += 1
      acc.bytes += stat.size
      acc.list.push({ path: rel, size: stat.size })
    }
  }

  // ── 安全复查：不得含本机画像
  const profileInSnapshot = join(TARGET, 'skills', 'qingnang', 'HOST_PROFILE.md')
  if (await exists(profileInSnapshot)) {
    await fs.rm(profileInSnapshot, { force: true })
    console.warn('  ⚠️  已移除误复制的 HOST_PROFILE.md')
    acc.list = acc.list.filter((i) => i.path !== 'skills/qingnang/HOST_PROFILE.md')
    acc.files -= 1
  }

  // ── SNAPSHOT.json
  const snapshot = {
    source: manifest.upstream || 'https://github.com/PancrePal-xiaoyibao/QingNang',
    commit: gitCommit(source),
    packVersion: manifest.pack_version || null,
    schemaVersion: manifest.schema_version || null,
    syncedAt: new Date().toISOString(),
    syncedBy: 'scripts/sync-qingnang.mjs',
    fileCount: acc.files,
    totalBytes: acc.bytes,
    included: INCLUDED,
    excluded: EXCLUDED,
    skipFileNames: [...SKIP_FILE_NAMES],
    checksum: checksumOf(acc.list)
  }
  await fs.writeFile(join(TARGET, 'SNAPSHOT.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

  const mb = (acc.bytes / 1024 / 1024).toFixed(1)
  console.log(`[sync-qingnang] 完成：${acc.files} 文件 / ${mb} MB`)
  console.log(`[sync-qingnang] packVersion=${snapshot.packVersion} commit=${snapshot.commit}`)
  console.log(`[sync-qingnang] checksum=${snapshot.checksum}`)

  if (acc.bytes / 1024 / 1024 > 60) {
    console.warn(`[sync-qingnang] ⚠️  快照体积 ${mb}MB 超过 60MB 上限`)
  }
}

main().catch((error) => {
  console.error('[sync-qingnang] 失败:', error?.message || error)
  process.exit(1)
})
