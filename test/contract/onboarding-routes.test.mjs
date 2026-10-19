/**
 * 首启向导相关路由契约：`POST /probe-dir` + `GET /settings` 的 dataRoot。
 *
 * 这两条是向导的「事实来源」：目录到底能不能写、数据到底在哪 —— 都必须由服务端给真答案。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  root = mkdtempSync(join(tmpdir(), 'xyb-wizard-route-'))
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

test('[向导/route] GET /settings 带回实际数据目录（向导与设置页都要显示「数据在哪」）', async () => {
  const { fetchImpl } = await boot()
  const data = await (await fetchImpl('http://127.0.0.1/api/xyb/settings')).json()
  assert.equal(typeof data.dataRoot, 'string')
  assert.ok(data.dataRoot.length > 3, '必须返回真实路径')
  assert.ok(!data.onboarding || typeof data.onboarding === 'object', 'onboarding 允许缺省（首次使用）')
})

test('[向导/route] probe-dir：可写目录返回 ok + 路径 + 余量', async () => {
  const { fetchImpl } = await boot()
  const target = mkdtempSync(join(tmpdir(), 'xyb-probe-ok-'))
  try {
    const res = await fetchImpl('http://127.0.0.1/api/xyb/probe-dir', {
      method: 'POST',
      body: JSON.stringify({ path: target })
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.ok, true, `可写目录必须判为 ok：${JSON.stringify(data)}`)
    assert.equal(data.path, resolve(target))
    assert.ok(data.reason.includes('读写'), '通过时也要给出可读说明')
    assert.equal(typeof data.freeBytes, 'number')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('[向导/route] probe-dir：不可写路径给出「人能读懂的原因」，而不是抛错', async () => {
  const { fetchImpl } = await boot()
  // 造一个确定性失败：让「目录」的某一段是文件（Windows 上稳定复现 ENOTDIR/EEXIST）
  const filePath = join(root, 'not-a-directory.txt')
  writeFileSync(filePath, 'x', 'utf8')
  const res = await fetchImpl('http://127.0.0.1/api/xyb/probe-dir', {
    method: 'POST',
    body: JSON.stringify({ path: join(filePath, 'child') })
  })
  assert.equal(res.status, 200, '探测失败不是 HTTP 错误（否则界面只能显示“出错了”）')
  const data = await res.json()
  assert.equal(data.ok, false)
  assert.ok(typeof data.reason === 'string' && data.reason.length >= 6, '必须给出可读原因')
  assert.ok(typeof data.code === 'string' && data.code.length > 0, '同时保留机器可判的 errno')
  assert.ok(!/Error:|at Object\./.test(data.reason), '不得把原始堆栈丢给用户')
})

test('[向导/route] 不带路径时探测当前数据根（向导第一步就是这么用的）', async () => {
  const { fetchImpl } = await boot()
  const data = await (
    await fetchImpl('http://127.0.0.1/api/xyb/probe-dir', { method: 'POST', body: JSON.stringify({}) })
  ).json()
  assert.equal(data.ok, true)
  assert.equal(data.path, resolve(root))
})

test('[向导/route] onboarding 标记可持久化（完成与跳过都记）', async () => {  const { fetchImpl } = await boot()
  const post = (onboarding) =>
    fetchImpl('http://127.0.0.1/api/xyb/settings', { method: 'POST', body: JSON.stringify({ onboarding }) })

  await post({ done: true, skipped: false, at: '2026-10-17T00:00:00.000Z' })
  let settings = await (await fetchImpl('http://127.0.0.1/api/xyb/settings')).json()
  assert.equal(settings.onboarding.done, true)
  assert.equal(settings.onboarding.skipped, false)
  assert.equal(settings.onboarding.at, '2026-10-17T00:00:00.000Z')

  await post({ done: false, skipped: true, at: '2026-10-17T01:00:00.000Z' })
  settings = await (await fetchImpl('http://127.0.0.1/api/xyb/settings')).json()
  assert.equal(settings.onboarding.skipped, true)
  assert.equal(settings.onboarding.done, false)
})
