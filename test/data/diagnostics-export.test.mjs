/**
 * 诊断包导出—— 数据层测试。
 *
 * 这个功能的失败模式很危险：包是给**开发者**看的，一旦夹带病历内容，
 * 用户的隐私就随着「求助」一起流出去。所以测试的核心是**投毒**：
 * 先往系统里放真实姓名 / 长数字 / 文档名 / 路径，再导出，然后逐项断言「原文找不到」。
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { collectDiagnostics, exportDiagnostics, diagnosticsDir, summarizeTree } from '../../packages/dsh-xyb-workbench/lib/diagnostics/export.js'
import { appendEvent, listEvents } from '../../packages/dsh-xyb-workbench/lib/store/events.js'

let root
before(() => {
  root = mkdtempSync(join(tmpdir(), 'xyb-diag-'))
})
after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('[diag] 结构统计只给数字：目录/文件/字节，且不含文件名', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(join(root, 'patients', 'p_1'), { recursive: true })
  await writeFile(join(root, 'patients', 'p_1', '张三-CT-20261017.pdf'), 'x'.repeat(2048), 'utf8')

  const summary = await summarizeTree(root)
  assert.ok(summary.files >= 1, '应统计到文件')
  assert.ok(summary.bytes >= 2048, '应统计到字节数')
  assert.deepEqual(Object.keys(summary).sort(), ['bytes', 'dirs', 'files', 'truncated'], '只允许这四个字段')
})

test('[diag] 导出：落盘 + sha256 与内容一致 + 含隐私声明', async () => {
  await appendEvent(root, { level: 'info', phase: 'app', code: 'READY', message: '工作台已启动' })
  const { events } = await listEvents(root, { limit: 20 })

  const result = await exportDiagnostics(root, {
    routes: ['/events/list', '/health'],
    events,
    version: '0.1.0',
    plugin: 'dsh-xyb-workbench'
  })
  assert.ok(result.path.startsWith(diagnosticsDir(root)), '导出文件应落在数据根的 diagnostics/ 下')
  assert.ok(result.bytes > 200, '包体不应为空')
  assert.equal(result.sha256.length, 64, 'sha256 应为 64 位十六进制')

  const text = readFileSync(result.path, 'utf8')
  assert.equal(createHash('sha256').update(text).digest('hex'), result.sha256, 'sha256 必须与实际内容一致')
  const payload = JSON.parse(text)
  assert.equal(payload.kind, 'xyb-diagnostics')
  assert.equal(payload.formatVersion, 1)
  assert.deepEqual(payload.routes, ['/events/list', '/health'], '路由面排序后原样写入')
  assert.ok(payload.privacy.statement.includes('不含病历正文'), '必须带隐私声明')
  assert.ok(payload.privacy.upload.includes('none'), '必须写明不上传')
})

test('[diag] 投毒：姓名 / 长数字 / 文档名 / 绝对路径都不得出现在包里', async () => {
  const poisonName = '欧阳测试'
  await appendEvent(root, {
    level: 'error',
    phase: 'import',
    code: 'POISON',
    message: `读取 D:\\病程资料\\${poisonName}-穿刺报告.pdf 失败，住院号 2026101700999，联系 13800138000`,
    names: [poisonName]
  })
  const { events } = await listEvents(root, { limit: 20 })

  const { path } = await exportDiagnostics(root, {
    routes: ['/health'],
    events,
    version: '0.1.0',
    names: [poisonName]
  })
  const text = readFileSync(path, 'utf8')

  for (const secret of [poisonName, '2026101700999', '13800138000', '穿刺报告', 'D:\\病程资料']) {
    assert.ok(!text.includes(secret), `诊断包不得含原文：${secret}`)
  }
  assert.ok(text.includes('<name>') || text.includes('<num>') || text.includes('<path>'), '应保留脱敏骨架供排障')
  assert.ok(/\d/.test(text), '版本号/时间戳等结构信息仍应保留')
})

test('[diag] 空数据根也能导出（不因缺目录而失败）', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'xyb-diag-empty-'))
  try {
    const { payload } = await collectDiagnostics(empty, { routes: [], events: [] })
    assert.equal(payload.dataRoot.structure.files, 0)
    const result = await exportDiagnostics(empty, { routes: [], events: [] })
    assert.ok(result.bytes > 100, '空根也应产出一个可读的包')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
