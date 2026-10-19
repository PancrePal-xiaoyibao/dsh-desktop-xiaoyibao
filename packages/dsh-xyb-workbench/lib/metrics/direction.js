/**
 * 指标方向语义。**本项目核心机制之一**。
 *
 * 硬约束：
 * 颜色由「指标方向」决定，**不由箭头方向决定**。
 * 同一个 ↑ 箭头：白蛋白上升是绿（好事），CA19-9 上升是红（坏事）。
 *
 * 三态：
 * up_good 上升为改善 —— ↑ 绿 / ↓ 红
 * down_good 下降为改善 —— ↓ 绿 / ↑ 红
 * range 维持区间 —— 在区间内绿，越界需关注
 *
 * 缺失方向（目录中无该指标）→ tone = 'unknown'，**不参与警示推导**。
 */

/** 判定阈值：变化量绝对值小于该比例视为「持平」（避免浮点噪音） */
const FLAT_RATIO = 1e-9

/**
 * 计算变化方向。
 * @param {number|null} prev 上一次值
 * @param {number|null} curr 本次值
 * @returns {'up'|'down'|'flat'|'unknown'}
 */
export function deltaDirection(prev, curr) {
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return 'unknown'
  const diff = curr - prev
  const scale = Math.max(Math.abs(prev), Math.abs(curr), FLAT_RATIO)
  if (Math.abs(diff) / scale < FLAT_RATIO) return 'flat'
  return diff > 0 ? 'up' : 'down'
}

/**
 * 值是否落在参考区间内。区间缺失时返回 null（未知）。
 */
export function inRange(value, refLow, refHigh) {
  if (!Number.isFinite(value)) return null
  if (!Number.isFinite(refLow) && !Number.isFinite(refHigh)) return null
  if (Number.isFinite(refLow) && value < refLow) return false
  if (Number.isFinite(refHigh) && value > refHigh) return false
  return true
}

/**
 * **核心函数**：由指标方向 + 变化 + 参考范围推导色调。
 *
 * @param {'up_good'|'down_good'|'range'|null} direction 指标方向语义
 * @param {'up'|'down'|'flat'|'unknown'} delta 变化方向
 * @param {number|null} value 当前值
 * @param {number|null} refLow
 * @param {number|null} refHigh
 * @returns {'good'|'watch'|'alert'|'neutral'|'unknown'}
 */
export function toneFor(direction, delta, value, refLow = null, refHigh = null) {
  // 无方向语义 → 待定，不参与警示推导
  if (direction !== 'up_good' && direction !== 'down_good' && direction !== 'range') return 'unknown'

  // 值缺失 → 待定
  if (!Number.isFinite(value)) return 'unknown'

  if (direction === 'range') {
    const inside = inRange(value, refLow, refHigh)
    if (inside === null) return 'neutral' // 无参考区间，无法判定
    return inside ? 'good' : 'watch'
  }

  // 变化未知（只有单次记录）→ 用参考范围给出保守判定
  if (delta === 'unknown') {
    const inside = inRange(value, refLow, refHigh)
    if (inside === null) return 'neutral'
    if (inside) return 'good'
    // 方向已知 + 当前值越界 → 需关注（不给 alert，因为不知道趋势）
    return 'watch'
  }

  if (delta === 'flat') return 'neutral'

  if (direction === 'up_good') {
    return delta === 'up' ? 'good' : 'alert'
  }
  // down_good
  return delta === 'down' ? 'good' : 'alert'
}

/**
 * 色调 → 中文标签（界面用；不单靠颜色区分，必须同时有文字）。
 */
export const TONE_LABEL = Object.freeze({
  good: '良好',
  watch: '需关注',
  alert: '异常',
  neutral: '持平',
  unknown: '待定'
})
