/**
 * 心理支持数据。
 *
 * 两条医学红线在本模块先落地，任何后续改动不得破坏：
 * · **M-3 不解读量表**：这里只存分数；`cutoffs` 一律为 null，页面也不得出现
 * 「说明你属于中度…」类解读。官方分界的核对与展示归 （UQ-1103）。
 * · **M-5 危机兜底**：危机资源（热线）是数据，不是可选项 —— 客户端每个心理子页
 * 都必须渲染它（有对应的红线测试钉住）。
 */
import { randomUUID } from 'node:crypto'
import { appendRecord, readJsonl } from '../store/jsonl.js'
import { streamPath, readProfile } from '../store/patients.js'

/** 量表清单（分数上限来自量表题数与每题的取值；分界不在本模块给）。 */
export const PSYCH_SCALES = Object.freeze([
  { id: 'PHQ-9', name: 'PHQ-9（抑郁，9 题）', min: 0, max: 27, cutoffs: null, note: '分界标准待核对官方来源后展示' },
  { id: 'GAD-7', name: 'GAD-7（焦虑，7 题）', min: 0, max: 21, cutoffs: null, note: '分界标准待核对官方来源后展示' },
  { id: 'DT', name: 'DT（心理痛苦温度计，0–10）', min: 0, max: 10, cutoffs: null, note: '分界标准待核对官方来源后展示' },
  { id: 'HADS', name: 'HADS（医院焦虑抑郁量表，14 题）', min: 0, max: 42, cutoffs: null, note: '分界标准待核对官方来源后展示' }
])

const MAX_NOTE = 200
const invalid = (message, code = 'INVALID_INPUT') => {
  const error = new Error(message)
  error.code = code
  return error
}

const scaleOf = (id) => PSYCH_SCALES.find((scale) => scale.id === id) || null

/** 读数列表（按时间正序）。 */
export async function listPsychScores(root, patientId) {
  await readProfile(root, patientId)
  const { items } = await readJsonl(streamPath(root, patientId, 'psych'))
  return { items: [...items].sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt))) }
}

/** 录入一条量表读数（不解读，只存分）。 */
export async function addPsychScore(root, patientId, body = {}) {
  await readProfile(root, patientId)
  const scale = scaleOf(String(body.scale || ''))
  if (!scale) throw invalid('未知量表')
  const score = Number(body.score)
  if (!Number.isFinite(score)) throw invalid('分数必须是数字')
  if (score < scale.min || score > scale.max) throw invalid(`${scale.id} 分数应在 ${scale.min}–${scale.max}`)
  const takenAt = String(body.takenAt || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(takenAt)) throw invalid('日期格式应为 YYYY-MM-DD')
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (note.length > MAX_NOTE) throw invalid(`备注超过 ${MAX_NOTE} 字上限`)

  const now = new Date().toISOString()
  const record = {
    id: `ps-${randomUUID().slice(0, 8)}`,
    patientId,
    scale: scale.id,
    score,
    takenAt,
    note,
    // 明确记下：这条记录只代表分数，本产品不对它做解读
    interpretation: null,
    createdAt: now
  }
  await appendRecord(streamPath(root, patientId, 'psych'), record)
  return record
}
