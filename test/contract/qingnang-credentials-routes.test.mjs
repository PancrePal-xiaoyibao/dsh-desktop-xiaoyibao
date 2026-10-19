/**
 * 青囊 MCP 通道凭据 —— 存储 + 路由测试。
 *
 * 要证明的是「社区发的 Key 现在有地方看、有地方填，而且只写不读」：
 *  · 清单接口必须列出**每条通道需要哪些 Key**（哪怕青囊资产没就绪也要列）；
 *  · 保存后立即落本机凭据文件，且可以清除；
 *  · 任何响应都不得回传密钥值（只回 configured + 来源）。
 *
 * ⚠️ 探针记录（§5.4.3）：修复前没有 /credentials 这两个路由，也没有凭据文件存储
 *    （只能靠进程环境变量）→ 本文件全部用例必然红。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { createHostMock } from '../../scripts/lib/host-contract-rules.mjs'
import {
  credentialStorePath,
  readStoredCredentials,
  setStoredCredential,
  clearStoredCredential,
  CREDENTIAL_NAME_PATTERN
} from '../../packages/dsh-xyb-qingnang/lib/credential-store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const ENTRY = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-qingnang', 'index.js')).href

const CANARY = 'qn-canary-0123456789abcdef'

let dataRoot
let unitRoot
before(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-qingnang-routes-'))
  unitRoot = mkdtempSync(join(tmpdir(), 'xyb-qingnang-store-'))
})
after(() => {
  rmSync(dataRoot, { recursive: true, force: true })
  rmSync(unitRoot, { recursive: true, force: true })
})

async function bootQingnang() {
  const mod = await import(ENTRY)
  const mock = createHostMock()
  let registerError = null
  try {
    await mod.apply(mock.ctx, { root: dataRoot })
  } catch (error) {
    registerError = error
  }
  assert.equal(registerError, null, `青囊插件装载失败：${registerError?.message}`)
  return mock
}

test('[青囊凭据] 存储层：写 / 读 / 清，非法名字拒绝', async () => {
  await setStoredCredential(unitRoot, 'KNOWS_API_KEY', '  abc  ')
  assert.deepEqual(await readStoredCredentials(unitRoot), { KNOWS_API_KEY: 'abc' }, '保存时应去掉首尾空白')

  const path = credentialStorePath(unitRoot)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).KNOWS_API_KEY, 'abc', '必须真的落盘到凭据文件')

  await clearStoredCredential(unitRoot, 'KNOWS_API_KEY')
  assert.deepEqual(await readStoredCredentials(unitRoot), {}, '清除后不应残留')

  // 幂等：清除不存在的键不报错
  await clearStoredCredential(unitRoot, 'KNOWS_API_KEY')

  await assert.rejects(() => setStoredCredential(unitRoot, 'bad name', 'x'), /凭据名不合法/)
  await assert.rejects(() => setStoredCredential(unitRoot, 'KNOWS_API_KEY', '   '), /不能为空/)
  await assert.rejects(() => setStoredCredential(unitRoot, 'KNOWS_API_KEY', 'x'.repeat(5000)), /过长/)

  assert.equal(CREDENTIAL_NAME_PATTERN.test('KNOWS_API_KEY'), true)
  assert.equal(CREDENTIAL_NAME_PATTERN.test('knows_api_key'), false)
})

test('[青囊凭据] 清单接口列出通道与所需 Key，且不含任何值', async () => {
  const mock = await bootQingnang()
  const response = await mock.dispatch('/api/xyb/qingnang/credentials')
  assert.equal(response.status, 200)
  const body = await response.json()

  const names = body.channels.map((row) => row.serverName)
  assert.ok(names.includes('qingnang_knows'), '必须列出 KnowS 通道')
  assert.ok(names.includes('qingnang_biji'), '必须列出得到笔记通道')

  const knows = body.channels.find((row) => row.serverName === 'qingnang_knows')
  assert.deepEqual(knows.keys.map((key) => key.name).sort(), ['KNOWS_API_HOST', 'KNOWS_API_KEY'])
  assert.ok(knows.keys.every((key) => key.configured === false), '初始状态应为未配置')

  assert.ok(Array.isArray(body.skills.installed), '技能清单必须是数组（哪怕是空的）')
  assert.ok(!JSON.stringify(body).includes(CANARY))
})

test('[青囊凭据] 保存后立即生效并可从清单看到；清除后回到未配置', async () => {
  const mock = await bootQingnang()

  const saved = await mock.dispatch('/api/xyb/qingnang/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'KNOWS_API_KEY', value: CANARY })
  })
  assert.equal(saved.status, 200)
  const savedBody = await saved.json()
  assert.equal(savedBody.ok, true)
  assert.equal(savedBody.cleared, false)
  assert.ok(!JSON.stringify(savedBody).includes(CANARY), '响应里不得出现密钥值')

  const afterSave = await (await mock.dispatch('/api/xyb/qingnang/credentials')).json()
  const key = afterSave.channels
    .find((row) => row.serverName === 'qingnang_knows')
    .keys.find((item) => item.name === 'KNOWS_API_KEY')
  assert.equal(key.configured, true)
  assert.equal(key.source, 'local', '来源必须能区分「界面填的」与「环境变量给的」')

  const cleared = await mock.dispatch('/api/xyb/qingnang/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'KNOWS_API_KEY', value: '' })
  })
  assert.equal(cleared.status, 200)
  assert.equal((await cleared.json()).cleared, true)

  const afterClear = await (await mock.dispatch('/api/xyb/qingnang/credentials')).json()
  const clearedKey = afterClear.channels
    .find((row) => row.serverName === 'qingnang_knows')
    .keys.find((item) => item.name === 'KNOWS_API_KEY')
  assert.equal(clearedKey.configured, false)
})

test('[青囊凭据] 不认识的凭据名 / 非法体都有明确失败出口', async () => {
  const mock = await bootQingnang()

  const unknown = await mock.dispatch('/api/xyb/qingnang/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'SOMETHING_ELSE', value: 'x' })
  })
  assert.equal(unknown.status, 400)
  assert.equal((await unknown.json()).error, 'UNKNOWN_CREDENTIAL')

  const badName = await mock.dispatch('/api/xyb/qingnang/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'knows api key', value: 'x' })
  })
  assert.equal(badName.status, 400)
  assert.equal((await badName.json()).error, 'INVALID_INPUT')

  const badJson = await mock.dispatch('/api/xyb/qingnang/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json'
  })
  assert.equal(badJson.status, 400)
  assert.equal((await badJson.json()).error, 'INVALID_JSON')
})
