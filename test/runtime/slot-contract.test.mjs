/**
 * 槽位契约测试 —— 客户端插件的 `ctx.slots` 注册规则。
 *
 * ── 这个测试防的是第四次崩溃（2026-10-16）──────────────────────────
 *   服务端已经全绿：`[desktop] Harness is ready`
 *   但 renderer（客户端）报：
 *
 *     [renderer] Error: single slot "sidebar.brand.mark" already has a registration
 *                at priority 0 (registered by mf) — register at a different priority to shadow it
 *     [renderer] Failed to load plugins
 *
 *   根因：宿主 `dsh-desktop-client-ui` 已经往三个品牌槽位注册了自己的一套
 *   （DSH logo，**默认优先级 0**），而这三个槽位的 kind 是 **single**
 *   （同一优先级只能一个占据者）。我们的品牌层也用默认 0 注册 → 直接抛错。
 *
 *   规则真源：`scripts/lib/slot-contract-rules.mjs`
 *   （逐字抄自 @deepseek-ai/dsh-client-ui-slots@0.2.0-rc.2，文件头有 sha256）
 *
 * ── 与前三次崩溃的共性 ─────────────────────────────────────────────
 *   四次都是同一类：**我的替身不认识宿主的真实规则**。
 *   前三次是「服务端路由规则」，这一次是「客户端槽位规则」。
 *   所以这个测试用**真规则替身**（SLOT_KINDS + createSlotRegistry），
 *   并预置「宿主已经占了哪些槽位」——不预置就重现不了真实冲突。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PRIORITY,
  SLOT_KIND,
  SLOT_KINDS,
  createSlotRegistry,
  explainSlotConflict,
  getRenderingEntries
} from '../../scripts/lib/slot-contract-rules.mjs'
import {
  HOST_OCCUPANTS,
  HOST_OCCUPANT_SOURCE,
  collectUsedSlots,
  loadClient,
  mountClient
} from '../../scripts/lib/client-sandbox.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

const PLUGINS = ['dsh-xyb-branding', 'dsh-xyb-qingnang', 'dsh-xyb-workbench']

// ═══════════════════════════════════════════ 装载：不得抛错

for (const name of PLUGINS) {
  test(`[装载] ${name} 在「宿主已占位」的前提下装载不抛错`, () => {
    // 这条断言就是第四次崩溃的回归测试：
    // 修复前（品牌层用默认 priority 0）会抛
    //   `single slot "sidebar.brand.mark" already has a registration at priority 0`
    // → 真机上整个 renderer 的插件加载失败。
    assert.doesNotThrow(
      () => mountClient(REPO_ROOT, name),
      `[${name}] 客户端插件装载抛错 → 真宿主会报「Failed to load plugins」→ 界面打不开`
    )
  })
}

test('[装载] 三个客户端插件可以同时装载（槽位互不冲突）', () => {
  const registry = createSlotRegistry()
  const owners = new Map()

  for (const name of PLUGINS) {
    const source = loadClient(REPO_ROOT, name).source
    const used = collectUsedSlots(source)
    for (const slot of used) {
      const kind = SLOT_KINDS[slot]
      assert.ok(kind, `槽位 ${slot} 的 kind 未登记 —— 不能猜，先补 kind 表`)
      if (!registry.entries(slot).length) registry.declare(slot, kind, name)
      // 记录谁用了这个槽位（用于报错定位）
      owners.set(slot, [...(owners.get(slot) ?? []), name])
    }
  }

  // 真正的检查：三方都按真规则注册一遍
  for (const name of PLUGINS) {
    assert.doesNotThrow(() => mountClient(REPO_ROOT, name), `[${name}] 装载抛错`)
  }

  // 报告槽位归属（便于人工复核）
  for (const [slot, list] of owners) {
    assert.ok(list.length >= 1)
  }
})

// ═══════════════════════════════════════════ 品牌层：必须用负数优先级遮蔽宿主

test('[branding] 三个品牌槽位都是 single，必须用 priority 遮掉宿主的 0', () => {
  const { registered } = mountClient(REPO_ROOT, 'dsh-xyb-branding')

  const brandSlots = ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark']
  for (const slot of brandSlots) {
    // ① 槽位 kind 必须是 single（这是「必须给优先级」的前提）
    assert.equal(SLOT_KINDS[slot], SLOT_KIND.SINGLE, `${slot} 应是 single 槽位`)
    // ② 宿主确实已占 priority 0
    assert.ok(HOST_OCCUPANTS[slot]?.length, `${slot} 应预置宿主占据者（否则测不到冲突）`)

    // ③ 我方必须给出**不同的**优先级
    const mine = registered.find((r) => r.spec.name === slot)
    assert.ok(mine, `品牌层必须往 ${slot} 注册`)
    assert.notEqual(
      mine.spec.priority,
      DEFAULT_PRIORITY,
      `${slot} 用的是默认优先级 0，与宿主冲突 → 宿主抛「already has a registration」→ ` +
        `客户端插件全部加载失败。修法：给一个更小的 priority（数字最小的渲染）`
    )
    assert.ok(
      typeof mine.spec.priority === 'number' && mine.spec.priority < DEFAULT_PRIORITY,
      `${slot} 的 priority 应小于宿主（${DEFAULT_PRIORITY}）才能遮蔽，实际 ${mine.spec.priority}`
    )
  }
})

test('[branding] 我方在品牌槽位上最终「渲染胜出」（遮蔽真的生效）', () => {
  const { slotRegistry } = mountClient(REPO_ROOT, 'dsh-xyb-branding')

  for (const slot of ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark']) {
    const rendering = slotRegistry.rendering(slot)
    assert.equal(rendering.length, 1, `${slot} 作为 single 槽位，最终只应有一个胜出者`)

    const winner = rendering[0]
    assert.ok(
      winner.registrant !== 'dsh-desktop-client-ui',
      `${slot} 的胜出者仍是宿主（registrant=${winner.registrant}）—— ` +
        `说明 priority 不够小，界面上会显示 DSH 的 logo 而不是小胰宝`
    )
    assert.equal(
      winner.priority,
      -1,
      `${slot} 应靠 priority=-1 遮蔽宿主（数字最小的渲染）`
    )
  }
})

// ═══════════════════════════════════════════ qingnang：list 槽位靠唯一 id

test('[qingnang] settings.general.item 是 list 槽位，靠唯一 id 与宿主共存（不需要优先级）', () => {
  assert.equal(SLOT_KINDS['settings.general.item'], SLOT_KIND.LIST, '该槽位应是 list')

  const { registered, slotRegistry } = mountClient(REPO_ROOT, 'dsh-xyb-qingnang')
  const mine = registered.find((r) => r.spec.name === 'settings.general.item')
  assert.ok(mine, '青囊必须往 settings.general.item 注册')
  assert.ok(mine.spec.id, 'list 槽位必须有 id（宿主会抛 requires options.id）')

  // id 不能与宿主的撞（否则 same (id, priority) 冲突）
  const hostIds = (HOST_OCCUPANTS['settings.general.item'] ?? []).map((o) => o.id)
  assert.ok(!hostIds.includes(mine.spec.id), `id "${mine.spec.id}" 与宿主冲突`)

  // list 槽位应当**同时**保留宿主与我们的条目
  const rendering = slotRegistry.rendering('settings.general.item')
  const ids = rendering.map((e) => e.id).sort()
  assert.ok(ids.includes(mine.spec.id), '我方条目应在渲染列表中')
  for (const hid of hostIds) {
    assert.ok(ids.includes(hid), `宿主条目 ${hid} 也应保留（list 槽位不做遮蔽）`)
  }
})

// ═══════════════════════════════════════════ 规则真源自检

test('[溯源] SLOT_KINDS 与宿主声明一致（钉住关键槽位 + 记录出处）', () => {
  // 四个我用到的槽位，kind 来自宿主自己的 children 声明
  assert.equal(SLOT_KINDS['sidebar.brand.mark'], 'single')
  assert.equal(SLOT_KINDS['sidebar.brand.name'], 'single')
  assert.equal(SLOT_KINDS['conversation.hero.brand.mark'], 'single')
  assert.equal(SLOT_KINDS['settings.general.item'], 'list')

  // 宿主占据者的出处必须可追溯（改宿主后要复核）
  for (const [who, where] of Object.entries(HOST_OCCUPANT_SOURCE)) {
    assert.ok(who && where, '必须记录宿主占据者的来源')
    assert.match(where, /client\.js:\d+/, `${who} 的出处应精确到文件:行号`)
  }

  assert.ok(Object.keys(SLOT_KINDS).length >= 20, 'kind 表应覆盖宿主的槽位（当前少于 20 个可疑）')
})

test('[溯源] 冲突判定行为与宿主逐字一致（用真实错误文案）', () => {
  // 宿主原文：single slot "X" already has a registration at priority 0
  //           (registered by mf) — register at a different priority to shadow it (lowest renders)
  const registry = createSlotRegistry()
  registry.declare('sidebar.brand.mark', 'single', 'host')
  registry.register({ name: 'sidebar.brand.mark', priority: 0, registrant: 'mf' }, () => null)

  assert.throws(
    () => registry.register({ name: 'sidebar.brand.mark', priority: 0, registrant: 'me' }, () => null),
    (error) => {
      assert.match(error.message, /single slot "sidebar\.brand\.mark" already has a registration/)
      assert.match(error.message, /at priority 0/)
      assert.match(error.message, /registered by mf/)
      assert.match(error.message, /lowest renders/)
      return true
    },
    '同优先级冲突必须抛错，且文案与宿主一致（便于在真日志里对照定位）'
  )

  // 不同优先级 → 不抛
  assert.doesNotThrow(
    () => registry.register({ name: 'sidebar.brand.mark', priority: -1, registrant: 'me' }, () => null),
    '换一个优先级应当可以注册（这是宿主给出的官方遮蔽手段）'
  )
})

test('[溯源] 未声明的槽位必须抛错（不是静默忽略）', () => {
  const registry = createSlotRegistry()
  assert.throws(
    () => registry.register({ name: 'not.declared.at.all' }, () => null),
    /is not declared/,
    '注册到未声明槽位必须抛错（否则界面静默不显示，用户以为功能没做）'
  )
})

test('[溯源] 优先级语义：数字最小的渲染（lowest renders）', () => {
  const entries = [
    { priority: 0, registrant: 'host' },
    { priority: -1, registrant: 'me' },
    { priority: 5, registrant: 'other' }
  ]
  const heads = getRenderingEntries('single', entries)
  assert.equal(heads.length, 1, 'single 槽位只应有一个胜出者')
  assert.equal(heads[0].registrant, 'me', 'priority 数字最小的应胜出')
})

test('[溯源] list 槽位按 (id, priority) 分格，组内按 order 排显示顺序', () => {
  const entries = [
    { id: 'a', priority: 0, order: 30, registrant: 'host' },
    { id: 'b', priority: 0, order: 90, registrant: 'me' }
  ]
  const heads = getRenderingEntries('list', entries)
  assert.equal(heads.length, 2, 'list 槽位不同 id 应各自保留')
  assert.deepEqual(heads.map((e) => e.id), ['a', 'b'], '组内按 order 升序')
})

test('[溯源] explainSlotConflict 能解释四种 kind 的失败原因（供静态检查器用）', () => {
  const occupied = [{ priority: 0, id: 'x', key: 'k', registrant: 'host' }]

  assert.ok(explainSlotConflict({ kind: 'single', priority: 0, existing: occupied }), 'single 冲突应可解释')
  assert.equal(explainSlotConflict({ kind: 'single', priority: -1, existing: occupied }), null)

  assert.ok(explainSlotConflict({ kind: 'keyed', priority: 0, existing: occupied }), 'keyed 缺 key 应报')
  assert.ok(
    explainSlotConflict({ kind: 'list', priority: 0, existing: occupied }),
    'list 缺 id 应报'
  )
  assert.equal(explainSlotConflict({ kind: 'chain', existing: occupied }), null, 'chain 不做遮蔽')

  // kind 未知 → **不猜**（第三次崩溃的教训）
  const unknown = explainSlotConflict({ kind: 'no-such-kind', priority: 0, existing: [] })
  assert.ok(unknown && unknown.includes('未登记'), 'kind 未知必须明确报「无法校验」，不得静默通过')
})

// ═══════════════════════════════════════════ 自检：探针验证测试不是假绿

test('[自检] 把品牌层的 priority 去掉后，本测试必须变红（证明它真的在防第四次崩溃）', () => {
  const { source } = loadClient(REPO_ROOT, 'dsh-xyb-branding')

  // 还原成修复前的写法：只给 name，不给 priority
  const broken = source
    .replace(/priority:\s*BRAND_PRIORITY\s*,\s*\}\s*,\s*DualBrandMark\)/, '}, DualBrandMark)')
    .replace(/name:\s*'sidebar\.brand\.name',\s*priority:\s*BRAND_PRIORITY\s*\}/, "name: 'sidebar.brand.name' }")

  assert.notEqual(broken, source, '探针改造应生效（否则本测试失效）')

  assert.throws(
    () => mountClient(REPO_ROOT, 'dsh-xyb-branding', { sourceOverride: broken }),
    /already has a registration/,
    '去掉 priority 后必须重现第四次崩溃的错误（否则这个测试防不住它）'
  )
})
