/**
 * 许可与版权归属。
 *
 * 依据：MIT 要求「版权声明与许可声明随副本或实质部分分发」。
 * 本测试锁住三件事：
 * ① 第三方清单里**四条版权归属**齐备（本发行版 / DataElement / Anywhere Labs / DeepSeek）
 * —— LICENSE 只放本项目自己的许可（否则 GitHub 认不出许可类型）；
 * ② 随包分发的许可六件套在配置里真实存在（extraResources 六条），且源文件都能找到；
 * ③ 第三方清单里三个上游章节齐备（官方 DSH Desktop / DSH Next / 青囊）。
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { releaseShapeReason } from '../../scripts/lib/release-shape.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const VENDOR = join(REPO_ROOT, 'vendor', 'dsh-desktop-main')

/** 公开仓（净源码仓，）没有 vendor/：依赖它的断言显式跳过（写明“不适用”）。 */
const RELEASE_SHAPE = releaseShapeReason(REPO_ROOT)

test('[许可] 第三方清单含四条归属（本发行版 + 三个上游）', () => {
  // 归属的正确落点是第三方清单，不是 LICENSE：
  // MIT 要求「版权声明随副本分发」，本项目通过 THIRD-PARTY-NOTICES.md 与随包 licenses/ 履行；
  // 而 LICENSE 保持纯标准正文，才能被 GitHub 识别出许可类型（实测：混入附加内容会显示 NOASSERTION）。
  const notices = readFileSync(join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8')
  assert.ok(notices.includes('小胰宝社区'), '必须声明本发行版版权方')
  assert.ok(notices.includes('DataElement'), '必须保留上游 DSH Desktop 版权（MIT 要求）')
  assert.ok(notices.includes('Anywhere Labs'), '必须写明 DSH Desktop Next 的版权')
  assert.ok(notices.includes('DeepSeek'), '必须写明共同上游（DeepSeek Harness）版权')
  assert.ok(notices.includes('Apache-2.0'), '内嵌青囊是 Apache-2.0，必须声明')
})

test('[许可] 三个上游许可原文都随包分发（extraResources 六件套齐备且源文件存在）', (t) => {
  if (RELEASE_SHAPE) return t.skip(RELEASE_SHAPE)
  const pkg = JSON.parse(readFileSync(join(VENDOR, 'package.json'), 'utf8'))
  const entries = (pkg.build.extraResources || []).filter((e) => String(e.to || '').startsWith('licenses/'))
  const targets = entries.map((e) => e.to)
  for (const required of [
    'licenses/LICENSE',
    'licenses/THIRD-PARTY-NOTICES.md',
    'licenses/DSH-Desktop-upstream-MIT.txt',
    'licenses/DeepSeek-Harness-MIT.txt',
    'licenses/QingNang-Apache-2.0.txt',
    'licenses/DSH-Desktop-Next-MIT.txt'
  ]) {
    assert.ok(targets.includes(required), `extraResources 缺少 ${required}`)
  }
  // 每个条目的源文件必须真的存在（否则打包时才炸 —— 实测踩坑：../ 路径被 electron-builder 拒绝）
  for (const entry of entries) {
    const source = entry.from.startsWith('..') ? resolve(VENDOR, entry.from) : join(VENDOR, entry.from)
    assert.ok(existsSync(source), `许可源文件不存在：${entry.from}`)
  }
})

test('[许可] 第三方清单覆盖三个上游 + 已移植片段登记表', () => {
  const notices = readFileSync(join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8')
  assert.match(notices, /## 一、宿主（DSH Desktop）/, '必须有宿主章节')
  assert.match(notices, /## 二、DSH Desktop Next（上游项目 \/ 功能来源）/, '必须有 DSH Desktop Next 章节')
  assert.match(notices, /已移植片段登记/, '必须有「已移植片段登记」表（移植了什么要能查）')
  assert.match(notices, /DeepSeek Harness/, '必须写明共同上游')
  assert.match(notices, /青囊/, '必须有青囊章节')
})

test('[许可] 宿主许可原文未被改动（MIT 头 + DataElement 版权行）', (t) => {
  if (RELEASE_SHAPE) return t.skip(RELEASE_SHAPE)
  const upstream = readFileSync(join(VENDOR, 'LICENSE'), 'utf8')
  assert.match(upstream, /^MIT License/, '上游许可必须是 MIT 原文')
  assert.ok(upstream.includes('Copyright (c) 2026 DataElement'), '上游版权行必须原样保留')
  assert.ok(!/小胰宝/.test(upstream), '不得往上游许可文件里塞我们的信息（原文保留）')
})

test('[许可] DSH Desktop Next 许可原文与共同上游声明到位', (t) => {
  if (RELEASE_SHAPE) return t.skip(RELEASE_SHAPE)
  const next = readFileSync(join(REPO_ROOT, 'vendor', 'dsh-desktop-next', 'LICENSE'), 'utf8')
  assert.ok(next.includes('Copyright (c) 2026 Anywhere Labs'), 'DSH Next 许可版权行')
  const upstreamOfNext = readFileSync(join(REPO_ROOT, 'vendor', 'dsh-desktop-next', 'dsh-desktop-next', 'LICENSE.upstream'), 'utf8')
  assert.ok(upstreamOfNext.includes('Copyright (c) 2026 DeepSeek'), 'Next 的上游是 DeepSeek Harness（其 LICENSE.upstream 可证）')
})
