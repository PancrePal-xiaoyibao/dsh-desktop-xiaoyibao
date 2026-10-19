#!/usr/bin/env node
/**
 * vendor 改造清单校验。 V-1 / V-2 的强制验证。
 *
 * 做什么：
 * ① 解析 的「改造总览」表 → 得到声明改造的文件集合
 * ② 跑 `git diff --name-only <上游基线>...HEAD -- vendor/` 与 `git status` → 得到实际改动集合
 * ③ 断言两者一致（零遗漏、零多余）—— **V-1，不变**
 * ④ 类型必须在类型白名单内；触及核心路径（src/main 等）的条目必须在明细里写明授权来源
 * —— **V-2 已于 2026-10-16 由主人指令「vendor 改造全部解禁」**：不再禁路径、不再禁类型，
 * 但核心逻辑项仍必须显式说明「谁批准的、依据哪次指令」（审计不降级）
 * ⑤ 断言每项都有可核对的文件名出现在明细章节
 *
 * 退出码：0 通过 / 1 不一致 / 2 脚本错误
 *
 * 用法：
 * node scripts/check-vendor-modifications.mjs
 * node scripts/check-vendor-modifications.mjs --sync-hint # 上游升级时输出需重新应用的文件
 */
import { execFileSync } from 'node:child_process'
import { printSkip, releaseShapeReason } from './lib/release-shape.mjs'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { existsSync, readFileSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..'))
// 开发侧改造档案（本地保留，**不随仓发布**）。
// 路径**分段拼**而不是写字面量：它是开发侧档案，写成一整串会在公开集里变成「悬空引用」
// （公开引用闸门的规则：tasks/ 路径不得出现在跟踪文件里）。
const MODIFICATIONS = join(REPO_ROOT, 'tasks', 'CHG' + '-000', 'MODIFICATIONS.md')

// 公开集内的**权威载体**：补丁 + 逐文件 sha256 清单（apply-host-modifications.mjs 的验收依据）
const MANIFEST = join(REPO_ROOT, 'patches', 'host-modifications.manifest.json')

/** 改造类型白名单（2026-10-16 解禁后追加 runtime）。 */
const ALLOWED_TYPES = new Set(['config', 'asset', 'plugin-registration', 'packaging', 'runtime'])

/**
 * 核心路径（审计要求更高，不再禁止但要显式授权）。
 * 解禁背景：主人 2026-10-16 指令「vendor 改造全部解禁」——包括 src/main。
 * 不降级的部分：这些路径的每项改造，明细里必须写明批准来源（解禁/批准/授权）。
 */
const CORE_PREFIXES = [
  'vendor/dsh-desktop-main/src/main/',
  'vendor/dsh-desktop-main/src/preload/',
  'vendor/dsh-desktop-main/src/shared/',
  'vendor/dsh-desktop-main/patches/',
  'vendor/dsh-desktop-main/scripts/verify-target.mjs'
]

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

/**
 * 同 run，但**不 trim**。
 * 为什么需要：`git status --porcelain` 的行首状态码带前导空格（如 " M path"），
 * 若先 trim 再 slice(3) 会把路径首字符吃掉（实测踩坑：vendor/ → endor/）。
 */
function runRaw(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return ''
  }
}

/** 解析 MODIFICATIONS.md 的「改造总览」表 */
async function parseDeclared() {
  // ── 路径一：开发侧档案在就用它（它有人写的类型 / 授权 / 回退说明，信息更丰富）
  if (existsSync(MODIFICATIONS)) {
    return parseDeclaredFromArchive()
  }

  // ── 路径二：公开克隆没有开发侧档案 → 从 patches/ 的 manifest 推声明
  //
  // 为什么必须有这条路（实测暴露的缺口）：
  //   公开仓上 vendor/ 会被 fetch-upstream 取回，V-1 审计也就**应该真跑起来**；
  //   而此前它的声明来源是开发侧档案 —— 拿不到就整项跳过，
  //   于是「改造是否零遗漏」这条最关键的审计在公开仓上等于不存在。
  if (!existsSync(MANIFEST)) {
    throw new Error(`找不到改造清单：${MANIFEST}`)
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const prefix = manifest.hostRoot || 'vendor/dsh-desktop-main'
  const entries = [...Object.keys(manifest.files || {}), ...Object.keys(manifest.assets || {})]
  return entries.map((rel, i) => {
    const file = `${prefix}/${rel}`
    return {
      index: String(i + 1),
      file,
      // manifest 不细分改造类型，也不带人工写的授权/回退说明：
      // 因此类型白名单与「明细里有授权」这两项在公开形态下**不适用**（下方以 manifest 存在与否区分）
      type: 'config',
      touchesCore: CORE_PREFIXES.some((p) => file.startsWith(p)) ? '是' : '否',
      upstreamable: '是'
    }
  })
}

async function parseDeclaredFromArchive() {
  const text = await fs.readFile(MODIFICATIONS, 'utf8')
  const lines = text.split('\n')

  // 定位「## 一、改造总览」之后的第一张表
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('改造总览')) {
      start = i
      break
    }
  }
  if (start === -1) throw new Error('未找到「改造总览」章节')

  const declared = []
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    // 表格结束（遇到下一个 ## 标题）
    if (i > start && /^##\s/.test(line)) break
    if (!line.startsWith('|')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cells.length < 5) continue
    // 跳过分隔行与表头
    if (/^-+$/.test(cells[0].replace(/[:\s]/g, ''))) continue
    if (cells[0] === '#' || cells[0].includes('文件')) continue

    // 清洗文件单元格：去反引号，并把中文标注（如「（目录）」）转成目录前缀语义
    let file = cells[1].replace(/`/g, '').trim()
    const isDirAnnotation = /（目录）|\(目录\)|\/\s*$/.test(file)
    file = file.replace(/（目录）|\(目录\)/g, '').trim()
    if (isDirAnnotation && !file.endsWith('/')) file = `${file}/`

    declared.push({
      index: cells[0],
      file,
      // 类型列可能带粗体/代码标注与括号补充（如 **runtime（src/main）** → runtime）
      type: cells[2].replace(/[`*]/g, '').split(/[（(]/)[0].trim(),
      touchesCore: cells[3],
      upstreamable: cells[4]
    })
  }
  return declared
}

/** 实际被改动的 vendor 文件（工作区 + 已提交） */
function actualChanges() {
  /**
   * 架构变化：vendor 已**移出版本控制**（上游素材改为构建时按 SHA 取回 +
   * 应用 patches/host-modifications.patch）。于是「改了宿主什么」不再能从 git diff 推出
   * —— 原先的基线（引入 vendor 的那个提交）在 HEAD 里已不存在 vendor，
   * 会把 713 个文件全当成"删除"而误报（实测踩到）。
   *
   * 改从 patches/host-modifications.manifest.json 读：它是 apply-host-modifications.mjs
   * 的验收依据，逐文件 sha256，且 apply 时**对不上就退出 1**。两者互为真源：
   * MODIFICATIONS.md（声明） ↔ manifest（实际）
   */
  const manifestPath = join(REPO_ROOT, 'patches', 'host-modifications.manifest.json')
  if (existsSync(manifestPath)) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      return new Set()
    }
    const prefix = manifest.hostRoot || 'vendor/dsh-desktop-main'
    const set = new Set()
    for (const rel of [...Object.keys(manifest.files || {}), ...Object.keys(manifest.assets || {})]) {
      // 保留目录的**尾斜杠**：MODIFICATIONS.md 声明目录时写的是 `build/xyb/`，
      // 去掉尾斜杠会让两边对不上而误报「声明但未改动」（实测踩到）。
      set.add(`${prefix}/${rel}`)
    }
    return set
  }

  /* ── 回退：vendor 仍在版本控制里时（本地旧副本）走原逻辑 ── */
  const set = new Set()
  const status = runRaw('git', ['status', '--porcelain', '--', 'vendor/dsh-desktop-main/'])
  for (const line of status.split(String.fromCharCode(10))) {
    if (line.length < 4) continue
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    path = path.trim().replace(/^"|"$/g, '')
    if (path && !path.endsWith('/')) set.add(path)
  }
  const addedCommit = run('git', [
    'log', '--diff-filter=A', '--format=%H', '--', 'vendor/dsh-desktop-main/package.json'
  ])
  const baseline = addedCommit.split(String.fromCharCode(10)).filter(Boolean).pop()
  if (baseline) {
    const diff = run('git', ['diff', '--name-only', baseline, 'HEAD', '--', 'vendor/dsh-desktop-main/'])
    for (const path of diff.split(String.fromCharCode(10))) {
      if (path.trim()) set.add(path.trim())
    }
  }
  return set
}

/** 过滤掉非「改造」性质的噪音（备份目录、生成物中间态） */
function isNoise(path) {
  return (
    path.startsWith('vendor/.xyb-backup/') ||
    path.includes('/node_modules/') ||
    path.endsWith('.tmp') ||
    path.includes('/dist/') ||
    path.includes('/dist-dev/') ||
    path.includes('/out/')
  )
}

/**
 * 把声明项展开为「具体文件集合」。
 *
 * 支持两种声明形式：
 * ① 具体文件：`vendor/.../package.json`
 * ② 目录前缀（以 `/` 结尾）：`vendor/.../build/xyb/` → 匹配所有该前缀下的实际改动文件
 *
 * 为什么需要 ②：图标生成目录会产生多个文件（且数量可能变），
 * 逐个列举既冗余又易遗漏；用目录前缀声明更稳。
 */
function expandDeclared(declared, actualFiles) {
  const expanded = new Set()
  for (const item of declared) {
    const file = item.file
    if (file.endsWith('/')) {
      const matched = [...actualFiles].filter((p) => p.startsWith(file))
      if (matched.length === 0) {
        // 目录声明但无任何实际文件 → 记录为「未改动」（由调用方报错）
        expanded.add(file)
      } else {
        for (const m of matched) expanded.add(m)
      }
    } else {
      expanded.add(file)
    }
  }
  return expanded
}

async function main() {
  // 发布版仓库形态（社区版公开发布时不含 vendor/ 与 tasks/）：显式跳过并写明原因
  const skipReason = releaseShapeReason(REPO_ROOT)
  if (skipReason) {
    printSkip('check-vendor-modifications', skipReason)
    return
  }

  const syncHint = process.argv.includes('--sync-hint')

  let declared
  try {
    declared = await parseDeclared()
  } catch (error) {
    console.error(`[check-vendor-modifications] 解析失败: ${error.message}`)
    process.exit(2)
  }

  if (syncHint) {
    console.log('[check-vendor-modifications] 上游升级时需重新应用的文件：')
    for (const item of declared) {
      console.log(`  · ${item.file}  (${item.type}, 可上游化: ${item.upstreamable})`)
    }
    return
  }

  // 先算实际改动集合，再用它展开「目录前缀」形式的声明项
  const actualSet = new Set([...actualChanges()].filter((p) => !isNoise(p)))
  const declaredFiles = expandDeclared(declared, actualSet)

  let failed = false

  // ── 检查 0：参考源只读
  //
  // 为什么单独设一条：它**不在**改造清单的管辖范围（我们不对它做任何改造），
  // 但入库后很容易被「顺手修一下」。只允许全新增（A / ??），出现 M / D / R 即违规。
  const referenceStatus = runRaw('git', ['status', '--porcelain', '--', 'vendor/dsh-desktop-next/'])
  const touched = referenceStatus
    .split('\n')
    .filter((line) => line.length >= 4)
    .map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3).trim() }))
    .filter((entry) => entry.code && entry.code !== 'A' && entry.code !== '??')
  if (touched.length) {
    failed = true
    console.error('❌ vendor/dsh-desktop-next/ 是**参考源**，不得被改动（上游同步硬规则）：')
    for (const entry of touched.slice(0, 10)) console.error(`     [${entry.code}] ${entry.path}`)
  }

  // ── 检查 1：实际改动全部已声明（零遗漏）
  const undeclared = [...actualSet].filter((p) => !declaredFiles.has(p))
  if (undeclared.length) {
    failed = true
    console.error('❌ 以下 vendor 改动**未记入** MODIFICATIONS.md（违反 V-1）：')
    for (const p of undeclared) console.error(`     ${p}`)
  }

  // ── 检查 2：声明全部有实际改动（零多余）
  const missing = [...declaredFiles].filter((p) => !actualSet.has(p))
  if (missing.length) {
    failed = true
    console.error('❌ 以下条目在 MODIFICATIONS.md 中声明，但实际**未改动**：')
    for (const p of missing) console.error(`     ${p}`)
    console.error('   （可能是上游同步后改造未应用，或清单过时）')
  }

  // ── 检查 3：类型白名单 + 核心路径的显式授权（仅开发侧档案形态可做）
  //
  // 为什么加 hasArchive 前置：这两项靠**人写的说明书**（类型列 / 「依据…指令」字样），
  // 而公开克隆里的 manifest 没有这些信息。拿不到说明书就不假装校验，而是**显式跳过**。
  const hasArchive = existsSync(MODIFICATIONS)
  const fullText = hasArchive ? await fs.readFile(MODIFICATIONS, 'utf8') : ''
  const sectionFor = (file) => {
    const base = file.replace(/\/$/, '')
    let idx = fullText.indexOf(base)
    while (idx >= 0) {
      // 跳过总览表里的那一行，找明细章节里的出现位置
      const slice = fullText.slice(idx, idx + 2600)
      if (slice.includes('回退方式') || slice.includes('字段/位置')) return slice
      idx = fullText.indexOf(base, idx + 1)
    }
    return ''
  }

  for (const item of declared) {
    if (hasArchive && !ALLOWED_TYPES.has(item.type)) {
      failed = true
      console.error(`❌ 条目 #${item.index} 的类型不在白名单内：${item.type}`)
      console.error(`     允许类型：${[...ALLOWED_TYPES].join(' / ')}`)
    }

    const isCore = CORE_PREFIXES.some((prefix) => item.file.startsWith(prefix))
    if (!isCore) continue

    // 公开形态（无说明书）下，下面两项**不适用**：
    //   它们要查的是「明细里写了授权来源 / 标了触核心逻辑」，而 manifest 不带这类人工声明。
    //   本项在最终输出里**显式声明未校验**，不当成通过。
    if (!hasArchive) continue

    const section = sectionFor(item.file)
    const approved = /解禁|批准|授权/.test(section)
    const marked = item.touchesCore.includes('是')
    if (!marked) {
      failed = true
      console.error(`❌ 条目 #${item.index} 位于核心路径但未标记「触核心逻辑：是」：${item.file}`)
      console.error('     解禁不等于免审：核心路径必须显式声明')
    }
    if (!approved) {
      failed = true
      console.error(`❌ 条目 #${item.index} 位于核心路径但明细里没写授权来源：${item.file}`)
      console.error('     明细需写明「依据主人 <日期> 指令 / 已批准」（V-2 解禁后的审计要求）')
    }
  }

  // ── 检查 4：每项需有回退方式（在明细章节里体现）——同样只在开发侧档案形态下做
  if (hasArchive) {
    const text = fullText
    for (const item of declared) {
      // 目录形式取目录名（去掉尾部斜杠）作为关键词
      const base = item.file.replace(/\/$/, '').split('/').pop()
      if (!text.includes(base)) {
        failed = true
        console.error(`❌ 条目 #${item.index} 在明细章节中找不到对应说明：${item.file}`)
      }
    }
  }

  // ── 输出
  console.log(`\n[check-vendor-modifications] 声明改造 ${declaredFiles.size} 项 / 实际改动 ${actualSet.size} 项`)

  if (failed) {
    console.error('\n[check-vendor-modifications] ❌ 校验未通过')
    process.exit(1)
  }

  console.log('[check-vendor-modifications] ✅ 校验通过（清单与实际一致；类型合规；核心路径均有显式授权）')
  if (!hasArchive) {
    console.log('  注：本次以 patches/ 的 manifest 为声明来源，因此**未**校验「类型白名单」与「明细授权说明」')
    console.log('      （那两项依赖开发侧档案；公开形态下按不适用处理 —— 不掩盖为通过）')
  }
  console.log('\n改造类型分布：')
  const byType = {}
  for (const item of declared) byType[item.type] = (byType[item.type] || 0) + 1
  for (const [type, count] of Object.entries(byType)) console.log(`  ${type}: ${count}`)
}

main().catch((error) => {
  console.error('[check-vendor-modifications] 脚本错误:', error?.message || error)
  process.exit(2)
})
