/**
 * 看板聚合。 SPEC §4.6。
 *
 * 七维度：基本体能 / 治疗情况 / 可匹配临床 / 营养 / 心理 / 并发症 / 毒性。
 *
 * **本期实现范围（诚实声明）**：
 * fitness 可由 ECOG 推导（ECOG 来自入组档案，本期可能缺失）
 * treatment 可由用药记录推导
 * nutrition 可由体重趋势推导
 * match 恒 unk（匹配在 ）
 * psych 恒 unk（量表在 ）
 * comorbidity 恒 unk（在 ）
 * toxicity 恒 unk（在 ）
 *
 * **未实现维度必须如实说明原因，不得伪造数据**（PRD US-125 / 原则三）。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { listRecords, listSeries } from '../metrics/query.js'
import { readJsonl } from '../store/jsonl.js'
import { streamPath, readProfile } from '../store/patients.js'

const HERE = dirname(fileURLToPath(import.meta.url))
let cachedRules = null

/** 读看板规则（阈值入数据文件，改阈值不改代码） */
export async function loadBoardRules() {
  if (cachedRules) return cachedRules
  cachedRules = JSON.parse(await readFile(join(HERE, 'board-rules.json'), 'utf8'))
  return cachedRules
}

export const DIMENSION_ORDER = Object.freeze([
  'fitness',
  'treatment',
  'match',
  'nutrition',
  'psych',
  'comorbidity',
  'toxicity'
])

export const DIMENSION_LABEL = Object.freeze({
  fitness: '基本体能',
  treatment: '治疗情况',
  match: '可匹配临床',
  nutrition: '营养',
  psych: '心理',
  comorbidity: '并发症',
  toxicity: '毒性'
})

/**
 * 维度 → 页签跳转目标。
 * 页签 key 与客户端 TABS 一致；未实现页跳过去是诚实占位，不影响跳转本身。
 */
export const DIMENSION_PAGE = Object.freeze({
  fitness: 'records',
  treatment: 'records',
  match: 'match',
  nutrition: 'nutrition',
  psych: 'psych',
  comorbidity: 'care',
  toxicity: 'care'
})

/**
 * 全程管理四类（原型 dashHTML 的「全程管理」区块）。
 * 有数据源的两类取维度状态；带管 / 血管通路等 落地前如实为空。
 */
export const CARE_ITEMS = Object.freeze([
  { key: 'toxicity', label: '毒性', dim: 'toxicity' },
  { key: 'comorbidity', label: '并发症', dim: 'comorbidity' },
  { key: 'tube', label: '带管', dim: null, pending: '后续版本' },
  { key: 'vascular', label: '血管通路', dim: null, pending: '后续版本' }
])

const UNK = (note) => ({ lv: 'unk', value: '未评估', note })

function daysBetween(a, b) {
  const t1 = Date.parse(a)
  const t2 = Date.parse(b)
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null
  return Math.round((t2 - t1) / 86400000)
}

/**
 * 营养维度：由体重趋势推导（走闸门）。
 */
async function computeNutrition(root, patientId, rules) {
  const series = await listSeries(root, patientId, { indicator: 'WEIGHT' })
  const points = series.WEIGHT || []
  if (!points.length) return UNK('尚无身高体重记录')

  const latest = points[points.length - 1]
  const windowDays = rules.weight.windowDays
  const cutoff = new Date(Date.parse(latest.at) - windowDays * 86400000).toISOString().slice(0, 10)
  const baseline = [...points].reverse().find((p) => p.at <= cutoff) || points[0]

  const span = daysBetween(baseline.at, latest.at)
  if (!span || span < 7 || !Number.isFinite(baseline.value) || baseline.value <= 0) {
    return {
      lv: 'good',
      value: `${latest.value} kg`,
      note: `最近一次体重 ${latest.value} kg（${latest.at}）。记录间隔较短，暂不评估趋势。`
    }
  }

  const dropPercent = ((baseline.value - latest.value) / baseline.value) * 100
  if (dropPercent >= rules.weight.alertPercentDrop) {
    return {
      lv: 'alert',
      value: `${latest.value} kg`,
      note: `近 ${span} 天体重下降 ${dropPercent.toFixed(1)}%（阈值 ${rules.weight.alertPercentDrop}%）。`
    }
  }
  if (dropPercent >= rules.weight.watchPercentDrop) {
    return {
      lv: 'watch',
      value: `${latest.value} kg`,
      note: `近 ${span} 天体重下降 ${dropPercent.toFixed(1)}%（阈值 ${rules.weight.watchPercentDrop}%）。`
    }
  }
  return {
    lv: 'good',
    value: `${latest.value} kg`,
    note: `近 ${span} 天体重变化 ${dropPercent >= 0 ? '下降' : '上升'} ${Math.abs(dropPercent).toFixed(1)}%。`
  }
}

/**
 * 治疗维度：由用药记录推导。
 */
async function computeTreatment(root, patientId) {
  const { items } = await readJsonl(streamPath(root, patientId, 'medications'))
  if (!items.length) return UNK('尚无治疗记录')

  const ongoing = items.filter((m) => !m.endedAt)
  const lastEnded = items
    .filter((m) => m.endedAt)
    .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))[0]

  if (ongoing.length) {
    const current = ongoing[ongoing.length - 1]
    return {
      lv: 'good',
      value: current.line ? `${current.line}：${current.name}` : current.name,
      note: `当前方案 ${current.name}，自 ${current.startedAt} 起。`
    }
  }
  if (lastEnded) {
    const reason = lastEnded.endReason === 'progression' ? '疾病进展' : lastEnded.endReason || '已结束'
    return {
      lv: 'watch',
      value: lastEnded.line ? `${lastEnded.line}：${lastEnded.name}` : lastEnded.name,
      note: `最近方案 ${lastEnded.name} 已于 ${lastEnded.endedAt} 结束（${reason}）。`
    }
  }
  return UNK('尚无治疗记录')
}

/**
 * 基本体能维度：需 ECOG（来自入组档案，）。本期通常缺失。
 */
function computeFitness(coverage, rules) {
  const ecog = coverage?.ecog?.value
  if (!Number.isFinite(ecog)) return UNK('尚无体能记录')
  if (ecog <= rules.ecog.goodMax) return { lv: 'good', value: `ECOG ${ecog}`, note: `ECOG ${ecog}，体能良好。` }
  if (ecog <= rules.ecog.watchMax) return { lv: 'watch', value: `ECOG ${ecog}`, note: `ECOG ${ecog}，体能受限。` }
  return { lv: 'alert', value: `ECOG ${ecog}`, note: `ECOG ${ecog}，体能明显受限。` }
}

/**
 * 聚合看板。
 *
 * @param {string} root
 * @param {string} patientId
 * @param {object} [options] { coverage } 由 提供；本期可为 null
 */
export async function buildBoard(root, patientId, options = {}) {
  await readProfile(root, patientId)
  const rules = await loadBoardRules()
  const coverage = options.coverage || null

  const dimensions = {
    fitness: computeFitness(coverage, rules),
    treatment: await computeTreatment(root, patientId),
    // 以下四项在对应 CHG 落地前恒为 unk，原因来自数据文件（不得伪造）
    match: UNK(rules.unimplementedNote.match),
    nutrition: await computeNutrition(root, patientId, rules),
    psych: UNK(rules.unimplementedNote.psych),
    comorbidity: UNK(rules.unimplementedNote.comorbidity),
    toxicity: UNK(rules.unimplementedNote.toxicity)
  }

  const alertN = DIMENSION_ORDER.filter((k) => dimensions[k].lv === 'alert').length
  const watchN = DIMENSION_ORDER.filter((k) => dimensions[k].lv === 'watch').length
  const unkN = DIMENSION_ORDER.filter((k) => dimensions[k].lv === 'unk').length
  const total = rules.completeness.total

  let verdict
  if (alertN > 0) verdict = { lv: 'alert', text: `${alertN} 项警示` }
  else if (watchN > 0) verdict = { lv: 'watch', text: `${watchN} 项需关注` }
  else if (unkN === total) verdict = { lv: 'unk', text: '尚无资料' }
  else verdict = { lv: 'good', text: '未见警示项' }

  const have = total - unkN

  // 跨维度需关注项汇总（原型「需关注项」区块）：只汇总已有数据得出的 watch/alert，
  // 不推测、不补数据；每条带跳转目标与一句事实陈述。
  const watch = DIMENSION_ORDER.filter((k) => dimensions[k].lv === 'watch' || dimensions[k].lv === 'alert').map(
    (k) => ({
      key: k,
      label: DIMENSION_LABEL[k],
      lv: dimensions[k].lv,
      value: dimensions[k].value,
      note: dimensions[k].note,
      page: DIMENSION_PAGE[k]
    })
  )

  // 全程管理摘要（原型「全程管理」区块）：四类，未实现的类目带归属说明
  const careDigest = CARE_ITEMS.map((item) => {
    if (!item.dim) {
      return {
        key: item.key,
        label: item.label,
        lv: 'unk',
        detail: `${item.label}管理尚未提供，当前为空`,
        page: 'care'
      }
    }
    return {
      key: item.key,
      label: item.label,
      lv: dimensions[item.dim].lv,
      detail: dimensions[item.dim].note,
      page: DIMENSION_PAGE[item.dim]
    }
  })

  return {
    patientId,
    verdict,
    dimensions,
    watch,
    careDigest,
    completeness: { have, total, missing: DIMENSION_ORDER.filter((k) => dimensions[k].lv === 'unk') },
    computedAt: new Date().toISOString()
  }
}
