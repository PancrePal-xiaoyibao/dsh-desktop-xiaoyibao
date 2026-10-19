/**
 * 插件 apply() 行为契约测试 —— **真实调用 apply()，用 mock 宿主上下文**。
 *
 * 为什么这个测试至关重要（真实事故，2026-10-15）：
 * 第二个 Windows 安装包启动即崩，报：
 * `connection: exact Fetch route "/api/xyb/settings" is already registered`
 * 根因：路由 helper 对每个 (path, method) 各调一次 register，
 * 而**宿主的 fetch 路由注册以 path 为主键**，同 path 第二次注册就抛错
 * → 插件 apply() 失败 → 「required plugin did not activate」→ **整个应用打不开**。
 *
 * 本次（第一次修复）出问题的 5 个 path：/settings、/patients、/patients/:id、
 * /patients/:id/records、/patients/:id/medications
 *
 * 随后第三个安装包又炸了一次（路径参数 `:` 不被宿主接受），本文件与
 * test/host-contract/route-surface.test.mjs 一起覆盖那一次。
 *
 * 为什么之前的测试没抓到：
 * 静态检查（node --check / 完整性分析）看的是**语法与文本模式**，
 * 而这个是**运行时语义**：只有真的调一次 apply()，让 mock 宿主按真实规则
 * （path 主键、重复即抛）响应，才能暴露。
 *
 * 本测试做的三件事：
 * ① 用**真实规则**的 mock ctx 调用每个插件的 apply()，断言不抛错
 * ② 断言注册的路由**没有重复 path**（精确复现宿主的主键语义）
 * ③ 断言路由数量/方法符合预期（防止将来误删路由）
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

/**
 * 插件入口的 import 说明符。
 * Windows 下 import() 不接受裸盘符路径（ERR_UNSUPPORTED_ESM_URL_SCHEME：
 * "On Windows, absolute paths must be valid file:// URLs"），必须转成 file:// URL。
 */
function pluginEntrySpecifier(plugin) {
  return pathToFileURL(join(REPO_ROOT, 'packages', plugin, 'index.js')).href
}

const PLUGINS = ['dsh-xyb-branding', 'dsh-xyb-workbench', 'dsh-xyb-qingnang']

/**
 * 构造 mock Cordis 上下文。
 *
 * `connection.fetch.register` 的行为**刻意模仿宿主实现**：
 * · 以 path 为主键；同一 path 再注册一次 → 抛「already registered」
 * （宿主原文：`connection: exact Fetch route "<path>" is already registered`）
 *
 * 这就是本次事故的复现场景：如果插件对同 path 注册两次，这里也会抛。
 */
function createMockCtx() {
  /** @type {Map<string, {methods: string[], fetch: Function}>} */
  const routes = new Map()
  const logs = []
  const effects = []

  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a])
    },
    // 框架自带方法，不需要 inject
    effect: (fn, label) => {
      effects.push({ fn, label })
      return () => {}
    },
    reflect: { provide: () => {} },
    on: () => () => {},
    connection: {
      fetch: {
        register(spec) {
          // ── 与宿主一致的主键语义 ───────────────────────────
          if (routes.has(spec.path)) {
            throw new Error(
              `connection: exact Fetch route "${spec.path}" is already registered`
            )
          }
          if (typeof spec.fetch !== 'function') {
            throw new Error(`route ${spec.path}: fetch 必须是函数`)
          }
          routes.set(spec.path, {
            methods: [...(spec.methods || [])],
            fetch: spec.fetch
          })
          return () => {} // 注销函数
        }
      }
    }
  }

  return { ctx, routes, logs, effects }
}

/** 每个插件共用的隔离数据根（避免污染真实数据，也避免测试之间互相干扰） */
function withTempDataRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'xyb-apply-'))
  const prev = process.env.XYB_DATA_ROOT
  process.env.XYB_DATA_ROOT = dir
  try {
    return fn(dir)
  } finally {
    if (prev === undefined) delete process.env.XYB_DATA_ROOT
    else process.env.XYB_DATA_ROOT = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const plugin of PLUGINS) {
  test(`[${plugin}] apply() 用 mock 宿主调用不抛错`, async () => {
    await withTempDataRoot(async (dataRoot) => {
      const mod = await import(pluginEntrySpecifier(plugin))
      assert.equal(typeof mod.apply, 'function', `${plugin} 必须导出 apply 函数`)

      const { ctx, routes } = createMockCtx()

      // 真实调用 apply()，传插件配置（与 cordis.patch.yml 的 dshHomePath('xyb') 等价）
      await mod.apply(ctx, { root: dataRoot })

      // ③ 注册结果存在且无重复（无重复由 mock 的 throw 保证，这里确认有产出）
      if (plugin !== 'dsh-xyb-branding') {
        assert.ok(
          routes.size > 0,
          `${plugin} 应该注册至少一条路由（实际 ${routes.size} 条）`
        )
      }
    })
  })

  test(`[${plugin}] 注册的路由没有重复 path`, async () => {
    await withTempDataRoot(async (dataRoot) => {
      const mod = await import(pluginEntrySpecifier(plugin))
      const { ctx, routes } = createMockCtx()

      // mock 的 register 会在重复 path 时抛错，所以「不抛」就等于「无重复」。
      // 这里再把每条路由列出来做一次显式断言，便于失败时定位。
      await mod.apply(ctx, { root: dataRoot })

      const seen = new Map()
      for (const [path, spec] of routes) {
        assert.ok(!seen.has(path), `重复路由 path：${path}`)
        seen.set(path, spec)
        // 方法列表不能为空，也不能有重复方法
        assert.ok(spec.methods.length > 0, `路由 ${path} 没有 methods`)
        assert.equal(
          new Set(spec.methods).size,
          spec.methods.length,
          `路由 ${path} 的 methods 有重复：${spec.methods.join(',')}`
        )
      }
    })
  })
}

test('[dsh-xyb-workbench] 同 path 的多方法合并到一次注册（回归：/settings GET+POST）', async () => {
  await withTempDataRoot(async (dataRoot) => {
    const mod = await import(pluginEntrySpecifier('dsh-xyb-workbench'))
    const { ctx, routes } = createMockCtx()
    await mod.apply(ctx, { root: dataRoot })

    // 事故点：/api/xyb/settings 曾被 GET 与 POST 各注册一次 → 第二次抛错。
    // 现在必须是**一条**路由，methods 含 GET 与 POST。
    const settings = routes.get('/api/xyb/settings')
    assert.ok(settings, '必须注册 /api/xyb/settings 路由')
    assert.deepEqual(
      [...settings.methods].sort(),
      ['GET', 'POST'],
      `/api/xyb/settings 的 methods 应为 GET+POST，实际 ${settings.methods.join(',')}`
    )

    // 其余事故路径同样要合并
    //
    // ⚠️ 注意：患者相关路由的参数走**查询串**（`?id=xxx`），不再用 `/patients/:id`。
    // 原因是宿主端点校验 ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/ 不含冒号，
    // 路径参数会让 assertFetchRoute 抛 invalid exact Fetch route（第三个安装包的死因）。
    // 更完整的路由校验见 test/host-contract/route-surface.test.mjs。
    for (const [path, methods] of [
      ['/api/xyb/patients', ['GET', 'POST']],
      ['/api/xyb/patient', ['DELETE', 'GET', 'PATCH']],
      ['/api/xyb/patient/records', ['GET', 'POST']],
      ['/api/xyb/patient/medications', ['GET', 'POST']]
    ]) {
      const route = routes.get(path)
      assert.ok(route, `必须注册 ${path} 路由`)
      assert.deepEqual(
        [...route.methods].sort(),
        methods,
        `${path} 的 methods 应为 ${methods.join('+')}，实际 ${route.methods.join(',')}`
      )
    }
  })
})

test('三个插件的路由 path 互不冲突（前缀隔离）', async () => {
  await withTempDataRoot(async (dataRoot) => {
    /** path → 哪个插件注册的 */
    const owners = new Map()
    for (const plugin of PLUGINS) {
      const mod = await import(pluginEntrySpecifier(plugin))
      const { ctx, routes } = createMockCtx()
      await mod.apply(ctx, { root: dataRoot })
      for (const path of routes.keys()) {
        assert.ok(
          !owners.has(path),
          `路由 ${path} 被 ${owners.get(path)} 与 ${plugin} 同时注册（宿主按 path 主键，会冲突）`
        )
        owners.set(path, plugin)
      }
    }
    assert.ok(owners.size > 0, '三个插件合计应注册路由')
  })
})

test('workbench 路由用法：未声明的方法得到 405 而不是崩溃', async () => {
  await withTempDataRoot(async (dataRoot) => {
    const mod = await import(pluginEntrySpecifier('dsh-xyb-workbench'))
    const { ctx, routes } = createMockCtx()
    await mod.apply(ctx, { root: dataRoot })

    const settings = routes.get('/api/xyb/settings')
    // DELETE 不在声明里 → 分发器应返回 405，而不是抛「no handler」
    const response = await settings.fetch(
      new Request('http://127.0.0.1/api/xyb/settings', { method: 'DELETE' })
    )
    assert.equal(response.status, 405, `未声明方法应返回 405，实际 ${response.status}`)

    // 已声明的方法能正常跑通（读设置）
    const ok = await settings.fetch(
      new Request('http://127.0.0.1/api/xyb/settings', { method: 'GET' })
    )
    assert.equal(ok.status, 200)
    const body = await ok.json()
    // 隐私闸门未确认 → 解析模式必须回落 local
    assert.equal(body.parseMode, 'local')
  })
})
