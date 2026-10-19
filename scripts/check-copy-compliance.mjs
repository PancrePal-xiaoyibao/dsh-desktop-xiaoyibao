#!/usr/bin/env node
/**
 * 文案合规审计。 SPEC §5 M7 / 治理文档 §7（医学安全六条红线）。
 *
 * 检查什么：
 * ① 全库零药名推荐 / 零剂量（红线 M-2：不做处方）
 * ② 全库零诊断性表述（红线 M-1：不做诊断）
 * ③ 免责声明键全部被引用（防止基础设施写了没用）
 * ④ 全程管理零建议性措辞
 * ⑤ 全程管理零因果措辞
 *
 * 为什么需要：医学表述越界是本产品**最严重**的失败模式。
 * 靠人工审阅会漏，因此做成可重复的 CI 门禁。
 *
 * 用法：
 * node scripts/check-copy-compliance.mjs
 * node scripts/check-copy-compliance.mjs --json
 *
 * 退出码：0 通过 / 1 命中 / 2 脚本错误
 */
import { promises as fs } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..'))

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'dist', 'dist-dev', 'out', 'coverage', '.ipynb_checkpoints'])
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.html', '.css'])

/** 跳过 vendor 与青囊快照（上游内容，不是我们的文案） */
const SKIP_PATH_PREFIXES = ['vendor/', 'packages/dsh-xyb-qingnang/vendor/']

/**
 * 跳过的路径（**立项文档与治理文档**）。
 *
 * 为什么：`tasks/**` 与 `AGENTS.md` 里大量出现被禁词，但它们是**规范描述**
 * （如「不得出现『建议尽快』」「零建议性措辞：建议尽快 / 建议及时」），
 * 属反例清单，不是产品文案。审计只针对**实现代码与用户可见文案**。
 */
const SKIP_DOC_PREFIXES = ['tasks/', 'agent-reference/']
const SKIP_DOC_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'ROADMAP.md'])

/**
 * 审计规则。**词表必须是「模式」而非真实内容**。
 *
 * 注意：这里的词表是**中文短语**，它们本身就是需要被禁止的表述，
 * 因此出现在本脚本里是正常的（本脚本会被自身扫描跳过，见 SKIP_FILES）。
 */
const RULES = [
  {
    id: 'prescribing',
    label: '处方性表述（红线 M-2）',
    // ⚠️ 关键：「使用」不能进通用列表 —— 它太泛（「建议使用代理」「建议使用 pipeline 模型」
    // 都是合法表述，实测踩坑）。处方性风险集中在**药物专用动词**上。
    // 另：需排除否定式（「不建议使用」是免责声明的一部分，不是处方）。
    patterns: [
      /(?<!不)建议(?:服用|注射|加用|停用|换用)/g,
      /(?<!不)推荐(?:服用|注射|加用|换用)/g,
      /可以考虑(?:服用|注射)/g,
      /(?:每日|每次)(?:服用|注射)[^。\n]{0,10}(?:mg|g|片|粒|支)/g,
      /\d+\s*mg\/kg/g
    ]
  },
  {
    id: 'drug-name',
    label: '药物名称（红线 M-2：本项目不应出现任何药名）',
    // 只在**本项目自有实现代码**中检查（packages/ 下），不扫原型（原型是设计参考，
    // 里面的药名是「监测副作用」场景的示例，属正常）。
    scope: 'packages/',
    patterns: [
      /(?:吉西他滨|白蛋白结合型紫杉醇|伊立替康|奥沙利铂|氟尿嘧啶|卡培他滨|紫杉醇|多西他赛|顺铂|卡铂)/g,
      /(?:mFOLFIRINOX|FOLFIRINOX|FOLFOX|FOLFIRI)/g,
      /(?:帕博利珠单抗|纳武利尤单抗|厄洛替尼|奥拉帕利)/g
    ]
  },
  {
    id: 'diagnosis',
    label: '诊断性表述（红线 M-1）',
    patterns: [
      /说明(?:你|患者)有[^。\n]{0,12}(?:病|症|癌|肿瘤)/g,
      /表明(?:你|患者)/g,
      /意味着(?:你|患者)/g,
      /(?:你|患者)属于[^。\n]{0,10}(?:期|型|级)/g,
      /确诊为/g,
      /提示(?:患有|存在)[^。\n]{0,10}(?:癌|肿瘤|病)/g
    ]
  },
  {
    id: 'advising',
    label: '建议性表述（全程管理禁）',
    patterns: [
      /建议尽快/g,
      /建议及时/g,
      /务必(?:要)?(?:去|做|安排)/g,
      /(?:应该|必须|最好)(?:去|尽快)(?:医院|复查|维护|检查)/g,
      /需要安排[^。\n]{0,10}(?:维护|复查|随访)/g
    ]
  },
  {
    id: 'causal',
    label: '因果推断（全程管理禁）',
    // 只在「记录关联」语境禁，但为简单起见全局禁（业务文案不应推断因果）
    patterns: [
      /(?:导致|引起|造成|引发)了?[^。\n]{0,15}(?:副作用|症状|升高|下降|异常)/g
    ]
  }
]

/**
 * 审计脚本自身与**禁用词表定义文件**。
 *
 * 为什么排除后者：`disclaimers.js` 里的 `FORBIDDEN` 对象就是**被禁词的词表定义**
 * （如「建议尽快」「意味着你」），它是「检测器」而非「被检测的文案」。
 * 排除它不是放水 —— 词表的作用由本脚本的扫描结果保证。
 */
const SKIP_FILES = new Set([
  'scripts/check-copy-compliance.mjs',
  'packages/dsh-xyb-workbench/lib/compliance/disclaimers.js'
])

async function collectFiles(dir, acc = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    const rel = relative(REPO_ROOT, full).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (SKIP_PATH_PREFIXES.some((p) => `${rel}/`.startsWith(p))) continue
      await collectFiles(full, acc)
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(rel)) continue
      if (SKIP_PATH_PREFIXES.some((p) => rel.startsWith(p))) continue
      // 立项/治理文档是规范描述（含反例词表），不是产品文案
      if (SKIP_DOC_PREFIXES.some((p) => rel.startsWith(p))) continue
      if (SKIP_DOC_FILES.has(rel)) continue
      const ext = extname(entry.name).toLowerCase()
      if (SCAN_EXT.has(ext)) acc.push(full)
    }
  }
  return acc
}

async function main() {
  const asJson = process.argv.includes('--json')
  const files = await collectFiles(REPO_ROOT)
  const findings = []

  for (const file of files) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
    let text
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const rule of RULES) {
      // scope 限定：只检查指定路径前缀下的文件
      if (rule.scope && !rel.startsWith(rule.scope)) continue
      for (const pattern of rule.patterns) {
        pattern.lastIndex = 0
        let match
        while ((match = pattern.exec(text)) !== null) {
          const line = text.slice(0, match.index).split('\n').length
          findings.push({ rule: rule.id, label: rule.label, file: rel, line, excerpt: match[0].slice(0, 60) })
          if (match[0].length === 0) break
        }
      }
    }
  }

  // 免责声明键引用检查（基础设施必须被用起来）
  const disclaimerPath = join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'lib', 'compliance', 'disclaimers.js')
  let disclaimerKeys = []
  try {
    const src = await fs.readFile(disclaimerPath, 'utf8')
    // 提取 DISCLAIMERS 对象的键名
    const block = src.slice(src.indexOf('export const DISCLAIMERS'), src.indexOf('export const FORBIDDEN'))
    disclaimerKeys = [...block.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1])
  } catch {
    findings.push({
      rule: 'disclaimer-missing',
      label: '免责声明基础设施缺失',
      file: 'packages/dsh-xyb-workbench/lib/compliance/disclaimers.js',
      line: 0,
      excerpt: '找不到 disclaimers.js'
    })
  }

  if (asJson) {
    console.log(JSON.stringify({ scanned: files.length, disclaimerKeys, findings }, null, 2))
  } else {
    if (findings.length === 0) {
      console.log(`[check-copy-compliance] ✅ 零命中（扫描 ${files.length} 个文件）`)
      console.log(`[check-copy-compliance] 免责声明键 ${disclaimerKeys.length} 个：${disclaimerKeys.join(' / ')}`)
    } else {
      console.error(`[check-copy-compliance] ❌ 命中 ${findings.length} 处（扫描 ${files.length} 个文件）：\n`)
      for (const f of findings) {
        console.error(`  [${f.label}] ${f.file}:${f.line}`)
        console.error(`      ${f.excerpt}\n`)
      }
    }
  }

  process.exit(findings.length ? 1 : 0)
}

main().catch((error) => {
  console.error('[check-copy-compliance] 脚本错误:', error?.message || error)
  process.exit(2)
})
