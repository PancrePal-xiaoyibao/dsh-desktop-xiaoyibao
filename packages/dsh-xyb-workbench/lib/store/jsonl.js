/**
 * JSONL 记录流。 SPEC ADR-02。
 *
 * 协议：
 * - 每行一个 JSON 对象，行尾 \n
 * - 追加用 appendFile（O_APPEND 原子追加）
 * - **软删除**：追加 { op: 'delete', id, at }
 * - **修订**：追加同 id 的完整记录（读取时"后出现者胜"）
 * - 坏行跳过并计数（**不静默丢弃**：返回 malformedLines）
 */
import { promises as fs } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { atomicWrite } from './atomic-write.js'

/**
 * 读取 JSONL，按 id 归并（put/delete，后出现者胜）。
 *
 * @param {string} path
 * @returns {Promise<{ items: object[], malformedLines: number }>}
 */
export async function readJsonl(path) {
  let text
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { items: [], malformedLines: 0 }
    throw error
  }

  const byId = new Map()
  let malformedLines = 0

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      malformedLines += 1
      continue
    }
    if (!parsed || typeof parsed !== 'object') {
      malformedLines += 1
      continue
    }

    if (parsed.op === 'delete') {
      if (typeof parsed.id === 'string') byId.delete(parsed.id)
      continue
    }

    const record = parsed.op === 'put' ? parsed.record : parsed
    if (!record || typeof record !== 'object' || typeof record.id !== 'string') {
      malformedLines += 1
      continue
    }
    byId.set(record.id, record)
  }

  return { items: [...byId.values()], malformedLines }
}

/**
 * 追加一行（原子追加）。
 */
export async function appendJsonl(path, value) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

/**
 * 追加一条记录（put 语义）。
 */
export async function appendRecord(path, record) {
  await appendJsonl(path, record)
}

/**
 * 追加一条软删除。
 */
export async function appendDelete(path, id) {
  await appendJsonl(path, { op: 'delete', id, at: new Date().toISOString() })
}

/**
 * 压实：读取 → 应用 op → 重写全文件（原子 rename）。
 * 返回 { before, after, removed }。
 */
export async function compactJsonl(path) {
  const { items, malformedLines } = await readJsonl(path)
  const body = items.map((item) => `${JSON.stringify(item)}\n`).join('')
  await atomicWrite(path, body)
  return { before: items.length + malformedLines, after: items.length, removed: malformedLines }
}

/**
 * 原子写留下的临时文件名判断（供备份排除与数据自检用）。
 *
 * 命名约定来自 atomic-write.js：`.<目标名>.tmp-<随机 hex>`。
 * ⚠️ 旧实现写的是 `name.startsWith('.' + basename(name))` —— 这**恒为 false**
 * （一个名字不可能以「点 + 它自己」开头），于是临时文件从来没被识别出来。
 * 实测由 F2 的自检测试抓出。
 */
export function isTempName(name) {
  return name.startsWith('.') && name.includes('.tmp-')
}
