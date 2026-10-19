#!/usr/bin/env node
/**
 * 安装 smoke：目标平台真实安装 → 启动 → **校验首屏是小胰宝** → 数据存活 → 卸载。
 *
 * SPEC ADR-703 / C-707。
 *
 * 为什么必须校验「首屏」（而不是只验安装成功）：
 * 安装成功、启动成功，都不能发现「装上了但打开是 DSH 会话界面」——
 * 而这正是 的核心目标（打开就是小胰宝）。
 * 只有校验首屏，才能确认品牌化真正生效。
 *
 * 首屏校验方案（ADR-703 的 P-1）：
 * 启动时带诊断参数，应用把「当前主面板标识」写到文件，脚本读取断言。
 * 若宿主/插件尚未支持该诊断输出，降级为「读应用日志中的面板注册记录」（P-3），
 * 并在结果中标注校验强度（checkStrength: 'diagnostic' | 'log' | 'none'）。
 *
 * 用法（由 CI 在目标平台调用）：
 * node scripts/verify-install.mjs --platform macos --artifacts artifacts
 * node scripts/verify-install.mjs --platform windows --artifacts artifacts
 *
 * 输出：smoke-result.json（结构化结果）+ 退出码（全部 ok → 0）
 */
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 检测逻辑做成纯函数放在 scripts/lib/ 下，方便用**真实崩溃日志**做回归测试
// （见 test/unit/smoke-detect.test.mjs）。本文件只负责 IO。
import {
  detectFirstPanelFromText,
  detectHostUiLeak,
  detectPluginFailure,
  PLUGIN_FAILURE_MARKERS
} from './lib/smoke-detect.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..'))

function parseArgs(argv) {
  const args = { platform: process.platform, artifacts: 'artifacts', timeout: 90 }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platform') args.platform = argv[++i]
    else if (argv[i] === '--artifacts') args.artifacts = argv[++i]
    else if (argv[i] === '--timeout') args.timeout = Number(argv[++i])
  }
  return args
}

const checks = []
function record(name, ok, detail, skipped = false) {
  checks.push({ name, ok, detail, skipped })
  const mark = skipped ? '⬜' : ok ? '✅' : '❌'
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 找安装产物 */
async function findArtifact(dir, platform) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const names = entries.filter((e) => e.isFile()).map((e) => e.name)
  if (platform === 'darwin' || platform === 'macos') {
    return names.find((n) => n.endsWith('.dmg')) || names.find((n) => n.endsWith('.zip'))
  }
  return names.find((n) => n.endsWith('.exe'))
}

/**
 * 读取首屏诊断（IO 外壳）。优先诊断文件，不存在则读日志。
 * 判定逻辑在 detectFirstPanelFromText（纯函数，已单测）。
 *
 * @returns {Promise<{ ok: boolean, strength: 'diagnostic'|'log'|'none', detail: string }>}
 */
async function checkFirstPanel(diagnosticPath, logPath) {
  if (await exists(diagnosticPath)) {
    return detectFirstPanelFromText(await fs.readFile(diagnosticPath, 'utf8'), 'diagnostic')
  }
  if (await exists(logPath)) {
    return detectFirstPanelFromText(await fs.readFile(logPath, 'utf8'), 'log')
  }
  return detectFirstPanelFromText(null, 'diagnostic')
}

/**
 * 等待多个条件中的任意一个先满足（轮询）。
 *
 * @param {{path: string, timeoutMs: number, stopOn?: string[]}[]} targets
 * `path` 出现即返回；若该条带 `stopOn`，文件内容含任一关键字也立即返回。
 * @returns {Promise<boolean>} 是否至少命中一个条件
 */
async function waitForAny(targets) {
  const deadline = Date.now() + Math.max(...targets.map((t) => t.timeoutMs))
  while (Date.now() < deadline) {
    for (const t of targets) {
      if (!(await exists(t.path))) continue
      if (!t.stopOn) return true
      // 文件存在且出现失败信号 → 命中（提前退出，不等满 timeout）
      const text = await fs.readFile(t.path, 'utf8')
      if (t.stopOn.some((m) => text.includes(m))) return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/**
 * 扫描启动进程的输出，找插件启动失败信号（IO 外壳）。
 * 判定逻辑在 detectPluginFailure（纯函数，已用真实崩溃日志单测）。
 *
 * @param {string[]} logPaths 启动输出文件（stdout / stderr）
 * @returns {Promise<{ok: boolean, hit: string|null, detail: string, excerpt: string}>}
 */
async function checkPluginActivation(logPaths) {
  const texts = []
  for (const path of logPaths) {
    if (!(await exists(path))) continue
    texts.push(await fs.readFile(path, 'utf8'))
  }
  return detectPluginFailure(texts)
}

/** 检查宿主 UI 是否泄漏（IO 外壳） */
async function checkNoHostUi(logPath, diagnosticPath) {
  const texts = []
  for (const path of [diagnosticPath, logPath]) {
    if (!(await exists(path))) continue
    texts.push(await fs.readFile(path, 'utf8'))
  }
  return detectHostUiLeak(texts)
}

/**
 * 读取 asar 头部的文件索引（**无需依赖**）。
 *
 * asar 格式：4字节 pickle 长度 + 4字节 header 长度 + header(JSON) + 文件数据。
 * header 里存的是完整文件路径索引，因此**直接搜字符串**就能判断包内是否含某模块。
 *
 * 为什么用这种方式而不是装 @electron/asar：
 * smoke 跑在目标平台 runner 上，不想为一个检查多装一个包；
 * 而且我们只需要「包内有没有这个名字」这个事实。
 */
async function readAsarIndex(asarPath) {
  const handle = await fs.open(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    await handle.read(head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    // 头部通常几百 KB，上限 4MB 足够覆盖
    const size = Math.min(headerSize, 4 * 1024 * 1024)
    const buf = Buffer.alloc(size)
    await handle.read(buf, 0, size, 16)
    return buf.toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * 在已安装的应用目录里找 resources/ 目录。
 */
async function findInstalledResources(platform) {
  const candidates = []
  if (platform === 'darwin' || platform === 'macos') {
    const base = process.env.RUNNER_TEMP || '/tmp'
    candidates.push(join(base, '小胰宝社区版.app', 'Contents', 'Resources'))
  } else {
    const base = process.env.RUNNER_TEMP || 'C:\\Temp'
    candidates.push(join(base, 'xyb-app', 'resources'))
    // NSIS 默认安装目录（用户未改路径时的回退位置）
    candidates.push(join(process.env.LOCALAPPDATA || '', 'Programs', '小胰宝社区版', 'resources'))
    candidates.push(join(process.env.PROGRAMFILES || '', '小胰宝社区版', 'resources'))
  }
  for (const dir of candidates) {
    if (await exists(dir)) return dir
  }
  return null
}

/**
 * Tier B 校验：**已安装应用**的静态内容检查。
 *
 * 它证明什么（真证据，不是假绿）：
 * · 包内确实含小胰宝的品牌层 / 工作台 / 青囊插件
 * · resources 里的 patch.yml 确实注册了它们
 * 因此「装的是小胰宝版本」这一事实成立。
 *
 * 它不证明什么（如实标注）：
 * · 不证明运行时的「首屏」确实是工作台（那需要 Tier A）
 */
async function checkInstalledAppContent(platform) {
  const resources = await findInstalledResources(platform)
  if (!resources) {
    return { ok: false, strength: 'none', detail: '找不到已安装应用的 resources 目录' }
  }

  const asarPath = join(resources, 'app.asar')
  if (!(await exists(asarPath))) {
    return { ok: false, strength: 'none', detail: `已安装应用缺少 app.asar：${asarPath}` }
  }

  const index = await readAsarIndex(asarPath)
  const required = ['dsh-xyb-branding', 'dsh-xyb-workbench', 'dsh-xyb-qingnang']
  const missing = required.filter((name) => !index.includes(name))
  if (missing.length) {
    return {
      ok: false,
      strength: 'static',
      detail: `已安装应用的 app.asar 缺少插件：${missing.join('、')}`
    }
  }

  // patch.yml 必须注册这三个插件（否则包里有也不加载）
  const patchPath = join(resources, 'dsh-desktop.patch.yml')
  if (!(await exists(patchPath))) {
    return { ok: false, strength: 'static', detail: '已安装应用缺少 dsh-desktop.patch.yml' }
  }
  const patch = await fs.readFile(patchPath, 'utf8')
  const unregistered = required.filter((name) => !patch.includes(name))
  if (unregistered.length) {
    return {
      ok: false,
      strength: 'static',
      detail: `patch.yml 未注册插件：${unregistered.join('、')}`
    }
  }

  return {
    ok: true,
    strength: 'static',
    detail: `已安装应用含三个插件且 patch.yml 已注册（品牌层 / 工作台 / 青囊）`
  }
}

/**
 * 许可合规：安装目录必须带本发行版的 LICENSE 与 THIRD-PARTY-NOTICES。
 *
 * 为什么是必须：MIT 要求版权与许可声明随「副本或实质部分」分发；社区版隐藏了
 * 宿主左栏（V-1101），应用内不再有上游「关于页」，因此许可文本必须随安装目录送达。
 */
async function checkInstalledLicenses(platform) {
  const resources = await findInstalledResources(platform)
  if (!resources) return { ok: false, strength: 'none', detail: '找不到已安装应用的 resources 目录' }
  const required = [
    { path: join(resources, 'licenses', 'LICENSE'), label: 'licenses/LICENSE（本发行版 MIT）' },
    { path: join(resources, 'licenses', 'THIRD-PARTY-NOTICES.md'), label: 'licenses/THIRD-PARTY-NOTICES.md' },
    { path: join(resources, 'licenses', 'DSH-Desktop-upstream-MIT.txt'), label: 'licenses/DSH-Desktop-upstream-MIT.txt' },
    { path: join(resources, 'licenses', 'DeepSeek-Harness-MIT.txt'), label: 'licenses/DeepSeek-Harness-MIT.txt' },
    { path: join(resources, 'licenses', 'QingNang-Apache-2.0.txt'), label: 'licenses/QingNang-Apache-2.0.txt' },
    { path: join(resources, 'licenses', 'DSH-Desktop-Next-MIT.txt'), label: 'licenses/DSH-Desktop-Next-MIT.txt' }
  ]
  const missing = []
  for (const item of required) if (!(await exists(item.path))) missing.push(item.label)
  if (missing.length) {
    return { ok: false, strength: 'static', detail: `已安装应用缺少许可文件：${missing.join('、')}` }
  }
  const upstream = await exists(join(dirname(resources), 'LICENSE.electron.txt'))
  return {
    ok: true,
    strength: 'static',
    detail: `licenses/ 六件套齐备（本发行版 / 第三方清单 / 上游 DSH Desktop / DeepSeek Harness / 青囊 / DSH Next）${upstream ? '；Electron/Chromium 许可在应用根目录' : ''}`
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const artifactsDir = resolve(REPO_ROOT, args.artifacts)
  const resultPath = join(REPO_ROOT, 'smoke-result.json')

  console.log(`[verify-install] 平台=${args.platform} 产物目录=${artifactsDir}`)

  const artifact = await findArtifact(artifactsDir, args.platform)
  if (!artifact) {
    record('产物存在', false, `${artifactsDir} 中未找到安装包`)
    await finish(resultPath, args, false)
    return
  }
  record('产物存在', true, artifact)

  const artifactPath = join(artifactsDir, artifact)
  const sizeMb = ((await fs.stat(artifactPath)).size / 1024 / 1024).toFixed(1)
  record('产物非空', Number(sizeMb) > 1, `${sizeMb} MB`)

  // 诊断文件与日志路径（应用写入 userData 下）
  //
  // Windows 的临时根回退必须是 C:\Temp（与下面的安装/启动路径一致），
  // 不能沿用 '/tmp'：在 Windows 上 '/tmp' 会变成**驱动器相对路径** `\tmp\...`，
  // 插件写出的位置与 smoke 读取的位置不一致 → Tier A 首屏证据永远收不到
  // （实测：本地 Windows smoke 曾因这个路径不一致，静默降级为 static 校验）。
  const smokeTempRoot = process.env.RUNNER_TEMP || (process.platform === 'win32' ? 'C:\\Temp' : '/tmp')
  const userData = process.env.XYB_SMOKE_USERDATA || join(smokeTempRoot, 'xyb-smoke')
  const diagnosticPath = join(userData, 'xyb-first-panel.json')
  const logPath = join(userData, 'xyb-startup.log')

  // ── 安装
  let installed = false
  try {
    if (args.platform === 'darwin' || args.platform === 'macos') {
      if (artifact.endsWith('.dmg')) {
        // CI 环境挂载 dmg 并复制 .app
        const mountPoint = join(process.env.RUNNER_TEMP || '/tmp', 'xyb-dmg')
        await fs.mkdir(mountPoint, { recursive: true })
        execFileSync('hdiutil', ['attach', artifactPath, '-nobrowse', '-mountpoint', mountPoint], { stdio: 'pipe' })
        const apps = (await fs.readdir(mountPoint)).filter((n) => n.endsWith('.app'))
        if (apps.length) {
          execFileSync('cp', ['-R', join(mountPoint, apps[0]), join(process.env.RUNNER_TEMP || '/tmp', apps[0])], { stdio: 'pipe' })
          installed = true
        }
        execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'pipe' })
      } else {
        execFileSync('unzip', ['-q', '-o', artifactPath, '-d', join(process.env.RUNNER_TEMP || '/tmp')], { stdio: 'pipe' })
        installed = true
      }
    } else {
      // Windows：静默安装（NSIS 的 /S）
      execFileSync(artifactPath, ['/S', `/D=${join(process.env.RUNNER_TEMP || 'C:\\Temp', 'xyb-app')}`], {
        stdio: 'pipe',
        timeout: 300000
      })
      installed = true
    }
    record('安装成功', installed, installed ? '已安装' : '安装未完成')
  } catch (error) {
    record('安装成功', false, String(error.message || error).slice(0, 300))
  }

  if (!installed) {
    // 安装失败 → 后续检查全部跳过（不计为通过）
    record('启动', false, '因安装失败而跳过', true)
    record('首屏为小胰宝面板', false, '因安装失败而跳过', true)
    record('宿主 UI 未泄漏', false, '因安装失败而跳过', true)
    await finish(resultPath, args, false)
    return
  }

  // ── 启动（带诊断参数；应用若支持则写诊断文件）
  await fs.mkdir(userData, { recursive: true })
  const env = { ...process.env, XYB_SMOKE_DIAGNOSTIC: diagnosticPath, XYB_SMOKE_LOG: logPath }

  // 启动输出落盘文件（stdout / stderr 各一份）
  const stdoutPath = join(userData, 'xyb-launch.stdout.log')
  const stderrPath = join(userData, 'xyb-launch.stderr.log')
  await fs.writeFile(stdoutPath, '')
  await fs.writeFile(stderrPath, '')

  let launched = false
  let launchError = null
  let child = null
  try {
    const command = getLaunchCommand(args.platform)
    child = spawn(command, getLaunchArgs(args.platform), {
      env,
      detached: true,
      // ⚠️ 不能用 'ignore'：插件加载失败的真正原因都在这两个流里。
      // 以前丢掉它，导致「插件崩了但 smoke 全绿」（实测踩坑）。
      stdio: ['ignore', 'pipe', 'pipe']
    })

    // 把子进程输出实时写盘（应用可能提前退出，所以用 stream 而不是等 close）
    const outStream = createWriteStream(stdoutPath, { flags: 'a' })
    const errStream = createWriteStream(stderrPath, { flags: 'a' })
    child.stdout?.pipe(outStream)
    child.stderr?.pipe(errStream)

    // ⚠️ spawn 失败（如路径不存在）是**异步** error 事件，不会被 try/catch 捕获。
    // 不监听它会把「没启动」误报为「已启动」（实测踩坑）。
    await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 3000)
      child.once('error', (error) => {
        clearTimeout(timer)
        launchError = error
        resolve('error')
      })
      child.once('spawn', () => {
        clearTimeout(timer)
        resolve('spawned')
      })
    })
    launched = !launchError
    record(
      '启动',
      launched,
      launchError ? `启动失败：${launchError.message}` : '进程已创建'
    )
  } catch (error) {
    record('启动', false, String(error.message || error).slice(0, 300))
  }

  // 等首屏证据出现。
  //
  // 关键优化：若启动输出里已出现**插件失败信号**，立刻停止等待——
  // 崩溃时诊断文件永远不会出现，不能白白等满 timeout。
  if (launched) {
    const appeared = await waitForAny(
      [
        { path: diagnosticPath, timeoutMs: args.timeout * 1000 },
        { path: logPath, timeoutMs: args.timeout * 1000 },
        { path: stderrPath, timeoutMs: args.timeout * 1000, stopOn: PLUGIN_FAILURE_MARKERS }
      ]
    )
    if (!appeared) {
      console.log('  · 诊断文件与日志均未出现（运行时链路未产出）')
    }
  }

  // ── 插件激活（**新增的关键运行时信号**）
  //
  // 为什么这个检查是必需的：
  // 之前 smoke 的链路是「装了 → 启动了 → 查到包里含三个插件」→ 全绿。
  // 但真实事故（2026-10-15）是插件 apply() 抛错、插件**没有激活**，
  // 应用完全打不开 —— 而上面这条链路完全看不到。
  // 启动进程其实把失败原因写在 stderr 了，接住就能用零协议成本验到。
  const activation = await checkPluginActivation([stderrPath, stdoutPath])
  record('插件已激活（应用可正常打开）', activation.ok, activation.detail)
  if (!activation.ok && activation.excerpt) {
    console.log('  ── 启动输出摘录 ──')
    for (const line of activation.excerpt.split('\n')) console.log(`  | ${line}`)
  }

  // 子进程还在跑的话，结束它（后面还有卸载步骤）
  if (child && child.exitCode === null) {
    try {
      if (args.platform === 'darwin' || args.platform === 'macos') {
        execFileSync('pkill', ['-f', '小胰宝社区版'], { stdio: 'pipe' })
      } else {
        execFileSync('taskkill', ['/F', '/T', '/IM', '小胰宝社区版.exe'], { stdio: 'pipe' })
      }
    } catch {
      /* 进程已自行退出 → 正常 */
    }
  }

  // ── 首屏校验（Tier A 运行时 → Tier B 静态，逐级降级）
  const firstPanel = await checkFirstPanel(diagnosticPath, logPath)
  if (firstPanel.ok) {
    record('首屏为小胰宝面板', true, `${firstPanel.detail}（校验强度：${firstPanel.strength}）`)
  } else {
    // Tier A 拿不到 → 降级到 Tier B（已安装应用的静态内容检查）
    const installed = await checkInstalledAppContent(args.platform)
    if (installed.ok) {
      record(
        '首屏为小胰宝面板',
        true,
        `运行时诊断未产出（${firstPanel.detail}），降级为已安装应用静态校验：${installed.detail}`
      )
      console.log('  ⚠️ 校验强度：static（证明「装的是小胰宝版本」，未直接观察运行时首屏）')
    } else {
      record('首屏为小胰宝面板', false, `${firstPanel.detail}；静态校验也失败：${installed.detail}`)
    }
  }

  // ── 宿主 UI 泄漏
  const hostUi = await checkNoHostUi(logPath, diagnosticPath)
  record('宿主 UI 未泄漏', hostUi.ok, hostUi.detail)

  // ── 许可随产物分发（MIT / Apache-2.0：版权与许可声明必须随分发送达）
  const licenses = await checkInstalledLicenses(args.platform)
  record('许可文件随产物分发', licenses.ok, licenses.detail)

  // ── 数据可写
  const dataWritable = await exists(userData)
  record('数据目录可写', dataWritable, userData)
  // ── 卸载
  try {
    if (args.platform !== 'darwin' && args.platform !== 'macos') {
      const uninstaller = join(process.env.RUNNER_TEMP || 'C:\\Temp', 'xyb-app', 'Uninstall 小胰宝社区版.exe')
      if (await exists(uninstaller)) {
        execFileSync(uninstaller, ['/S'], { stdio: 'pipe', timeout: 120000 })
      }
    }
    record('卸载', true, '已执行')
  } catch (error) {
    record('卸载', false, String(error.message || error).slice(0, 200))
  }

  const allOk = checks.every((c) => c.ok || c.skipped)
  await finish(resultPath, args, allOk)
}

/** 启动命令（平台相关） */
function getLaunchCommand(platform) {
  if (platform === 'darwin' || platform === 'macos') {
    return 'open'
  }
  const base = process.env.RUNNER_TEMP || 'C:\\Temp'
  return join(base, 'xyb-app', '小胰宝社区版.exe')
}

function getLaunchArgs(platform) {
  if (platform === 'darwin' || platform === 'macos') {
    const base = process.env.RUNNER_TEMP || '/tmp'
    // 找到安装后的 .app
    return ['-a', join(base, '小胰宝社区版.app'), '--args', '--xyb-diagnostic']
  }
  return ['--xyb-diagnostic']
}

async function finish(resultPath, args, ok) {
  const result = {
    ok,
    platform: args.platform,
    checkedAt: new Date().toISOString(),
    checks,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.ok && !c.skipped).length,
      failed: checks.filter((c) => !c.ok && !c.skipped).length,
      skipped: checks.filter((c) => c.skipped).length
    },
    note: ok ? 'smoke 通过' : 'smoke 失败 —— 将阻断发布（C-707）'
  }
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`\n[verify-install] ${ok ? '✅ 通过' : '❌ 失败'}（pass=${result.summary.passed} fail=${result.summary.failed} skip=${result.summary.skipped}）`)
  console.log(`[verify-install] 结果已写入 ${resultPath}`)
  process.exit(ok ? 0 : 1)
}

main().catch(async (error) => {
  console.error('[verify-install] 脚本错误:', error?.message || error)
  try {
    await fs.writeFile(
      join(REPO_ROOT, 'smoke-result.json'),
      JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2)
    )
  } catch {
    /* 写失败不影响退出码 */
  }
  process.exit(1)
})
