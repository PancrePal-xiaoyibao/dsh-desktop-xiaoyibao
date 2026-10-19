/**
 * · 把「我们对宿主的 16 项改造」重放到一份**上游原样副本**上。
 *
 * ── 为什么需要它（架构变化的核心）───────────────────────────────
 * 原来：vendor/ 里的宿主源码**直接提交进仓库**（713 个文件），构建就从它出发。
 * 现在：宿主是**参考素材**，不进仓库；CI/开发者构建时按锁定 SHA 取回上游，
 * 再由本脚本重放我们那 16 项改造 —— 于是仓库里只剩「我们自己的代码」。
 *
 * ── 三个输入（都在仓库里，缺一不可）─────────────────────────────
 * patches/host-modifications.patch 文本改动（8 个文件）
 * patches/host-modifications.manifest.json 逐文件 sha256（验收依据）
 * assets/host-build/ 品牌资产（5 项，拷贝式改动）
 *
 * ── 为什么要 sha256 对账而不是"跑完就算"─────────────────────────
 * `git apply` 成功只说明**补丁打上去了**，不说明**结果与原来一致**。
 * 上游升版本、补丁过期、资产被换掉 —— 这些都不报错但结果已经偏了。
 * 所以打完必须逐文件比 sha256：**只有全部命中才算成功**（fail-closed）。
 *
 * 用法：
 * node scripts/apply-host-modifications.mjs # 应用到 vendor/dsh-desktop-main
 * node scripts/apply-host-modifications.mjs --root /tmp/pristine # 应用到别的根（验证用）
 * node scripts/apply-host-modifications.mjs --check # 只校验，不改文件
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const VENDOR_REL = 'vendor/dsh-desktop-main'
const PATCH_REL = 'patches/host-modifications.patch'
const MANIFEST_REL = 'patches/host-modifications.manifest.json'
const ASSETS_REL = 'assets/host-build'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const ROOT = val('--root', REPO)
const CHECK_ONLY = has('--check')
const PATCH = has('--no-patch') // 供「资产已就位、只补文本」的场景
const VENDOR = join(ROOT, VENDOR_REL)

/**
 * 文件摘要（**行尾归一化**）。
 *
 * ⚠ 必须归一化 CRLF→LF：本仓 core.autocrlf=true，开发机工作区是 CRLF、
 * git archive / CI（Linux、macOS）产出的是 LF —— 按原始字节算 hash，
 * 同一份内容在 Windows 过、在 CI 上必然失败（实测踩到：12 个文件里
 * package.json 差一个 hash，其余恰好两边同为 LF 才蒙对）。
 * 验收要的是"内容一致"，不是"字节一致"。
 */
const BIN_EXT = ['icns','ico','png','jpg','jpeg','gif','webp','woff','woff2','ttf','otf','dmg','exe','zip','asar']
const isBinary = (rel) => BIN_EXT.includes(String(rel).split('.').pop().toLowerCase())

/**
 * 文件摘要。两条规矩各踩过一次坑：
 * ① 文本要**归一化行尾**：本仓 core.autocrlf=true，开发机是 CRLF、
 * git archive / CI（Linux、macOS）是 LF —— 按原始字节算 hash，
 * 同一内容在 Windows 过、在 CI 上必失败。验收要「内容一致」不是「字节一致」。
 * ② 二进制**绝不能归一化**：把 .icns/.ico/.png 读成 UTF-8 再删字节会毁掉内容
 * （实测：4 个图标 hash 全不符，而它们其实完全正确）。
 * 用 String.fromCharCode(13) 与扩展名数组，全程不写转义序列 ——
 * 多层转义曾把回车换行解成真实换行，导致语法错误。
 */
const sha = async (p, binary = false) => {
  const buf = await readFile(p)
  if (binary || isBinary(p)) return createHash('sha256').update(buf).digest('hex').slice(0, 16)
  const text = buf.toString('utf8').split(String.fromCharCode(13)).join('')
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
const problems = []
const say = (m) => console.log(`[apply] ${m}`)

/* ── 0. 输入自检（缺一个就别往下走）── */
for (const rel of [PATCH_REL, MANIFEST_REL]) {
  if (!existsSync(join(REPO, rel))) {
    console.error(`[apply] ✗ 缺少 ${rel} —— 无法重放改造`)
    process.exit(2)
  }
}
if (!existsSync(VENDOR)) {
  console.error(`[apply] ✗ 目标不存在：${VENDOR}`)
  console.error(`[apply]   先取回上游原样副本，例如：`)
  console.error(`[apply]     git clone --depth 1 https://github.com/dataelement/dsh-desktop /tmp/up`)
  console.error(`[apply]     git -C /tmp/up fetch origin 115a0b474cc2c4794316171c640a8898398591fe`)
  console.error(`[apply]     git -C /tmp/up checkout 115a0b47 && cp -r /tmp/up ${VENDOR}`)
  process.exit(2)
}

const manifest = JSON.parse(await readFile(join(REPO, MANIFEST_REL), 'utf8'))
say(`目标：${VENDOR}`)
say(`基线：上游 ${manifest.upstreamVersion} @ ${manifest.baseline.slice(0, 8)}`)
say(`预期：${Object.keys(manifest.files).length} 个文本文件 + ${Object.keys(manifest.assets).length} 项资产`)

/* ── 1. 应用文本补丁 ── */
if (!CHECK_ONLY && !PATCH) {
  const r = spawnSync(
    'git',
    // ⚠️ 行尾必须钉死：
    // `git apply` 对行尾敏感。补丁是 LF，若目标树是 CRLF（或反过来），
    // 8 个文件会全部报 "patch does not apply"。
    // 宿主机 git 配置因平台/机器而异（Windows 常为 core.autocrlf=true），
    // 所以这里**显式指定**而非常依赖环境；.gitattributes 也把
    // patches/*.patch 声明为 -text（永不转换）、vendor/** 声明为 eol=lf。
    // 两处共同保证：补丁与目标树在我们控制的每一台机器上都是 LF。
    ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--whitespace=nowarn', join(REPO, PATCH_REL)],
    {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8'
    }
  )
  if (r.status !== 0) {
    // 输出必须可见（绝不 stdio:'ignore' —— 那等于把失败原因丢掉）
    console.error('[apply] ✗ git apply 失败：')
    console.error((r.stderr || r.stdout || '').trim())
    console.error('[apply]   常见原因：上游换版本了（补丁基线不匹配），或 vendor 副本不是原样的')
    process.exit(1)
  }
  say(`✓ 文本补丁已应用（${Object.keys(manifest.files).length} 个文件）`)
} else if (CHECK_ONLY) {
  say('（--check：跳过补丁应用，只校验当前状态）')
}

/* ── 2. 拷贝品牌资产（5 项，不走 patch）── */
if (!CHECK_ONLY) {
  let copied = 0
  for (const rel of Object.keys(manifest.assets)) {
    const src = join(REPO, ASSETS_REL, rel)
    const dst = join(VENDOR, rel)
    if (rel.endsWith('/')) {
      // 目录（build/xyb/）：逐个文件拷贝
      const { readdir } = await import('node:fs/promises')
      const walk = async (a, b) => {
        await mkdir(b, { recursive: true })
        for (const e of await readdir(a, { withFileTypes: true })) {
          if (e.isDirectory()) await walk(join(a, e.name), join(b, e.name))
          else {
            await copyFile(join(a, e.name), join(b, e.name))
            copied += 1
          }
        }
      }
      await walk(src, dst)
    } else {
      await mkdir(dirname(dst), { recursive: true })
      await copyFile(src, dst)
      copied += 1
    }
  }
  say(`✓ 品牌资产已就位（${copied} 个文件）`)
}

/* ── 3. 逐文件 sha256 对账（**这一步才是真正的验收**）── */
for (const [rel, want] of Object.entries(manifest.files)) {
  const p = join(VENDOR, rel)
  if (!existsSync(p)) {
    problems.push(`缺失：${rel}`)
    continue
  }
  const got = await sha(p)
  if (got !== want) problems.push(`内容不符：${rel}  期望 ${want} 实际 ${got}`)
}
for (const [rel, want] of Object.entries(manifest.assets)) {
  if (rel.endsWith('/')) continue // 目录在下一步按文件数校验
  const p = join(VENDOR, rel)
  if (!existsSync(p)) {
    problems.push(`资产缺失：${rel}`)
    continue
  }
  const got = await sha(p)
  if (got !== want) problems.push(`资产内容不符：${rel}  期望 ${want} 实际 ${got}`)
}

/* ── 4. 关键字段抽查（防"补丁打上了但语义没生效"）── */
try {
  const pkg = JSON.parse(await readFile(join(VENDOR, 'package.json'), 'utf8'))
  const expect = {
    'build.appId': 'com.pancrepal.xyb.desktop',
    'build.productName': '小胰宝社区版'
  }
  for (const [k, v] of Object.entries(expect)) {
    const got = k.split('.').reduce((o, kk) => (o ? o[kk] : undefined), pkg)
    if (got !== v) problems.push(`字段未生效：${k} 期望 "${v}" 实际 "${got}"`)
  }
  if (!Array.isArray(pkg.build?.publish) || pkg.build.publish.length !== 0) {
    problems.push(`字段未生效：build.publish 应为 []（关闭官方更新源），实际 ${JSON.stringify(pkg.build?.publish)}`)
  }
} catch (e) {
  problems.push(`package.json 不可解析：${(e && e.message) || e}`)
}

/* ── 5. 结论（fail-closed）── */
if (problems.length) {
  console.error('')
  console.error(`[apply] ✗ 对账失败（${problems.length} 项）—— 拒绝声称改造已就位：`)
  for (const p of problems.slice(0, 12)) console.error('   · ' + p)
  process.exit(1)
}
say('')
say(`✓ 改造已就位并通过 sha256 对账：${Object.keys(manifest.files).length} 个文本文件 + ${Object.keys(manifest.assets).length} 项资产`)
say('  宿主现在是「上游原样 + 我们的 16 项改造」，与提交 vendor 时的状态一致。')
