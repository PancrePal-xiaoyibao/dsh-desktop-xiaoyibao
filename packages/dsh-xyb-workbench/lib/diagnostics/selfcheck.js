/**
 * 数据自检与修复。
 *
 * 由来：本项目踩过的坑里，有三类「数据面」故障是用户能自己救回来的 ——
 * ① 配置/清单 JSON 损坏（界面报错甚至白屏）；
 * ② JSONL 里出现写坏的行（某条记录永远读不出来）；
 * ③ 进程被强杀留下的临时文件（`.name.tmp-xxxx`）。
 * 这些都不该等开发者。所以这里给出**可解释的检查项 + 白名单修复动作**。
 *
 * 硬规则（医疗数据，顺序不可颠倒）：
 * 1. 修复前**先整根备份**（复用 migrate.js 的 `.backup-` 机制），备份失败就**不修**；
 * 2. 修复只碰**派生/临时/可重建**的东西；业务记录（档案与记录行）**只允许**在
 * 「明确告知会丢弃坏行 + 已备份原文」的前提下压实（compactJsonl），绝不静默丢弃；
 * 3. 修复幂等：连跑两次结果一致，第二次无副作用；
 * 4. 每个动作写一条事件（F3 时间线可回看），且**不含病历内容**。
 */
import { copyFile, mkdir, readdir, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readJson } from '../store/atomic-write.js'
import { BACKUP_DIR_PREFIX, createBackup } from '../store/migrate.js'
import { compactJsonl, isTempName, readJsonl } from '../store/jsonl.js'
import { listPatients, STREAM_NAMES, streamPath } from '../store/patients.js'

/** 自检项的状态级别（与 UI 的三色一致）。 */
export const CHECK_LEVELS = ['ok', 'warn', 'error']

/** 磁盘余量阈值 */
const DISK_WARN_BYTES = 500 * 1024 * 1024
const DISK_ERROR_BYTES = 100 * 1024 * 1024

/** 单次自检最多遍历的档案数（避免大库把自检拖死） */
const MAX_PATIENTS = 50

/**
 * 修复动作白名单。**只有**这里登记的动作可以被路由调用。
 * 每个动作：{ label, target, run(root, context) } —— run 返回 { detail, changed }
 */
export const REPAIR_ACTIONS = {
  'clean-temp': {
    label: '清理临时文件',
    target: '写盘中断留下的 .tmp-* 残留（可安全删除）',
    run: async (root) => {
      const targets = await findTempFiles(root)
      for (const file of targets) await unlink(file).catch(() => {})
      return { detail: `已清理 ${targets.length} 个临时文件`, changed: targets.length }
    }
  },
  'compact-jsonl': {
    label: '压实记录文件（丢弃坏行）',
    target: '记录 JSONL 里无法解析的坏行；原文已随修复前备份保留',
    run: async (root, context) => {
      const patients = await safePatients(root)
      let removed = 0
      let files = 0
      for (const patient of patients) {
        for (const stream of STREAM_NAMES) {
          const file = streamPath(root, patient.id, stream)
          const { malformedLines } = await readJsonl(file)
          if (!malformedLines) continue
          const result = await compactJsonl(file)
          removed += result.removed || 0
          files += 1
        }
      }
      void context
      return { detail: `压实 ${files} 份记录文件，丢弃 ${removed} 行坏行（原文在备份里）`, changed: removed }
    }
  },
  'restore-settings': {
    label: '从备份恢复设置',
    target: 'settings.json（解析失败时用最近一次备份覆盖）',
    run: async (root) => restoreFileFromNewestBackup(root, 'settings.json')
  },
  'restore-manifest': {
    label: '从备份恢复档案清单',
    target: 'manifest.json（解析失败时用最近一次备份覆盖）',
    run: async (root) => restoreFileFromNewestBackup(root, 'manifest.json')
  }
}

/** 自检：逐项跑一遍，返回 items + summary（不修改任何东西）。 */
export async function runSelfCheck(root, options = {}) {
  const { now = new Date() } = options
  const items = []

  // ① 数据根可写（最基础：写一个探针再删掉）
  try {
    await mkdir(root, { recursive: true })
    const probe = join(root, '.selfcheck-probe')
    await writeFile(probe, String(now.getTime()), 'utf8')
    await unlink(probe)
    items.push({ id: 'root-writable', label: '数据目录可写', level: 'ok', detail: '写入探针正常', repairable: false })
  } catch (error) {
    items.push({
      id: 'root-writable',
      label: '数据目录可写',
      level: 'error',
      detail: `不可写：${error?.message || '未知原因'}（常见原因：目录权限、受控文件夹访问、磁盘已满）`,
      repairable: false
    })
  }

  // ② 设置文件
  items.push(await checkJsonFile(root, {
    id: 'settings',
    label: '设置文件',
    file: 'settings.json',
    restoreAction: 'restore-settings',
    acceptable: (value) => value === null || value === undefined || typeof value === 'object'
  }))

  // ③ 档案清单
  items.push(await checkJsonFile(root, {
    id: 'manifest',
    label: '档案清单',
    file: 'manifest.json',
    restoreAction: 'restore-manifest',
    acceptable: (value) => value === null || value === undefined || Array.isArray(value?.patients)
  }))

  // ④ 每份档案的基本信息
  const patients = await safePatients(root)
  const profileIssues = []
  for (const patient of patients.slice(0, MAX_PATIENTS)) {
    const profile = await safeReadJson(join(root, 'patients', patient.id, 'profile.json'))
    if (!profile) profileIssues.push(patient.id)
  }
  items.push({
    id: 'profiles',
    label: '档案基本信息',
    level: profileIssues.length ? 'error' : 'ok',
    detail: profileIssues.length
      ? `${profileIssues.length} 份档案的 profile.json 读不出来（属于业务数据，需要人工确认后再处理）`
      : `已检查 ${Math.min(patients.length, MAX_PATIENTS)} 份档案，均可读`,
    repairable: false
  })

  // ⑤ 记录文件（5 条流：records/medications/assessments/cares/psych 的坏行）
  let badLines = 0
  let scannedStreams = 0
  for (const patient of patients.slice(0, MAX_PATIENTS)) {
    for (const stream of STREAM_NAMES) {
      const { malformedLines } = await readJsonl(streamPath(root, patient.id, stream))
      badLines += malformedLines || 0
      scannedStreams += 1
    }
  }
  items.push({
    id: 'records',
    label: '记录文件完整性',
    level: badLines ? 'warn' : 'ok',
    detail: badLines
      ? `已检查 ${scannedStreams} 份记录文件，发现 ${badLines} 行无法解析（修复会丢弃这些行，原文先备份）`
      : `已检查 ${scannedStreams} 份记录文件，未发现坏行`,
    repairable: badLines > 0,
    action: badLines ? 'compact-jsonl' : undefined
  })

  // ⑥ 临时文件残留
  const temps = await findTempFiles(root)
  items.push({
    id: 'temp',
    label: '临时文件残留',
    level: temps.length ? 'warn' : 'ok',
    detail: temps.length ? `发现 ${temps.length} 个写盘中断残留（可安全清理）` : '无残留',
    repairable: temps.length > 0,
    action: temps.length ? 'clean-temp' : undefined
  })

  // ⑦ 备份可用性（真读一遍最近一份，而不是只看目录在不在）
  const backups = await listBackups(root)
  let backupDetail = '还没有备份（第一次修复时会自动创建）'
  let backupLevel = 'warn'
  if (backups.length) {
    try {
      const entries = await readdir(backups[0])
      backupLevel = entries.length ? 'ok' : 'warn'
      backupDetail = `最近一份备份可读（${entries.length} 项，${backups[0].split(/[\\/]/).pop()}）`
    } catch (error) {
      backupLevel = 'warn'
      backupDetail = `最近一份备份读不出来：${error?.message || ''}`
    }
  }
  items.push({ id: 'backups', label: '备份可用性', level: backupLevel, detail: backupDetail, repairable: false })

  // ⑧ 磁盘余量
  try {
    const info = await statfs(root)
    const free = Number(info.bavail) * Number(info.bsize)
    const gb = (free / 1024 / 1024 / 1024).toFixed(1)
    const level = free < DISK_ERROR_BYTES ? 'error' : free < DISK_WARN_BYTES ? 'warn' : 'ok'
    items.push({ id: 'disk', label: '磁盘余量', level, detail: `可用 ${gb} GB`, repairable: false })
  } catch (error) {
    items.push({ id: 'disk', label: '磁盘余量', level: 'warn', detail: `读不到磁盘信息：${error?.message || ''}`, repairable: false })
  }

  const summary = {
    ok: items.filter((i) => i.level === 'ok').length,
    warn: items.filter((i) => i.level === 'warn').length,
    error: items.filter((i) => i.level === 'error').length,
    checkedAt: now.toISOString()
  }
  return { items, summary }
}

/**
 * 执行一个修复动作（白名单外一律拒绝）。
 *
 * 流程固定为：备份 → 动作 → 复检。
 * @returns {Promise<{ok: boolean, action?: string, backup?: string, detail?: string, after?: object, error?: string}>}
 */
export async function runRepair(root, action, options = {}) {
  const entry = REPAIR_ACTIONS[action]
  if (!entry) return { ok: false, error: 'UNKNOWN_ACTION' }

  let backup
  try {
    // 硬规则 1：先备份；备份失败就不动数据
    backup = await createBackup(root, `pre-repair-${action}`)
  } catch (error) {
    return { ok: false, action, error: 'BACKUP_FAILED', detail: `修复前备份失败：${error?.message || ''}` }
  }

  try {
    const result = await entry.run(root, options)
    const after = await runSelfCheck(root, options)
    return { ok: true, action, backup, detail: result.detail, changed: result.changed, after }
  } catch (error) {
    return { ok: false, action, backup, error: error?.code || 'REPAIR_FAILED', detail: error?.message || '修复失败' }
  }
}

// ─────────────────────────────────────────── 内部工具

/**
 * 安全读 JSON：坏 JSON 会**抛错**（见 atomic-write.js），自检不能因此中断。
 *
 * @returns {Promise<unknown|undefined>} 解析失败或不存在时返回 undefined
 */
async function safeReadJson(path) {
  try {
    return await readJson(path, undefined)
  } catch {
    return undefined
  }
}

/** 读 JSON 文件并给出可读结论（缺失不算错，损坏才算）。 */
async function checkJsonFile(root, { id, label, file, restoreAction, acceptable }) {
  const path = join(root, file)
  let exists = true
  try {
    await stat(path)
  } catch {
    exists = false
  }
  if (!exists) {
    return { id, label, level: 'ok', detail: `${file} 尚未创建（首次使用正常）`, repairable: false }
  }

  const value = await safeReadJson(path)
  if (value === undefined) {
    return {
      id,
      label,
      level: 'error',
      detail: `${file} 解析失败（内容不是合法 JSON）`,
      repairable: true,
      action: restoreAction
    }
  }
  if (!acceptable(value)) {
    return { id, label, level: 'error', detail: `${file} 结构不符合预期`, repairable: true, action: restoreAction }
  }
  return { id, label, level: 'ok', detail: `${file} 可解析`, repairable: false }
}

/** 列档案（读不出来就当空库，自检本身不能抛错）。 */
async function safePatients(root) {
  try {
    const patients = await listPatients(root)
    return Array.isArray(patients) ? patients : []
  } catch {
    return []
  }
}

/** 找临时残留（根与 patients/* 各一层，够用且不会扫穿大库）。 */
async function findTempFiles(root) {
  const found = []
  const scan = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isFile() && isTempName(entry.name)) found.push(join(dir, entry.name))
    }
  }
  await scan(root)
  await scan(join(root, 'patients'))
  return found
}

/** 按名字列出备份目录（新 → 旧）。 */
async function listBackups(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith(BACKUP_DIR_PREFIX))
      .map((e) => join(root, e.name))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** 从最近一份备份里恢复单个文件（找不到就明确失败，不假装成功）。 */
async function restoreFileFromNewestBackup(root, file) {
  const backups = await listBackups(root)
  for (const backup of backups) {
    const source = join(backup, file)
    try {
      await stat(source)
    } catch {
      continue
    }
    await copyFile(source, join(root, file))
    return { detail: `已从 ${backup.split(/[\\/]/).pop()} 恢复 ${file}`, changed: 1 }
  }
  const error = new Error(`最近的备份里没有 ${file}`)
  error.code = 'NO_BACKUP_FILE'
  throw error
}

/** 给路由用的动作清单（UI 只允许点这些）。 */
export function repairCatalog() {
  return Object.entries(REPAIR_ACTIONS).map(([id, entry]) => ({ id, label: entry.label, target: entry.target }))
}
