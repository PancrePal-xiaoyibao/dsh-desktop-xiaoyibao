/**
 * 「发布版仓库形态」判定。
 *
 * 背景：社区发行版公开发布时，仓库里**不跟踪**开发中间物（`vendor/` 上游源码、`tasks/` 立项文档）。
 * 于是「在开发者机器上必须全绿」的那些检查项，在社区用户 clone 下来的仓库里会**前提不存在** ——
 * 它们不该崩，也不该假绿，而应当**显式跳过并说明原因**（ §5.4.6 B5：跳过必须单独计数、
 * 并写明是「不适用」还是「没抓到」）。
 *
 * 两种触发方式：
 * 1. 自动：`vendor/dsh-desktop-main/` 或 不存在；
 * 2. 显式：`XYB_RELEASE_SHAPE=1`（测试用 —— 不必真的搬走 3GB 的 vendor 就能验证降级行为）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 发布版形态下必然缺失的两个前提。 */
export const RELEASE_SHAPE_REQUIREMENTS = {
  vendorDir: join('vendor', 'dsh-desktop-main'),
    manifestFile: join('patches', 'host-modifications.manifest.json')
}

/**
 * 判断当前仓库是否处于「发布版形态」。
 *
 * @param {string} repoRoot 仓库根
 * @returns {string|null} 跳过原因（null = 正常开发形态，检查应照常执行）
 */
export function releaseShapeReason(repoRoot) {
  if (process.env.XYB_RELEASE_SHAPE === '1') {
    return '宿主源码未就位（XYB_RELEASE_SHAPE=1 显式声明）：本次不校验依赖 vendor/ 的规则'
  }
  // ⚠️ 判据只能是「宿主源码在不在」，**不能是「tasks/ 在不在」**：
  //   tasks/ 是开发侧档案，永远不随仓发布（已 gitignore）——用它做判据会得出
  //   「公开仓上本仓永远是发布形态」，于是把依赖 vendor/ 的校验全部跳过；
  //   而 vendor/ 是构建时取回的真实目录（node scripts/fetch-upstream.mjs），
  //   它到底在不在，才是「能不能跑这些校验」的真实判据。
  const missing = []
  if (!existsSync(join(repoRoot, RELEASE_SHAPE_REQUIREMENTS.vendorDir))) missing.push(RELEASE_SHAPE_REQUIREMENTS.vendorDir)
  if (!missing.length) return null
  return `宿主源码未就位（缺 ${missing.join(' 与 ')}）：先跑 node scripts/fetch-upstream.mjs；依赖它的校验本次不适用`
}

/** 统一的「跳过」输出（写明不适用 + 原因，避免被当成「通过」）。 */
export function printSkip(label, reason) {
  console.log(`⏭ [${label}] 跳过：${reason}`)
  console.log(`   校验强度：none（不适用 —— 不是「没问题」，是「前提不存在」）`)
}
