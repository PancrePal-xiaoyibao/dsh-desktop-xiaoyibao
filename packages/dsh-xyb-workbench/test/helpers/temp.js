/**
 * 测试工具：独立的临时数据根。
 *
 * 并行隔离要求：
 * 每个 worker 用独立临时目录，绝不共用；测试结束清理。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 创建一个独立临时数据根 */
export async function makeTempRoot(tag = 'test') {
  const dir = join(tmpdir(), `xyb-${tag}-${process.pid}-${randomBytes(4).toString('hex')}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** 清理临时数据根 */
export async function removeTempRoot(dir) {
  await fs.rm(dir, { recursive: true, force: true })
}

/** 带自动清理的上下文 */
export async function withTempRoot(tag, fn) {
  const root = await makeTempRoot(tag)
  try {
    return await fn(root)
  } finally {
    await removeTempRoot(root)
  }
}
