/**
 * 零官方更新源。
 *
 * 依据： C-002 / PRIVACY 承诺 —— 社区版不得指向官方更新源（`dshdesktop.com`）。
 * 这条规则有两个层次，本测试都要证：
 * ① **配置层**：`build.publish` 为空数组（打包/发布配置不指向官方）；
 * ② **运行时层**：宿主更新检查被短路（V-1103）—— 只关配置是**不够的**（实测踩坑 P-34：
 * 打包版启动 15–30s 后仍会去官方源检查更新）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { releaseShapeReason } from '../../scripts/lib/release-shape.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const VENDOR = join(REPO_ROOT, 'vendor', 'dsh-desktop-main')

/** 公开仓（净源码仓，）没有 vendor/：前两条断言显式跳过（第三条读公开仓自己的配置，照常执行）。 */
const RELEASE_SHAPE = releaseShapeReason(REPO_ROOT)

test('[零官方更新源] build.publish 必须为空（不指向任何更新源）', (t) => {
  if (RELEASE_SHAPE) return t.skip(RELEASE_SHAPE)
  const pkg = JSON.parse(readFileSync(join(VENDOR, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.build.publish, [], 'publish 必须为空数组；非空即会指向更新源')
})

test('[零官方更新源] 运行时更新检查必须被短路（V-1103）', (t) => {
  if (RELEASE_SHAPE) return t.skip(RELEASE_SHAPE)
  const source = readFileSync(join(VENDOR, 'src', 'main', 'update', 'update-manager.ts'), 'utf8')
  assert.match(source, /COMMUNITY_UPDATES_DISABLED\s*=\s*true/, '必须显式关闭社区版更新检查')
  // 真实签名：`function supportsUpdates(): boolean {` —— 首行即短路（实测：断言写窄了会假红）
  assert.match(
    source,
    /function supportsUpdates\(\): boolean \{\s*if \(COMMUNITY_UPDATES_DISABLED\) return false/,
    'supportsUpdates() 必须首行短路返回 false'
  )
})

test('[零官方更新源] 本项目自己的可执行配置里不得出现官方域名', () => {
  // 只看「可执行配置」：tasks/（立项文档需记录改造前原值）、docs/（用户文档说明）、vendor/（上游源码）、
  // tests/（本测试自身）都要排除 —— 这是 branding.test.mjs A-5 的同一语义，此处独立成表以便追溯。
  const files = [
    join(REPO_ROOT, 'package.json'),
    join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
    join(REPO_ROOT, '.github', 'workflows', 'release.yml')
  ]
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue // 文件不存在就不管（不因缺文件而假绿：这个用例只对存在的配置断言）
    }
    assert.ok(!text.includes('dshdesktop.com'), `${file} 不得出现官方更新源域名（dshdesktop.com）`)
  }
})
