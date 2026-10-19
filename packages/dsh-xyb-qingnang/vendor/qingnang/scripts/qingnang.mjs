#!/usr/bin/env node
/**
 * 青囊统一入口 —— 跨平台（Windows / macOS / Linux），只依赖 Node。
 *
 * 用法：
 *   node scripts/qingnang.mjs serve <channel-id> [额外参数...]   # 启动 MCP（宿主调用这个）
 *   node scripts/qingnang.mjs fetch   [--force] [--js-only] [--py-only]
 *   node scripts/qingnang.mjs deploy  --mode=source|agent [--host=] [--link] [--dry-run] [--uninstall]
 *   node scripts/qingnang.mjs probe   [--json]
 *   node scripts/qingnang.mjs doctor
 *   node scripts/qingnang.mjs check
 *   node scripts/qingnang.mjs mcp-config [--json]      # 输出宿主的 MCP 配置片段
 *
 * 为什么是 Node 而不是 bash：
 *   MCP 的启动命令由宿主在【运行时】执行。若启动器是 bash，Windows 原生就跑不了，
 *   必须装 WSL 或 Git Bash —— 这是不必要的门槛。
 *   Node 是青囊的必需依赖（MCP 本身就跑在 Node 上），用它做启动器零额外成本，且三平台通用。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, cpSync, rmSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'

// ── 基础 ────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

const TTY = process.stdout.isTTY
const C = TTY
  ? { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m', rst: '\x1b[0m' }
  : { ok: '', warn: '', err: '', dim: '', rst: '' }
const OK = '✓', OPT = '⬜', FAIL = '❌'

const say = (...a) => console.log(...a)
const ok = (m) => say(`${C.ok}${OK}${C.rst} ${m}`)
const warn = (m) => say(`${C.warn}${OPT}${C.rst} ${m}`)
const err = (m) => console.error(`${C.err}${FAIL}${C.rst} ${m}`)
const dim = (m) => say(`${C.dim}${m}${C.rst}`)
const die = (m) => { err(m); process.exit(1) }

// ── 平台工具 ────────────────────────────────────────────────────
function which(cmd) {
  const finder = IS_WIN ? 'where' : 'which'
  const r = spawnSync(finder, [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
  if (r.status !== 0 || !r.stdout) return null
  return r.stdout.trim().split(/\r?\n/)[0] || null
}

/** 跨平台执行（Windows 上 npm/pnpm/yarn 是 .cmd，需要 shell） */
function run(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: IS_WIN,          // Windows 上 .cmd 必须走 shell
    ...opts,
  })
}

function runQuiet(cmd, args = []) {
  // ⚠️ 必须设 timeout：pnpm --version 在装了 corepack 的机器上会挂起（实测），
  //    spawnSync 不设 timeout 就是永久阻塞。这是 probe 卡死的根因。
  return spawnSync(cmd, args, {
    encoding: 'utf8', shell: IS_WIN, stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10000, killSignal: 'SIGKILL',
  })
}

/** 探测本地端口是否在监听（⚠️ 只证明端口有东西，不证明它是可用代理） */
function portOpen(port, timeout = 800) {
  return new Promise((res) => {
    const s = createConnection({ host: '127.0.0.1', port })
    const done = (v) => { try { s.destroy() } catch {} ; res(v) }
    s.setTimeout(timeout)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
  })
}

// ── 代理验证（关键：验证而非假设）───────────────────────────────
//
// ❌ 曾经的 bug：只测「端口在监听」就推荐它当代理。
//    实测本机 7890 端口有东西监听，但它不转发 → 按它的建议配代理必失败。
// ✅ 正确做法：真的发一个请求过去，看能不能通。
//
// 判定顺序（对齐 AGENTS.md §1.2 降级链）：
//   ① 直连通 → 不需要代理（最简）
//   ② 直连不通 → 逐个验证候选代理，只有真正能转发的才推荐
//   ③ 都不行 → 明说「需自配代理」，给命令

/** 测直连某 HTTPS 站点 */
function testDirect(host, timeout = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const req = https.request({ host, port: 443, path: '/', method: 'HEAD', timeout }, (res) => {
      resolve({ ok: res.statusCode > 0, ms: Date.now() - t0, code: res.statusCode })
      req.destroy()
    })
    req.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, error: e.code || e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: timeout, error: 'timeout' }) })
    req.end()
  })
}

/** 测 HTTP 代理是否真的能转发（用 CONNECT 打通到目标 443） */
function testProxy(proxyUrl, targetHost, timeout = 6000) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(proxyUrl) } catch { return resolve({ ok: false, error: 'URL 不合法' }) }
    // socks5 无法用 Node 内置 http 模块验证（需要额外依赖）→ 如实报告「无法验证」
    if (/^socks/i.test(u.protocol)) {
      return resolve({ ok: null, error: 'socks5 协议无法用内置模块验证（不代表不可用）' })
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolve({ ok: false, error: `不支持的协议 ${u.protocol}` })
    }
    const t0 = Date.now()
    const headers = {}
    if (u.username) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64')
    }
    const req = http.request({
      host: u.hostname, port: Number(u.port) || 80, method: 'CONNECT',
      path: `${targetHost}:443`, timeout, headers,
    })
    req.on('connect', (res) => {
      const ok = res.statusCode === 200
      resolve({ ok, ms: Date.now() - t0, code: res.statusCode, error: ok ? null : `代理返回 ${res.statusCode}` })
      req.destroy()
    })
    req.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, error: e.code || e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: timeout, error: 'timeout' }) })
    req.end()
  })
}

// ── manifest ────────────────────────────────────────────────────
const MANIFEST_PATH = join(REPO, 'mcp-servers', 'manifest.json')

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) die(`找不到 ${MANIFEST_PATH}`)
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
}

function findServer(id) {
  const s = loadManifest().servers.find((x) => x.id === id)
  if (!s) die(`manifest 中没有通道：${id}`)
  return s
}

/** 在 node_modules 里定位包入口（bin → main → 常见回退） */
// 包解析根：vendor 优先（离线可用）→ node_modules（开发态回退）
// 这确保「一次 clone → 立刻可用」，不依赖 npm 网络。
function pkgRoots() {
  const roots = [join(REPO, 'vendor', 'node_modules')]
  const nm = join(REPO, 'node_modules')
  if (existsSync(nm)) roots.push(nm)
  return roots
}

function pkgDir(pkg) {
  for (const r of pkgRoots()) {
    const d = join(r, ...pkg.split('/'))
    if (existsSync(join(d, 'package.json'))) return d
  }
  return null
}

function findEntry(pkg) {
  const dir = pkgDir(pkg)
  if (!dir) return null
  const pj = join(dir, 'package.json')
  let d
  try { d = JSON.parse(readFileSync(pj, 'utf8')) } catch { return null }
  const cands = []
  if (typeof d.bin === 'string') cands.push(d.bin)
  else if (d.bin && typeof d.bin === 'object') cands.push(...Object.values(d.bin))
  if (d.main) cands.push(d.main)
  cands.push('build/index.js', 'dist/index.js', 'src/index.js', 'src/cli.js')
  for (const c of cands) {
    if (!c) continue
    const rel = c.startsWith('./') ? c.slice(2) : c
    if (existsSync(join(dir, rel))) return join(dir, rel)
  }
  return null
}

// ════════════════════════════════════════════════════════════════
// serve —— 启动 MCP（这是垫片职责，是【运行时】热路径，必须跨平台）
// ════════════════════════════════════════════════════════════════
function cmdServe(rest) {
  const id = rest[0]
  if (!id) die('用法：node scripts/qingnang.mjs serve <channel-id>')
  const s = findServer(id)

  // 凭据门：缺必需凭据时给清晰提示（不算崩溃）
  const required = (s.env || []).filter((e) => e.required).map((e) => e.key)
  const missing = required.filter((k) => !process.env[k] && !readEnvFile()[k])
  if (missing.length && s.credential_gate) {
    err(`${s.display_name || id} 需要凭据：${missing.join(', ')}`)
    say(`  该通道未启用。其他通道不受影响。`)
    say(`  申请后填入 ${join(REPO, '.env')} 即可启用。`)
    process.exit(2)
  }
  if (missing.length) {
    err(`${id} 缺少必需凭据：${missing.join(', ')}`)
    process.exit(2)
  }

  const entry = findEntry(s.package)
  if (!entry) {
    err(`MCP 入口不存在：${s.package}`)
    say(`  请先运行： node scripts/qingnang.mjs fetch`)
    process.exit(1)
  }

  // 合并：manifest 的 env 覆盖值 + .env + 现有环境
  const env = { ...process.env, ...readEnvFile(), ...envOverrides(s) }

  const argv = [entry, ...(s.args || []), ...rest.slice(1)]
  const child = spawn(process.execPath, argv, { stdio: 'inherit', env, cwd: REPO })

  child.on('error', (e) => { err(`启动失败：${e.message}`); process.exit(1) })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 1)
  })
  // 转发终止信号，保证子进程不残留
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig) } catch {} })
  }
}

function readEnvFile() {
  const f = join(REPO, '.env')
  if (!existsSync(f)) return {}
  const out = {}
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (v) out[m[1]] = v
  }
  return out
}

function envOverrides(s) {
  const out = {}
  for (const e of s.env || []) if (e.value) out[e.key] = String(e.value)
  // 代理：从 HOST_PROFILE.md 自动回填（若 manifest 声明了 value_from）
  const hp = join(REPO, 'skills', 'qingnang', 'HOST_PROFILE.md')
  const needProxy = (s.env || []).some((e) => e.value_from === 'host_profile')
  if (needProxy && existsSync(hp)) {
    const proxy = extractSuggestedProxy(readFileSync(hp, 'utf8'))
    if (proxy) { out.USE_PROXY = 'true'; out.PROXY_URL = proxy }
  }
  return out
}

function extractSuggestedProxy(md) {
  // 取「建议使用的代理地址」那一行，剥掉所有 markdown 强调符与表格竖线后再判定。
  // ❌ 曾经的 bug：正则写成 /地址\s*\|\s*\*\*([^*|]+)\*\*\*/，
  //    但实际文本是 `| **建议使用的代理地址** | **http://...** |`，
  //    行内标签本身的 ** 挡在了竖线前，导致永远匹配不上 → 代理显示「未检测到」。
  const line = md.split(/\r?\n/).find((l) => l.includes('建议使用的代理地址'))
  if (!line) return null
  const cells = line.split('|').map((c) => c.replace(/[*\s]/g, ''))
  for (const c of cells) if (/^https?:\/\//.test(c)) return c
  return null
}

// ════════════════════════════════════════════════════════════════
// probe —— 宿主机探测（跨平台）
// ════════════════════════════════════════════════════════════════
async function probe() {
  const cpus = os.cpus()
  const cpuModel = (cpus[0]?.model || '').trim() || null
  const cores = cpus.length

  // ── 代理：验证而非假设（见 testDirect / testProxy 的注释）──
  // ❌ 旧做法：只测「端口在监听」就推荐它当代理。
  //    实测本机 7890 有东西监听但不转发 → 按这个建议配代理必然失败。
  // ✅ 新做法：真的发请求验证；同时测直连（回答「需不需要」而不只是「可不可用」）。
  const proxyPorts = [7890, 7897, 1080, 8888, 8118, 10808]
  const listening = []
  const openResults = await Promise.all(proxyPorts.map((p) => portOpen(p)))
  proxyPorts.forEach((p, i) => { if (openResults[i]) listening.push(p) })

  const envProxy = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY || null

  const PROBE_TARGET = 'eutils.ncbi.nlm.nih.gov'
  const directTest = await testDirect(PROBE_TARGET)

  // 候选 = 本机监听的端口 + 环境变量声明的；逐个真实验证（并行，避免串行 6s×N）
  const candidates = [...new Set([
    ...listening.map((p) => `http://127.0.0.1:${p}`),
    ...(envProxy ? [envProxy] : []),
  ])]
  const tested = await Promise.all(candidates.map(async (url) => {
    const r = await testProxy(url, PROBE_TARGET)
    return { url, ...r }
  }))
  const verified = tested.filter((t) => t.ok === true).map((t) => ({ url: t.url, ms: t.ms }))
  const broken = tested.filter((t) => t.ok === false).map((t) => ({ url: t.url, error: t.error }))
  const unverifiable = tested.filter((t) => t.ok === null).map((t) => ({ url: t.url, note: t.error }))

  // 语义：直连可用时【不推荐】代理（避免用户去配一个不必要的东西）
  const suggested = directTest.ok === true ? null : (verified.length ? verified[0].url : null)

  const findPython = () => {
    for (const c of IS_WIN ? ['python', 'py', 'python3'] : ['python3', 'python']) {
      const p = which(c)
      if (p) {
        const r = runQuiet(p, ['--version'])
        const v = (r.stdout || r.stderr || '').match(/(\d+\.\d+\.\d+)/)
        if (v) return { cmd: p, version: v[1] }
      }
    }
    return null
  }

  const findPm = (name) => {
    const p = which(name)
    if (!p) return null
    const r = runQuiet(p, ['--version'])
    const v = (r.stdout || '').trim().split(/\r?\n/)[0]
    return v ? v : null
  }

  const hosts = {
    claude_code: existsSync(join(os.homedir(), '.claude')),
    pi: existsSync(join(os.homedir(), '.pi')),
    codex: existsSync(join(os.homedir(), '.codex')),
    openclaw: existsSync(join(os.homedir(), '.openclaw')) || existsSync(join(process.cwd(), 'config', 'openclaw')),
  }

  return {
    os: { name: os.platform(), release: os.release(), arch: os.arch() },
    // Windows 上 shell 标识，便于文档与提示区分
    is_windows: IS_WIN,
    shell: IS_WIN ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || null),
    hardware: {
      cpu_model: cpuModel, cpu_cores: cores,
      memory_gb: Math.round(os.totalmem() / 1073741824),
    },
    runtimes: {
      node: process.versions.node,
      python: findPython()?.version ?? null,
      python_cmd: findPython()?.cmd ?? null,
      git: (() => { const p = which('git'); if (!p) return null; const r = runQuiet(p, ['--version']); return (r.stdout || '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? null })(),
    },
    builders: {
      pnpm: findPm('pnpm'), npm: findPm('npm'), yarn: findPm('yarn'),
      uv: (() => { const p = which('uv'); if (!p) return null; const r = runQuiet(p, ['--version']); return (r.stdout || '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? null })(),
      venv: !!findPython(),
      conda: (() => { const p = which('conda'); if (!p) return null; const r = runQuiet(p, ['--version']); return (r.stdout || '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? null })(),
    },
    proxy: {
      env: envProxy,
      listening_ports: listening,     // 端口有东西（不一定能用）
      direct_ok: directTest.ok,       // 直连目标站是否通
      direct_ms: directTest.ms,
      verified,                       // ✅ 真实验证能用
      broken,                         // ❌ 端口在监听但不能转发
      unverifiable,                   // ⚠️ 无法用内置模块验证（如 socks5）
      suggested_url: suggested,
      probe_target: PROBE_TARGET,
    },
    hosts,
    probed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  }
}

// ════════════════════════════════════════════════════════════════
// HOST_PROFILE.md 渲染
// ════════════════════════════════════════════════════════════════
function renderHostProfile(p) {
  const naive = '未检测到'
  const g = (v) => (v === null || v === undefined || v === '' ? naive : String(v))
  // 代理段落的语义：先回答「需不需要」，再回答「用哪个」
  const pr = p.proxy
  const directOk = pr.direct_ok === true
  const needProxy = !directOk
  const verifiedList = pr.verified || []
  const brokenList = pr.broken || []
  const unverList = pr.unverifiable || []
  const proxyCell = verifiedList.length
    ? `**${verifiedList[0].url}**　（已实测可用，${verifiedList[0].ms}ms）`
    : (needProxy ? '**未找到可用的代理**（需自配）' : '**不需要代理**（直连已通）')

  const installHints = {
    win32: {
      node: 'https://nodejs.org/ 或 winget install OpenJS.NodeJS.LTS',
      python: 'https://www.python.org/downloads/ 或 winget install Python.Python.3.12',
      uv: 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"',
      pnpm: 'npm i -g pnpm',
    },
    darwin: {
      node: 'https://nodejs.org/ 或 brew install node',
      python: 'brew install python@3.12',
      uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
      pnpm: 'npm i -g pnpm',
    },
    linux: {
      node: 'https://nodejs.org/ 或 apt install nodejs npm',
      python: 'apt install python3 python3-venv',
      uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
      pnpm: 'npm i -g pnpm',
    },
  }[p.os.name] || {}

  const nodeOk = p.runtimes.node && !semverLt(p.runtimes.node, '22.13.0')

  return `# 青囊 · 本机画像（HOST_PROFILE）

> **本文件由 \`node scripts/qingnang.mjs probe\` 在部署时自动生成。**
> 它是**机器相关**的，已在 \`.gitignore\` 中，**不会进仓库**。

**探测时间**：${p.probed_at}
**平台**：${p.os.name} ${p.os.release}（${p.os.arch}）${p.is_windows ? ' · **Windows（原生，无需 WSL）**' : ''}

---

## 硬件

| 项 | 值 |
|---|---|
| CPU | ${g(p.hardware.cpu_model)} |
| 核心数 | ${p.hardware.cpu_cores} |
| 内存 | ${p.hardware.memory_gb} GB |

## 运行时

| 项 | 值 | 青囊是否需要 |
|---|---|---|
| Node | **${g(p.runtimes.node)}** | **必需**（${nodeOk ? '版本达标 ✓' : `⚠️ 需 ≥ 22.13.0 → ${installHints.node || ''}`}） |
| Python | ${g(p.runtimes.python)} | 可选（Phase 3 本地解析用） |
${p.runtimes.python_cmd ? `| Python 命令 | \`${p.runtimes.python_cmd}\` | — |\n` : ''}| git | ${g(p.runtimes.git)} | 必需（部署用） |

## 网络与代理 ⚠️ 搜索失败先看这里

> **探测方式**：真的发请求验证过（不是只看端口在不在监听）。
> 验证目标：\`${pr.probe_target}:443\`

| 项 | 值 |
|---|---|
| **要不要代理** | ${directOk ? '**不需要** —— 直连已通（' + pr.direct_ms + 'ms）' : '**需要** —— 直连不通（' + (pr.direct_ms || '?') + 'ms / ' + (pr.direct_error || '失败') + '）'} |
| **验证可用的代理** | ${proxyCell} |
| 环境变量声明的代理 | ${g(pr.env)} |
| 端口在监听（**不代表能用**） | ${(pr.listening_ports || []).length ? pr.listening_ports.join(', ') : '（无）'} |
${brokenList.length ? `| ❌ 验证失败的候选 | ${brokenList.map((b) => `\`${b.url}\`（${b.error}）`).join('、')} |\n` : ''}${unverList.length ? `| ⚠️ 无法用内置模块验证 | ${unverList.map((b) => `\`${b.url}\`（${b.note}）`).join('、')} |\n` : ''}
**怎么用**：

\`\`\`
${directOk
  ? '本机直连可用，无需代理：\n   USE_PROXY=false'
  : `运行期（实际搜索时，open-websearch 用）：\n   USE_PROXY=true PROXY_URL=${verifiedList[0]?.url || '<你的代理>'} node scripts/qingnang.mjs serve web_search\n\n安装期（拉 npm 包时，两阶段独立，只配一个不够）：\n   npm --proxy ${verifiedList[0]?.url || '<你的代理>'} --https-proxy ${verifiedList[0]?.url || '<你的代理>'} install`}
\`\`\`

> **为什么列出「端口在监听但不代表能用」**：本机可能有程序占了 7890 端口，
> 但它不是 HTTP 代理。只按端口判断会给出错误建议，所以这里区分「监听」与「验证通过」。

## 环境构建器（降级链）

| 层 | 首选 | 次选 | 兜底 | 本机可用 |
|---|---|---|---|---|
| JS | pnpm | npm | yarn | pnpm=${g(p.builders.pnpm)} · npm=${g(p.builders.npm)} · yarn=${g(p.builders.yarn)} |
| Python | uv venv | python -m venv | conda | uv=${g(p.builders.uv)} · venv=${p.builders.venv ? '可用' : '不可用'} · conda=${g(p.builders.conda)} |

## 宿主环境

| 宿主 | 是否检测到 |
|---|---|
| Claude Code | ${p.hosts.claude_code ? '是' : '否'} |
| pi | ${p.hosts.pi ? '是' : '否'} |
| Codex | ${p.hosts.codex ? '是' : '否'} |
| OpenClaw | ${p.hosts.openclaw ? '是' : '否'} |

**给 Agent 的提示**：部署时用 \`--host=\` 指定宿主；不指定则从本表自动推断。
`
}

function semverLt(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true
    if ((pa[i] || 0) > (pb[i] || 0)) return false
  }
  return false
}

// ════════════════════════════════════════════════════════════════
// fetch —— 构建依赖环境（全链降级）
// ════════════════════════════════════════════════════════════════
function cmdFetch(opts) {
  say('青囊 · 构建本地能力层')
  say('════════════════════════════════════')
  let failed = false

  if (!opts.pyOnly) {
    if (!buildJs(opts)) failed = true
  }
  if (!opts.jsOnly) {
    buildPython(opts)   // 失败不致命
  }

  say('')
  say('════════════════════════════════════')
  if (failed) {
    err('JS 侧未就绪 —— 它是青囊核心，必须修好')
    process.exit(1)
  }
  ok('就绪')
  say('')
  say('下一步：')
  say('  node scripts/qingnang.mjs deploy --mode=source')
  say('  node scripts/qingnang.mjs doctor')
  return true
}

function buildJs(opts) {
  say('')
  say('【A】JS 侧 · MCP 运行环境')
  say('────────────────────────────────────')

  const nodeV = process.versions.node
  if (semverLt(nodeV, '22.13.0')) {
    err(`Node 版本过低：${nodeV}（需要 ≥ 22.13.0）`)
    say('  原因：unified-trial-mcp 要求 node >=22.13.0，是 7 个 MCP 里最严的下限。')
    say('  安装： https://nodejs.org/   或  nvm install 22')
    return false
  }
  ok(`Node v${nodeV}`)

  // ① 首选：vendor 已随包分发 → 直接可用，不需要任何网络或包管理器
  //    （ADR-015：一次 clone → 立刻可用）
  const vroot = join(REPO, 'vendor', 'node_modules')
  const vrep = join(REPO, 'vendor', 'VENDOR.json')
  if (existsSync(vroot) && existsSync(vrep)) {
    let rep = null
    try { rep = JSON.parse(readFileSync(vrep, 'utf8')) } catch {}
    const vmiss = loadManifest().servers.filter(
      (s) => !existsSync(join(vroot, ...s.package.split('/'), 'package.json')))
    if (rep && !vmiss.length) {
      ok(`vendor 已随包分发：${rep.package_count} 包，${(rep.bytes / 1048576).toFixed(1)}M`)
      if (rep.kept_platforms) say(`    ${C.dim}保留平台：${rep.kept_platforms.join(' ')}${C.rst}`)
      say(`    ${C.dim}无需 npm install、无需网络，直接进下一步${C.rst}`)
      return verifyEntries()
    }
    if (vmiss.length) {
      warn(`vendor 不完整（缺 ${vmiss.map((m) => m.id).join(', ')}），回退实时安装`)
    }
  }

  // ② 降级：pnpm → npm → yarn（开发态 / vendor 不可用时）
  let pm = null, why = ''
  for (const [name, reason] of [['pnpm', '首选（隔离式依赖布局）'], ['npm', '次选（扁平化，多版本依赖有冲突风险）'], ['yarn', '兜底']]) {
    if (which(name)) { pm = name; why = reason; break }
  }
  if (!pm) {
    err('未找到任何 JS 包管理器（pnpm / npm / yarn）')
    say('  请先安装： npm i -g pnpm   （推荐）  或安装 Node.js（自带 npm）')
    return false
  }
  ok(`包管理器：${pm} — ${why}`)
  if (pm === 'npm') {
    warn('npm 扁平化：本包已知 @modelcontextprotocol/sdk / express 存在多版本共存')
    warn('  若 healthcheck 报模块解析错误，改装 pnpm： npm i -g pnpm')
  }

  say('  安装 7 个 MCP（版本已在 package.json 钉死）…')
  const args = ['install', '--no-audit', '--no-fund']
  if (opts.force) args.push('--force')
  if (pm === 'npm') args.push('--fetch-retries=5', '--fetch-retry-maxtimeout=120000')
  const r = run(pm, args, { cwd: REPO })
  if (r.status !== 0) {
    err(`安装失败（${pm} 退出码 ${r.status}）`)
    say('  常见原因与对策：')
    say('    · 网络慢 → 重跑一次（npm 可达但慢，实测约 5–10 分钟）')
    say('    · 需要代理 → 安装期与运行期代理是两件事，安装期用：')
    say('        npm --proxy <代理> --https-proxy <代理> install')
    return false
  }
  ok('依赖安装完成')
  return verifyEntries()
}

// 校验 7 个通道入口是否真的可解析（vendor 与实时安装共用）
function verifyEntries() {
  say('  校验 7 个通道入口…')
  const missing = []
  for (const s of loadManifest().servers) {
    const e = findEntry(s.package)
    if (e) say(`    ${OK} ${s.id} → ${e.replace(REPO + '/', '').replace(REPO + '\\', '')}`)
    else missing.push(`${s.id} (${s.package})`)
  }
  if (missing.length) {
    err(`以下通道入口缺失：${missing.join(', ')}`)
    say('  修法： node scripts/qingnang.mjs fetch --force   （重装依赖）')
    return false
  }
  ok('全部 7 个通道入口就绪')
  return true
}

function buildPython(opts) {
  say('')
  say('【B】Python 侧 · 项目活动区环境（.venv）')
  say('────────────────────────────────────')

  const py = IS_WIN ? ['python', 'py', 'python3'] : ['python3', 'python']
  let pyCmd = null, pyV = null
  for (const c of py) {
    const p = which(c)
    if (!p) continue
    const r = runQuiet(p, ['--version'])
    const m = (r.stdout || r.stderr || '').match(/(\d+\.\d+\.\d+)/)
    if (m) { pyCmd = p; pyV = m[1]; break }
  }
  if (!pyCmd) {
    warn('未检测到 Python —— 跳过 Python 环境构建')
    say('  【不受影响】七条通道全部是 Node 侧，Python 侧当前无依赖（Phase 3 才用）')
    return
  }
  ok(`Python ${pyV}（${pyCmd}）`)

  const venvDir = join(REPO, '.venv')
  const venvPy = IS_WIN ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
  if (existsSync(venvPy) && !opts.force) {
    ok('环境已存在：.venv（--force 可重建）')
    return
  }

  // 降级链：uv → python -m venv → conda
  let builder = null
  if (which('uv')) builder = 'uv'
  else if (runQuiet(pyCmd, ['-c', 'import venv']).status === 0) builder = 'venv'
  else if (which('conda')) builder = 'conda'

  if (!builder) {
    warn('无可用 Python 环境构建器（uv / venv / conda）')
    say('  【不受影响】搜索通道是 Node 侧。建议装 uv：')
    say(IS_WIN ? '    powershell -c "irm https://astral.sh/uv/install.ps1 | iex"' : '    curl -LsSf https://astral.sh/uv/install.sh | sh')
    return
  }
  say(`  构建器：${builder}`)

  if (opts.force && existsSync(venvDir)) rmSync(venvDir, { recursive: true, force: true })

  let r
  if (builder === 'uv') {
    r = run('uv', ['venv', venvDir], { cwd: REPO })
  } else if (builder === 'venv') {
    r = run(pyCmd, ['-m', 'venv', venvDir], { cwd: REPO })
  } else {
    r = run('conda', ['create', '-y', '-p', venvDir, `python=${pyV}`], { cwd: REPO })
  }

  if (r.status !== 0 || !existsSync(venvPy)) {
    warn('环境构建失败，尝试降级到 python -m venv')
    if (runQuiet(pyCmd, ['-c', 'import venv']).status === 0) {
      const r2 = run(pyCmd, ['-m', 'venv', venvDir], { cwd: REPO })
      if (r2.status === 0 && existsSync(venvPy)) { ok('降级成功：.venv 已就绪'); return }
    }
    warn('Python 环境未就绪（不影响搜索通道）')
    return
  }
  ok('Python 环境就绪：.venv')
  say(IS_WIN ? '  激活： .venv\\Scripts\\activate' : '  激活： source .venv/bin/activate')
}

// ════════════════════════════════════════════════════════════════
// deploy —— 部署（source / agent）
// ════════════════════════════════════════════════════════════════
async function cmdDeploy(opts) {
  say('青囊 · 部署')
  say('────────────────────────────────────')
  if (opts.dryRun) say(`${C.dim}模式：dry-run（只验证，不写文件）${C.rst}`)

  // 遥测校验
  const tel = readEnvFile().QINGNANG_TELEMETRY || process.env.QINGNANG_TELEMETRY || 'off'
  if (tel !== 'off') {
    err(`QINGNANG_TELEMETRY 的值 '${tel}' 非法`)
    say('  本包遥测唯一合法值是 off（默认即 off）')
    process.exit(1)
  }

  if (opts.uninstall) return doUninstall(opts)
  if (opts.mode === 'source') return doSource(opts)
  if (opts.mode === 'agent') return doAgent(opts)

  err('必须指定 --mode=source 或 --mode=agent')
  process.exit(1)
}

async function doSource(opts) {
  say('① 建立本机画像（硬件 / 网络 / 代理 / 构建器）')
  const hp = join(REPO, 'skills', 'qingnang', 'HOST_PROFILE.md')
  if (existsSync(hp) && !opts.force) {
    ok('宿主画像已存在（--force 可重新探测）')
  } else if (opts.dryRun) {
    say(`${C.dim}[dry-run] 将探测本机并生成 HOST_PROFILE.md${C.rst}`)
  } else {
    const p = await probe()
    writeFileSync(hp, renderHostProfile(p), 'utf8')
    try { chmodSync(hp, 0o600) } catch {}
    ok('已生成 skills/qingnang/HOST_PROFILE.md')
  }

  say('② 校验 MCP 清单')
  const m = loadManifest()
  ok(`清单就绪：${m.servers.length} 条通道（${m.servers.filter((s) => !s.credential_gate).length} 条零凭据）`)

  say('③ 校验能力层环境')
  const miss = m.servers.filter((s) => !findEntry(s.package)).map((s) => s.id)
  if (miss.length) {
    err(`环境未就绪，缺：${miss.join(', ')}`)
    say('  请先运行： node scripts/qingnang.mjs fetch')
    process.exit(1)
  }
  ok(`${m.servers.length} 个通道入口就绪`)

  say('④ 创建私有数据目录')
  const priv = join(os.homedir(), '.qingnang', 'private')
  if (opts.dryRun) {
    say(`${C.dim}[dry-run] 将创建 ${priv}（权限 0700）${C.rst}`)
  } else {
    mkdirSync(priv, { recursive: true })
    try { chmodSync(priv, 0o700) } catch {}
    ok(`私有目录就绪：${priv}`)
  }

  say('⑤ 提示')
  say('  下一步： node scripts/qingnang.mjs deploy --mode=agent')
  say('  然后：   node scripts/qingnang.mjs doctor')
}

// 列出 skills/ 下的技能目录（每个都是一个可装载的 skill）
function listSkillDirs() {
  const base = join(REPO, 'skills')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => (a === 'qingnang' ? -1 : b === 'qingnang' ? 1 : a.localeCompare(b)))
}

// 宿主技能目录（跨平台）
function hostSkillDir(host) {
  const home = os.homedir()
  switch (host) {
    case 'claude':
    case 'pi':
      return join(home, '.claude', 'skills')
    case 'openclaw':
      return join(process.cwd(), 'config', 'openclaw', 'workspace', 'skills')
    case 'codex':
      return null   // 无 skills 惯例 → 走 AGENTS.md
    default:
      return join(home, '.claude', 'skills')
  }
}

function detectHost(explicit) {
  if (explicit) return explicit
  const home = os.homedir()
  if (existsSync(join(home, '.claude'))) return 'claude'
  if (existsSync(join(home, '.pi'))) return 'pi'
  if (existsSync(join(home, '.codex'))) return 'codex'
  if (existsSync(join(home, '.openclaw'))) return 'openclaw'
  return 'claude'
}

function doAgent(opts) {
  const host = detectHost(opts.host)
  say(`宿主：${host}`)

  // 三件套必须齐（A28）
  const need = ['INJECT.md', 'SEARCH_RUNTIME.md', 'SKILL.md', 'MERGE_CONTRACT.md', 'HOST_PROFILE.md']
  const srcDir = join(REPO, 'skills', 'qingnang')
  const missing = need.filter((f) => !existsSync(join(srcDir, f)))
  if (missing.length) {
    err(`缺少注入文件：${missing.join(', ')}`)
    say('  先跑： node scripts/qingnang.mjs deploy --mode=source')
    process.exit(1)
  }

  const MARKER = 'qingnang-inject'
  // 技能层清单：主技能 + 所有 vendor 进来的社区 skill
  const skillDirs = listSkillDirs()

  if (host === 'codex') {
    const target = join(os.homedir(), '.codex', 'AGENTS.md')
    const body = [
      `青囊（QingNang）医学能力包已就绪。`,
      `- 主注入：${join(srcDir, 'INJECT.md')}`,
      `- 搜索分流：${join(srcDir, 'SEARCH_RUNTIME.md')}`,
      `- 本机画像：${join(srcDir, 'HOST_PROFILE.md')}`,
      `- 技能层：${skillDirs.length} 个（${skillDirs.join(' / ')}）`,
      `涉及医学检索时，先读搜索分流表再动手。`,
    ].join('\n')
    if (opts.dryRun) {
      say(`${C.dim}[dry-run] 将在 ${target} 写入 marker 块 ${MARKER}（幂等 upsert）${C.rst}`)
    } else {
      upsertBlock(target, MARKER, body)
      ok(`已注入 ${target}`)
    }
  } else {
    const sdir = hostSkillDir(host)
    if (!sdir) die(`无法确定 ${host} 的技能目录`)

    if (opts.dryRun) {
      say(`${C.dim}[dry-run] 将安装 ${skillDirs.length} 个 skill 到 ${sdir}：${skillDirs.join(' / ')}${C.rst}`)
    } else {
      // ① 主技能：逐文件装（支持 --link 软链）
      const dest = join(sdir, 'qingnang')
      mkdirSync(dest, { recursive: true })
      for (const f of need) {
        const src = join(srcDir, f)
        const dst = join(dest, f)
        if (opts.link) {
          try { rmSync(dst, { force: true }) } catch {}
          try { spawnSync(IS_WIN ? 'cmd' : 'ln', IS_WIN ? ['/c', 'mklink', dst, src] : ['-sfn', src, dst], { stdio: 'ignore' }) } catch {}
          if (!existsSync(dst)) writeFileSync(dst, readFileSync(src))   // link 失败回退复制
        } else {
          writeFileSync(dst, readFileSync(src))
        }
      }
      // 参考层
      const rsrc = join(srcDir, 'references')
      const rdst = join(dest, 'references')
      if (existsSync(rsrc)) {
        rmSync(rdst, { recursive: true, force: true })
        cpSync(rsrc, rdst, { recursive: true })
      }
      ok(`主技能已装：${dest}（${need.length} 个注入文件 + references/）`)

      // ② 社区 skill：整目录装（含各自 SKILL.md + 脚本 + QINGNANG.md 适配层）
      let vendored = 0
      for (const sd of skillDirs) {
        if (sd === 'qingnang') continue
        const from = join(REPO, 'skills', sd)
        const to = join(sdir, sd)
        rmSync(to, { recursive: true, force: true })
        cpSync(from, to, { recursive: true })
        vendored++
      }
      ok(`社区 skill 已装：${vendored} 个（${skillDirs.filter((s) => s !== 'qingnang').join(' / ')}）`)
    }
  }

  say('')
  say('⑥ MCP 配置（复制到你的宿主）')
  printMcpConfig(host)
  say('')
  say('  下一步： node scripts/qingnang.mjs doctor')
}

function upsertBlock(file, marker, body) {
  const begin = `<!-- QINGNANG:BEGIN ${marker} -->`
  const end = `<!-- QINGNANG:END ${marker} -->`
  mkdirSync(dirname(file), { recursive: true })
  let cur = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const block = `${begin}\n${body}\n${end}`
  if (cur.includes(begin)) {
    const re = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}`)
    cur = cur.replace(re, block)
  } else {
    cur = cur.trim() ? `${cur.trimEnd()}\n\n${block}\n` : `${block}\n`
  }
  writeFileSync(file, cur, 'utf8')
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function doUninstall(opts) {
  const host = detectHost(opts.host)
  if (host === 'codex') {
    const target = join(os.homedir(), '.codex', 'AGENTS.md')
    if (existsSync(target)) {
      const begin = `<!-- QINGNANG:BEGIN qingnang-inject -->`
      const end = `<!-- QINGNANG:END qingnang-inject -->`
      const re = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`)
      writeFileSync(target, readFileSync(target, 'utf8').replace(re, ''), 'utf8')
      ok(`已移除 ${target} 中的青囊块`)
    }
  } else {
    const dest = join(hostSkillDir(host), 'qingnang')
    if (existsSync(dest)) { rmSync(dest, { recursive: true, force: true }); ok(`已移除 ${dest}`) }
    else warn(`未找到 ${dest}`)
  }
}

// MCP 配置片段生成（相对路径 → 绝对路径）
/**
 * 生成 MCP 配置（多格式，供不同宿主/嵌入方消费）
 *
 * 格式说明：
 *   claude / pi  → { mcpServers: { <name>: {command,args,env} } }   （Claude Code 惯例）
 *   codex        → { mcp_servers: {...} }                            （Codex 惯例）
 *   openclaw     → { servers: {...} }
 *   dsh          → [{ transport:'stdio', serverName, command, args, env, cwd, ... }]
 *                  **DSH 后端嵌入专用**：对齐 DSH 内核 packages/mcp/mcp-client 的 StdioConfig
 *   generic      → 中性结构，含青囊自有元数据（许可/通道/降级），供任意宿主二次映射
 */
function mcpConfigFor(host = 'claude') {
  const m = loadManifest()

  const toEntry = (s) => ({
    command: process.execPath,   // node 绝对路径（跨平台稳定，不依赖 PATH）
    args: [join(REPO, 'scripts', 'qingnang.mjs'), 'serve', s.id],
    env: Object.fromEntries(
      (s.env || []).filter((e) => e.value).map((e) => [e.key, String(e.value)]),
    ),
  })

  if (host === 'dsh') {
    // 对齐 DSH StdioConfig：transport / serverName / command / args / env / cwd /
    //                      toolCallTimeoutMs / failOnStartupError / reconnect?
    return m.servers.map((s) => ({
      transport: 'stdio',
      serverName: s.server_name,
      command: process.execPath,
      args: [join(REPO, 'scripts', 'qingnang.mjs'), 'serve', s.id],
      env: Object.fromEntries(
        (s.env || []).filter((e) => e.value).map((e) => [e.key, String(e.value)]),
      ),
      cwd: REPO,
      toolCallTimeoutMs: 60000,
      // 凭据门通道：启动失败【不应】拖垮整个插件（缺凭据是正常的选填状态）
      failOnStartupError: !s.credential_gate,
      _qingnang: {
        channel: s.channel,
        displayName: s.display_name,
        license: s.license,
        credentialRequired: !!s.credential_gate,
        degradeTo: s.degrade_to ?? null,
        degradeNote: s.degrade_note ?? null,
      },
    }))
  }

  if (host === 'generic') {
    return {
      schema_version: 1,
      pack: 'qingnang',
      pack_version: JSON.parse(readFileSync(join(REPO, 'MANIFEST.json'), 'utf8')).pack_version,
      repo_root: REPO,          // 嵌入方需要绝对路径来定位技能层
      skill_path: join(REPO, 'skills', 'qingnang'),
      servers: m.servers.map((s) => ({
        id: s.id,
        channel: s.channel,
        display_name: s.display_name,
        server_name: s.server_name,
        transport: s.transport,
        command: process.execPath,
        args: [join(REPO, 'scripts', 'qingnang.mjs'), 'serve', s.id],
        env_required: (s.env || []).filter((e) => e.required).map((e) => e.key),
        env_optional: (s.env || []).filter((e) => !e.required && e.secret).map((e) => e.key),
        credential_required: !!s.credential_gate,
        degrade_to: s.degrade_to ?? null,
        license: s.license,
        upstream: s.upstream,
      })),
      injection_files: {
        main: join(REPO, 'skills', 'qingnang', 'INJECT.md'),
        search_runtime: join(REPO, 'skills', 'qingnang', 'SEARCH_RUNTIME.md'),
        skill: join(REPO, 'skills', 'qingnang', 'SKILL.md'),
        host_profile: join(REPO, 'skills', 'qingnang', 'HOST_PROFILE.md'),
      },
    }
  }

  const servers = {}
  for (const s of m.servers) servers[s.server_name] = toEntry(s)
  if (host === 'codex') return { mcp_servers: servers }
  if (host === 'openclaw') return { servers }
  return { mcpServers: servers }   // claude / pi / 默认
}

function printMcpConfig(host) {
  const cfg = mcpConfigFor(host)
  say('  MCP 配置片段（JSON）：')
  say('')
  const j = JSON.stringify(cfg, null, 2).split('\n').map((l) => '    ' + l).join('\n')
  say(j)
  say('')
  dim('  说明：已用绝对路径 + process.execPath，Windows / macOS / Linux 通用。')
  dim('  路径：')
  if (host === 'claude' || host === 'pi') dim('    Claude Code / pi → ~/.claude.json 的 mcpServers 字段')
  if (host === 'codex') dim('    Codex → ~/.codex/config.toml（把上面的 JSON 转成 TOML）')
  if (host === 'openclaw') dim('    OpenClaw → config/openclaw 的 MCP 配置')
}

// ════════════════════════════════════════════════════════════════
// doctor —— 体检（跨平台，9 项）
// ════════════════════════════════════════════════════════════════
async function cmdDoctor() {
  say('青囊 · 体检')
  say('════════════════════════════════════')
  const fixes = []
  let failed = 0
  let i = 0
  const TOTAL = 9
  const step = (name) => { i++; process.stdout.write(`[${i}/${TOTAL}] ${name.padEnd(10)} `) }
  const end = (m) => { say(m); }
  const setFail = (m, fix) => { failed = 1; end(m); if (fix) fixes.push(fix) }

  // 1 宿主画像
  step('宿主画像')
  const hp = join(REPO, 'skills', 'qingnang', 'HOST_PROFILE.md')
  if (!existsSync(hp)) {
    setFail(`${FAIL} 未生成`, '先跑： node scripts/qingnang.mjs deploy --mode=source')
  } else {
    const md = readFileSync(hp, 'utf8')
    const proxy = extractSuggestedProxy(md)
    const mm = md.match(/内存\s*\|\s*(\d+)/)
    const cc = md.match(/核心数\s*\|\s*(\d+)/)
    const age = Math.round((Date.now() - statSync(hp).mtimeMs) / 60000)
    end(`${OK} 已生成（${age} 分钟前）· 代理 ${proxy || '未检测到'} · ${cc?.[1] || '?'} 核 / ${mm?.[1] || '?'} GB`)
  }

  // 2 运行时
  step('运行时')
  const nodeV = process.versions.node
  const nodeOk2 = !semverLt(nodeV, '22.13.0')
  const pyInfo = (() => { for (const c of IS_WIN ? ['python', 'py', 'python3'] : ['python3', 'python']) { const p = which(c); if (!p) continue; const r = runQuiet(p, ['--version']); const v = (r.stdout || r.stderr || '').match(/(\d+\.\d+\.\d+)/); if (v) return v[1] } return null })()
  if (!nodeOk2) setFail(`${FAIL} Node ${nodeV} 需 ≥22.13.0`, '升级 Node： https://nodejs.org/')
  else end(`${OK} Node ${nodeV} · ${pyInfo ? `${OK} Python ${pyInfo}` : `${OPT} Python 未装（可选）`}`)

  // 3 网络
  step('网络')
  const pnpmOk = !!which('pnpm') || !!which('npm')
  if (!pnpmOk) setFail(`${FAIL} 无 JS 包管理器`, 'npm i -g pnpm')
  else end(`${OK} 包管理器可用（${which('pnpm') ? 'pnpm' : 'npm'}）`)

  // 4 MCP 握手（凭据门记 ⬜）
  step('MCP 握手')
  const m = loadManifest()
  const r = spawnSync(process.execPath, [join(REPO, 'mcp-servers', 'healthcheck.mjs'), '--quiet'], { encoding: 'utf8', cwd: REPO })
  if (r.status === 0) {
    const usable = m.servers.filter((s) => !s.credential_gate).length
    const gated = m.servers.filter((s) => s.credential_gate).length
    end(`${OK} ${usable} 条可用 · ${gated} 条待凭据（共 ${m.servers.length} 条）`)
  } else {
    setFail(`${FAIL} 有通道不可用`, '详查： node mcp-servers/healthcheck.mjs')
  }

  // 5 凭据矩阵
  step('凭据矩阵')
  const envf = readEnvFile()
  // 只列「真凭据」（manifest 标了 secret:true 的），不列配置项（MODE / USE_PROXY 等）
  const optionalUnset = m.servers
    .flatMap((s) => (s.env || []).filter((e) => e.secret).map((e) => e.key))
    .filter((k) => !envf[k] && !process.env[k])
  end(optionalUnset.length ? `${OPT} 选填未配: ${optionalUnset.join(' ')}（不影响使用）` : `${OK} 增强通道已配置`)

  // 6 隐私隔离
  step('隐私隔离')
  const priv = join(os.homedir(), '.qingnang', 'private')
  if (!existsSync(priv)) setFail(`${FAIL} ${priv} 不存在`, 'node scripts/qingnang.mjs deploy --mode=source')
  else {
    let mode = ''
    if (!IS_WIN) { try { mode = (statSync(priv).mode & 0o777).toString(8) } catch {} }
    const gi = spawnSync('git', ['-C', REPO, 'check-ignore', '-q', 'skills/qingnang/HOST_PROFILE.md'])
    const ignored = gi.status === 0
    if (!IS_WIN && mode && mode !== '700') setFail(`${FAIL} 权限 ${mode}（应 700）`, `chmod 700 ${priv}`)
    else if (!ignored) setFail(`${FAIL} 画像未加入 .gitignore`, '检查 .gitignore')
    else end(`${OK} ${priv}${IS_WIN ? '' : ' 权限 0700'} · ${OK} 画像未入库`)
  }

  // 7 遥测
  step('遥测')
  const tel = envf.QINGNANG_TELEMETRY || process.env.QINGNANG_TELEMETRY || 'off'
  if (tel !== 'off') setFail(`${FAIL} 值非法：${tel}`, '编辑 .env：QINGNANG_TELEMETRY=off')
  else end(`${OK} off（唯一合法值）`)

  // 8 技能层体积
  step('技能层')
  const caps = { 'INJECT.md': 2048, 'SEARCH_RUNTIME.md': 8192, 'SKILL.md': 14336 }
  let allOk = true, parts = []
  for (const [f, cap] of Object.entries(caps)) {
    const p = join(REPO, 'skills', 'qingnang', f)
    if (!existsSync(p)) { allOk = false; parts.push(`${FAIL} ${f} 缺失`); continue }
    const sz = statSync(p).size
    if (sz > cap) { allOk = false; parts.push(`${FAIL} ${f} ${sz}B>${cap}B`) }
    else parts.push(`${OK} ${f} ${sz}B/${cap}B`)
  }
  if (!allOk) setFail(parts.join(' · '), '见 SPEC §4.5 体积契约')
  else end(parts.join(' · '))

  // 9 能力层
  step('能力层')
  const nm = existsSync(join(REPO, 'node_modules'))
  const venv = existsSync(join(REPO, '.venv', IS_WIN ? 'Scripts' : 'bin'))
  if (!nm) setFail(`${FAIL} node_modules 未构建`, 'node scripts/qingnang.mjs fetch')
  else end(`${OK} JS 环境（${m.servers.length} 通道） · ${venv ? `${OK} Python .venv` : `${OPT} Python .venv 未建（当前无依赖，不影响搜索）`}`)

  say('════════════════════════════════════')
  if (failed) {
    err('有检查未通过，请修复：')
    fixes.forEach((f) => say(`  · ${f}`))
    say('')
    say('修好后重跑： node scripts/qingnang.mjs doctor')
    process.exit(1)
  }
  ok('全部通过。')
  say('')
  say('你现在可以说：')
  say('  · 帮我查一下胰腺癌 FOLFIRINOX 方案的最新文献')
  say('  · 找一下国内正在招募的胰腺癌临床试验')
  say('  · 解释一下 CA19-9 这个指标是什么意思')
}

// ════════════════════════════════════════════════════════════════
// check —— 聚合自检（跨平台核心子集）
// ════════════════════════════════════════════════════════════════
function cmdCheck() {
  say('青囊 · 自检')
  say('════════════════════════════════════')
  let failed = 0
  const fail = (m) => { err(m); failed = 1 }

  // 1 MCP 清单
  say('── MCP 清单 ──')
  try {
    const m = loadManifest()
    const wl = new Set(m.license_whitelist)
    const errs = []
    const names = new Set()
    for (const s of m.servers) {
      for (const k of ['id', 'server_name', 'package', 'version', 'license', 'command']) if (!s[k]) errs.push(`${s.id}: 缺字段 ${k}`)
      if (s.license && !wl.has(s.license)) errs.push(`${s.id}: 许可 ${s.license} 不在白名单`)
      if (s.server_name && !/^[A-Za-z0-9_-]{1,32}$/.test(s.server_name)) errs.push(`${s.id}: server_name 不合法`)
      if (s.server_name && names.has(s.server_name)) errs.push(`${s.id}: server_name 重复`)
      names.add(s.server_name)
      const cmd = s.command || []
      const isShim = cmd.some((x) => String(x).includes('qingnang.mjs'))
      const hasVer = cmd.some((x) => String(x).includes('@'))
      if (!isShim && !hasVer) errs.push(`${s.id}: command 未指向入口也未钉版本`)
    }
    if (errs.length) { errs.forEach((e) => fail(`  · ${e}`)); }
    else ok(`${m.servers.length} 条通道声明合法；${(m.reserved || []).length} 条 reserved`)
  } catch (e) { fail(`manifest 解析失败：${e.message}`) }

  // 2 技能层体积 + 内容
  say('── 技能层 ──')
  const D = join(REPO, 'skills', 'qingnang')
  const caps = { 'INJECT.md': 2048, 'SEARCH_RUNTIME.md': 8192, 'SKILL.md': 14336 }
  for (const [f, cap] of Object.entries(caps)) {
    const p = join(D, f)
    if (!existsSync(p)) { fail(`  缺失：${f}`); continue }
    const sz = statSync(p).size
    if (sz > cap) fail(`  ${f} 超限：${sz}B > ${cap}B`)
    else ok(`${f} ${sz}B / ${cap}B`)
  }
  const inj = existsSync(join(D, 'INJECT.md')) ? readFileSync(join(D, 'INJECT.md'), 'utf8') : ''
  const redlines = ['不做诊断', '不给剂量', '永不上传'].filter((k) => !inj.includes(k))
  if (redlines.length) fail(`  INJECT.md 缺红线关键词：${redlines.join(' ')}`)
  else ok('INJECT.md 含三条医学红线')
  // 薄提示：主注入不许出现工具包名
  const leaked = ['open-websearch', 'bing-cn-mcp', 'mcp-pubmed-llm-server', 'openalex-mcp-server', 'unified-trial-mcp', 'knows-mcp-server', 'get-biji-mcp'].filter((p) => inj.includes(p))
  if (leaked.length) fail(`  INJECT.md 泄漏工具包名：${leaked.join(' ')}`)
  else ok('INJECT.md 保持薄提示（未泄漏工具包名）')
  const sr = existsSync(join(D, 'SEARCH_RUNTIME.md')) ? readFileSync(join(D, 'SEARCH_RUNTIME.md'), 'utf8') : ''
  const chCount = (sr.match(/^### 通道 [1-9] /gm) || []).length
  if (chCount < 6) fail(`  SEARCH_RUNTIME 通道数不足（${chCount}）`)
  else ok(`SEARCH_RUNTIME 含 ${chCount} 条通道`)
  const sk = existsSync(join(D, 'SKILL.md')) ? readFileSync(join(D, 'SKILL.md'), 'utf8') : ''
  if (sk.includes('依赖') && sk.includes('什么时候调') && sk.includes('怎么用')) ok('SKILL.md 声明耦合三件事')
  else fail('  SKILL.md 缺耦合三件事')

  // 3 治理一致性
  say('── 治理一致性 ──')
  const a = join(REPO, 'AGENTS.md'), c = join(REPO, 'CLAUDE.md')
  if (existsSync(a) && existsSync(c) && readFileSync(a, 'utf8') === readFileSync(c, 'utf8')) ok('AGENTS.md ≡ CLAUDE.md')
  else fail('  AGENTS.md 与 CLAUDE.md 不一致')

  // 4 forge 接缝 S1：零 DSH 专属实现
  const secrets = ['dsh-plugin', 'StdioConfig', 'ctx.inject', '@deepseek-ai', 'desktopPnpm', 'desktopProfiles', 'dsh-community-fabric']
  let s1bad = []
  const scanDirs = ['mcp-servers', 'skills', 'scripts']
  const ext = new Set(['.json', '.sh', '.py', '.mjs', '.js', '.md'])
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) { if (!['node_modules', 'launch', '.git'].includes(e.name)) walk(p) }
      else if (ext.has('.' + e.name.split('.').pop())) {
        const txt = readFileSync(p, 'utf8')
        for (const s of secrets) if (txt.includes(s) && !p.includes('qingnang.mjs') && !p.includes('check')) s1bad.push(`${s}@${p.replace(REPO + '/', '')}`)
      }
    }
  }
  scanDirs.forEach((d) => walk(join(REPO, d)))
  if (s1bad.length) fail(`  forge 接缝 S1 违约：${s1bad.slice(0, 5).join(', ')}`)
  else ok('forge 接缝 S1：无 DSH/Cordis 专属实现')

  // 4b vendor 完整性（ADR-015：一次 clone 即可离线运行）
  say('── MCP vendor（离线能力）──')
  const vroot = join(REPO, 'vendor', 'node_modules')
  const vrep = join(REPO, 'vendor', 'VENDOR.json')
  if (!existsSync(vroot) || !existsSync(vrep)) {
    fail('  vendor 不存在 —— 跑： node scripts/vendor-mcp.mjs')
  } else {
    let vrepJson
    try { vrepJson = JSON.parse(readFileSync(vrep, 'utf8')) } catch { vrepJson = null }
    if (!vrepJson) fail('  vendor/VENDOR.json 解析失败')
    else {
      const miss = []
      for (const s of loadManifest().servers) {
        if (!existsSync(join(vroot, ...s.package.split('/'), 'package.json'))) miss.push(s.package)
      }
      if (miss.length) fail(`  vendor 缺入口包：${miss.join(', ')}`)
      else ok(`vendor 完整：${vrepJson.package_count} 包，${(vrepJson.bytes / 1048576).toFixed(1)}M，入口 ${loadManifest().servers.length} 个`)
      if (vrepJson.kept_platforms) ok(`保留平台：${vrepJson.kept_platforms.join(' ')}`)
    }
  }

  // 5 隐私
  say('── 隐私隔离 ──')
  const gi = readFileSync(join(REPO, '.gitignore'), 'utf8')
  for (const [k, label] of [['skills/qingnang/HOST_PROFILE.md', 'HOST_PROFILE.md'], ['.env', '.env'], ['private/', 'private/'], ['node_modules/', 'node_modules/'], ['.venv/', '.venv/']]) {
    if (gi.includes(k)) ok(`${label} 已忽略`)
    else fail(`  ${label} 未加入 .gitignore`)
  }

  say('════════════════════════════════════')
  if (failed) { err('自检未通过'); process.exit(1) }
  ok('自检全部通过')
}

// ════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════
function parseArgs(argv) {
  const o = { _: [] }
  for (const a of argv) {
    if (a === '--force') o.force = true
    else if (a === '--link') o.link = true
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--uninstall') o.uninstall = true
    else if (a === '--json') o.json = true
    else if (a === '--js-only') o.jsOnly = true
    else if (a === '--py-only') o.pyOnly = true
    else if (a.startsWith('--mode=')) o.mode = a.slice(7)
    else if (a.startsWith('--host=')) o.host = a.slice(7)
    else if (a.startsWith('--format=')) o.format = a.slice(9)
    else o._.push(a)
  }
  return o
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]

  switch (cmd) {
    case 'serve': return cmdServe(args._.slice(1))
    case 'fetch': return cmdFetch(args)
    case 'deploy': return cmdDeploy(args)
    case 'probe': {
      const p = await probe()
      if (args.json) say(JSON.stringify(p, null, 2))
      else {
        say(`平台：${p.os.name} ${p.os.release}（${p.os.arch}）${p.is_windows ? ' · Windows 原生' : ''}`)
        say(`Node：v${p.runtimes.node} · Python：${p.runtimes.python || '未装'}`)
        say(`CPU：${p.hardware.cpu_model} × ${p.hardware.cpu_cores} 核 · 内存 ${p.hardware.memory_gb} GB`)
        const pr = p.proxy
        const need = pr.direct_ok === true ? '不需要（直连通）' : '需要'
        const v = (pr.verified || []).length ? pr.verified[0].url : '未找到可用代理'
        say(`代理：${need} · 已验证可用：${v} · 监听端口：${(pr.listening_ports || []).join(', ') || '无'}`)
        say(`构建器：pnpm=${p.builders.pnpm || '-'} npm=${p.builders.npm || '-'} uv=${p.builders.uv || '-'} venv=${p.builders.venv ? '有' : '无'}`)
      }
      return
    }
    case 'doctor': return cmdDoctor()
    case 'check': return cmdCheck()
    case 'mcp-config': {
      const fmt = args.format || args.host || detectHost(args.host)
      const VALID = ['claude', 'pi', 'codex', 'openclaw', 'dsh', 'generic']
      if (!VALID.includes(fmt)) {
        err(`未知格式：${fmt}`)
        say(`可用：${VALID.join(' / ')}`)
        process.exit(1)
      }
      // 六种格式【统一输出纯 JSON】—— 对齐 P1「为 Agent 而做」：
      //   机读是默认，人话解释只在 deploy --mode=agent 流程里出现（那里确实给人看）
      // ❌ 曾经的不一致：claude/pi/codex/openclaw 输出「人话头 + JSON」，程序无法直接解析
      say(JSON.stringify(mcpConfigFor(fmt), null, 2))
      return
    }
    case 'help':
    case undefined:
      say(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).map((l) => l.replace(/^\s*\*?\/?\*?\s?/, '')).join('\n'))
      return
    default:
      err(`未知命令：${cmd}`)
      say('可用：serve / fetch / deploy / probe / doctor / check / mcp-config')
      say('  mcp-config --format=dsh|claude|codex|openclaw|generic   生成 MCP 配置（后端嵌入用 --format=dsh）')
      process.exit(1)
  }
}

main().catch((e) => { err(e.stack || e.message); process.exit(1) })
