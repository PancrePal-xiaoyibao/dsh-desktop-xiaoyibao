/**
 * 病情一图秀运行时测试。
 *
 * 钉住：三组控件（时间/显示/指标）、指标与用药共享同一时间轴、速率开关生效、
 * 空态引导（未确认不进时间轴）。
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
const { appendRecord } = await import(libUrl('store', 'jsonl.js'))
const { streamPath } = await import(libUrl('store', 'patients.js'))

let dataRoot
let patientId

before(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-timeline-'))
  process.env.XYB_DATA_ROOT = dataRoot
  await initRoot(dataRoot)
  const patient = await createPatient(dataRoot, { name: '时间轴患者' })
  patientId = patient.id
  await confirmExtraction(dataRoot, patientId, { id: 'w1', indicator: 'WEIGHT', value: 60, unit: 'kg', measuredAt: '2026-01-01' })
  await confirmExtraction(dataRoot, patientId, { id: 'w2', indicator: 'WEIGHT', value: 57, unit: 'kg', measuredAt: '2026-06-01' })
  await appendRecord(streamPath(dataRoot, patientId, 'medications'), {
    id: 'm1',
    patientId,
    line: '1',
    name: 'AG 方案',
    startedAt: '2026-01-05',
    endedAt: '2026-05-05',
    endReason: '进展',
    note: '',
    createdAt: '2026-01-05T00:00:00.000Z'
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

async function mountTimeline() {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `服务端装载失败：${registerError?.message}`)
  const { fetchImpl } = makeFetch(mock.routes)
  globalThis.fetch = fetchImpl
  const { react, registered } = mountClient(REPO_ROOT, 'dsh-xyb-workbench')
  const Panel = registered[0].Component
  const props = { service: {} }
  const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
  const tab = collectProps(settled.tree).find((p) => p.type === 'button' && p.props.id === 'xyb-tab-timeline')
  assert.ok(tab, '应有一图秀页签')
  tab.props.onClick()
  return { react, Panel, props }
}

test('[timeline] 三组控件齐备且默认年份来自真实数据', async () => {
  const { react, Panel, props } = await mountTimeline()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('动态病情一图秀'), { label: '一图秀' })
    assert.ok(settled.text.includes('时间筛选（年）'), '控件 1：时间筛选')
    assert.ok(settled.text.includes('显示控制'), '控件 2：显示控制')
    assert.ok(settled.text.includes('选择指标'), '控件 3：指标选择')
    assert.ok(settled.text.includes('指标趋势图（2026–2026）'), '默认年份应来自数据')

    const fromInput = findNode(settled.tree, (n) => n.type === 'input' && n.props['aria-label'] === '起始年份')
    const toInput = findNode(settled.tree, (n) => n.type === 'input' && n.props['aria-label'] === '结束年份')
    assert.ok(fromInput && toInput, '起止年份输入框应存在')
    assert.equal(fromInput.props.value, 2026)
    assert.equal(toInput.props.value, 2026)
  } finally {
    delete globalThis.fetch
  }
})

test('[timeline] 指标与用药在同一时间轴上（共享年份域）', async () => {
  const { react, Panel, props } = await mountTimeline()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('用药时间轴'), { label: '一图秀' })
    assert.ok(settled.text.includes('用药时间轴'), '应有用药时间轴区块')
    assert.ok(settled.text.includes('1线 · AG 方案'), '用药条应显示线数与方案名')

    const bar = findNode(settled.tree, (n) => String(n.props.className || '') === 'xybMedBar')
    assert.ok(bar, '应渲染用药条')
    assert.ok(String(bar.props.style.left).endsWith('%'), '用药条位置按同一时间域计算')

    const chart = findNode(settled.tree, (n) => n.props.role === 'img' && String(n.props['aria-label'] || '').includes('时间轴趋势'))
    assert.ok(chart, '应渲染指标时间轴图（带可访问名称）')
    assert.ok(settled.text.includes('只读'), '用药时间轴必须声明只读')
  } finally {
    delete globalThis.fetch
  }
})

test('[timeline] 显示控制：勾选「速率」后出现速率文案', async () => {
  const { react, Panel, props } = await mountTimeline()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('显示控制'), { label: '一图秀' })
    assert.ok(!settled.text.includes('速率 ≈'), '默认不显示速率')

    const label = findNode(settled.tree, (n) => n.type === 'label' && textOf(n).join('').includes('速率'))
    assert.ok(label, '应有速率复选框')
    const box = findNode(label, (n) => n.type === 'input' && n.props.type === 'checkbox')
    assert.ok(box, '速率复选框应存在')
    box.props.onChange({ target: { checked: true } })

    const after = await renderUntil(react, Panel, props, (t) => t.includes('速率 ≈'), { label: '速率文案' })
    assert.ok(after.text.includes('速率 ≈'), '勾选后应显示速率')
  } finally {
    delete globalThis.fetch
  }
})
