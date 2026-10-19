/**
 * 本机事件时间线。
 *
 * 为什么要有它：本项目已被「失败静默」坑过多次 —— 工作区创建失败零反馈、就位副本过期发旧界面、
 * 插件装载失败整窗白屏。静态检查与 smoke 都看不见「用户那一侧到底发生了什么」。
 * 本模块把关键事件（尤其是失败）写成**追加式 JSONL**，让用户与开发者都能回看。
 *
 * 硬规则（医疗数据）：
 * ① 字段白名单：只有 `{ts, level, phase, code, message, redactions}` 会落盘，未知字段一律丢弃
 * —— 防止调用方顺手把整个业务对象塞进来（那会把病历写进日志）；
 * ② 一切文本先过 `redactText()`（路径 / 长数字 / URL / 邮箱 / 凭据 / 已知患者姓名）；
 * ③ 滚动上限（2000 条 / 2MB）：超出后截断最旧，避免日志无限增长吃掉用户磁盘；
 * ④ **只在本机**：没有任何上传路径（与 PRIVACY.md 的「两种联网情形」一致）。
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { redactText } from '../compliance/redact.js'

export const MAX_EVENTS = 2000
export const MAX_BYTES = 2 * 1024 * 1024
export const EVENT_LEVELS = ['info', 'warn', 'error']
export const EVENT_FIELDS = ['ts', 'level', 'phase', 'code', 'message', 'redactions']

/** 事件文件位置（数据根下）。 */
export function eventsPath(root) {
  return join(root, 'events', 'events.jsonl')
}

/**
 * 规范化一条事件：字段白名单 + 级别校验 + 文本脱敏 + 长度上限。
 *
 * @param {{ level?: string, phase?: string, code?: string, message?: unknown, names?: string[], at?: Date }} input
 * @returns {{ record: object, dropped: string[] }}
 */
export function normalizeEvent(input = {}) {
  const dropped = []
  for (const key of Object.keys(input)) {
    if (!['level', 'phase', 'code', 'message', 'names', 'at', 'extra'].includes(key)) dropped.push(key)
  }

  const level = EVENT_LEVELS.includes(input.level) ? input.level : 'info'
  const phase = clampText(input.phase, 40) || 'app'
  const code = clampText(input.code, 60) || 'OK'
  const { text: message, redactions } = redactText(input.message ?? '', { names: input.names, maxLength: 600 })

  return {
    record: {
      ts: (input.at instanceof Date ? input.at : new Date()).toISOString(),
      level,
      phase,
      code,
      message,
      redactions
    },
    dropped
  }
}

function clampText(value, limit) {
  if (value === null || value === undefined) return ''
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * 追加一条事件（写失败一律**吞掉** —— 事件日志不能因为磁盘问题反过来打断业务）。
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function appendEvent(root, input) {
  try {
    const { record } = normalizeEvent(input)
    const file = eventsPath(root)
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
    await rollIfNeeded(file)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error?.code || error?.message || 'APPEND_FAILED' }
  }
}

/** 超过条数或体积上限时，保留最新的一半（重写为临时文件再原子替换）。 */
async function rollIfNeeded(file) {
  let info
  try {
    info = await stat(file)
  } catch {
    return
  }
  if (info.size <= MAX_BYTES) return

  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
  if (lines.length <= MAX_EVENTS / 2 + 1) return
  const kept = lines.slice(-Math.floor(MAX_EVENTS / 2))
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${kept.join('\n')}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * 读事件（新 → 旧）。
 *
 * @param {string} root
 * @param {{ limit?: number, level?: string }} [options]
 * @returns {Promise<{ events: object[], total: number, truncated: boolean }>}
 */
export async function listEvents(root, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200)
  const level = EVENT_LEVELS.includes(options.level) ? options.level : ''
  const file = eventsPath(root)

  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { events: [], total: 0, truncated: false }
  }

  const all = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (level && parsed.level !== level) continue
      all.push(parsed)
    } catch {
      // 半行（写入中断）直接跳过：日志不因一条坏行整体不可读
    }
  }

  const events = all.slice(-limit).reverse()
  return { events, total: all.length, truncated: all.length > events.length }
}
