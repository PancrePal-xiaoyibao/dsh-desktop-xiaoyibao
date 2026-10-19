/**
 * 方向语义矩阵测试 —— **本项目核心机制之一**。
 *
 * 硬要求（SPEC §7.2）：**3 方向 × 3 变化 = 9 组合全断言**。
 *
 * 这条测试如果红了，说明「颜色由箭头方向决定」的 bug 又回来了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toneFor, deltaDirection, inRange } from '../../lib/metrics/direction.js'

// ───────────────────────────── 核心：9 组合矩阵

test('方向语义矩阵：up_good（上升为改善）', () => {
  // 白蛋白、体重
  assert.equal(toneFor('up_good', 'up', 45), 'good', '↑ 应为良好')
  assert.equal(toneFor('up_good', 'flat', 40), 'neutral', '持平为中性')
  assert.equal(toneFor('up_good', 'down', 35), 'alert', '↓ 应为异常')
})

test('方向语义矩阵：down_good（下降为改善）', () => {
  // CA19-9、总胆红素、CRP
  assert.equal(toneFor('down_good', 'up', 200), 'alert', '↑ 应为异常')
  assert.equal(toneFor('down_good', 'flat', 100), 'neutral', '持平为中性')
  assert.equal(toneFor('down_good', 'down', 50), 'good', '↓ 应为良好')
})

test('方向语义矩阵：range（维持区间）', () => {
  // BMI（参考 18.5–24.0）
  assert.equal(toneFor('range', 'up', 22, 18.5, 24.0), 'good', '区间内为良好')
  assert.equal(toneFor('range', 'flat', 22, 18.5, 24.0), 'good', '区间内为良好')
  assert.equal(toneFor('range', 'down', 22, 18.5, 24.0), 'good', '区间内为良好')
  assert.equal(toneFor('range', 'up', 25, 18.5, 24.0), 'watch', '越界为需关注')
  assert.equal(toneFor('range', 'down', 17, 18.5, 24.0), 'watch', '越界为需关注')
})

test('方向语义矩阵：同一箭头方向在不同指标上呈现相反颜色（关键断言）', () => {
  // 这是本机制的核心：不能只看箭头
  const upOnUpGood = toneFor('up_good', 'up', 45)
  const upOnDownGood = toneFor('down_good', 'up', 200)
  assert.notEqual(upOnUpGood, upOnDownGood, '同一 ↑ 在不同指标上必须不同色')
  assert.equal(upOnUpGood, 'good')
  assert.equal(upOnDownGood, 'alert')

  const downOnUpGood = toneFor('up_good', 'down', 35)
  const downOnDownGood = toneFor('down_good', 'down', 50)
  assert.notEqual(downOnUpGood, downOnDownGood, '同一 ↓ 在不同指标上必须不同色')
  assert.equal(downOnUpGood, 'alert')
  assert.equal(downOnDownGood, 'good')
})

// ───────────────────────────── 缺失与边界

test('缺失方向 → unknown（不参与警示推导）', () => {
  assert.equal(toneFor(null, 'up', 10), 'unknown')
  assert.equal(toneFor('unknown-direction', 'up', 10), 'unknown')
})

test('缺失值 → unknown（不当作 0）', () => {
  assert.equal(toneFor('up_good', 'up', null), 'unknown')
  assert.equal(toneFor('up_good', 'up', undefined), 'unknown')
  assert.equal(toneFor('down_good', 'flat', NaN), 'unknown')
})

test('单次记录（变化未知）+ 值越界 → watch（保守，不给 alert）', () => {
  assert.equal(toneFor('down_good', 'unknown', 200, 0, 37), 'watch', '越界但不知趋势 → 需关注')
  assert.equal(toneFor('down_good', 'unknown', 10, 0, 37), 'good', '区间内 → 良好')
})

test('无参考区间 + range 方向 → neutral（无法判定）', () => {
  assert.equal(toneFor('range', 'up', 22, null, null), 'neutral')
})

// ───────────────────────────── 变化方向判定

test('deltaDirection 基本行为', () => {
  assert.equal(deltaDirection(100, 120), 'up')
  assert.equal(deltaDirection(120, 100), 'down')
  assert.equal(deltaDirection(100, 100), 'flat')
  assert.equal(deltaDirection(null, 100), 'unknown')
  assert.equal(deltaDirection(100, null), 'unknown')
})

test('deltaDirection 对浮点噪音不敏感', () => {
  // 极小相对变化视为持平
  assert.equal(deltaDirection(1e6, 1e6 + 1e-9), 'flat')
})

test('inRange 边界（含端点）', () => {
  assert.equal(inRange(18.5, 18.5, 24.0), true, '下界含')
  assert.equal(inRange(24.0, 18.5, 24.0), true, '上界含')
  assert.equal(inRange(18.4, 18.5, 24.0), false)
  assert.equal(inRange(24.1, 18.5, 24.0), false)
  assert.equal(inRange(NaN, 18.5, 24.0), null, '缺失值 → null（未知）')
  assert.equal(inRange(10, null, null), null, '无区间 → null')
})

// ───────────────────────────── 组合覆盖度自检

test('9 组合矩阵完整性自检（防止有人漏改一侧）', () => {
  const directions = ['up_good', 'down_good']
  const deltas = ['up', 'flat', 'down']
  const seen = new Map()
  for (const d of directions) {
    for (const delta of deltas) {
      const tone = toneFor(d, delta, 10)
      seen.set(`${d}|${delta}`, tone)
      assert.ok(['good', 'watch', 'alert', 'neutral'].includes(tone), `${d}|${delta} 应产出有效色调`)
    }
  }
  // 对称性：up_good 与 down_good 的 up/down 结果应互为相反
  assert.equal(seen.get('up_good|up'), 'good')
  assert.equal(seen.get('down_good|up'), 'alert')
  assert.equal(seen.get('up_good|down'), 'alert')
  assert.equal(seen.get('down_good|down'), 'good')
  // 持平两侧一致
  assert.equal(seen.get('up_good|flat'), seen.get('down_good|flat'))
})
