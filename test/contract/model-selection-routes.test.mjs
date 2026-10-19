/**
 * 模型探测 / 自定义提供方 / 模型选择 —— 契约测试。
 *
 * 要证明的三件事（全部来自主人明确要求）：
 *  ① 模型菜单**只展示探测返回 200 的模型**：401/网络失败/坏 JSON 一律 `models: []`；
 *  ② 清单地址与认证头**与宿主 pi-ai 实现一致**（OpenAI `{base}/models` + Bearer；
 *     Anthropic 根路径 + `/v1/models?limit=1000` + `anthropic-version` / `x-api-key`）；
 *  ③ 自定义提供方写进宿主 `llm-pi-ai.providers.<route>` 时**先读后合并**（不清掉别人的路由），
 *     模型选择走宿主的 `agentDefaultModel.saveSelection`。
 *
 * ⚠️ 探针记录（§5.4.3）：修复前没有这三个能力（路由 404 / 函数不存在），本文件必红。
 */
import { strict as assert } from 'node:assert'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

import {
  LISTABLE_PROTOCOLS,
  listingUrl,
  parseModelListing,
  probeProviderModels,
  saveCustomProvider,
  saveModelSelection
} from '../../packages/dsh-xyb-workbench/lib/settings/model-selection.js'
import { deriveKeyRef } from '../../packages/dsh-xyb-workbench/lib/settings/model-config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const ENTRY = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'index.js')).href

/** 造一个「宿主 seam」替身；providerRow 通过 llm 目录返回。 */
function fakeHost({ provider = 'deepseek-official', displayName = 'DeepSeek 官方', baseURL = 'https://api.example.test/v1', api = 'openai-completions', configured = true } = {}) {
  const store = new Map(configured ? [['DEEPSEEK_API_KEY', 'sk-live-test']] : [])
  const saved = []
  return {
    saved,
    store,
    seams: {
      llm: {
        listProviders: () => [{ provider, displayName, settingsNs: 'llm-test', settingsPath: [] }],
        listConfigurableProviders: () => []
      },
      settings: {
        writable: true,
        describe: () => [{ ns: 'llm-test', value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL, api }, secrets: [] }],
        update: async (ns, patch) => saved.push({ ns, patch })
      },
      credentials: {
        describe: async (ref) => ({ configured: store.has(ref), source: store.has(ref) ? 'file' : undefined, writable: true }),
        resolve: async (ref) => (store.has(ref) ? { value: store.get(ref), source: 'file' } : undefined),
        set: async (ref, value) => store.set(ref, value),
        unset: async (ref) => store.delete(ref)
      },
      agentDefaultModel: {
        currentSelection: () => ({ provider, model: 'deepseek-chat' }),
        saveSelection: async (next) => saved.push({ selection: next })
      }
    }
  }
}

test('[清单地址] OpenAI 与 Anthropic 的拼接规则与宿主一致', () => {
  assert.equal(listingUrl('https://api.openai.com/v1', 'openai-completions'), 'https://api.openai.com/v1/models')
  assert.equal(listingUrl('https://api.openai.com/v1/', 'openai-completions'), 'https://api.openai.com/v1/models')
  // Anthropic：去掉一段 /v1 再拼 /v1/models（gateway 两种写法都收敛到同一根）
  assert.equal(listingUrl('https://api.anthropic.com/v1', 'anthropic-messages'), 'https://api.anthropic.com/v1/models?limit=1000')
  assert.equal(listingUrl('https://api.anthropic.com', 'anthropic-messages'), 'https://api.anthropic.com/v1/models?limit=1000')
  assert.deepEqual(LISTABLE_PROTOCOLS, ['anthropic-messages', 'openai-completions', 'openai-responses'])
})

test('[清单解析] data 数组 / models 字典 / 坏 JSON', () => {
  assert.deepEqual(parseModelListing(JSON.stringify({ data: [{ id: 'a', name: 'A' }, { id: 'b' }, { name: 'no-id' }] })), [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'b' }
  ])
  assert.deepEqual(parseModelListing(JSON.stringify({ models: { x: { name: 'X' }, y: 'not-a-model' } })), [{ id: 'x', name: 'X' }])
  assert.throws(() => parseModelListing('not json'), /不是合法 JSON/)
})

test('[探测] 未配 Key 时不发请求、不返回任何模型', async (t) => {
  const host = fakeHost({ configured: false })
  const ctx = { reflect: { get: (name) => host.seams[name] } }
  let called = 0
  t.after(() => {
    globalThis.fetch = undefined
  })
  globalThis.fetch = async () => {
    called += 1
    return new Response('{}', { status: 200 })
  }
  const result = await probeProviderModels(ctx, { provider: 'deepseek-official' })
  assert.equal(result.available, false)
  assert.equal(result.reason, 'KEY_MISSING')
  assert.deepEqual(result.models, [])
  assert.equal(called, 0, '没 Key 就不该打网络')
})

test('[探测] 401 一律不展示模型（只展示 200）', async (t) => {
  const host = fakeHost()
  const ctx = { reflect: { get: (name) => host.seams[name] } }
  let seen = null
  t.after(() => {
    globalThis.fetch = undefined
  })
  globalThis.fetch = async (url, init) => {
    seen = { url, init }
    return new Response('{"error":"bad key"}', { status: 401 })
  }
  const result = await probeProviderModels(ctx, { provider: 'deepseek-official' })
  assert.equal(result.available, false)
  assert.equal(result.reason, 'HTTP_ERROR')
  assert.equal(result.httpStatus, 401)
  assert.deepEqual(result.models, [], '401 时不得展示任何模型')
  assert.equal(seen.url, 'https://api.example.test/v1/models')
  assert.equal(seen.init.headers.authorization, 'Bearer sk-live-test')
})

test('[探测] 200 才返回模型，并带上供应商名', async (t) => {
  const host = fakeHost()
  const ctx = { reflect: { get: (name) => host.seams[name] } }
  t.after(() => {
    globalThis.fetch = undefined
  })
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'm-1', name: 'Model One' }] }), { status: 200 })
  const result = await probeProviderModels(ctx, { provider: 'deepseek-official' })
  assert.equal(result.available, true)
  assert.equal(result.httpStatus, 200)
  assert.deepEqual(result.models, [{ id: 'm-1', name: 'Model One', provider: 'deepseek-official', providerName: 'DeepSeek 官方' }])
})

test('[探测] Anthropic 用 x-api-key + anthropic-version', async (t) => {
  const host = fakeHost({ api: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1' })
  const ctx = { reflect: { get: (name) => host.seams[name] } }
  let seen = null
  t.after(() => {
    globalThis.fetch = undefined
  })
  globalThis.fetch = async (url, init) => {
    seen = { url, init }
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }
  const result = await probeProviderModels(ctx, { provider: 'deepseek-official' })
  assert.equal(result.available, true)
  assert.equal(seen.url, 'https://api.anthropic.com/v1/models?limit=1000')
  assert.equal(seen.init.headers['x-api-key'], 'sk-live-test')
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01')
})

test('[自定义提供方] 先读后合并，不清掉已有路由；凭据按派生名写入', async () => {
  const host = fakeHost()
  // 预置一条用户已有的自定义路由
  host.seams.settings.describe = () => [
    {
      ns: 'llm-pi-ai',
      value: { providers: { existing: { api: 'openai-completions', baseURL: 'https://existing.test/v1', apiKeyEnv: 'EXISTING_API_KEY' } } },
      secrets: []
    }
  ]
  const ctx = { reflect: { get: (name) => host.seams[name] } }
  await saveCustomProvider(ctx, {
    route: 'my-gateway',
    displayName: '我的网关',
    baseURL: 'https://gw.test/v1/',
    protocol: 'openai-completions',
    apiKey: 'sk-custom',
    models: ['m1', 'm2']
  })

  const write = host.saved.find((entry) => entry.ns === 'llm-pi-ai')
  assert.ok(write, '必须写 llm-pi-ai')
  const providers = write.patch.providers
  assert.ok(providers.existing, '已有路由必须保留（整段替换会清掉用户配置）')
  assert.equal(providers['my-gateway'].baseURL, 'https://gw.test/v1', '末尾斜杠要去掉')
  assert.equal(providers['my-gateway'].api, 'openai-completions')
  assert.equal(providers['my-gateway'].apiKeyEnv, deriveKeyRef('my-gateway'))
  assert.deepEqual(providers['my-gateway'].models, [{ id: 'm1' }, { id: 'm2' }])
  assert.equal(host.store.get(deriveKeyRef('my-gateway')), 'sk-custom', 'Key 必须写进凭据存储')
})

test('[自定义提供方] 非法标识 / 非 http(s) 地址 / 空模型都被拒', async () => {
  const host = fakeHost()
  const ctx = { reflect: { get: (name) => host.seams[name] } }
  await assert.rejects(() => saveCustomProvider(ctx, { route: 'Bad Name', baseURL: 'https://x.test/v1', models: ['m'] }), /提供方标识/)
  await assert.rejects(() => saveCustomProvider(ctx, { route: 'ok-name', baseURL: 'ftp://x.test', models: ['m'] }), /http\(s\)/)
  await assert.rejects(() => saveCustomProvider(ctx, { route: 'ok-name', baseURL: 'https://x.test/v1', models: [] }), /至少有一个模型/)
})

test('[模型选择] 写到宿主 agent 默认模型；未配 Key 拒绝', async () => {
  const host = fakeHost()
  const ctx = { reflect: { get: (name) => host.seams[name] } }
  const saved = await saveModelSelection(ctx, { provider: 'deepseek-official', model: 'deepseek-chat' })
  assert.deepEqual(saved, { provider: 'deepseek-official', model: 'deepseek-chat' })
  assert.deepEqual(host.saved.at(-1), { selection: { provider: 'deepseek-official', model: 'deepseek-chat' } })

  const blocked = fakeHost({ configured: false })
  const blockedCtx = { reflect: { get: (name) => blocked.seams[name] } }
  await assert.rejects(() => saveModelSelection(blockedCtx, { provider: 'deepseek-official', model: 'x' }), /还没配置 API Key/)
})

test('[路由] /api/xyb/models/available 已注册且缺参有明确失败出口', async () => {
  const mod = await import(ENTRY)
  const { createHostMock } = await import('../../scripts/lib/host-contract-rules.mjs')
  const mock = createHostMock()
  const registerError = await (async () => {
    try {
      await mod.apply(mock.ctx, { root: join(REPO_ROOT, '.test-logs', 'model-selection-routes') })
      return null
    } catch (error) {
      return error
    }
  })()
  assert.equal(registerError, null)
  const missing = await mock.dispatch('/api/xyb/models/available')
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error, 'INVALID_INPUT')
})
