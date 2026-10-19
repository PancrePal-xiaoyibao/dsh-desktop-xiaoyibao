/**
 * 宿主契约模拟器 —— 用**真实规则**校验插件注册的路由与客户端调用。
 *
 * ── 为什么需要它（真实事故，2026-10-15，三个安装包连崩三次）─────────────
 *   三次崩溃全是同一类：**插件契约违规，语法合法、静态检查看不见、装完就崩**。
 *
 *     ① `export const __internals = { readSettings }` 引用闭包变量
 *        → import 期抛 ReferenceError          → 插件不激活 → 应用打不开
 *     ② `route('/settings','GET')` + `route('/settings','POST')` 各注册一次
 *        → 宿主按 path 作主键，第二次抛 already registered → 同上
 *     ③ `route('/patients/:id', …)` 用了路径参数
 *        → 宿主路径字符集不含冒号，抛 invalid exact Fetch route → 同上
 *
 *   前两个是我用「自己猜的规则」写 mock 抓到的；第三个说明**猜的规则不够**。
 *   本文件改用**从宿主真实源码抄下来的校验**，让 mock 与真宿主等价。
 *
 * ── 权威来源（逐字对齐，非推测）──────────────────────────────────────
 *   包：@deepseek-ai/dsh-client-connection@0.2.0-rc.2
 *   tgz sha256：536ec548c42af452b5f5d518f4ae0f1c0c992d5f183a460544bf3329f7b2e70b
 *   文件：lib/index.js
 *     · L549  `const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;`
 *     · L550  `const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;`
 *     · L711  `function endpointFromPath(channel, pathname) { … }`
 *     · L758  `function assertFetchRoute(route) { … }`
 *     · L625  `registerFetchRoute(owner, route) { … }`
 *     · L608  `createSharedFetchHandler(channel) { … }`
 *
 *   如果宿主升级，这些常量可能变；`test/host-contract/host-rules-pin.test.mjs`
 *   会在升级时提醒复核（把新版本的这些行贴进去做对比）。
 */

// ─────────────────────────────────────────── 宿主常量（逐字抄自 L549-550）

/** 宿主：RPC 频道名模式 */
export const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/

/**
 * 宿主：exact Fetch 路由**每一段**的允许字符。
 *
 * ⚠️ **不含冒号** —— 这就是路径参数（`/patients/:id`）被拒绝的根因。
 * 所以插件里的动态段必须走查询串（`/patient?id=xxx`）或改用字面段。
 */
export const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** 宿主 reserved channel（assertChannel 里显式禁止） */
export const RESERVED_CHANNEL = '/api'

// ─────────────────────────────────────────── 宿主校验逻辑（逐字对齐）

/**
 * 宿主 `endpointFromPath(channel, pathname)`（L711）。
 *
 * @returns {string|undefined} 合法则返回 endpoint（剥掉 channel 前缀），否则 undefined
 */
export function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (
    endpoint
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))
  ) {
    return undefined
  }
  return endpoint
}

/**
 * 宿主 `assertFetchRoute(route)`（L758）。不合法直接抛，抛的文案与宿主逐字一致。
 */
export function assertFetchRoute(route) {
  if (endpointFromPath('/api', route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  if (new Set(route.methods).size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}

/** 宿主 `assertChannel(channel)`（L754） */
export function assertChannel(channel) {
  if (!CHANNEL_PATTERN.test(channel) || channel === RESERVED_CHANNEL) {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

/** 一条路径是否会被宿主接受（供静态检查器给出“为什么不合法”的可读理由） */
export function explainRoutePath(path) {
  if (typeof path !== 'string' || !path) return '路径为空'
  if (!path.startsWith('/api/')) return `路径必须以 /api/ 开头（实际 ${JSON.stringify(path)}）`
  if (endpointFromPath('/api', path) !== undefined) return null
  const endpoint = path.slice('/api/'.length)
  const bad = endpoint
    .split('/')
    .filter((s) => s === '' || s === '.' || s === '..' || !ENDPOINT_SEGMENT_PATTERN.test(s))
  const reasons = bad.map((s) => {
    if (s === '') return '空段（多余的 /）'
    if (s === '.' || s === '..') return `相对段 "${s}"`
    const illegal = [...new Set(s.replace(/[A-Za-z0-9_$.-]/g, ''))]
    return `段 "${s}" 含非法字符 ${illegal.map((c) => JSON.stringify(c)).join(' ')}`
  })
  return reasons.join('；')
}

// ─────────────────────────────────────────── 宿主模拟器

/**
 * 构造一个**行为等价于真宿主**的 Cordis ctx。
 *
 * 与真宿主对齐的点：
 *   · `fetch.register` 先跑 assertFetchRoute（路径/方法校验），再跑重复 path 检查
 *   · 重复 path 的报错文案与宿主逐字一致
 *   · 注册发生在 effect 内（宿主是 `owner.effect(...)`）；本模拟器同步执行 effect
 *   · 提供 createSharedFetchHandler 等价的**请求派发**，可以真发请求验证路由可用
 *
 * @returns {{
 *   ctx: object,
 *   routes: Map<string, {methods: Set<string>, requestBody: string, fetch: Function}>,
 *   logs: Array,
 *   errors: Array,          // 注册期的异常（含被宿主拒绝的路由）
 *   dispatch: (url: string, init?: object) => Promise<Response>
 * }}
 */
export function createHostMock() {
  const routes = new Map()
  const logs = []
  const errors = []
  const effects = []

  const pushLog = (level, args) => logs.push({ level, args })

  const ctx = {
    logger: {
      info: (...a) => pushLog('info', a),
      warn: (...a) => pushLog('warn', a),
      error: (...a) => pushLog('error', a)
    },
    // Cordis 核心方法（不属于服务，不需要 inject）
    //
    // ⚠️ 语义：`effect(fn)` 在 apply 期**立即执行 fn**，fn 的**返回值是 disposer**；
    //    卸载时调用 disposer。这里必须存 disposer 而不是 fn 本身
    //    （实测踩坑：存 fn 会导致 teardown 时把回调又跑一遍，路由永远清不掉）。
    effect: (fn, label) => {
      const disposer = fn()
      effects.push({ disposer, label })
      return disposer
    },
    reflect: { provide: () => {} },
    on: () => () => {},
    connection: {
      fetch: {
        register(route) {
          // ── 与宿主 L625-639 逐条对齐 ──
          assertFetchRoute(route) // 路径合法性 + 方法非空 + 方法不重复
          const registered = {
            methods: new Set(route.methods),
            requestBody: route.requestBody,
            fetch: route.fetch
          }
          if (routes.has(route.path)) {
            throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
          }
          routes.set(route.path, registered)
          // 宿主在 registerFetchRoute 内部用 owner.effect(...) 包住注册，
          // 返回的 disposer 会 delete 路由（L632-638）。因此**注册的副作用
          // 归宿主所有**，插件自己不需要调 ctx.effect —— mock 必须复刻这一点，
          // 否则 teardown 清不掉路由，HMR 重载测试会误判。
          const disposer = () => routes.delete(route.path)
          effects.push({ disposer, label: `fetch route ${route.path}` })
          return disposer
        }
      }
    }
  }

  /**
   * 请求派发 —— 对齐宿主 createSharedFetchHandler（L608-624）。
   *
   * 语义：**先按完整 pathname 精确查表**；命中且方法在集合内才执行 handler，
   * 否则 404（宿主原文 `new Response('not found', { status: 404 })`）。
   *
   * 这条语义很重要：它证明「路由注册成功了」不等于「请求能到达」——
   * 路径写错一个字符就是 404，而插件不会因此崩溃。所以必须直接发请求测。
   */
  const dispatch = async (url, init = {}) => {
    const request = new Request(url.startsWith('http') ? url : `http://127.0.0.1${url}`, init)
    const pathname = new URL(request.url).pathname
    const route = routes.get(pathname)
    if (route && route.methods.has(request.method)) return route.fetch(request)
    return new Response('not found', { status: 404 })
  }

  return { ctx, routes, logs, errors, dispatch, effects }
}

/**
 * 加载插件入口并用宿主模拟器跑一遍 apply()。
 *
 * 返回的 `registerError` 就是**真宿主会抛的那个错**（如果有）。
 * 用它做断言：任何插件在任何配置下都不应该让 registerError 非空。
 *
 * @param {string} entryUrl  插件 index.js 的 file:// URL 或绝对路径
 * @param {object} config    插件配置（模拟 cordis.patch.yml 注入）
 * @returns {Promise<{mod: object, mock: object, registerError: Error|null}>}
 */
export async function bootPlugin(entryUrl, config = {}) {
  const mod = await import(entryUrl)
  const mock = createHostMock()
  let registerError = null
  try {
    await mod.apply(mock.ctx, config)
  } catch (error) {
    registerError = error
    mock.errors.push(error)
  }
  return { mod, mock, registerError }
}

/**
 * 把 `ctx.effect` 里注册的清理函数都跑一遍（模拟插件卸载 / HMR 重载）。
 *
 * 用途：验证插件**可以安全卸载再装载**（宿主热重载、profile 切换都会走到）。
 * 若不幂等，重载就会抛 already registered —— 与首装崩溃同样致命。
 */
export function teardown(mock) {
  // 逆序执行（Cordis 卸载语义）
  for (const { disposer } of [...mock.effects].reverse()) {
    if (typeof disposer === 'function') disposer()
  }
}
