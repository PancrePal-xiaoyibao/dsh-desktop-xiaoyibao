/**
 * smoke 检测器单测 —— 用**真实崩溃日志**当 fixture。
 *
 * 为什么这个测试必须有（真实事故，2026-10-15）：
 *   第二个 Windows 安装包启动即崩（插件路由重复注册 → apply() 抛错 →
 *   应用完全打不开），而 smoke **全绿**。
 *   两个根因：
 *     ① 启动输出被 `stdio: 'ignore'` 丢弃 → 失败信号进不了 smoke
 *     ② 即便拿到日志，也没有「认得出这是崩溃」的检测器
 *   本测试锁定 ②：把用户实测的原始日志原文当输入，断言检测器必须判失败。
 *
 * 测试策略：**用真实数据，不用人造样本**。
 *   下面 CRASH_LOG 里的每一行都是从用户 Windows 实测输出里原样摘的。
 *   这样测试防的是「检测器漏判真实故障」，而不是「检测器符合我造的样本」。
 */
import { strict as assert } from 'node:assert'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  detectFirstPanelFromText,
  detectHostUiLeak,
  detectPluginFailure,
  FIRST_PANEL_MARKERS,
  HOST_UI_MARKERS,
  PLUGIN_FAILURE_MARKERS
} from '../../scripts/lib/smoke-detect.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

// ─────────────────────────────────────────── 真实崩溃日志（用户实测原文）

/** 事故 1：readSettings 未定义（第一个安装包） */
const CRASH_LOG_READSETTINGS = `
[2026-10-15T12:23:58.242Z] + 5906ms [stdout] [harness-node] invoking DSH runCli()
[2026-10-15T12:24:00.418Z] + 8082ms [stderr] [harness-log] error include: ReferenceError: readSettings is not defined
[2026-10-15T12:24:00.418Z] + 8082ms [stderr] [harness-log]       at file:///E:/software/dsh-desktop/resources/app.asar/node_modules/dsh-xyb-workbench/index.js:394:30
[2026-10-15T12:24:01.656Z] + 9320ms [stderr] dsh: startup failed: 1 required plugin did not activate
[2026-10-15T12:24:01.656Z] + 9320ms [stderr] Failed plugins (1):
[2026-10-15T12:24:01.656Z] + 9320ms [stderr]   dsh-xyb-workbench (required)
[2026-10-15T12:24:01.659Z] + 9323ms [stderr] [harness-node] plugin failures: {"version":1,"failures":[{"stage":"import","entryId":"dsh-xyb-workbench","message":"readSettings is not defined"}]}
[2026-10-15T12:24:01.659Z] + 9323ms [desktop] Harness entry failed during startup; stopping immediately
`.trim()

/** 事故 2：路由重复注册（第二个安装包） */
const CRASH_LOG_DUP_ROUTE = `
[2026-10-15T13:28:05.208Z] + 5089ms [stderr] [harness-log] error include: Error: connection: exact Fetch route "/api/xyb/settings" is already registered
[2026-10-15T13:28:05.208Z] + 5089ms [stderr] [harness-log]       at route (file:///E:/software/dsh-desktop/resources/app.asar/node_modules/dsh-xyb-workbench/index.js:154:26)
[2026-10-15T13:28:05.284Z] + 5165ms [stderr] dsh: startup failed: 1 required plugin did not activate
[2026-10-15T13:28:05.287Z] + 5168ms [stderr] [harness-node] plugin failures: {"version":1,"failures":[{"stage":"apply","entryId":"dsh-xyb-workbench","message":"connection: exact Fetch route /api/xyb/settings is already registered"}]}
[2026-10-15T13:28:05.288Z] + 5169ms [desktop] Harness entry failed during startup; stopping immediately
`.trim()

/** 正常启动的输出（对照组：不得误判为失败） */
const HEALTHY_LOG = `
[2026-10-15T13:28:01.736Z] + 1617ms [stdout] [harness-node] runtime node=v24.17.0 platform=win32 arch=x64
[2026-10-15T13:28:01.902Z] + 1783ms [stdout] [harness-node] DSH entry loaded
[2026-10-15T13:28:04.050Z] + 3931ms [stdout] [harness-log] info dsh-desktop-log-bridge: runtime warnings and errors are recorded from here on
[2026-10-15T13:28:05.154Z] + 5035ms [stdout] dsh-desktop: pnpm shim written
`.trim()

// ─────────────────────────────────────────── detectPluginFailure

test('[smoke-detect] 事故日志 1（readSettings 未定义）必须判为插件失败', () => {
  const r = detectPluginFailure([CRASH_LOG_READSETTINGS])
  assert.equal(r.ok, false, '真实崩溃日志绝不能判为通过')
  assert.ok(r.hit, '必须给出命中的信号词')
  assert.ok(r.excerpt.length > 0, '必须给出上下文摘录，便于定位')
  // 摘录要能看出「哪个插件、什么错」
  assert.ok(
    r.excerpt.includes('readSettings') || r.excerpt.includes('dsh-xyb-workbench'),
    `摘录应含插件名或错误信息，实际：${r.excerpt}`
  )
})

test('[smoke-detect] 事故日志 2（路由重复注册）必须判为插件失败', () => {
  const r = detectPluginFailure([CRASH_LOG_DUP_ROUTE])
  assert.equal(r.ok, false, '真实崩溃日志绝不能判为通过')
  assert.ok(r.hit, '必须给出命中的信号词')
  assert.ok(
    r.excerpt.includes('already registered') || r.excerpt.includes('did not activate'),
    `摘录应含关键错误，实际：${r.excerpt}`
  )
})

test('[smoke-detect] 正常启动日志不得误判', () => {
  const r = detectPluginFailure([HEALTHY_LOG])
  assert.equal(r.ok, true, `健康日志被误判为崩溃：hit=${r.hit}`)
  assert.equal(r.hit, null)
})

test('[smoke-detect] stderr 与 stdout 都要扫（不能只看一个流）', () => {
  // 失败信号只在 stderr，stdout 干净 → 仍然要抓到
  const r1 = detectPluginFailure([HEALTHY_LOG, CRASH_LOG_DUP_ROUTE])
  assert.equal(r1.ok, false, 'stderr 里有失败信号，合并扫描时必须抓到')

  // 反过来也必须抓
  const r2 = detectPluginFailure([CRASH_LOG_DUP_ROUTE, HEALTHY_LOG])
  assert.equal(r2.ok, false, '参数顺序不应影响判定')
})

test('[smoke-detect] 未捕获到输出时不据此判失败（避免假红）', () => {
  for (const input of [[], [''], ['', ''], [null, undefined]]) {
    const r = detectPluginFailure(input)
    assert.equal(r.ok, true, `空输入应判通过（不据此判失败），实际：${JSON.stringify(r)}`)
    assert.ok(r.detail.includes('未捕获到'), `detail 应说明原因，实际：${r.detail}`)
  }
})

test('[smoke-detect] 每个失败关键词都能独立命中（防未来手滑删词）', () => {
  for (const marker of PLUGIN_FAILURE_MARKERS) {
    const r = detectPluginFailure([`some output\n${marker}\nmore`])
    assert.equal(r.ok, false, `关键词「${marker}」未被识别`)
  }
})

// ─────────────────────────────────────────── detectFirstPanelFromText

test('[smoke-detect] 诊断文件含小胰宝标识 → 通过，强度 diagnostic', () => {
  const r = detectFirstPanelFromText(
    JSON.stringify({ firstPanel: 'xyb', firstPanelLabel: '小胰宝', product: '小胰宝社区版' }),
    'diagnostic'
  )
  assert.equal(r.ok, true)
  assert.equal(r.strength, 'diagnostic')
})

test('[smoke-detect] 诊断文件存在但不含标识 → 失败（不是降级）', () => {
  const r = detectFirstPanelFromText('{"firstPanel":"dsh","product":"DSH Desktop"}', 'diagnostic')
  assert.equal(r.ok, false, '有诊断文件但不含标识，说明首屏不对，必须判失败')
  assert.equal(r.strength, 'diagnostic')
})

test('[smoke-detect] 无文件 → 失败且强度 none', () => {
  const r = detectFirstPanelFromText(null, 'diagnostic')
  assert.equal(r.ok, false)
  assert.equal(r.strength, 'none')
})

test('[smoke-detect] 三个标识词（xyb / xiaoyibao / 小胰宝）都能识别，大小写不敏感', () => {
  for (const text of ['firstPanel: xyb', 'XIAOYIBAO', '小胰宝社区版', 'Xyb']) {
    const r = detectFirstPanelFromText(text, 'diagnostic')
    assert.equal(r.ok, true, `标识「${text}」未被识别`)
  }
  assert.equal(FIRST_PANEL_MARKERS.length, 3, '首屏标识词数量变化需要复核（可能漏判/误判）')
})

// ─────────────────────────────────────────── detectHostUiLeak

test('[smoke-detect] 出现宿主 UI 词 → 判泄漏', () => {
  for (const marker of HOST_UI_MARKERS) {
    const r = detectHostUiLeak([`log line\n${marker}\n`])
    assert.equal(r.ok, false, `泄漏词「${marker}」未被识别`)
    assert.ok(r.detail.includes(marker), `detail 应指明是哪个词，实际：${r.detail}`)
  }
})

test('[smoke-detect] 无泄漏词 → 通过', () => {
  const r = detectHostUiLeak([HEALTHY_LOG, ''])
  assert.equal(r.ok, true)
})

// ─────────────────────────────────────────── 与真实仓库的一致性

test('[smoke-detect] 插件写诊断的字段必须能被检测器识别（跨端契约）', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(
    join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js'),
    'utf8'
  )
  // 插件产出的 payload 里，firstPanel 字段值必须是检测器认得的标识之一
  const m = src.match(/firstPanel:\s*'([^']+)'/)
  assert.ok(m, '未在 workbench 插件里找到 firstPanel 字段（契约变了，检测器要跟着改）')
  const value = m[1]
  assert.ok(
    FIRST_PANEL_MARKERS.some((marker) => value.toLowerCase().includes(marker.toLowerCase())),
    `插件写的 firstPanel="${value}" 不在检测器标识词 ${FIRST_PANEL_MARKERS.join('/')} 里 → 真实设备上会误判失败`
  )
})
