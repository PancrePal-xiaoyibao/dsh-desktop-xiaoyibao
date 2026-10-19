/**
 * 社区标识一致性。
 *
 * 依据：C-804 —— 「社区发行版，非官方产品」这句话必须同时出现在**仓库文档**与**产品界面**里。
 * 为什么两边都要：用户可能先看安装包（界面），也可能先看仓库（README）；
 * 只写一边就等于有人会误以为它是官方版。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { releaseShapeReason } from '../../scripts/lib/release-shape.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

/** 公开仓（净源码仓）没有 vendor/ 与 tasks/：依赖它们的断言显式跳过。 */
const RELEASE_SHAPE = releaseShapeReason(REPO_ROOT)

/**
 * 社区标识的**可接受措辞**。
 *
 * 为什么是一个集合而不是单一字符串：产品与文档的措辞本来就有多个正确写法
 * （README 写「非 DeepSeek 官方产品」，界面写「社区发行版 · 非官方产品」）——
 * 测试要守的是「表达了非官方性」，不是「逐字一致」。
 */
const COMMUNITY_MARKERS = ['社区发行版']
const NON_OFFICIAL = ['非官方产品', '非 DeepSeek 官方产品', '非官方']

function requires(text, label) {
  for (const marker of COMMUNITY_MARKERS) {
    assert.ok(text.includes(marker), `${label} 必须包含社区标识「${marker}」`)
  }
  assert.ok(
    NON_OFFICIAL.some((phrase) => text.includes(phrase)),
    `${label} 必须表达「非官方」（可接受措辞：${NON_OFFICIAL.join(' / ')}）`
  )
}

test('[社区标识] README 必须有社区标识 + 与官方无隶属关系', () => {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')
  requires(readme, 'README.md')
  assert.match(readme, /无隶属关系|非 DeepSeek 官方产品/, 'README 必须写明与官方的隶属关系缺失')
})

test('[社区标识] 界面（关于区 + 品牌署名条）必须有社区标识', () => {
  const client = readFileSync(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'client.js'), 'utf8')
  requires(client, 'client.js')
  assert.ok(client.includes('社区发行版 · 非官方产品'), '品牌署名条必须带社区标识标签')
})

test('[社区标识] 隐私与医疗免责文档必须同样声明', () => {
  // 为什么不再要求 LICENSE（不是放宽断言）：
  // LICENSE 要能被 GitHub 识别出许可类型，就必须是**标准许可正文**；
  // 社区身份声明的正确落点是 README + 界面 + 隐私/免责文档 + 发布说明。
  // 下面把 README 一并纳入（它本来就是用户看仓库的第一落点）。
  for (const file of ['README.md', join('docs', 'PRIVACY.md'), join('docs', 'MEDICAL-DISCLAIMER.md')]) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8')
    assert.match(text, /非 DeepSeek 官方产品|社区发行版/, `${file} 必须声明这是社区发行版`)
  }
})

test('[社区标识] 发布说明模板同样带社区标识（发布页是用户第一落点）', (t) => {
  // release.yml 只在开发仓（它要 vendor/ 才能构建产物）→ 公开仓里跳过
  if (RELEASE_SHAPE) return t.skip(RELEASE_SHAPE)
  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.ok(workflow.includes('社区发行版，非 DeepSeek 官方产品'), '发布说明必须带社区标识')
})
