/**
 * 品牌资产与署名测试 —— M12-2 / M12-5。
 *
 * 由来：社区开发者反馈「logo 有点太小了」。改名/换图/调尺寸这类改动**不会**被任何
 * 现有测试挡住 —— 谁都可以把 logo 改回 14px 的字符占位，CI 依旧全绿。本文件就是那道闸门：
 *
 * 1. **一致性**：同一份吉祥物资产在两个 client.js 里必须逐字节相同（历史上两处内联过
 * 不同版本，改一处忘另一处 → 界面里出现两个不同 logo）；
 * 2. **完整性**：data URI 必须能解出真实图像魔数（防止注入时被截断成半张图）；
 * 3. **可见度下限**：各位点的 logo 高度不得低于阈值（社区开发者投诉的那个坑）；
 * 4. **可点击外链**：两个 logo 必须链到社区 GitHub / 上游项目主页，且带 noopener；
 * 5. **锁定标不得抠底**：上游锁定标是深色板 + 白字，转成透明 PNG 会把白字毁掉。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

const WORKBENCH = readFileSync(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'client.js'), 'utf8')
const BRANDING = readFileSync(join(REPO_ROOT, 'packages', 'dsh-xyb-branding', 'client.js'), 'utf8')
const CSS = WORKBENCH.slice(WORKBENCH.indexOf('<style') >= 0 ? 0 : 0)

const COMMUNITY_URL = 'https://github.com/PancrePal-xiaoyibao'
const NEXT_TEAM_URL = 'https://www.dshdesktop.cn/'

/** 取形如 `const NAME =\n 'data:image/…'` 的常量值。 */
function constant(source, name) {
  const match = source.match(new RegExp(`const ${name} =\\s*\\n?\\s*'(data:image/[^']+)'`))
  assert.ok(match, `找不到常量 ${name}（改名后必须同步本测试）`)
  return match[1]
}

function decodeDataUri(uri) {
  const [meta, payload] = uri.split(',')
  assert.ok(meta.includes(';base64'), `只支持 base64 data URI：${meta}`)
  return Buffer.from(payload, 'base64')
}

/** 从 `.cls { ... }` 规则里读某个属性值（首个匹配）。 */
function ruleValue(source, cls, prop) {
  const rule = source.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`))
  assert.ok(rule, `CSS 里找不到 .${cls} 规则`)
  const found = rule[1].match(new RegExp(`${prop}:\\s*([0-9.]+)px`))
  assert.ok(found, `.${cls} 里找不到 ${prop}（像素值）`)
  return Number(found[1])
}

test('[brand] 吉祥物资产在两个 client.js 里逐字节一致（防两处内联漂移）', () => {
  const inWorkbench = constant(WORKBENCH, 'XYB_LOGO_DATA_URI')
  const inBranding = constant(BRANDING, 'XYB_MARK_DATA_URI')
  assert.equal(inBranding, inWorkbench, '品牌资产必须同源同版本（改一处必须改另一处）')
  assert.ok(inWorkbench.length > 5000, `资产过小，疑似占位：${inWorkbench.length} 字符`)
  assert.ok(inWorkbench.startsWith('data:image/webp;base64,'), '吉祥物必须是带透明的 WebP（白底 JPG 无法直接上浅色界面）')
})

test('[brand] 资产完整性：魔数正确（防注入截断/编码错误）', () => {
  const mascot = decodeDataUri(constant(WORKBENCH, 'XYB_LOGO_DATA_URI'))
  assert.equal(mascot.subarray(0, 4).toString('ascii'), 'RIFF', '吉祥物应是 RIFF 容器')
  assert.equal(mascot.subarray(8, 12).toString('ascii'), 'WEBP', '吉祥物应是 WebP 格式')
  assert.ok(mascot.length > 3000, `吉祥物字节数过小：${mascot.length}`)

  const lockup = decodeDataUri(constant(WORKBENCH, 'DSH_LOCKUP_DATA_URI'))
  assert.deepEqual([...lockup.subarray(0, 3)], [0xff, 0xd8, 0xff], '上下游锁定标应是 JPEG')
  assert.ok(lockup.length > 8000, `锁定标字节数过小：${lockup.length}`)
})

test('[brand] 锁定标保持深色板 JPEG（抠底会毁掉白字，这是有意决策）', () => {
  assert.ok(
    constant(WORKBENCH, 'DSH_LOCKUP_DATA_URI').startsWith('data:image/jpeg;base64,'),
    '上游锁定标必须是原始 JPEG；不要「优化」成透明 PNG —— 它的白色字标依赖深色底'
  )
  assert.match(WORKBENCH, /不要抠底/, '决策理由必须留在代码注释里（防止后人好心改坏）')
})

test('[brand] 可见度下限：各位点 logo 高度不得低于社区反馈阈值', () => {
  const mins = [
    ['xybBrandLogo', 32], // 顶栏主品牌位
    ['xybBrandRowLogo', 30], // AI 面板署名条（主品牌）
    ['xybBrandLockup', 24], // AI 面板署名条（上游锁定标）
    ['xybAboutLogoXYB', 56], // 设置页「关于」
    ['xybAboutLogoDSH', 32]
  ]
  for (const [cls, min] of mins) {
    const height = ruleValue(WORKBENCH, cls, 'height')
    assert.ok(height >= min, `.${cls} 高度 ${height}px 低于阈值 ${min}px（社区开发者投诉过「logo 太小」）`)
  }
})

test('[brand] 旧字符占位绝迹（◈ 是被投诉「太小」的那个）', () => {
  assert.ok(!WORKBENCH.includes('◈'), 'workbench 不得再用 ◈ 占位')
  assert.ok(!BRANDING.includes('◈'), 'branding 不得再用 ◈ 占位')
})

test('[brand] 两个 logo 都是可点击外链，并带 noopener', () => {
  assert.ok(WORKBENCH.includes(COMMUNITY_URL), '缺少社区 GitHub 链接')
  assert.ok(WORKBENCH.includes(NEXT_TEAM_URL), '缺少上游项目主页链接')
  assert.ok(BRANDING.includes(COMMUNITY_URL), '对话区品牌标记也应链回社区')

  const anchors = [...WORKBENCH.matchAll(/href:\s*[A-Z_]+_URL,\s*\n?\s*target:\s*'_blank',\s*\n?\s*rel:\s*'noopener noreferrer'/g)]
  assert.ok(anchors.length >= 3, `外链锚点数量不足（顶栏 / 署名条 ×2 / 关于区 ×2）：${anchors.length}`)
})
