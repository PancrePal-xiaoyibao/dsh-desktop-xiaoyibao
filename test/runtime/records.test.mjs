/**
 * 病情整理运行时测试。
 *
 * 覆盖：五子页签、报告核对（核对前后与就地结清）、指标趋势（真实指标卡 + 对比上限）、
 * 病情汇总（真实派生）、资料库（诚实占位）。全部走真实 client.js + 真实路由 + 真实数据根。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { collectProps, makeFetch, mountClient, renderUntil, textOf } from '../../scripts/lib/client-sandbox.mjs'
import { bootPlugin } from '../../scripts/lib/host-contract-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const LIB = resolve(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'lib')
const libUrl = (...segments) => pathToFileURL(join(LIB, ...segments)).href

const { initRoot, createPatient } = await import(libUrl('store', 'patients.js'))
const { confirmExtraction } = await import(libUrl('metrics', 'records.js'))
const { listPending, listRecords } = await import(libUrl('metrics', 'query.js'))
const { appendRecord } = await import(libUrl('store', 'jsonl.js'))
const { streamPath } = await import(libUrl('store', 'patients.js'))

let dataRoot
let patientId

before(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-records-'))
  process.env.XYB_DATA_ROOT = dataRoot
  await initRoot(dataRoot)
  const patient = await createPatient(dataRoot, { name: '整理患者' })
  patientId = patient.id
  // 已确认的体重序列（趋势/汇总用）
  await confirmExtraction(dataRoot, patientId, { id: 'w1', indicator: 'WEIGHT', value: 60, unit: 'kg', measuredAt: '2026-01-01' })
  await confirmExtraction(dataRoot, patientId, { id: 'w2', indicator: 'WEIGHT', value: 58, unit: 'kg', measuredAt: '2026-02-15' })
  // 一条机器抽取、待核对的记录（核对子页用）
  await appendRecord(streamPath(dataRoot, patientId, 'records'), {
    id: 'pending-1',
    patientId,
    indicator: 'CA19-9',
    value: 148,
    unit: 'U/mL',
    measuredAt: '2026-03-01',
    source: { kind: 'document', rawText: '糖类抗原 19-9', pageNo: 2, documentId: 'doc-1' },
    review: { status: 'pending' }
  })
})

after(() => {
  delete process.env.XYB_DATA_ROOT
  rmSync(dataRoot, { recursive: true, force: true })
})

function findNode(tree, predicate) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node.$$element) {
      if (!found && predicate(node)) found = node
      walk(node.children)
    }
  }
  walk(tree)
  return found
}

const findButton = (tree, label) =>
  findNode(tree, (n) => n.type === 'button' && !n.props.disabled && textOf(n).join('').includes(label))

async function mountRecords() {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `服务端装载失败：${registerError?.message}`)
  const { fetchImpl } = makeFetch(mock.routes)
  globalThis.fetch = fetchImpl
  const { react, registered } = mountClient(REPO_ROOT, 'dsh-xyb-workbench')
  const Panel = registered[0].Component
  const props = { service: {} }
  // 切到「病情整理」页签
  const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
  const recordsTab = collectProps(settled.tree).find((p) => p.type === 'button' && p.props.id === 'xyb-tab-records')
  assert.ok(recordsTab, '应有病情整理页签')
  recordsTab.props.onClick()
  return { react, Panel, props }
}

test('[records] 五个子页齐备，默认停在高频使用的指标趋势', async () => {
  const { react, Panel, props } = await mountRecords()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('多指标对比上限'), { label: '病情整理·指标趋势' })
    for (const label of ['资料库', '报告核对', '指标趋势', '病情评估', '病情汇总']) {
      assert.ok(settled.text.includes(label), `子页签应包含「${label}」`)
    }
    assert.ok(settled.text.includes('多指标对比上限 8 个'), '对比上限要写在界面上')
  } finally {
    delete globalThis.fetch
  }
})

test('[records] 报告核对：确认后待办就地消失，且数据层变为已确认', async () => {
  const { react, Panel, props } = await mountRecords()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('报告核对'), { label: '病情整理' })
    findButton(settled.tree, '报告核对').props.onClick()

    const review = await renderUntil(react, Panel, props, (t) => t.includes('待确认（1）'), { label: '待确认列表' })
    assert.ok(review.text.includes('糖类抗原 19-9'), '待确认项应显示机器抽取的原文')
    assert.ok(review.text.includes('机器抽取'), '来源要可见')
    assert.ok(review.text.includes('第 2 页'), '页码要可见')

    findButton(review.tree, '确认').props.onClick()
    const afterConfirm = await renderUntil(react, Panel, props, (t) => t.includes('已确认，这条记录已进入趋势'), { label: '确认反馈' })
    assert.ok(afterConfirm.text.includes('待确认（0）'), '确认后待办应就地消失')

    // 数据层复核（回归 P-15：复用 id，不产生重复，也不残留）
    const pending = await listPending(dataRoot, patientId)
    assert.deepEqual(pending.items, [], '待确认清单应为空')
    const { items } = await listRecords(dataRoot, patientId, { indicator: 'CA19-9' })
    assert.equal(items.length, 1, '应恰好一条已确认记录（不重复）')
    assert.equal(items[0].id, 'pending-1', '就地结清：复用原 id')
    assert.equal(items[0].review.status, 'confirmed')
  } finally {
    delete globalThis.fetch
  }
})

test('[records] 指标趋势：真实指标卡（名称/值/参考/最近变化）+ 加入对比', async () => {
  const { react, Panel, props } = await mountRecords()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('体重'), { label: '指标卡' })
    assert.ok(settled.text.includes('58 kg'), '应显示最新体重')
    assert.ok(settled.text.includes('参考'), '应显示参考范围')
    assert.ok(/最近变化(下降|上升|持平|单次记录)/.test(settled.text), '应显示最近变化（方向语义）')

    const compare = findButton(settled.tree, '加入对比')
    assert.ok(compare, '指标卡应有加入对比按钮')
    compare.props.onClick()
    const compared = await renderUntil(react, Panel, props, (t) => t.includes('多指标对比（1/8）'), { label: '对比面板' })
    assert.ok(compared.text.includes('共享时间轴 · 各图独立纵轴'), '对比面板要写明读图规则')
  } finally {
    delete globalThis.fetch
  }
})

test('[records] 病情汇总：真实派生（维度一览 + 关键指标 + 待办提示）', async () => {
  const { react, Panel, props } = await mountRecords()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('病情汇总'), { label: '病情整理' })
    findButton(settled.tree, '病情汇总').props.onClick()

    const summary = await renderUntil(react, Panel, props, (t) => t.includes('维度一览'), { label: '汇总' })
    assert.ok(summary.text.includes('资料完整度'), '应显示完整度')
    assert.ok(summary.text.includes('准备问医生的问题'), '应有问题清单区块')
  } finally {
    delete globalThis.fetch
  }
})

test('[records] 病情评估：五组齐备，填写年龄保存后能回读', async () => {
  const { react, Panel, props } = await mountRecords()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('多指标对比上限'), { label: '病情整理' })
    findButton(settled.tree, '病情评估').props.onClick()

    const assess = await renderUntil(react, Panel, props, (t) => t.includes('未填的项保持「未填写」'), { label: '病情评估' })
    for (const label of ['基本情况', '诊断与病理', '治疗经过', '当前关键指标', '待补充项']) {
      assert.ok(assess.text.includes(label), `应有「${label}」组`)
    }
    assert.ok(assess.text.includes('这份档案同时供临床匹配使用'), '档案共用说明要可见')

    const ageInput = findNode(assess.tree, (n) => n.type === 'input' && n.props['aria-label'] === '年龄')
    assert.ok(ageInput, '应有年龄输入框')
    ageInput.props.onChange({ target: { value: '62' } })

    const save = findButton(react.render(Panel, props).tree, '保存评估档案')
    assert.ok(save, '应有保存按钮')
    save.props.onClick()

    const saved = await renderUntil(react, Panel, props, (t) => t.includes('已保存'), { label: '保存反馈' })
    assert.ok(saved.text.includes('已保存'), '应显示保存成功')

    const { readAssess } = await import(libUrl('assess', 'profile.js'))
    const profile = await readAssess(dataRoot, patientId)
    assert.equal(profile.basic.age, 62, '数据层应能读回刚保存的年龄')
  } finally {
    delete globalThis.fetch
  }
})

test('[records] 资料库：文档导入未实现必须明说（不用假条目冒充）', async () => {
  const { react, Panel, props } = await mountRecords()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料库'), { label: '病情整理' })
    findButton(settled.tree, '资料库').props.onClick()
    const library = await renderUntil(react, Panel, props, (t) => t.includes('文档导入尚未实现'), { label: '资料库' })
    assert.ok(library.text.includes('尚未提供'), '未实现要如实说明')
    assert.ok(!/CHG-\d/.test(library.text), '不得对用户暴露内部变更编号')
    assert.ok(library.text.includes('已确认记录'), '真实记录统计要可见')
  } finally {
    delete globalThis.fetch
  }
})
