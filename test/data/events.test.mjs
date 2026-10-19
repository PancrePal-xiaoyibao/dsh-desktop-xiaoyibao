/**
 * 事件时间线—— 数据层测试。
 *
 * 这是医疗数据产品的**诊断资产**：它必须能被排障的人读懂，同时**绝不能**带出病历内容。
 * 因此本文件的核心不是「能写能读」，而是三条防线：
 * ① 字段白名单（调用方塞进来的业务对象必须被丢掉）；
 * ② 脱敏投毒（把真实姓名/路径/长数字写进去，落盘后必须找不到原文）；
 * ③ 滚动上限（日志不许无限增长吃掉用户磁盘）。
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  EVENT_FIELDS,
  MAX_BYTES,
  appendEvent,
  eventsPath,
  listEvents,
  normalizeEvent
} from '../../packages/dsh-xyb-workbench/lib/store/events.js'
import { redactText } from '../../packages/dsh-xyb-workbench/lib/compliance/redact.js'

let root
before(() => {
  root = mkdtempSync(join(tmpdir(), 'xyb-events-'))
})
after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('[events] 追加与读回：新 → 旧，total 正确', async () => {
  const { events, total } = await listEvents(root, { limit: 10 })
  const before = total
  await appendEvent(root, { level: 'info', phase: 'test', code: 'A', message: '第一条' })
  await appendEvent(root, { level: 'warn', phase: 'test', code: 'B', message: '第二条' })

  const after = await listEvents(root, { limit: 10 })
  assert.equal(after.total, before + 2, '总数应 +2')
  assert.equal(after.events[0].message, '第二条', '最新的一条在最前')
  assert.equal(after.events[1].message, '第一条', '其次是上一条')
  assert.equal(events.length, after.events.length - 2, '前后条数关系正确')
})

test('[events] 字段白名单：业务对象不得混进日志（病历正文/姓名一律丢弃）', async () => {
  const { dropped } = normalizeEvent({ level: 'info', phase: 'p', code: 'C', message: 'm', patientName: '张三', record: { value: 1 } })
  assert.deepEqual(dropped.sort(), ['patientName', 'record'], '未知字段必须被登记为丢弃')

  await appendEvent(root, {
    level: 'info',
    phase: 'p',
    code: 'WHITELIST_PROBE',
    message: '带脏字段的一条',
    patientName: '张三',
    record: { value: 120, note: '病历正文不得入库' }
  })
  const line = readFileSync(eventsPath(root), 'utf8').trim().split('\n').pop()
  const parsed = JSON.parse(line)
  assert.deepEqual(Object.keys(parsed).sort(), [...EVENT_FIELDS].sort(), `落盘字段必须恰为白名单，实际 ${Object.keys(parsed)}`)
  assert.ok(!line.includes('张三'), '姓名不得落盘')
  assert.ok(!line.includes('病历正文不得入库'), '业务正文不得落盘')
})

test('[events] 脱敏投毒：路径 / 长数字 / 手机号 / URL / 已知姓名都不得以原文落盘', async () => {
  const poison = '读取 D:\\病程资料\\CT-报告.pdf 失败，检查号 2026101700123，联系电话 13800138000，参见 https://example.com/x?token=abc'
  const result = await appendEvent(root, {
    level: 'error',
    phase: 'import',
    code: 'POISON',
    message: poison,
    names: ['李小花']
  })
  assert.equal(result.ok, true)

  const raw = readFileSync(eventsPath(root), 'utf8')
  for (const secret of ['病程资料', 'CT-报告.pdf', '2026101700123', '13800138000', 'https://example.com/x']) {
    assert.ok(!raw.includes(secret), `原文不得落盘：${secret}`)
  }
  const stored = JSON.parse(raw.trim().split('\n').pop())
  assert.ok(stored.redactions >= 3, `必须记录替换次数（自证脱敏），实际 ${stored.redactions}`)
  assert.ok(stored.message.includes('<path>') || stored.message.includes('<num>'), '应保留可读骨架')

  // 已知姓名（当前档案患者名）也必须是精确替换
  const named = redactText('患者李小花本次复查', { names: ['李小花'] })
  assert.equal(named.text, '患者<name>本次复查')
  assert.ok(named.redactions >= 1)
})

test('[events] 坏行不致命：写入中断产生的半行被跳过，其余照常可读', async () => {
  const file = eventsPath(root)
  const before = readFileSync(file, 'utf8')
  writeFileSync(file, `${before}{"ts":"坏行"\n`, 'utf8')
  const { events } = await listEvents(root, { limit: 200 })
  assert.ok(events.length >= 1, '坏行不得让整份日志不可读')
  assert.ok(events.every((e) => typeof e.message === 'string'), '返回的每条都应是结构完整的记录')
})

test('[events] 级别筛选与 limit 收敛', async () => {
  await appendEvent(root, { level: 'error', phase: 't', code: 'E1', message: '错误一条' })
  const onlyError = await listEvents(root, { level: 'error', limit: 50 })
  assert.ok(onlyError.events.length >= 1, '应能筛出错误级')
  assert.ok(onlyError.events.every((e) => e.level === 'error'), '筛选结果只能是错误级')

  const limited = await listEvents(root, { limit: 1 })
  assert.equal(limited.events.length, 1, 'limit=1 只返回一条')
  const clamped = await listEvents(root, { limit: 10_000 })
  assert.ok(clamped.events.length <= 200, 'limit 上限 200（防止一次拉爆界面）')
})

test('[events] 滚动上限：文件超过 2MB 时截断最旧、保留最新', async () => {
  const file = eventsPath(root)
  mkdirSync(join(root, 'events'), { recursive: true })
  // 直接种一个大文件：比逐条追加快得多，且能精确控制规模
  const filler = JSON.stringify({ ts: new Date().toISOString(), level: 'info', phase: 'seed', code: 'SEED', message: 'x'.repeat(400), redactions: 0 })
  const lines = Array.from({ length: 6000 }, () => filler)
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  assert.ok(statSync(file).size > MAX_BYTES, '前置条件：种子文件必须超过上限')

  await appendEvent(root, { level: 'info', phase: 'roll', code: 'AFTER_ROLL', message: '滚动之后写入的最新一条' })

  const size = statSync(file).size
  assert.ok(size <= MAX_BYTES, `滚动后仍超过上限：${size}`)
  const { events } = await listEvents(root, { limit: 5 })
  assert.equal(events[0].message, '滚动之后写入的最新一条', '最新一条必须还在')
})
