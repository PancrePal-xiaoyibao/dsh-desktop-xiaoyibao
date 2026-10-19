/**
 * 心理支持运行时测试。
 *
 * 医学红线自动化：
 * · M-5：四个子页（自评/缓解/安宁/哀伤）**每一页**都必须出现危机资源；
 * · M-3：只呈现分数，不解读——页面不得出现解读性措辞，量表页要写明不解读；
 * · 分数可记录并回读（真数据）。
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

let dataRoot
let patientId

before(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-psych-ui-'))
  process.env.XYB_DATA_ROOT = dataRoot
  await initRoot(dataRoot)
  const patient = await createPatient(dataRoot, { name: '心理患者' })
  patientId = patient.id
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

async function mountPsych() {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `服务端装载失败：${registerError?.message}`)
  const { fetchImpl } = makeFetch(mock.routes)
  globalThis.fetch = fetchImpl
  const { react, registered } = mountClient(REPO_ROOT, 'dsh-xyb-workbench')
  const Panel = registered[0].Component
  const props = { service: {} }
  const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
  const tab = collectProps(settled.tree).find((p) => p.type === 'button' && p.props.id === 'xyb-tab-psych')
  assert.ok(tab, '应有心理支持页签')
  tab.props.onClick()
  return { react, Panel, props }
}

const CRISIS_MARKS = ['如果你现在处于危机中', '不能提供危机干预', '12356']

test('[psych] M-5：四个子页每一页都有危机资源', async () => {
  const { react, Panel, props } = await mountPsych()
  try {
    // 用页面内容等待（不能用页签文案，否则会在页面加载前就命中）
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('如果你现在处于危机中'), { label: '心理支持' })
    for (const label of ['情绪自评', '心理缓解', '安宁疗护', '哀伤管理']) {
      findButton(settled.tree, label).props.onClick()
      const view = await renderUntil(react, Panel, props, (t) => t.includes('如果你现在处于危机中') && t.includes(label), { label })
      for (const mark of CRISIS_MARKS) {
        assert.ok(view.text.includes(mark), `「${label}」页必须包含危机标记「${mark}」（M-5）`)
      }
    }
  } finally {
    delete globalThis.fetch
  }
})

test('[psych] M-3：只呈现分数不解读，且如实声明分界待核对（不暴露内部编号）', async () => {
  const { react, Panel, props } = await mountPsych()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('情绪自评'), { label: '情绪自评' })
    assert.ok(settled.text.includes('工作台不对分数做解读'), '必须声明不解读')
    assert.ok(!/CHG-\d/.test(settled.text), '不得对用户暴露内部变更编号')
    assert.ok(/官方分界标准核对后|待核对官方来源/.test(settled.text), '分界未核对前必须如实说明')
    for (const banned of ['中度抑郁', '重度抑郁', '说明你', '诊断为']) {
      assert.ok(!settled.text.includes(banned), `不得出现解读性措辞「${banned}」`)
    }
  } finally {
    delete globalThis.fetch
  }
})

test('[psych] 记录分数 → 列表回读（真数据）', async () => {
  const { react, Panel, props } = await mountPsych()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('已记录的分数'), { label: '情绪自评' })
    const scoreInput = findNode(settled.tree, (n) => n.type === 'input' && n.props['aria-label'] === '分数')
    assert.ok(scoreInput, '应有分数输入框')
    scoreInput.props.onChange({ target: { value: '7' } })

    const save = findButton(react.render(Panel, props).tree, '记录分数')
    assert.ok(save, '应有记录按钮')
    save.props.onClick()

    const after = await renderUntil(react, Panel, props, (t) => t.includes('已记录。工作台不对分数做解读。'), { label: '保存反馈' })
    assert.ok(after.text.includes('7 分'), '列表里应出现刚记录的分数')
    assert.ok(after.text.includes(`已记录的分数（1）`), '计数应为 1')
  } finally {
    delete globalThis.fetch
  }
})
