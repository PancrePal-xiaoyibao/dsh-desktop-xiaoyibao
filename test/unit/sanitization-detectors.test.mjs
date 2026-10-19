/**
 * 脱敏检查器的检出能力。
 *
 * 为什么要单独一个测试文件：`check-sanitization.mjs` 是**我们唯一的安全网**，
 * 而「安全网自己坏掉」是最危险的失效模式 —— 它静默通过，所有人以为没问题。
 * 所以它的自检（注入构造的假敏感值 → 断言全类别可检出）必须被当成一等公民对待：
 * 由本测试**每次全量回归时执行**，而不是靠人手记得跑。
 */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

test('[脱敏检查器] --self-test 必须证明「全类别可检出 + 白名单不误报」', () => {
  let output = ''
  let code = 0
  try {
    output = execFileSync(process.execPath, ['scripts/check-sanitization.mjs', '--self-test'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    code = error.status ?? 1
    output = `${error.stdout || ''}${error.stderr || ''}`
  }
  assert.equal(code, 0, `自检必须通过（否则安全网已失效）：\n${output.slice(-800)}`)
  assert.ok(output.includes('自检通过'), `必须打印自检通过：\n${output.slice(-400)}`)
})

test('[脱敏检查器] 真实仓库扫描：工作区零命中（这是发布前的硬闸门）', () => {
  let output = ''
  let code = 0
  try {
    output = execFileSync(process.execPath, ['scripts/check-sanitization.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    code = error.status ?? 1
    output = `${error.stdout || ''}${error.stderr || ''}`
  }
  assert.equal(code, 0, `工作区扫描必须零命中：\n${output.slice(-800)}`)
  assert.match(output, /零命中/, '必须明确报告零命中（而不是「没抓到」）')
})
