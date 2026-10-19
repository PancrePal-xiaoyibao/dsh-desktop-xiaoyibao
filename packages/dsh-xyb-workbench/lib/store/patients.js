/**
 * 患者档案与数据根布局。 SPEC ADR-02。
 *
 * 目录布局：
 * <root>/manifest.json schemaVersion + patients 索引
 * <root>/settings.json 全局设置
 * <root>/patients/<pid>/profile.json 患者档案
 * <root>/patients/<pid>/records.jsonl 指标记录流
 * <root>/patients/<pid>/medications.jsonl 用药记录流
 * <root>/patients/<pid>/assessments.jsonl 评估记录流
 * <root>/patients/<pid>/cares.jsonl 全程管理事件流
 * <root>/patients/<pid>/documents/ 原始文件（只增不改）
 * <root>/patients/<pid>/derived/ 派生数据（可重建）
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, readJson, ensureDir } from './atomic-write.js'
import { CURRENT_SCHEMA_VERSION, readManifest, migrateIfNeeded } from './migrate.js'

/** 患者数上限（PRD UQ-11：家庭场景，个位数） */
export const MAX_PATIENTS = 9

/**
 * 患者姓名长度上限。
 *
 * 与客户端输入框的 maxLength 保持一致（client.js 里是 40）——
 * 数据层必须**独立**校验，不能依赖 UI 约束：接口可被直接调用，
 * 超长姓名会污染 manifest 与所有列表渲染（实测：500 字姓名此前被放行）。
 */
export const MAX_NAME_LENGTH = 40

/** 患者 id 白名单校验（防路径穿越） */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/

export function isValidPatientId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

function assertPatientId(id) {
  if (!isValidPatientId(id)) {
    const error = new Error(`非法的患者 id: ${String(id)}`)
    error.code = 'PATH_ESCAPE'
    throw error
  }
}

/**
 * 初始化数据根（幂等）。
 *
 * @param {string} root
 * @returns {Promise<{ manifest: object, migration: object }>}
 */
export async function initRoot(root) {
  await ensureDir(root)

  let manifest = await readManifest(root)
  if (!manifest) {
    manifest = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      patients: []
    }
    await atomicWriteJson(join(root, 'manifest.json'), manifest)
    return { manifest, migration: { ok: true, from: CURRENT_SCHEMA_VERSION, to: CURRENT_SCHEMA_VERSION } }
  }

  const migration = await migrateIfNeeded(root, manifest)
  if (!migration.ok) {
    const error = new Error(migration.error)
    error.code = migration.error
    error.migration = migration
    throw error
  }
  // migrateIfNeeded 可能已更新 manifest，重新读一次
  manifest = await readManifest(root)
  return { manifest, migration }
}

/** 患者目录 */
export function patientDir(root, patientId) {
  assertPatientId(patientId)
  return join(root, 'patients', patientId)
}

/** 患者档案路径 */
export function profilePath(root, patientId) {
  return join(patientDir(root, patientId), 'profile.json')
}

/** 记录流路径 */
/**
 * 记录流白名单（**单一真源**：streamPath 与数据自检都从这里取）。
 *
 * 流名会拼进文件名，必须封闭（防路径穿越）。
 * 追加 'psych'（量表读数，见 lib/psych/scores.js）。
 */
export const STREAM_NAMES = ['records', 'medications', 'assessments', 'cares', 'psych']

export function streamPath(root, patientId, stream) {
  if (!STREAM_NAMES.includes(stream)) {
    const error = new Error(`未知记录流: ${String(stream)}`)
    error.code = 'UNKNOWN_STREAM'
    throw error
  }
  return join(patientDir(root, patientId), `${stream}.jsonl`)
}

/**
 * 列出患者（从 manifest 索引读，过滤已软删）。
 */
export async function listPatients(root) {
  const manifest = await readManifest(root)
  if (!manifest) return []
  return (manifest.patients || []).filter((p) => !p.deletedAt)
}

/**
 * 读患者档案。不存在时抛 NOT_FOUND。
 */
export async function readProfile(root, patientId) {
  const profile = await readJson(profilePath(root, patientId), null)
  if (!profile) {
    const error = new Error(`患者不存在: ${patientId}`)
    error.code = 'NOT_FOUND'
    throw error
  }
  return profile
}

/**
 * 新建患者。
 *
 * @param {string} root
 * @param {{ name: string, sex?: string, birthYear?: number, diagnosedAt?: string, note?: string }} input
 */
export async function createPatient(root, input) {
  const { manifest } = await initRoot(root)
  const active = (manifest.patients || []).filter((p) => !p.deletedAt)
  if (active.length >= MAX_PATIENTS) {
    const error = new Error(`患者数量已达上限（${MAX_PATIENTS}）`)
    error.code = 'PATIENT_LIMIT'
    throw error
  }

  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (!name) {
    const error = new Error('患者姓名不能为空')
    error.code = 'INVALID_INPUT'
    throw error
  }
  if (name.length > MAX_NAME_LENGTH) {
    const error = new Error(`患者姓名不能超过 ${MAX_NAME_LENGTH} 个字符`)
    error.code = 'INVALID_INPUT'
    throw error
  }

  const id = `p-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const profile = {
    id,
    name,
    sex: input?.sex ?? 'unknown',
    birthYear: input?.birthYear ?? null,
    diagnosedAt: input?.diagnosedAt ?? null,
    note: input?.note ?? '',
    createdAt: now,
    updatedAt: now
  }

  await ensureDir(patientDir(root, id))
  await atomicWriteJson(profilePath(root, id), profile)

  manifest.patients = [...(manifest.patients || []), { id, name, createdAt: now }]
  await atomicWriteJson(join(root, 'manifest.json'), manifest)
  return profile
}

/**
 * 更新患者档案（部分字段）。
 */
export async function updatePatient(root, patientId, patch) {
  const profile = await readProfile(root, patientId)
  const allowed = ['name', 'sex', 'birthYear', 'diagnosedAt', 'note']
  const next = { ...profile }
  for (const key of allowed) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key]
  }
  // 改名同样要校验（否则可以「先建短名、再改成超长」绕过 createPatient 的检查）
  if (typeof next.name === 'string') {
    next.name = next.name.trim()
    if (!next.name) {
      const error = new Error('患者姓名不能为空')
      error.code = 'INVALID_INPUT'
      throw error
    }
    if (next.name.length > MAX_NAME_LENGTH) {
      const error = new Error(`患者姓名不能超过 ${MAX_NAME_LENGTH} 个字符`)
      error.code = 'INVALID_INPUT'
      throw error
    }
  }
  next.updatedAt = new Date().toISOString()
  await atomicWriteJson(profilePath(root, patientId), next)

  // 同步 manifest 中的姓名
  if (next.name !== profile.name) {
    const { manifest } = await initRoot(root)
    manifest.patients = (manifest.patients || []).map((p) =>
      p.id === patientId ? { ...p, name: next.name } : p
    )
    await atomicWriteJson(join(root, 'manifest.json'), manifest)
  }
  return next
}

/**
 * 软删除患者（保留目录与数据，仅标记）。
 * **不物理删除**（医疗数据不物理删除，见治理文档 §3.3）。
 */
export async function deletePatient(root, patientId) {
  assertPatientId(patientId)
  await readProfile(root, patientId)
  const { manifest } = await initRoot(root)
  const at = new Date().toISOString()
  manifest.patients = (manifest.patients || []).map((p) =>
    p.id === patientId ? { ...p, deletedAt: at } : p
  )
  await atomicWriteJson(join(root, 'manifest.json'), manifest)
  return { deleted: patientId, deletedAt: at }
}

/**
 * 空间统计（按分类）。 会复用；本处提供基础实现。
 */
export async function computeStats(root) {
  const result = { documents: 0, derived: 0, records: 0, other: 0, total: 0 }

  async function walk(dir, bucket) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.backup-')) continue
        await walk(full, bucket)
      } else if (entry.isFile()) {
        let size = 0
        try {
          size = (await fs.stat(full)).size
        } catch {
          continue
        }
        result[bucket] += size
        result.total += size
      }
    }
  }

  await walk(join(root, 'patients'), 'other')

  // 细分：一份数据可能落在多个 bucket，这里按路径特征归类（简化但可解释）
  const patientsDir = join(root, 'patients')
  let ids = []
  try {
    ids = (await fs.readdir(patientsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return { ...result, computedAt: new Date().toISOString() }
  }

  const detailed = { documents: 0, derived: 0, records: 0, other: 0, total: 0 }
  const add = async (dir, bucket) => {
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await add(full, bucket)
      } else if (entry.isFile()) {
        let size = 0
        try {
          size = (await fs.stat(full)).size
        } catch {
          continue
        }
        detailed[bucket] += size
        detailed.total += size
      }
    }
  }

  for (const id of ids) {
    await add(join(patientsDir, id, 'documents'), 'documents')
    await add(join(patientsDir, id, 'derived'), 'derived')
    for (const f of ['records.jsonl', 'medications.jsonl', 'assessments.jsonl', 'cares.jsonl']) {
      try {
        const size = (await fs.stat(join(patientsDir, id, f))).size
        detailed.records += size
        detailed.total += size
      } catch {
        /* 不存在则跳过 */
      }
    }
  }
  // 其余（manifest / settings / profile 等）
  const known = detailed.documents + detailed.derived + detailed.records
  detailed.other = Math.max(0, result.total - known)
  detailed.total = result.total

  return { ...detailed, computedAt: new Date().toISOString() }
}
