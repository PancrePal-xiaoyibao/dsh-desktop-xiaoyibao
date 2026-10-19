/**
 * 诊断与日志面板—— 运行时测试。
 *
 * 静态断言只能证明「有个 section 叫诊断与日志」；这里要证明的是**行为**：
 * 真渲染 → 真读路由 → 真筛选 → 真刷新，并且文案里明确「只存本机、不含病历」。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { collectProps, makeFetch, mountClient, renderUntil, textOf } from '../../scripts/lib/client-sandbox.mjs'
import { bootPlugin } from '../../scripts/lib/host-contract-rules.mjs'
import { appendEvent } from '../../packages/dsh-xyb-workbench/lib/store/events.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

let dataRoot
before(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-logcenter-'))
  process.env.XYB_DATA_ROOT = dataRoot
})
after(() => {
  delete process.env.XYB_DATA_ROOT
  rmSync(dataRoot, { recursive: true, force: true })
})

/** 按**精确文本**找按钮（时间线筛选按钮的文本就是「全部/错误/警告/信息」）。 */
function findButtonExact(tree, label) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node.$$element) {
      if (!found && node.type === 'button' && textOf(node).join('').trim() === label) found = node
      walk(node.children)
    }
  }
  walk(tree)
  return found
}

function findButton(tree, label) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node.$$element) {
      if (!found && node.type === 'button' && textOf(node).join('').includes(label)) found = node
      walk(node.children)
    }
  }
  walk(tree)
  return found
}

async function mountShellWithEvents() {
  await appendEvent(dataRoot, { level: 'info', phase: 'app', code: 'READY_SEED', message: '工作台已启动（种子）' })
  await appendEvent(dataRoot, { level: 'error', phase: 'route', code: 'SEED_ERROR', message: 'DELETE /patient：找不到该档案' })

  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `服务端装载失败：${registerError?.message}`)
  const { fetchImpl, calls } = makeFetch(mock.routes)
  globalThis.fetch = fetchImpl
  const { react, registered } = mountClient(REPO_ROOT, 'dsh-xyb-workbench')
  return { react, Panel: registered[0].Component, props: { service: {} }, calls }
}

test('[日志中心] 设置页有时间线：种子事件可见 + 筛选按钮齐备', async () => {
  const { react, Panel, props } = await mountShellWithEvents()
  try {
    const shell = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    const settingsBtn = findButton(shell.tree, '设置')
    assert.ok(settingsBtn, '顶栏必须有设置入口')
    settingsBtn.props.onClick()

    const page = await renderUntil(react, Panel, props, (t) => t.includes('诊断与日志'), { label: '设置页' })
    void page
    // ⚠️ 时间线内容是异步取 /events/list 后才渲染的：只等标题会假红（并行负载下尤明显）。
    // 等一个**数据依赖**的标记（种子事件文案）—— §5.4.6 B1 要求条件驱动。
    const loaded = await renderUntil(react, Panel, props, (t) => t.includes('工作台已启动（种子）'), {
      label: '时间线数据已到'
    })
    assert.ok(loaded.text.includes('工作台已启动（种子）'), '时间线应显示已有事件')
    assert.ok(loaded.text.includes('找不到该档案'), '错误事件也应显示')

    for (const label of ['全部', '错误', '警告', '信息']) {
      const btn = findButtonExact(loaded.tree, label)
      assert.ok(btn, `时间线必须有「${label}」筛选按钮`)
      assert.equal(btn.props['aria-pressed'], label === '全部', '默认只看「全部」')
    }
    assert.ok(loaded.text.includes('只存在本机'), '必须向用户声明「只存本机」')
    assert.ok(loaded.text.includes('不含病历'), '必须向用户声明「不含病历内容」')
  } finally {
    delete globalThis.fetch
  }
})

test('[日志中心] 点「错误」→ 真发 level=error 请求，且列表只剩错误级', async () => {
  const { react, Panel, props, calls } = await mountShellWithEvents()
  try {
    const shell = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    const settingsBtn = findButton(shell.tree, '设置')
    assert.ok(settingsBtn, '顶栏必须有设置入口')
    settingsBtn.props.onClick()
    const page = await renderUntil(react, Panel, props, (t) => t.includes('诊断与日志'), { label: '设置页' })

    const errorFilter = findButtonExact(page.tree, '错误')
    assert.ok(errorFilter, '必须找到「错误」筛选按钮（顶栏按钮也带 aria-pressed，不能用下标取）')
    errorFilter.props.onClick()

    const filtered = await renderUntil(react, Panel, props, (t) => t.includes('找不到该档案') && !t.includes('工作台已启动（种子）'), {
      label: '只显示错误'
    })
    assert.ok(filtered.text.includes('找不到该档案'), '错误级仍然可见')
    assert.ok(!filtered.text.includes('工作台已启动（种子）'), '信息级应被筛掉')
    assert.ok(
      calls.some((c) => c.path === '/api/xyb/events/list' && String(c.search).includes('level=error')),
      `必须真发带 level=error 的请求，实际：${JSON.stringify(calls.slice(-3))}`
    )
  } finally {
    delete globalThis.fetch
  }
})

test('[日志中心] 导出诊断包按钮：真发 POST，并展示路径 / sha256 / 脱敏处数', async () => {
  const { react, Panel, props, calls } = await mountShellWithEvents()
  try {
    const shell = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    const settingsBtn = findButton(shell.tree, '设置')
    assert.ok(settingsBtn, '顶栏必须有设置入口')
    settingsBtn.props.onClick()
    const page = await renderUntil(react, Panel, props, (t) => t.includes('诊断与日志'), { label: '设置页' })
    void page
    // ⚠️ 预览摘要是异步请求 /diagnostics/preview 后才渲染的：必须等**数据依赖**的标记，
    // 否则并行负载下会「标题到了、数据未到」→ 假红。
    await renderUntil(react, Panel, props, (t) => t.includes('将包含'), { label: '预览摘要已到' })
    const loaded = await renderUntil(react, Panel, props, (t) => t.includes('将包含'), { label: '预览已就绪' })
    assert.ok(loaded.text.includes('将包含'), '导出前必须告诉用户包里有什么（透明性）')
    assert.ok(loaded.text.includes('已脱敏'), '概要里应体现脱敏处数')

    const exportBtn = findButton(loaded.tree, '导出诊断包')
    assert.ok(exportBtn, '诊断与日志区必须有「导出诊断包」按钮')
    exportBtn.props.onClick()

    const done = await renderUntil(react, Panel, props, (t) => t.includes('已导出到'), { label: '导出完成' })
    assert.ok(done.text.includes('sha256'), '必须回显 sha256（可自证文件未被改动）')
    assert.ok(done.text.includes('脱敏'), '必须回显脱敏处数')
    assert.ok(
      calls.some((c) => c.path === '/api/xyb/diagnostics/export' && c.method === 'POST'),
      `必须真发 POST /diagnostics/export，实际：${JSON.stringify(calls.slice(-4))}`
    )
  } finally {
    delete globalThis.fetch
  }
})
