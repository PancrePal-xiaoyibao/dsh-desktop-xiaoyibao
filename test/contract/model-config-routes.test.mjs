/**
 * 模型与 API Key 路由 —— 契约测试。
 *
 * 要证明的是「设置页真能配 Key，而且一个字节的值都不外泄」：
 *  · 缺宿主 seam 时明确降级为 `available:false`，不编造「已配置」；
 *  · 有 seam 时引用名按宿主规则取：`apiKeyEnv` 优先，否则 `deriveKeyRef`；
 *  · 写入只走上游凭据服务，**响应体、事件日志、磁盘数据里都不得出现密钥值**。
 *
 * ⚠️ 探针记录（§5.4.3）：这两个路由在修复前不存在 → 请求直接 404，
 *    本文件全部用例必然红。因此它是「能抓住该缺陷」的回归测试，不是装饰。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { createHostMock } from '../../scripts/lib/host-contract-rules.mjs'
import { deriveKeyRef, parseCredentialRequest, readModelConfig } from '../../packages/dsh-xyb-workbench/lib/settings/model-config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const ENTRY = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href

/** 用来证明「值没有顺着任何一条链路漏出去」的金丝雀。 */
const CANARY = 'sk-canary-0123456789abcdef'

let dataRoot
before(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-model-config-'))
})
after(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

/** 造一套宿主 seam 替身：语义逐条对真实服务（describe 只回状态、不回值）。 */
function fakeSeams({ providers = [], shippedProviders = [], namespaces = [], records = {} } = {}) {
  const store = new Map(Object.entries(records))
  const calls = []
  return {
    calls,
    seams: {
      llm: {
        listProviders: () => shippedProviders,
        listConfigurableProviders: () => providers
      },
      settings: {
        writable: true,
        describe: () => namespaces
      },
      credentials: {
        describe: async (ref) => ({
          configured: store.has(ref),
          source: store.has(ref) ? 'file' : undefined,
          writable: true
        }),
        set: async (ref, value) => {
          calls.push({ op: 'set', ref, value })
          store.set(ref, value)
        },
        unset: async (ref) => {
          calls.push({ op: 'unset', ref })
          store.delete(ref)
        }
      }
    }
  }
}

async function boot(seams) {
  const mod = await import(ENTRY)
  const mock = createHostMock()
  if (seams) Object.assign(mock.ctx, seams)
  const registerError = await (async () => {
    try {
      await mod.apply(mock.ctx, { root: dataRoot })
      return null
    } catch (error) {
      return error
    }
  })()
  assert.equal(registerError, null, `插件装载失败：${registerError?.message}`)
  return mock
}

/** 递归扫数据目录，确认密钥值没有落到任何文件里。 */
function scanForCanary(root) {
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const info = statSync(full)
      if (info.isDirectory()) walk(full)
      else if (info.isFile() && readFileSync(full, 'utf8').includes(CANARY)) hits.push(full)
    }
  }
  walk(root)
  return hits
}

test('[模型配置] 没有凭据服务时明确降级，不编造状态', async () => {
  const mock = await boot(null)
  const response = await mock.dispatch('/api/xyb/model-config')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.available, false, '缺 seam 必须报不可用')
  assert.equal(body.credentialSeam, false)
  assert.deepEqual(body.providers, [])
  assert.match(body.reason, /凭据服务/, '原因必须能让用户看懂该去哪儿配')
})

test('[模型配置] 引用名取 apiKeyEnv（宿主规则），缺省才派生', async () => {
  const { seams } = fakeSeams({
    providers: [
      { provider: 'deepseek-official', displayName: 'DeepSeek 官方', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'minimax-cn', displayName: 'MiniMax', settingsNs: 'llm-pi-ai', settingsPath: ['routes', 'minimax-cn'] }
    ],
    namespaces: [
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, secrets: [{ path: ['apiKey'], set: true }] },
      { ns: 'llm-pi-ai', value: { routes: { 'minimax-cn': { baseURL: 'https://api.example.test' } } }, secrets: [] }
    ],
    records: { DEEPSEEK_API_KEY: CANARY }
  })
  const mock = await boot(seams)
  const body = await (await mock.dispatch('/api/xyb/model-config')).json()

  assert.equal(body.available, true)
  const deepseek = body.providers.find((row) => row.provider === 'deepseek-official')
  assert.equal(deepseek.keyRef, 'DEEPSEEK_API_KEY')
  assert.equal(deepseek.refFromConfig, true)
  assert.equal(deepseek.configured, true)
  assert.equal(deepseek.source, 'file')

  const minimax = body.providers.find((row) => row.provider === 'minimax-cn')
  assert.equal(minimax.keyRef, deriveKeyRef('minimax-cn'))
  assert.equal(minimax.keyRef, 'MINIMAX_CN_API_KEY')
  assert.equal(minimax.refFromConfig, false)
  assert.equal(minimax.configured, false)

  assert.ok(!JSON.stringify(body).includes(CANARY), '响应里不得出现密钥值')
})

test('[模型配置] 保存 / 清除：只走上游凭据服务，值不进响应也不落盘', async () => {
  const { seams, calls } = fakeSeams({
    providers: [{ provider: 'deepseek-official', displayName: 'DeepSeek 官方', settingsNs: 'llm-deepseek', settingsPath: [] }],
    namespaces: [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, secrets: [{ path: ['apiKey'], set: false }] }]
  })
  const mock = await boot(seams)

  const saved = await mock.dispatch('/api/xyb/model-config/credential', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'DEEPSEEK_API_KEY', value: CANARY })
  })
  assert.equal(saved.status, 200)
  const savedBody = await saved.json()
  assert.equal(savedBody.configured, true)
  assert.ok(!JSON.stringify(savedBody).includes(CANARY), '响应里不得出现密钥值')
  assert.deepEqual(calls.at(-1), { op: 'set', ref: 'DEEPSEEK_API_KEY', value: CANARY }, '必须原样交给宿主凭据服务')

  const cleared = await mock.dispatch('/api/xyb/model-config/credential', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'DEEPSEEK_API_KEY', value: '' })
  })
  assert.equal(cleared.status, 200)
  assert.equal((await cleared.json()).cleared, true)
  assert.deepEqual(calls.at(-1), { op: 'unset', ref: 'DEEPSEEK_API_KEY' })

  assert.deepEqual(scanForCanary(dataRoot), [], '密钥值不得落进本插件的数据目录')
})

test('[模型配置] 非法输入有明确失败出口（不是静默成功）', async () => {
  const { seams, calls } = fakeSeams()
  const mock = await boot(seams)

  const badRef = await mock.dispatch('/api/xyb/model-config/credential', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'deepseek key', value: 'x' })
  })
  assert.equal(badRef.status, 400)
  assert.equal((await badRef.json()).error, 'INVALID_INPUT')

  const tooLong = await mock.dispatch('/api/xyb/model-config/credential', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'DEEPSEEK_API_KEY', value: 'x'.repeat(5000) })
  })
  assert.equal(tooLong.status, 413)

  assert.deepEqual(calls, [], '被拒的请求不得触达凭据服务')
})

test('[模型配置] 没有凭据服务时写入是 503（不假成功）', async () => {
  const mock = await boot(null)
  const response = await mock.dispatch('/api/xyb/model-config/credential', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'DEEPSEEK_API_KEY', value: 'x' })
  })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error, 'SEAM_UNAVAILABLE')
})

test('[模型配置] 提供方目录取并集，且能展开 Volatile 的 apiKeyEnv（与路由级配置）', async () => {
  // 依据：宿主自己的提供方在 listProviders()，用户在配置里新增的在
  // listConfigurableProviders()；只读一份就会「有些提供方永远不显示」。
  // apiKeyEnv 在 schema 里是 Volatile<string>（deepseek 默认 DEEPSEEK_API_KEY），
  // 取错会得到一个**不同名字**的引用 —— 用户填了 Key 也没用。
  const { seams } = fakeSeams({
    shippedProviders: [{ provider: 'deepseek-official', displayName: 'DeepSeek 官方', settingsNs: 'llm-deepseek', settingsPath: [] }],
    providers: [{ provider: 'minimax-cn', displayName: 'MiniMax', settingsNs: 'llm-pi-ai', settingsPath: ['routes', 'minimax-cn'] }],
    namespaces: [
      { ns: 'llm-deepseek', value: { apiKeyEnv: { get: () => 'DEEPSEEK_API_KEY' } }, secrets: [] },
      { ns: 'llm-pi-ai', value: { routes: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_KEY' } } }, secrets: [] }
    ],
    records: { DEEPSEEK_API_KEY: CANARY }
  })
  const mock = await boot(seams)
  const body = await (await mock.dispatch('/api/xyb/model-config')).json()

  const providers = body.providers.map((row) => row.provider).sort()
  assert.deepEqual(providers, ['deepseek-official', 'minimax-cn'], '两份目录必须并集')

  const deepseek = body.providers.find((row) => row.provider === 'deepseek-official')
  assert.equal(deepseek.keyRef, 'DEEPSEEK_API_KEY', 'Volatile 值必须能展开成真实引用名')
  assert.equal(deepseek.refFromConfig, true)

  const minimax = body.providers.find((row) => row.provider === 'minimax-cn')
  assert.equal(minimax.keyRef, 'MINIMAX_CN_KEY', '路由级配置里的 apiKeyEnv 优先于派生名')
  assert.ok(!JSON.stringify(body).includes(CANARY))
})

test('[模型配置] cordis 语义：未 inject 的服务必须经 reflect.get 读，不能直接 ctx.settings', async () => {
  // 真 cordis 对未 inject 的服务抛 `cannot get property "x" without inject`（reflect.ts 的 get 陷阱）。
  // 而 inject 没有「可选」语义 —— 写进 inject 会让插件在缺服务时永不激活。
  // 因此这里钉住：属性访问**抛错**的情况下，只要 reflect.get 能拿到服务，就必须能读出配置。
  const { seams } = fakeSeams({
    providers: [{ provider: 'deepseek-official', displayName: 'DeepSeek 官方', settingsNs: 'llm-deepseek', settingsPath: [] }],
    namespaces: [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, secrets: [] }]
  })
  const store = { settings: seams.settings, credentials: seams.credentials, llm: seams.llm }
  const ctx = { reflect: { get: (name) => store[name], provide: () => {} } }
  for (const name of Object.keys(store)) {
    Object.defineProperty(ctx, name, {
      configurable: true,
      get() {
        throw new Error(`cannot get property "${name}" without inject`)
      }
    })
  }

  const config = await readModelConfig(ctx)
  assert.equal(config.available, true, 'reflect.get 能拿到凭据服务时不应降级')
  assert.equal(config.providers.length, 1)
  assert.equal(config.providers[0].keyRef, 'DEEPSEEK_API_KEY')

  const degraded = await readModelConfig({ reflect: { get: () => undefined } })
  assert.equal(degraded.available, false, '服务真不存在时必须降级，而不是抛错或假成功')
})

test('[模型配置] parseCredentialRequest 与 deriveKeyRef 的边界', () => {
  assert.equal(deriveKeyRef('minimax-cn'), 'MINIMAX_CN_API_KEY')
  assert.equal(deriveKeyRef('deepseek-official'), 'DEEPSEEK_OFFICIAL_API_KEY')
  assert.equal(deriveKeyRef(''), '_API_KEY')
  assert.throws(() => parseCredentialRequest({ ref: '1abc' }), /凭据名不合法/)
  assert.throws(() => parseCredentialRequest({ ref: 'A_B', value: 'x\ny' }), /换行/)
  assert.deepEqual(parseCredentialRequest({ ref: 'A_B', value: '  v  ' }), { ref: 'A_B', value: 'v' })
  assert.deepEqual(parseCredentialRequest({ ref: 'A_B' }), { ref: 'A_B', value: '' })
})
