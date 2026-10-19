/**
 * 数据自检与修复—— 数据层测试。
 *
 * 这类功能最危险的失败模式不是「没修好」，而是「修的时候把用户的数据弄没了」。
 * 所以本文件的重心是三条：
 * ① 造真损坏（坏 JSON、坏行、临时残留）→ 必须被检出；
 * ② 修复**先备份**、只碰可重建的东西，坏行原文仍在备份里；
 * ③ 幂等：连跑两次不叠加副作用。
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { REPAIR_ACTIONS, runRepair, runSelfCheck } from '../../packages/dsh-xyb-workbench/lib/diagnostics/selfcheck.js'
import { createPatient, initRoot } from '../../packages/dsh-xyb-workbench/lib/store/patients.js'

let root
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'xyb-selfcheck-'))
  await initRoot(root)
})
after(() => {
  rmSync(root, { recursive: true, force: true })
})

function item(result, id) {
  const found = result.items.find((i) => i.id === id)
  assert.ok(found, `自检结果里应有 ${id} 项`)
  return found
}

function backups() {
  return readdirSync(root).filter((name) => name.startsWith('.backup-'))
}

test('[selfcheck] 干净数据根：全部检查项结构完整，级别取值合法', async () => {
  const result = await runSelfCheck(root)
  assert.ok(result.items.length >= 7, `检查项应 ≥7，实际 ${result.items.length}`)
  for (const entry of result.items) {
    assert.deepEqual(Object.keys(entry).filter((k) => !['action'].includes(k)).sort().slice(0, 3), ['detail', 'id', 'label'])
    assert.ok(['ok', 'warn', 'error'].includes(entry.level), `${entry.id} 级别非法：${entry.level}`)
    assert.equal(typeof entry.detail, 'string')
    assert.equal(typeof entry.repairable, 'boolean')
  }
  assert.equal(typeof result.summary.ok, 'number')
  assert.ok(!result.items.some((i) => i.level === 'error'), '干净根不应有故障项')
})

test('[selfcheck] 坏 JSON 被抓到 → 从备份恢复 → 复检转绿', async () => {
  // 先做一份好备份（含可解析的 settings.json）
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ parseMode: 'local' }), 'utf8')
  const { createBackup } = await import('../../packages/dsh-xyb-workbench/lib/store/migrate.js')
  await createBackup(root, 'seed')

  // 再把它弄坏
  writeFileSync(join(root, 'settings.json'), '{ this is not json', 'utf8')
  const before = await runSelfCheck(root)
  const settings = item(before, 'settings')
  assert.equal(settings.level, 'error', '坏 JSON 必须报故障')
  assert.equal(settings.repairable, true)
  assert.equal(settings.action, 'restore-settings')

  const repaired = await runRepair(root, 'restore-settings')
  assert.equal(repaired.ok, true, `修复应成功：${JSON.stringify(repaired)}`)
  assert.ok(repaired.backup, '必须返回修复前备份路径')
  assert.equal(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).parseMode, 'local', '应恢复出可用设置')
  assert.equal(item(repaired.after, 'settings').level, 'ok', '复检必须转绿')
})

test('[selfcheck] 记录坏行：检出 → 压实丢弃 → 好行仍在、坏行原文留在备份里', async () => {
  // 用真实建档流程拿合法 id（手搓 id 会被 PATH_ESCAPE 拒掉 —— 这正是防护生效）
  const patient = await createPatient(root, { name: '自检档案' })
  const dir = join(root, 'patients', patient.id)
  const goodLine = JSON.stringify({ id: 'r1', indicator: 'CA19-9', value: 37, unit: 'U/mL' })
  const recordFile = join(dir, 'records.jsonl')
  mkdirSync(dir, { recursive: true })
  writeFileSync(recordFile, `${goodLine}\n{"id":"r2","value":`, 'utf8')

  const before = await runSelfCheck(root)
  const records = item(before, 'records')
  assert.equal(records.level, 'warn', '坏行应报「需注意」')
  assert.equal(records.repairable, true)
  assert.equal(records.action, 'compact-jsonl')

  const repaired = await runRepair(root, 'compact-jsonl')
  assert.equal(repaired.ok, true, JSON.stringify(repaired))
  const after = readFileSync(recordFile, 'utf8')
  assert.ok(after.includes('CA19-9'), '好行必须保留')
  assert.ok(!after.includes('"r2"'), '坏行应被丢弃')
  assert.equal(item(repaired.after, 'records').level, 'ok', '复检必须转绿')

  // 原文必须留在备份里（这是「不静默丢弃」的证据）
  const backupWithFile = repaired.backup
  const raw = readFileSync(join(backupWithFile, 'patients', patient.id, 'records.jsonl'), 'utf8')
  assert.ok(raw.includes('"r2"'), '坏行原文必须能在修复前备份里找到')
})

test('[selfcheck] 临时残留：检出 → 清理 → 幂等（第二次无变化）', async () => {
  const patient = await createPatient(root, { name: '临时文件测试档案' })
  const dir = join(root, 'patients', patient.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.records.jsonl.tmp-cafebabe'), 'x', 'utf8')
  writeFileSync(join(root, '.manifest.json.tmp-deadbeef'), 'x', 'utf8')
  const before = await runSelfCheck(root)
  assert.equal(item(before, 'temp').level, 'warn', '临时残留应报「需注意」')
  assert.equal(item(before, 'temp').action, 'clean-temp')

  const first = await runRepair(root, 'clean-temp')
  assert.equal(first.ok, true)
  assert.equal(item(first.after, 'temp').level, 'ok', '清理后应转绿')

  const second = await runRepair(root, 'clean-temp')
  assert.equal(second.ok, true, '幂等：第二次也应成功')
  assert.equal(second.changed, 0, '幂等：第二次不应再有清理动作')
})

test('[selfcheck] 白名单守卫：未知动作被拒，且不会产生任何备份或改动', async () => {
  const before = backups().length
  const result = await runRepair(root, 'delete-everything')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'UNKNOWN_ACTION')
  assert.equal(backups().length, before, '未知动作不得创建备份（更不能动数据）')
  assert.ok(Object.keys(REPAIR_ACTIONS).length >= 4, '动作白名单本身不能缩水')
})

test('[selfcheck] 每次修复都留备份（硬规则 1：备份失败就不修）', async () => {
  const before = backups().length
  const result = await runRepair(root, 'clean-temp')
  assert.equal(result.ok, true)
  assert.equal(backups().length, before + 1, '修复成功后应恰好多一份备份')
  assert.ok(result.backup.startsWith(join(root, '.backup-')), '备份应落在数据根下')
})
