/**
 * 营养 / 临床匹配 / 全程管理 三页运行时测试。
 *
 * 重点在「真数据 + 诚实边界」：
 * · 营养：体重是真数据；**不给能量配方、不给剂量**（M-2）；
 * · 匹配：入组档案读的是病情评估那份真档案；**不做自动入组判定**（M-4）；
 * 未实现的子页要写明归属，不铺演示数据；
 * · 全程：四类状态来自看板聚合；带管/血管通路如实标 。
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
const { updateAssess } = await import(libUrl('assess', 'profile.js'))

let dataRoot
let patientId

before(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-pages-'))
  process.env.XYB_DATA_ROOT = dataRoot
  await initRoot(dataRoot)
  const patient = await createPatient(dataRoot, { name: '三页患者' })
  patientId = patient.id
  await confirmExtraction(dataRoot, patientId, { id: 'w1', indicator: 'WEIGHT', value: 60, unit: 'kg', measuredAt: '2026-01-01' })
  await confirmExtraction(dataRoot, patientId, { id: 'w2', indicator: 'WEIGHT', value: 56, unit: 'kg', measuredAt: '2026-02-15' })
  await updateAssess(dataRoot, patientId, {
    basic: { age: 63, sex: 'male', ecog: 1, weightKg: 56 },
    diagnosis: { primary: '胰头', histology: '腺癌', stage: 'III', gene: ['KRAS G12D'] },
    pending: ['病理原件']
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

async function mountTab(tabId) {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `服务端装载失败：${registerError?.message}`)
  const { fetchImpl } = makeFetch(mock.routes)
  globalThis.fetch = fetchImpl
  const { react, registered } = mountClient(REPO_ROOT, 'dsh-xyb-workbench')
  const Panel = registered[0].Component
  const props = { service: {} }
  const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
  const tab = collectProps(settled.tree).find((p) => p.type === 'button' && p.props.id === `xyb-tab-${tabId}`)
  assert.ok(tab, `应有 ${tabId} 页签`)
  tab.props.onClick()
  return { react, Panel, props }
}

test('[nutrition] 真实体重 + 下降判定 + 不给配方不给剂量（M-2）', async () => {
  const { react, Panel, props } = await mountTab('nutrition')
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('当前状态') && t.includes('56 kg'), { label: '营养' })
    assert.ok(settled.text.includes('体重'), '应显示体重')
    assert.ok(settled.text.includes('较上次'), '应显示与上次的变化')
    assert.ok(settled.text.includes('需关注'), '体重下降 >2% 应判为需关注')
    assert.ok(settled.text.includes('本工作台不给能量配方，也不给补充剂剂量'), 'M-2：必须声明不给配方/剂量')
    assert.ok(settled.text.includes('剂量与用法均由医生决定'), '胰酶剂量必须交由医生')
  } finally {
    delete globalThis.fetch
  }
})

test('[match] 入组档案是真档案；未实现子页明说；不做自动判定（M-4）', async () => {
  const { react, Panel, props } = await mountTab('match')
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('与「病情评估」共用同一份档案'), { label: '匹配·入组档案' })
    assert.ok(settled.text.includes('63'), '入组档案应读到真实年龄')
    assert.ok(settled.text.includes('KRAS G12D'), '应读到真实分子特征')
    assert.ok(settled.text.includes('编辑请去'), '应说明与病情评估共用同一份档案')

    findButton(settled.tree, '匹配分析').props.onClick()
    const analysis = await renderUntil(react, Panel, props, (t) => t.includes('不做自动入组资格判定'), { label: '匹配分析' })
    assert.ok(analysis.text.includes('待人工'), 'M-4：需医生评估的项要标待人工')
    assert.ok(analysis.text.includes('尚未实现'), '未实现要如实占位')
    assert.ok(!/CHG-\d/.test(analysis.text), '不得对用户暴露内部变更编号')

    findButton(analysis.tree, '试验检索').props.onClick()
    const trials = await renderUntil(react, Panel, props, (t) => t.includes('试验检索尚未实现'), { label: '试验检索' })
    assert.ok(trials.text.includes('尚未提供'), '未实现要如实说明')
    assert.ok(!/CHG-\d/.test(trials.text), '不得对用户暴露内部变更编号')
  } finally {
    delete globalThis.fetch
  }
})

test('[care] 四类管理齐备；带管/血管通路如实标「未实现」', async () => {
  const { react, Panel, props } = await mountTab('care')
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('四类；状态来自已确认记录'), { label: '全程管理' })
    for (const label of ['毒性', '并发症', '带管', '血管通路']) {
      assert.ok(settled.text.includes(label), `应有「${label}」类`)
    }
    assert.ok(settled.text.includes('尚未提供'), '未实现类目要如实说明')
    assert.ok(!/CHG-\d/.test(settled.text), '不得对用户暴露内部变更编号')
    assert.ok(settled.text.includes('不铺演示数据'), '不得用演示数据冒充')
  } finally {
    delete globalThis.fetch
  }
})

// ── 回归（2026-10-19）：「渠道配置」页签曾引用被删除的组件 → 点进去直接白屏 ──
// 契约测试测不到（没有用例走到这个页签），所以这里必须真点一次。
test('[回归] 临床匹配 → 渠道配置：渲染青囊面板或其诚实的未载入态，不得崩、不得再是占位符', async () => {
  const { react, Panel, props } = await mountTab('match')
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('与「病情评估」共用同一份档案'), { label: '匹配·入组档案' })

    const chip = findButton(settled.tree, '渠道配置')
    assert.ok(chip, '临床匹配下应有「渠道配置」页签')
    chip.props.onClick()

    const view = await renderUntil(
      react,
      Panel,
      props,
      (t) => t.includes('检索通道') || t.includes('通道状态'),
      { label: '渠道配置' }
    )
    assert.ok(!view.text.includes('渠道配置尚未实现'), '不能再是占位符')
    assert.ok(view.text.trim().length > 0, '渲染不得为空（白屏）')
    assert.ok(!/CHG-d/.test(view.text), '不得对用户暴露内部变更编号')
  } finally {
    delete globalThis.fetch
  }
})
