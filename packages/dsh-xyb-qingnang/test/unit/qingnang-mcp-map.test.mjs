/**
 * MCP 配置映射测试。 ADR-902 / SPEC §7。
 *
 * 这是本 CHG 最关键的单元测试：映射错了，通道就起不来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapQingnangChannel, buildAllChannels } from '../../lib/mcp-registrar.js'

/** 青囊 `mcp-config --format=dsh` 的实测输出样本（结构取自真实输出） */
const SAMPLE = {
  transport: 'stdio',
  serverName: 'qingnang_web',
  command: '/usr/local/bin/node',
  args: ['/opt/qingnang/scripts/qingnang.mjs', 'serve', 'web_search'],
  env: { MODE: 'stdio', SEARCH_MODE: 'request' },
  cwd: '/opt/qingnang',
  toolCallTimeoutMs: 60000,
  failOnStartupError: true,
  _qingnang: {
    channel: 1,
    displayName: '青囊·通用网页搜索',
    license: 'Apache-2.0',
    credentialRequired: false,
    degradeTo: 'bing_cn',
    degradeNote: null
  }
}

test('command 必须替换为 process.execPath（不依赖用户 PATH）', () => {
  const mapped = mapQingnangChannel(SAMPLE, { assetsDir: '/app/xyb/qingnang', execPath: '/app/electron' })
  assert.equal(mapped.command, '/app/electron', '必须用 Electron 自带 Node，不用青囊配置里的绝对路径')
  assert.notEqual(mapped.command, SAMPLE.command, '不得保留青囊原始 command')
})

test('args 必须指向应用内的青囊脚本（不指向开发机路径）', () => {
  const mapped = mapQingnangChannel(SAMPLE, { assetsDir: '/app/xyb/qingnang', execPath: '/app/electron' })
  assert.equal(mapped.args[0], '/app/xyb/qingnang/scripts/qingnang.mjs')
  assert.deepEqual(mapped.args.slice(1), ['serve', 'web_search'], '子命令与通道 id 保持不变')
  assert.ok(!mapped.args.some((a) => a.includes('/opt/qingnang')), '不得残留青囊仓库原始路径')
})

test('cwd 必须指向应用内快照目录', () => {
  const mapped = mapQingnangChannel(SAMPLE, { assetsDir: '/app/xyb/qingnang', execPath: '/app/electron' })
  assert.equal(mapped.cwd, '/app/xyb/qingnang')
  assert.notEqual(mapped.cwd, '/opt/qingnang')
})

test('failOnStartupError 必须为 false（青囊失败不得阻塞宿主）', () => {
  const mapped = mapQingnangChannel(SAMPLE, { assetsDir: '/app/xyb/qingnang', execPath: '/app/electron' })
  assert.equal(mapped.failOnStartupError, false, 'S-914：青囊任何通道坏了，不能拖垮应用')
})

test('_qingnang 元信息必须被剥离（宿主不认这个字段）', () => {
  const mapped = mapQingnangChannel(SAMPLE, { assetsDir: '/app/xyb/qingnang', execPath: '/app/electron' })
  assert.equal(mapped._qingnang, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(mapped, '_qingnang'), false)
})

test('env 保持青囊默认值', () => {
  const mapped = mapQingnangChannel(SAMPLE, { assetsDir: '/app/xyb/qingnang', execPath: '/app/electron' })
  assert.equal(mapped.env.MODE, 'stdio')
  assert.equal(mapped.env.SEARCH_MODE, 'request', '强制 request 模式可完全避开 Playwright 依赖')
})

test('env 合入运行期代理（仅有代理时）', () => {
  const withProxy = mapQingnangChannel(SAMPLE, {
    assetsDir: '/app/xyb/qingnang',
    execPath: '/app/electron',
    proxy: 'http://127.0.0.1:7890'
  })
  assert.equal(withProxy.env.USE_PROXY, 'true')
  assert.equal(withProxy.env.PROXY_URL, 'http://127.0.0.1:7890')

  const withoutProxy = mapQingnangChannel(SAMPLE, { assetsDir: '/app/xyb/qingnang', execPath: '/app/electron' })
  assert.equal(withoutProxy.env.USE_PROXY, 'false', '无代理时必须显式 false，不能留空让上游默认启用')
})

test('serverName 与超时直传', () => {
  const mapped = mapQingnangChannel(SAMPLE, { assetsDir: '/app/xyb/qingnang', execPath: '/app/electron' })
  assert.equal(mapped.serverName, 'qingnang_web')
  assert.equal(mapped.transport, 'stdio')
  assert.equal(mapped.toolCallTimeoutMs, 60000)
})

test('mapQingnangChannel 是纯函数（不改动入参）', () => {
  const snapshot = JSON.stringify(SAMPLE)
  mapQingnangChannel(SAMPLE, { assetsDir: '/app/xyb/qingnang', execPath: '/app/electron' })
  assert.equal(JSON.stringify(SAMPLE), snapshot, '不得修改调用方传入的对象')
})

test('buildAllChannels：5 条零凭据通道无条件注册，2 条凭据通道按凭据决定', () => {
  const channels = [
    { serverName: 'qingnang_web', args: ['s', 'serve', 'web_search'], _qingnang: { credentialRequired: false } },
    { serverName: 'qingnang_bing', args: ['s', 'serve', 'bing_cn'], _qingnang: { credentialRequired: false } },
    { serverName: 'qingnang_pubmed', args: ['s', 'serve', 'pubmed'], _qingnang: { credentialRequired: false } },
    { serverName: 'qingnang_openalex', args: ['s', 'serve', 'openalex'], _qingnang: { credentialRequired: false } },
    { serverName: 'qingnang_trial', args: ['s', 'serve', 'unified_trial'], _qingnang: { credentialRequired: false } },
    { serverName: 'qingnang_knows', args: ['s', 'serve', 'knows'], _qingnang: { credentialRequired: true } },
    { serverName: 'qingnang_biji', args: ['s', 'serve', 'get_biji'], _qingnang: { credentialRequired: true } }
  ]

  // 无凭据：只注册 5 条
  const noCred = buildAllChannels(channels, {
    assetsDir: '/app/xyb/qingnang',
    execPath: '/app/electron',
    credentials: {}
  })
  assert.equal(noCred.registered.length, 5, '零凭据通道 5 条')
  assert.equal(noCred.skipped.length, 2, '凭据通道 2 条被跳过')

  // 有凭据：注册 7 条
  const withCred = buildAllChannels(channels, {
    assetsDir: '/app/xyb/qingnang',
    execPath: '/app/electron',
    credentials: { KNOWS_API_KEY: 'x', KNOWS_API_HOST: 'h', GET_NOTE_API_KEY: 'y' }
  })
  assert.equal(withCred.registered.length, 7)
  assert.equal(withCred.skipped.length, 0)
})

test('buildAllChannels：跳过的通道必须带未启用原因（不得静默跳过）', () => {
  const channels = [
    { serverName: 'qingnang_biji', args: ['s', 'serve', 'get_biji'], _qingnang: { credentialRequired: true, displayName: '青囊·病友经验' } }
  ]
  const result = buildAllChannels(channels, { assetsDir: '/a', execPath: '/e', credentials: {} })
  assert.equal(result.skipped.length, 1)
  assert.ok(result.skipped[0].reason, '必须有 reason')
  assert.match(result.skipped[0].reason, /凭据/, 'reason 应说明是凭据问题')
})
