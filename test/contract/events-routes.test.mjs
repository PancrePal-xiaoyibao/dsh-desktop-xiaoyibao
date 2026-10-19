/**
 * 事件时间线路由契约。
 *
 * 走**宿主真规则装载**（bootPlugin）+ 真发请求，不是读源码断言：
 * 路由是否注册、方法是否对、查询串校验是否真的生效，只有装载期才看得见。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { makeFetch } from '../../scripts/lib/client-sandbox.mjs'
import { bootPlugin } from '../../scripts/lib/host-contract-rules.mjs'
import { appendEvent } from '../../packages/dsh-xyb-workbench/lib/store/events.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

let root
before(() => {
  root = mkdtempSync(join(tmpdir(), 'xyb-events-route-'))
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

test('[events/route] GET /events/list 已注册，返回 { events, total, truncated }', async () => {
  const { fetchImpl } = await boot()
  await appendEvent(root, { level: 'info', phase: 'route-test', code: 'SEED', message: '种子事件' })

  const res = await fetchImpl('http://127.0.0.1/api/xyb/events/list?limit=20')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(Array.isArray(data.events), 'events 必须是数组')
  assert.equal(typeof data.total, 'number')
  assert.equal(typeof data.truncated, 'boolean')
  assert.ok(data.events.some((e) => e.code === 'SEED'), '种子事件应能读到')
})

test('[events/route] 级别取值受校验：未知级别 400，不得静默当成「全部」', async () => {
  const { fetchImpl } = await boot()
  const res = await fetchImpl('http://127.0.0.1/api/xyb/events/list?level=critical')
  assert.equal(res.status, 400, '未知级别必须拒绝（静默忽略会让用户以为已筛选）')
  const data = await res.json()
  assert.equal(data.error, 'INVALID_INPUT')
})

test('[events/route] limit 走查询串并收敛到上限内', async () => {
  const { fetchImpl } = await boot()
  for (let i = 0; i < 3; i += 1) {
    await appendEvent(root, { level: 'error', phase: 'route-test', code: `E${i}`, message: `错误 ${i}` })
  }
  const one = await (await fetchImpl('http://127.0.0.1/api/xyb/events/list?limit=1')).json()
  assert.equal(one.events.length, 1, 'limit=1 → 1 条')
  const huge = await (await fetchImpl('http://127.0.0.1/api/xyb/events/list?limit=99999')).json()
  assert.ok(huge.events.length <= 200, '超大 limit 必须被收敛（防止一次拉爆界面）')
  const errors = await (await fetchImpl('http://127.0.0.1/api/xyb/events/list?level=error')).json()
  assert.ok(errors.events.every((e) => e.level === 'error'), 'level=error 只返回错误级')
})

test('[events/route] 路由失败会落进时间线（「失败静默」的正解）', async () => {
  const { fetchImpl } = await boot()
  // 先建一份档案，再删两次：第二次会真的抛 NOT_FOUND（异常路径 → 必须落进时间线）
  const created = await (
    await fetchImpl('http://127.0.0.1/api/xyb/patients', { method: 'POST', body: JSON.stringify({ name: '事件时间线测试档案' }) })
  ).json()
  const id = created.id || created.patient?.id
  assert.ok(id, `建档必须返回 id，实际 ${JSON.stringify(created).slice(0, 120)}`)
  const first = await fetchImpl(`http://127.0.0.1/api/xyb/patient?id=${id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) })
  assert.equal(first.status, 200, '第一次删除应成功')
  // 真异常路径：把姓名改到超长（数据层独立校验，长度上界 → 抛 INVALID_INPUT）
  const overlong = await fetchImpl(`http://127.0.0.1/api/xyb/patient?id=${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'x'.repeat(300) })
  })
  assert.ok(overlong.status >= 400, `超长姓名必须被拒（前置条件），实际 ${overlong.status}`)

  const listed = await (await fetchImpl('http://127.0.0.1/api/xyb/events/list?level=error')).json()
  assert.ok(
    listed.events.some((e) => e.phase === 'route'),
    `路由失败必须在时间线里可见，实际：${JSON.stringify(listed.events.slice(0, 3))}`
  )
})
