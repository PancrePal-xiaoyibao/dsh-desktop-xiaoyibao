/**
 * 通道状态三态。 SPEC ADR-906。
 *
 * 判定规则（对齐青囊既有约定）：
 * credential_gate=true 且凭据缺失 → credential-missing（⬜ 选填未配，**不算失败**）
 * initialize 成功 → enabled
 * initialize 失败/超时 → failed（❌）
 * 尚未检测 → checking
 * 未注册（快照缺失等） → not-registered
 *
 * 青囊的原始注释说得很清楚：
 * 「凭据是可选的增强，不是可用性门槛。」
 * 因此把「未配凭据」记成失败是错的，会误导用户以为坏了。
 */

export const CHANNEL_STATUS = Object.freeze({
  ENABLED: 'enabled',
  CREDENTIAL_MISSING: 'credential-missing',
  FAILED: 'failed',
  CHECKING: 'checking',
  NOT_REGISTERED: 'not-registered'
})

/** 状态 → 界面标签与图标（不单靠颜色区分） */
export const STATUS_LABEL = Object.freeze({
  enabled: { text: '已启用', mark: '✅', countsAsFailure: false },
  'credential-missing': { text: '未配凭据', mark: '⬜', countsAsFailure: false },
  failed: { text: '失败', mark: '❌', countsAsFailure: true },
  checking: { text: '检测中', mark: '⏳', countsAsFailure: false },
  'not-registered': { text: '未注册', mark: '➖', countsAsFailure: false }
})

/**
 * 推导单条通道状态。**纯函数**。
 *
 * @param {object} channel 通道声明（来自青囊 manifest）
 * @param {object} runtime 运行时观测 { registered: boolean, initOk?: boolean, checkStarted?: boolean }
 * @param {object} credentials 凭据表
 */
export function deriveStatus(channel, runtime, credentials = {}) {
  if (!runtime.registered) return CHANNEL_STATUS.NOT_REGISTERED

  // 凭据门控优先：缺凭据时不算失败
  if (channel.credentialRequired === true) {
    const keys = channel.credentialKeys || []
    const missing = keys.filter((k) => !credentials[k])
    if (missing.length) return CHANNEL_STATUS.CREDENTIAL_MISSING
  }

  if (runtime.initOk === true) return CHANNEL_STATUS.ENABLED
  if (runtime.initOk === false) return CHANNEL_STATUS.FAILED
  return CHANNEL_STATUS.CHECKING
}

/**
 * 汇总状态列表 → 统计。
 */
export function summarize(states) {
  const counts = { enabled: 0, 'credential-missing': 0, failed: 0, checking: 0, 'not-registered': 0 }
  for (const s of states) counts[s.status] = (counts[s.status] || 0) + 1
  const failures = states.filter((s) => STATUS_LABEL[s.status]?.countsAsFailure).length
  return { counts, failures, total: states.length }
}

/**
 * 构造给界面的通道状态项。
 */
export function toChannelState(channel, runtime, credentials = {}, extra = {}) {
  const status = deriveStatus(channel, runtime, credentials)
  return {
    id: channel.id,
    displayName: channel.displayName || channel.id,
    channel: channel.channel ?? null,
    status,
    statusText: STATUS_LABEL[status]?.text || status,
    statusMark: STATUS_LABEL[status]?.mark || '',
    license: channel.license || null,
    credentialRequired: channel.credentialRequired === true,
    degradeTo: channel.degradeTo ?? null,
    degradeNote: channel.degradeNote ?? null,
    lastCheckedAt: extra.lastCheckedAt || null,
    startupMs: extra.startupMs ?? null,
    errorCode: extra.errorCode || null
  }
}
