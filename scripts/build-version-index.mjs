#!/usr/bin/env node
/**
 * 版本索引生成与校验。 SPEC ADR-704。
 *
 * 为什么由 CI 从产物生成（而不是手工维护）：
 * 手工维护的索引必然与实际产物漂移（R-706）；
 * 从产物扫描是唯一可靠的事实来源。
 *
 * 产出两份：
 * version-index.json 机读（含 sha256 校验值，供程序与用户自检）
 * version-index.md 人读（含下载指引与校验方法）
 *
 * 用法：
 * node scripts/build-version-index.mjs --assets <目录> --version 0.1.0 --channel prerelease --tag v0.1.0-rc.1 --out version-index.json
 * node scripts/build-version-index.mjs --verify version-index.json --assets <目录>
 *
 * 退出码：0 通过 / 1 校验失败 / 2 脚本错误
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join, resolve } from 'node:path'

function parseArgs(argv) {
  const args = { assets: 'release-assets', version: null, channel: 'prerelease', tag: null, out: 'version-index.json', verify: null }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--assets') args.assets = argv[++i]
    else if (key === '--version') args.version = argv[++i]
    else if (key === '--channel') args.channel = argv[++i]
    else if (key === '--tag') args.tag = argv[++i]
    else if (key === '--out') args.out = argv[++i]
    else if (key === '--verify') args.verify = argv[++i]
  }
  return args
}

async function sha256(path) {
  const buf = await fs.readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}

/** 从文件名推断平台与架构（与 ADR-004 的命名约定一致） */
function classify(name) {
  const lower = name.toLowerCase()
  let platform = 'unknown'
  let arch = 'unknown'
  if (lower.includes('mac') || lower.endsWith('.dmg')) platform = 'macos'
  else if (lower.includes('windows') || lower.endsWith('.exe')) platform = 'windows'
  if (lower.includes('arm64')) arch = 'arm64'
  else if (lower.includes('x64') || lower.includes('x86_64')) arch = 'x64'
  let kind = 'installer'
  if (lower.endsWith('.zip')) kind = 'archive'
  else if (lower.endsWith('.dmg')) kind = 'installer'
  else if (lower.endsWith('.exe')) kind = 'installer'
  return { platform, arch, kind }
}

/** 收集产物（忽略 .sha256 附属文件与索引本身） */
async function collectAssets(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (name.endsWith('.sha256')) continue
    if (name.startsWith('version-index')) continue
    if (name.endsWith('.md')) continue
    if (name.endsWith('.yml') || name.endsWith('.yaml')) continue
    const full = join(dir, name)
    const stat = await fs.stat(full)
    if (stat.size < 1024) continue // 太小，不像安装包
    out.push({
      file: name,
      size: stat.size,
      sha256: await sha256(full),
      ...classify(name)
    })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/** 读宿主基线信息（用于追溯） */
async function upstreamInfo() {
  try {
    const raw = await fs.readFile(resolve('vendor/dsh-desktop-main/package.json'), 'utf8')
    const pkg = JSON.parse(raw)
    return {
      product: pkg.build?.productName || null,
      appId: pkg.build?.appId || null,
      harness: pkg.dependencies?.['@deepseek-ai/dsh'] || null
    }
  } catch {
    return { product: null, appId: null, harness: null }
  }
}

function renderMarkdown(index) {
  const lines = []
  lines.push('# 小胰宝社区版 · 版本索引')
  lines.push('')
  lines.push('> **社区发行版，非 DeepSeek 官方产品。**')
  lines.push('')
  lines.push(`索引更新时间：${index.updatedAt}`)
  lines.push('')
  for (const rel of index.releases) {
    lines.push(`## ${rel.version}${rel.channel === 'prerelease' ? '（预发布 / 内测）' : ''}`)
    lines.push('')
    lines.push(`- 发布标签：\`${rel.tag || '（手动触发）'}\``)
    lines.push(`- 发布日期：${rel.releasedAt}`)
    if (rel.harness) lines.push(`- 宿主基线：\`${rel.harness}\``)
    lines.push('')
    lines.push('| 文件 | 平台 | 架构 | 大小 | SHA-256 |')
    lines.push('|---|---|---|---|---|')
    for (const a of rel.artifacts) {
      const mb = (a.size / 1024 / 1024).toFixed(1)
      lines.push(`| \`${a.file}\` | ${a.platform} | ${a.arch} | ${mb} MB | \`${a.sha256}\` |`)
    }
    lines.push('')
    lines.push('### 校验下载文件（可选但推荐）')
    lines.push('')
    lines.push('```bash')
    lines.push('# macOS / Linux')
    lines.push(`shasum -a 256 ${rel.artifacts[0]?.file || '<文件名>'}`)
    lines.push('```')
    lines.push('')
    lines.push('```powershell')
    lines.push('# Windows')
    lines.push(`Get-FileHash ${rel.artifacts[0]?.file || '<文件名>'} -Algorithm SHA256`)
    lines.push('```')
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push('安装说明与隐私说明见仓库 `README.md` 与 `docs/PRIVACY.md`。')
  lines.push('本工具不构成医疗建议，不做诊断、不给用药剂量、不替代医生。')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const assetsDir = resolve(args.assets)

  // ── 校验模式
  if (args.verify) {
    const indexPath = resolve(args.verify)
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'))
    let problems = 0
    for (const rel of index.releases) {
      for (const a of rel.artifacts) {
        const full = join(assetsDir, a.file)
        try {
          const actual = await sha256(full)
          if (actual !== a.sha256) {
            console.error(`❌ ${a.file} 校验值不匹配（索引 ${a.sha256.slice(0, 16)}… / 实际 ${actual.slice(0, 16)}…）`)
            problems += 1
          } else {
            console.log(`✓ ${a.file} 校验值一致`)
          }
        } catch {
          console.error(`❌ ${a.file} 在产物目录中不存在`)
          problems += 1
        }
      }
    }
    if (problems) {
      console.error(`\n[build-version-index] ❌ 索引一致性校验失败（${problems} 项）`)
      process.exit(1)
    }
    console.log('\n[build-version-index] ✅ 索引与产物一致')
    return
  }

  // ── 生成模式
  if (!args.version) {
    console.error('[build-version-index] 缺少 --version')
    process.exit(2)
  }

  const artifacts = await collectAssets(assetsDir)
  if (artifacts.length === 0) {
    console.error(`[build-version-index] ${assetsDir} 中未找到安装产物`)
    process.exit(1)
  }

  const upstream = await upstreamInfo()
  const index = {
    product: upstream.product || '小胰宝社区版',
    appId: upstream.appId || null,
    indexVersion: 1,
    updatedAt: new Date().toISOString(),
    releases: [
      {
        version: args.version,
        channel: args.channel,
        tag: args.tag || null,
        releasedAt: new Date().toISOString().slice(0, 10),
        harness: upstream.harness,
        artifacts
      }
    ]
  }

  const outPath = resolve(args.out)
  await fs.writeFile(outPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await fs.writeFile(outPath.replace(/\.json$/, '.md'), renderMarkdown(index), 'utf8')

  console.log(`[build-version-index] 生成 ${artifacts.length} 个产物条目`)
  for (const a of artifacts) {
    console.log(`  · ${a.file}  ${(a.size / 1024 / 1024).toFixed(1)} MB  ${a.platform}/${a.arch}`)
  }
  console.log(`[build-version-index] 已写入 ${outPath} 与 ${outPath.replace(/\.json$/, '.md')}`)
}

main().catch((error) => {
  console.error('[build-version-index] 脚本错误:', error?.message || error)
  process.exit(2)
})
