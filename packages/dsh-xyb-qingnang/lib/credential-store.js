/**
 * 青囊 MCP 通道凭据的本机存储。
 *
 * **为什么需要它**
 * 需要凭据的通道（KnowS、得到笔记等，凭据由社区申请发放）此前只能靠进程环境变量
 * 供给 —— 用户既看不到「哪条通道缺哪个 Key」，也没有任何输入口（实测反馈缺口）。
 * 而 MCP 通道的凭据是**青囊自己的能力**，不属于宿主模型凭据，因此存在青囊自己的
 * 运行时目录里（与应用数据同根），不写用户全局 agent 目录、不写仓库。
 *
 * **安全边界**
 * 1. 文件权限 0600（Windows 上 chmod 无效，退回系统默认 ACL，不报错阻断保存）。
 * 2. 只接受形如 `KNOWS_API_KEY` 的名字；其它键（手改坏文件）一律忽略而不是抛错 ——
 *    一个坏文件不能让应用起不来（boot 的隔离原则）。
 * 3. 读接口永远不把值回传；上层展示只用 `configured` / `source`。
 */

import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from './fs-util.js'
import { assertNotGlobalPath, runtimeDir } from './paths.js'

/** 凭据名语法：大写字母 / 数字 / 下划线，且不以数字开头（POSIX shell identifier）。 */
export const CREDENTIAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/

/** 单个密钥值上限：防止把整份配置粘进来撑爆内存与请求体。 */
export const MAX_SECRET_BYTES = 4096

/**
 * 凭据文件位置（应用数据根内）。
 *
 * @param {string} dataRoot 应用数据根
 * @returns {string} 绝对路径（已断言不在全局 agent 目录内）
 */
export function credentialStorePath(dataRoot) {
  return assertNotGlobalPath(join(runtimeDir(dataRoot), 'credentials.json'))
}

/** 过滤出合法键值对：非法名字 / 空值 / 非字符串一律丢弃。 */
function sanitize(map) {
  const out = {}
  for (const [name, value] of Object.entries(map || {})) {
    if (!CREDENTIAL_NAME_PATTERN.test(name)) continue
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > MAX_SECRET_BYTES) continue
    out[name] = trimmed
  }
  return out
}

/**
 * 读本机凭据文件。文件不存在 / 读取失败 / JSON 坏掉都返回 `{}`（不抛错）。
 *
 * @param {string} dataRoot 应用数据根
 * @returns {Promise<Record<string, string>>} 凭据名 → 值
 */
export async function readStoredCredentials(dataRoot) {
  try {
    const raw = await readFile(credentialStorePath(dataRoot), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return sanitize(parsed)
  } catch {
    return {}
  }
}

/**
 * 覆写本机凭据文件（原子写 + 0600）。
 *
 * @param {string} dataRoot 应用数据根
 * @param {Record<string, string>} map 凭据名 → 值
 * @returns {Promise<Record<string, string>>} 实际写入的内容（已过滤）
 */
export async function writeStoredCredentials(dataRoot, map) {
  const clean = sanitize(map)
  const target = credentialStorePath(dataRoot)
  await atomicWriteJson(target, clean)
  // Windows 上 chmod 只影响只读位、会抛：权限收紧失败不阻断保存，但也不假装成功
  try {
    await chmod(target, 0o600)
  } catch {
    /* 非 POSIX 文件系统：交给系统默认 ACL */
  }
  return clean
}

/**
 * 写入一个凭据。
 *
 * @param {string} dataRoot 应用数据根
 * @param {string} name 凭据名
 * @param {string} value 值（非空）
 * @returns {Promise<Record<string, string>>} 写入后的全量凭据
 */
export async function setStoredCredential(dataRoot, name, value) {
  if (!CREDENTIAL_NAME_PATTERN.test(String(name || ''))) {
    const error = new Error('凭据名不合法（应为大写字母 / 数字 / 下划线，且不以数字开头）')
    error.code = 'INVALID_INPUT'
    throw error
  }
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error('密钥值不能为空')
    error.code = 'INVALID_INPUT'
    throw error
  }
  if (value.length > MAX_SECRET_BYTES) {
    const error = new Error('密钥值过长')
    error.code = 'SIZE_EXCEEDED'
    throw error
  }
  if (/[\r\n]/.test(value)) {
    const error = new Error('密钥值不能包含换行')
    error.code = 'INVALID_INPUT'
    throw error
  }
  const current = await readStoredCredentials(dataRoot)
  return writeStoredCredentials(dataRoot, { ...current, [name]: value.trim() })
}

/**
 * 清除一个凭据（不存在也算成功：清除是幂等操作）。
 *
 * @param {string} dataRoot 应用数据根
 * @param {string} name 凭据名
 * @returns {Promise<Record<string, string>>} 清除后的全量凭据
 */
export async function clearStoredCredential(dataRoot, name) {
  const current = await readStoredCredentials(dataRoot)
  if (!Object.prototype.hasOwnProperty.call(current, name)) return current
  const next = { ...current }
  delete next[name]
  return writeStoredCredentials(dataRoot, next)
}
