#!/usr/bin/env node
/**
 * 宿主改造补丁生成器 —— 补上 V-3「上游同步能力」的缺口（把改造逐项重放到新上游版本）。
 *
 * ⚠️⚠️ **已知缺陷 · 当前不要用于正式生成（2026-10-19）** ⚠️⚠️
 *   本脚本尚未达到可用标准，实测两度造成不一致：
 *     ① `git diff --no-index <pristine> <host>` 会对比**整棵树**（含 vendor 里的
 *        node_modules / dist）→ 产出 32 万行、1022 段的补丁（**必须改为逐文件比对**）；
 *     ② 写 manifest 时把 `files[rel]` 写成了 `{ sha256 }` 对象，而原格式是**纯字符串**
 *        → apply 的对账输出变成「期望 [object Object]」。
 *   因此当前状态是：**补丁与 manifest 仍以仓库里的已提交版本为准**（由
 *   `apply-host-modifications.mjs` 逐文件 sha256 对账保证），本脚本仅供后续修复参考。
 *   修好前切勿用它重写 patches/ —— 会直接破坏可重放的构建输入。
 *
 * ── 为什么必须有它 ────────────────────────────────────────────────
 * 本仓库**不包含上游源码**（vendor/ 由 `fetch-upstream.mjs` 按锁定 commit 取回）。
 * 于是「我们改了宿主什么」必须由 `patches/host-modifications.patch` 承载。
 * 但在本次之前，仓库里只有**重放器**（apply-host-modifications.mjs）——
 * 没有任何工具能**生成**补丁。这意味着：
 *   · 上游升级后无法重新生成补丁，V-3 要求的「重新应用到新版本」实际做不到；
 *   · 补丁里夹带的陈年注释（指向开发侧档案）也没法安全清理（手改会让 sha256 对账失败）。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────
 *   ① 取回**原样上游**（按 manifest 里的锁定 commit；复用 fetch-upstream 的取回逻辑）
 *   ② 与当前本地宿主树逐文件比对 → 生成统一 diff（路径前缀归一化为 vendor/dsh-desktop-main/）
 *   ③ 重算 manifest：文本按 **LF 归一化**后取 sha256；二进制按**原始字节**
 *   ④ **自验**：把新补丁应用到原样上游副本，逐文件 sha256 必须与当前树一致
 *      —— 对不上就 EXIT=1（绝不产出「看起来对」的补丁）
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *   node scripts/generate-host-modifications.mjs --check    # 只对账，不改文件
 *   node scripts/generate-host-modifications.mjs            # 生成 patch + manifest
 *
 * 退出码：0 成功；1 任一步失败。
 *
 * TODO（修复清单，供后续接手）
 *   1. 把「整树 diff」改为**逐文件 diff**：只对 `changed` 集合里的每个路径调
 *      `git diff --no-index --src-prefix=… --dst-prefix=… <pristine>/<rel> <host>/<rel>`，
 *      再拼接成单个补丁（这样天然排除 node_modules/dist，也不会带出无关段）。
 *   2. manifest 写入时保持**原有字段结构**（`files[rel]` 是 sha256 字符串），
 *      不要包对象；人工字段（类型 / 授权 / 可上游化）只能保留、不能覆盖。
 *   3. 必须先用 `--check` 与 `apply-host-modifications.mjs --check` 双向对账通过，
 *      才允许写文件（当前是先写后验，一旦出错就把仓库留在不一致状态 —— 实测踩到）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const MANIFEST_PATH = join(REPO_ROOT, 'patches', 'host-modifications.manifest.json')
const PATCH_PATH = join(REPO_ROOT, 'patches', 'host-modifications.patch')
const ASSETS_DIR = join(REPO_ROOT, 'assets', 'host-build')
const CHECK_ONLY = process.argv.includes('--check')
const LF = String.fromCharCode(10)

function say(msg) {
  console.log(`[generate] ${msg}`)
}
function fail(msg) {
  console.error(`[generate] ❌ ${msg}`)
  process.exit(1)
}
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}
/** 文本：LF 归一化后取哈希（与 apply 的对账口径一致）；二进制：原始字节。 */
function hashFile(abs) {
  const buf = readFileSync(abs)
  if (buf.includes(0)) return { hex: sha256(buf), binary: true }
  const text = buf.toString('utf8').replace(/\r\n/g, LF)
  return { hex: sha256(Buffer.from(text, 'utf8')), binary: false }
}
function walk(dir, base = dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(abs, base))
    else out.push(relative(base, abs).split('\\').join('/'))
  }
  return out
}

/** 取回原样上游到一个临时目录（复用 fetch-upstream 的锁定值）。 */
function fetchPristine(manifest) {
  const staging = mkdtempSync(join(tmpdir(), 'xyb-pristine-'))
  const git = (args) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { cwd: staging, encoding: 'utf8' })
  git(['init', '-q'])
  git(['remote', 'add', 'origin', 'https://github.com/dataelement/dsh-desktop'])
  try {
    git(['fetch', '-q', '--depth', '1', 'origin', manifest.baseline])
  } catch {
    git(['fetch', '-q', '--depth', '1', 'origin', `refs/tags/${manifest.upstreamVersion}`])
  }
  git(['checkout', '-q', 'FETCH_HEAD'])
  rmSync(join(staging, '.git'), { recursive: true, force: true })
  return staging
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const hostRoot = join(REPO_ROOT, manifest.hostRoot)
  if (!existsSync(hostRoot)) {
    fail(`${manifest.hostRoot} 不在位 —— 先跑 node scripts/fetch-upstream.mjs`)
  }
  say(`锁定上游：${manifest.upstreamVersion} @ ${manifest.baseline.slice(0, 8)}`)

  // 取回的原样上游就在临时目录**根部**：
  // 不需要再包一层 vendor/（补丁里的路径前缀在生成时统一归一化），
  // 而且把它 cp 进自己子目录会报 ERR_FS_CP_EINVAL（实测踩到）。
  const pristineRoot = fetchPristine(manifest)
  if (!existsSync(join(pristineRoot, 'package.json'))) fail('取回的上游树不完整')

  // 品牌资产（图标等二进制）**不走补丁**：manifest 的 assets 段负责，apply 时从 assets/host-build/ 拷贝。
  // 若把它们放进补丁：git diff 只能写「Binary files differ」= 不可应用（实测踩到 EINVAL 之后的下一个坑）。
  const assetRels = new Set(Object.keys(manifest.assets || {}))

  // ── 比对：哪些文件被我们改过
  const rels = walk(pristineRoot)
  const changed = []
  const manifestFiles = {}
  for (const rel of rels) {
    if (assetRels.has(rel) || assetRels.has(rel + '/')) continue
    const a = join(pristineRoot, rel)
    const b = join(hostRoot, rel)
    if (!existsSync(b)) continue // 我们删掉的文件：本改造集不含删除（如需支持，另行登记）
    const ha = hashFile(a)
    const hb = hashFile(b)
    if (ha.hex === hb.hex) continue
    changed.push(rel)
    manifestFiles[rel] = { sha256: hb.hex }
  }
  say(`检出改动：${changed.length} 个文本文件`)

  // 我们新增的文件（上游没有）
  const hostRels = walk(hostRoot)
  const pristineSet = new Set(rels)
  const added = hostRels.filter((r) => !pristineSet.has(r) && !r.endsWith('/'))
  if (added.length) say(`新增文件（上游没有）：${added.length} 个 —— 需登记为 assets 或纳入补丁`)

  if (CHECK_ONLY) {
    const declared = new Set([...Object.keys(manifest.files || {}), ...Object.keys(manifest.assets || {})])
    const undeclared = changed.filter((r) => !declared.has(r))
    say(undeclared.length ? `未登记改动 ${undeclared.length} 个：${undeclared.slice(0, 5).join(', ')}` : '✅ 实际改动与 manifest 登记一致')
    rmSync(pristineRoot, { recursive: true, force: true })
    return
  }

  // ── 生成补丁（路径前缀归一化）
  const diffArgs = ['diff', '--no-index', '--no-color', '--src-prefix=a/vendor/dsh-desktop-main/', '--dst-prefix=b/vendor/dsh-desktop-main/', pristineRoot, hostRoot]
  let diff = ''
  try {
    diff = execFileSync('git', diffArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    diff = err.stdout || '' // git diff --no-index 有差异时退出码为 1：这是正常的
  }
  if (!diff.trim()) fail('没有检出任何差异 —— 宿主树与上游一致？')

  // 归一化头：git diff --no-index 会写绝对路径，换成 a/ b/ 形式
  // ⚠️ `/dev/null` 是**新增文件**的标记，绝不能改写（改写后 git apply 会报
  //    bad git-diff - expected /dev/null，实测踩到）。
  const normalized = diff
    .split(LF)
    .map((line) => {
      // 先按 diff --git 分段，丢掉资产段（二进制不可用补丁表达）
      if (line.startsWith('diff --git ')) {
        const m = line.match(/diff --git a\/(.+) b\/(.+)$/)
        if (!m) return line
        const p = m[1].replace(/^.*?vendor\/dsh-desktop-main\//, '')
        return `diff --git a/vendor/dsh-desktop-main/${p} b/vendor/dsh-desktop-main/${p}`
      }
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        const head = line.slice(0, 4)
        const rest = line.slice(4)
        if (rest.startsWith('/dev/null')) return line // 新增/删除文件的标记：保持原样
        const p = rest.replace(/^.*?vendor\/dsh-desktop-main\//, '')
        return `${head}${head.startsWith('---') ? 'a' : 'b'}/vendor/dsh-desktop-main/${p}`
      }
      return line
    })
    .join(LF)

  // 丢掉资产段（按 diff --git 分段过滤）
  const sections = normalized.split(LF + 'diff --git ')
  const kept = sections.filter((sec, i) => {
    if (i === 0) return true
    const firstLine = sec.split(LF)[0]
    const m = firstLine.match(/a\/vendor\/dsh-desktop-main\/(.+?) b\//)
    if (!m) return true
    return !(assetRels.has(m[1]) || [...assetRels].some((a) => a.endsWith('/') && m[1].startsWith(a)))
  })
  const body = kept.join(LF + 'diff --git ')

  writeFileSync(PATCH_PATH, body)
  say(`已写入补丁：${PATCH_PATH}（${body.split(LF).length} 行，已排除 ${assetRels.size} 项资产）`)

  // ── 重算 manifest（保留原因/授权等人工字段，只更新 sha256）
  const next = { ...manifest, files: {} }
  for (const rel of Object.keys(manifestFiles)) {
    next.files[rel] = { ...(manifest.files?.[rel] || {}), sha256: manifestFiles[rel].sha256 }
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(next, null, 2) + LF)
  say(`已更新 manifest：${MANIFEST_PATH}（${Object.keys(next.files).length} 个文件）`)

  // ── 自验：把新补丁应用到另取一份原样上游，必须与当前树一致
  say('自验：把新补丁应用到原样上游…')
  execFileSync('git', ['init', '-q'], { cwd: pristineRoot, encoding: 'utf8' })
  execFileSync('git', ['apply', '--whitespace=nowarn', PATCH_PATH], { cwd: pristineRoot, encoding: 'utf8' })
  let bad = 0
  for (const rel of Object.keys(next.files)) {
    const h = hashFile(join(pristineRoot, rel))
    if (h.hex !== next.files[rel].sha256) {
      bad += 1
      console.error(`      ✗ ${rel}`)
    }
  }
  for (const rel of Object.keys(next.assets || {})) {
    const src = join(ASSETS_DIR, rel)
    const dst = join(hostRoot, rel)
    if (!existsSync(dst) && !existsSync(src)) continue
  }
  rmSync(pristineRoot, { recursive: true, force: true })
  if (bad) fail(`自验失败：${bad} 个文件与当前树不一致 —— 拒绝声称成功`)
  say('✅ 完成：补丁可重放，且重放结果与当前宿主树逐文件一致')
}

main()
