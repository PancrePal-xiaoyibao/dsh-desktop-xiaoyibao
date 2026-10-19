#!/usr/bin/env node
/**
 * 公开引用闸门（CHG-017 Z-3 的衍生品）。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────
 * 本仓要转为 public。公开后，外部开发者会读到我们的文档与代码注释 ——
 * 如果里面出现**指向不存在东西的引用**，读者照做必然踩空：
 *
 *   · `tasks/CHG-000/MODIFICATIONS.md`  → tasks/ 不入库（且已从历史清除）
 *   · `agent-reference/environment.md`  → 该目录不入库（宿主机画像）
 *   · `vendor/dsh-desktop-main/docs/…`  → vendor/ 不在仓库里（构建时按锁定 SHA 取回）
 *   · `（CHG-016）`                     → 变更档案不公开，读者无从查证
 *
 * 最后一类尤其隐蔽：它不是"路径不存在"，而是"**引用了读者无法查证的东西**"。
 * 而项目自己的代码规范就写着「注释说明**原因**，不复述代码做什么」——
 * 只写一个内部编号，等于既没给原因、又给了个查不到的指路牌。
 *
 * ── 两种模式 ──────────────────────────────────────────────────────
 *   node scripts/check-public-references.mjs            # 报告模式（默认，EXIT=0）—— 用作普查工具
 *   node scripts/check-public-references.mjs --strict   # 严格模式（有命中即 EXIT=1）—— 供 CI 使用
 *
 * ── 为什么默认是报告模式 ──────────────────────────────────────────
 * 普查时命中会很多（存量），此时若直接红，会逼人「为了让 CI 变绿而放宽规则」（测试纪律 R4 明令禁止）。
 * 先把清单变成数字，再逐批清零；清零后把 CI 切到 --strict，从此不许回退。
 *
 * ── 允许的例外（逐条有理由，不是"懒得改"）────────────────────────
 * 见 ALLOW：描述上游来源与取回方式的少数文件，必须写明路径才有可能照做。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const SELF = 'scripts/check-public-references.mjs'

const STRICT = process.argv.includes('--strict')

/**
 * 规则表。
 * `allow` 是该规则**放行**的文件清单，每条都要能说出理由 —— 否则就是在给技术债开后门。
 */
const RULES = [
  {
    id: 'tasks-path',
    label: 'tasks/ 路径引用',
    pattern: /tasks\/[A-Za-z0-9._/-]+/g,
    hint: 'tasks/ 不入库（且已从历史清除）→ 改为描述性表述，或指向真实存在的公开文件',
    severity: 'error',
    allow: [
      // 它**就是**「禁止内部路径出现在界面文案里」的规则定义本身
      'test/design/no-internal-refs.test.mjs',
      // 补丁是字节级构建输入：清它必须重新生成补丁 + 重新对账（见 ZERO-REVIEW 待办）
      'patches/host-modifications.patch'
    ]
  },
  {
    id: 'agent-reference',
    label: 'agent-reference/ 引用',
    pattern: /agent-reference\/[A-Za-z0-9._/-]+/g,
    hint: 'agent-reference/ 是宿主机画像，不入库 → 改为自洽表述或删除',
    severity: 'error',
    allow: []
  },
  {
    id: 'change-id',
    label: 'CHG 变更编号',
    pattern: /CHG-\d{3}/g,
    hint: '变更档案不公开 → 把编号换成它背后**真正的原因**（项目规范本就要求注释写原因）',
    severity: 'error',
    allow: [
      'test/design/no-internal-refs.test.mjs', // 规则定义（断言界面文案不得出现变更编号）
      'patches/host-modifications.patch', // 字节级构建输入，需重新生成
      'packages/dsh-xyb-qingnang/vendor/' // 第三方 vendored 代码：不修改（V-3 上游同步）
    ]
  },
  {
    id: 'retired-mirror',
    label: '已删除的镜像仓引用',
    pattern: /dsh-desktop-xiaoyibao-release/g,
    hint: '镜像仓模型已废除（仓库已删）→ 本仓即公开仓',
    severity: 'error',
    allow: [
      // 踩坑记录：需逐字记述当时的仓名，否则事故描述失实（史实不改）
      'AGENTS.md',
      'CLAUDE.md',
      // 它断言「release.yml 里不得再出现该仓名」——规则定义本身
      'test/release/release-workflow.test.mjs'
    ]
  },
  {
    id: 'vendor-path',
    label: '宿主编译路径引用',
    pattern: /vendor\/dsh-desktop-[a-z]+\/[A-Za-z0-9._/-]+/g,
    hint: 'vendor/ 不在仓库里，但**构建时真实存在**（fetch-upstream 会创建）→ 只作提示，不阻断',
    // ⚠️ 为什么降为 info 而不是继续当错误：
    //   `tasks/` 是**必然悬空**（永远不在仓库里）；而 `vendor/` 是**取回后真实存在**的路径。
    //   工具与文档必须写明它才能让人照做（参照 ZERO-REVIEW 记录的教训）。
    //   把它当错误会逼人要么删掉必要信息、要么给整批文件开白名单——两者都是自欺。
    severity: 'info',
    allow: []
  }
]

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split(String.fromCharCode(10))
    .filter(Boolean)
}

function scan() {
  const findings = []
  for (const rel of trackedFiles()) {
    if (rel === SELF) continue // 本文件自身含规则字样，跳过（否则自己命自己）
    const abs = join(REPO_ROOT, rel)
    if (!existsSync(abs)) continue
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue // 二进制或读不了：跳过（许可原文、图片等）
    }
    if (text.includes(String.fromCharCode(0))) continue
    const lines = text.split(String.fromCharCode(10))
    for (const rule of RULES) {
      // 白名单支持「文件」与「目录前缀」两种写法（目录以 / 结尾）
      const allowed = rule.allow.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a))
      if (allowed) continue
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        // `.gitignore` / `.gitattributes` 里的**忽略模式行**是必须存在的
        // （我们正是要忽略 tasks/ 与 agent-reference/），但注释行仍要扫。
        // 不这么分：闸门会把「正确忽略内部目录」当成违规，逼人删掉忽略规则。
        if ((rel === '.gitignore' || rel === '.gitattributes') && !line.trimStart().startsWith('#')) continue
        rule.pattern.lastIndex = 0
        const m = line.match(rule.pattern)
        if (m) {
          findings.push({ file: rel, line: i + 1, rule: rule.id, severity: rule.severity, hits: m.length, sample: m[0] })
        }
      }
    }
  }
  return findings
}

function main() {
  const findings = scan()
  const byRule = {}
  const byFile = {}
  let errors = 0
  for (const f of findings) {
    byRule[f.rule] = (byRule[f.rule] ?? 0) + f.hits
    byFile[f.file] = (byFile[f.file] ?? 0) + f.hits
    if (f.severity !== 'info') errors += f.hits
  }

  console.log(`[public-refs] 扫描 ${trackedFiles().length} 个跟踪文件，命中 ${findings.length} 行（其中**阻断级** ${errors} 处）`)
  console.log('')
  if (findings.length === 0) {
    console.log('[public-refs] ✅ 零命中：公开集里没有指向不存在东西的引用')
    return
  }

  console.log('  按规则：')
  for (const rule of RULES) {
    const n = byRule[rule.id] ?? 0
    if (n > 0) console.log(`    ${rule.label.padEnd(22)} ${n} 处  [${rule.severity === 'info' ? '提示' : '阻断'}]`)
  }
  console.log('')
  console.log('  按目录：')
  const byDir = {}
  for (const [file, n] of Object.entries(byFile)) {
    const d = file.includes('/') ? file.split('/').slice(0, 2).join('/') : '(根文件)'
    byDir[d] = (byDir[d] ?? 0) + n
  }
  for (const [d, n] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${d.padEnd(22)} ${n} 处`)
  }
  console.log('')
  console.log('  前 40 个文件（文件:行 规则 样例）：')
  for (const [file, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    const first = findings.find((f) => f.file === file)
    console.log(`    ${String(n).padStart(3)}  ${file}:${first.line}  [${first.rule}]  ${first.sample}`)
  }
  console.log('')
  for (const rule of RULES) {
    if ((byRule[rule.id] ?? 0) > 0) console.log(`  · ${rule.label}：${rule.hint}`)
  }
  console.log('')
  console.log(
    STRICT
      ? errors > 0
        ? `[public-refs] ❌ 严格模式下不允许**阻断级**命中（当前 ${errors} 处）`
        : `[public-refs] ✅ 严格模式通过（阻断级 0 处；提示级 ${findings.length - errors} 处不计）`
      : '[public-refs] （报告模式：仅统计，不阻断。阻断级清零后请把 CI 切到 --strict）'
  )
  if (STRICT && errors > 0) process.exit(1)
}

main()
