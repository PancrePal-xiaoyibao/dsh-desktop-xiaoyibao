#!/usr/bin/env node
/**
 * 收集发布产物。 SPEC ADR-704。
 *
 * 为什么独立成脚本（不用内联 shell）：
 * ① 跨平台一致（macOS 的 `shasum` 与 Windows 的 `Get-FileHash` 语法不同）
 * ② 可测试（本地能跑，不依赖 CI）
 * ③ 产物清单可对齐上游（上游用 verify-release-assets.mjs 校验必需文件）
 *
 * 收集哪些（**对齐上游 REQUIRED_ASSETS**）：
 * macOS : *.dmg · *.zip · *.zip.blockmap · latest-mac.yml
 * Windows : *.exe · *.exe.blockmap · latest.yml
 * 另附 : 每个安装包的 .sha256（社区自检用）
 *
 * 用法：
 * node scripts/collect-release-assets.mjs --from dist --to ../release-out
 * node scripts/collect-release-assets.mjs --from dist --to out --check # 只校验不复制
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join, resolve } from 'node:path'

function parseArgs(argv) {
  const args = { from: 'dist', to: 'release-out', check: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') args.from = argv[++i]
    else if (argv[i] === '--to') args.to = argv[++i]
    else if (argv[i] === '--check') args.check = true
  }
  return args
}

/** 安装包（必须有） */
const INSTALLER_PATTERNS = [/\.dmg$/i, /\.exe$/i, /\.zip$/i]
/** 辅助文件（有则收，无则跳过） */
const AUX_PATTERNS = [/\.blockmap$/i, /^latest.*\.yml$/i, /^latest.*\.yaml$/i]
/** 明确不要的（我们自己的 .sha256 会重新生成；上游的日志/中间产物也不要） */
const EXCLUDE_PATTERNS = [/\.sha256$/i, /\.log$/i, /^builder-.*\.yml$/i, /^builder-.*\.yaml$/i]

function classify(name) {
  if (INSTALLER_PATTERNS.some((p) => p.test(name))) return 'installer'
  if (AUX_PATTERNS.some((p) => p.test(name))) return 'aux'
  return null
}

async function sha256(file) {
  const buf = await fs.readFile(file)
  return createHash('sha256').update(buf).digest('hex')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const fromDir = resolve(args.from)
  const toDir = resolve(args.to)

  let entries
  try {
    entries = await fs.readdir(fromDir, { withFileTypes: true })
  } catch {
    console.error(`[collect-release-assets] 源目录不存在：${fromDir}`)
    process.exit(1)
  }

  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => !EXCLUDE_PATTERNS.some((p) => p.test(name)))
    .filter((name) => classify(name) !== null)

  if (files.length === 0) {
    console.error(`[collect-release-assets] ${fromDir} 中未找到发布产物`)
    console.error('  期望至少有一个 .dmg / .exe / .zip')
    process.exit(1)
  }

  const installers = files.filter((n) => classify(n) === 'installer')
  const aux = files.filter((n) => classify(n) === 'aux')

  if (installers.length === 0) {
    console.error('[collect-release-assets] 没有任何安装包（.dmg / .exe / .zip）')
    process.exit(1)
  }

  console.log(`[collect-release-assets] 源：${fromDir}`)
  console.log(`  安装包 ${installers.length} 个 / 辅助文件 ${aux.length} 个`)

  const manifest = []
  for (const name of files) {
    const src = join(fromDir, name)
    const stat = await fs.stat(src)
    const kind = classify(name)
    const hash = await sha256(src)
    manifest.push({ name, kind, size: stat.size, sha256: hash })
  }

  if (!args.check) {
    await fs.mkdir(toDir, { recursive: true })
    for (const item of manifest) {
      await fs.copyFile(join(fromDir, item.name), join(toDir, item.name))
      // 安装包附一份 .sha256（社区自检用）
      if (item.kind === 'installer') {
        await fs.writeFile(join(toDir, `${item.name}.sha256`), `${item.sha256}\n`, 'utf8')
      }
    }
  }

  for (const item of manifest) {
    const mb = (item.size / 1024 / 1024).toFixed(1)
    console.log(`  · [${item.kind}] ${item.name}  ${mb} MB  ${item.sha256.slice(0, 16)}…`)
  }

  // 缺 update 元数据时提示（本项目关闭了自动更新，属预期）
  const hasUpdateMeta = aux.some((n) => /^latest.*\.ya?ml$/i.test(n))
  if (!hasUpdateMeta) {
    console.log('  ℹ️  未找到 latest*.yml（本项目关闭了自动更新，electron-builder 不生成更新元数据，属预期）')
  }

  const outManifest = join(args.check ? fromDir : toDir, 'release-manifest.json')
  await fs.writeFile(
    outManifest,
    `${JSON.stringify({ collectedAt: new Date().toISOString(), source: fromDir, files: manifest }, null, 2)}\n`,
    'utf8'
  )
  console.log(`[collect-release-assets] ${args.check ? '校验' : '收集'}完成 → ${args.to}`)
}

main().catch((error) => {
  console.error('[collect-release-assets] 脚本错误:', error?.message || error)
  process.exit(2)
})
