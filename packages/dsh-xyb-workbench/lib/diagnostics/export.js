/**
 * 诊断包导出。
 *
 * 目标：用户报障时能交出一个**能被开发者读懂、但不含任何病历内容**的诊断包。
 * 与 Next 的诊断导出（`dsh-desktop-next/src/diagnostics-export.ts`）的关键差别：
 * 我们把「脱敏」当成第一等公民 —— **先脱敏、再落盘**，并记录替换计数自证。
 *
 * 包里有什么（全部为结构或已脱敏文本）：
 * · 应用与插件版本、运行环境（Node / 平台 / 架构）
 * · 路由面（只有路由名，不含任何请求体）
 * · 数据根结构统计（目录数 / 文件数 / 字节数 —— **没有文件名**）
 * · 事件时间线尾部（F3，字段已白名单 + 已脱敏）
 * · 一份 `privacy` 声明，说明哪些内容**永不写入**
 *
 * 包里**永远没有**：病历正文、患者姓名/ID、原始文档名、本机绝对路径、
 * 任何可回连的凭据（这些要么不收集，要么被脱敏器抹掉）。
 */
import { createHash } from 'node:crypto'
import { readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { redactText } from '../compliance/redact.js'

/** 导出文件目录（数据根下）。 */
export function diagnosticsDir(root) {
  return join(root, 'diagnostics')
}

/**
 * 统计数据根的「形状」：目录数 / 文件数 / 总字节数。
 *
 * 有意**不收集文件名**：文件名往往含患者姓名或检查项目（`张三-CT-2026.pdf`），
 * 属于必须留在本机的信息。深度与条目数都有上限，避免大目录把导出拖死。
 */
export async function summarizeTree(root, { maxDepth = 3, maxEntries = 5000 } = {}) {
  let dirs = 0
  let files = 0
  let bytes = 0
  let seen = 0

  const walk = async (dir, depth) => {
    if (depth > maxDepth || seen > maxEntries) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      seen += 1
      if (seen > maxEntries) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        dirs += 1
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        files += 1
        try {
          bytes += (await stat(full)).size
        } catch {
          /* 读不到大小就跳过：统计不是关键路径 */
        }
      }
    }
  }

  await walk(root, 1)
  return { dirs, files, bytes, truncated: seen > maxEntries }
}

/**
 * 组装诊断包（纯收集，不落盘 —— 便于先给用户看「将要导出什么」）。
 *
 * @param {string} root 数据根
 * @param {{ routes?: string[], events?: object[], version?: string, plugin?: string, now?: Date, names?: string[] }} [context]
 */
export async function collectDiagnostics(root, context = {}) {
  const { routes = [], events = [], version = 'unknown', plugin = 'dsh-xyb-workbench', now = new Date(), names = [] } = context

  const structure = await summarizeTree(root)
  const payload = {
    kind: 'xyb-diagnostics',
    formatVersion: 1,
    generatedAt: now.toISOString(),
    app: {
      plugin,
      version,
      platform: process.platform,
      arch: process.arch,
      node: process.versions?.node || '',
      // Electron 版本由宿主提供，这里只在可用时记录（插件侧拿不到就留空）
      electron: process.versions?.electron || ''
    },
    dataRoot: { structure },
    routes: [...routes].sort(),
    events: {
      count: events.length,
      items: events.map((e) => ({
        ts: e.ts,
        level: e.level,
        phase: e.phase,
        code: e.code,
        message: e.message,
        redactions: e.redactions
      }))
    },
    privacy: {
      statement: '本诊断包只包含结构信息与已脱敏文本；不含病历正文、患者姓名/ID、原始文档名与本机绝对路径。',
      alwaysExcluded: ['病历正文', '患者姓名与标识', '原始文档名', '本机绝对路径', '任何凭据或令牌'],
      upload: 'none — 诊断包只写在本机，需要你自己决定是否交给他人'
    }
  }

  // 纵深防御：整包再过一次脱敏（事件已脱敏，但结构字段可能被未来改动带进敏感串）
  const { text, redactions } = redactText(JSON.stringify(payload, null, 2), { names, maxLength: 2 * 1024 * 1024 })
  return { payload, text, redactions }
}

/**
 * 落盘诊断包。
 *
 * @returns {Promise<{path: string, bytes: number, sha256: string, redactions: number}>}
 */
export async function exportDiagnostics(root, context = {}) {
  const { text, redactions, payload } = await collectDiagnostics(root, context)
  const dir = diagnosticsDir(root)
  await mkdir(dir, { recursive: true })
  const stamp = (context.now instanceof Date ? context.now : new Date()).toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `xyb-diag-${stamp}.json`)
  await writeFile(file, text, 'utf8')
  const bytes = Buffer.byteLength(text, 'utf8')
  const sha256 = createHash('sha256').update(text).digest('hex')
  return { path: file, bytes, sha256, redactions, generatedAt: payload.generatedAt }
}
