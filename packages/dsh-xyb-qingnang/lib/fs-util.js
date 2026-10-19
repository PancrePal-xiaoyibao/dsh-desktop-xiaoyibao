/**
 * 插件内最小 JSON 读取与原子写。
 *
 * 为什么不复用 dsh-xyb-workbench 的 store：
 *   两个插件包必须能独立安装/卸载。跨包 import 会让「只装青囊嵌入插件」的场景失败。
 *   因此这里保留一份最小实现（只用到 JSON 读写，不涉及 JSONL / 迁移）。
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 读 JSON；文件不存在或损坏时返回 fallback（**不抛错**：青囊环节失败不能阻塞宿主） */
export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写 JSON：写临时文件 → rename */
export async function atomicWriteJson(target, value) {
  const dir = dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(target)}.tmp-${randomBytes(6).toString('hex')}`)
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await fs.rename(tmp, target)
  } catch (error) {
    try {
      await fs.unlink(tmp)
    } catch {
      /* 临时文件可能不存在 */
    }
    throw error
  }
}

/** 原子写文本 */
export async function atomicWriteText(target, text) {
  const dir = dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(target)}.tmp-${randomBytes(6).toString('hex')}`)
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, target)
  } catch (error) {
    try {
      await fs.unlink(tmp)
    } catch {
      /* 同上 */
    }
    throw error
  }
}

/** 递归复制目录（用于技能装载） */
export async function copyTree(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  let files = 0
  for (const entry of entries) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      files += await copyTree(from, to)
    } else if (entry.isFile()) {
      await fs.copyFile(from, to)
      files += 1
    }
  }
  return files
}

/** 递归统计目录内的文件数与总字节 */
export async function treeStats(dir) {
  let files = 0
  let bytes = 0
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { files, bytes }
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = await treeStats(full)
      files += sub.files
      bytes += sub.bytes
    } else if (entry.isFile()) {
      try {
        bytes += (await fs.stat(full)).size
        files += 1
      } catch {
        /* 跳过无法 stat 的文件 */
      }
    }
  }
  return { files, bytes }
}
