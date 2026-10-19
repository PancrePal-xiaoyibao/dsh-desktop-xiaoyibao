/**
 * 原子写。 SPEC ADR-02。
 *
 * 协议：写 <target>.tmp-<rand> → fsync → rename 到 <target>。
 * 失败时删除临时文件，**保留原 target 不变**（这是"原子"的含义）。
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, basename, join } from 'node:path'

/**
 * 原子写入文本内容。
 * @param {string} target 目标文件绝对路径
 * @param {string} content 内容
 */
export async function atomicWrite(target, content) {
  const dir = dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(target)}.tmp-${randomBytes(6).toString('hex')}`)
  let handle
  try {
    handle = await fs.open(tmp, 'w')
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(tmp, target)
  } catch (error) {
    if (handle) {
      try {
        await handle.close()
      } catch {
        /* 关闭失败不掩盖原始错误 */
      }
    }
    try {
      await fs.unlink(tmp)
    } catch {
      /* 临时文件可能不存在，忽略 */
    }
    throw error
  }
}

/**
 * 原子写入 JSON（带缩进，便于人工查看与 diff）。
 */
export async function atomicWriteJson(target, value) {
  await atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 读 JSON；文件不存在时返回 fallback（不抛错）。
 */
export async function readJson(target, fallback = null) {
  try {
    const text = await fs.readFile(target, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    // 坏文件不静默吞掉：抛出可定位的错误
    throw new Error(`读取 JSON 失败: ${target}: ${error && error.message ? error.message : String(error)}`)
  }
}

/**
 * 确保目录存在且权限收敛（POSIX 下 0700）。
 * Windows 忽略 mode（Node 在 Win 上不强制）。
 */
export async function ensureDir(dir, mode = 0o700) {
  await fs.mkdir(dir, { recursive: true, mode })
}
