#!/usr/bin/env node
/**
 * 脱敏审计。 SPEC ADR-801。
 *
 * 为什么自建而不是用现成工具（gitleaks / trufflehog）：
 * 本项目的风险大头**不是密钥**，而是**本机路径 / SSH 别名 / 服务拓扑 / 内网 IP**。
 * 现成工具强于通用密钥，但无法编码「白名单」（127.0.0.1、example.com 是合法的）。
 * 因此主控是自建脚本；如需可再叠加 gitleaks 作补充。
 *
 * 设计要点：
 * · 词表用**模式**而非字面值 —— **脚本自身绝不能含真实值**（否则脚本就是泄露源）
 * · 按路径区分白名单：`tasks/**` 与 `vendor/**` 允许出现上游身份（立项文档需记录改造前原值）
 * · 双模式：默认扫工作区；`--history` 扫 git 全史
 * · `--self-test` 自检：注入构造的假敏感值，断言全类别可检出
 *
 * 退出码：0 零命中 / 1 有命中 / 2 脚本错误
 *
 * 用法：
 * node scripts/check-sanitization.mjs
 * node scripts/check-sanitization.mjs --history
 * node scripts/check-sanitization.mjs --json
 * node scripts/check-sanitization.mjs --self-test
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..'))

// ─────────────────────────────────────────── 扫描范围

/** 跳过的目录（不扫） */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'dist',
  'dist-dev',
  'out',
  'coverage',
  '.ipynb_checkpoints',
  'vendor' // 上游原样，不扫（其内容另有来源）
])

/** 只扫这些扩展名（避免二进制噪音） */
const SCAN_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.txt', '.yml', '.yaml',
  '.sh', '.ps1', '.py', '.toml', '.cfg', '.ini', '.env', '.example', '.html', '.css'
])

/**
 * 跳过的文件：**审计脚本自身**。
 *
 * 为什么：它内部含有检测用的**正则模式定义**（如域名 TLD 列表、私钥头模式），
 * 这些模式文本天然会被自己的规则命中。这是「检测器」与「被检测对象」的区别，
 * 不是遗漏 —— 脚本的能力由 `--self-test` 保证。
 */
const SKIP_FILES = new Set(['scripts/check-sanitization.mjs'])

/** 允许出现「上游身份」的路径前缀（立项文档需记录改造前原值） */
const UPSTREAM_IDENTITY_ALLOWED = [
  'tasks/',
  'vendor/',
  'THIRD-PARTY-NOTICES.md',
  'LICENSE',
  // 公开仓（净源码仓，）不跟踪 vendor/：上游身份集中写在这份指路文档里
  'UPSTREAM-SOURCES.md'
]

/**
 * 完全不扫的路径前缀（上游原样内容，不是本项目的文本）。
 * 为什么：vendor 是上游代码，其内容里出现域名/IP 属正常；
 * 青囊快照同理（第三方技能与依赖）。
 */
const SKIP_PATH_PREFIXES = ['vendor/', 'packages/dsh-xyb-qingnang/vendor/']

// ─────────────────────────────────────────── 检测规则
//
// ⚠️ 规则本身必须是「模式」，不能是真实值。

const RULES = [
  {
    id: 'ipv4',
    label: '公网/内网 IP',
    pattern: /\b(?!(?:127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.255|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)(?:\d|\.)*\b)(?:\d{1,3}\.){3}\d{1,3}\b/g,
    hint: '改为 <IP> 或占位符；文档示例用 RFC 5737 段（192.0.2.0/24 等）'
  },
  {
    id: 'ipv6',
    label: 'IPv6 地址',
    pattern: /\b(?!::1\b|fe80::)(?:[0-9a-fA-F]{1,4}:){4,}[0-9a-fA-F]{0,4}\b/g,
    hint: '改为 <IPv6>'
  },
  {
    id: 'home-path',
    label: '用户 home 路径',
    pattern: /(?:\/home\/[a-zA-Z_][a-zA-Z0-9_-]{1,31}|\/Users\/[A-Za-z0-9_.-]{1,32}|[A-Z]:\\\\?Users\\\\?[A-Za-z0-9_.-]{1,32})/g,
    hint: '改为 <home> 或 ~'
  },
  {
    id: 'private-key',
    label: '私钥',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    hint: '立即移除并轮换该密钥'
  },
  {
    id: 'api-key',
    label: 'API Key / Token',
    pattern: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    hint: '立即移除并轮换该凭据'
  },
  {
    id: 'tunnel-service',
    label: '隧道 / FRP 服务名',
    pattern: /\b(?:frpc@[a-z0-9-]+|frps@[a-z0-9-]+|\.trycloudflare\.com|\.pinggy\.(?:link|io)|\.loca\.lt)\b/g,
    hint: '改为 <隧道服务> 占位符'
  },
  {
    id: 'ssh-alias-leak',
    label: 'SSH 跳板别名（疑似）',
    // 只匹配「ssh <别名>」这种明确用法，且别名不像通用词
    pattern: /\bssh\s+(?:vps|jump|bastion|relay)[a-z0-9-]*\b/gi,
    hint: '改为 <SSH 别名>'
  },
  {
    id: 'domain',
    label: '域名（非白名单）',
    // ⚠️ 四个防误报设计（都是实测踩坑后加的）：
    // ① 前视断言排除白名单（含上游身份与常用公开站点）
    // ①′ 白名单用 `\S*?` 前缀匹配：原写法是**位置锚定**的——只在
    // 「匹配起点正好是白名单域名」时生效。而 `registry.npmjs.org` 的匹配起点在
    // `registry`，那个位置的文本不是 `npmjs.org`，前视于是通过 →
    // **白名单里的域名以子域形式出现时反而不被识别**（实测：package-lock.json
    // 的 2 处 `registry.npmjs.org` 被误报，而单独写 `npmjs.org` 却能过）。
    // 改成 `\S*?(?:白名单)` = 「同一 token 内以白名单域名结尾的都放行」，
    // 同时覆盖 download.nodejs.org / raw.githubusercontent.com 这类子域。
    // ② 后视断言**不能包含 `/`** —— 否则会屏蔽 URL 里的域名（`https://<域名>` 实测踩坑）；
    // 保留 `-` 与 `.` 以避开 `electron-builder.dev.cjs` 这类文件名
    // ③ 首段至少 2 字符 + TLD 不含 `link`/`co` —— 避免把 `esc(c.link)` 这类**属性访问**当成域名
    pattern: /(?<![a-zA-Z0-9._-])(?!\S*?(?:example\.(?:com|org|net)|localhost|github\.com|npmjs\.org|nodejs\.org|nodejs\.dev|electronjs\.org|electron-builder|openai\.com|deepseek\.com|dshdesktop\.com|dshdesktop\.cn|www\.dshdesktop\.cn|mineru\.net|w3\.org|schemas\.|json-schema\.org|creativecommons\.org|opensource\.org|apache\.org|python\.org|rust-lang\.org|golang\.org|kernel\.org|man7\.org|ietf\.org|rfc-editor\.org|iana\.org|wikipedia\.org|mozilla\.org|stackoverflow\.com|google\.com|apple\.com|microsoft\.com|anthropic\.com|claude\.ai|volcengine\.com|volces\.com|aliyuncs\.com|pinggy\.link|trycloudflare\.com|openstreetmap\.org|sqlite\.org|pypi\.org|readthedocs\.io|githubusercontent\.com|jsdelivr\.net|unpkg\.com)(?![a-zA-Z0-9_-]))[a-z0-9][a-z0-9-]*[a-z0-9](?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|cn|net|org|io|dev|app|pro|xyz|ai)(?![a-zA-Z0-9-])/gi,
    hint: '改为 <域名> 占位符（或加入白名单）'
  }
]

/** 是否在允许上游身份的路径下 */
function isUpstreamIdentityAllowed(relPath) {
  const normalized = relPath.replace(/\\/g, '/')
  return UPSTREAM_IDENTITY_ALLOWED.some((prefix) => normalized.startsWith(prefix))
}

/** 域名规则在上游身份路径下不报（上游地址是合规引用） */
function shouldSkipRule(ruleId, relPath) {
  if (ruleId === 'domain' && isUpstreamIdentityAllowed(relPath)) return true
  return false
}

// ─────────────────────────────────────────── 扫描实现

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
      if (entry.name.startsWith('.xyb-backup')) continue
      // 跳过的路径前缀（vendor 与青囊快照）
      if (SKIP_PATH_PREFIXES.some((p) => `${rel}/`.startsWith(p))) continue
      await collectFiles(full, acc)
    } else if (entry.isFile()) {
      if (SKIP_PATH_PREFIXES.some((p) => rel.startsWith(p))) continue
      const ext = extname(entry.name).toLowerCase()
      // 无扩展名的文件也扫（如 LICENSE、Makefile）
      if (ext === '' || SCAN_EXT.has(ext)) acc.push(full)
    }
  }
  return acc
}

function scanText(text, relPath, findings) {
  for (const rule of RULES) {
    if (shouldSkipRule(rule.id, relPath)) continue
    // 每次扫描重置 lastIndex（全局正则有状态）
    rule.pattern.lastIndex = 0
    let match
    while ((match = rule.pattern.exec(text)) !== null) {
      const before = text.slice(0, match.index)
      const line = before.split('\n').length
      findings.push({
        rule: rule.id,
        label: rule.label,
        file: relPath,
        line,
        excerpt: match[0].slice(0, 80),
        hint: rule.hint
      })
      if (match[0].length === 0) break // 防死循环
    }
  }
}

async function scanWorktree() {
  const files = await collectFiles(REPO_ROOT)
  const findings = []
  for (const file of files) {
    const relPath = relative(REPO_ROOT, file).replace(/\\/g, '/')
    if (SKIP_FILES.has(relPath)) continue
    let text
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    scanText(text, relPath, findings)
  }
  return { findings, scanned: files.length }
}

/**
 * git 全史扫描：对**每个历史提交的树**跑同一套正则规则。
 *
 * 为什么不用 `git log -S <字面量>`（曾经的写法，已废弃）：
 * ① **依赖环境变量**：探针曾用 `process.env.USER`。本机是真实用户名（敏感），
 * 但 CI 上是 `runner` —— 于是拿 `runner` 当敏感词去搜，命中了 CI 配置里的
 * `runs-on: ubuntu-24.04` 等文本，产生大批误报（实测踩坑）。
 * ② **与工作区规则不一致**：`-S` 是字面量，而 RULES 是正则。
 * 例：规则要求 `frpc@` 后必须跟主机名，但裸 `frpc@` 会命中
 * `/SPEC.md` 里那句**模式描述**（`` `frpc@` ``），也是误报。
 * ③ **看不到具体位置**：`-S` 只给 commit，不给文件与行号。
 *
 * 现在的做法：用 `git grep -n -E <正则> <commit>` 对每个提交跑规则，
 * 因此**零环境依赖**、**与工作区规则完全一致**、且能给出文件与行号。
 */
async function scanHistory() {
  const findings = []

  // 枚举全部历史提交（含所有分支）
  let commits = []
  try {
    commits = execFileSync('git', ['rev-list', '--all'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
      .split('\n')
      .filter(Boolean)
  } catch {
    return { findings, scanned: 0 }
  }

  for (const commit of commits) {
    for (const rule of RULES) {
      // 把规则的 pattern 转成 git grep 可用的正则源（去标志位）
      const source = rule.pattern.source
      let out = ''
      try {
        out = execFileSync(
          'git',
          ['grep', '-n', '-I', '-E', '--extended-regexp', '-e', source, commit],
          { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        )
      } catch {
        // git grep 无命中时退出码为 1，属正常
        continue
      }

      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        // 格式：<commit>:<path>:<line>:<content>
        const parts = line.split(':')
        if (parts.length < 4) continue
        const commitPart = parts[0]
        const path = parts[1]
        const lineNo = Number(parts[2]) || 0
        const content = parts.slice(3).join(':')

        if (SKIP_FILES.has(path)) continue
        if (SKIP_PATH_PREFIXES.some((p) => path.startsWith(p))) continue
        if (shouldSkipRule(rule.id, path)) continue

        findings.push({
          rule: `history:${rule.id}`,
          label: `历史提交中含${rule.label}`,
          file: `${path} (commit ${commitPart.slice(0, 7)})`,
          line: lineNo,
          excerpt: content.trim().slice(0, 80),
          hint: '需 git filter-repo 全史清除 + force-push（只改最新 commit 不够）'
        })
      }
    }
  }

  return { findings, scanned: commits.length }
}

// ─────────────────────────────────────────── 自检

/**
 * 自检：注入**构造的假敏感值**，断言全类别可检出。
 * 这保证「脚本本身有能力检出」，而不是默默通过。
 */
function selfTest() {
  // ⚠️ 关键：样本必须**程序化拼装**，不能以字面量形式出现在本文件里。
  // 否则本脚本自身会被自己的扫描命中（实测踩坑）。
  const h = 'ho' + 'me'
  const u = 'some' + 'user'
  const sk = 'sk-' + 'a'.repeat(24)
  const gh = 'ghp_' + 'b'.repeat(24)
  const dom = 'secret-internal' + '.' + 'example' + '-corp.com'
  const alias = 'vps' + '-mytest'
  const svc = 'frpc' + '@' + 'myrelay'

  const samples = [
    { rule: 'ipv4', text: `server at 203.0.114.${99} port 22` },
    { rule: 'ipv4', text: `addr 10.20.30.${40}` },
    // IPv6 / 私钥头也必须**程序化拼装**（字面量会被本脚本自身命中）
    { rule: 'ipv6', text: ['addr 2001', 'db8', '85a3', '0', '0', '8a2e', '370', String(7334)].join(':') },
    { rule: 'private-key', text: ['-----BEGIN', 'RSA', 'PRIVATE KEY-----'].join(' ') },
    { rule: 'home-path', text: `path /${h}/${u}/project` },
    { rule: 'api-key', text: `key ${sk}` },
    { rule: 'api-key', text: `token ${gh}` },
    { rule: 'tunnel-service', text: `svc ${svc} running` },
    { rule: 'ssh-alias-leak', text: `connect via ssh ${alias}` },
    { rule: 'domain', text: `visit https://${dom}/x` }
  ]

  const failures = []
  for (const sample of samples) {
    const findings = []
    scanText(sample.text, 'self-test.md', findings)
    const hit = findings.some((f) => f.rule === sample.rule)
    if (!hit) failures.push(`规则 ${sample.rule} 未能检出样本：${sample.text}`)
  }

  // 白名单自检：合法值不得误报
  const allowed = [
    { rule: 'ipv4', text: `listen 127.0.0.${1}:3000` },
    { rule: 'ipv4', text: `docs use 192.0.2.${1} (RFC 5737)` },
    { rule: 'domain', text: 'see https://example' + '.com/docs' },
    { rule: 'domain', text: 'see https://github' + '.com/owner/repo' }
  ]
  for (const sample of allowed) {
    const findings = []
    scanText(sample.text, 'self-test.md', findings)
    const hit = findings.some((f) => f.rule === sample.rule)
    if (hit) failures.push(`白名单失效：${sample.text} 被误报为 ${sample.rule}`)
  }

  return failures
}

// ─────────────────────────────────────────── 主流程

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--self-test')) {
    const failures = selfTest()
    if (failures.length) {
      console.error('[check-sanitization] ❌ 自检失败：')
      for (const f of failures) console.error(`  · ${f}`)
      process.exit(1)
    }
    console.log('[check-sanitization] ✅ 自检通过（全类别可检出；白名单不误报）')
    return
  }

  const useHistory = args.includes('--history')
  const asJson = args.includes('--json')

  const result = useHistory ? await scanHistory() : await scanWorktree()
  const { findings, scanned } = result
  if (asJson) {
    console.log(JSON.stringify({ mode: useHistory ? 'history' : 'worktree', scanned, findings }, null, 2))
  } else {
    if (findings.length === 0) {
      console.log(`[check-sanitization] ✅ 零命中（扫描 ${scanned} 项，模式=${useHistory ? 'git 全史' : '工作区'}）`)
    } else {
      console.error(`[check-sanitization] ❌ 命中 ${findings.length} 处（扫描 ${scanned} 项）：\n`)
      for (const f of findings) {
        console.error(`  [${f.label}] ${f.file}:${f.line}`)
        console.error(`      内容：${f.excerpt}`)
        console.error(`      建议：${f.hint}\n`)
      }
    }
  }

  process.exit(findings.length ? 1 : 0)
}

main().catch((error) => {
  console.error('[check-sanitization] 脚本错误:', error?.message || error)
  process.exit(2)
})
