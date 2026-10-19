/**
 * 外壳运行时测试 —— M11-1 / US-1101。
 *
 * 覆盖的是「外壳本身」：顶栏四项、1–7 编号页签、键盘导航、设置入口、AI 协助开合、
 * 无档案空态。全部走真实 client.js + 真实服务端路由（同 client-mount 的基础设施），
 * 不是静态断言——第四次崩溃的教训是「静态检查看不见运行时语义」。
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

const TAB_KEYS = ['dash', 'records', 'timeline', 'match', 'nutrition', 'psych', 'care']

let dataRoot
before(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-shell-'))
  process.env.XYB_DATA_ROOT = dataRoot
})
after(() => {
  delete process.env.XYB_DATA_ROOT
  rmSync(dataRoot, { recursive: true, force: true })
})

async function serverRoutes(name) {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', name, 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `${name} 服务端装载失败：${registerError?.message}`)
  return mock.routes
}

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

/** 按文本找按钮（外壳里按钮很多，必须精确定位） */
function findButton(tree, label, { includeDisabled = false } = {}) {
  let found = null
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node.$$element) {
      const isMatch =
        node.type === 'button' &&
        (includeDisabled || !node.props.disabled) &&
        textOf(node).join('').includes(label)
      if (isMatch) found = node
      walk(node.children)
    }
  }
  walk(tree)
  return found
}

async function mountShell() {
  const routes = await serverRoutes('dsh-xyb-workbench')
  const { fetchImpl } = makeFetch(routes)
  globalThis.fetch = fetchImpl
  const { react, registered } = mountClient(REPO_ROOT, 'dsh-xyb-workbench')
  const Panel = registered[0].Component
  return { react, Panel, props: { service: {} } }
}

test('[shell] 顶栏四项 + 七个编号页签 + AI 协助面板', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳顶栏' })
    const text = settled.text
    assert.ok(text.includes('小胰宝'), '顶栏应有品牌名')
    assert.ok(text.includes('资料留在本机'), '顶栏应有本机标识')
    assert.ok(text.includes('设置'), '顶栏应有设置入口')
    assert.ok(text.includes('AI 协助'), '顶栏应有 AI 协助入口')

    const tabs = collectProps(settled.tree).filter((p) => p.type === 'button' && p.props.role === 'tab')
    assert.equal(tabs.length, 7, `页签应为 7 个，实际 ${tabs.length}`)
    assert.deepEqual(
      tabs.map((t) => t.props['aria-selected']),
      [true, false, false, false, false, false, false],
      '首个页签选中，其余未选中'
    )
    tabs.forEach((t, i) => assert.equal(t.props.id, `xyb-tab-${TAB_KEYS[i]}`, `页签 ${i + 1} 的 id`))
    assert.ok(tabs.every((t) => t.props.tabIndex === 0 || t.props.tabIndex === -1), 'roving tabindex 必须存在')
    assert.ok(tabs.every((t) => t.props['aria-controls'] === 'xyb-panel'), '页签必须指向面板')
  } finally {
    delete globalThis.fetch
  }
})

test('[shell] 点页签切换 aria-selected，并渲染该页内容', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    const timelineTab = collectProps(settled.tree).find((p) => p.type === 'button' && p.props.id === 'xyb-tab-timeline')
    assert.ok(timelineTab, '应有「病情一图秀」页签')
    timelineTab.props.onClick()

    const after = await renderUntil(react, Panel, props, (t) => t.includes('尚未实现'), { label: '未实现页占位' })
    const tabs = collectProps(after.tree).filter((p) => p.type === 'button' && p.props.role === 'tab')
    assert.equal(tabs[2].props['aria-selected'], true, '第 3 个页签应选中')
    assert.equal(tabs[0].props['aria-selected'], false, '第 1 个页签应取消选中')
    // 诚实占位：未实现页必须写明归属，不铺演示数据
    assert.ok(after.text.includes('此页尚未实现'), '未实现页要有明确占位')
    assert.ok(/后续版本|尚未提供/.test(after.text), '占位要给用户能读懂的说明')
    assert.ok(!/CHG-\d/.test(after.text), '产品界面不得出现内部变更编号（主人 2026-10-17 指令）')
  } finally {
    delete globalThis.fetch
  }
})

test('[shell] 页签键盘导航：→/←/Home/End', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    const dashTab = collectProps(settled.tree).find((p) => p.type === 'button' && p.props.id === 'xyb-tab-dash')
    assert.ok(dashTab && typeof dashTab.props.onKeyDown === 'function', '页签必须有键盘处理')

    dashTab.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
    let tabs = collectProps(react.render(Panel, props).tree).filter((p) => p.type === 'button' && p.props.role === 'tab')
    assert.equal(tabs[1].props['aria-selected'], true, '→ 应选中下一个页签')

    tabs[1].props.onKeyDown({ key: 'End', preventDefault() {} })
    tabs = collectProps(react.render(Panel, props).tree).filter((p) => p.type === 'button' && p.props.role === 'tab')
    assert.equal(tabs[6].props['aria-selected'], true, 'End 应选中最后一个页签')

    tabs[6].props.onKeyDown({ key: 'Home', preventDefault() {} })
    tabs = collectProps(react.render(Panel, props).tree).filter((p) => p.type === 'button' && p.props.role === 'tab')
    assert.equal(tabs[0].props['aria-selected'], true, 'Home 应回到第一个页签')

    tabs[0].props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
    tabs = collectProps(react.render(Panel, props).tree).filter((p) => p.type === 'button' && p.props.role === 'tab')
    assert.equal(tabs[6].props['aria-selected'], true, '← 应环绕到最后一个页签')
  } finally {
    delete globalThis.fetch
  }
})

test('[shell] 设置入口：渲染真实设置页（数据来源/存储与备份），未实现项明说', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    const gear = findButton(settled.tree, '设置')
    assert.ok(gear, '应能找到设置按钮')
    gear.props.onClick()

    const after = await renderUntil(react, Panel, props, (t) => t.includes('存储与备份'), { label: '设置页' })
    assert.ok(after.text.includes('数据来源'), '设置页应有数据来源块')
    assert.ok(after.text.includes('解析模式'), '设置页应显示解析模式')
    assert.ok(after.text.includes('local'), '隐私闸门未确认时解析模式应为 local')
    // 未实现能力必须明说，且按钮禁用（不造死按钮）
    const disabled = findButton(after.tree, '未实现', { includeDisabled: true })
    assert.ok(disabled && disabled.props.disabled === true, '未实现项应是禁用按钮并标注')
  } finally {
    delete globalThis.fetch
  }
})

test('[shell] AI 协助开合：无会话时默认收起，点击展开/再点收起（aria-pressed 与 data-open 同步）', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('资料留在本机'), { label: '外壳' })
    let aside = collectProps(settled.tree).find((p) => p.type === 'aside')
    // 实测反馈的「只显示左半边，右边一长溜竖向空白」：没有会话时右侧面板不该占位。
    assert.ok(aside && aside.props['data-open'] === 'false', '无会话时 AI 协助应默认收起')

    const assist = findButton(settled.tree, 'AI 协助')
    assert.ok(assist, '应有 AI 协助按钮')
    assert.equal(assist.props['aria-pressed'], false, '收起时 aria-pressed=false')

    assist.props.onClick()
    let tree = react.render(Panel, props).tree
    aside = collectProps(tree).find((p) => p.type === 'aside')
    assert.equal(aside.props['data-open'], 'true', '点击后展开：data-open=true')
    assert.equal(findButton(tree, 'AI 协助').props['aria-pressed'], true, '展开后 aria-pressed=true')

    findButton(tree, 'AI 协助').props.onClick()
    tree = react.render(Panel, props).tree
    aside = collectProps(tree).find((p) => p.type === 'aside')
    assert.equal(aside.props['data-open'], 'false', '再点收起：data-open=false')
  } finally {
    delete globalThis.fetch
  }
})

test('[shell] 双品牌条：小胰宝 + 上游 DSH Desktop 的归属与可点击外链（V-4 + M12-4）', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('社区发行版 · 非官方产品'), { label: '品牌条' })
    assert.ok(settled.text.includes('小胰宝'), '应显示社区产品名')
    assert.ok(settled.text.includes('社区发行版 · 非官方产品'), '必须有非官方标识')
    assert.ok(settled.text.includes('MIT License'), '必须列出上游许可证')
    assert.ok(settled.text.includes('DataElement'), '必须保留上游版权归属')

    const footer = findNode(settled.tree, (n) => String(n.props.className || '') === 'xybBrandStrip')
    assert.ok(footer, '品牌条应存在（AI 协助面板顶部）')

    // 两个 logo 必须是**实图**（社区开发者反馈过「logo 太小 / 没存在感」）
    const imgs = collectProps(footer).filter((p) => p.type === 'img')
    assert.equal(imgs.length, 2, `品牌条应有两个 logo 实图，实际 ${imgs.length}`)
    assert.ok(imgs.every((p) => String(p.props.src || '').startsWith('data:image/')), 'logo 必须是内联图像资产')
    assert.ok(imgs.some((p) => p.props.alt === 'DSH Desktop'), '上游 logo 的可访问名必须是 DSH Desktop')

    // 可点击外链：两个 logo 分别指向社区 GitHub 与上游项目主页
    const links = collectProps(footer).filter((p) => p.type === 'a')
    const hrefs = links.map((p) => p.props.href)
    assert.ok(hrefs.includes('https://github.com/PancrePal-xiaoyibao'), `缺少社区 GitHub 链接：${JSON.stringify(hrefs)}`)
    assert.ok(hrefs.includes('https://www.dshdesktop.cn/'), `缺少上游项目主页链接：${JSON.stringify(hrefs)}`)
    links.forEach((p) => {
      assert.equal(p.props.target, '_blank', '外链必须新开（宿主交给系统浏览器）')
      assert.ok(String(p.props.rel || '').includes('noopener'), '外链必须带 noopener')
    })

    // 回归保护：旧占位符号不得再作为品牌标记（正是被投诉「太小」的那个）
    assert.ok(!settled.text.includes('◈'), '不得再用字符占位充当品牌标记')
  } finally {
    delete globalThis.fetch
  }
})

test('[shell] 无档案空态：引导入口 + 七维「未上传」骨架，不用 0 冒充', async () => {
  const { react, Panel, props } = await mountShell()
  try {
    const settled = await renderUntil(react, Panel, props, (t) => t.includes('还没有患者档案'), { label: '空态' })
    assert.ok(settled.text.includes('建立档案'), '空态要有建立档案入口')
    assert.ok(settled.text.includes('未上传'), '空态骨架必须标注未上传')
    const zeros = (settled.text.match(/资料完整度 0\/7/g) || []).length
    assert.ok(zeros >= 1, '完整度显示 0/7（这是计数，不是指标值）')
    assert.ok(!/基本体能\s*0\s/.test(settled.text), '不得把缺失显示为 0')
  } finally {
    delete globalThis.fetch
  }
})
