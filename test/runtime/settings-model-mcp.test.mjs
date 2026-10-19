/**
 * 设置页「模型与 API Key」（下拉式）+「右侧 AI 栏使用的模型」+ 青囊 MCP + 右侧面板默认收起 —— 运行时测试。
 *
 * 对应用户实测与明确要求：
 *  ① 模型 Key 要有入口，且**不要全部摊开**：一个下拉，选中谁才展开谁的表单；
 *  ② 有「自定提供方」入口（名称 + URL + Key + 模型，且提示 URL 规范）；
 *  ③ 模型菜单**只展示探测返回 200 的模型**，显示「模型名 · 供应商名」；
 *  ④ 未配 Key 时必须提示先填 Key，不能假装有模型；
 *  ⑤ 没有会话时右侧 AI 面板默认收起（否则看起来只显示左半边）。
 *
 * ⚠️ 探针记录（§5.4.3）：修复前没有下拉、没有自定义入口、没有模型探测 →
 *    本文件相关用例必红。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { makeFetch, mountClient, renderUntil, textOf } from '../../scripts/lib/client-sandbox.mjs'
import { bootPlugin } from '../../scripts/lib/host-contract-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const REPOSITORY = 'https://github.com/PancrePal-xiaoyibao/dsh-desktop-xiaoyibao'
const CANARY = 'sk-ui-canary-0123456789'

let dataRoot
before(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-settings-ui-'))
})
after(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

/** 用固定应答替换某个路由（内容由测试控制；语义仍是「真发请求 → 真拿 JSON」）。 */
function stubRoute(routes, path, handler) {
  routes.set(path, {
    methods: new Set(['GET', 'POST']),
    requestBody: 'buffered',
    fetch: async (request) =>
      new Response(JSON.stringify(await handler(request)), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' }
      })
  })
}

const providerRow = (provider, displayName, keyRef, configured) => ({
  provider,
  displayName,
  settingsNs: 'llm-pi-ai',
  keyRef,
  refFromConfig: true,
  baseURL: 'https://api.deepseek.com/v1',
  protocol: 'openai-completions',
  custom: false,
  configured,
  source: configured ? 'file' : null,
  writable: true,
  error: null
})

const modelPayload = (configured) => ({
  available: true,
  reason: null,
  credentialSeam: true,
  settingsSeam: true,
  writable: true,
  // 两个提供方：用来证明「只展开选中的那一个」
  providers: [providerRow('deepseek-official', 'DeepSeek 官方', 'DEEPSEEK_API_KEY', configured), providerRow('minimax-cn', 'MiniMax', 'MINIMAX_CN_API_KEY', false)],
  namespaces: [],
  selection: configured ? { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: null } : null,
  notes: ['保存后写入宿主凭据存储（与宿主设置面板是同一份），本工作台不留副本。']
})

const qingnangPayload = (configured) => ({
  snapshotOk: true,
  registeredCount: configured ? 1 : 0,
  channels: [
    {
      serverName: 'qingnang_knows',
      channelId: 'knows',
      displayName: 'KnowS 医学知识',
      status: configured ? 'enabled' : 'credential-missing',
      statusText: configured ? '已启用' : '未配凭据',
      unknownKeys: false,
      keys: [{ name: 'KNOWS_API_KEY', configured, source: configured ? 'local' : null }]
    }
  ],
  skills: { installed: ['qingnang-trial-search', 'qingnang-desensitize'], fileCount: 12 }
})

/** 遍历渲染树，按条件收集节点。 */
function collect(tree, predicate) {
  const found = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node.$$element) {
      if (predicate(node)) found.push(node)
      walk(node.children)
    }
  }
  walk(tree)
  return found
}

const byClass = (name) => (node) => String(node.props?.className || '').split(/\s+/).includes(name)
const byText = (label) => (node) => node.type === 'button' && textOf(node).join('').includes(label)
const byAria = (label) => (node) => node.props?.['aria-label'] === label

async function mountShell({ initialModelConfigured = false, sessionBindings = {} } = {}) {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `服务端装载失败：${registerError?.message}`)

  let modelConfigured = initialModelConfigured
  stubRoute(mock.routes, '/api/xyb/model-config', async () => modelPayload(modelConfigured))
  stubRoute(mock.routes, '/api/xyb/model-config/credential', async () => {
    modelConfigured = true
    return { ref: 'DEEPSEEK_API_KEY', cleared: false, configured: true, source: 'file', config: modelPayload(true) }
  })
  stubRoute(mock.routes, '/api/xyb/models/available', async () => ({
    available: true,
    reason: null,
    httpStatus: 200,
    provider: 'deepseek-official',
    providerName: 'DeepSeek 官方',
    models: [
      { id: 'deepseek-chat', name: 'deepseek-chat', provider: 'deepseek-official', providerName: 'DeepSeek 官方' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner', provider: 'deepseek-official', providerName: 'DeepSeek 官方' }
    ]
  }))
  stubRoute(mock.routes, '/api/xyb/model-selected', async () => ({ ok: true, selection: { provider: 'deepseek-official', model: 'deepseek-chat' } }))
  stubRoute(mock.routes, '/api/xyb/qingnang/credentials', async (request) => {
    if (request.method === 'POST') return { ok: true, name: 'KNOWS_API_KEY', cleared: false, channels: [] }
    return qingnangPayload(false)
  })

  const { fetchImpl, calls } = makeFetch(mock.routes)
  globalThis.fetch = fetchImpl
  const { react, registered } = mountClient(REPO_ROOT, 'dsh-xyb-workbench')
  const service = {
    getSnapshot: () => ({ ready: true, state: { active: null, sessionBindings } }),
    subscribe: () => () => {},
    newWorkspaceSession: () => Promise.resolve(),
    run: () => {}
  }
  return { react, Panel: registered[0].Component, props: { service, conversation: null }, calls }
}

async function openSettings(ctx) {
  const shell = await renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('资料留在本机'), { label: '外壳' })
  collect(shell.tree, byText('设置'))[0].props.onClick()
  // ⚠️ 不能只等标题：标题在「正在读取」阶段就已存在 → 会拿着 loading 树做断言（假红）。
  // 等一个**数据依赖**的标记（只有 model-config 到手后才渲染的说明行）。
  return renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('对话模型由右侧'), { label: '设置页数据已到' })
}

test('[布局] 没有会话时右侧 AI 面板默认收起（否则就是一条竖向空白）', async () => {
  const ctx = await mountShell()
  const shell = await renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('资料留在本机'), { label: '外壳' })
  const asides = collect(shell.tree, byClass('xybChat'))
  assert.equal(asides.length, 1, '右侧面板节点应存在（常驻挂载，不卸载会话树）')
  assert.equal(asides[0].props['data-open'], 'false', '无会话时必须收起：data-open=false')
})

test('[布局] 有会话时才展开右侧面板', async () => {
  const ctx = await mountShell({ sessionBindings: { s1: REPOSITORY } })
  const shell = await renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('资料留在本机'), { label: '外壳' })
  assert.equal(collect(shell.tree, byClass('xybChat'))[0].props['data-open'], 'true')
})

test('[设置页] 提供方是下拉，只展开选中的那一个（不全部摊开）', async () => {
  const ctx = await mountShell()
  const page = await openSettings(ctx)

  const selects = collect(page.tree, byAria('模型提供方'))
  assert.equal(selects.length, 1, '必须是一个提供方下拉')
  assert.equal(selects[0].type, 'select')
  assert.equal(selects[0].props.value, 'deepseek-official', '默认选中第一个提供方')

  // 选中的提供方有自己的 Key 输入
  assert.equal(collect(page.tree, byAria('DEEPSEEK_API_KEY 的值')).length, 1)
  // 未选中的提供方**不得**渲染输入框（这就是「不要全部摊开」）
  assert.equal(collect(page.tree, byAria('MINIMAX_CN_API_KEY 的值')).length, 0, '未选中的提供方不应展开')
  assert.ok(collect(page.tree, (n) => n.type === 'option' && String(n.props?.value) === 'custom').length === 1, '下拉里必须有「自定提供方…」')
})

test('[设置页] 保存 Key：不回显值，状态变已配置', async () => {
  const ctx = await mountShell()
  const page = await openSettings(ctx)

  const input = collect(page.tree, byAria('DEEPSEEK_API_KEY 的值'))[0]
  assert.equal(input.props.type, 'password', '输入框必须是密码型')
  input.props.onChange({ target: { value: CANARY } })

  const typed = await renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('DEEPSEEK_API_KEY'), { label: '输入后重渲染' })
  collect(typed.tree, byText('保存'))[0].props.onClick()

  // ⚠️ 不能用「已保存」做条件：placeholder 里也有「已保存」字样 → 假绿
  const saved = await renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('DeepSeek 官方 已保存'), { label: '保存完成' })
  assert.ok(!saved.text.includes(CANARY), '保存后界面上不得回显密钥值')
  assert.ok(saved.text.includes('已配置'), '保存后状态必须变为已配置')
  assert.ok(ctx.calls.some((c) => c.path === '/api/xyb/model-config/credential' && c.method === 'POST'), '必须真的发保存请求')
})

test('[设置页] 自定义提供方表单：名称 + URL + Key + 模型，并给出 URL 规范提示', async () => {
  const ctx = await mountShell()
  const page = await openSettings(ctx)
  const select = collect(page.tree, byAria('模型提供方'))[0]
  select.props.onChange({ target: { value: 'custom' } })

  const custom = await renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('自定义提供方'), { label: '自定义面板' })
  assert.ok(collect(custom.tree, byAria('提供方标识')).length === 1, '要有提供方标识输入')
  assert.ok(collect(custom.tree, byAria('服务地址')).length === 1, '要有服务地址输入')
  assert.ok(collect(custom.tree, byAria('自定义提供方的 API Key')).length === 1, '要有 Key 输入')
  assert.ok(collect(custom.tree, byAria('可用模型 id')).length === 1, '要有模型 id 输入')
  assert.ok(custom.text.includes('https://api.openai.com/v1'), '必须给出 URL 规范示例（写到 /v1）')
  assert.ok(custom.text.includes('拼 /models'), 'OpenAI 兼容必须说明会拼 /models')

  // 切到 Anthropic 协议后，提示要变成「会拼 /v1/models」（两种规范都要说清）
  const protocol = collect(custom.tree, byAria('协议'))[0]
  protocol.props.onChange({ target: { value: 'anthropic-messages' } })
  const anthropic = await renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('/v1/models'), { label: 'Anthropic 提示' })
  assert.ok(anthropic.text.includes('https://api.anthropic.com/v1'), '必须给出 Anthropic 的规范示例')
})

test('[设置页] 模型菜单：未配 Key 时提示先填 Key；配好后只展示 200 的模型（模型名 · 供应商）', async () => {
  const blockedCtx = await mountShell()
  const blockedPage = await openSettings(blockedCtx)
  assert.ok(blockedPage.text.includes('先填写 API Key'), '未配 Key 时必须提示先填 Key')

  const ctx = await mountShell({ initialModelConfigured: true })
  const page = await openSettings(ctx)
  const probes = collect(page.tree, byText('刷新可用模型'))
  assert.equal(probes.length, 1, '必须有刷新按钮')
  probes[0].props.onClick()

  const probed = await renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('共 2 个可用'), { label: '模型已刷新' })
  const modelSelect = collect(probed.tree, byAria('可用模型'))[0]
  assert.ok(modelSelect, '必须有模型下拉')
  const labels = collect(modelSelect, (n) => n.type === 'option').map((n) => textOf(n).join(''))
  assert.ok(labels.some((label) => label.includes('deepseek-chat · DeepSeek 官方')), `模型必须显示「模型名 · 供应商」：${JSON.stringify(labels)}`)
  assert.ok(!labels.some((label) => label.includes('不可用')), '不可用的模型不得出现')

  modelSelect.props.onChange({ target: { value: 'deepseek-official::deepseek-chat' } })
  const picked = await renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('共 2 个可用'), { label: '选中模型后' })
  collect(picked.tree, byText('设为当前模型'))[0].props.onClick()
  const done = await renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('右侧 AI 栏现在使用'), { label: '保存模型选择' })
  assert.ok(done.text.includes('deepseek-chat'), '必须回显选中的模型')
  assert.ok(ctx.calls.some((c) => c.path === '/api/xyb/model-selected' && c.method === 'POST'), '必须真的保存模型选择')
})

test('[设置页] 青囊 MCP 通道、所需 Key、已装载技能都可见', async () => {
  const ctx = await mountShell()
  const page = await openSettings(ctx)
  const loaded = await renderUntil(ctx.react, ctx.Panel, ctx.props, (t) => t.includes('KnowS 医学知识'), { label: '青囊通道' })
  assert.ok(loaded.text.includes('检索通道（青囊 MCP）'))
  assert.ok(loaded.text.includes('KNOWS_API_KEY'))
  assert.ok(loaded.text.includes('已装载技能（2）'))
  assert.ok(loaded.text.includes('qingnang-trial-search'))
  assert.equal(collect(loaded.tree, byAria('KNOWS_API_KEY 的值')).length, 1, '通道 Key 必须可填')
})
