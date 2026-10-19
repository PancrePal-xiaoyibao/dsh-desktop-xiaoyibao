/**
 * 示例数据必须明显虚构。
 *
 * 依据：ADR-803 —— 仓库里的演示数据「不赌真实性，一律替换」成**一眼可辨的虚构**，
 * 这样即使有人截图外发，也不会牵扯真实病人信息。
 *
 * 本测试锁住两点：
 * ① 原型/文档明确声明演示数据为虚构（有声明 banner）；
 * ② 原型里的患者名来自**显式白名单**（新加名字必须改这里 → 强制一次「这名字虚构吗」的思考）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const PROTOTYPE = join(REPO_ROOT, 'docs', 'prototype-v2.html')

/** 允许出现在演示数据里的患者名（全部带「虚构演示」标记）。 */
const ALLOWED_DEMO_NAMES = ['林阿姨', '陈先生']

test('[示例数据] 原型必须显式声明「全部虚构」（用户能看见的那种声明）', () => {
  const html = readFileSync(PROTOTYPE, 'utf8')
  assert.match(html, /全部患者、报告、试验、规则与数字均为虚构演示/, '必须有虚构声明 banner')
  assert.match(html, /演示数据：全部虚构/, '必须有演示数据标注')
})

test('[示例数据] 原型里的患者名必须来自白名单，且带「虚构演示」标记', () => {
  const html = readFileSync(PROTOTYPE, 'utf8')
  const picker = html.match(/<select id="patient"[\s\S]{0,600}?<\/select>/)?.[0] || ''
  assert.ok(picker, '原型应含患者选择器')
  const options = [...picker.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((m) => m[1].trim())
  assert.ok(options.length >= 2, '患者选择器应有演示选项')

  for (const label of options) {
    if (label.includes('未选择')) continue
    assert.ok(label.includes('虚构演示'), `演示患者「${label}」必须带「虚构演示」标记`)
    const name = label.split('·')[0].trim()
    assert.ok(
      ALLOWED_DEMO_NAMES.includes(name),
      `演示患者名「${name}」不在白名单里。新增演示数据请先确认它是明显虚构的，并把它加进 ALLOWED_DEMO_NAMES`
    )
  }
})

test('[示例数据] 仓库文档里不得出现真实机构 + 真实姓名的组合式演示数据', () => {
  // 只做「明显红线」检查：最常见的真实三甲医院全名出现在演示语境里
  const files = ['docs/prototype-v2.html', 'README.md', 'docs/FAQ.md']
  for (const file of files) {
    let text
    try {
      text = readFileSync(join(REPO_ROOT, file), 'utf8')
    } catch {
      continue
    }
    for (const hospital of ['北京协和医院', '复旦大学附属肿瘤医院', '中山大学肿瘤防治中心']) {
      if (!text.includes(hospital)) continue
      // 出现机构名是允许的（例如隐私说明），但必须是「声明/说明」语境，不得与演示患者绑定
      assert.ok(
        !new RegExp(`${hospital}[^。]{0,20}(患者|病人|档案)`).test(text),
        `${file} 里「${hospital}」不得与演示患者绑定`
      )
    }
  }
})
