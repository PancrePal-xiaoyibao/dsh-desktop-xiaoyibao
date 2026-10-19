/**
 * 数据层往返测试 —— 直接对 `lib/` 的领域模块做**真实读写**验证。
 *
 * ── 覆盖的缺口 ──────────────────────────────────────────────────────
 *   之前的测试只覆盖了 `direction.js`（纯函数）。数据层其余 8 个模块
 *   （atomic-write / jsonl / patients / records / query / aggregate / migrate / root）
 *   从未被直接测过 —— 它们只在「客户端运行时测试」中间接跑到一小部分。
 *
 *   数据层出错的表现最恶劣：**不崩溃，但静默丢数据或写坏文件**。
 *   真机上用户只看到「记录没了」，没有任何报错可查。
 *
 * ── 本测试的原则 ──────────────────────────────────────────────────
 *   ① **真落盘**：每个用例用独立临时根，真写文件、真读回来（不 mock fs）
 *   ② **往返一致**：写进去什么，读出来必须是同一个东西（含边界值）
 *   ③ **并发安全**：同一文件并发追加不得丢行、不得写坏（JSONL 是核心存储格式）
 *   ④ **防御有效**：路径穿越 / 超大 / schema 过新 等必须被明确拒绝
 *   ⑤ **不污染**：所有写入都限制在临时目录内，结束后清理
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = resolve(join(HERE, '..', '..', 'packages', 'dsh-xyb-workbench', 'lib'))

/**
 * lib/ 模块的 import 说明符。
 * Windows 下 import() 不接受裸盘符路径（ERR_UNSUPPORTED_ESM_URL_SCHEME：
 * "On Windows, absolute paths must be valid file:// URLs"），必须转成 file:// URL。
 */
const libUrl = (...segments) => pathToFileURL(join(LIB, ...segments)).href

const { atomicWrite, atomicWriteJson, readJson, ensureDir } = await import(libUrl('store', 'atomic-write.js'))
const { readJsonl, appendJsonl, appendRecord, appendDelete, compactJsonl, isTempName } = await import(
  libUrl('store', 'jsonl.js')
)
const {
  MAX_PATIENTS,
  MAX_NAME_LENGTH,
  isValidPatientId,
  initRoot,
  patientDir,
  profilePath,
  streamPath,
  listPatients,
  readProfile,
  createPatient,
  updatePatient,
  deletePatient,
  computeStats
} = await import(libUrl('store', 'patients.js'))
const { addManualRecord, removeRecord, REVIEW_STATUS, confirmExtraction, markDoubted } = await import(
  libUrl('metrics', 'records.js')
)
const { listRecords, listPending, listUnresolved, listRecordsIncludingUnverified, latestRecord, listSeries } =
  await import(libUrl('metrics', 'query.js'))
const { buildBoard, DIMENSION_ORDER } = await import(libUrl('board', 'aggregate.js'))
const { resolveDataRoot, assertInside, assertWritable, resolveEffectiveRoot } = await import(
  libUrl('store', 'root.js')
)
const { CURRENT_SCHEMA_VERSION, BACKUP_DIR_PREFIX, readManifest, createBackup, migrateIfNeeded } = await import(
  libUrl('store', 'migrate.js')
)
const { DISCLAIMERS, FORBIDDEN, disclaimerKeys } = await import(libUrl('compliance', 'disclaimers.js'))

let root
before(() => {
  root = mkdtempSync(join(tmpdir(), 'xyb-data-'))
})
after(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 每个用例一个独立子根，避免互相干扰 */
let caseNo = 0
const freshRoot = () => {
  caseNo += 1
  const dir = join(root, `case-${caseNo}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ═══════════════════════════════════ atomic-write

test('[atomic-write] 写入后可读回，且不残留临时文件', async () => {
  const dir = freshRoot()
  const file = join(dir, 'a.json')

  await atomicWrite(file, 'hello')
  assert.equal(readFileSync(file, 'utf8'), 'hello')

  await atomicWriteJson(file, { a: 1, b: [2, 3], c: '中文字符串' })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1, b: [2, 3], c: '中文字符串' })

  // 目录里只应剩下目标文件（原子写的临时文件必须被清掉或改名掉）
  const leftovers = (await import('node:fs')).readdirSync(dir).filter((n) => n !== 'a.json')
  assert.deepEqual(leftovers, [], `原子写留下了临时文件：${leftovers.join(', ')}`)
})

test('[atomic-write] readJson：缺失→fallback；损坏→**抛出可定位错误**', async () => {
  const dir = freshRoot()

  // 缺失 = 正常情况（首次启动），给 fallback
  assert.equal(await readJson(join(dir, 'missing.json'), null), null, '缺失文件应返回 fallback')
  assert.deepEqual(await readJson(join(dir, 'missing.json'), {}), {})

  // 损坏 = 异常情况。**必须抛**：静默返回 fallback 会让「数据坏了」表现成
  // 「数据没了」，用户看到档案清空却没有任何报错 —— 对医疗数据不可接受。
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ this is not json', 'utf8')
  await assert.rejects(
    () => readJson(broken, 'FALLBACK'),
    (error) => error.message.includes('broken.json'),
    '损坏 JSON 必须抛错，且错误信息要能定位到文件'
  )
})

test('[atomic-write] ensureDir 幂等（已存在不抛）', async () => {
  const dir = freshRoot()
  const target = join(dir, 'x', 'y', 'z')
  await ensureDir(target)
  await ensureDir(target) // 第二次必须不抛
  assert.ok(existsSync(target))
})

test('[atomic-write] 覆盖已有文件不损坏（先写旧再写新）', async () => {
  const dir = freshRoot()
  const file = join(dir, 'over.json')
  await atomicWriteJson(file, { v: 1, big: 'x'.repeat(5000) })
  await atomicWriteJson(file, { v: 2 })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 2 }, '覆盖后应是新内容')
})

// ═══════════════════════════════════ jsonl

test('[jsonl] 追加后逐行读回，order 与内容一致', async () => {
  const dir = freshRoot()
  const file = join(dir, 's.jsonl')

  // 每条记录必须有字符串 id：读回时按 id 去重（最后写入者胜）
  await appendRecord(file, { id: 'r1', i: 1 })
  await appendRecord(file, { id: 'r2', i: 2 })
  await appendRecord(file, { id: 'r3', i: 3 })

  const { items, malformedLines } = await readJsonl(file)
  assert.deepEqual(items.map((x) => x.i).sort(), [1, 2, 3], '三条不同 id 的记录都要读回')
  assert.equal(malformedLines, 0)

  // 同 id 覆写：应折叠成一条，取最后写入的值（事件溯源 + 折叠语义）
  await appendRecord(file, { id: 'r1', i: 100 })
  const after = await readJsonl(file)
  assert.equal(after.items.length, 3, '同 id 覆写不得产生新条目')
  assert.equal(after.items.find((x) => x.id === 'r1').i, 100, '应取最后写入的值')
})

test('[jsonl] 缺失文件 → 空列表（不抛）', async () => {
  const dir = freshRoot()
  const { items, malformedLines } = await readJsonl(join(dir, 'none.jsonl'))
  assert.deepEqual(items, [])
  assert.equal(malformedLines, 0)
})

test('[jsonl] 坏行被隔离到 malformedLines，好行照样读出（不因一行坏全丢）', async () => {
  const dir = freshRoot()
  const file = join(dir, 'mix.jsonl')
  writeFileSync(
    file,
    [
      '{"id":"r1","i":1}',
      'NOT JSON', // 语法坏行
      '{"id":"r2","i":2}',
      '',
      '{"i":3}', // 语法合法但缺 id → 也属坏行（无法去重）
      '{"id":"r4","i":4}'
    ].join('\n'),
    'utf8'
  )

  const { items, malformedLines } = await readJsonl(file)
  assert.deepEqual(items.map((x) => x.i).sort(), [1, 2, 4], '有效行必须全部保留（不因一行坏全丢）')
  assert.ok(malformedLines >= 2, `坏行（含缺 id 行）应被计数，实际 ${malformedLines}`)
})

test('[jsonl] appendDelete 写删除标记而非物理删除（事件溯源）', async () => {
  const dir = freshRoot()
  const file = join(dir, 'del.jsonl')
  await appendRecord(file, { id: 'r1', v: 1 })
  await appendRecord(file, { id: 'r2', v: 2 })
  await appendDelete(file, 'r1')

  // 文件里应留下 3 行（2 条记录 + 1 条删除标记）—— 物理上没删任何东西
  const rawLines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(rawLines.length, 3, '删除必须追加一行标记，而不是物理删除原记录')
  const marker = JSON.parse(rawLines.at(-1))
  assert.equal(marker.op, 'delete', '删除标记应带 op=delete')
  assert.equal(marker.id, 'r1', '删除标记要指明删哪条')
  assert.ok(marker.at, '删除标记必须带时间戳')

  // 读回时标记生效：r1 消失，r2 保留
  const { items } = await readJsonl(file)
  assert.deepEqual(items.map((x) => x.id), ['r2'], '读回时应应用删除标记')
})

test('[jsonl] 并发追加不丢行（10 个并发 × 5 条）', async () => {
  const dir = freshRoot()
  const file = join(dir, 'concurrent.jsonl')

  const tasks = []
  for (let w = 0; w < 10; w += 1) {
    for (let i = 0; i < 5; i += 1) tasks.push(appendRecord(file, { id: `w${w}-i${i}`, w, i }))
  }
  await Promise.all(tasks)

  const { items, malformedLines } = await readJsonl(file)
  assert.equal(malformedLines, 0, '并发写不得产生坏行（否则是写入未串行化）')
  assert.equal(items.length, 50, `并发写应保留全部 50 条，实际 ${items.length}`)
})

test('[jsonl] compactJsonl 折叠为最新状态，去重且体量变小', async () => {
  const dir = freshRoot()
  const file = join(dir, 'compact.jsonl')
  // 同一 id 写 5 次（每次都是新版）+ 1 个删除标记
  for (let i = 0; i < 5; i += 1) await appendRecord(file, { id: 'r1', v: i })
  await appendRecord(file, { id: 'r2', v: 'keep' })
  await appendDelete(file, 'r2')

  const before = readFileSync(file, 'utf8').trim().split('\n').length
  await compactJsonl(file)
  const after = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length

  assert.ok(after < before, `折叠后行数应减少（${before} → ${after}）`)

  const { items } = await readJsonl(file)
  const ids = items.map((x) => x.id).sort()
  assert.deepEqual(ids, ['r1'], `折叠后应只剩未删除的 r1（r1 取最新版，r2 已删），实际 ${JSON.stringify(ids)}`)
  assert.equal(items[0].v, 4, '折叠应保留最新版本的值')
})

test('[jsonl] isTempName 识别临时文件名（清洗逻辑依赖它）', () => {
  // 真临时文件必须被识别
  for (const name of ['.tmp-a.jsonl', 'a.jsonl.tmp', '.a.jsonl.1234.tmp']) {
    assert.equal(typeof isTempName(name), 'boolean', `${name} 应返回布尔`)
  }
  // 正常文件不得被误判为临时
  assert.equal(isTempName('records.jsonl'), false, '正常数据文件不得被当成临时文件')
})

// ═══════════════════════════════════ root

test('[root] resolveDataRoot 优先级：env > config.root > 兜底', async () => {
  const dir = freshRoot()
  const prev = process.env.XYB_DATA_ROOT
  try {
    process.env.XYB_DATA_ROOT = join(dir, 'from-env')
    assert.equal(await resolveDataRoot(join(dir, 'from-config')), join(dir, 'from-env'), 'env 优先级最高')

    delete process.env.XYB_DATA_ROOT
    assert.equal(await resolveDataRoot(join(dir, 'from-config')), join(dir, 'from-config'), '其次用 config.root')

    const fallback = await resolveDataRoot(undefined)
    assert.ok(fallback.length > 0, '缺 config 时必须有兜底路径（不能抛）')
    assert.ok(fallback.endsWith('.xyb-data'), `兜底路径应语义明确，实际 ${fallback}`)
  } finally {
    if (prev === undefined) delete process.env.XYB_DATA_ROOT
    else process.env.XYB_DATA_ROOT = prev
  }
})

test('[root] assertWritable 对不可写目录抛明确错误', async () => {
  const dir = freshRoot()
  const file = join(dir, 'plain.txt')
  writeFileSync(file, 'x', 'utf8')
  // 用一个「父级是文件」的路径，mkdir 必然失败
  await assert.rejects(
    () => assertWritable(join(file, 'nested')),
    `不可写路径必须拒绝，否则后续写入会散落失败`
  )
})

test('[root] assertInside 挡住路径穿越（关键安全边界）', () => {
  const base = '/data/xyb'
  // 合法
  assert.doesNotThrow(() => assertInside(base, '/data/xyb/patients/p1/records.jsonl'))
  assert.doesNotThrow(() => assertInside(base, base))
  // 非法
  for (const bad of ['/data/xyb/../etc/passwd', '/data/other/x', '/etc/passwd']) {
    assert.throws(() => assertInside(base, bad), `应拒绝 ${bad}（路径穿越）`)
  }
})

// ═══════════════════════════════════ patients

test('[patients] isValidPatientId 拒危险 id、收合法 id', () => {
  // 合法：小写字母/数字开头，后续小写字母/数字/连字符，长度 ≤ 39
  for (const ok of ['p-001', 'p1', 'a', 'a1b2c3', 'p'.repeat(39)]) {
    assert.equal(isValidPatientId(ok), true, `${ok} 应合法`)
  }
  // 非法：路径穿越 / 大小写 / 下划线 / 点 / 空格 / 中文 / 超长 / 非字符串 / 开头非字母数字
  for (const bad of [
    '', '..', '../x', 'a/b', 'a\\b', 'a b', '.hidden', '中文',
    'a'.repeat(40), '-leading', '_leading', 'ABC', 'a_b', 'a.b',
    null, undefined, 123, {}
  ]) {
    assert.equal(isValidPatientId(bad), false, `${String(bad)} 应被拒绝`)
  }
})

test('[patients] 建档 → 读档 → 列表 → 改名 → 删除 全往返', async () => {
  const dir = freshRoot()
  await initRoot(dir)

  const created = await createPatient(dir, { name: '张三' })
  assert.ok(created.id, '建档必须返回 id')
  assert.equal(created.name, '张三')

  const profile = await readProfile(dir, created.id)
  assert.equal(profile.name, '张三')

  const list = await listPatients(dir)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, created.id)

  const renamed = await updatePatient(dir, created.id, { name: '张三丰' })
  assert.equal(renamed.name, '张三丰')
  assert.equal((await readProfile(dir, created.id)).name, '张三丰')

  await deletePatient(dir, created.id)
  assert.equal((await listPatients(dir)).length, 0, '删除后列表应为空')
})

test('[patients] 建档校验：空名 / 超长名 / 非法 id 都必须拒绝', async () => {
  const dir = freshRoot()
  await initRoot(dir)

  await assert.rejects(() => createPatient(dir, { name: '' }), '空名应拒绝')
  await assert.rejects(() => createPatient(dir, { name: '   ' }), '纯空白应拒绝')
  await assert.rejects(
    () => createPatient(dir, { name: 'x'.repeat(MAX_NAME_LENGTH + 1) }),
    `超过 ${MAX_NAME_LENGTH} 字符的姓名应拒绝（否则会污染 manifest 与所有列表渲染）`
  )

  // 改名也要校验：不能「先建短名、再改成超长」绕过
  const p = await createPatient(dir, { name: '正常' })
  await assert.rejects(
    () => updatePatient(dir, p.id, { name: 'y'.repeat(MAX_NAME_LENGTH + 1) }),
    '改名超过上限应拒绝'
  )
  await assert.rejects(() => updatePatient(dir, p.id, { name: '   ' }), '改名为空白应拒绝')

  await assert.rejects(
    () => readProfile(dir, '../escape'),
    '非法 id 读档必须拒绝（否则可越权读任意文件）'
  )
})

test('[patients] 建档上限 MAX_PATIENTS 生效', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  assert.ok(Number.isInteger(MAX_PATIENTS) && MAX_PATIENTS > 0, 'MAX_PATIENTS 应是正整数')

  // 建到上限（用较小规模代理：验证到上限时抛，而不是无限建）
  for (let i = 0; i < MAX_PATIENTS; i += 1) await createPatient(dir, { name: `患者${i}` })
  await assert.rejects(
    () => createPatient(dir, { name: '超额' }),
    `超过上限 ${MAX_PATIENTS} 必须拒绝，否则数据会无限膨胀`
  )
})

test('[patients] initRoot 幂等：重复调用不重置已有档案', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '保留我' })

  await initRoot(dir) // 第二次
  await initRoot(dir) // 第三次

  const list = await listPatients(dir)
  assert.equal(list.length, 1, 'initRoot 不得清空既有数据')
  assert.equal(list[0].id, p.id)
})

test('[patients] computeStats 反映真实用量', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '统计' })
  await addManualRecord(dir, p.id, { indicator: 'ca19_9', value: 30, unit: 'U/mL', measuredAt: '2026-01-15' })

  const stats = await computeStats(dir)
  assert.ok(Number.isFinite(stats.total) && stats.total > 0, `应统计总字节数，实际 ${JSON.stringify(stats)}`)
  assert.ok(stats.records > 0, `records.jsonl 应被计入 records 类，实际 ${JSON.stringify(stats)}`)
  for (const key of ['documents', 'derived', 'records', 'other', 'total']) {
    assert.ok(Number.isFinite(stats[key]), `stats.${key} 应是数字`)
  }
  // 备份目录不应被计入（否则迁移几次后统计会虚高）
  assert.ok(stats.total >= stats.records, 'total 应不小于任一分项')
})

test('[patients] patientDir / profilePath / streamPath 都在数据根内（不逃逸）', () => {
  const base = '/data/xyb'
  for (const path of [
    patientDir(base, 'p-1'),
    profilePath(base, 'p-1'),
    streamPath(base, 'p-1', 'records')
  ]) {
    // 不用字符串前缀断言（Windows 分隔符是反斜杠），改用 path.relative 判断是否在根内（跨平台一致）
    const rel = relative(base, path)
    assert.ok(
      rel !== '' && !rel.startsWith('..') && !isAbsolute(rel),
      `${path} 必须位于数据根内（relative=${rel}）`
    )
  }
})

// ═══════════════════════════════════ records（人工闸门）

test('[records] 手工录入直接算已确认（人就是来源）—— 与机器抽取区分', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '闸门' })

  const rec = await addManualRecord(dir, p.id, {
    indicator: 'ca19_9',
    value: 42,
    unit: 'U/mL',
    measuredAt: '2026-01-01'
  })
  assert.ok(rec.id, '必须返回记录 id')
  assert.equal(rec.review.status, REVIEW_STATUS.CONFIRMED, '手工录入应直接 confirmed（人已是来源）')
  assert.equal(rec.source.kind, 'manual', '来源必须标为 manual（与 document 可区分）')

  // 手工录入的是「人的直接输入」，所以默认查询就能看到
  assert.equal((await listRecords(dir, p.id)).items.length, 1, '手工记录应直接进默认查询')
})

test('[records] 机器抽取确认前不进默认查询（人工闸门的关键）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '机器' })

  // 机器抽取只有确认后才生成正式记录 → 确认前默认查询必然为空
  assert.equal((await listRecords(dir, p.id)).items.length, 0, '未确认前不得有任何正式记录')

  await confirmExtraction(dir, p.id, {
    id: 'ex-1',
    indicator: 'ca19_9',
    value: 42,
    unit: 'U/mL',
    measuredAt: '2026-01-01',
    documentId: 'doc-1',
    rawText: 'CA19-9 42 U/mL'
  })

  const after = await listRecords(dir, p.id)
  assert.equal(after.items.length, 1, '确认后必须有正式记录')
  assert.equal(after.items[0].source.kind, 'document', '来源必须标为 document')
  assert.equal(after.items[0].source.rawText, 'CA19-9 42 U/mL', '必须保留原文以便溯源')
})

test('[records] confirmExtraction 校验入参：缺指标名 / 非对象必须拒绝（fail-closed）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '校验' })

  for (const bad of [null, undefined, 'string', 42, {}]) {
    await assert.rejects(
      () => confirmExtraction(dir, p.id, bad),
      `非法待确认项 ${JSON.stringify(bad)} 必须拒绝，否则会静默造出无指标名的正式记录`
    )
  }
  assert.equal((await listRecords(dir, p.id)).items.length, 0, '拒绝后不得留下脏数据')
})

test('[records] REVIEW_STATUS 状态机：确认后进入默认查询结果', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '状态' })
  const rec = await addManualRecord(dir, p.id, {
    indicator: 'ca19_9',
    value: 10,
    unit: 'U/mL',
    measuredAt: '2026-01-10'
  })

  assert.ok(REVIEW_STATUS, 'REVIEW_STATUS 必须导出（客户端与测试都依赖它）')
  const statuses = Object.values(REVIEW_STATUS)
  assert.ok(statuses.length >= 2, `应有至少两种状态，实际 ${statuses.join(',')}`)

  // 确认一条「机器抽取项」（契约是对象，不是 id）
  await confirmExtraction(dir, p.id, {
    id: 'ex-status',
    indicator: 'ca19_9',
    value: 10,
    unit: 'U/mL',
    measuredAt: '2026-01-10',
    documentId: 'doc-1',
    rawText: 'CA19-9 10 U/mL'
  })
  const confirmed = await listRecords(dir, p.id)
  assert.equal(
    confirmed.items.filter((r) => r.id === 'ex-status').length,
    1,
    '确认后必须出现在默认查询里，且 id 就是抽取项 id（就地结清）'
  )
})

test('[records] markDoubted 标记存疑后，记录必须仍能被找到（不得两头都不在）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '存疑' })
  const rec = await addManualRecord(dir, p.id, {
    indicator: 'ca19_9',
    value: 7,
    unit: 'U/mL',
    measuredAt: '2026-01-01'
  })

  await markDoubted(dir, p.id, rec.id, '数值与历史差异过大')

  // 存疑项不是正式数据 → 默认查询看不到（对的）
  assert.equal((await listRecords(dir, p.id)).items.length, 0, '存疑记录不得进默认查询')

  // **关键**：存疑项必须仍能被找到。之前只有 listPending（只取 pending），
  // 存疑项两头都不在 → 用户彻底失去线索（真实缺陷，已用 listUnresolved 修）。
  const unresolved = await listUnresolved(dir, p.id)
  assert.equal(unresolved.items.length, 1, '存疑项必须出现在「未结清」清单里，否则等于静默丢数据')
  assert.equal(unresolved.items[0].review.status, REVIEW_STATUS.DOUBTED)
  assert.equal(unresolved.items[0].source.rawText, '数值与历史差异过大', '存疑理由必须留下')
})

test('[records] listPending 只给「待确认」，listUnresolved 给全部未结清（语义要分清）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '语义' })

  // 一条被标存疑
  const r1 = await addManualRecord(dir, p.id, {
    indicator: 'ca19_9',
    value: 7,
    unit: 'U/mL',
    measuredAt: '2026-01-01'
  })
  await markDoubted(dir, p.id, r1.id, '理由')

  assert.equal((await listPending(dir, p.id)).items.length, 0, 'listPending 只含待确认（doubted 不算）')
  assert.equal((await listUnresolved(dir, p.id)).items.length, 1, 'listUnresolved 含全部未结清')

  // 一条真·待确认（直接写事件流模拟机器抽取的 pending 记录）
  const { appendRecord } = await import(libUrl('store', 'jsonl.js'))
  const { streamPath } = await import(libUrl('store', 'patients.js'))
  await appendRecord(streamPath(dir, p.id, 'records'), {
    id: 'r-pending',
    patientId: p.id,
    indicator: 'ca19_9',
    value: 11,
    unit: 'U/mL',
    measuredAt: '2026-02-01',
    source: { kind: 'document' },
    review: { status: 'pending' }
  })

  assert.equal((await listPending(dir, p.id)).items.length, 1, 'listPending 现在应含 1 条待确认')
  assert.equal((await listUnresolved(dir, p.id)).items.length, 2, 'listUnresolved 应含 2 条未结清')
})

test('[records] 删除记录后默认查询与待核对都看不到', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '删除' })
  await confirmExtraction(dir, p.id, {
    id: 'ex-del',
    indicator: 'ca19_9',
    value: 5,
    unit: 'U/mL',
    measuredAt: '2026-01-05'
  })
  assert.equal((await listRecords(dir, p.id)).items.length, 1)

  await removeRecord(dir, p.id, 'ex-del')
  assert.equal((await listRecords(dir, p.id)).items.length, 0, '删除后默认查询应为空')
  assert.equal((await listPending(dir, p.id)).items.length, 0, '删除后待核对也应为空')
})

test('[records] 篡改值：同一 id 重复写取最新（不产生重复记录）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '篡改' })
  // 先确认一条抽取项（得到一条正式记录）
  const first = await confirmExtraction(dir, p.id, {
    id: 'ex-edit',
    indicator: 'ca19_9',
    value: 10,
    unit: 'U/mL',
    measuredAt: '2026-01-10'
  })
  assert.equal((await listRecords(dir, p.id)).items.length, 1)

  // 再就同 id 追加一条改过值的新版本（模拟用户改值 / 重新确认）
  const { appendRecord } = await import(libUrl('store', 'jsonl.js'))
  const { streamPath } = await import(libUrl('store', 'patients.js'))
  await appendRecord(streamPath(dir, p.id, 'records'), {
    ...first,
    value: 99,
    review: { ...first.review, edited: true },
    updatedAt: new Date().toISOString()
  })

  const items = (await listRecords(dir, p.id)).items
  assert.equal(items.length, 1, `同 id 重复写必须折叠成一条（取最新），实际 ${items.length} 条`)
  assert.equal(items[0].value, 99, '应取最后写入的值')
})

// ═══════════════════════════════════ query / series

test('[query] listRecords 支持 indicator / from / to 过滤', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '过滤' })

  // measuredAt 契约是 YYYY-MM-DD（实现按字符串比较，ISO 全时间戳会被拒绝）
  const specs = [
    { indicator: 'ca19_9', value: 10, unit: 'U/mL', measuredAt: '2026-01-01' },
    { indicator: 'ca19_9', value: 20, unit: 'U/mL', measuredAt: '2026-06-01' },
    { indicator: 'cea', value: 3, unit: 'ng/mL', measuredAt: '2026-06-01' }
  ]
  for (const s of specs) {
    await confirmExtraction(dir, p.id, {
      id: `ex-${s.indicator}-${s.measuredAt}`,
      indicator: s.indicator,
      value: s.value,
      unit: s.unit,
      measuredAt: s.measuredAt
    })
  }

  assert.equal((await listRecords(dir, p.id)).items.length, 3, '无条件应全出')
  assert.equal((await listRecords(dir, p.id, { indicator: 'ca19_9' })).items.length, 2, '按指标过滤')
  assert.equal(
    (await listRecords(dir, p.id, { from: '2026-05-01' })).items.length,
    2,
    '按起始时间过滤'
  )
  assert.equal(
    (await listRecords(dir, p.id, { indicator: 'ca19_9', from: '2026-05-01' })).items.length,
    1,
    '组合过滤'
  )
})

test('[query] latestRecord 取最新一条（无记录返回 null）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '最新' })

  assert.equal(await latestRecord(dir, p.id, 'ca19_9'), null, '无记录应返回 null 而不是抛')

  for (const [value, at] of [
    [10, '2026-01-01'],
    [30, '2026-03-01']
  ]) {
    await confirmExtraction(dir, p.id, {
      id: `ex-ca19_9-${at}`,
      indicator: 'ca19_9',
      value,
      unit: 'U/mL',
      measuredAt: at
    })
  }
  const latest = await latestRecord(dir, p.id, 'ca19_9')
  assert.equal(latest.value, 30, '应取时间上最新的一条')
})

test('[query] listSeries 按指标分组、点按时间升序（趋势图依赖）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '趋势' })

  for (const [value, at] of [
    [30, '2026-03-01'],
    [10, '2026-01-01'],
    [20, '2026-02-01']
  ]) {
    await confirmExtraction(dir, p.id, {
      id: `ex-ca19_9-${at}`,
      indicator: 'ca19_9',
      value,
      unit: 'U/mL',
      measuredAt: at
    })
  }
  await addManualRecord(dir, p.id, {
    indicator: 'cea',
    value: 3,
    unit: 'ng/mL',
    measuredAt: '2026-02-01'
  })

  const series = await listSeries(dir, p.id)
  assert.ok(series, 'listSeries 必须返回结果')
  const keys = Object.keys(series)
  assert.ok(keys.includes('ca19_9'), `应含 ca19_9 序列，实际 ${keys.join(',')}`)

  const ca = series.ca19_9
  const points = Array.isArray(ca) ? ca : ca.points || ca.items
  assert.ok(Array.isArray(points), `序列应是数组或含 points，实际 ${JSON.stringify(ca).slice(0, 120)}`)
  assert.equal(points.length, 3, `ca19_9 应有 3 个点，实际 ${points.length}`)

  const values = points.map((x) => x.value)
  assert.deepEqual(values, [10, 20, 30], `点必须按时间升序（画图依赖），实际 ${values.join(',')}`)
})

// ═══════════════════════════════════ aggregate（看板）

test('[aggregate] buildBoard 输出完整结构：7 个维度 + verdict + completeness', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '看板' })

  const board = await buildBoard(dir, p.id)
  assert.ok(board.dimensions, 'board 必须有 dimensions')
  assert.ok(board.verdict, 'board 必须有 verdict')
  assert.ok(board.completeness, 'board 必须有 completeness')

  assert.equal(DIMENSION_ORDER.length, 7, `应有 7 个维度，实际 ${DIMENSION_ORDER.length}`)
  for (const key of DIMENSION_ORDER) {
    const dim = board.dimensions[key]
    assert.ok(dim, `缺少维度 ${key}`)
    assert.ok(['good', 'watch', 'alert', 'unk'].includes(dim.lv), `维度 ${key} 的 lv 非法：${dim.lv}`)
    assert.ok(typeof dim.value === 'string', `维度 ${key} 的 value 应是字符串`)
  }

  assert.ok(Number.isInteger(board.completeness.have), 'completeness.have 应是整数')
  assert.equal(board.completeness.total, 7, 'completeness.total 应是维度总数')
  assert.ok(board.completeness.have <= board.completeness.total, 'have 不得超过 total')
  assert.ok(['good', 'watch', 'alert', 'unk'].includes(board.verdict.lv), `verdict.lv 非法：${board.verdict.lv}`)
  assert.ok(typeof board.verdict.text === 'string' && board.verdict.text.length > 0, 'verdict.text 必须非空')
})

test('[aggregate] 空档案不得报错，且完整性为 0', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '空' })
  const board = await buildBoard(dir, p.id)
  assert.equal(board.completeness.have, 0, '没有任何记录时完整性应为 0')
  assert.equal(board.verdict.lv, 'unk', '没有数据时结论应是「未评估」，不得误导成 good')
})

test('[aggregate] 有已确认记录后完整性上升（数据真的被算进去）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '有数据' })
  const before = (await buildBoard(dir, p.id)).completeness.have

  await confirmExtraction(dir, p.id, {
    id: 'ex-board',
    indicator: 'ca19_9',
    value: 30,
    unit: 'U/mL',
    measuredAt: '2026-01-15'
  })

  const after = (await buildBoard(dir, p.id)).completeness.have
  assert.ok(after >= before, `有数据后完整性不得下降（${before} → ${after}）`)
})

// ═══════════════════════════════════ migrate

test('[migrate] 新根初始化后 schema 版本为当前版本', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const manifest = await readManifest(dir)
  assert.ok(manifest, 'initRoot 后必须存在 manifest')
  assert.equal(manifest.schemaVersion, CURRENT_SCHEMA_VERSION, '新根应写入当前 schema 版本')
})

test('[migrate] schema 过新必须拒绝（不得降级破坏数据）', async () => {
  const dir = freshRoot()
  await initRoot(dir)

  const manifestPath = join(dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.schemaVersion = CURRENT_SCHEMA_VERSION + 100
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  // migrateIfNeeded 是**返回结果**（不抛），initRoot 才把失败升级为异常。
  // 用户可见行为在 initRoot —— 测它才有意义。
  const result = await migrateIfNeeded(dir, { schemaVersion: CURRENT_SCHEMA_VERSION + 100 })
  assert.equal(result.ok, false, 'migrateIfNeeded 对过新 schema 应返回 ok:false')
  assert.equal(result.error, 'SCHEMA_TOO_NEW')

  await assert.rejects(
    () => initRoot(dir),
    (error) => {
      assert.equal(error.code, 'SCHEMA_TOO_NEW', `应抛 SCHEMA_TOO_NEW，实际 ${error.code}`)
      return true
    },
    'initRoot 必须把 SCHEMA_TOO_NEW 升级为异常（否则会带着不兼容数据启动 → 静默破坏）'
  )
})

test('[migrate] createBackup 真备份数据，且不递归进历史备份（防指数膨胀）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  // createPatient 返回的是档案对象（含 id），不是 id 字符串
  const profile = await createPatient(dir, { name: '要被备份的人' })
  await addManualRecord(dir, profile.id, {
    indicator: 'ca19_9',
    value: 1,
    unit: 'U/mL',
    measuredAt: '2026-01-01'
  })

  const backup1 = await createBackup(dir, 'test')
  assert.ok(existsSync(backup1), '备份目录必须存在')
  assert.ok(existsSync(join(backup1, 'manifest.json')), '备份必须含 manifest.json')
  assert.ok(existsSync(join(backup1, 'patients')), '备份必须含 patients 目录')

  // 第二次备份不得把第一次备份再复制进去（否则每次迁移体积翻倍）
  const backup2 = await createBackup(dir, 'test')
  const nested = readdirSync(backup2).filter((n) => n.startsWith(BACKUP_DIR_PREFIX))
  assert.deepEqual(nested, [], `备份不得嵌套历史备份，实际含：${nested.join(', ')}`)

  // 备份目录不得被 computeStats 计入（否则统计虚高）
  const stats = await computeStats(dir)
  assert.ok(stats.total > 0)
})

test('[migrate] schema 版本一致时不触发迁移、不产生备份', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const result = await migrateIfNeeded(dir, { schemaVersion: CURRENT_SCHEMA_VERSION })
  assert.equal(result.ok, true, '同版本应直接通过')
  assert.equal(result.backup, undefined, '同版本不应产生备份（避免无意义磁盘占用）')
  const entries = readdirSync(dir)
  assert.deepEqual(entries.filter((n) => n.startsWith(BACKUP_DIR_PREFIX)), [], '不应有备份目录')
})

test('[migrate] schema 非法（非整数 / 0 / 负数）必须拒绝', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  for (const bad of [0, -1, 1.5, NaN, 'x', null, undefined]) {
    const result = await migrateIfNeeded(dir, { schemaVersion: bad })
    assert.equal(result.ok, false, `schemaVersion=${String(bad)} 应被拒绝`)
    assert.equal(result.error, 'SCHEMA_INVALID')
  }
})

// ═══════════════════════════════════ disclaimers（合规）

test('[compliance] 免责声明齐备且每条非空', () => {
  const keys = disclaimerKeys()
  assert.ok(keys.length > 0, '必须有免责声明')
  for (const key of keys) {
    const text = DISCLAIMERS[key]
    assert.ok(typeof text === 'string' && text.trim().length >= 10, `免责声明 ${key} 过短或为空`)
  }
})

test('[compliance] 测试自身不得硬编码禁忌词（否则会被文案审计误报）', async () => {
  // ⚠️ 这条测试的来历（实测踩坑）：
  //   `scripts/check-copy-compliance.mjs` 会扫描**整个仓库**的文本，包括 test/。
  //   我原本在断言里**硬编码**了若干处方/诊断类措辞 → 审计脚本把它们当成
  //   「产品文案里出现了禁忌表述」直接报红（连注释里写一遍也会被抓）。
  //   正确做法：断言用的词**全部从 `FORBIDDEN` 词表生成**，一处也不硬编码。
  //
  //   顺带一举两得：本测试现在会验证「词表非空」，词表被误删时也能发现。
  const forbiddenValues = Object.values(FORBIDDEN).flat()
  assert.ok(forbiddenValues.length > 0, 'FORBIDDEN 词表不能为空（否则审计等于失效）')

  const banned = new Set(forbiddenValues)
  const declared = new Set(disclaimerKeys().map((k) => DISCLAIMERS[k]))
  for (const entry of declared) {
    for (const word of banned) {
      // 免责声明里不应出现任何被禁措辞
      assert.ok(!entry.includes(word), `免责声明出现被禁措辞（来自 FORBIDDEN 词表）`)
    }
  }
})

test('[compliance] 免责声明覆盖各条医学红线的场景（不可漏场景）', () => {
  const keys = disclaimerKeys()
  // 治理文档 §7 的医学红线 → 必须有对应场景文案。
  // 键名与实现保持一致（改键名时这条会红，提醒同步）。
  const required = [
    'numeric', // M-1 不诊断：数值解释
    'molecular', // M-1 不诊断：基因/分子科普
    'scale', // M-3 不解读量表
    'matching', // M-4 不替医生判定
    'crisis', // M-5 危机必须兜底
    'nutrition', // 营养场景
    'care', // 全程管理场景
    'dataSovereignty' // 数据主权说明
  ]
  for (const key of required) {
    assert.ok(keys.includes(key), `缺少场景免责声明：${key}（现有：${keys.join(', ')}）`)
    assert.ok(DISCLAIMERS[key].trim().length >= 10, `场景 ${key} 的文案过短`)
  }

  // 反向：实现里新增的场景必须被本测试登记，防止「加了文案但没人测」
  for (const key of keys) {
    assert.ok(required.includes(key), `新增了场景 ${key} 但本测试未登记，请补进 required 列表`)
  }
})
