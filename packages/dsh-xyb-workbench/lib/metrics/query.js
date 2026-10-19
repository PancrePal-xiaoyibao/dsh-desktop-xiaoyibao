/**
 * 指标记录查询。** SPEC ADR-06 —— 人工闸门在此强制**。
 *
 * 三层强制：
 * ① 数据层写入时必带 review.status（见 records.js）
 * ② **查询层默认过滤 status === 'confirmed'**（本文件）
 * ③ 自动化测试断言所有下游查询零未确认数据
 *
 * 契约：
 * - `listRecords(...)` → 默认安全，只返回已确认
 * - `listRecordsIncludingUnverified(...)` → 显式越权，名字自带警示
 *
 * ⚠️ 新增任何返回指标数据的函数，**必须**默认过滤。
 * 如需返回未确认，函数名**必须**含 `IncludingUnverified`。
 * 代码评审检查项见此约定（治理文档 §8.3）。
 */
import { readJsonl } from '../store/jsonl.js'
import { streamPath } from '../store/patients.js'

/** 已确认过滤器（唯一真源） */
export const CONFIRMED_ONLY = (record) => record?.review?.status === 'confirmed'

function matchesFilter(record, filter) {
  if (!filter) return true
  if (filter.indicator && record.indicator !== filter.indicator) return false
  if (filter.indicators && Array.isArray(filter.indicators) && !filter.indicators.includes(record.indicator)) {
    return false
  }
  if (filter.from && record.measuredAt && record.measuredAt < filter.from) return false
  if (filter.to && record.measuredAt && record.measuredAt > filter.to) return false
  if (filter.documentId && record.source?.documentId !== filter.documentId) return false
  return true
}

/**
 * 显式越权：返回全部记录（含 pending / doubted）。
 *
 * **仅允许核对界面使用。** 名字自带警示，便于评审时一眼识别。
 *
 * @param {string} root 数据根
 * @param {string} patientId
 * @param {object} [filter]
 * @returns {Promise<{ items: object[], malformedLines: number }>}
 */
export async function listRecordsIncludingUnverified(root, patientId, filter = {}) {
  const { items, malformedLines } = await readJsonl(streamPath(root, patientId, 'records'))
  const filtered = items.filter((record) => matchesFilter(record, filter))
  filtered.sort((a, b) => String(a.measuredAt || '').localeCompare(String(b.measuredAt || '')))
  return { items: filtered, malformedLines }
}

/**
 * **默认安全**：只返回已确认记录。
 *
 * 所有下游（趋势 / 看板 / 营养 / 匹配 / 导出）**必须**走这个函数。
 *
 * @returns {Promise<{ items: object[], malformedLines: number }>}
 */
export async function listRecords(root, patientId, filter = {}) {
  const { items, malformedLines } = await listRecordsIncludingUnverified(root, patientId, filter)
  return { items: items.filter(CONFIRMED_ONLY), malformedLines }
}

/**
 * 待核对清单（核对界面的数据源，**显式**使用越权查询）。
 *
 * ⚠️ **只返回 status === 'pending'**（“等我确认的机器抽取项”）。
 * 被标为存疑的项（doubted）**不在这个函数里** —— 它们在
 * `listUnresolved`（见下），因为“存疑”不是“待确认”，两者处理动作不同。
 */
export async function listPending(root, patientId) {
  const { items, malformedLines } = await listRecordsIncludingUnverified(root, patientId)
  return { items: items.filter((r) => r?.review?.status === 'pending'), malformedLines }
}

/**
 * **未结清清单**：既未被确认为正式数据、也未被丢弃的所有条目。
 *
 * ── 为什么必须有这个函数（真实缺陷，2026-10-15 数据层测试发现）──────
 * `markDoubted` 会写入一条 `status='doubted'` 的记录。而 `listPending`
 * 只取 `status='pending'` —— 于是被标存疑的项：
 * · 不在 `listRecords`（只给已确认）→ 界面上看不到
 * · 也不在 `listPending`（只给 pending）→ 核对队列里也看不到
 * **两头都不在，用户彻底失去这条数据的线索**（既不是正式数据、也不在待办里）。
 * 对医疗数据而言这是“静默丢数据”，比报错严重。
 *
 * 用途：核对界面应该展示 `listUnresolved`，让用户能看到并了结每一条：
 * 确认（confirmExtraction）或丢弃（removeRecord）。
 *
 * @returns {Promise<{ items: object[], malformedLines: number }>}
 * items 中的每项都带 `review.status`，调用方可据此区分“待确认”与“已存疑”。
 */
export async function listUnresolved(root, patientId) {
  const { items, malformedLines } = await listRecordsIncludingUnverified(root, patientId)
  return {
    items: items.filter((r) => r?.review?.status !== 'confirmed'),
    malformedLines
  }
}

/**
 * 取某指标的最新已确认记录。
 */
export async function latestRecord(root, patientId, indicator) {
  const { items } = await listRecords(root, patientId, { indicator })
  return items.length ? items[items.length - 1] : null
}

/**
 * 指标序列（趋势图数据源）。**走闸门**。
 *
 * @returns {Promise<Record<string, Array<{ at: string, value: number }>>>}
 */
export async function listSeries(root, patientId, filter = {}) {
  const { items } = await listRecords(root, patientId, filter)
  const out = {}
  for (const record of items) {
    if (!Number.isFinite(record.value)) continue // 缺失值不插点（PRD：不插值）
    if (!out[record.indicator]) out[record.indicator] = []
    out[record.indicator].push({ at: record.measuredAt, value: record.value, unit: record.unit ?? null })
  }
  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => String(a.at).localeCompare(String(b.at)))
  }
  return out
}
