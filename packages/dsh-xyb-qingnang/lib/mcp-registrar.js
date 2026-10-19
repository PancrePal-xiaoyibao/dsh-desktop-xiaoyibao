/**
 * MCP 注册。 SPEC ADR-902。
 *
 * 职责：把青囊 `mcp-config --format=dsh` 的产物映射为宿主 MCP 配置，并负责注册/注销。
 *
 * 关键设计（都是踩过坑的地方）：
 * · command 用 process.execPath —— 用户机器不一定有 node 在 PATH，但 Electron 一定自带
 * · failOnStartupError 改为 false —— 青囊任何通道坏了不得拖垮宿主（S-914）
 * · cwd 指向应用内快照 —— 不指向开发机路径
 * · 剥离 _qingnang 元信息 —— 宿主不认这个字段
 * · USE_PROXY 显式 false —— 不留空让上游默认启用
 */

/** 各凭据通道所需的凭据键（来自青囊 mcp-servers/manifest.json 的 env 声明） */
const CREDENTIAL_KEYS = {
  qingnang_knows: ['KNOWS_API_KEY', 'KNOWS_API_HOST'],
  qingnang_biji: ['GET_NOTE_API_KEY']
}

/** 不需要代理的通道（青囊 manifest 的 proxy.supported === false） */
const NO_PROXY_CHANNELS = new Set(['qingnang_bing', 'qingnang_pubmed', 'qingnang_openalex', 'qingnang_trial', 'qingnang_knows', 'qingnang_biji'])

/**
 * 把单条青囊通道配置映射为宿主 MCP 配置。**纯函数**（不改动入参）。
 *
 * @param {object} channel 青囊 `mcp-config --format=dsh` 的单条产物
 * @param {{ assetsDir: string, execPath: string, proxy?: string|null }} params
 * @returns {object} 宿主 MCP 配置
 */
export function mapQingnangChannel(channel, params) {
  const { assetsDir, execPath, proxy = null } = params

  // 分离「宿主认识的字段」与「青囊元信息」
  const { _qingnang: meta, ...hostFields } = channel

  // args：第 0 项替换为应用内脚本路径，其余（子命令 + 通道 id）保持
  const args = Array.isArray(hostFields.args) ? [...hostFields.args] : []
  if (args.length) args[0] = `${assetsDir}/scripts/qingnang.mjs`

  // env：保留青囊默认 + 代理
  const env = { ...(hostFields.env || {}) }
  const proxySupported = !NO_PROXY_CHANNELS.has(hostFields.serverName)
  if (proxySupported) {
    if (proxy) {
      env.USE_PROXY = 'true'
      env.PROXY_URL = proxy
    } else {
      // 显式 false：留空会让上游默认启用
      env.USE_PROXY = 'false'
      if (!('PROXY_URL' in env)) env.PROXY_URL = ''
    }
  }

  return {
    transport: hostFields.transport || 'stdio',
    serverName: hostFields.serverName,
    command: execPath,
    args,
    env,
    cwd: assetsDir,
    toolCallTimeoutMs: hostFields.toolCallTimeoutMs ?? 60000,
    // 关键：青囊失败不得阻塞宿主
    failOnStartupError: false
  }
}

/**
 * 判断某条通道的凭据是否齐备。
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkCredentials(serverName, credentials = {}) {
  const required = CREDENTIAL_KEYS[serverName]
  if (!required || required.length === 0) {
    // 未登记的凭据通道：任一凭据存在即视为可用
    const anyPresent = Object.values(credentials).some((v) => typeof v === 'string' && v.length > 0)
    return { ok: anyPresent, missing: anyPresent ? [] : ['<未知凭据>'] }
  }
  const missing = required.filter((k) => !credentials || !credentials[k])
  return { ok: missing.length === 0, missing }
}

/**
 * 批量构建：零凭据通道无条件注册；凭据通道按凭据齐备程度决定。
 *
 * @param {object[]} channels 青囊产物数组
 * @param {{ assetsDir: string, execPath: string, credentials?: object, proxy?: string|null }} params
 * @returns {{ registered: object[], skipped: Array<{ serverName: string, reason: string }> }}
 */
export function buildAllChannels(channels, params) {
  const { credentials = {}, ...rest } = params
  const registered = []
  const skipped = []

  for (const channel of channels) {
    const meta = channel._qingnang || {}
    const serverName = channel.serverName

    if (meta.credentialRequired === true) {
      const check = checkCredentials(serverName, credentials)
      if (!check.ok) {
        skipped.push({
          serverName,
          reason: `未配置凭据（缺少 ${check.missing.join('、')}），该通道未启用`
        })
        continue
      }
      // 有凭据：把凭据注入 env
      const mapped = mapQingnangChannel(channel, rest)
      for (const key of CREDENTIAL_KEYS[serverName] || []) {
        if (credentials[key]) mapped.env[key] = credentials[key]
      }
      registered.push(mapped)
      continue
    }

    registered.push(mapQingnangChannel(channel, rest))
  }

  return { registered, skipped }
}

/**
 * 幂等键：用于判断某条通道是否已注册（避免重复注册）。
 */
export function channelKey(config) {
  return `${config.serverName}::${config.cwd}`
}

/**
 * 就地合并：把新配置并入已有注册表，保持幂等。
 *
 * @param {object[]} existing 已注册的配置数组
 * @param {object[]} incoming 本次要注册的配置数组
 * @returns {{ merged: object[], added: number, replaced: number }}
 */
export function mergeRegistrations(existing, incoming) {
  const map = new Map((existing || []).map((c) => [channelKey(c), c]))
  let added = 0
  let replaced = 0
  for (const config of incoming) {
    const key = channelKey(config)
    if (map.has(key)) {
      map.set(key, config)
      replaced += 1
    } else {
      map.set(key, config)
      added += 1
    }
  }
  return { merged: [...map.values()], added, replaced }
}

/**
 * 从注册表中移除所有青囊条目（卸载清理）。
 */
export function removeQingnangEntries(existing) {
  const kept = (existing || []).filter((c) => !String(c.serverName || '').startsWith('qingnang_'))
  return { kept, removed: (existing || []).length - kept.length }
}
