/**
 * 看板聚合数据测试。
 *
 * 钉住三件事：
 * ① 空数据：verdict=尚无资料、完整度 0/7、需关注项为空、带管/血管通路如实标 ；
 * ② 体重下降触发 watch（阈值来自 board-rules.json，本测试自己造数据触发）；
 * ③ 需关注项 / 全程管理摘要的结构（跳转目标、依据说明），供客户端渲染。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = resolve(join(HERE, '..', '..', 'packages', 'dsh-xyb-workbench', 'lib'))
const libUrl = (...segments) => pathToFileURL(join(LIB, ...segments)).href

const { initRoot, createPatient } = await import(libUrl('store', 'patients.js'))
const { confirmExtraction } = await import(libUrl('metrics', 'records.js'))
const { buildBoard } = await import(libUrl('board', 'aggregate.js'))

let base
before(() => {
  base = mkdtempSync(join(tmpdir(), 'xyb-board-'))
})
after(() => {
  rmSync(base, { recursive: true, force: true })
})
const freshRoot = () => join(base, `p-${Date.now()}-${Math.random().toString(36).slice(2)}`)

test('[board] 空数据：尚无资料 + 需关注项为空 + 未实现类目如实说明', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '空档案' })

  const board = await buildBoard(dir, p.id)
  assert.equal(board.verdict.lv, 'unk')
  assert.equal(board.verdict.text, '尚无资料')
  assert.equal(board.completeness.have, 0)
  assert.equal(board.completeness.total, 7)
  assert.deepEqual(board.watch, [], '无数据时不得凭空产生需关注项')

  assert.equal(board.careDigest.length, 4, '全程管理固定四类')
  assert.deepEqual(board.careDigest.map((i) => i.key), ['toxicity', 'comorbidity', 'tube', 'vascular'])
  for (const key of ['tube', 'vascular']) {
    const item = board.careDigest.find((i) => i.key === key)
    assert.equal(item.lv, 'unk')
    assert.match(item.detail, /尚未提供|后续版本/, '未实现类目必须对用户讲清（不铺演示数据）')
    assert.ok(!/CHG-\d/.test(item.detail), '未实现类目不得对用户暴露内部变更编号')
  }
})

test('[board] 体重下降 ≥2%：营养 watch 并进入需关注项汇总（带跳转与依据）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '体重档案' })

  await confirmExtraction(dir, p.id, { id: 'w1', indicator: 'WEIGHT', value: 60, unit: 'kg', measuredAt: '2026-01-01' })
  await confirmExtraction(dir, p.id, { id: 'w2', indicator: 'WEIGHT', value: 58, unit: 'kg', measuredAt: '2026-02-15' })

  const board = await buildBoard(dir, p.id)
  assert.equal(board.dimensions.nutrition.lv, 'watch', `实际：${JSON.stringify(board.dimensions.nutrition)}`)
  assert.equal(board.verdict.lv, 'watch')
  assert.equal(board.completeness.have, 1, '只有营养维度有数据')

  const item = board.watch.find((i) => i.key === 'nutrition')
  assert.ok(item, '需关注项汇总必须包含营养')
  assert.equal(item.label, '营养')
  assert.equal(item.page, 'nutrition', '需关注项必须带跳转目标')
  assert.match(item.note, /体重下降/, '依据要写清是什么触发的')
})

test('[board] 体重下降 ≥5%：升级为 alert（阈值来自规则文件，非硬编码）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '预警档案' })

  await confirmExtraction(dir, p.id, { id: 'w1', indicator: 'WEIGHT', value: 60, unit: 'kg', measuredAt: '2026-01-01' })
  await confirmExtraction(dir, p.id, { id: 'w2', indicator: 'WEIGHT', value: 56, unit: 'kg', measuredAt: '2026-02-15' })

  const board = await buildBoard(dir, p.id)
  assert.equal(board.dimensions.nutrition.lv, 'alert')
  assert.equal(board.verdict.lv, 'alert')
  assert.equal(board.watch.length, 1)
  assert.equal(board.watch[0].lv, 'alert')
})

test('[board] 未确认的记录不进看板（人工闸门）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '闸门档案' })

  await confirmExtraction(dir, p.id, { id: 'w1', indicator: 'WEIGHT', value: 60, unit: 'kg', measuredAt: '2026-01-01' })
  // 直接写事件流模拟「机器抽取、还没核对」的 pending 记录
  const { appendRecord } = await import(libUrl('store', 'jsonl.js'))
  const { streamPath } = await import(libUrl('store', 'patients.js'))
  await appendRecord(streamPath(dir, p.id, 'records'), {
    id: 'w2',
    patientId: p.id,
    indicator: 'WEIGHT',
    value: 50,
    unit: 'kg',
    measuredAt: '2026-02-15',
    source: { kind: 'document' },
    review: { status: 'pending' }
  })

  const board = await buildBoard(dir, p.id)
  // 未核对的 50kg 不得进入任何计算：只剩一个已确认点时不得给出趋势结论，更不能出现 50
  assert.notEqual(board.dimensions.nutrition.lv, 'alert', '待核对数据不得触发预警')
  assert.ok(!String(board.dimensions.nutrition.note || '').includes('50'), '未核对的值不得出现在依据里')
  assert.deepEqual(board.watch, [])
})
