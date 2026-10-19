/**
 * 客户端沙箱 —— 真实加载 `client.js` 所需的全套测试基础设施（单一真源）。
 *
 * ── 为什么单独抽一个文件 ─────────────────────────────────────────────
 *   两个测试套件都要用同一套基础设施：
 *     · `test/runtime/client-mount.test.mjs`   渲染与端到端
 *     · `test/runtime/slot-contract.test.mjs`  槽位契约（第四次崩溃）
 *   复制两份必然会漂移 —— 而「替身不保真」正是第四次崩溃的病根。
 *   所以基础设施只存一处（同 AGENTS.md §5.4.4 的单一真源纪律）。
 *
 * ── 关键设计：替身必须认识宿主的真实规则 ────────────────────────────
 *   第四次崩溃（2026-10-16）：
 *     服务端已 `Harness is ready`，但 renderer 报
 *       single slot "sidebar.brand.mark" already has a registration at priority 0
 *     → 客户端插件全部加载失败。
 *
 *   旧版假替身的 `slots.register` 只是 `push` 到数组，**任何冲突都不报** ——
 *   于是「测试全绿」而真机崩溃。现在 `createSlotRegistry()` 按宿主真实规则抛错。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  HOST_OCCUPANT_SOURCE,
  HOST_OCCUPIED_SLOTS,
  SLOT_KINDS,
  createSlotRegistry
} from './slot-contract-rules.mjs'

// ═══════════════════════════════════════════ mini-React（对齐 React 18.3.1）

export function createMiniReact() {
  let current = null
  const instances = new Map()
  let pendingEffects = []
  let pendingLayout = []

  const getInstance = (Component) => {
    let inst = instances.get(Component)
    if (!inst) {
      inst = { state: {}, memo: {}, effectMemo: {} }
      instances.set(Component, inst)
    }
    return inst
  }

  const depsEqual = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  /**
   * 登记副作用。**必须做依赖比较** —— React 语义是「依赖没变就不重跑」。
   *
   * ⚠️ 不做比较的后果（实测踩坑）：每次渲染都重跑 effect → `useEffect(load, [load])`
   *    每次渲染都把 status 重置回 loading → 界面永远停在加载态，看起来像产品 bug。
   */
  const registerEffect = (bucket, fn, deps) => {
    const inst = current
    const idx = inst.cursor++
    const prev = inst.effectMemo[idx]
    const changed = !prev || !deps || !prev.deps || !depsEqual(prev.deps, deps)
    inst.effectMemo[idx] = { deps }
    if (changed) bucket.push({ fn, deps })
  }

  const createElement = (type, props, ...children) => ({
    $$element: true,
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true)
  })

  const api = {
    createElement,
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const inst = current
      const idx = inst.cursor++
      if (!(idx in inst.state)) inst.state[idx] = typeof initial === 'function' ? initial() : initial
      return [
        inst.state[idx],
        (next) => {
          inst.state[idx] = typeof next === 'function' ? next(inst.state[idx]) : next
        }
      ]
    },
    useEffect: (fn, deps) => registerEffect(pendingEffects, fn, deps),
    useLayoutEffect: (fn, deps) => registerEffect(pendingLayout, fn, deps),
    useCallback(fn, deps) {
      const inst = current
      const idx = inst.cursor++
      const prev = inst.memo[idx]
      if (prev && deps && prev.deps && depsEqual(prev.deps, deps)) return prev.fn
      inst.memo[idx] = { fn, deps }
      return fn
    },
    useMemo(fn, deps) {
      const inst = current
      const idx = inst.cursor++
      const prev = inst.memo[`m${idx}`]
      if (prev && deps && prev.deps && depsEqual(prev.deps, deps)) return prev.value
      const value = fn()
      inst.memo[`m${idx}`] = { value, deps }
      return value
    },
    useRef: (v) => ({ current: v }),
    memo: (c) => c,
    isValidElement: (x) => Boolean(x && x.$$element)
  }

  /**
   * **递归展开函数型组件** —— 这是 React 真正做的事。
   *
   * ⚠️ 不做展开的后果（实测踩坑）：`h(Board, …)` 这类子组件永远不会被调用，
   *    测试只看到外层容器文本，断言的是假象。
   */
  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expand)

    if (node.$$element) {
      const { type, props } = node
      if (typeof type === 'function') {
        const inst = getInstance(type)
        const prev = current
        current = inst
        inst.cursor = 0
        let out
        try {
          out = type({ ...props, children: node.children.length ? node.children : props.children })
        } finally {
          current = prev
        }
        return expand(out)
      }
      return { ...node, children: expand(node.children) }
    }
    return node
  }

  return {
    api,
    /** 渲染一次：展开组件树 + 跑 layoutEffects；返回待执行的普通 effects */
    render(Component, props) {
      pendingEffects = []
      pendingLayout = []
      const tree = expand(createElement(Component, props))
      for (const e of pendingLayout) e.fn()
      return { tree, effects: pendingEffects }
    }
  }
}

// ═══════════════════════════════════════════ 浏览器替身

export function createMiniDocument() {
  const head = { children: [] }
  return {
    document: {
      getElementById: (id) => head.children.find((c) => c.id === id),
      createElement: () => ({ id: null, textContent: '' }),
      head: { appendChild: (node) => head.children.push(node) }
    },
    head
  }
}

// ═══════════════════════════════════════════ 元素树工具

/** 元素树 → 纯文本（用于断言界面内容） */
export function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (node.$$element) {
    textOf(node.props.children, out)
    if (node.children !== node.props.children) textOf(node.children, out)
  }
  return out
}

/** 收集所有元素的 {type, props}（用于断言结构与交互回调） */
export function collectProps(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) collectProps(n, out)
    return out
  }
  if (node.$$element) {
    out.push({ type: node.type, props: node.props })
    collectProps(node.children, out)
  }
  return out
}

// ═══════════════════════════════════════════ 等待（条件驱动）

/**
 * 等待条件成立（**条件驱动 + 超时**），而不是固定 tick 数。
 *
 * ⚠️ 为什么不能用固定 tick（实测踩坑）：服务端 handler 里有真实文件 IO，
 *    完成时间随磁盘与事件循环浮动 → 固定轮数会时对时错（flaky）。
 */
export async function waitUntil(probe, opts = {}) {
  const { timeoutMs = 8000, intervalMs = 10, label = '条件', diagnose } = opts
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      if (await probe()) return true
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  const extra = diagnose ? `\n  诊断：${diagnose()}` : ''
  const err = lastError ? `\n  最后一次探测异常：${lastError.message}` : ''
  throw new Error(`等待超时（${timeoutMs}ms）：${label}${extra}${err}`)
}

/**
 * 反复「渲染 + 跑 effect」直到界面满足条件（等 React 收敛的通用做法）。
 *
 * ⚠️ 每次渲染后都要 effect 跑完 —— `useEffect` 有依赖比较，
 *    只渲染不跑 effect 会导致下一次渲染**不再登记** effect → 请求发不出去。
 */
export async function renderUntil(react, Component, props, predicate, opts = {}) {
  const { label = '界面条件', timeoutMs = 8000 } = opts
  let last = null
  await waitUntil(
    async () => {
      const rendered = react.render(Component, props)
      for (const e of rendered.effects) e.fn()
      last = { tree: rendered.tree, text: textOf(rendered.tree).join(' ') }
      await new Promise((r) => setTimeout(r, 10))
      return predicate(last.text, rendered) === true
    },
    {
      label,
      timeoutMs,
      diagnose: () => (last ? `最近渲染文本=${JSON.stringify(last.text.slice(0, 200))}` : '从未渲染成功')
    }
  )
  return last
}

// ═══════════════════════════════════════════ 加载 client.js

/**
 * 真实加载 `client.js`：注入 `__ModuleLoader__` 捕获注册，再用 `factory(require)` 真跑一遍。
 *
 * @param {string} repoRoot 仓库根
 * @param {string} name     包名
 * @param {{sourceOverride?: string, extraRequires?: Record<string, unknown>}} [opts]
 *   `sourceOverride` 用于探针测试（喂一份**改坏**的源码，验证测试真能抓到）
 * @returns {{entry: object, exports: object, react: object, head: Array, source: string}}
 */
export function loadClient(repoRoot, name, opts = {}) {
  const source =
    opts.sourceOverride ?? readFileSync(join(repoRoot, 'packages', name, 'client.js'), 'utf8')
  const captured = []
  const { document, head } = createMiniDocument()

  // client.js 是给浏览器跑的，不能直接 import → 用 Function 构造沙箱执行
  // windowExtra 用于注入额外全局（如 localStorage）——默认入口的「只做一次」标记需要它
  const runner = new Function('window', 'document', 'console', source)
  runner({ ...(opts.windowExtra || {}), __ModuleLoader__: { load: (e) => captured.push(e) } }, document, console)

  if (captured.length !== 1) {
    throw new Error(`${name}/client.js 应恰好调用一次 __ModuleLoader__.load（实际 ${captured.length}）`)
  }
  const entry = captured[0]
  if (entry.id !== name) {
    throw new Error(`ModuleLoader 的 id 必须是包名（期望 ${name}，实际 ${entry.id}）`)
  }
  if (typeof entry.factory !== 'function') {
    throw new Error(`${name}/client.js 的 load 缺少 factory`)
  }

  const react = createMiniReact()
  const requireImpl = (spec) => {
    if (spec === 'react') return react.api
    if (opts.extraRequires && spec in opts.extraRequires) return opts.extraRequires[spec]
    throw new Error(`${name}/client.js 请求了宿主未提供的依赖：${spec}`)
  }
  const exports = entry.factory(requireImpl)

  return { entry, exports, react, head, source }
}

// ═══════════════════════════════════════════ fetch → 真实服务端路由

/**
 * 造一个 fetch 实现，直接打到**真实服务端路由表**上（宿主语义：精确 pathname + 方法在集合内）。
 */
export function makeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url, 'http://127.0.0.1')
    const method = (init.method || 'GET').toUpperCase()
    calls.push({ path: u.pathname, method, search: u.search })

    const route = routes.get(u.pathname)
    if (!route || !route.methods.has(method)) {
      return new Response('not found', { status: 404 })
    }
    return route.fetch(new Request(u, init))
  }
  return { fetchImpl, calls }
}

// ═══════════════════════════════════════════ 槽位：宿主占据情况

// 宿主占据情况由契约真源提供（见 slot-contract-rules.mjs）。
// 这里 re-export 是为了调用方一处导入，避免两处各定义一份而漂移。
//
// ⚠️ `export { X as Y }` 只创建**导出名**，不会在模块内建出本地名 `Y`。
//    （实测踩坑：模块内继续用 Y 会 ReferenceError: Y is not defined。）
//    所以要显式建一个本地别名给下面的代码用。
export { HOST_OCCUPIED_SLOTS as HOST_OCCUPANTS, HOST_OCCUPANT_SOURCE }
const HOST_OCCUPANTS = HOST_OCCUPIED_SLOTS

/**
 * 从 `client.js` 源码里抽出它用到的全部槽位名。
 *
 * 两种写法都要抓：
 *   · `slots.register({ name: 'x' }, …)`  → 实际占据
 *   · `slots.inject('x', …)`             → 可能间接注册
 */
export function collectUsedSlots(source) {
  const out = new Set()
  for (const m of source.matchAll(/slots\.register\(\s*\{[^}]*?name:\s*'([^']+)'/gs)) out.add(m[1])
  for (const m of source.matchAll(/slots\.inject\(\s*'([^']+)'/g)) out.add(m[1])
  return [...out]
}

// ═══════════════════════════════════════════ 装载客户端插件

/**
 * 装载一个客户端插件，`ctx.slots` 用**真规则替身**，并预置宿主占据者。
 *
 * @returns {{exports, react, registered, injected, slotRegistry, source}}
 */
export function mountClient(repoRoot, name, opts = {}) {
  const { exports, react, source } = loadClient(repoRoot, name, opts)
  const registered = []
  const injected = []
  const baseCtx = {
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    }
  }

  // 真规则槽位表：先按宿主声明 declare，再把宿主已占的槽位填上
  const slots = createSlotRegistry()
  for (const slot of collectUsedSlots(source)) {
    const kind = SLOT_KINDS[slot]
    if (!kind) {
      throw new Error(
        `槽位 ${slot} 的 kind 未登记（scripts/lib/slot-kinds.json）—— ` +
          `不能猜（第四次崩溃的教训），请先补齐 kind 表`
      )
    }
    slots.declare(slot, kind, 'dsh-desktop-host')
    for (const occupant of HOST_OCCUPANTS[slot] ?? []) {
      slots.register({ name: slot, ...occupant }, () => null)
    }
  }

  const facade = {
    // 宿主语义：inject(slot, cb) 在槽位可声明时调用 cb
    inject: (slot, fn) => {
      injected.push(slot)
      fn()
    },
    register: (spec, Component) => {
      registered.push({ spec, Component })
      return slots.register(spec, Component)
    },
    entries: (slot) => slots.entries(slot),
    rendering: (slot) => slots.rendering(slot)
  }
  const desktopWorkbenches = {
    register: (spec, Component) => registered.push({ spec, Component })
  }

  exports.apply({ ...baseCtx, slots: facade, desktopWorkbenches, ...opts.ctxExtra })
  return { exports, react, registered, injected, slotRegistry: slots, source }
}
