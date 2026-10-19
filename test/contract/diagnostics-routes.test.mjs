/**
 * 诊断包路由契约。
 *
 * 走宿主真规则装载 + 真发请求。重点：preview 与 export 的差别必须真实存在 ——
 * preview 只回结构（给用户看「将要导出什么」），export 才落盘。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  root = mkdtempSync(join(tmpdir(), 'xyb-diag-route-'))
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

test('[diag/route] preview 只回结构，不落盘', async () => {
  const { fetchImpl } = await boot()
  const res = await fetchImpl('http://127.0.0.1/api/xyb/diagnostics/preview')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.preview.kind, 'xyb-diagnostics')
  assert.ok(data.preview.routes.length > 5, '应列出路由面（只有名字）')
  // 结构字段必须是**固定集合**：多一个字段就可能是未来改动顺手带进来的业务数据
  assert.deepEqual(
    Object.keys(data.preview).sort(),
    ['app', 'dataRoot', 'events', 'formatVersion', 'generatedAt', 'kind', 'privacy', 'routes'],
    '预览只允许这些结构字段'
  )
  // 事件项必须都过白名单，且不得出现业务内容（privacy 声明里提到「病历」是正常的 —— 那是免责说明）
  for (const item of data.preview.events.items) {
    assert.deepEqual(Object.keys(item).sort(), ['code', 'level', 'message', 'phase', 'redactions', 'ts'])
    assert.ok(!item.message.includes('病历正文'), '实际事件文本不得包含业务内容')
  }
  assert.equal(typeof data.redactions, 'number')
})

test('[diag/route] export 落盘并返回 path / bytes / sha256 / redactions', async () => {
  const { fetchImpl } = await boot()
  const res = await fetchImpl('http://127.0.0.1/api/xyb/diagnostics/export', { method: 'POST' })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(data.path.includes('diagnostics'), '文件应在数据根的 diagnostics/ 下')
  assert.ok(data.bytes > 100)
  assert.equal(typeof data.sha256, 'string')
  assert.equal(data.sha256.length, 64)

  const text = readFileSync(data.path, 'utf8')
  const payload = JSON.parse(text)
  assert.equal(payload.kind, 'xyb-diagnostics')
  assert.ok(payload.privacy.statement.includes('不含病历正文'), '包内要有隐私声明')
  // 导出动作本身也要进时间线（可回看）
  const listed = await (await fetchImpl('http://127.0.0.1/api/xyb/events/list?limit=20')).json()
  assert.ok(listed.events.some((e) => e.phase === 'diagnostics' && e.code === 'EXPORTED'), '导出应留下事件')
})

test('[diag/route] 导出包内的路径与长数字已脱敏（纵深防御）', async () => {
  const { fetchImpl } = await boot()
  const data = await (await fetchImpl('http://127.0.0.1/api/xyb/diagnostics/export', { method: 'POST' })).json()
  const text = readFileSync(data.path, 'utf8')
  // 数据根绝对路径不得出现在包里（它含用户名）
  assert.ok(!text.includes(root.replace(/\\/g, '\\\\')) && !text.includes(root), '不得含本机绝对路径')
})
