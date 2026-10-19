#!/usr/bin/env node
/**
 * UI token 纪律检查。
 *
 * 为什么需要：
 * 美术基因要落地就必须**可核对**。只靠人眼说「好看」会随迭代漂移：
 * 新加的颜色、少掉的 :disabled 态、忘记的 reduced-motion——每一处都会
 * 把「高级感」磨掉一格。本检查把这些约束变成机器判据。
 *
 * 判据（全部来自 SPEC §3，不是拍脑袋）：
 * ① token 块存在且包含全部必需 token（颜色/圆角/字体/字号/间距/焦点/动效）；
 * ② token 块之外**零裸十六进制色**（颜色必须走变量；rgba 仅允许出现在焦点 token 里）；
 * ③ 交互必备：:focus-visible / :disabled / prefers-reduced-motion / tabular-nums；
 * ④ 按钮三档齐备：.xybBtn / --primary / --ghost。
 *
 * 用法：
 * node scripts/check-ui-tokens.mjs
 * node scripts/check-ui-tokens.mjs --file <path> # 检查指定文件（测试用）
 *
 * 纯函数 `analyzeTokens(source)` 导出给 test/design/tokens.test.mjs 做**探针自检**
 * 。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..'))
const DEFAULT_TARGET = join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'client.js')

/** SPEC §3 的 token 清单：缺一个就是基因漂移。 */
export const REQUIRED_TOKENS = [
  '--xyb-ink', '--xyb-muted', '--xyb-faint',
  '--xyb-green', '--xyb-green-dark', '--xyb-green-light',
  '--xyb-wash', '--xyb-line', '--xyb-surface', '--xyb-on-accent',
  '--xyb-good', '--xyb-good-bg', '--xyb-good-line',
  '--xyb-watch', '--xyb-watch-bg', '--xyb-watch-line',
  '--xyb-alert', '--xyb-alert-bg', '--xyb-alert-line',
  '--xyb-plum', '--xyb-plum-bg', '--xyb-plum-line',
  '--xyb-dash',
  '--xyb-r-card', '--xyb-r-control', '--xyb-r-pill',
  '--xyb-font-sans', '--xyb-font-serif',
  '--xyb-t-h1', '--xyb-t-h2', '--xyb-t-body', '--xyb-t-small',
  '--xyb-lh-body', '--xyb-lh-tight',
  '--xyb-s1', '--xyb-s2', '--xyb-s3', '--xyb-s4', '--xyb-s5', '--xyb-s6',
  '--xyb-focus', '--xyb-motion',
]

/** 交互与结构必备项（含按钮三档）。 */
const REQUIRED_FEATURES = [
  [':focus-visible', '键盘焦点环'],
  [':disabled', '禁用态'],
  ['prefers-reduced-motion', '减动效'],
  ['tabular-nums', '数字等宽（指标可读性）'],
  ['.xybBtn {', '按钮基础档'],
  ['.xybBtn--primary {', '主按钮档'],
  ['.xybBtn--ghost {', '文本按钮档'],
]

const HEX = /#[0-9a-fA-F]{3,8}\b/g

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/**
 * 分析一份 client.js 源码。
 * @returns {{code: string, detail: string}[]} findings（空数组 = 通过）
 */
export function analyzeTokens(source) {
  const findings = []
  if (typeof source !== 'string' || source.length === 0) {
    return [{ code: 'EMPTY_SOURCE', detail: '源码为空' }]
  }

  const template = source.match(/const CSS = `([\s\S]*?)`\s*\n/)
  if (!template) {
    return [{ code: 'NO_CSS_TEMPLATE', detail: '找不到 `const CSS = \\`…\\`` 模板' }]
  }
  const css = template[1]

  const tokenMatch = css.match(/:root\s*\{([\s\S]*?)\}/)
  if (!tokenMatch) findings.push({ code: 'NO_TOKEN_BLOCK', detail: '缺少 :root token 块' })
  const tokenBlock = tokenMatch ? tokenMatch[0] : ''

  for (const token of REQUIRED_TOKENS) {
    if (!css.includes(`${token}:`)) findings.push({ code: 'MISSING_TOKEN', detail: token })
  }

  // 裸十六进制色：token 块之外一律不允许（颜色只能从变量来）
  const rest = tokenBlock ? css.replace(tokenBlock, '') : css
  HEX.lastIndex = 0
  let hex
  while ((hex = HEX.exec(rest)) !== null) {
    findings.push({ code: 'RAW_HEX', detail: `${hex[0]}（第 ${lineOf(css, hex.index)} 行附近）` })
  }

  for (const [needle, label] of REQUIRED_FEATURES) {
    if (!css.includes(needle)) findings.push({ code: 'MISSING_FEATURE', detail: `${label}：${needle}` })
  }

  return findings
}

function main() {
  const fileArg = process.argv.indexOf('--file')
  const target = fileArg >= 0 ? resolve(process.argv[fileArg + 1]) : DEFAULT_TARGET

  let source
  try {
    source = readFileSync(target, 'utf8')
  } catch (error) {
    console.error(`[check-ui-tokens] ❌ 读不到目标文件：${target}`)
    console.error(`  ${error?.message ?? error}`)
    process.exit(1)
  }

  const findings = analyzeTokens(source)
  if (findings.length > 0) {
    console.error(`[check-ui-tokens] ❌ ${findings.length} 项违规：`)
    for (const f of findings) console.error(`  · [${f.code}] ${f.detail}`)
    console.error('\n依据：设计 token 与强制规则（规则真源在本脚本顶部注释；公开说明见 CONTRIBUTING.md 的 CI 硬杠杆一节）')
    process.exit(1)
  }

  console.log(`[check-ui-tokens] ✅ 通过（token ${REQUIRED_TOKENS.length} 项齐备；零裸色值；按钮三档与交互态齐备）`)
  console.log(`[check-ui-tokens] 检查文件：${target}`)
}

// 只在直接运行时执行主流程，import 时不产生副作用（测试要复用它）
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) main()
