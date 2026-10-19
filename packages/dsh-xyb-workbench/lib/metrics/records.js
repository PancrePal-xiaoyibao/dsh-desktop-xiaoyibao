/**
 * 指标记录写入。 SPEC §4.2 数据契约。
 *
 * 写入规则（治理文档 §3.3）：
 * - 缺失值用 null，**禁止用 0 代替**
 * - 每条记录必须带：来源 / 核对状态 / 原始值 / 记录时间
 * - 删除是软删除（追加 tombstone，不物理删）
 * - 单位随数据（不在展示层硬编码）
 */
import { randomUUID } from 'node:crypto'
import { appendRecord, appendDelete } from '../store/jsonl.js'
import { streamPath } from '../store/patients.js'
import { readProfile } from '../store/patients.js'

export const REVIEW_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  DOUBTED: 'doubted'
})

function assertPatient(root, patientId) {
  return readProfile(root, patientId) // 不存在会抛 NOT_FOUND
}

/**
 * 规范化数值：**null 保持 null（= 未测量），不得变成 0**。
 */
function normalizeValue(input) {
  if (input === null || input === undefined || input === '') return null
  const num = Number(input)
  return Number.isFinite(num) ? num : null
}

/**
 * 手工录入一条指标记录 → **直接 confirmed**（因为是人自己输入的）。
 *
 * 与「机器抽取」的区别：
 * 机器抽取 → pending（必须经核对闸门）
 * 手工录入 → confirmed（人已经是来源）
 */
export async function addManualRecord(root, patientId, input) {
  await assertPatient(root, patientId)

  const indicator = typeof input?.indicator === 'string' ? input.indicator.trim() : ''
  if (!indicator) {
    const error = new Error('指标名不能为空')
    error.code = 'INVALID_INPUT'
    throw error
  }
  const measuredAt = typeof input?.measuredAt === 'string' ? input.measuredAt : null
  if (!measuredAt || !/^\d{4}-\d{2}-\d{2}$/.test(measuredAt)) {
    const error = new Error('测量日期格式应为 YYYY-MM-DD')
    error.code = 'INVALID_INPUT'
    throw error
  }

  const now = new Date().toISOString()
  const record = {
    id: `r-${randomUUID().slice(0, 8)}`,
    patientId,
    indicator,
    value: normalizeValue(input?.value),
    unit: input?.unit ?? null,
    refLow: normalizeValue(input?.refLow),
    refHigh: normalizeValue(input?.refHigh),
    measuredAt,
    source: {
      kind: 'manual',
      documentId: null,
      pageNo: null,
      fieldId: null,
      rawText: null,
      extractedValue: null,
      extractedUnit: null
    },
    review: {
      status: REVIEW_STATUS.CONFIRMED,
      reviewedAt: now,
      edited: false
    },
    createdAt: now,
    updatedAt: now
  }

  await appendRecord(streamPath(root, patientId, 'records'), record)
  return record
}

/**
 * 由核对流程确认一条机器抽取项 → 生成 confirmed 记录。
 *
 * 这是**唯一**把机器抽取数据转为正式记录的入口（人工闸门）。
 *
 * ⚠️ 入参必须校验（真实缺口，2026-10-15 数据层测试发现）：
 * 之前直接解引用 `extraction.value`，传 `null` / 字符串会抛原生 TypeError；
 * 而 `indicator` 一旦缺失就会**静默**造出一条 indicator=undefined 的记录
 * 进入正式数据，且无法从界面上识别与清理。必须 fail-closed。
 */
export async function confirmExtraction(root, patientId, extraction, decision = {}) {
  await assertPatient(root, patientId)

  if (!extraction || typeof extraction !== 'object') {
    const error = new Error('待确认项必项是对象')
    error.code = 'INVALID_INPUT'
    throw error
  }
  const indicator = decision.indicator ?? extraction.indicator
  if (typeof indicator !== 'string' || !indicator.trim()) {
    const error = new Error('待确认项缺少指标名')
    error.code = 'INVALID_INPUT'
    throw error
  }

  const now = new Date().toISOString()

  const finalValue =
    decision.value !== undefined ? normalizeValue(decision.value) : normalizeValue(extraction.value)
  const edited =
    decision.value !== undefined && normalizeValue(extraction.value) !== finalValue

  const record = {
    // ⚠️ **复用抽取项的 id（若提供）** —— 确认是「就地结清」，不是另造一条。
    //
    // 真实缺陷（2026-10-15 数据层测试发现）：
    // 原实现每次生成新 id，于是确认一条抽取项后，事件流里同时存在
    // ① 原 pending 项（id 不变，status 仍是 pending）
    // ② 新建的 confirmed 项
    // → `listPending` / `listUnresolved` **仍会列出 ①**，用户看到同一条待办
    // 永远清不掉（每点一次「确认」就多一条重复数据，待办还不消失）。
    //
    // 复用 id 后：同一 id 在流里折叠成一条，状态从 pending 变 confirmed，
    // 待办自动消失、也不产生重复。与 `markDoubted`（同样按 id 就地改写）
    // 的设计保持一致。
    id:
      typeof extraction.id === 'string' && extraction.id.trim()
        ? extraction.id
        : `r-${randomUUID().slice(0, 8)}`,
    patientId,
    indicator: indicator.trim(),
    value: finalValue,
    unit: decision.unit ?? extraction.unit ?? null,
    refLow: normalizeValue(decision.refLow ?? extraction.refLow),
    refHigh: normalizeValue(decision.refHigh ?? extraction.refHigh),
    measuredAt: decision.measuredAt ?? extraction.measuredAt ?? extraction.pageDate ?? null,
    source: {
      kind: 'document',
      documentId: extraction.documentId ?? null,
      pageNo: extraction.pageNo ?? null,
      fieldId: extraction.id ?? null,
      rawText: extraction.rawText ?? null,
      // **保留机器原始抽取值**（即使被人工改过）—— 溯源要求
      extractedValue: normalizeValue(extraction.value),
      extractedUnit: extraction.unit ?? null
    },
    review: {
      status: REVIEW_STATUS.CONFIRMED,
      reviewedAt: now,
      edited
    },
    createdAt: now,
    updatedAt: now
  }

  await appendRecord(streamPath(root, patientId, 'records'), record)
  return record
}

/**
 * 标记一条抽取项为存疑（不生成正式记录）。
 */
export async function markDoubted(root, patientId, extractionId, note = '') {
  await assertPatient(root, patientId)
  const now = new Date().toISOString()
  const marker = {
    id: extractionId,
    patientId,
    indicator: '__doubt_marker__',
    value: null,
    unit: null,
    refLow: null,
    refHigh: null,
    measuredAt: now.slice(0, 10),
    source: { kind: 'document', fieldId: extractionId, rawText: note },
    review: { status: REVIEW_STATUS.DOUBTED, reviewedAt: now, edited: false },
    createdAt: now,
    updatedAt: now
  }
  await appendRecord(streamPath(root, patientId, 'records'), marker)
  return marker
}

/**
 * 软删除一条记录。
 */
export async function removeRecord(root, patientId, recordId) {
  await assertPatient(root, patientId)
  await appendDelete(streamPath(root, patientId, 'records'), recordId)
  return { deleted: recordId }
}
