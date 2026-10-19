/**
 * 数据根定位。 SPEC ADR-02 / ADR-605。
 *
 * 优先级：
 * 1. 环境变量 XYB_DATA_ROOT（**仅测试用**，避免污染真实数据）
 * 2. 插件 config.root（由 cordis.patch.yml 的 dshHomePath('xyb') 注入）
 * 3. 兜底：<cwd>/.xyb-data（不推荐，仅用于缺少 config 的场景）
 *
 * 真实用户数据一律落在 DSH 数据根（dshHomePath('xyb')），与宿主数据边界一致。
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readJson } from './atomic-write.js'

/**
 * 解析当前生效的数据根。
 *
 * @param {string|undefined} configRoot 插件 config.root
 * @returns {Promise<string>} 绝对路径
 */
export async function resolveDataRoot(configRoot) {
  const fromEnv = process.env.XYB_DATA_ROOT
  if (fromEnv) return resolve(fromEnv)

  if (typeof configRoot === 'string' && configRoot.trim()) {
    return isAbsolute(configRoot) ? configRoot : resolve(configRoot)
  }

  // 兜底：不抛错（否则插件在缺少 config 时完全不可用），但路径明显是"临时"语义
  return join(process.cwd(), '.xyb-data')
}

/**
 * 读取用户自行改过的数据根覆盖值。
 * 读 `<defaultRoot>/settings.json` 的 dataRootOverride 字段。
 *
 * 注意：覆盖值本身存在默认数据根里，形成"指针"语义。
 */
export async function resolveEffectiveRoot(defaultRoot) {
  const settings = await readJson(join(defaultRoot, 'settings.json'), null)
  const override = settings && typeof settings.dataRootOverride === 'string' ? settings.dataRootOverride : null
  if (!override) return { root: defaultRoot, overridden: false }
  return { root: resolve(override), overridden: true }
}

/**
 * 有界重试地初始化数据根。
 *
 * 为什么需要：数据根初始化是**真实文件 IO**（mkdir / 写 manifest / 追加事件）。
 * 在 Windows 上会被安全软件与索引器短暂占用，并行回归实测偶发一次失败 ——
 * 第一次失败就把整个界面打成「内部错误」是过度反应。
 *
 * 边界：**只重试一次**（默认 2 次尝试）。持续故障（无权限 / 磁盘满 / 只读）
 * 会把最后一个错误原样抛出 —— 不无限重试，也不把失败伪装成成功。
 *
 * @param {() => Promise<any>} attempt 一次完整尝试
 * @param {number} [attempts] 最多尝试次数（默认 2，最小 1）
 * @returns {Promise<any>} 第一次成功的返回值
 */
export async function bootWithRetry(attempt, attempts = 2) {
  const limit = Math.max(1, Number(attempts) || 1)
  let lastError = null
  for (let index = 0; index < limit; index += 1) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * 路径穿越防护：断言 child 位于 root 之内。
 * 所有由外部输入参与拼接的路径都必须过这一关。
 */
export function assertInside(root, child) {
  const rel = resolve(child)
  const base = resolve(root)
  if (rel !== base && !rel.startsWith(`${base}${process.platform === 'win32' ? '\\' : '/'}`)) {
    const error = new Error(`路径越界: ${child}`)
    error.code = 'PATH_ESCAPE'
    throw error
  }
  return rel
}

/** 数据根可写性检查（启动时用，避免写操作时才发现） */
export async function assertWritable(dir) {
  await fs.mkdir(dir, { recursive: true })
  const probe = join(dir, `.write-probe-${process.pid}`)
  try {
    await fs.writeFile(probe, 'ok', 'utf8')
  } catch (error) {
    const e = new Error(`数据根不可写: ${dir}`)
    e.code = 'DATA_ROOT_UNWRITABLE'
    e.cause = error
    throw e
  } finally {
    try {
      await fs.unlink(probe)
    } catch {
      /* probe 可能未创建成功，忽略 */
    }
  }
  return true
}
