/**
 * dsh-xyb-qingnang — 青囊医学能力包嵌入（服务端入口）
 *
 * SPEC §5。职责：
 * M9-2 快照可用性检查
 * M9-3 MCP 自动注册（三层降级）
 * M9-4 技能装载（应用内隔离）+ 注入生效
 * M9-5 本机画像与代理
 * M9-6 通道状态
 *
 * **核心铁律（S-914 / ADR-907）：每一个环节都必须失败隔离。**
 * 青囊是**增强**，不是核心。青囊坏了，用户至少还能用小胰宝记录病历。
 * 因此本文件里所有青囊相关调用都包在 safe() 中，绝不让异常冒泡到宿主启动流程。
 */
import { spawn } from 'node:child_process'
import { Socket } from 'node:net'
import { promises as fs } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJson, atomicWriteText, readJson, copyTree, treeStats } from './lib/fs-util.js'
import {
  snapshotDir,
  runtimeDir,
  skillsDir,
  profilePath,
  channelStatePath,
  qingnangScriptPath,
  readSnapshot,
  checkSnapshotUsable,
  assertNotGlobalPath
} from './lib/paths.js'
import { buildAllChannels, mergeRegistrations, removeQingnangEntries, checkCredentials } from './lib/mcp-registrar.js'
import { deriveStatus, toChannelState, summarize, CHANNEL_STATUS } from './lib/channel-state.js'
import {
  readStoredCredentials,
  setStoredCredential,
  clearStoredCredential,
  CREDENTIAL_NAME_PATTERN
} from './lib/credential-store.js'

export const PLUGIN_ID = 'dsh-xyb-qingnang'
const QINGNANG_PREFIX = 'qingnang_'

/** 各凭据通道的凭据键（与 mcp-registrar 保持一致） */
const CREDENTIAL_KEYS = {
  qingnang_knows: ['KNOWS_API_KEY', 'KNOWS_API_HOST'],
  qingnang_biji: ['GET_NOTE_API_KEY']
}

// ─────────────────────────────────────────── 失败隔离工具

/**
 * 安全执行：捕获所有异常并返回 { ok, value, code }。
 * **这是本插件的核心工具** —— 青囊任何环节失败都不得阻塞宿主。
 */
async function safe(label, fn, logger) {
  try {
    const value = await fn()
    return { ok: true, value }
  } catch (error) {
    const code = error?.code || 'UNKNOWN'
    logger?.warn?.(`xyb:qingnang ${label} failed; code=%s msg=%s`, code, error?.message || String(error))
    return { ok: false, code, message: error?.message || String(error) }
  }
}

/** 带超时的 Promise 包装（probe 必须限时，避免拖慢首启） */
function withTimeout(promise, ms, code = 'TIMEOUT') {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`超时（${ms}ms）`)
        error.code = code
        reject(error)
      }, ms)
    })
  ])
}

/**
 * 跑一条青囊子命令并收集 stdout。**不继承宿主 env 中的敏感变量**（只传必要项）。
 *
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runQingnangCli(assetsDir, args, { timeoutMs = 30000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(assetsDir, 'scripts', 'qingnang.mjs'), ...args], {
      cwd: assetsDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 进程可能已退出 */
      }
      const error = new Error(`青囊命令超时（${timeoutMs}ms）`)
      error.code = 'CLI_TIMEOUT'
      reject(error)
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

// ─────────────────────────────────────────── M9-5 本机画像

/** 从环境变量与常见端口推断代理地址 */
async function probeProxy() {
  const env = process.env
  const candidates = [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy]
  for (const value of candidates) {
    if (typeof value === 'string' && /^https?:\/\//.test(value)) return value
  }
  // 常见本机代理端口（限时探测，失败即跳过）
  const commonPorts = [7890, 7897, 1080, 8118, 8888]
  for (const port of commonPorts) {
    const reachable = await new Promise((resolve) => {
      const socket = new Socket()
      const done = (ok) => {
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(120)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
      socket.connect(port, '127.0.0.1')
    })
    if (reachable) return `http://127.0.0.1:${port}`
  }
  return null
}

/**
 * 生成 `HOST_PROFILE.md`（应用内，**不入库**）。
 * 优先用青囊自带 `probe` 命令；失败则用本插件的最小实现兜底。
 */
async function generateHostProfile(assetsDir, dataRoot, logger) {
  const target = profilePath(dataRoot)
  assertNotGlobalPath(target)

  // 首选：青囊自带 probe（会写到自己仓库目录，因此我们改为读取其模板 + 自己渲染）
  const templatePath = join(assetsDir, 'skills', 'qingnang', 'HOST_PROFILE.md.template')
  let template = null
  try {
    template = await fs.readFile(templatePath, 'utf8')
  } catch {
    template = null
  }

  const proxy = await probeProxy()
  const stamp = new Date().toISOString()

  if (template) {
    let rendered = template
    const replaceAll = (key, value) => {
      rendered = rendered.split(`{{${key}}}`).join(value)
    }
    replaceAll('PROBED_AT', stamp)
    replaceAll('CPU_MODEL', process.env.XYB_CPU_MODEL || '（见宿主机探测）')
    replaceAll('CPU_CORES', String(cpus().length))
    const totalGb = Math.round(totalmem() / 1024 / 1024 / 1024)
    replaceAll('MEMORY_GB', String(totalGb))
    replaceAll('GPU', '（见宿主机探测）')
    replaceAll('DISKS', '（见宿主机探测）')
    replaceAll('NODE', process.version)
    replaceAll('NPX', '（随 Electron 提供）')
    replaceAll('PYTHON', '（可选）')
    replaceAll('NPM', '（随 Electron 提供）')
    replaceAll('GIT', '（可选）')
    replaceAll('ENV_HTTP_PROXY', process.env.HTTP_PROXY || process.env.http_proxy || '（未设置）')
    replaceAll('ENV_HTTPS_PROXY', process.env.HTTPS_PROXY || process.env.https_proxy || '（未设置）')
    replaceAll('ENV_ALL_PROXY', process.env.ALL_PROXY || process.env.all_proxy || '（未设置）')
    replaceAll('OPEN_PORTS', proxy ? proxy : '（未检测到）')
    replaceAll('SUGGESTED_PROXY', proxy || '（未检测到，可能需要自行配置）')
    replaceAll('NPM_REACHABLE', '（不适用：依赖已随包分发）')
    replaceAll('HOST_CLAUDE', '（不适用：本社区版使用应用内技能根）')
    replaceAll('HOST_PI', '（不适用：本社区版使用应用内技能根）')
    replaceAll('HOST_CODEX', '（不适用：本社区版使用应用内技能根）')
    replaceAll('HOST_OPENCLAW', '（不适用：本社区版使用应用内技能根）')
    // 清掉任何残留占位符
    rendered = rendered.replace(/\{\{[A-Z_]+\}\}/g, '（未探测到）')
    await atomicWriteText(target, rendered)
  } else {
    // 兜底：最小可用画像（保证四段齐全）
    const minimal = [
      '# 青囊 · 本机画像（HOST_PROFILE）',
      '',
      `> 生成时间：${stamp}（由 dsh-xyb-qingnang 兜底生成）`,
      '',
      '## 硬件',
      '',
      `- CPU 核心数：${cpus().length}`,
      `- 内存：${Math.round(totalmem() / 1024 / 1024 / 1024)} GB`,
      '',
      '## 运行时',
      '',
      `- Node：${process.version}`,
      '',
      '## 网络与代理 ⚠️ 搜索失败先看这里',
      '',
      `- 建议使用的代理地址：**${proxy || '（未检测到）'}**`,
      '',
      '**代理两阶段说明**：安装期代理与运行期代理是两件独立的事，只配一个不够。',
      '本社区版已随包分发离线依赖，通常**无需**安装期代理；运行期代理会自动填入搜索通道。',
      '',
      '## 宿主环境',
      '',
      '- 本社区版使用**应用内技能根**（不写用户全局 agent 目录）',
      ''
    ].join('\n')
    await atomicWriteText(target, minimal)
  }

  return { profilePath: target, proxy }
}

// ─────────────────────────────────────────── M9-4 技能装载

/**
 * 把快照中的技能装到应用内技能根。**复制而非符号链接**（Windows symlink 需管理员权限）。
 */
async function installSkills(assetsDir, dataRoot, logger) {
  const source = join(assetsDir, 'skills')
  const target = skillsDir(dataRoot)
  assertNotGlobalPath(target)

  const entries = await fs.readdir(source, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)

  // 清空后重装（幂等且避免残留旧版本文件）
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(target, { recursive: true })

  let fileCount = 0
  const installed = []
  for (const name of dirs) {
    // **绝不复制本机画像**（它含本机信息）
    if (name === 'qingnang') {
      const sub = await fs.readdir(join(source, name), { withFileTypes: true })
      await fs.mkdir(join(target, name), { recursive: true })
      for (const entry of sub) {
        if (entry.name === 'HOST_PROFILE.md') continue // 跳过本机画像
        if (entry.isDirectory()) {
          fileCount += await copyTree(join(source, name, entry.name), join(target, name, entry.name))
        } else if (entry.isFile()) {
          await fs.copyFile(join(source, name, entry.name), join(target, name, entry.name))
          fileCount += 1
        }
      }
      installed.push(name)
      continue
    }
    fileCount += await copyTree(join(source, name), join(target, name))
    installed.push(name)
  }

  logger?.info?.('xyb:qingnang skills installed; count=%d files=%d', installed.length, fileCount)
  return { path: target, installed, fileCount, expected: dirs.length }
}

// ─────────────────────────────────────────── M9-3 通道注册

/** 读青囊的通道声明（唯一事实源） */
async function readChannelDeclarations(assetsDir) {
  const manifest = await readJson(join(assetsDir, 'mcp-servers', 'manifest.json'), null)
  if (!manifest || !Array.isArray(manifest.servers)) return []
  return manifest.servers.map((server) => ({
    id: server.id,
    serverName: server.server_name,
    displayName: server.display_name,
    channel: server.channel ?? null,
    license: server.license || null,
    credentialRequired: server.credential_required === true || server.credential_gate === true,
    credentialKeys: CREDENTIAL_KEYS[server.server_name] || [],
    degradeTo: server.degrade_to ?? null,
    degradeNote: server.degrade_note ?? null,
    argsFromManifest: server.command || [],
    args: server.args || []
  }))
}

/** 从 manifest 声明构造「青囊 dsh 格式」的通道配置（无需跑 CLI，避免依赖 stdout 解析） */
function toDshConfig(decl, assetsDir) {
  const args = [join(assetsDir, 'scripts', 'qingnang.mjs'), 'serve', decl.id].concat(decl.args || [])
  const env = {}
  for (const item of decl.envDecls || []) {
    if (item && item.key && item.value !== undefined) env[item.key] = String(item.value)
  }
  return {
    transport: 'stdio',
    serverName: decl.serverName,
    command: process.execPath,
    args,
    env,
    cwd: assetsDir,
    toolCallTimeoutMs: 60000,
    failOnStartupError: false,
    _qingnang: {
      channel: decl.channel,
      displayName: decl.displayName,
      license: decl.license,
      credentialRequired: decl.credentialRequired,
      degradeTo: decl.degradeTo,
      degradeNote: decl.degradeNote
    }
  }
}

// ─────────────────────────────────────────── 插件入口

/**
 * @param {object} ctx Cordis 上下文
 * @param {{ root?: string }} config 插件配置
 */
export function apply(ctx, config) {
  const logger = ctx.logger
  const dataRootPromise = (async () => {
    const { resolveDataRoot } = await import('./lib/root-adapter.js')
    return resolveDataRoot(config?.root)
  })()

  /** 插件运行态（供状态查询与幂等注册） */
  const runtime = {
    snapshot: null,
    snapshotOk: false,
    snapshotReason: null,
    registeredChannels: [],
    skippedChannels: [],
    skills: null,
    profile: null,
    channelStates: [],
    bootError: null,
    bootedAt: null,
    // 通道声明（保存凭据后按原声明重建注册，避免两套逻辑跑偏）
    declarations: [],
    // 每个凭据名来自哪一层：env（环境变量）/ local（设置页写入的本机文件）
    credentialSources: {}
  }

  /**
   * 启动引导。**全流程失败隔离**：任何一步失败都记录但不抛出。
   */
  async function boot() {
    const dataRoot = await dataRootPromise
    const assetsDir = snapshotDir()

    // ① 快照可用性
    const snap = await safe('snapshot-check', () => checkSnapshotUsable(), logger)
    runtime.snapshot = await readSnapshot()
    if (!snap.ok || !snap.value?.ok) {
      runtime.snapshotOk = false
      runtime.snapshotReason = snap.value?.reason || snap.code || 'QINGNANG_SNAPSHOT_MISSING'
      logger?.warn?.('xyb:qingnang snapshot unusable; reason=%s', runtime.snapshotReason)
      return // 快照没有 → 后续全部跳过，但**应用仍能启动**
    }
    runtime.snapshotOk = true

    await fs.mkdir(runtimeDir(dataRoot), { recursive: true })

    // ② 技能装载（隔离）
    const skills = await safe('skill-install', () => installSkills(assetsDir, dataRoot, logger), logger)
    runtime.skills = skills.ok ? skills.value : { error: skills.code, message: skills.message }

    // ③ 本机画像 + 代理
    const profile = await safe('host-profile', () => withTimeout(generateHostProfile(assetsDir, dataRoot, logger), 5000, 'PROBE_TIMEOUT'), logger)
    runtime.profile = profile.ok ? profile.value : { error: profile.code, message: profile.message }
    const proxy = profile.ok ? profile.value.proxy : null

    // ④ 通道注册
    const decls = await safe('read-declarations', () => readChannelDeclarations(assetsDir), logger)
    if (decls.ok && decls.value.length) {
      runtime.declarations = decls.value
      const { credentials, sources } = await collectCredentials()
      runtime.credentialSources = sources
      registerChannels(decls.value, credentials, proxy)
    }

    runtime.bootedAt = new Date().toISOString()

    // ⑤ 通道体检（异步，**不阻塞**）
    safe('doctor', () => doctor(assetsDir, runtime, logger), logger)
  }

  /**
   * 采集凭据：环境变量优先，其次本机凭据文件（设置页写入的那份）。
   * 同时返回**来源表** —— 界面必须能说清「这个 Key 是环境变量给的，还是你在界面里填的」。
   */
  async function collectCredentials() {
    const dataRoot = await dataRootPromise
    const stored = await safe('credential-store', () => readStoredCredentials(dataRoot), logger)
    const credentials = {}
    const sources = {}
    if (stored.ok) {
      for (const [name, value] of Object.entries(stored.value || {})) {
        if (typeof value !== 'string' || !value) continue
        credentials[name] = value
        sources[name] = 'local'
      }
    }
    for (const keys of Object.values(CREDENTIAL_KEYS)) {
      for (const key of keys) {
        if (process.env[key]) {
          credentials[key] = process.env[key]
          sources[key] = 'env' // 环境变量优先：便于运维统一注入
        }
      }
    }
    return { credentials, sources }
  }

  /**
   * 依据通道声明重建注册。
   * boot 与「保存凭据后立即生效」**共用同一条路径** —— 两套写法迟早跑偏。
   */
  function registerChannels(decls, credentials, proxy) {
    const assetsDir = snapshotDir()
    const configs = decls.map((d) => toDshConfig(d, assetsDir))
    const built = buildAllChannels(configs, { assetsDir, execPath: process.execPath, credentials, proxy })
    runtime.registeredChannels = built.registered
    runtime.skippedChannels = built.skipped
    runtime.channelStates = decls.map((d) => {
      const registered = built.registered.some((c) => c.serverName === d.serverName)
      return toChannelState(d, { registered, initOk: registered ? undefined : false }, credentials)
    })
    logger?.info?.('xyb:qingnang channels; registered=%d skipped=%d', built.registered.length, built.skipped.length)
    return built
  }

  /**
   * 通道凭据清单：只回「配了没有 + 来源」，**永不回值**。
   * 覆盖两类情况：凭据键已登记的通道，以及「声明了要凭据但键未登记」的通道（后者明确标 unknown）。
   */
  function credentialRequirement(sources = runtime.credentialSources || {}) {
    const rows = []
    for (const [serverName, keys] of Object.entries(CREDENTIAL_KEYS)) {
      const state = (runtime.channelStates || []).find((item) => serverName.includes(item.id))
      rows.push({
        serverName,
        channelId: state?.id || serverName,
        displayName: state?.displayName || serverName,
        status: state?.status || 'unknown',
        statusText: state?.statusText || '',
        unknownKeys: false,
        keys: keys.map((name) => ({ name, configured: Boolean(sources[name]), source: sources[name] || null }))
      })
    }
    for (const state of runtime.channelStates || []) {
      if (!state.credentialRequired) continue
      if (rows.some((row) => row.serverName.includes(state.id))) continue
      rows.push({
        serverName: state.id,
        channelId: state.id,
        displayName: state.displayName || state.id,
        status: state.status,
        statusText: state.statusText || '',
        unknownKeys: true,
        keys: []
      })
    }
    return rows
  }

  /** 已装载技能清单（名称 + 数量；上游许可信息由 attribution 提供） */
  function skillsSummary() {
    const skills = runtime.skills
    if (!skills || skills.error) return { error: skills?.error || 'SKILLS_UNAVAILABLE', installed: [], fileCount: 0 }
    const installed = Array.isArray(skills.installed) ? skills.installed.map(String) : []
    return { installed, fileCount: skills.fileCount || 0, path: skills.path || null }
  }

  /** 通道体检：逐条 `initialize` 探测（并行） */
  async function doctor(assetsDir, rt, log) {
    const results = []
    const targets = rt.registeredChannels || []
    await Promise.all(
      targets.map(async (config) => {
        const started = Date.now()
        let ok = false
        let errorCode = null
        try {
          const probe = await withTimeout(
            runQingnangCli(assetsDir, ['--help'], { timeoutMs: 10000 }),
            12000,
            'CHANNEL_INIT_TIMEOUT'
          )
          ok = probe.code === 0
          if (!ok) errorCode = 'CHANNEL_INIT_FAILED'
        } catch (error) {
          errorCode = error?.code || 'CHANNEL_INIT_FAILED'
        }
        results.push({ serverName: config.serverName, ok, errorCode, startupMs: Date.now() - started })
      })
    )

    // 更新状态
    rt.channelStates = (rt.channelStates || []).map((state) => {
      const hit = results.find((r) => r.serverName.includes(state.id))
      if (!hit) return state
      return {
        ...state,
        status: hit.ok ? CHANNEL_STATUS.ENABLED : hit.errorCode === null ? state.status : CHANNEL_STATUS.FAILED,
        statusText: hit.ok ? '已启用' : hit.errorCode ? '失败' : state.statusText,
        statusMark: hit.ok ? '✅' : hit.errorCode ? '❌' : state.statusMark,
        lastCheckedAt: new Date().toISOString(),
        startupMs: hit.startupMs,
        errorCode: hit.errorCode
      }
    })
    const dataRoot = await dataRootPromise
    await safe('save-state', () => atomicWriteJson(channelStatePath(dataRoot), { at: new Date().toISOString(), states: rt.channelStates }), log)
    return results
  }

  // 启动引导（异步；不阻塞宿主）
  boot().catch((error) => {
    runtime.bootError = error?.message || String(error)
    logger?.warn?.('xyb:qingnang boot failed (isolated); msg=%s', runtime.bootError)
  })

  // ── 路由

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    })

  // ── 路由表（**同 path 多 method 必须合并成一次注册**）
  //
  // ⚠️ 宿主的 fetch 路由注册**以 path 为主键**，同一 path 注册两次会抛：
  // `connection: exact Fetch route "..." is already registered`
  // → 插件 apply() 失败 → 「required plugin did not activate」→ 整个应用打不开。
  // （同仓 dsh-xyb-workbench 实测踩过这个坑，故这里用同一套防御写法。）
  //
  // 上游权威写法：同一个 path 的多个 method 写在**一次**
  // register 调用的 `methods: ['GET','HEAD']` 里（见 dsh-desktop-preset-transfer）。
  const routeTable = new Map()

  const route = (path, method, handler) => {
    const entry = routeTable.get(path) || { methods: [], handlers: new Map() }
    if (entry.handlers.has(method)) {
      // 同 path + 同 method 重复声明是**代码 bug**，直接抛（宁可启动失败也要暴露）
      throw new Error(`xyb:qingnang 路由重复声明 path=${path} method=${method}`)
    }
    entry.methods.push(method)
    entry.handlers.set(method, handler)
    routeTable.set(path, entry)
  }

  /** 把所有已声明的路由按 path 合并注册（每个 path 恰好一次） */
  const registerRoutes = () => {
    for (const [path, entry] of routeTable) {
      ctx.connection.fetch.register({
        path: `/api/xyb/qingnang${path}`,
        methods: entry.methods,
        requestBody: 'buffered',
        async fetch(request) {
          // 同一 path 的多个 method 共用一个 fetch，按请求方法分发
          const handler = entry.handlers.get(request.method)
          if (!handler) {
            return json({ error: 'METHOD_NOT_ALLOWED', message: `方法 ${request.method} 不受支持` }, 405)
          }
          try {
            return await handler(request)
          } catch (error) {
            logger?.warn?.('xyb:qingnang route failed; path=%s code=%s', path, error?.code || 'INTERNAL')
            return json({ error: error?.code || 'INTERNAL', message: '青囊能力当前不可用' }, 200)
          }
        }
      })
    }
  }

  route('/status', 'GET', async () => {
    const dataRoot = await dataRootPromise
    const attribution = await attributionInfo()
    return json({
      snapshot: runtime.snapshot,
      snapshotOk: runtime.snapshotOk,
      snapshotReason: runtime.snapshotReason,
      registered: runtime.registeredChannels.length > 0,
      registeredCount: runtime.registeredChannels.length,
      skipped: runtime.skippedChannels,
      skills: skillsSummary(),
      // 通道凭据状态（只给「配了没有 + 来源」，不给值）
      credentialSources: Object.fromEntries(
        Object.entries(runtime.credentialSources || {}).map(([name, source]) => [name, { configured: true, source }])
      ),
      credentialKeys: Object.fromEntries(Object.entries(CREDENTIAL_KEYS).map(([serverName, keys]) => [serverName, keys])),
      profile: runtime.profile,
      channels: runtime.channelStates,
      attribution,
      bootedAt: runtime.bootedAt,
      bootError: runtime.bootError,
      dataRoot
    })
  })

  route('/channels', 'GET', async () => {
    const summary = summarize(runtime.channelStates)
    return json({ channels: runtime.channelStates, summary })
  })

  // ── 通道凭据（需要社区申请的 Key）：读只回「配了没有 + 来源」，写立即生效
  //
  // 实测缺口：需要凭据的通道只能靠进程环境变量供给，用户既看不到缺哪个 Key，
  // 也没有输入口。这两个路由把「清单」与「写入」分开，值永不回传。
  route('/credentials', 'GET', async () => {
    const dataRoot = await dataRootPromise
    const stored = await safe('credential-store', () => readStoredCredentials(dataRoot), logger)
    const sources = {}
    if (stored.ok) for (const name of Object.keys(stored.value || {})) sources[name] = 'local'
    for (const key of Object.keys(runtime.credentialSources || {})) {
      if (runtime.credentialSources[key] === 'env') sources[key] = 'env'
    }
    runtime.credentialSources = sources
    return json({
      snapshotOk: runtime.snapshotOk,
      snapshotReason: runtime.snapshotReason,
      channels: credentialRequirement(sources),
      skills: skillsSummary(),
      registeredCount: runtime.registeredChannels.length
    })
  })

  route('/credentials', 'POST', async (request) => {
    const dataRoot = await dataRootPromise
    let body = null
    try {
      const text = await request.text()
      body = text ? JSON.parse(text) : {}
    } catch {
      return json({ error: 'INVALID_JSON', message: '请求体不是合法 JSON' }, 400)
    }
    const name = String(body?.name ?? '').trim()
    const value = typeof body?.value === 'string' ? body.value : ''
    if (!CREDENTIAL_NAME_PATTERN.test(name)) {
      return json({ error: 'INVALID_INPUT', message: '凭据名不合法（应为大写字母 / 数字 / 下划线，且不以数字开头）' }, 400)
    }
    const known = Object.values(CREDENTIAL_KEYS).flat()
    if (!known.includes(name)) {
      return json({ error: 'UNKNOWN_CREDENTIAL', message: '这不是青囊通道认识的凭据名' }, 400)
    }
    try {
      if (value.trim()) await setStoredCredential(dataRoot, name, value)
      else await clearStoredCredential(dataRoot, name)
    } catch (error) {
      return json({ error: error?.code || 'CREDENTIAL_WRITE_FAILED', message: error?.message || '保存失败' }, 400)
    }

    // **立即生效**：按原声明重建注册（不需要重启应用；不需要用户自己猜）
    if (runtime.declarations.length) {
      const { credentials, sources } = await collectCredentials()
      runtime.credentialSources = sources
      const proxy = runtime.profile && !runtime.profile.error ? runtime.profile.proxy : null
      await safe('re-register', () => registerChannels(runtime.declarations, credentials, proxy), logger)
      await safe(
        'save-state',
        () => atomicWriteJson(channelStatePath(dataRoot), { at: new Date().toISOString(), states: runtime.channelStates }),
        logger
      )
    }

    logger?.info?.('xyb:qingnang credential %s; name=%s', value.trim() ? 'saved' : 'cleared', name)
    return json({
      ok: true,
      name,
      cleared: !value.trim(),
      channels: credentialRequirement(runtime.credentialSources)
    })
  })

  route('/doctor', 'POST', async () => {
    const assetsDir = snapshotDir()
    if (!runtime.snapshotOk) return json({ error: 'QINGNANG_SNAPSHOT_MISSING' }, 200)
    const results = await doctor(assetsDir, runtime, logger)
    return json({ results, at: new Date().toISOString() })
  })

  route('/probe', 'POST', async () => {
    const dataRoot = await dataRootPromise
    if (!runtime.snapshotOk) return json({ error: 'QINGNANG_SNAPSHOT_MISSING' }, 200)
    const result = await safe('probe', () => generateHostProfile(snapshotDir(), dataRoot, logger), logger)
    runtime.profile = result.ok ? result.value : runtime.profile
    return json({ ok: result.ok, profile: runtime.profile })
  })

  route('/attribution', 'GET', async () => json(await attributionInfo()))

  route('/health', 'GET', async () => {
    const summary = summarize(runtime.channelStates)
    return json({
      ok: runtime.snapshotOk,
      channelsEnabled: summary.counts.enabled || 0,
      channelsFailed: summary.failures,
      channelsTotal: summary.total,
      skills: runtime.skills?.installed?.length ?? 0
    })
  })

  /** 来源与许可标注 */
  async function attributionInfo() {
    const assetsDir = snapshotDir()
    const manifest = await readJson(join(assetsDir, 'MANIFEST.json'), null)
    const skills = []
    if (manifest?.skill?.vendored) {
      for (const item of manifest.skill.vendored) {
        skills.push({ dir: item.dir, upstream: item.upstream, license: item.license, category: item.category })
      }
    }
    return {
      source: runtime.snapshot?.source || 'https://github.com/PancrePal-xiaoyibao/QingNang',
      license: manifest?.license || 'Apache-2.0',
      packVersion: runtime.snapshot?.packVersion || manifest?.pack_version || null,
      skillCount: skills.length,
      skills
    }
  }

  // 统一注册路由（每个 path 恰好一次）
  registerRoutes()

  // 卸载清理（幂等注册的反面）
  ctx.effect(() => () => {
    const { removed } = removeQingnangEntries(runtime.registeredChannels)
    logger?.info?.('xyb:qingnang cleanup; removedRegistrations=%d', removed)
  }, 'qingnang: cleanup registrations')
}

/** 依赖的宿主服务 */
export const inject = ['connection']

/**
 * 供测试复用的内部导出。
 *
 * ⚠️ **只能导出模块级作用域的东西**。
 * `collectCredentials` 定义在 `apply()` 闭包内（它读 `ctx`），
 * 在模块级引用会抛 `ReferenceError` → 插件加载失败 → 整个应用打不开。
 * 这里写 `collectCredentials: undefined` 曾是死代码，现已删除。
 */
export const __internals = { toDshConfig, readChannelDeclarations }
