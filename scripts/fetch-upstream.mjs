#!/usr/bin/env node
/**
 * 取回上游宿主源码。
 *
 * ── 为什么需要这个脚本 ───────────────────────────────────────────────
 * 本仓（社区发行仓）**不再包含 vendor/**：它是上游 MIT 源码的镜像，体积大、与我们的
 * 改动混在一起，且许可只要求保留版权声明（见 THIRD-PARTY-NOTICES.md、UPSTREAM-SOURCES.md）。
 * 于是构建方（CI 与社区开发者）必须能自己把上游取回来，再把我们的受控改造重放上去。
 *
 * 本脚本只做「取回」，改造重放交给 scripts/apply-host-modifications.mjs（它自带
 * fail-closed 的 sha256 对账）—— 两件事分开，各自可单独验证。
 *
 * ── 锁定值从哪来（单一真源）───────────────────────────────────────────
 * 全部读 patches/host-modifications.manifest.json：
 * · baseline 上游 commit（我们改造所基于的确切版本）
 * · upstreamVersion 人类可读版本（v0.11.1），作为按 SHA 取失败时的回退
 * · hostRoot 宿主要落在哪个目录
 * 这里**不另存一份锁定值** —— 两处存同一事实必然漂移（A4）。
 *
 * ── 为什么强制 LF（Windows CI 必踩的坑）───────────────────────────────
 * Windows runner 的 git 默认 core.autocrlf=true → 检出的文本是 CRLF，
 * 而 patches/host-modifications.patch 的上下文行是 LF → `git apply` 直接对不上而失败。
 * 所以所有 git 调用都显式带 -c core.autocrlf=false。**不要"简化"掉这一项**。
 *
 * ── 幂等 ──────────────────────────────────────────────────────────────
 * 已存在且版本正确 → 直接跳过（本地开发反复跑不浪费 5 分钟）。
 * 加了 --force 才强制重取。
 *
 * 用法：
 * node scripts/fetch-upstream.mjs # 取回两个上游并重放改造
 * node scripts/fetch-upstream.mjs --no-next # 不取上游许可源（会让产物缺件，慎用）
 * node scripts/fetch-upstream.mjs --no-apply # 只取回，不重放（调试用）
 * node scripts/fetch-upstream.mjs --force # 强制重取
 *
 * 退出码：0 成功；1 任何一步失败（**不静默降级** —— 取不回就是取不回）
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const MANIFEST_PATH = join(REPO_ROOT, 'patches', 'host-modifications.manifest.json')

/**
 * 上游仓库。
 * manifest 只记 commit 与版本、不记地址，故这里登记一次。
 *
 * dsh-desktop-main：构建基线（DataElement，MIT）。
 *
 * dsh-desktop-next：上游项目（Anywhere Labs，MIT）。**它参与构建** —— 拿的不是它的代码，
 * 而是它的**许可原文**：宿主 package.json 的 build.extraResources 有一条
 * { "from": "../../vendor/dsh-desktop-next/LICENSE",
 * "to": "licenses/DSH-Desktop-Next-MIT.txt" }
 * 即「上游许可」是随安装包分发的六件套之一。
 *
 * ⚠️ 实测事故（v0.1.0 首个 tag，run 39121515555）：曾把它当成「可选参考源」默认不取 →
 * 打包产物缺 licenses/DSH-Desktop-Next-MIT.txt →
 * macOS 与 Windows 的安装 smoke 双双失败：
 * ❌ 许可文件随产物分发 — 已安装应用缺少许可文件：licenses/DSH-Desktop-Next-MIT.txt
 * 而本地全绿（开发机 vendor/ 里那个文件还在）—— 典型的「1~6 层看不见、第 7 层才抓得到」。
 * → 现在**默认取回**，并用下面的许可哈希做 fail-closed 校验。
 */
const MAIN_REPO = 'https://github.com/dataelement/dsh-desktop'
const NEXT_REPO = 'https://github.com/anywhere-labs/dsh-desktop'
const NEXT_BRANCH = 'master'
/** 冻结时 next 的 master 头部（锁定以求可复现；取不到时回退按分支取，并由许可哈希把关）。 */
const NEXT_PIN = '6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a'
/**
 * 上游许可原文的**合同值**。
 * 我们**必须**随包转达这份许可，所以「取到哪个 commit」不重要，
 * 「许可原文是不是这一份」才重要——因此按内容哈希校验，而不是只信 commit/分支。
 * 已核对：此值与本地 vendor/dsh-desktop-next/LICENSE 逐字节相同。
 */
const NEXT_LICENSE_SHA256 = 'ae36246eca21ae16838d566147ab356fd79bdf9ae1c2aa53349700e083f2d679'
/** next 的许可文件在仓库内的相对路径（宿主的 extraResources 正是引用它）。 */
const NEXT_LICENSE_REL = 'LICENSE'

/**
 * 取回目标表（**对外导出**，供 test/release/build-inputs.test.mjs 做跨文件契约断言）：
 * 「构建引用的每个上游源，都必须在取回范围内」—— 这一条就是上面那个事故的回归。
 */
export const FETCH_TARGETS = [
  { dir: 'vendor/dsh-desktop-main', repo: MAIN_REPO, label: '宿主基线' },
  {
    dir: 'vendor/dsh-desktop-next',
    repo: NEXT_REPO,
    label: '上游许可源',
    licenseSha256: NEXT_LICENSE_SHA256
  }
]

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)

/** 跑 git，强制 LF 检出（见文件头注释：Windows 上 `git apply` 会因此失败）。 */
function git(args, opts = {}) {
  return execFileSync(
    'git',
    ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args],
    { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe', cwd: opts.cwd || REPO_ROOT }
  )
}

function log(msg) {
  console.log(`[fetch-upstream] ${msg}`)
}

function fail(msg) {
  console.error(`[fetch-upstream] ❌ ${msg}`)
  process.exit(1)
}

/**
 * 许可原文必须**逐字节**等于冻结值。
 *
 * 为什么不只看 commit：我们的义务是「随包转达这份许可」，不是「取到某个 commit」。
 * 回退按分支取时 commit 可能已经前进；即便 commit 对了，上游也可能悄悄改过许可文本。
 * 按内容哈希校验，才是真正守住义务的那道门 —— 对不上就 EXIT=1，绝不静默放过。
 */
function verifyLicense(dir, who) {
  const file = join(dir, NEXT_LICENSE_REL)
  if (!existsSync(file)) {
    fail(
      `${who}许可缺失：${NEXT_LICENSE_REL} 不在位（${dir}）—— ` +
        '打包产物会缺少 licenses 六件套之一（实测事故：v0.1.0 首个 tag 的双平台安装 smoke 因此失败）'
    )
  }
  const got = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (got !== NEXT_LICENSE_SHA256) {
    fail(
      `${who}许可原文与冻结值不一致：期望 ${NEXT_LICENSE_SHA256.slice(0, 16)}…，实得 ${got.slice(0, 16)}… ` +
        '—— 上游改过许可文本？请人工核对后再更新冻结值（不得不明就里地改哈希）'
    )
  }
  log(`${who}许可原文校验通过（sha256 ${got.slice(0, 16)}…）`)
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    fail(`找不到 ${MANIFEST_PATH} —— 它是锁定值与对账清单的单一真源，缺失即无法构建`)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  } catch (err) {
    fail(`manifest 不是合法 JSON：${err.message}`)
  }
  for (const key of ['baseline', 'upstreamVersion', 'hostRoot']) {
    if (!manifest[key]) fail(`manifest 缺少必需字段 ${key}`)
  }
  return manifest
}

/**
 * 取回一个仓库到指定目录。
 *
 * 按 SHA 取（精确）；失败则回退按 tag 取（用户可读、且 GitHub 允许）。
 * 每次都先 fetch 再 checkout，而不是 clone --depth 1 --branch：
 * 后者对「非分支的裸 SHA」无效，而我们要的正是精确 commit。
 */
function fetchRepo({ repo, ref, fallbackTag, fallbackBranch, into, label }) {
  if (existsSync(into)) {
    log(`${label}: 已存在 ${into}，跳过（--force 可强制重取）`)
    return false
  }

  const staging = mkdtempSync(join(tmpdir(), 'xyb-upstream-'))
  try {
    log(`${label}: 初始化暂存仓库 ${staging}`)
    git(['init', '-q'], { cwd: staging })
    git(['remote', 'add', 'origin', repo], { cwd: staging })

    log(`${label}: 按 commit 取 ${ref}`)
    let exact = false
    try {
      // GitHub 支持按 SHA 浅取；这一步失败不致命，下面还有回退
      git(['fetch', '-q', '--depth', '1', 'origin', ref], { cwd: staging })
      exact = true
    } catch (err) {
      log(`${label}: 按 commit 取失败（${String(err.message).split(String.fromCharCode(10))[0]}），回退`)
    }

    if (!exact) {
      if (fallbackTag) {
        git(['fetch', '-q', '--depth', '1', 'origin', `refs/tags/${fallbackTag}`], { cwd: staging })
      } else if (fallbackBranch) {
        // 回退按分支取：头部可能已经前进，**因此不再要求 SHA 相等** ——
        // 改用「内容级校验」（如许可原文哈希）把关，见 main 里的 verifyLicense。
        git(['fetch', '-q', '--depth', '1', 'origin', fallbackBranch], { cwd: staging })
      } else {
        fail(`${label}: 按 commit ${ref} 取失败，且没有可回退的 tag/branch`)
      }
    }

    git(['checkout', '-q', 'FETCH_HEAD'], { cwd: staging })

    // 按锁定 commit 取时，必须真的是那个 commit（防上游 tag 被移动）
    const got = git(['rev-parse', 'HEAD'], { cwd: staging }).trim()
    if (exact && got !== ref) {
      fail(`${label}: 取到的 commit 是 ${got}，但锁定值是 ${ref} —— 上游 tag 被移动过？拒绝继续`)
    }
    if (!exact) {
      log(`${label}: 回退取到 ${got.slice(0, 12)}（非锁定 commit，将由内容校验把关）`)
    }

    // 去掉 .git 再搬入仓库：我们是「源码镜像」而不是子模块/嵌套仓库
    rmSync(join(staging, '.git'), { recursive: true, force: true })

    const parent = dirname(into)
    mkdirSync(parent, { recursive: true })

    // 优先 rename（同设备时是原子操作）；跨设备会抛 EXDEV，退回 Node 自带的 cpSync。
    // 不用外部的 `cp` 命令：Windows CI 上没有这个可执行文件（Node 22 自带 cpSync）。
    try {
      renameSync(staging, into)
    } catch {
      log(`${label}: 跨设备搬移，改用 cpSync`)
      cpSync(staging, into, { recursive: true })
      rmSync(staging, { recursive: true, force: true })
    }

    log(`${label}: ✅ 已就位 ${into}（commit ${got.slice(0, 12)}）`)
    return true
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  }
}

function main() {
  const manifest = readManifest()
  const hostRoot = join(REPO_ROOT, manifest.hostRoot)

  log(`锁定上游：${manifest.upstreamVersion}（commit ${manifest.baseline}）`)
  log(`目标目录：${manifest.hostRoot}`)

  const force = has('--force')
  if (force && existsSync(hostRoot)) {
    log('--force：删除既有宿主目录重新取回')
    rmSync(hostRoot, { recursive: true, force: true })
  }

  fetchRepo({
    repo: MAIN_REPO,
    ref: manifest.baseline,
    fallbackTag: manifest.upstreamVersion,
    into: hostRoot,
    label: '宿主基线 dsh-desktop-main'
  })

  if (!existsSync(join(hostRoot, 'package.json'))) {
    fail(`${manifest.hostRoot}/package.json 不在位 —— 取回结果不完整`)
  }

  // ── 上游许可源（**参与构建**：它的 LICENSE 是随包六件套之一）──
  // 默认取回。--no-next 可跳过，但那会让打包产物缺件（安装 smoke 会抳住）。
  const nextDir = join(REPO_ROOT, 'vendor', 'dsh-desktop-next')
  if (has('--no-next')) {
    log('--no-next：跳过上游许可源 —— 注意：产物将缺少 licenses/DSH-Desktop-Next-MIT.txt')
  } else {
    fetchRepo({
      repo: NEXT_REPO,
      ref: NEXT_PIN,
      fallbackBranch: NEXT_BRANCH,
      into: nextDir,
      label: '上游许可源 dsh-desktop-next'
    })
    // 不论“刚取回”还是“已存在跳过”，都要校验 —— 否则 skip 分支会静默放过缺件
    verifyLicense(nextDir, '上游')
  }

  if (has('--no-apply')) {
    log('--no-apply：跳过改造重放')
    log('✅ 取回完成')
    return
  }

  // 重放我们的受控改造。它自带 fail-closed 对账（每个目标文件 sha256 必须匹配 manifest），
  // 对不上就 EXIT=1 —— 绝不允许「看起来成功」。
  log('重放受控改造：node scripts/apply-host-modifications.mjs')
  try {
    execFileSync('node', [join('scripts', 'apply-host-modifications.mjs')], {
      cwd: REPO_ROOT,
      stdio: 'inherit'
    })
  } catch (err) {
    fail(`改造重放失败（EXIT ${err.status ?? '?'}）—— 宿主树与 manifest 不一致，拒绝继续`)
  }

  const stat = statSync(hostRoot)
  if (!stat.isDirectory()) fail(`${manifest.hostRoot} 不是目录`)
  log('✅ 完成：上游已取回且改造已重放（与 manifest 逐文件对账通过）')
}

// 允许被 import：test/release/build-inputs.test.mjs 要读 FETCH_TARGETS 做跨文件契约断言。
// 只有「直接执行」时才跑 main（被 import 时不跑）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
