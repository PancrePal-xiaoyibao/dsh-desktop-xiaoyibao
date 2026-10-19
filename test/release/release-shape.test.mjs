/**
 * 「宿主源码未就位」降级行为测试。
 *
 * 本仓库**不跟踪**上游源码：`vendor/` 由 `scripts/fetch-upstream.mjs` 按锁定 commit 取回。
 * 因此在「没跑过取回」的克隆上，那些以 vendor 为前提的规则必须**显式跳过并说明**，
 * 既不能崩（红），也不能假绿（静默通过）。
 *
 * ⚠️ 判据是「宿主源码在不在」，**不是「tasks/ 在不在」**：
 *   tasks/ 是开发侧档案、永远不随仓发布；用它做判据会得出「公开仓永远是发布形态」，
 *   从而把 V-1 审计这类关键校验**整项跳过**（实测暴露的缺口）。
 *
 * 本文件锁住两件事：
 * ① 未就位时：明确 skip、零 fail，且输出里写明「不适用」；
 * ② 已就位时：同样的用例**照常执行**（防止有人把守卫写成「永远跳过」→ 假绿）。
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { printSkip, releaseShapeReason } from '../../scripts/lib/release-shape.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

/** node --test 的汇总在部分环境走 stderr —— 断言统一看两路合并输出。 */
function combined(result) {
  return `${result.stdout || ''}${result.stderr || ''}`
}

function runNode(args, extraEnv = {}) {
  // ⚠️ 必须清掉 NODE_TEST_CONTEXT：否则嵌套的 node --test 会以为自己在父 runner 里，
  // 什么都不输出（实测踩坑：断言拿到空字符串）。
  const env = { ...process.env, ...extraEnv }
  delete env.NODE_TEST_CONTEXT
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' }
  }
}

test('[发布形态] 判定逻辑：宿主源码已就位返回 null，未就位与显式开关都返回原因', () => {
  // 本测试在两种环境下都要成立：
  // · 已跑过取回（vendor/ 在）→ releaseShapeReason 应为 null（检查照常执行）；
  // · 没跑过取回（vendor/ 不在）→ 应为带原因的字符串（显式跳过）。
  const autoShape = releaseShapeReason(REPO_ROOT)
  if (process.env.XYB_RELEASE_SHAPE === '1') {
    assert.ok(autoShape && autoShape.includes('未就位'), '显式开关必须给出可读原因')
  } else if (autoShape === null) {
    assert.equal(autoShape, null, '宿主源码已就位时不应跳过')
  } else {
    assert.ok(autoShape.includes('未就位'), `缺宿主源码时应给出原因，实际：${autoShape}`)
  }

  process.env.XYB_RELEASE_SHAPE = '1'
  const forcedReason = releaseShapeReason(REPO_ROOT)
  delete process.env.XYB_RELEASE_SHAPE
  assert.ok(forcedReason && forcedReason.includes('未就位'), '显式开关必须给出可读原因')

  // 拿一个必然缺前提的临时根来验证「自动判定」分支
  const autoReason = releaseShapeReason(join(REPO_ROOT, 'test', 'release', 'fixtures-missing'))
  assert.ok(autoReason && autoReason.includes('未就位'), `缺前提时应给出原因，实际：${autoReason}`)
})

test('[发布形态] check-vendor-modifications：显式跳过 + 标注「不适用」，退出码 0', () => {
  const result = runNode(['scripts/check-vendor-modifications.mjs'], { XYB_RELEASE_SHAPE: '1' })
  assert.equal(result.code, 0, `发布形态下不得判定失败：${combined(result)}`)
  assert.ok(combined(result).includes('跳过'), '必须打印「跳过」')
  assert.ok(combined(result).includes('不适用'), '必须写明是「不适用」而不是「没问题」')
  assert.ok(combined(result).includes('校验强度：none'), '必须标注校验强度（防假绿）')
})

test('[发布形态] 品牌合规测试：发布形态下全部 skip、零 fail（社区 clone 不会一片红）', () => {
  const result = runNode(['--test', 'packages/dsh-xyb-branding/test/compliance/branding.test.mjs'], {
    XYB_RELEASE_SHAPE: '1'
  })
  assert.equal(result.code, 0, `发布形态下测试应整体通过（skip 不算失败）：${combined(result).slice(-400)}`)
  assert.match(combined(result), /# skipped 15/, `应恰好跳过 15 个用例，实际输出：${combined(result).slice(-300)}`)
  assert.match(combined(result), /# fail 0/, '不得有失败')
})

test('[发布形态] 反向守卫：宿主源码已就位时这些用例必须**真的执行**（不是永远跳过）', (t) => {
  // 反向守卫只在「取回过宿主源码」时有意义：没取回就跑不了这些用例，本来就该跳过
  if (releaseShapeReason(REPO_ROOT)) {
    return t.skip('当前未取回宿主源码（vendor/ 不在）—— 反向守卫不适用')
  }
  const check = runNode(['scripts/check-vendor-modifications.mjs'])
  assert.equal(check.code, 0, `开发形态下检查应通过：${combined(check)}`)
  assert.ok(!combined(check).includes('跳过'), '开发形态下不得跳过 vendor 改动核对')

  const branding = runNode(['--test', 'packages/dsh-xyb-branding/test/compliance/branding.test.mjs'])
  assert.equal(branding.code, 0, '开发形态下品牌合规测试应通过')
  assert.match(combined(branding), /# pass 15/, '开发形态下必须真的跑 15 个用例')
  assert.match(combined(branding), /# skipped 0/, '开发形态下不应有跳过')
})

test('[发布形态] 跳过输出格式统一（可被上游脚本与 CI 识别）', () => {
  const lines = []
  const original = console.log
  console.log = (line) => lines.push(String(line))
  try {
    printSkip('demo', '因为处于发布版形态')
  } finally {
    console.log = original
  }
  assert.ok(lines[0].startsWith('⏭ [demo] 跳过：'), `首行格式应为 ⏭ [label] 跳过：…，实际 ${lines[0]}`)
  assert.ok(lines.some((l) => l.includes('校验强度')), '必须带强度标注')
})
