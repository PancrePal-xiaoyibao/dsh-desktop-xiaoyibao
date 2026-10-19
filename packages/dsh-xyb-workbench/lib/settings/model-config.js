/**
 * 模型与 API Key 配置 —— 宿主 seam 的只读 / 只写代理。
 *
 * **为什么本插件不自己存一份 Key**
 * 宿主已经是模型与密钥的唯一真源：`@deepseek-ai/dsh-settings` 的 `llm-*` 命名空间
 * 描述「有哪些提供方、每个提供方的 API Key 引用名是什么」，`@deepseek-ai/dsh-credentials`
 * 保存真正的密钥值。工作台再存一份必然互相覆盖 —— 旧版设置页只能写一句
 * 「由宿主运行时管理」，用户因此根本找不到入口（实测反馈的缺口）。
 *
 * **溯源（A1：外部契约逐字抄自对方真实实现，不凭印象）**
 * - 凭据引用语法 = POSIX shell identifier（`isCredentialRefName`），见
 *   `@deepseek-ai/dsh-credentials@0.2.0-rc.2` `lib/types/index.d.ts`。
 * - 引用名派生 `deriveKeyRef`：逐字抄自
 *   `@deepseek-ai/dsh-client-ui-settings-models@0.2.0-rc.2` `lib/client.js:1247-1249`：
 *     provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
 * - seam 方法签名：`ctx.settings.describe()`、`ctx.credentials.describe(ref)` /
 *   `.set(ref, value)` / `.unset(ref)`、`ctx.llm.listConfigurableProviders()`。
 *   对应 `dsh-settings` / `dsh-credentials` / `dsh-llm` 的 `index.d.ts`。
 *
 * **本模块的安全边界**
 * 1. 读：只回「配置了没有 + 来自哪一层」，**永不回传密钥值**（宿主 describe 本身也不回）。
 * 2. 写：只接受 `{ ref, value }`；value 只向上游写，不落盘、不进日志、不进响应。
 * 3. 缺 seam 时返回 `available:false` 并说明原因 —— 不编造、不假装「已配置」。
 */

/** 凭据引用名：大写字母 / 数字 / 下划线，且不以数字开头（POSIX shell identifier）。 */
export const CREDENTIAL_REF_PATTERN = /^[A-Z_][A-Z0-9_]*$/

/** 单个密钥值的上限（防把整份配置粘进来把内存与请求体撑爆）。 */
export const MAX_SECRET_BYTES = 4096

/** 取值失败的统一错误：带 code，交给路由层映射 HTTP 状态。 */
export function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 从 provider 路由 id 派生凭据引用名（逐字对应宿主实现）。
 *
 * @param {string} provider provider 路由 id（如 `deepseek-official`、`minimax-cn`）
 * @returns {string} 派生出的引用名（如 `MINIMAX_CN_API_KEY`）
 */
export function deriveKeyRef(provider) {
  return `${String(provider || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * 读可选的宿主服务。
 *
 * **为什么不能直接 `ctx.settings`**：cordis 的上下文代理对**未在 inject 里声明**的服务
 * 直接抛 `cannot get property "x" without inject`（源码 `cordis/src/reflect.ts` get 陷阱）。
 * 而本插件不能把这些服务写进 `inject`：cordis 的 inject 没有「可选」语义 ——
 * 某个服务永远不出现，插件就**永远不会激活**（工作台整个不显示，比缺功能更糟）。
 *
 * 正确做法：走 `ctx.reflect.get(name, false)` ——
 * 该方法**绕过 inject 要求**读服务，未提供时返回 undefined（同上源码 `ReflectService.get`）。
 * 拿不到就明确降级，绝不假装「已配置」。
 *
 * @param {object} ctx cordis 上下文
 * @param {string} name 服务名（`settings` / `credentials` / `llm`）
 * @returns {object|null} 服务实例或 null
 */
export function optionalService(ctx, name) {
  try {
    const reflect = ctx && ctx.reflect
    if (reflect && typeof reflect.get === 'function') {
      const value = reflect.get(name, false)
      return value && typeof value === 'object' ? value : null
    }
    // 测试替身 / 非 cordis 宿主：服务就是普通属性
    const value = ctx ? ctx[name] : null
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** 读路径（`['a','b']` → `value.a.b`），路径不存在回 undefined。 */
function atPath(value, path) {
  let cursor = value
  for (const key of path || []) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[key]
  }
  return cursor
}

/**
 * 从配置值里读 `apiKeyEnv`（凭据引用名）。
 *
 * 为什么要兼容对象：该字段在 schema 里是 `Volatile<string>`（见
 * `@deepseek-ai/dsh-llm-deepseek-api-key/lib/types/config.d.ts`：
 * “Credential reference resolved per request; defaults to DEEPSEEK_API_KEY”）。
 * 正常 `describe()` 已经把它展开成普通值，但万一拿到的是 Volatile 对象，
 * 必须按 `.get()` 取 —— 取错会得到一个**不同名字**的引用（用户填了 Key 也没用）。
 */
function readApiKeyEnv(value) {
  const raw = value && typeof value === 'object' ? value.apiKeyEnv : undefined
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (raw && typeof raw.get === 'function') {
    try {
      const unwrapped = raw.get()
      if (typeof unwrapped === 'string' && unwrapped.trim()) return unwrapped.trim()
    } catch {
      /* 取不到就当没有：交给派生规则 */
    }
  }
  return ''
}

/** 只保留 `llm-*` 命名空间（模型相关），其它业务命名空间不归本页管。 */
function llmNamespaces(settings) {
  if (!settings || typeof settings.describe !== 'function') return []
  let described = []
  try {
    described = settings.describe() || []
  } catch {
    return []
  }
  if (!Array.isArray(described)) return []
  return described
    .map((entry) => ({
      ns: String(entry?.ns ?? entry?.id ?? ''),
      value: entry?.value ?? null,
      secrets: Array.isArray(entry?.secrets) ? entry.secrets : []
    }))
    .filter((entry) => entry.ns.startsWith('llm-'))
}

/**
 * 列出提供方。优先用宿主集中登记的目录；目录缺失时退回「按命名空间里的
 * `apiKeyEnv` 反推」——两条路都只产出**真实存在**的项，不做猜测补全。
 */
function llmProviders(llm, namespaces) {
  const rows = []
  const push = (row) => {
    const provider = String(row?.provider ?? row?.id ?? '').trim()
    if (!provider) return
    if (rows.some((item) => item.provider === provider)) return
    rows.push({
      provider,
      displayName: String(row?.displayName ?? row?.name ?? provider),
      settingsNs: String(row?.settingsNs ?? ''),
      settingsPath: Array.isArray(row?.settingsPath) ? row.settingsPath.map(String) : []
    })
  }

  // **两份目录取并集**：宿主自己的提供方在 `listProviders()`，用户在配置里新增的
  // 在 `listConfigurableProviders()`。只读其中一份就会「有些提供方永远不显示」。
  if (llm && typeof llm.listProviders === 'function') {
    try {
      for (const row of llm.listProviders() || []) push(row)
    } catch {
      /* 目录读失败：继续尝试另一份 */
    }
  }
  if (llm && typeof llm.listConfigurableProviders === 'function') {
    try {
      for (const row of llm.listConfigurableProviders() || []) push(row)
    } catch {
      /* 同上 */
    }
  }
  if (rows.length === 0) {
    for (const entry of namespaces) {
      const env = readApiKeyEnv(entry.value)
      const provider = String(atPath(entry.value, ['provider']) ?? entry.ns.replace(/^llm-/, ''))
      if (env) push({ provider, displayName: provider, settingsNs: entry.ns })
    }
  }
  return rows
}

/** 单个引用名的状态；describe 失败不回假值，而是标 `error`。 */
async function describeRef(credentials, ref) {
  try {
    const info = await credentials.describe(ref)
    return {
      configured: info?.configured === true,
      source: typeof info?.source === 'string' ? info.source : null,
      writable: info?.writable !== false,
      error: null
    }
  } catch (error) {
    return { configured: false, source: null, writable: false, error: error?.message || '凭据服务读取失败' }
  }
}

/**
 * 当前「右侧 AI 栏」使用的模型（宿主的 agent 默认模型选择）。
 * 服务缺失 / 未设置时返回 null，不猜。
 *
 * @param {object} ctx cordis 上下文
 * @returns {{provider: string, model: string, reasoningEffort: string|null}|null}
 */
export function readSelection(ctx) {
  const agentDefaultModel = optionalService(ctx, 'agentDefaultModel')
  if (!agentDefaultModel || typeof agentDefaultModel.currentSelection !== 'function') return null
  try {
    const selection = agentDefaultModel.currentSelection()
    if (!selection || typeof selection !== 'object') return null
    const provider = typeof selection.provider === 'string' ? selection.provider : ''
    const model = typeof selection.model === 'string' ? selection.model : ''
    if (!provider || !model) return null
    return { provider, model, reasoningEffort: selection.reasoningEffort ?? null }
  } catch {
    return null
  }
}

/**
 * 汇总「模型提供方 + API Key 状态」。
 *
 * @param {object} ctx cordis 上下文
 * @returns {Promise<{
 *   available: boolean,
 *   reason: string|null,
 *   credentialSeam: boolean,
 *   settingsSeam: boolean,
 *   writable: boolean,
 *   providers: Array<object>,
 *   namespaces: Array<{ns: string, secrets: Array<{path: string[], set: boolean}>}>,
 *   notes: string[]
 * }>}
 */
export async function readModelConfig(ctx) {
  const credentials = optionalService(ctx, 'credentials')
  const settings = optionalService(ctx, 'settings')
  const llm = optionalService(ctx, 'llm')

  // 命名空间只读一次：提供方的 apiKeyEnv 要从同一份快照里取，分两次读会不一致
  const namespaceViews = llmNamespaces(settings)
  const namespaces = namespaceViews.map((entry) => ({
    ns: entry.ns,
    secrets: entry.secrets.map((secret) => ({ path: Array.isArray(secret?.path) ? secret.path.map(String) : [], set: secret?.set === true }))
  }))

  if (!credentials || typeof credentials.describe !== 'function') {
    return {
      available: false,
      reason: '宿主没有提供凭据服务（ctx.credentials），本机无法读取或保存 API Key。可改为在宿主设置面板里配置。',
      credentialSeam: false,
      settingsSeam: Boolean(settings && typeof settings.describe === 'function'),
      writable: false,
      providers: [],
      namespaces,
      notes: []
    }
  }

  const writable = Boolean(settings && settings.writable !== false)
  const selection = readSelection(ctx)
  const providers = []
  for (const row of llmProviders(llm, namespaceViews)) {
    const entry = namespaceViews.find((item) => item.ns === row.settingsNs)
    const namespaceValue = entry ? (row.settingsPath.length ? atPath(entry.value, row.settingsPath) : entry.value) : undefined
    const declaredRef = readApiKeyEnv(namespaceValue)
    const keyRef = declaredRef || deriveKeyRef(row.provider)
    if (!CREDENTIAL_REF_PATTERN.test(keyRef)) continue // 不合法的引用名不进界面（写入侧还会再校验一次）
    const state = await describeRef(credentials, keyRef)
    providers.push({
      provider: row.provider,
      displayName: row.displayName,
      settingsNs: row.settingsNs,
      keyRef,
      refFromConfig: Boolean(declaredRef),
      // 服务地址与协议：宿主自己的提供方写在自己的命名空间里；用户自定义的走 llm-pi-ai 路由档案
      baseURL: typeof namespaceValue?.baseURL === 'string' ? namespaceValue.baseURL : '',
      protocol: typeof namespaceValue?.api === 'string' && namespaceValue.api ? namespaceValue.api : 'openai-completions',
      custom: row.settingsNs === 'llm-pi-ai',
      configured: state.configured,
      source: state.source,
      writable: state.writable,
      error: state.error
    })
  }

  const notes = []
  if (providers.length === 0) {
    notes.push('宿主没有登记任何可配置的模型提供方：请先在宿主设置里添加提供方，这里才会出现对应的 API Key 输入框。')
  }
  notes.push('保存后写入宿主凭据存储（与宿主设置面板是同一份），本工作台不留副本。')

  return {
    available: true,
    reason: null,
    credentialSeam: true,
    settingsSeam: Boolean(settings && typeof settings.describe === 'function'),
    writable,
    providers,
    namespaces,
    selection,
    notes
  }
}

/**
 * 归一化一次密钥写入请求。
 *
 * @param {unknown} payload 请求体
 * @returns {{ref: string, value: string}}
 * @throws 带 code 的错误（INVALID_INPUT / SIZE_EXCEEDED）
 */
export function parseCredentialRequest(payload) {
  const ref = typeof payload?.ref === 'string' ? payload.ref.trim() : ''
  if (!CREDENTIAL_REF_PATTERN.test(ref)) {
    throw codedError('INVALID_INPUT', '凭据名不合法（应为大写字母 / 数字 / 下划线，且不以数字开头）')
  }
  const raw = payload?.value
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw codedError('INVALID_INPUT', '密钥值必须是字符串')
  }
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value.length > MAX_SECRET_BYTES) throw codedError('SIZE_EXCEEDED', '密钥值过长')
  if (/[\r\n]/.test(value)) throw codedError('INVALID_INPUT', '密钥值不能包含换行')
  return { ref, value }
}

/**
 * 写入或清除一个 API Key。空字符串表示清除。
 *
 * @param {object} ctx cordis 上下文
 * @param {{ref?: unknown, value?: unknown}} payload 请求体
 * @returns {Promise<{ref: string, cleared: boolean, configured: boolean, source: string|null, writable: boolean}>}
 */
export async function writeModelCredential(ctx, payload) {
  const credentials = optionalService(ctx, 'credentials')
  if (!credentials || typeof credentials.set !== 'function' || typeof credentials.unset !== 'function') {
    throw codedError('SEAM_UNAVAILABLE', '宿主没有提供凭据服务，无法保存 API Key')
  }
  const { ref, value } = parseCredentialRequest(payload)
  if (value) await credentials.set(ref, value)
  else await credentials.unset(ref)
  const state = await describeRef(credentials, ref)
  if (state.error) throw codedError('CREDENTIAL_WRITE_FAILED', state.error)
  return { ref, cleared: !value, configured: state.configured, source: state.source, writable: state.writable }
}
