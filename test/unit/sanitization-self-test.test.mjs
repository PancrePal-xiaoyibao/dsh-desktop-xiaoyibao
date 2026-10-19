/**
 * 脱敏脚本**自身**必须干净。
 *
 * 逻辑很直白但很容易被忽略：**一个含真实值的扫描脚本本身就是一个泄露源**。
 * 本测试用「本机真实身份」作为探针 —— 如果脚本源码里出现了本机的用户名/邮箱/手机号，
 * 那它就已经把不该有的东西写进了仓库。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

/** 被检查的脚本集合：安全网本体。 */
const SCANNER_FILES = [
  'scripts/check-sanitization.mjs',
  'scripts/lib/host-contract-rules.mjs',
  'scripts/lib/release-shape.mjs',
  'scripts/lib/smoke-detect.mjs'
]

/** 允许出现（示例语境）的域名/邮箱。 */
const ALLOWED_EMAILS = /@(example\.(com|org|net)|test\.invalid|localhost)$/i

function read(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

test('[脚本自身干净] 不得出现本机用户名（用真实身份做探针）', () => {
  const username = userInfo().username
  if (!username || username.length < 3) {
    assert.ok(true, '用户名过短（或不可用），跳过探针')
    return
  }
  for (const rel of SCANNER_FILES) {
    const text = read(rel)
    // 允许出现在「模式定义」里（如 /Users\/[A-Za-z0-9_.-]{1,32}/），但不允许真实用户名出现
    const hit = new RegExp(`(?:Users|home)[\\\\/]${username}\\b`, 'i').test(text)
    assert.equal(hit, false, `${rel} 出现了本机用户名「${username}」——脚本本身就是泄露源`)
  }
})

test('[脚本自身干净] 不得出现真实邮箱 / 手机号 / 长数字串', () => {
  for (const rel of SCANNER_FILES) {
    const text = read(rel)
    const emails = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).filter(
      (email) => !ALLOWED_EMAILS.test(email)
    )
    assert.deepEqual(emails, [], `${rel} 出现疑似真实邮箱：${emails.join(', ')}`)

    // 长数字串（≥6 位）：脚本里只应出现「模式」而不是真值；用基准排除明显的版本号/年份
    const longNumbers = (text.match(/\b\d{6,}\b/g) || []).filter((n) => !/^(202[0-9]|0\d{5,})$/.test(n))
    assert.deepEqual(longNumbers, [], `${rel} 出现疑似真实长数字：${longNumbers.join(', ')}`)
  }
})

test('[脚本自身干净] 自检用的假值必须是明显构造的（带标记，不与真实格式混同）', () => {
  const text = read('scripts/check-sanitization.mjs')
  // 自检里注入的假值必须一眼可辨（例如 example.com / 全 0 数字），避免「假值看起来像真值」
  assert.match(text, /selfTest|自检/, '脚本必须含自检逻辑')
  assert.ok(
    text.includes('example.com') || text.includes('伪造') || text.includes('假值') || text.includes('FAKE'),
    '自检注入的值必须是明显构造的（example.com / FAKE / 伪造 等标记）'
  )
})
