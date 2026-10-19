/**
 * 客户端运行时测试 —— **真实加载 client.js、真实渲染、真实打到服务端路由上**。
 *
 * ── 为什么必须有这一层（四次崩溃的教训）─────────────────────────────
 *   前三次崩在**服务端**（插件装载失败 → 应用打不开）。
 *   第四次（2026-10-16）崩在**客户端**：服务端已经 `Harness is ready`，
 *   但 renderer 报槽位冲突 → 客户端插件全部加载失败 → 界面打不开。
 *
 *   这一层覆盖的是「打开之后」的问题，它们**比崩溃更难查**（没有堆栈、界面不报错）：
 *     · client.js 引用了不存在的函数/变量        → 点开面板白屏
 *     · 客户端 slot 名写错                       → 面板根本不显示，静默
 *     · 客户端调了服务端没有的接口               → 点下去 404，只在浏览器控制台可见
 *     · 客户端读错服务端返回的字段名             → 界面空白
 *     · 槽位冲突（第四次崩溃）                   → 整个 renderer 插件加载失败
 *
 * ── 基础设施 ────────────────────────────────────────────────────────
 *   mini-React / mini-DOM / 元素树工具 / 条件驱动等待 / 加载器 / 槽位真规则替身
 *   全部在 `scripts/lib/client-sandbox.mjs`（单一真源，两个套件共用）。
 *   那边的注释里逐条写明「替身语义不保真会怎样」。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { loadClient, makeFetch, mountClient, renderUntil, collectProps, textOf } from '../../scripts/lib/client-sandbox.mjs'
import { bootPlugin } from '../../scripts/lib/host-contract-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

let dataRoot
before(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-render-'))
  process.env.XYB_DATA_ROOT = dataRoot
})
after(() => {
  delete process.env.XYB_DATA_ROOT
  rmSync(dataRoot, { recursive: true, force: true })
})

/** 装载服务端，拿真实路由表 */
async function serverRoutes(name) {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', name, 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `${name} 服务端装载失败：${registerError?.message}`)
  return mock.routes
}

/** 装载客户端插件（槽位用真规则替身 + 预置宿主占据者） */
const mount = (name) => mountClient(REPO_ROOT, name)

// ═══════════════════════════════════════════ workbench

test('[workbench] factory 真跑一遍不抛错，导出 apply/inject，服务已声明', () => {
  const { exports } = loadClient(REPO_ROOT, 'dsh-xyb-workbench')
  assert.equal(typeof exports.apply, 'function', '客户端必须导出 apply')
  assert.ok(Array.isArray(exports.inject) && exports.inject.length > 0, 'inject 必须是非空数组')
  assert.ok(exports.inject.includes('desktopWorkbenches'), '工作台面板必须 inject desktopWorkbenches')
})

test('[workbench] apply 时把面板注册进 desktopWorkbenches（宿主工作台契约）', () => {
  const { registered } = mount('dsh-xyb-workbench')
  assert.equal(registered.length, 1, '必须注册恰好一个工作台面板')

  const { spec, Component } = registered[0]
  // 字段要求对照 vendor/dsh-desktop-main/docs/workbench-standard.zh.md
  for (const key of ['title', 'repository', 'description', 'category']) {
    assert.ok(spec[key], `工作台注册缺少字段 ${key}`)
  }
  assert.equal(typeof Component, 'function', '面板必须是可渲染组件')
  assert.ok(spec.repository.startsWith('https://'), 'repository 必须是可访问的地址')
})

test('[workbench] 首屏真渲染：无档案时显示引导页（不是永远 loading）', async () => {
  const routes = await serverRoutes('dsh-xyb-workbench')
  const { fetchImpl, calls } = makeFetch(routes)
  globalThis.fetch = fetchImpl

  try {
    const { react, registered } = mount('dsh-xyb-workbench')
    const Panel = registered[0].Component

    // 首渲染应先显示加载态（真实行为，不是错误）。
    // ⚠️ 这次渲染**必须同时把 effect 跑掉**：useEffect 有依赖比较，只渲染不跑 effect
    //    会让下一次渲染不再登记 effect → 请求发不出去 → 永远卡在加载态（实测踩坑）。
    const first = react.render(Panel, { service: {} })
    assert.ok(textOf(first.tree).join('').includes('正在启动'), '首渲染应先显示加载态')
    for (const e of first.effects) e.fn()

    const settled = await renderUntil(react, Panel, { service: {} }, (t) => t.includes('还没有患者档案'), {
      label: '引导页（还没有患者档案）'
    })

    assert.ok(settled.text.includes('小胰宝'), '引导页应含产品名')
    assert.ok(settled.text.includes('建立档案'), '引导页应有建立档案入口')

    // 关键：客户端发的每个请求都命中了真实服务端路由
    assert.ok(calls.length > 0, '首屏应至少请求一次 /manifest')
    for (const c of calls) {
      assert.ok(routes.has(c.path), `客户端请求了不存在的路由：${c.method} ${c.path}`)
      assert.ok(!c.path.includes(':'), `客户端不得发送含冒号的路径：${c.path}`)
    }
    assert.equal(calls[0].path, '/api/xyb/manifest', '首屏第一个请求应是 /manifest')
    assert.equal(calls[0].method, 'GET')
  } finally {
    delete globalThis.fetch
  }
})

test('[workbench] 建档案 → 看板：全链路走真实服务端，界面收敛到看板', async () => {
  const routes = await serverRoutes('dsh-xyb-workbench')
  const { fetchImpl, calls } = makeFetch(routes)
  globalThis.fetch = fetchImpl

  try {
    const { react, registered } = mount('dsh-xyb-workbench')
    const Panel = registered[0].Component
    const props = { service: {} }

    await renderUntil(react, Panel, props, (t) => t.includes('还没有患者档案'), { label: '引导页' })

    // 在姓名框里输入（调真实的 onChange）
    const input = collectProps(react.render(Panel, props).tree).find((p) => p.type === 'input')
    assert.ok(input, '引导页应有姓名输入框')
    assert.equal(input.props['aria-label'], '患者姓名或化名', '输入框应有可访问名称')
    input.props.onChange({ target: { value: '测试患者' } })

    // 点「建立档案」（触发真实 POST /api/xyb/patients）
    // 外壳（customFrame）里还有页签/AI 协助等按钮，按文案找目标按钮
    const findButtonByText = (tree, label) => {
      let found = null
      const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) {
          node.forEach(walk)
          return
        }
        if (node.$$element) {
          if (node.type === 'button' && !node.props.disabled && textOf(node).join('').includes(label)) found = node
          walk(node.children)
        }
      }
      walk(tree)
      return found
    }
    const btn = findButtonByText(react.render(Panel, props).tree, '建立档案')
    assert.ok(btn, '填了姓名后应有可点的建立按钮')
    btn.props.onClick()

    const settled = await renderUntil(
      react,
      Panel,
      props,
      // 用「患者：」而不是「资料完整度」：空态骨架也含后者，会导致提前收敛
      (text) => text.includes('患者：'),
      { label: '看板（患者：）' }
    )

    assert.ok(
      !settled.text.includes('请求失败') && !settled.text.includes('无法解析') && !settled.text.includes('内部错误'),
      `建档案后不应出现错误，实际渲染：${settled.text.slice(0, 300)}`
    )

    // 全链路请求都命中真实路由，参数走查询串
    const paths = [...new Set(calls.map((c) => `${c.method} ${c.path}`))]
    assert.ok(paths.includes('POST /api/xyb/patients'), `应发过建档案请求，实际：${paths.join(' | ')}`)
    assert.ok(
      paths.includes('GET /api/xyb/patient/board'),
      `应发过看板请求（/patient/board + 查询串），实际：${paths.join(' | ')}`
    )
    const boardCall = calls.find((c) => c.path === '/api/xyb/patient/board')
    assert.ok(boardCall.search.includes('id='), `看板请求必须带 ?id=，实际 ${boardCall.search}`)

    for (const c of calls) {
      assert.ok(!c.path.includes(':'), `客户端不得发送含冒号的路径：${c.path}`)
      assert.ok(routes.has(c.path), `客户端请求了不存在的路由：${c.method} ${c.path}`)
    }

    // 服务端数据真的落盘了（不是只有界面看起来对）
    const { readFileSync } = await import('node:fs')
    const manifest = JSON.parse(readFileSync(join(dataRoot, 'manifest.json'), 'utf8'))
    assert.equal(manifest.patients.length, 1, '服务端应落盘 1 份档案')
    assert.equal(manifest.patients[0].name, '测试患者')
  } finally {
    delete globalThis.fetch
  }
})

test('[workbench] 服务端返回错误时界面显示可读错误，且可重试', async () => {
  const routes = await serverRoutes('dsh-xyb-workbench')
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://127.0.0.1')
    if (u.pathname === '/api/xyb/manifest') {
      return new Response(JSON.stringify({ error: 'INTERNAL', message: '内部错误' }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })
    }
    const route = routes.get(u.pathname)
    if (!route) return new Response('not found', { status: 404 })
    return route.fetch(new Request(u, init))
  }

  try {
    const { react, registered } = mount('dsh-xyb-workbench')
    const Panel = registered[0].Component
    const settled = await renderUntil(react, Panel, { service: {} }, (t) => t.includes('内部错误'), {
      label: '错误提示'
    })
    assert.ok(settled.text.includes('重试'), '错误态应提供重试入口')
  } finally {
    delete globalThis.fetch
  }
})

// ═══════════════════════════════════════════ qingnang

test('[qingnang] factory 真跑一遍不抛错，导出 apply/inject', () => {
  const { exports } = loadClient(REPO_ROOT, 'dsh-xyb-qingnang')
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject) && exports.inject.length > 0)
  assert.ok(exports.inject.includes('slots'), '青囊面板注册到 slot，必须 inject slots')
})

test('[qingnang] apply 时往 settings.general.item 注册设置面板', () => {
  const { registered, injected } = mount('dsh-xyb-qingnang')
  assert.ok(injected.includes('settings.general.item'), '必须往 settings.general.item 注入')
  assert.equal(registered.length, 1, '必须注册恰好一个设置项')

  const { spec, Component } = registered[0]
  assert.equal(spec.name, 'settings.general.item', 'slot 名必须与 inject 时一致（否则静默注册到别处）')
  assert.ok(spec.id, 'list 槽位必须有 id（宿主用它做去重键）')
  assert.equal(typeof Component, 'function')
})

test('[qingnang] 面板真渲染，状态来自真实服务端 /status', async () => {
  const routes = await serverRoutes('dsh-xyb-qingnang')
  const { fetchImpl, calls } = makeFetch(routes)
  globalThis.fetch = fetchImpl

  try {
    const { react, registered } = mount('dsh-xyb-qingnang')
    const Panel = registered[0].Component

    const settled = await renderUntil(
      react,
      Panel,
      {},
      (text) => text.length > 20 && calls.some((c) => c.path === '/api/xyb/qingnang/status'),
      { label: '青囊面板内容 + /status 请求' }
    )
    assert.ok(settled.text.length > 0, '青囊面板应渲染出内容')

    for (const c of calls) {
      assert.ok(routes.has(c.path), `青囊客户端请求了不存在的路由：${c.method} ${c.path}`)
      assert.ok(!c.path.includes(':'), `不得发送含冒号的路径：${c.path}`)
    }
  } finally {
    delete globalThis.fetch
  }
})

// ═══════════════════════════════════════════ branding

test('[branding] factory 真跑一遍不抛错，导出 apply', () => {
  const { exports } = loadClient(REPO_ROOT, 'dsh-xyb-branding')
  assert.equal(typeof exports.apply, 'function')
})

test('[branding] 往三个品牌 slot 注册标记（侧栏 + 侧栏名 + 对话区）', () => {
  const { registered, injected } = mount('dsh-xyb-branding')
  assert.deepEqual(
    [...injected].sort(),
    ['conversation.hero.brand.mark', 'sidebar.brand.mark', 'sidebar.brand.name'],
    '品牌层应覆盖侧栏标记 / 侧栏名 / 对话区标记三个 slot'
  )
  assert.equal(registered.length, 3, '应注册 3 个品牌组件')
  for (const r of registered) {
    assert.ok(r.spec.name, '每个注册项都要有 slot 名')
    assert.equal(typeof r.Component, 'function')
  }
})

test('[branding] apply 不得依赖超出 inject 声明的服务', () => {
  const { exports } = loadClient(REPO_ROOT, 'dsh-xyb-branding')
  const declared = new Set(exports.inject || [])
  const touched = new Set()

  const ctx = new Proxy(
    {
      effect: (fn) => {
        const d = fn()
        return typeof d === 'function' ? d : () => {}
      },
      slots: { inject: (_n, fn) => fn(), register: () => () => {} }
    },
    {
      get(target, prop) {
        if (typeof prop === 'string' && prop !== 'effect') touched.add(prop)
        return target[prop]
      }
    }
  )
  exports.apply(ctx)

  for (const svc of touched) {
    assert.ok(
      declared.has(svc),
      `branding 客户端用了 ctx.${svc} 但 inject 里没声明（宿主不注入 → 运行时 undefined）`
    )
  }
})

test('[branding] 三个品牌组件都能真渲染（不白屏）', () => {
  const { react, registered } = mount('dsh-xyb-branding')
  for (const { spec, Component } of registered) {
    const r = react.render(Component, {})
    const text = textOf(r.tree).join(' ').trim()
    assert.ok(
      text.length > 0 || collectProps(r.tree).length > 0,
      `品牌组件 ${spec.name} 渲染为空（界面上会白屏）`
    )
  }
})

// ═══════════════════════════════════════════ 探针自检（防假绿）

test('[自检] 装载器能抓到「客户端插件 apply 抛错」—— 用改坏的源码当探针', () => {
  // 造一份**故意改成会抛错**的 branding 源码：注册到未声明的槽位
  const { source } = loadClient(REPO_ROOT, 'dsh-xyb-branding')
  const broken = source.replace(
    "ctx.slots.inject('sidebar.brand.mark'",
    "ctx.slots.inject('a.slot.that.does.not.exist'"
  )
  assert.notEqual(broken, source, '探针改造应生效（源码里没找到目标片段则测试失效）')

  assert.throws(
    () => mountClient(REPO_ROOT, 'dsh-xyb-branding', { sourceOverride: broken }),
    /kind 未登记|not declared/,
    '装载器必须能发现「注册到未声明槽位」这类错误（否则它是假绿的）'
  )
})
