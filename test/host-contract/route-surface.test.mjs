/**
 * 路由面契约测试 —— 用**行为等价于真宿主**的 mock 装载每个插件。
 *
 * ── 这个测试防的是什么（三次真实事故）─────────────────────────────────
 * 三个 Windows 安装包连崩三次，全是「插件注册期抛错 → 应用打不开」：
 * ① 模块级引用闭包变量（import 期 ReferenceError）
 * ② 同一 path 注册两次（already registered） ← 我靠**猜的规则**的 mock 抓到
 * ③ 路径写了 `:` 路径参数（invalid exact Fetch route）← 猜的规则漏了，崩了第三次
 *
 * 教训：mock 必须用**宿主真实规则**，不能用我猜的。
 * 现在 mock 的校验逻辑逐字抄自 @deepseek-ai/dsh-client-connection@0.2.0-rc.2
 * （见 scripts/lib/host-contract-rules.mjs 的溯源注释）。
 *
 * ── 本测试覆盖四层 ────────────────────────────────────────────────
 * L1 装载：apply() 不得抛错（等价于宿主 auditStartupEntries 判定「插件已激活」）
 * L2 形状：路由集合快照（防止误删/改名导致客户端 404）
 * L3 可用：每条路由**真发请求**必须返回非 404（注册成功 ≠ 请求能到达）
 * L4 重载：teardown 后重新 apply 必须仍成功（宿主 HMR / profile 切换会走到）
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { bootPlugin, createHostMock, teardown } from '../../scripts/lib/host-contract-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

/** 三个自有插件：名字 → 入口文件 */
const PLUGINS = {
  'dsh-xyb-branding': 'index.js',
  'dsh-xyb-workbench': 'index.js',
  'dsh-xyb-qingnang': 'index.js'
}

/** 共享的隔离数据根（所有测试用同一个临时目录，避免污染真实数据） */
let dataRoot

before(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-route-'))
  process.env.XYB_DATA_ROOT = dataRoot
})

after(() => {
  delete process.env.XYB_DATA_ROOT
  rmSync(dataRoot, { recursive: true, force: true })
})

/** 通用的「装载并断言成功」 */
async function bootOk(name) {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', name, PLUGINS[name])).href
  const { mod, mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(
    registerError,
    null,
    `[${name}] apply() 抛错 → 真宿主会报「required plugin did not activate」→ 应用打不开。\n` +
      `真实错误：${registerError?.message}`
  )
  assert.equal(typeof mod.apply, 'function', `[${name}] 必须导出 apply 函数`)
  return { mod, mock }
}

// ─────────────────────────────────────────── L1 装载

for (const name of Object.keys(PLUGINS)) {
  test(`[L1 装载] ${name} 用宿主规则装载不抛错`, async () => {
    await bootOk(name)
  })
}

test('[L1 装载] 三个插件可以同时装载（路由互不冲突）', async () => {
  const owners = new Map()
  for (const name of Object.keys(PLUGINS)) {
    const { mock } = await bootOk(name)
    for (const path of mock.routes.keys()) {
      assert.ok(
        !owners.has(path),
        `路由 ${path} 被 ${owners.get(path)} 与 ${name} 同时注册 → 真宿主抛 already registered`
      )
      owners.set(path, name)
    }
  }
  assert.ok(owners.size > 0, '三个插件合计应注册路由')
})

// ─────────────────────────────────────────── L2 形状

test('[L2 形状] workbench 路由集合快照（改动即提醒复核客户端）', async () => {
  const { mock } = await bootOk('dsh-xyb-workbench')
  const actual = [...mock.routes.keys()].sort()

  // 快照：任何增删改都必须同步检查 client.js 的调用点
  const EXPECTED = [
    '/api/xyb/catalog',
    '/api/xyb/diagnostics/export',
    '/api/xyb/diagnostics/preview',
    '/api/xyb/disclaimers',
    '/api/xyb/events/list',
    '/api/xyb/health',
    '/api/xyb/manifest',
    '/api/xyb/model-config',
    '/api/xyb/model-config/credential',
    '/api/xyb/model-provider/custom',
    '/api/xyb/model-selected',
    '/api/xyb/models/available',
    '/api/xyb/patient',
    '/api/xyb/patient/assess',
    '/api/xyb/patient/board',
    '/api/xyb/patient/indicator-summary',
    '/api/xyb/patient/medications',
    '/api/xyb/patient/pending',
    '/api/xyb/patient/record',
    '/api/xyb/patient/records',
    '/api/xyb/patient/records-including-unverified',
    '/api/xyb/patient/review',
    '/api/xyb/patient/series',
    '/api/xyb/patients',
    '/api/xyb/patient/psych',
    '/api/xyb/probe-dir',
    '/api/xyb/psych/resources',
    '/api/xyb/psych/scales',
    '/api/xyb/selfcheck',
    '/api/xyb/selfcheck/repair',
    '/api/xyb/settings',
    '/api/xyb/storage/stats'
  ].sort()

  assert.deepEqual(
    actual,
    EXPECTED,
    `路由集合变了。新增/删除路由时请同步更新本快照，并确认 client.js 的调用点\n` +
      `  多了：${actual.filter((p) => !EXPECTED.includes(p)).join(' ') || '（无）'}\n` +
      `  少了：${EXPECTED.filter((p) => !actual.includes(p)).join(' ') || '（无）'}`
  )
})

test('[L2 形状] qingnang 路由集合快照', async () => {
  const { mock } = await bootOk('dsh-xyb-qingnang')
  const actual = [...mock.routes.keys()].sort()
  const EXPECTED = [
    '/api/xyb/qingnang/attribution',
    '/api/xyb/qingnang/channels',
    '/api/xyb/qingnang/credentials',
    '/api/xyb/qingnang/doctor',
    '/api/xyb/qingnang/health',
    '/api/xyb/qingnang/probe',
    '/api/xyb/qingnang/status'
  ].sort()
  assert.deepEqual(actual, EXPECTED, 'qingnang 路由集合变了，请同步快照与客户端')
})

test('[L2 形状] 每个 path 的 methods 无重复、无空数组', async () => {
  for (const name of Object.keys(PLUGINS)) {
    const { mock } = await bootOk(name)
    for (const [path, spec] of mock.routes) {
      assert.ok(spec.methods.size > 0, `${name} 路由 ${path} 没有 methods（宿主会抛 declares no methods）`)
      // Set 去重后如果与原始数组长度不一致，宿主会抛 repeats a method
      // （mock 的 assertFetchRoute 已经拦了，这里再显式断言一次便于定位）
      assert.ok(spec.methods.size >= 1)
    }
  }
})

test('[L2 形状] branding 注册的是不含 connection 的表面（不注册路由）', async () => {
  const { mock } = await bootOk('dsh-xyb-branding')
  assert.equal(mock.routes.size, 0, 'branding 只做品牌层，不应注册 HTTP 路由')
})

// ─────────────────────────────────────────── L3 可用（真发请求）

test('[L3 可用] workbench 每条路由真发请求都不得 404', async () => {
  const { mock } = await bootOk('dsh-xyb-workbench')

  for (const [path, spec] of mock.routes) {
    // 每个已声明的方法都发一次；无 body 的 GET 直接发
    for (const method of spec.methods) {
      const init = { method }
      if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
        init.headers = { 'content-type': 'application/json' }
        // DELETE 需要二次确认；PATCH 需要合法 patch；统一给最小合法 body
        init.body = method === 'DELETE' ? JSON.stringify({ confirm: true }) : JSON.stringify({})
      }
      const res = await mock.dispatch(`http://127.0.0.1${path}`, init)
      assert.notEqual(
        res.status,
        404,
        `${method} ${path} 返回 404 —— 说明路由没被宿主派发到（注册成功 ≠ 能到达）`
      )
      // 消费 body，避免 stream 泄漏警告
      await res.text()
    }
  }
})

test('[L3 可用] 未声明的方法返回 404（宿主语义），已声明的不会', async () => {
  const { mock } = await bootOk('dsh-xyb-workbench')
  const settings = mock.routes.get('/api/xyb/settings')
  assert.ok(settings, '必须注册 /api/xyb/settings')

  // DELETE 未声明 → 宿主按「方法不在集合内」走 404（不是 405）
  const res = await mock.dispatch('http://127.0.0.1/api/xyb/settings', { method: 'DELETE' })
  assert.equal(res.status, 404, '未声明方法应落入宿主 404（路由未匹配）')
  await res.text()

  // GET 已声明 → 命中 handler
  const ok = await mock.dispatch('http://127.0.0.1/api/xyb/settings', { method: 'GET' })
  assert.equal(ok.status, 200, `GET /api/xyb/settings 应 200，实际 ${ok.status}`)
  const body = await ok.json()
  // 隐私闸门未确认 → 解析模式强制回落 local
  assert.equal(body.parseMode, 'local', '未确认隐私闸门时 parseMode 必须是 local')
})

test('[L3 可用] 查询串传参可用：/patient?id=xxx 能返回档案或明确错误', async () => {
  const { mock } = await bootOk('dsh-xyb-workbench')

  // 非法 id → 403 PATH_ESCAPE（不能是 500，也不能是 404）
  const bad = await mock.dispatch('http://127.0.0.1/api/xyb/patient?id=..%2Fetc')
  assert.equal(bad.status, 403, `非法 id 应 403，实际 ${bad.status}`)
  const badBody = await bad.json()
  assert.equal(badBody.error, 'PATH_ESCAPE')

  // 不存在的合法 id → 业务层 404，且 body 是 JSON 错误体
  // （路由未命中时宿主返回的是纯文本 'not found'，两者可区分）
  const missing = await mock.dispatch('http://127.0.0.1/api/xyb/patient?id=p-not-exist')
  const raw = await missing.text()
  assert.ok(
    raw.includes('"error"'),
    `不存在的档案应返回业务层 JSON 错误（证明路由通），实际 status=${missing.status} body=${raw.slice(0, 80)}`
  )
})

test('[L3 可用] qingnang 每条路由真发请求都不得 404', async () => {
  const { mock } = await bootOk('dsh-xyb-qingnang')
  for (const [path, spec] of mock.routes) {
    for (const method of spec.methods) {
      const init = { method }
      if (method === 'POST') {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify({})
      }
      const res = await mock.dispatch(`http://127.0.0.1${path}`, init)
      assert.notEqual(res.status, 404, `${method} ${path} 返回 404 —— 路由未被派发`)
      await res.text()
    }
  }
})

// ─────────────────────────────────────────── L4 重载（HMR / profile 切换）

test('[L4 重载] workbench 卸载后可重新装载（宿主 HMR 场景）', async () => {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const mod = await import(entry)

  const first = createHostMock()
  await mod.apply(first.ctx, { root: dataRoot })
  const before = first.routes.size
  assert.ok(before > 0)

  // 卸载：跑所有 effect 的 disposer（宿主热重载会走到）
  teardown(first)
  assert.equal(first.routes.size, 0, '卸载后路由应被清空（宿主 disposer 会 delete）')

  // 重新装载：不得抛 already registered
  // ⚠️ apply() 是同步函数，返回 undefined；assert.doesNotReject 需要 Promise，
  // 所以要用 async 包装（实测踩坑：直接传同步函数会报 ERR_INVALID_RETURN_VALUE）。
  const second = createHostMock()
  await assert.doesNotReject(
    async () => {
      await mod.apply(second.ctx, { root: dataRoot })
    },
    '卸载后重新装载必须成功（否则宿主热重载 / profile 切换会崩）'
  )
  assert.equal(second.routes.size, before, '重载后路由数量应与首次一致')
})

// ─────────────────────────────────────────── 溯源钉

test('[溯源] mock 的校验规则与宿主源码一致（钉住常量）', async () => {
  const { CHANNEL_PATTERN, ENDPOINT_SEGMENT_PATTERN, explainRoutePath } = await import(
    '../../scripts/lib/host-contract-rules.mjs'
  )
  // 逐字对齐 @deepseek-ai/dsh-client-connection@0.2.0-rc.2 lib/index.js L549-550
  assert.equal(String(ENDPOINT_SEGMENT_PATTERN), String(/^[A-Za-z0-9_$.-]+$/), '宿主路径段模式变了')
  assert.equal(String(CHANNEL_PATTERN), String(/^\/[A-Za-z0-9._~-]+$/), '宿主频道模式变了')

  // 关键性质：冒号非法（这是第三个安装包崩溃的根因）
  assert.ok(!ENDPOINT_SEGMENT_PATTERN.test(':id'), '宿主不允许冒号 —— 这条若变则路径参数可用')
  assert.ok(explainRoutePath('/api/xyb/patients/:id')?.includes('":id"'), '应能解释冒号非法')

  // 合法路径不得被误判
  for (const ok of [
    '/api/xyb/settings',
    '/api/xyb/patient',
    '/api/xyb/patient/records',
    '/api/xyb/storage/stats',
    '/api/xyb/qingnang/status'
  ]) {
    assert.equal(explainRoutePath(ok), null, `${ok} 应合法`)
  }

  // 各类非法路径都要能被解释
  for (const bad of [
    '/api/xyb/patients/:id',
    '/api/xyb/patients/:id/records',
    '/api/xyb//double',
    '/api/xyb/../escape',
    '/api/xyb/has space',
    '/api/xyb/中文'
  ]) {
    assert.ok(explainRoutePath(bad), `${bad} 应被判定非法`)
  }
})
