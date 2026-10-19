/**
 * 病情评估档案数据测试。
 *
 * 钉住：空档案结构、往返一致、缺失≠0（空字符串不落 0）、上界与非法值拒绝、
 * 未知患者拒绝、局部合并不丢其它组。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = resolve(join(HERE, '..', '..'), 'packages', 'dsh-xyb-workbench', 'lib')
const libUrl = (...segments) => pathToFileURL(join(LIB, ...segments)).href

const { initRoot, createPatient } = await import(libUrl('store', 'patients.js'))
const { readAssess, updateAssess } = await import(libUrl('assess', 'profile.js'))

let base
before(() => {
  base = mkdtempSync(join(tmpdir(), 'xyb-assess-'))
})
after(() => {
  rmSync(base, { recursive: true, force: true })
})
const freshRoot = () => join(base, `p-${Date.now()}-${Math.random().toString(36).slice(2)}`)

test('[assess] 空档案：结构齐备且数值为 null（不是 0）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '空评估' })

  const profile = await readAssess(dir, p.id)
  assert.equal(profile.schemaVersion, 1)
  assert.equal(profile.basic.age, null)
  assert.equal(profile.basic.weightKg, null, '未填写必须是 null，不能是 0')
  assert.deepEqual(profile.diagnosis.gene, [])
  assert.deepEqual(profile.treatment.lines, [])
  assert.deepEqual(profile.pending, [])
})

test('[assess] 往返一致：写入后读回同值，局部合并不丢其它组', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '往返' })

  await updateAssess(dir, p.id, {
    basic: { age: 62, sex: 'female', ecog: 1, weightKg: 52.5 },
    diagnosis: { primary: '胰头', histology: '腺癌', gene: ['KRAS G12D'], ihc: ['CK19+'] }
  })
  await updateAssess(dir, p.id, { treatment: { lines: [{ line: '1', name: 'AG 方案', startedAt: '2026-01-01' }] } })

  const profile = await readAssess(dir, p.id)
  assert.equal(profile.basic.age, 62)
  assert.equal(profile.basic.sex, 'female')
  assert.equal(profile.basic.weightKg, 52.5)
  assert.deepEqual(profile.diagnosis.gene, ['KRAS G12D'])
  assert.equal(profile.treatment.lines.length, 1)
  assert.equal(profile.treatment.lines[0].name, 'AG 方案')
  assert.ok(profile.updatedAt, '应记录更新时间')
})

test('[assess] 清空数值写回 null（缺失≠0）', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '清空' })

  await updateAssess(dir, p.id, { basic: { weightKg: 50 } })
  await updateAssess(dir, p.id, { basic: { weightKg: '' } })
  const profile = await readAssess(dir, p.id)
  assert.equal(profile.basic.weightKg, null)
})

test('[assess] 校验：非法数值 / 超长 / 非法枚举都要拒绝', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '校验' })

  await assert.rejects(() => updateAssess(dir, p.id, { basic: { age: 'abc' } }), /数字/)
  await assert.rejects(() => updateAssess(dir, p.id, { basic: { age: 200 } }), /合理范围/)
  await assert.rejects(() => updateAssess(dir, p.id, { basic: { sex: 'other' } }), /取值非法/)
  await assert.rejects(() => updateAssess(dir, p.id, { diagnosis: { primary: 'x'.repeat(300) } }), /上限/)
  await assert.rejects(() => updateAssess(dir, p.id, { pending: new Array(50).fill('a') }), /最多/)
})

test('[assess] 未知患者拒绝写入', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  await assert.rejects(() => updateAssess(dir, 'p-not-exist', { basic: { age: 60 } }))
})
