/**
 * 看板运行时测试。
 *
 * 三个区块、维度卡展开、查看详情跳转、未上传标注——全部走真实 client.js +
 * 真实服务端路由 + 真实数据根（种子数据用 lib 直接写入，与生产同一套）。
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

let dataRoot
before(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-dash-'))
  process.env.XYB_DATA_ROOT = dataRoot
  await initRoot(dataRoot)
  const p = await createPatient(dataRoot, { name: '看板患者' })
  await confirmExtraction(dataRoot, p.id, { id: 'w1', indicator: 'WEIGHT', value: 60, unit: 'kg', measuredAt: '2026-01-01' })
  await confirmExtraction(dataRoot, p.id, { id: 'w2', indicator: 'WEIGHT', value: 58, unit: 'kg', measuredAt: '2026-02-15' })
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

async function mountShell() {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `服务端装载失败：${registerError?.message}`)
  const { fetchImpl } = makeFetch(mock.routes)
  globalThis.fetch = fetchImpl
  const { react, registered } = mountClient(REPO_ROOT, 'dsh-xyb-workbench')
  return { react, Panel: registered[0].Component, props: { service: {} } }
}

test('[dash] 三个区块齐备：需关注项 / 维度状态 / 全程管理', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('需关注项'), { label: '看板三区块' })
    const text = settled.text
    assert.ok(text.includes('需关注项'), '区块 1：需关注项')
    assert.ok(text.includes('维度状态'), '区块 2：维度状态')
    assert.ok(text.includes('7 个维度 · 点击展开依据'), '维度区说明与原型一致')
    assert.ok(text.includes('全程管理'), '区块 3：全程管理')
    assert.ok(text.includes('贯穿治疗过程的四类管理'), '全程管理说明与原型一致')
    // 需关注项来自真实聚合（体重下降 3.3% → watch），带跳转按钮
    assert.ok(text.includes('体重下降'), '需关注项应带真实依据')
    assert.ok(text.includes('带管') && text.includes('血管通路'), '全程管理四类齐备')
  } finally {
    delete globalThis.fetch
  }
})

test('[dash] 维度卡点击展开依据，内有「查看详情」跳转', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('维度状态'), { label: '看板' })
    const dimRow = findNode(
      settled.tree,
      (n) => n.type === 'button' && n.props['aria-expanded'] === false && textOf(n).join('').includes('营养')
    )
    assert.ok(dimRow, '应有营养维度卡（可展开）')
    dimRow.props.onClick()

    const expanded = await renderUntil(react, Panel, props, (t) => t.includes('体重下降'), { label: '展开依据' })
    const detail = findNode(expanded.tree, (n) => n.type === 'button' && textOf(n).join('').includes('查看详情'))
    assert.ok(detail, '展开后应有「查看详情」按钮')

    detail.props.onClick()
    const after = react.render(Panel, props)
    const tabs = collectProps(after.tree).filter((p) => p.type === 'button' && p.props.role === 'tab')
    assert.equal(tabs[4].props['aria-selected'], true, '查看详情应跳到营养管理页签')
  } finally {
    delete globalThis.fetch
  }
})

test('[dash] 维度卡颜色由方向语义决定（体重下降 = 需关注，不是「因为箭头向下」）', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('维度状态'), { label: '看板' })
    const dot = findNode(settled.tree, (n) => n.type === 'i' && String(n.props.className || '').includes('xybDot'))
    assert.ok(dot, '维度卡必须有状态点')
    assert.ok(String(dot.props.className).includes('watch'), `体重下降应判为 watch，实际 ${dot.props.className}`)
  } finally {
    delete globalThis.fetch
  }
})
