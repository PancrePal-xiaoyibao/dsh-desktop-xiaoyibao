/**
 * 模型探测 / 自定义提供方 / 「右侧 AI 栏用哪个模型」。
 *
 * **探测规则全部来自宿主真实实现**（A1：不凭印象写外部契约）：
 * - 清单地址：`@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2` `lib/index.js:2191-2204` `listingUrl()`
 *   · OpenAI 系：`{baseURL}/models`
 *   · Anthropic：根路径（去掉末尾 `/` 与一段 `/v1`）+ `/v1/models?limit=1000`
 * - 认证头：同文件 `2319-2336`：Anthropic 用 `anthropic-version` + `x-api-key`（版本 `2023-06-01`），
 *   其它可列协议用 `authorization: Bearer <key>`。
 * - 可列协议白名单：同文件 `2164-2168` `LISTABLE_PROTOCOLS`。
 * - 自定义提供方的配置形态：`@deepseek-ai/dsh-client-ui-settings-models@0.2.0-rc.2`
 *   `lib/client.js:1567-1583`（写 `llm-pi-ai` 的 `providers.<route>`，
 *   字段 `{ displayName?, apiKeyEnv, api, baseURL, models }`），路由 id 规则见 `1505`。
 * - 「右侧 AI 栏用哪个模型」：`@deepseek-ai/dsh-agent-default-model` 的
 *   `ctx.agentDefaultModel.currentSelection()` / `.saveSelection()`。
 *
 * **产品约束（主人明确要求）**：模型菜单只展示**探测返回 200** 的模型；
 * 没有 Key / 请求失败 / 响应不可解析时一律不展示模型，并给出人能读懂的原因。
 */

import { CREDENTIAL_REF_PATTERN, codedError, deriveKeyRef, optionalService, readModelConfig } from './model-config.js'

/**
 * 提供方路由 id 的合法形态 —— 逐字抄自宿主 UI（`dsh-client-ui-settings-models`
 * `lib/client.js:1505`：`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`）。
 * 这个 id 同时是设置字典的键，也是凭据引用名的词干（`deriveKeyRef`）。
 */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * 可列模型的协议 —— 抄自 pi-ai `lib/index.js:2164`。
 * 其它协议没有可读清单：界面上必须让用户手填，不能假装能探测。
 */
export const LISTABLE_PROTOCOLS = ['anthropic-messages', 'openai-completions', 'openai-responses']

/** Anthropic 版本头，抄自 pi-ai `ANTHROPIC_VERSION`（`lib/index.js:2170`）。 */
const ANTHROPIC_VERSION = '2023-06-01'

/** 模型清单响应体上限：与 pi-ai `MAX_RESPONSE_BYTES` 一致（4 MiB）。 */
const MAX_LISTING_BYTES = 4 * 1024 * 1024

/**
 * 模型清单地址（逐字对应 pi-ai `listingUrl()`）。
 *
 * @param {string} baseURL 服务地址（如 `https://api.openai.com/v1`）
 * @param {string} api 协议 id
 * @returns {string} 清单地址
 */
export function listingUrl(baseURL, api) {
  const base = String(baseURL || '').replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  return `${base.endsWith('/v1') ? base.slice(0, -3) : base}/v1/models?limit=1000`
}

/**
 * 解析模型清单：优先 `data` 数组，其次 `models` 字典（键即请求用的 id），
 * 再其次 `models` 数组。缺 id 的行跳过，而不是整包失败（与 pi-ai 一致）。
 *
 * @param {string} text 响应体
 * @returns {Array<{id: string, name: string}>}
 */
export function parseModelListing(text) {
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    throw codedError('LISTING_UNREADABLE', '模型清单不是合法 JSON')
  }
  const rows = []
  const push = (id, name) => {
    const modelId = typeof id === 'string' ? id.trim() : ''
    if (!modelId) return
    rows.push({ id: modelId, name: typeof name === 'string' && name.trim() ? name.trim() : modelId })
  }
  if (payload && Array.isArray(payload.data)) {
    for (const item of payload.data) if (item && typeof item === 'object') push(item.id, item.name ?? item.display_name)
  } else if (payload && payload.models && typeof payload.models === 'object' && !Array.isArray(payload.models)) {
    for (const [key, value] of Object.entries(payload.models)) {
      if (!value || typeof value !== 'object') continue
      push(key || value.id, value.name ?? value.display_name)
    }
  } else if (payload && Array.isArray(payload.models)) {
    for (const item of payload.models) if (item && typeof item === 'object') push(item.id, item.name ?? item.display_name)
  }
  return rows
}

/** 读有限长度的响应体：超限即拒绝（不无限读）。 */
async function readBoundedText(response) {
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_LISTING_BYTES) {
    await response.body?.cancel()
    throw codedError('LISTING_TOO_LARGE', '模型清单响应体过大')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_LISTING_BYTES) throw codedError('LISTING_TOO_LARGE', '模型清单响应体过大')
  return text
}

/** 在已登记的提供方里定位一个路由（含 baseURL / 协议 / 凭据名）。 */
async function resolveProvider(ctx, providerId) {
  const wanted = String(providerId || '').trim()
  if (!wanted) throw codedError('INVALID_INPUT', '必须指定提供方')
  const config = await readModelConfig(ctx)
  if (config.available !== true) throw codedError('SEAM_UNAVAILABLE', config.reason || '宿主没有提供凭据服务')
  const row = config.providers.find((item) => item.provider === wanted)
  if (!row) throw codedError('PROVIDER_UNKNOWN', `宿主没有登记提供方「${wanted}」`)
  return row
}

/** 解析凭据当前值（只在探测这一瞬间用，不缓存、不回传、不落盘）。 */
async function resolveCredentialValue(ctx, ref) {
  const credentials = optionalService(ctx, 'credentials')
  if (!credentials || typeof credentials.resolve !== 'function') return null
  try {
    const resolved = await credentials.resolve(ref)
    return resolved && typeof resolved.value === 'string' && resolved.value ? resolved.value : null
  } catch {
    return null
  }
}

/**
 * 探测一个提供方当前可用（HTTP 200）的模型。
 *
 * @param {object} ctx cordis 上下文
 * @param {{provider?: unknown, timeoutMs?: unknown}} query 查询参数
 * @returns {Promise<object>} { available, reason, message, models: [{id,name,provider,providerName}] }
 */
export async function probeProviderModels(ctx, query) {
  const row = await resolveProvider(ctx, query?.provider)
  const providerName = row.displayName || row.provider
  const blocked = (reason, message, extra = {}) => ({
    available: false,
    reason,
    message,
    provider: row.provider,
    providerName,
    models: [],
    ...extra
  })

  if (!row.configured) return blocked('KEY_MISSING', '这个提供方还没填 API Key —— 先在上面填好 Key 并保存，再刷新模型列表。')
  if (!LISTABLE_PROTOCOLS.includes(row.protocol)) {
    return blocked('LISTING_UNSUPPORTED', `协议「${row.protocol}」没有可读的模型清单，请手填模型名。`)
  }
  const baseURL = String(row.baseURL || '').trim()
  if (!baseURL) return blocked('BASEURL_MISSING', '这个提供方没有配置服务地址（baseURL），无法探测模型。')
  const apiKey = await resolveCredentialValue(ctx, row.keyRef)
  if (!apiKey) return blocked('KEY_UNREADABLE', '读不到这个提供方的 Key，无法探测模型。')

  const url = listingUrl(baseURL, row.protocol)
  const timeoutMs = Math.min(30000, Math.max(3000, Number(query?.timeoutMs) || 12000))
  const headers = { accept: 'application/json' }
  if (row.protocol === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    headers['x-api-key'] = apiKey
  } else {
    headers.authorization = `Bearer ${apiKey}`
  }

  let response = null
  try {
    response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return blocked(
      timedOut ? 'TIMEOUT' : 'UNREACHABLE',
      timedOut ? `请求超时（${timeoutMs}ms）：${url}` : `连不上 ${url}（检查地址与网络）`,
      { url }
    )
  }

  // **只有 200 才展示**：非 2xx 一律不返回任何模型名（避免展示用不了的模型）
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? '（Key 可能无效或权限不足）' : ''
    return blocked('HTTP_ERROR', `${url} 返回 ${response.status}${hint}，因此不展示任何模型。`, { url, httpStatus: response.status })
  }

  let models = []
  try {
    models = parseModelListing(await readBoundedText(response))
  } catch (error) {
    return blocked(error?.code || 'LISTING_UNREADABLE', error?.message || '模型清单无法解析', { url })
  }

  return {
    available: true,
    reason: null,
    message: null,
    httpStatus: response.status,
    provider: row.provider,
    providerName,
    url,
    models: models.map((model) => ({ ...model, provider: row.provider, providerName })),
    fetchedAt: new Date().toISOString()
  }
}

/** 读 llm-pi-ai 命名空间的 providers 快照（用于合并后再写，避免整段覆盖）。 */
function piAiProviders(ctx) {
  const settings = optionalService(ctx, 'settings')
  if (!settings || typeof settings.describe !== 'function') return { settings, providers: {} }
  let described = []
  try {
    described = settings.describe() || []
  } catch {
    described = []
  }
  const entry = Array.isArray(described) ? described.find((item) => item?.ns === 'llm-pi-ai') : null
  const value = entry?.value
  const providers = value && typeof value === 'object' && value.providers && typeof value.providers === 'object' ? value.providers : {}
  return { settings, providers }
}

/**
 * 新增 / 更新一个**自定义提供方**（写宿主的 `llm-pi-ai` 路由字典）。
 *
 * 为什么先读后合并：`providers` 是字典，整段替换会清掉用户已有的路由。
 *
 * @param {object} ctx cordis 上下文
 * @param {{route?: unknown, displayName?: unknown, baseURL?: unknown, protocol?: unknown, apiKey?: unknown, models?: unknown}} payload
 * @returns {Promise<object>} 刷新后的配置视图
 */
export async function saveCustomProvider(ctx, payload) {
  const route = String(payload?.route ?? '').trim()
  if (!PROVIDER_ID_PATTERN.test(route)) {
    throw codedError('INVALID_INPUT', '提供方标识只能用小写字母开头 + 小写字母/数字/连字符（例如 my-gateway）')
  }
  const baseURL = String(payload?.baseURL ?? '').trim().replace(/\/+$/, '')
  let parsed = null
  try {
    parsed = new URL(baseURL)
  } catch {
    throw codedError('INVALID_INPUT', '服务地址必须是完整 URL，例如 https://api.openai.com/v1')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw codedError('INVALID_INPUT', '服务地址必须是 http(s) URL')
  }
  const protocol = String(payload?.protocol ?? 'openai-completions').trim()
  if (!LISTABLE_PROTOCOLS.includes(protocol)) {
    throw codedError('INVALID_INPUT', `协议必须是 ${LISTABLE_PROTOCOLS.join(' / ')} 之一`)
  }
  const displayName = String(payload?.displayName ?? '').trim()
  const keyValue = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : ''
  const keyRef = deriveKeyRef(route)
  if (!CREDENTIAL_REF_PATTERN.test(keyRef)) throw codedError('INVALID_INPUT', '派生出的凭据名不合法')

  const { settings, providers } = piAiProviders(ctx)
  if (!settings || typeof settings.update !== 'function') {
    throw codedError('SEAM_UNAVAILABLE', '宿主没有提供设置服务，无法新增提供方')
  }

  const modelIds = Array.isArray(payload?.models)
    ? payload.models.map((item) => (typeof item === 'string' ? item : item?.id)).filter((id) => typeof id === 'string' && id.trim())
    : []
  if (modelIds.length === 0) throw codedError('INVALID_INPUT', '自定义提供方必须至少有一个模型 id')

  const profile = {
    ...(displayName ? { displayName } : {}),
    apiKeyEnv: keyRef,
    api: protocol,
    baseURL,
    models: modelIds.map((id) => ({ id }))
  }
  const nextProviders = { ...providers, [route]: { ...(providers[route] || {}), ...profile } }
  await settings.update('llm-pi-ai', { providers: nextProviders })

  if (keyValue) {
    const credentials = optionalService(ctx, 'credentials')
    if (!credentials || typeof credentials.set !== 'function') {
      throw codedError('SEAM_UNAVAILABLE', '宿主没有提供凭据服务，无法保存 API Key')
    }
    await credentials.set(keyRef, keyValue)
  }

  return readModelConfig(ctx)
}

/**
 * 选择「右侧 AI 栏」默认使用的模型。
 *
 * @param {object} ctx cordis 上下文
 * @param {{provider?: unknown, model?: unknown}} payload
 * @returns {Promise<{provider: string, model: string}>}
 */
export async function saveModelSelection(ctx, payload) {
  const provider = String(payload?.provider ?? '').trim()
  const model = String(payload?.model ?? '').trim()
  if (!provider || !model) throw codedError('INVALID_INPUT', '必须同时给出提供方与模型')
  const row = await resolveProvider(ctx, provider)
  if (!row.configured) throw codedError('INVALID_INPUT', `提供方「${provider}」还没配置 API Key`)
  const agentDefaultModel = optionalService(ctx, 'agentDefaultModel')
  if (!agentDefaultModel || typeof agentDefaultModel.saveSelection !== 'function') {
    throw codedError('SEAM_UNAVAILABLE', '宿主没有提供默认模型服务，无法设置右侧 AI 栏使用的模型')
  }
  await agentDefaultModel.saveSelection({ provider, model })
  return { provider, model }
}
