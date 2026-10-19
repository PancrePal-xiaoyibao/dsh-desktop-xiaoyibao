/**
 * 首启向导—— 运行时测试。
 *
 * 要证明的是「第一次打开的人真的走得通」：
 * ① 首次打开弹出向导，四步都能看到，隐私与医学免责在第一步就讲清；
 * ② 数据目录那一步**真的**发探测请求，并把结果（能写 / 不能写 + 原因）显示出来；
 * ③ 界面大小那一步直接复用三档控（当场生效）；
 * ④ 最后一步建档 + 写 onboarding 标记 → 向导关闭；
 * ⑤ 「先跳过」也写标记，下次不再自动弹；设置页可以重新打开。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { collectProps, makeFetch, mountClient, renderUntil, textOf } from '../../scripts/lib/client-sandbox.mjs'
import { bootPlugin } from '../../scripts/lib/host-contract-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

let dataRoot
before(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-wizard-ui-'))
  process.env.XYB_DATA_ROOT = dataRoot
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
  // 每个用例都要从「首次打开」开始：清掉 onboarding 标记（否则前一个用例写下的
  // done=true 会让后续用例里向导不再自动弹出 —— 这正是它该有的行为，只是测试需要干净起点）
  writeFileSync(join(dataRoot, 'settings.json'), JSON.stringify({}), 'utf8')

  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `服务端装载失败：${registerError?.message}`)
  const { fetchImpl, calls } = makeFetch(mock.routes)
  globalThis.fetch = fetchImpl
  const { react, registered } = mountClient(REPO_ROOT, 'dsh-xyb-workbench')
  return { react, Panel: registered[0].Component, props: { service: {} }, calls }
}

test('[向导] 首次打开自动弹出：四步进度 + 隐私与免责在第一步讲清', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('欢迎使用小胰宝社区版'), { label: '向导' })
    for (const label of ['1 欢迎', '2 数据目录', '3 界面大小', '4 建立档案']) {
      assert.ok(settled.text.includes(label), `必须显示步骤进度「${label}」`)
    }
    assert.ok(settled.text.includes('所有资料都保存在你自己的电脑上'), '第一步必须讲清数据在哪')
    assert.ok(settled.text.includes('只有两种情况会联网'), '第一步必须讲清联网边界')
    assert.ok(settled.text.includes('不做诊断'), '第一步必须带医学免责')
    assert.ok(findButton(settled.tree, '先跳过'), '任何一步都能跳过')
  } finally {
    delete globalThis.fetch
  }
})

test('[向导] 数据目录那一步真发探测请求，并显示结果', async () => {
  const { react, Panel, props, calls } = await mountShell()
  try {
    const step0 = await renderUntil(react, Panel, props, (t) => t.includes('欢迎使用小胰宝社区版'), { label: '向导' })
    findButton(step0.tree, '下一步').props.onClick() // → 第 2 步

    const step1 = await renderUntil(react, Panel, props, (t) => t.includes('数据存放在哪里'), { label: '第 2 步' })
    assert.ok(step1.text.includes(dataRoot.replace(/\\/g, '\\')) || step1.text.includes('当前数据目录'), '必须显示当前数据目录')

    const probeBtn = findButton(step1.tree, '检测能不能写')
    assert.ok(probeBtn, '必须提供「检测能不能写」入口')
    probeBtn.props.onClick()

    const done = await renderUntil(react, Panel, props, (t) => t.includes('可以正常读写'), { label: '探测结果' })
    assert.ok(done.text.includes('可以正常读写'), '可写时必须明确告诉用户')
    assert.ok(
      calls.some((c) => c.path === '/api/xyb/probe-dir' && c.method === 'POST'),
      `必须真发探测请求，实际：${JSON.stringify(calls.filter((c) => c.path.includes('probe-dir')))}`
    )
  } finally {
    delete globalThis.fetch
  }
})

test('[向导] 走到最后建档 → 关闭向导并写入 onboarding.done', async () => {
  const { react, Panel, props, calls } = await mountShell()
  try {
    const step0 = await renderUntil(react, Panel, props, (t) => t.includes('欢迎使用小胰宝社区版'), { label: '向导' })
    findButton(step0.tree, '下一步').props.onClick()
    const step1 = await renderUntil(react, Panel, props, (t) => t.includes('数据存放在哪里'), { label: '第 2 步' })
    findButton(step1.tree, '检测能不能写').props.onClick()
    const probed = await renderUntil(react, Panel, props, (t) => t.includes('可以正常读写'), { label: '探测通过' })
    findButton(probed.tree, '下一步').props.onClick()

    const step2 = await renderUntil(react, Panel, props, (t) => t.includes('选一个看得清的大小'), { label: '第 3 步' })
    // 第 3 步：直接复用三档控（当场生效）
    const xlarge = collectProps(step2.tree).find((p) => p.type === 'button' && p.props.id === 'xyb-wizard-scale-xlarge')
    assert.ok(xlarge, '第 3 步必须有「特大」档按钮')
    xlarge.props.onClick()
    const scaled = await renderUntil(react, Panel, props, (t) => t.includes('选一个看得清的大小'), { label: '换档后' })
    const root = collectProps(scaled.tree).find((p) => String(p.props.className || '').includes('xybShell'))
    assert.equal(root.props['data-text-scale'], 'xlarge', '向导里换档必须当场生效')

    findButton(scaled.tree, '下一步').props.onClick()
    const step3 = await renderUntil(react, Panel, props, (t) => t.includes('建立第一份档案'), { label: '第 4 步' })
    const input = collectProps(step3.tree).find((p) => p.type === 'input' && p.props['aria-label'] === '档案名称')
    assert.ok(input && typeof input.props.onChange === 'function', '必须能填档案名称')
    input.props.onChange({ target: { value: '妈妈' } })

    const ready = await renderUntil(react, Panel, props, (t) => t.includes('建立第一份档案'), { label: '填好后' })
    const finish = findButton(ready.tree, '完成并开始')
    assert.ok(finish, '必须有「完成并开始」')
    finish.props.onClick()

    const after = await renderUntil(react, Panel, props, (t) => !t.includes('建立第一份档案') && !t.includes('欢迎使用小胰宝社区版'), { label: '向导关闭' })
    assert.ok(!after.text.includes('欢迎使用小胰宝社区版'), '完成后向导应关闭')
    assert.ok(!after.text.includes('建立第一份档案'), '完成后向导应关闭（第 4 步文案也应消失）')
    assert.ok(after.text.includes('妈妈'), '新建的档案应出现在顶栏档案选择里')
    assert.ok(
      calls.some((c) => c.path === '/api/xyb/patients' && c.method === 'POST'),
      '必须真建档'
    )
    assert.ok(
      calls.some((c) => c.path === '/api/xyb/settings' && c.method === 'POST'),
      '必须写 onboarding 标记（否则下次还会弹）'
    )
  } finally {
    delete globalThis.fetch
  }
})

test('[向导] 先跳过：写 skipped 标记并关闭；设置页可重新打开', async () => {
  const { react, Panel, props, calls } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('欢迎使用小胰宝社区版'), { label: '向导' })
    findButton(settled.tree, '先跳过').props.onClick()
    const after = await renderUntil(react, Panel, props, (t) => !t.includes('欢迎使用小胰宝社区版'), { label: '跳过' })
    assert.ok(!after.text.includes('欢迎使用小胰宝社区版'), '跳过应向导关闭')
    assert.ok(
      calls.some((c) => c.path === '/api/xyb/settings' && c.method === 'POST' && String(c.search) === ''),
      '跳过必须写标记'
    )

    // 设置页入口：重新打开
    const settingsBtn = findButton(after.tree, '设置')
    assert.ok(settingsBtn, '顶栏需有设置入口')
    settingsBtn.props.onClick()
    const page = await renderUntil(react, Panel, props, (t) => t.includes('首次设置向导'), { label: '设置页' })
    const reopen = findButton(page.tree, '重新打开向导')
    assert.ok(reopen, '设置页必须提供「重新打开向导」')
    reopen.props.onClick()
    const reopened = await renderUntil(react, Panel, props, (t) => t.includes('欢迎使用小胰宝社区版'), { label: '重开向导' })
    assert.ok(reopened.text.includes('数据目录'), '重开后应回到向导流程')
  } finally {
    delete globalThis.fetch
  }
})
