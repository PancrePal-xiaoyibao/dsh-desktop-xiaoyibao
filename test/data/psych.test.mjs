/**
 * 心理量表数据测试。
 *
 * 铁律：只存分、不解读（interpretation 恒为 null）；非法量表/分数/日期一律拒绝。
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
const { listPsychScores, addPsychScore, PSYCH_SCALES } = await import(libUrl('psych', 'scores.js'))

let base
before(() => {
  base = mkdtempSync(join(tmpdir(), 'xyb-psych-'))
})
after(() => {
  rmSync(base, { recursive: true, force: true })
})
const freshRoot = () => join(base, `p-${Date.now()}-${Math.random().toString(36).slice(2)}`)

test('[psych] 量表清单：四种量表且都没有分界（分界不在本期范围）', () => {
  assert.deepEqual(PSYCH_SCALES.map((s) => s.id), ['PHQ-9', 'GAD-7', 'DT', 'HADS'])
  for (const scale of PSYCH_SCALES) {
    assert.equal(scale.cutoffs, null, `${scale.id} 在本期不得给出分界（M-3）`)
    assert.match(scale.note, /待核对官方来源/, '分界标准未核对前必须如实说明')
    assert.ok(!/CHG-\d/.test(scale.note), '不得对用户暴露内部变更编号')
  }
})

test('[psych] 往返：记录分数后按时间正序读回，且 interpretation 为空', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '量表' })

  await addPsychScore(dir, p.id, { scale: 'GAD-7', score: 9, takenAt: '2026-03-02', note: '' })
  await addPsychScore(dir, p.id, { scale: 'PHQ-9', score: 12, takenAt: '2026-01-15', note: '放疗期间' })

  const { items } = await listPsychScores(dir, p.id)
  assert.equal(items.length, 2)
  assert.equal(items[0].scale, 'PHQ-9', '应按时间正序')
  assert.equal(items[0].interpretation, null, 'M-3：不得存解读结果')
  assert.equal(items[1].score, 9)
})

test('[psych] 校验：未知量表 / 越界分数 / 非法日期 / 超长备注都要拒绝', async () => {
  const dir = freshRoot()
  await initRoot(dir)
  const p = await createPatient(dir, { name: '校验' })

  await assert.rejects(() => addPsychScore(dir, p.id, { scale: 'UNKNOWN', score: 1, takenAt: '2026-01-01' }), /未知量表/)
  await assert.rejects(() => addPsychScore(dir, p.id, { scale: 'PHQ-9', score: 99, takenAt: '2026-01-01' }), /分数应在/)
  await assert.rejects(() => addPsychScore(dir, p.id, { scale: 'DT', score: 5, takenAt: '2026/01/01' }), /YYYY-MM-DD/)
  await assert.rejects(
    () => addPsychScore(dir, p.id, { scale: 'DT', score: 5, takenAt: '2026-01-01', note: 'x'.repeat(300) }),
    /上限/
  )
})
