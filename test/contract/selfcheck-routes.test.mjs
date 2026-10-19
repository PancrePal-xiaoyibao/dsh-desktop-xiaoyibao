/**
 * 数据自检路由契约。
 *
 * 关键点：修复动作必须**白名单**（未知动作拒绝，不静默忽略），且修复会留下事件。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { makeFetch } from '../../scripts/lib/client-sandbox.mjs'
import { bootPlugin } from '../../scripts/lib/host-contract-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

let root
before(() => {
  root = mkdtempSync(join(tmpdir(), 'xyb-selfcheck-route-'))
  process.env.XYB_DATA_ROOT = root
})
after(() => {
  delete process.env.XYB_DATA_ROOT
  rmSync(root, { recursive: true, force: true })
})

async function boot() {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root })
  assert.equal(registerError, null, `装载失败：${registerError?.message}`)
  return makeFetch(mock.routes)
}

test('[selfcheck/route] GET /selfcheck 返回检查项 + 汇总 + 动作清单', async () => {
  const { fetchImpl } = await boot()
  const res = await fetchImpl('http://127.0.0.1/api/xyb/selfcheck')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(Array.isArray(data.items) && data.items.length >= 7, `检查项应 ≥7，实际 ${data.items?.length}`)
  assert.equal(typeof data.summary.ok, 'number')
  const ids = data.items.map((i) => i.id)
  for (const required of ['root-writable', 'settings', 'manifest', 'records', 'temp', 'backups', 'disk']) {
    assert.ok(ids.includes(required), `缺少检查项 ${required}`)
  }
  assert.ok(Array.isArray(data.actions) && data.actions.length >= 4, '必须下发修复动作清单（UI 只允许点这些）')
  for (const action of data.actions) {
    assert.equal(typeof action.id, 'string')
    assert.equal(typeof action.label, 'string')
    assert.equal(typeof action.target, 'string')
  }
})

test('[selfcheck/route] 未知修复动作被拒（400），不产生副作用', async () => {
  const { fetchImpl } = await boot()
  const res = await fetchImpl('http://127.0.0.1/api/xyb/selfcheck/repair', {
    method: 'POST',
    body: JSON.stringify({ action: 'rm-rf-everything' })
  })
  assert.equal(res.status, 400)
  const data = await res.json()
  assert.equal(data.error, 'INVALID_INPUT')
  // 缺 action 也一样拒绝
  const empty = await fetchImpl('http://127.0.0.1/api/xyb/selfcheck/repair', { method: 'POST', body: '{}' })
  assert.equal(empty.status, 400)
})

test('[selfcheck/route] 合法动作：返回 after 复检 + 留下审计事件', async () => {
  const { fetchImpl } = await boot()
  const res = await fetchImpl('http://127.0.0.1/api/xyb/selfcheck/repair', {
    method: 'POST',
    body: JSON.stringify({ action: 'clean-temp' })
  })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.ok, true)
  assert.equal(data.action, 'clean-temp')
  assert.ok(data.backup, '必须返回修复前备份路径')
  assert.ok(data.after && Array.isArray(data.after.items), '必须返回复检结果（UI 直接刷新）')

  const listed = await (await fetchImpl('http://127.0.0.1/api/xyb/events/list?limit=20')).json()
  assert.ok(
    listed.events.some((e) => e.phase === 'selfcheck' && e.code === 'REPAIRED'),
    `修复必须留事件，实际：${JSON.stringify(listed.events.slice(0, 3))}`
  )
})
