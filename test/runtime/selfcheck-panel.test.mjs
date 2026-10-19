/**
 * 数据自检面板—— 运行时测试。
 *
 * 要证明的是「用户真能用它救回自己」：面板渲染检查项 → 有问题的项给「修复」按钮 →
 * 点击真的发请求 → 结果回显（含备份名）。文案必须让非技术用户看懂。
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { collectProps, makeFetch, mountClient, renderUntil, textOf } from '../../scripts/lib/client-sandbox.mjs'
import { bootPlugin } from '../../scripts/lib/host-contract-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

let dataRoot
before(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-selfcheck-ui-'))
  process.env.XYB_DATA_ROOT = dataRoot
  // 造一个真实可检出的问题：临时文件残留（用户能一键清掉的那种）
  mkdirSync(join(dataRoot, 'patients'), { recursive: true })
  writeFileSync(join(dataRoot, '.manifest.json.tmp-feedface'), 'x', 'utf8')
})
after(() => {
  delete process.env.XYB_DATA_ROOT
  rmSync(dataRoot, { recursive: true, force: true })
})

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

async function mountShell() {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `服务端装载失败：${registerError?.message}`)
  const { fetchImpl, calls } = makeFetch(mock.routes)
  globalThis.fetch = fetchImpl
  const { react, registered } = mountClient(REPO_ROOT, 'dsh-xyb-workbench')
  return { react, Panel: registered[0].Component, props: { service: {} }, calls }
}

test('[自检面板] 设置页展示检查项与汇总，并说明「会不会自己修」', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const shell = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    const settingsBtn = findButton(shell.tree, '设置')
    assert.ok(settingsBtn, '顶栏必须有设置入口')
    settingsBtn.props.onClick()

    const page = await renderUntil(react, Panel, props, (t) => t.includes('数据自检'), { label: '设置页' })
    void page
    // ⚠️ 不能只等「数据自检」这个标题：自检项是异步请求 /selfcheck 后才渲染的，
    // 并行负载下会先渲染出标题、后渲染出数据。等一个**数据依赖**的标记，
    // 否则就是「等固定时机」的假红。
    const loaded = await renderUntil(react, Panel, props, (t) => t.includes('数据目录可写'), { label: '自检数据已到' })
    const pageText = loaded.text
    for (const label of ['数据目录可写', '设置文件', '档案清单', '记录文件完整性', '备份可用性', '磁盘余量']) {
      assert.ok(pageText.includes(label), `自检面板应列出「${label}」`)
    }
    assert.ok(/正常 \d+ · 需注意 \d+ · 故障 \d+/.test(pageText), '必须给出汇总计数')
    assert.ok(pageText.includes('修复前会先在本机做一份完整备份'), '必须讲清修复的安全边界')
    assert.ok(pageText.includes('不会删除你的档案与记录'), '必须明确不动业务数据')
    const recheck = findButton(loaded.tree, '重新检查')
    assert.ok(recheck && typeof recheck.props.onClick === 'function', '必须有「重新检查」入口')
  } finally {
    delete globalThis.fetch
  }
})

test('[自检面板] 有问题的项给出「修复」按钮 → 真发 POST → 回显结果与备份名', async () => {
  const { react, Panel, props, calls } = await mountShell()
  try {
    const shell = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    findButton(shell.tree, '设置').props.onClick()

    const page = await renderUntil(react, Panel, props, (t) => t.includes('临时文件残留'), { label: '设置页' })
    void page
    // 等「数据 + 等级」同时到位（面板是异步取 /selfcheck 的；只等标签会假红）
    const loaded = await renderUntil(react, Panel, props, (t) => t.includes('临时文件残留') && t.includes('需注意'), {
      label: '残留项已报「需注意」'
    })
    assert.ok(loaded.text.includes('需注意'), '临时残留应显示为「需注意」')

    const repairBtn = findButton(loaded.tree, '修复')
    assert.ok(repairBtn, '可修复项必须给出「修复」按钮')
    repairBtn.props.onClick()

    const done = await renderUntil(react, Panel, props, (t) => t.includes('已修复'), { label: '修复完成' })
    assert.ok(done.text.includes('清理'), '应回显做了什么（清理临时文件）')
    assert.ok(done.text.includes('备份'), '应回显修复前备份名')
    assert.ok(
      calls.some((c) => c.path === '/api/xyb/selfcheck/repair' && c.method === 'POST'),
      `必须真发 POST /selfcheck/repair，实际：${JSON.stringify(calls.slice(-4))}`
    )
    // 复检结果来自响应的 after：问题项应已转绿
    assert.ok(done.text.includes('正常'), '复检后面板应显示正常计数')
  } finally {
    delete globalThis.fetch
  }
})
