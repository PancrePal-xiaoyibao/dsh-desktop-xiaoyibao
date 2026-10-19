/**
 * 病情评估档案。
 *
 * 五组与原型一致：基本情况 / 诊断与病理 / 治疗经过 / 当前关键指标 / 待补充项。
 * **与临床匹配共用同一模型**——同一份档案，避免两处重复录入
 *。
 *
 * 铁律：
 * · 缺失 ≠ 0：数值字段未填一律 null，绝不落 0；
 * · 所有字段可选，但写入前必须校验类型与上界（回归 P-16：只校验「非空」挡不住超长）；
 * · 数据带 schemaVersion，后续迁移可读旧结构。
 */
import { join } from 'node:path'
import { atomicWriteJson, readJson } from '../store/atomic-write.js'
import { readProfile } from '../store/patients.js'

export const ASSESS_SCHEMA_VERSION = 1
const MAX_TEXT = 200
const MAX_TAG = 60
const MAX_TAGS = 40
const MAX_LINES = 20

const TEXT_KEYS = {
  basic: ['note'],
  diagnosis: ['primary', 'histology', 'stage', 'note'],
  treatment: ['note'],
  keyIndicators: ['note']
}

const emptyProfile = (patientId = null) => ({
  schemaVersion: ASSESS_SCHEMA_VERSION,
  patientId,
  basic: { age: null, sex: null, ecog: null, weightKg: null, heightCm: null, note: '' },
  diagnosis: { primary: '', histology: '', stage: '', gene: [], ihc: [], note: '' },
  treatment: { lines: [], note: '' },
  keyIndicators: { note: '' },
  pending: [],
  updatedAt: null
})

const pathFor = (root, patientId) => join(root, 'patients', patientId, 'assess.json')

const invalid = (message, code = 'INVALID_INPUT') => {
  const error = new Error(message)
  error.code = code
  return error
}

/** 空 / null / undefined → null（缺失≠0）；数字字符串 → 数字；非法 → 抛错。 */
const numberOrNull = (value, label) => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) throw invalid(`${label} 必须是数字`)
  return n
}

/** 文本：去空白 + 上界校验（超长报错，不静默截断）。 */
const text = (value, label, limit = MAX_TEXT) => {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') throw invalid(`${label} 必须是文本`)
  const trimmed = value.trim()
  if (trimmed.length > limit) throw invalid(`${label} 超过 ${limit} 字上限`)
  return trimmed
}

/** 标签数组：字符串数组、逐项上界、总量上界、去重保序。 */
const tags = (value, label) => {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw invalid(`${label} 必须是数组`)
  if (value.length > MAX_TAGS) throw invalid(`${label} 最多 ${MAX_TAGS} 项`)
  const out = []
  for (const item of value) {
    const item_text = text(item, label, MAX_TAG)
    if (item_text && !out.includes(item_text)) out.push(item_text)
  }
  return out
}

const oneOf = (value, allowed, label) => {
  if (value === null || value === undefined || value === '') return null
  const v = String(value)
  if (!allowed.includes(v)) throw invalid(`${label} 取值非法：${v}`)
  return v
}

/**
 * 合并并校验补丁。
 * 只接受已知分组/键；未知键忽略（向前兼容，不炸界面）。
 */
export function mergeAssessProfile(current, patch = {}) {
  const base = current ? { ...current } : emptyProfile()
  const next = {
    ...base,
    basic: { ...base.basic },
    diagnosis: { ...base.diagnosis },
    treatment: { ...base.treatment },
    keyIndicators: { ...base.keyIndicators },
    pending: Array.isArray(base.pending) ? [...base.pending] : []
  }
  const p = patch && typeof patch === 'object' ? patch : {}

  if (p.basic && typeof p.basic === 'object') {
    const b = p.basic
    if ('age' in b) next.basic.age = numberOrNull(b.age, '年龄')
    if (next.basic.age !== null && (next.basic.age < 0 || next.basic.age > 130)) throw invalid('年龄超出合理范围')
    if ('sex' in b) next.basic.sex = oneOf(b.sex, ['male', 'female'], '性别')
    if ('ecog' in b) {
      next.basic.ecog = numberOrNull(b.ecog, 'ECOG')
      if (next.basic.ecog !== null && (next.basic.ecog < 0 || next.basic.ecog > 4)) throw invalid('ECOG 应在 0–4')
    }
    if ('weightKg' in b) {
      next.basic.weightKg = numberOrNull(b.weightKg, '体重')
      if (next.basic.weightKg !== null && (next.basic.weightKg <= 0 || next.basic.weightKg > 300)) throw invalid('体重超出合理范围')
    }
    if ('heightCm' in b) {
      next.basic.heightCm = numberOrNull(b.heightCm, '身高')
      if (next.basic.heightCm !== null && (next.basic.heightCm <= 0 || next.basic.heightCm > 260)) throw invalid('身高超出合理范围')
    }
    if ('note' in b) next.basic.note = text(b.note, '基本情况备注')
  }

  if (p.diagnosis && typeof p.diagnosis === 'object') {
    const d = p.diagnosis
    for (const key of TEXT_KEYS.diagnosis) if (key in d) next.diagnosis[key] = text(d[key], `诊断·${key}`, key === 'note' ? MAX_TEXT : 120)
    if ('gene' in d) next.diagnosis.gene = tags(d.gene, '基因（分子特征）')
    if ('ihc' in d) next.diagnosis.ihc = tags(d.ihc, '病理 / 免疫组化')
  }

  if (p.treatment && typeof p.treatment === 'object') {
    const t = p.treatment
    if ('note' in t) next.treatment.note = text(t.note, '治疗经过备注')
    if ('lines' in t) {
      if (!Array.isArray(t.lines)) throw invalid('治疗线数必须是数组')
      if (t.lines.length > MAX_LINES) throw invalid(`治疗线数最多 ${MAX_LINES} 条`)
      next.treatment.lines = t.lines.map((line, index) => {
        if (!line || typeof line !== 'object') throw invalid(`第 ${index + 1} 条治疗记录必须是对象`)
        return {
          line: text(line.line, `第 ${index + 1} 条·线数`, 20),
          name: text(line.name, `第 ${index + 1} 条·方案名`, 120),
          startedAt: text(line.startedAt, `第 ${index + 1} 条·开始日期`, 20),
          endedAt: text(line.endedAt, `第 ${index + 1} 条·结束日期`, 20),
          note: text(line.note, `第 ${index + 1} 条·备注`, MAX_TEXT)
        }
      })
    }
  }

  if (p.keyIndicators && typeof p.keyIndicators === 'object') {
    if ('note' in p.keyIndicators) next.keyIndicators.note = text(p.keyIndicators.note, '关键指标备注')
  }

  if ('pending' in p) next.pending = tags(p.pending, '待补充项')

  next.schemaVersion = ASSESS_SCHEMA_VERSION
  next.updatedAt = new Date().toISOString()
  return next
}

/** 读评估档案（不存在时返回空结构，不写盘）。 */
export async function readAssess(root, patientId) {
  await readProfile(root, patientId)
  const raw = await readJson(pathFor(root, patientId), null)
  if (!raw || typeof raw !== 'object') return emptyProfile(patientId)
  const merged = mergeAssessProfile(emptyProfile(patientId), raw)
  return { ...merged, patientId, updatedAt: raw.updatedAt ?? null }
}

/** 写评估档案（局部合并 + 校验 + 原子写）。 */
export async function updateAssess(root, patientId, patch) {
  await readProfile(root, patientId)
  const current = await readAssess(root, patientId)
  const next = mergeAssessProfile(current, patch)
  const saved = { ...next, patientId }
  await atomicWriteJson(pathFor(root, patientId), saved)
  return saved
}
