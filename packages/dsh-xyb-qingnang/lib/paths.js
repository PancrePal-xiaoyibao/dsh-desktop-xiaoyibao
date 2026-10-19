/**
 * 应用内路径解析。 SPEC ADR-903 / ADR-905。
 *
 * 硬约束（S-905 / C-905）：
 * **绝不解析到用户的全局 agent 目录**（~/.claude / ~/.codex / ~/.pi / ~/.agents）。
 * 所有青囊资产都在应用数据根之内，原因是用户可能同时用多个 agent，
 * 往全局目录写东西会干扰他们。
 */
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson } from './fs-util.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 用户全局 agent 目录（**禁止写入**，用于隔离断言） */
export const FORBIDDEN_GLOBAL_DIRS = [
  '~/.claude',
  '~/.codex',
  '~/.gemini',
  '~/.pi',
  '~/.agents',
  '~/.claude/skills',
  '~/.agents/skills'
]

/** 插件包内随包分发的青囊快照目录 */
export function snapshotDir() {
  return resolve(join(HERE, '..', 'vendor', 'qingnang'))
}

/** 应用内运行时青囊目录（技能副本、画像、状态都放这里） */
export function runtimeDir(dataRoot) {
  return join(dataRoot, 'qingnang')
}

/** 应用内技能根（隔离；**不是**全局技能目录） */
export function skillsDir(dataRoot) {
  return join(dataRoot, 'skills')
}

/** 本机画像位置（应用内，不入库） */
export function profilePath(dataRoot) {
  return join(runtimeDir(dataRoot), 'HOST_PROFILE.md')
}

/** 通道状态缓存位置 */
export function channelStatePath(dataRoot) {
  return join(runtimeDir(dataRoot), 'channel-state.json')
}

/** 青囊脚本绝对路径（应用内快照） */
export function qingnangScriptPath() {
  return join(snapshotDir(), 'scripts', 'qingnang.mjs')
}

/**
 * 断言路径不在用户的全局 agent 目录内。
 * 违反则抛错（这是硬边界，不是警告）。
 */
export function assertNotGlobalPath(target) {
  const resolved = resolve(target)
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (!home) return resolved

  const forbidden = FORBIDDEN_GLOBAL_DIRS.map((p) =>
    resolve(p.replace(/^~/, home))
  )
  for (const dir of forbidden) {
    if (resolved === dir || resolved.startsWith(`${dir}/`) || resolved.startsWith(`${dir}\\`)) {
      const error = new Error(`拒绝写入用户全局 agent 目录: ${target}`)
      error.code = 'CANNOT_ISOLATE'
      throw error
    }
  }
  return resolved
}

/**
 * 读取快照元信息（`SNAPSHOT.json`）。不存在返回 null（**不抛错**：快照缺失应用要能开）。
 */
export async function readSnapshot() {
  try {
    return await readJson(join(snapshotDir(), 'SNAPSHOT.json'), null)
  } catch {
    return null
  }
}

/**
 * 快照是否存在且可用（含必需文件）。
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function checkSnapshotUsable() {
  const meta = await readSnapshot()
  if (!meta) return { ok: false, reason: 'QINGNANG_SNAPSHOT_MISSING' }
  const required = [
    qingnangScriptPath(),
    join(snapshotDir(), 'mcp-servers', 'manifest.json'),
    join(snapshotDir(), 'LICENSE')
  ]
  for (const path of required) {
    try {
      await fs.access(path)
    } catch {
      return { ok: false, reason: `SNAPSHOT_INCOMPLETE: ${path}` }
    }
  }
  return { ok: true }
}
