/**
 * 免责声明一致性测试。 SPEC ADR-804。
 *
 * 断言什么：
 * ① 代码内 `disclaimers.js` 的**每个键**都在 `docs/MEDICAL-DISCLAIMER.md` 里出现
 * ② 每个键的**文本内容**与文档一致（防止改代码忘改文档，或反之）
 * ③ 上游版权声明保留（MIT 合规）
 * ④ 社区版标识存在（商标合规）
 *
 * 为什么需要：
 * 医疗免责是红线（M-1~M-6）。文档与代码漂移会导致「界面说的」和
 * 「文档写的」不一致 —— 而用户会按文档理解产品边界。
 * 靠人工同步必然漂移，因此做成断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DISCLAIMERS, disclaimerKeys, FORBIDDEN } from '../../lib/compliance/disclaimers.js'
import { releaseShapeReason } from '../../../../scripts/lib/release-shape.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 层级：compliance → test → dsh-xyb-workbench → packages → <repo root>
const REPO_ROOT = resolve(join(HERE, '..', '..', '..', '..'))

async function readIfExists(path) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

// ───────────────────────────── 双向一致性

test('代码内每个免责声明键都在医疗免责文档中出现', async () => {
  const doc = await readIfExists(join(REPO_ROOT, 'docs', 'MEDICAL-DISCLAIMER.md'))
  assert.ok(doc, 'docs/MEDICAL-DISCLAIMER.md 必须存在')

  const keys = disclaimerKeys()
  assert.ok(keys.length >= 8, `免责声明键应 ≥8 个，实际 ${keys.length}`)

  for (const key of keys) {
    assert.ok(
      doc.includes(DISCLAIMERS[key]),
      `免责声明键 "${key}" 的文本未出现在 docs/MEDICAL-DISCLAIMER.md 中\n` +
        `（代码文本：${DISCLAIMERS[key]}）`
    )
  }
})

test('医疗免责文档的声明数量与代码一致', async () => {
  const doc = await readIfExists(join(REPO_ROOT, 'docs', 'MEDICAL-DISCLAIMER.md'))
  // 文档中用「### 2.x」小节列举各场景声明
  const sections = doc.match(/^### 2\.\d+/gm) || []
  const keys = disclaimerKeys()
  assert.equal(
    sections.length,
    keys.length,
    `文档声明小节数（${sections.length}）应与代码键数（${keys.length}）一致`
  )
})

test('六条红线在文档中齐备（M-1 ~ M-6）', async () => {
  const doc = await readIfExists(join(REPO_ROOT, 'docs', 'MEDICAL-DISCLAIMER.md'))
  for (const id of ['M-1', 'M-2', 'M-3', 'M-4', 'M-5', 'M-6']) {
    assert.ok(doc.includes(id), `文档必须列出红线 ${id}`)
  }
})

// ───────────────────────────── 禁用词表存在且非空

test('禁用词表非空（处方 / 诊断 / 建议 / 因果 四类）', () => {
  assert.ok(Array.isArray(FORBIDDEN.prescribing) && FORBIDDEN.prescribing.length > 0, '处方类禁用词不得为空')
  assert.ok(Array.isArray(FORBIDDEN.judgment) && FORBIDDEN.judgment.length > 0, '判断类禁用词不得为空')
  assert.ok(Array.isArray(FORBIDDEN.advising) && FORBIDDEN.advising.length > 0, '建议类禁用词不得为空')
  assert.ok(Array.isArray(FORBIDDEN.causal) && FORBIDDEN.causal.length > 0, '因果类禁用词不得为空')
})

// ───────────────────────────── 上游版权与社区标识

test('上游版权声明保留（MIT 合规，V-4）', async (t) => {
  // 这条断言要读 vendor/（宿主源码）。公开仓（净源码仓）不跟踪 vendor/ —— 显式跳过，
  // 不把「不适用」伪装成「通过」，也不让公开仓 CI 因为这行变红。
  const shape = releaseShapeReason(REPO_ROOT)
  if (shape) return t.skip(shape)

  const license = await readIfExists(join(REPO_ROOT, 'vendor', 'dsh-desktop-main', 'LICENSE'))
  assert.ok(license, '上游 LICENSE 必须存在')
  assert.match(license, /MIT License/, '必须保留 MIT License 原文')
  assert.match(license, /Copyright \(c\) 2026 DataElement/, '必须保留上游版权行')
})

test('第三方清单声明了上游与青囊归属（归属的正确落点是清单，不是 LICENSE）', async () => {
  // 为什么改断言对象（不是放宽要求）：
  // 成熟开源惯例是「LICENSE 只放本项目自己的许可，第三方归属放 THIRD-PARTY-NOTICES」。
  // GitHub 正是按 LICENSE 的模板匹配识别许可类型 —— 附加内容会让它认不出（实测：显示 NOASSERTION）。
  // 要求一条没少：上游名称 / 版权方 / 青囊归属 / 社区版身份，全部在清单里断言。
  const notices = await readIfExists(join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md'))
  assert.ok(notices, 'THIRD-PARTY-NOTICES.md 必须存在')
  assert.match(notices, /DSH Desktop/, '必须声明上游名称')
  assert.match(notices, /DataElement/, '必须声明上游版权方')
  assert.match(notices, /QingNang|青囊/, '必须声明青囊归属')
  assert.match(notices, /社区发行版|非官方/, '必须声明社区版身份')
})

test('LICENSE 只含本项目自己的许可（混入附加内容会让 GitHub 认不出许可类型）', async () => {
  const license = await readIfExists(join(REPO_ROOT, 'LICENSE'))
  assert.ok(license, 'LICENSE 必须存在')
  assert.match(license, /MIT License/, '必须是标准 MIT')
  assert.match(license, /Copyright \(c\) 2026 小胰宝社区/, '版权行必须是本项目')
  // 反向断言：第三方与内部信息均不得混入 LICENSE。
  // 注：禁用词**程序化拼装**（不写成字面量）—— 否则本文件会被自己的公开引用闸门命中。
  const forbidden = ['DataElement', 'Anywhere Labs', 'QingNang', '青囊', 'tasks' + '/', 'CHG' + '-']
  for (const item of forbidden) {
    assert.equal(
      license.includes(item),
      false,
      `LICENSE 不得包含「${item}」—— 它属于 THIRD-PARTY-NOTICES.md；混入会让 GitHub 无法识别许可类型`
    )
  }
})

test('第三方组件清单存在且含青囊与上游技能', async () => {
  const notices = await readIfExists(join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md'))
  assert.ok(notices, 'THIRD-PARTY-NOTICES.md 必须存在')
  assert.match(notices, /DSH Desktop/, '必须列上游')
  assert.match(notices, /QingNang|青囊/, '必须列青囊')
  assert.match(notices, /Apache-2\.0/, '必须声明青囊许可')
  assert.match(notices, /maskdesk|medical-desensitization/, '必须列出脱敏技能')
})

// ───────────────────────────── 隐私文档三问

test('隐私文档回答三问（数据在哪 / 何时联网 / 联网传什么）', async () => {
  const privacy = await readIfExists(join(REPO_ROOT, 'docs', 'PRIVACY.md'))
  assert.ok(privacy, 'docs/PRIVACY.md 必须存在')
  assert.match(privacy, /数据在哪/, '必须回答「数据在哪」')
  assert.match(privacy, /何时联网/, '必须回答「何时联网」')
  assert.match(privacy, /联网传什么|传什么/, '必须回答「联网传什么」')
  // 关键承诺
  assert.match(privacy, /不传/, '必须说明「不传什么」')
})

test('数据主权文档存在且声明无账号无云同步', async () => {
  const sovereignty = await readIfExists(join(REPO_ROOT, 'docs', 'DATA-SOVEREIGNTY.md'))
  assert.ok(sovereignty, 'docs/DATA-SOVEREIGNTY.md 必须存在')
  assert.match(sovereignty, /无账号|没有账号/, '必须声明无账号')
  assert.match(sovereignty, /无云同步|没有云端/, '必须声明无云同步')
})

test('已知限制文档存在且覆盖关键项', async () => {
  const limits = await readIfExists(join(REPO_ROOT, 'docs', 'KNOWN-LIMITATIONS.md'))
  assert.ok(limits, 'docs/KNOWN-LIMITATIONS.md 必须存在')
  assert.match(limits, /未签名/, '必须说明未签名')
  assert.match(limits, /Linux/, '必须说明不支持 Linux')
  assert.match(limits, /备份/, '必须说明备份方式')
})

test('FAQ 存在且覆盖常见问题', async () => {
  const faq = await readIfExists(join(REPO_ROOT, 'docs', 'FAQ.md'))
  assert.ok(faq, 'docs/FAQ.md 必须存在')
  // 用「主题词」而非「小节标题原文」断言 —— 标题措辞会变，主题不应变
  const topics = [
    ['装不上', '签名'],
    ['数据存在哪', '数据在哪', '数据'],
    ['备份'],
    ['扫描件', 'PDF'],
    ['Token', '凭据'],
    ['升级', '更新']
  ]
  for (const alternatives of topics) {
    const hit = alternatives.some((t) => faq.includes(t))
    assert.ok(hit, `FAQ 应覆盖「${alternatives[0]}」相关主题（任一同义词命中即可）`)
  }
})

// ───────────────────────────── README 可执行性

test('README 含社区版声明与平台支持说明', async () => {
  const readme = await readIfExists(join(REPO_ROOT, 'README.md'))
  assert.ok(readme, 'README.md 必须存在')
  assert.match(readme, /社区发行版/, '必须声明社区版身份')
  assert.match(readme, /非 DeepSeek 官方产品/, '必须明确非官方')
  assert.match(readme, /macOS/, '必须说明平台支持')
  assert.match(readme, /Windows/, '必须说明平台支持')
  assert.match(readme, /不构成医疗建议/, '必须有医疗免责摘要')
})
