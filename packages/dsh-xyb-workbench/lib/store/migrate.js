/**
 * 数据格式版本化与迁移。 SPEC ADR-07。
 *
 * 协议：
 * 1. 读 manifest.schemaVersion
 * 2. == 当前 → 直接启动
 * 3. > 当前 → **拒绝启动**（防降级破坏数据）
 * 4. < 当前 → 备份整个数据根 → 按序执行迁移 → 任一失败从备份还原
 */
import { promises as fs } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { atomicWriteJson, readJson } from './atomic-write.js'

/** 当前数据格式版本。结构性变更时递增，并在 MIGRATIONS 中补一条。 */
export const CURRENT_SCHEMA_VERSION = 1

/**
 * 迁移注册表：键为「从哪个版本升到下一版」。
 * 例：1: async (root) => { /* v1 → v2 的迁移逻辑 *\/ }
 * 当前只有 v1，注册表为空（占位，随后续 CHG 增补）。
 */
export const MIGRATIONS = {
  // 1: async (root) => { ... }
}

/** 备份目录名前缀（同时用于备份排除与清理识别） */
export const BACKUP_DIR_PREFIX = '.backup-'

/**
 * 递归复制目录（仅复制需要的部分，用于迁移前备份）。
 */
async function copyTree(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      // 不递归进历史备份目录（避免备份套备份无限膨胀）
      if (entry.name.startsWith(BACKUP_DIR_PREFIX)) continue
      await copyTree(from, to)
    } else if (entry.isFile()) {
      await fs.copyFile(from, to)
    }
  }
}

/**
 * 创建备份。返回备份目录路径。
 */
export async function createBackup(root, tag = 'pre-migrate') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(root, `${BACKUP_DIR_PREFIX}${tag}-${stamp}`)
  await copyTree(root, dest)
  return dest
}

/**
 * 从备份恢复（迁移失败时用）。
 */
export async function restoreFromBackup(root, backupDir) {
  const entries = await fs.readdir(backupDir, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(backupDir, entry.name)
    const to = join(root, entry.name)
    if (entry.isDirectory()) {
      await fs.rm(to, { recursive: true, force: true })
      await copyTree(from, to)
    } else if (entry.isFile()) {
      await fs.copyFile(from, to)
    }
  }
}

/**
 * 迁移主流程。**调用方负责在迁移前确保数据根已建立**。
 *
 * @param {string} root 数据根
 * @param {object} manifest 已读取的 manifest
 * @returns {Promise<{ ok: boolean, from: number, to: number, backup?: string, error?: string }>}
 */
export async function migrateIfNeeded(root, manifest) {
  const from = Number(manifest?.schemaVersion)
  const to = CURRENT_SCHEMA_VERSION

  if (!Number.isInteger(from) || from < 1) {
    return { ok: false, from: from || 0, to, error: 'SCHEMA_INVALID' }
  }
  if (from === to) return { ok: true, from, to }
  if (from > to) {
    // 数据比程序新：拒绝启动，避免降级破坏
    return { ok: false, from, to, error: 'SCHEMA_TOO_NEW' }
  }

  const backup = await createBackup(root, 'pre-migrate')
  try {
    for (let v = from; v < to; v += 1) {
      const step = MIGRATIONS[v]
      if (typeof step !== 'function') {
        throw new Error(`缺少迁移步骤: v${v} → v${v + 1}`)
      }
      await step(root)
    }
    manifest.schemaVersion = to
    await atomicWriteJson(join(root, 'manifest.json'), manifest)
    return { ok: true, from, to, backup }
  } catch (error) {
    try {
      await restoreFromBackup(root, backup)
    } catch {
      /* 还原失败时保留备份目录，让用户可手工恢复 */
    }
    return {
      ok: false,
      from,
      to,
      backup,
      error: `MIGRATION_FAILED: ${error && error.message ? error.message : String(error)}`
    }
  }
}

/**
 * 读取 manifest（若不存在返回 null，不创建）。
 */
export async function readManifest(root) {
  return readJson(join(root, 'manifest.json'), null)
}
