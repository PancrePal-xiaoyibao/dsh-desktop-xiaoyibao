/**
 * [构建输入] 跨文件契约：**构建引用的每个上游源，都必须在取回范围内**。
 *
 * ── 为什么有这条测试（真实事故，）────────────────────────────
 * v0.1.0 的第一个 tag（run 39121515555）在双平台安装 smoke 上失败：
 *
 * ❌ 许可文件随产物分发 — 已安装应用缺少许可文件：licenses/DSH-Desktop-Next-MIT.txt
 *
 * 根因：宿主的 package.json 里有一条 extraResources 指向
 * { "from": "../../vendor/dsh-desktop-next/LICENSE", ← 第二个上游
 * "to": "licenses/DSH-Desktop-Next-MIT.txt" }
 * 而 scripts/fetch-upstream.mjs 当时把 dsh-desktop-next 当成「可选参考源」默认不取
 * → 构建机上该文件不存在 → 打包产物缺件。
 *
 * ⚠️ 关键在于：这个缺陷**本地全绿**（开发机 vendor/ 里那个文件还在），
 * 而既有的 test/compliance/license-attribution.test.mjs 只断言「源文件存在」——
 * 它在本地当然成立，在 CI 又因 RELEASE_SHAPE 被跳过。**所以那一层抓不到它。**
 *
 * 本测试换成断言**因果关系**而不是「当前状态」：
 * 宿主补丁引用的每个 vendor/ 下的源 → 必须被 fetch-upstream 的取回目标覆盖。
 * 它只读补丁与脚本、**不需要 vendor 存在**，因此能在最快的 ci.yml 层就红。
 *
 * 自检（§5.4.8）：把 FETCH_TARGETS 里的 next 那一项注释掉，本测试必须变红。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import { FETCH_TARGETS } from '../../scripts/fetch-upstream.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const PATCH = join(REPO_ROOT, 'patches', 'host-modifications.patch')
/** 宿主的目录（extraResources 的 from 相对它解析）；与 manifest 的 hostRoot 一致。 */
const HOST_DIR = 'vendor/dsh-desktop-main'

const LF = String.fromCharCode(10)

/**
 * 从补丁里取出 extraResources 的 from→to 配对。
 * 逐行配对（`"to": "licenses/…"` 往前找最近的 `"from"`），不依赖缩进或顺序。
 */
function readExtraResourceLicenses(patchText) {
  const lines = patchText.split(LF)
  const pairs = []
  for (let i = 0; i < lines.length; i += 1) {
    const to = lines[i].match(/"to":\s*"(licenses\/[^"]+)"/)
    if (!to) continue
    for (let j = i; j >= 0 && j > i - 8; j -= 1) {
      const from = lines[j].match(/"from":\s*"([^"]+)"/)
      if (from) {
        pairs.push({ from: from[1], to: to[1] })
        break
      }
    }
  }
  return pairs
}

const LICENSE_PAIRS = readExtraResourceLicenses(readFileSync(PATCH, 'utf8'))
const FETCH_DIRS = FETCH_TARGETS.map((t) => t.dir)

test('[构建输入] 补丁里的 extraResources 许可条目能被解析出来（闸门自检：解析不到就是空转）', () => {
  assert.ok(
    LICENSE_PAIRS.length >= 6,
    `应解析出至少 6 条 licenses/ 条目（六件套），实际 ${LICENSE_PAIRS.length}：${JSON.stringify(LICENSE_PAIRS)}`
  )
  assert.ok(
    LICENSE_PAIRS.some((p) => p.to === 'licenses/LICENSE'),
    '六件套里必须有本发行版自身的 LICENSE'
  )
})

test('[构建输入] 每个 vendor/ 下的引用源，都被 fetch-upstream 的取回目标覆盖', () => {
  const uncovered = []
  for (const pair of LICENSE_PAIRS) {
    // 相对宿主目录解析成仓库内路径（posix 语义，与 git 一致）
    const repoRel = posix.normalize(posix.join(HOST_DIR, pair.from))
    if (!repoRel.startsWith('vendor/')) continue // 本仓自有的源（packages/ 等）另行由 git 跟踪
    const covered = FETCH_DIRS.some((dir) => repoRel === dir || repoRel.startsWith(dir + '/'))
    if (!covered) uncovered.push(`${pair.from}  →  ${repoRel}（to: ${pair.to}）`)
  }
  assert.deepEqual(
    uncovered,
    [],
    '以下构建引用源不在 fetch-upstream 的取回范围内 —— 构建机上它们不存在，产物会缺件：' + LF + uncovered.join(LF)
  )
})

test('[构建输入] 上游许可源必须默认取回（它是随包六件套之一，不是可选参考源）', () => {
  const next = FETCH_TARGETS.find((t) => t.dir === 'vendor/dsh-desktop-next')
  assert.ok(
    next,
    'fetch-upstream 必须把 vendor/dsh-desktop-next 列为取回目标 —— ' +
      '宿主 extraResources 引用它的 LICENSE 作为 licenses/DSH-Desktop-Next-MIT.txt'
  )
  assert.match(
    String(next.licenseSha256),
    /^[0-9a-f]{64}$/,
    '上游许可必须带一个冻结的内容哈希（我们随包转达的是这份许可，commit 只是手段）'
  )
})

test('[构建输入] 取回目标互不重叠（避免两处写同一目录）', () => {
  for (let i = 0; i < FETCH_DIRS.length; i += 1) {
    for (let j = i + 1; j < FETCH_DIRS.length; j += 1) {
      const a = FETCH_DIRS[i]
      const b = FETCH_DIRS[j]
      assert.equal(
        a === b || a.startsWith(b + '/') || b.startsWith(a + '/'),
        false,
        `取回目标重叠：${a} 与 ${b}`
      )
    }
  }
})
