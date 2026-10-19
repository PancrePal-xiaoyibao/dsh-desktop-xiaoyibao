/**
 * 大字模式（中老年可读性）—— M12-3 / W-5。
 *
 * 为什么要有这个测试：主人明确要求「字体增加一个大字体按钮，中老年人适合」。这是一个
 * **真实用户群（患者与家属，年龄偏大）的可读性需求**，而它天然容易退化成：
 * · 控件渲染了但点了没反应（状态没接上）；
 * · 换了档位但样式没跟上（CSS 变量没挂到根节点）；
 * · 关掉应用再打开就忘了（没持久化）。
 * 三种退化在「静态检查」与「看起来能点」里都看不出来，必须走真实渲染 + 真实点击 + 真实读写。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { collectProps, makeFetch, mountClient, renderUntil, textOf } from '../../scripts/lib/client-sandbox.mjs'
import { bootPlugin } from '../../scripts/lib/host-contract-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const CLIENT_SOURCE = readFileSync(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'client.js'), 'utf8')

const TEXT_SCALE_KEY = 'xyb:text-scale:v1'

let dataRoot
before(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-textscale-'))
  process.env.XYB_DATA_ROOT = dataRoot
})
after(() => {
  delete process.env.XYB_DATA_ROOT
  rmSync(dataRoot, { recursive: true, force: true })
})

/** 假 localStorage：记录读写，行为对齐 Web Storage 子集（与 default-entry 测试同一约定）。 */
function createFakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data
  }
}

async function mountShell(storage) {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `服务端装载失败：${registerError?.message}`)
  const { fetchImpl } = makeFetch(mock.routes)
  globalThis.fetch = fetchImpl
  const { react, registered } = mountClient(REPO_ROOT, 'dsh-xyb-workbench', { windowExtra: { localStorage: storage } })
  return { react, Panel: registered[0].Component, props: { service: {} } }
}

/** 按可见文本找按钮（顶栏按钮多，必须精确定位） */
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

function rootOf(tree) {
  return collectProps(tree).find((p) => String(p.props.className || '').includes('xybShell'))
}

function scaleButtons(tree) {
  return collectProps(tree).filter((p) => p.type === 'button' && /^xyb-(top|set)-scale-/.test(String(p.props.id || '')))
}

test('[大字] 默认标准档，三档齐备且当前档有 aria-pressed', async () => {
  const storage = createFakeStorage()
  const { react, Panel, props } = await mountShell(storage)
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    assert.equal(rootOf(settled.tree).props['data-text-scale'], 'normal', '默认必须是标准档')

    const buttons = scaleButtons(settled.tree)
    assert.equal(buttons.length, 3, `顶栏三档控应有 3 个按钮，实际 ${buttons.length}`)
    assert.deepEqual(
      buttons.map((b) => b.props.id),
      ['xyb-top-scale-normal', 'xyb-top-scale-large', 'xyb-top-scale-xlarge'],
      '三档按钮的 id 必须稳定（顶栏控件）'
    )
    assert.deepEqual(buttons.map((b) => b.props['aria-pressed']), [true, false, false], '只有当前档 aria-pressed')
    assert.ok(settled.text.includes('标准') && settled.text.includes('大字') && settled.text.includes('特大'), '三档文字必须直白可读')
  } finally {
    delete globalThis.fetch
  }
})

test('[大字] 点「特大」→ 根节点换档 + 写入 localStorage（真点击、真持久化）', async () => {
  const storage = createFakeStorage()
  const { react, Panel, props } = await mountShell(storage)
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    const xlarge = scaleButtons(settled.tree).find((b) => b.props.id === 'xyb-top-scale-xlarge')
    assert.ok(xlarge && typeof xlarge.props.onClick === 'function', '「特大」必须是可点按钮')
    xlarge.props.onClick()

    const after = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '换档后' })
    assert.equal(rootOf(after.tree).props['data-text-scale'], 'xlarge', '根节点必须换成特大档（CSS zoom 由此生效）')
    assert.equal(storage.getItem(TEXT_SCALE_KEY), 'xlarge', '选择必须被记住')
    const pressed = scaleButtons(after.tree).filter((b) => b.props['aria-pressed'])
    assert.deepEqual(pressed.map((b) => b.props.id), ['xyb-top-scale-xlarge'], '换成「特大」后只有它选中')
  } finally {
    delete globalThis.fetch
  }
})

test('[大字] 上次选过「大字」→ 下次打开直接生效（不要求用户再点一次）', async () => {
  const storage = createFakeStorage({ [TEXT_SCALE_KEY]: 'large' })
  const { react, Panel, props } = await mountShell(storage)
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    assert.equal(rootOf(settled.tree).props['data-text-scale'], 'large', '记忆的档位必须首屏生效')
    const pressed = scaleButtons(settled.tree).filter((b) => b.props['aria-pressed'])
    assert.deepEqual(pressed.map((b) => b.props.id), ['xyb-top-scale-large'], '「大字」必须显示为选中')
  } finally {
    delete globalThis.fetch
  }
})

test('[大字] 设置页同一控件 + 「关于」区两个 logo 均可点击外链', async () => {
  const storage = createFakeStorage()
  const { react, Panel, props } = await mountShell(storage)
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    const settingsBtn = findButton(settled.tree, '设置')
    assert.ok(settingsBtn && typeof settingsBtn.props.onClick === 'function', '顶栏必须有设置入口')
    settingsBtn.props.onClick()

    const page = await renderUntil(react, Panel, props, (t) => t.includes('显示与可读性'), { label: '设置页' })
    const setButtons = scaleButtons(page.tree).filter((b) => String(b.props.id).startsWith('xyb-set-scale-'))
    assert.equal(setButtons.length, 3, '设置页必须有同一套三档控（中老年使用者的可发现性）')
    assert.ok(page.text.includes('中老年使用者建议'), '设置页必须给出面向中老年的使用建议')

    const aboutLinks = collectProps(page.tree).filter((p) => p.type === 'a')
    const hrefs = aboutLinks.map((p) => p.props.href)
    assert.ok(hrefs.includes('https://github.com/PancrePal-xiaoyibao'), `关于区缺社区链接：${JSON.stringify(hrefs)}`)
    assert.ok(hrefs.includes('https://www.dshdesktop.cn/'), `关于区缺上游项目链接：${JSON.stringify(hrefs)}`)
    const aboutImgs = collectProps(page.tree).filter((p) => p.type === 'img' && String(p.props.src || '').startsWith('data:image/'))
    assert.ok(aboutImgs.length >= 2, '关于区必须展示两个品牌实图（社区开发者要求的可见度）')
  } finally {
    delete globalThis.fetch
  }
})

test('[大字] 缩放机制是 CSS 变量而非写死像素（三档值可核对）', () => {
  // 这是「换档真的会变大」的静态半边：根节点 data-text-scale → --xyb-zoom → zoom:var(--xyb-zoom,1)
  assert.match(CLIENT_SOURCE, /\.xybShell[^}]*zoom:var\(--xyb-zoom,1\)/, '外壳必须用 --xyb-zoom 驱动缩放')
  assert.match(CLIENT_SOURCE, /\[data-text-scale="large"\]\s*\{\s*--xyb-zoom:1\.15;?\s*\}/, '大字档必须是 1.15')
  assert.match(CLIENT_SOURCE, /\[data-text-scale="xlarge"\]\s*\{\s*--xyb-zoom:1\.32;?\s*\}/, '特大档必须是 1.32')
  assert.match(CLIENT_SOURCE, /zoom/, 'zoom 机制必须存在')
})
