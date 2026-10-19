/**
 * 产品界面「零内部引用」闸门 —— 主人 2026-10-17 指令：
 *
 * 「类似这种话：『许可全文随安装包一并分发（licenses/ 目录）；本项目对上游的改造见仓库
 * 』，不要出现在产品的任何一个地方。」
 *
 * 为什么需要一条**自动闸门**：这类文字是「开发者写给开发者」的内部记叙（仓库路径、变更编号、
 * 文档文件名）。它们混在界面文案里时，任何静态检查、烟雾测试都不会报错，只有用户看见会困惑 ——
 * 而本项目的使用者是患者与家属，不该被要求理解工程术语。同时它是**回归高发区**：
 * 写文档顺手把路径贴进文案、新增占位页时抄了「CHG-xxx 实现」的句式，都会立刻复发。
 *
 * 规则：
 * · 客户端包（`packages/<包名>/client.js`）：字符串里不得出现变更编号、仓库路径、文档文件名；
 * · 服务端模块（`packages/<包名>/lib/` 下）：字符串里不得出现变更编号（它们的文案会经路由回到界面）；
 * · 排除注释（JS 行注释/块注释、以及 CSS 模板里的 /* … *​/ 注释）——注释是工程内部资产，不在产品里。
 *
 * 自检：必须证明「造一个泄漏能被抓到」+「真实源码零误报」。
 */
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const PACKAGES = join(REPO_ROOT, 'packages')

/** 客户端界面里绝对不允许出现的内部引用。 */
const UI_FORBIDDEN = [
  { id: 'CHG 编号', re: /CHG-\d/ },
  { id: '仓库 tasks 路径', re: /\btasks\// },
  { id: '改造清单文件名', re: /MODIFICATIONS/ },
  { id: 'vendor 路径', re: /\bvendor\// },
  { id: '第三方清单文件名', re: /THIRD-PARTY/ },
  { id: '许可目录路径', re: /\blicenses\// },
  { id: 'scripts 路径', re: /\bscripts\// },
  { id: '文档文件名', re: /\.md\b/ }
]

/** 服务端模块（文案会回流到界面）里不允许出现的：只查变更编号。 */
const SERVER_FORBIDDEN = [{ id: 'CHG 编号', re: /CHG-\d/ }]

/**
 * 去掉注释：JS 的块注释与行注释，以及 CSS 模板串里的注释。
 *
 * 行注释需特别对待：`https://…` 里的 `//` **不是**注释（故用 `[^:]` 保护），
 * 否则会把公开链接后半段当注释剥掉，反而漏检同行的泄漏。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/** 抽出源码里的字符串字面量（'…' / "…" / `…`）。 */
function stringLiterals(source) {
  const withoutComments = stripComments(source)
  const out = []
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
  let m
  while ((m = re.exec(withoutComments)) !== null) out.push(m[2])
  return out
}

/** 找出违规项（返回 {literal, rule}）。 */
function findViolations(source, rules) {
  const hits = []
  for (const literal of stringLiterals(source)) {
    for (const rule of rules) {
      if (rule.re.test(literal)) hits.push({ literal: literal.slice(0, 120), rule: rule.id })
    }
  }
  return hits
}

function listFiles(root, predicate) {
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name.startsWith('.')) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, predicate))
    else if (predicate(full)) out.push(full)
  }
  return out
}

const packageDirs = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('dsh-xyb-'))
  .map((e) => join(PACKAGES, e.name))
  .filter((dir) => {
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  })

test('[文案闸门] 客户端包字符串里零内部引用（变更编号 / 仓库路径 / 文档名）', () => {
  const offenders = []
  for (const dir of packageDirs) {
    const client = join(dir, 'client.js')
    let source
    try {
      source = readFileSync(client, 'utf8')
    } catch {
      continue
    }
    for (const hit of findViolations(source, UI_FORBIDDEN)) {
      offenders.push(`${dir.split(/[\\/]/).pop()}/client.js → [${hit.rule}] ${hit.literal}`)
    }
  }
  assert.deepEqual(offenders, [], `界面文案不得出现内部引用（主人 2026-10-17 指令）：\n${offenders.join('\n')}`)
})

test('[文案闸门] 服务端模块字符串里零变更编号（文案会回流到界面）', () => {
  const offenders = []
  for (const dir of packageDirs) {
    for (const file of listFiles(dir, (f) => f.endsWith('.js'))) {
      if (file.endsWith('client.js')) continue
      const source = readFileSync(file, 'utf8')
      for (const hit of findViolations(source, SERVER_FORBIDDEN)) {
        offenders.push(`${file.replace(REPO_ROOT + '\\', '').replace(REPO_ROOT + '/', '')} → ${hit.literal}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `服务端文案不得出现内部变更编号：\n${offenders.join('\n')}`)
})

test('[文案闸门] 自检：造出来的泄漏必须被抓到（否则闸门是假的）', () => {
  const planted = "const note = '许可全文随安装包分发（licenses/ 目录）；改造见 tasks/CHG-000/MODIFICATIONS.md'\n"
  const hits = findViolations(planted, UI_FORBIDDEN)
  assert.ok(hits.length >= 3, `应同时命中多条规则，实际 ${JSON.stringify(hits)}`)
  assert.ok(hits.some((h) => h.rule === 'CHG 编号'), '应抓到变更编号')
  assert.ok(hits.some((h) => h.rule === '许可目录路径'), '应抓到 licenses/ 路径')

  // 注释里的同类文字**不算**违规（注释是工程资产，不面向用户）
  const inComment = "/* 见 tasks/CHG-000/MODIFICATIONS.md */\nconst ok = '好的'\n"
  assert.deepEqual(findViolations(inComment, UI_FORBIDDEN), [], '注释里的引用不应误报')

  // 中英文普通文案不得误报
  const normal = "const a = '资料留在本机'; const b = 'https://github.com/PancrePal-xiaoyibao'\n"
  assert.deepEqual(findViolations(normal, UI_FORBIDDEN), [], '普通文案与公开链接不应误报')
})
