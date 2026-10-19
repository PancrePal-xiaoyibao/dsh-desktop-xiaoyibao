/**
 * 槽位契约规则真源 —— 客户端插件的 `ctx.slots` 注册规则。
 *
 * ── 为什么需要它（真实事故，2026-10-16，第四个安装包）────────────────
 *   服务端（Harness）已经全绿：`[desktop] Harness is ready`。
 *   但客户端（renderer）插件全部加载失败：
 *
 *     [renderer] Error: single slot "sidebar.brand.mark" already has a registration
 *                at priority 0 (registered by mf) — register at a different priority to shadow it
 *     [renderer] Failed to load plugins
 *
 *   根因：宿主 `dsh-desktop-client-ui` 已经往三个品牌槽位注册了自己的一套（DSH logo，
 *   默认优先级 0），而这三个槽位的 kind 是 **single**（同一优先级只能一个占据者）。
 *   我们的品牌层也用默认 0 注册 → 直接抛错 → 客户端插件整体加载失败 → 界面打不开。
 *
 * ── 这和第 3 次崩溃（路由路径参数）是同一个病根 ─────────────────────
 *   我的测试替身不认识宿主的真实规则。上次是「路径字符集」，这次是「槽位 kind 与优先级」。
 *   所以规则必须从宿主真实源码抄录，并与检查器/测试共用同一份（见 AGENTS.md §5.4.4）。
 *
 * ── 权威来源（逐字对齐，非推测）──────────────────────────────────
 *   包：@deepseek-ai/dsh-client-ui-slots@0.2.0-rc.2
 *   tgz sha256：4b152f3676fc54606e3475c30e8f86e2e794d899ed49167401ecef6ab283fbdd
 *   文件：lib/index.js
 *     · L163   `register(options, component) {`
 *     · L167   `const priority = options.priority ?? 0;`
 *     · L168   occupantHint()（错误文案模板）
 *     · L169-188  按 spec.kind 分派：single / keyed / list / chain
 *     · L221   `next.sort(...)`（list 按 priority→order；其余只按 priority）
 *     · L262-292 `entriesOfSlot(key)`（每格取第一个 → **priority 数字最小的渲染**）
 *
 *   槽位 kind 来源：宿主各 client.js 的 `children` 声明表
 *     例：sidebar 声明 `"sidebar.brand.mark": { kind: "single", scope: "root" }`
 *   kind 表由 `scripts/lib/slot-kinds.json` 提供（生成方式见该文件头的注释）。
 *
 *   ⚠️ 宿主升级时这些规则可能变；`test/runtime/slot-contract.test.mjs` 里有溯源钉，
 *      常量变化会报警提醒复核。
 */

/**
 * 宿主声明的槽位 kind 表（**权威**，来自宿主自己的 children 声明）。
 *
 * 只列宿主真实声明过的槽位。查不到 kind 的槽位**不能猜** ——
 * 检查器会把它报成「需复核」，而不是当成安全默认值（见 explainSlotConflict）。
 */
export const SLOT_KINDS = Object.freeze({
  'conversation.chat.commandview': 'keyed',
  'conversation.chat.node': 'keyed',
  'conversation.chat.turnTail': 'list',
  'conversation.composer': 'chain',
  'conversation.composer.dock': 'list',
  'conversation.header.leading': 'single',
  'conversation.hero.brand.mark': 'single',
  'conversation.hero.workspace': 'single',
  'conversation.input.activity': 'single',
  'conversation.input.dock': 'list',
  'conversation.input.left': 'list',
  'conversation.input.model': 'single',
  'conversation.input.overlay': 'list',
  'conversation.input.permission': 'single',
  'conversation.input.plan': 'single',
  'conversation.input.right': 'list',
  'conversation.message.images': 'single',
  'conversation.session': 'single',
  'conversation.session.header': 'single',
  'conversation.session.header.actions': 'list',
  'conversation.session.header.corner': 'single',
  'conversation.session.header.lineage': 'single',
  'conversation.session.header.utilities': 'list',
  'conversation.view': 'list',
  'main': 'keyed',
  'rightbar': 'single',
  'settings.action': 'list',
  'settings.close': 'single',
  'settings.general.item': 'list',
  'settings.header': 'single',
  'settings.launcher': 'single',
  'settings.onboarding': 'list',
  'settings.section': 'list',
  'settings.trigger': 'single',
  'shell.leading': 'single',
  'shell.overlay': 'list',
  'sidebar': 'single',
  'sidebar.brand.mark': 'single',
  'sidebar.brand.name': 'single',
  'sidebar.footer.action': 'list',
  'sidebar.panellist': 'list',
  'sidebar.settings': 'single',
  'sidebar.toggle.badge': 'single',
  'sidebar.workspaces': 'single',
})

/** 宿主默认优先级（`options.priority ?? 0`，见 slots lib/index.js:167） */
export const DEFAULT_PRIORITY = 0

/** 四种槽位类型（slots lib/types/index.d.ts:83） */
export const SLOT_KIND = Object.freeze({
  SINGLE: 'single',
  LIST: 'list',
  KEYED: 'keyed',
  CHAIN: 'chain'
})

/**
 * 宿主插件**已经占据**的槽位（真机上宿主一定先加载）。
 *
 * 这是「我方注册会不会撞车」的判据来源，所以放在契约真源里（检查器与测试共用）。
 *
 * 出处（逐条核对过宿主源码，改宿主后必须复核）：
 *   · dsh-desktop-client-ui 往三个品牌槽位注册了一套（**未给 priority → 默认 0**）
 *     vendor/dsh-desktop-main/packages/dsh-desktop-client-ui/client.js:135-143
 *   · dsh-desktop-workbenches 往 settings.general.item 注册一行（id 固定）
 *     vendor/dsh-desktop-main/packages/dsh-desktop-workbenches/client.js:2035
 */
export const HOST_OCCUPIED_SLOTS = Object.freeze({
  'sidebar.brand.mark': [{ priority: 0, registrant: 'dsh-desktop-client-ui' }],
  'sidebar.brand.name': [{ priority: 0, registrant: 'dsh-desktop-client-ui' }],
  'conversation.hero.brand.mark': [{ priority: 0, registrant: 'dsh-desktop-client-ui' }],
  'settings.general.item': [
    { id: 'desktop-workbench-enable', order: 34, registrant: 'dsh-desktop-workbenches' }
  ]
})

/** 上面每个占据者的精确出处（供人工复核与文档引用） */
export const HOST_OCCUPANT_SOURCE = Object.freeze({
  'dsh-desktop-client-ui': 'vendor/dsh-desktop-main/packages/dsh-desktop-client-ui/client.js:135-143',
  'dsh-desktop-workbenches': 'vendor/dsh-desktop-main/packages/dsh-desktop-workbenches/client.js:2035'
})

/**
 * 检查一条待注册的槽位条目会不会与宿主撞车。
 *
 * @param {object} params
 * @param {string} params.name      槽位名
 * @param {number} [params.priority]
 * @param {string} [params.id]      list 槽位用
 * @param {string} [params.key]     keyed 槽位用
 * @returns {string|null} 撞车原因（可读）；不撞返回 null
 */
export function explainSlotConflictWithHost({ name, priority, id, key }) {
  const kind = SLOT_KINDS[name]
  if (!kind) return `槽位 ${name} 的 kind 未登记（不能猜 —— 第四次崩溃的教训）`
  return explainSlotConflict({ kind, priority, id, key, existing: HOST_OCCUPIED_SLOTS[name] ?? [] })
}

/**
 * 宿主 `register()` 的校验规则（逐字对齐 slots lib/index.js:163-190）。
 *
 * @param {object} params
 * @param {string} params.kind         槽位 kind（来自 SLOT_KINDS）
 * @param {number} [params.priority]   本次注册的优先级（缺省 0）
 * @param {string} [params.key]        keyed 槽位必填
 * @param {string} [params.id]         list 槽位必填
 * @param {Array}  params.existing     已有条目 [{priority, key, id, registrant}]
 * @returns {string|null} 违规原因（可读）；合法返回 null
 */
export function explainSlotConflict({ kind, priority, key, id, existing = [] }) {
  const p = priority ?? DEFAULT_PRIORITY

  if (kind === SLOT_KIND.SINGLE) {
    const occupant = existing.find((e) => (e.priority ?? DEFAULT_PRIORITY) === p)
    if (occupant) {
      const by = occupant.registrant !== undefined ? `（已由 ${occupant.registrant} 注册）` : ''
      return (
        `single 槽位在 priority=${p} 上已有占据者${by} → 宿主会抛 ` +
        `"single slot … already has a registration"。` +
        `修法：改用一个不同的 priority（数字**最小**的会渲染，见 getRenderingEntry）`
      )
    }
    return null
  }

  if (kind === SLOT_KIND.KEYED) {
    if (key === undefined) return 'keyed 槽位必须提供 key（宿主会抛 requires options.key）'
    const occupant = existing.find((e) => e.key === key && (e.priority ?? DEFAULT_PRIORITY) === p)
    if (occupant) return `keyed 槽位在 key="${key}" 且 priority=${p} 上已有占据者`
    return null
  }

  if (kind === SLOT_KIND.LIST) {
    if (id === undefined) return 'list 槽位必须提供 id（宿主会抛 requires options.id）'
    const occupant = existing.find((e) => e.id === id && (e.priority ?? DEFAULT_PRIORITY) === p)
    if (occupant) return `list 槽位在 id="${id}" 且 priority=${p} 上已有占据者`
    return null
  }

  if (kind === SLOT_KIND.CHAIN) {
    // chain 槽位不做遮蔽（选举消费全部条目），只需 select
    return null
  }

  // kind 未知 → **不猜**（这是第 3 次崩溃的教训：猜的规则等于没有规则）
  return `槽位 kind 未登记（SLOT_KINDS 里没有）→ 无法校验。请先补齐 kind 表再注册`
}

/**
 * 哪些条目最终会渲染（宿主 `entriesOfSlot` 的等价实现，lib/index.js:262-292）。
 *
 * 语义：按 priority 升序排序，**每格取第一个** → **数字最小的渲染**。
 *   · single：整个槽位算一格
 *   · keyed ：每个 key 一格
 *   · list  ：每个 id 一格（组内再按 order 排显示顺序）
 *
 * @param {string} kind
 * @param {Array} entries [{priority, key, id, order, component}]
 * @returns {Array} 每格胜出的条目
 */
export function getRenderingEntries(kind, entries) {
  const sorted = [...entries].sort((a, b) => {
    const dp = (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY)
    if (dp !== 0) return dp
    // list 槽位再按 order 排（宿主 L221）
    return kind === SLOT_KIND.LIST ? (a.order ?? 0) - (b.order ?? 0) : 0
  })

  if (kind === SLOT_KIND.CHAIN) return sorted

  const seen = new Set()
  const heads = []
  for (const entry of sorted) {
    const cell = kind === SLOT_KIND.KEYED ? entry.key : kind === SLOT_KIND.LIST ? entry.id : '__single__'
    if (seen.has(cell)) continue
    seen.add(cell)
    heads.push(entry)
  }
  return heads
}

/** 便捷：某一格最终由谁渲染 */
export function getRenderingEntry(kind, entries, cell) {
  const heads = getRenderingEntries(kind, entries)
  if (kind === SLOT_KIND.SINGLE) return heads[0]
  return heads.find((e) => (kind === SLOT_KIND.KEYED ? e.key : e.id) === cell)
}

/**
 * 行为等价于真宿主的槽位注册表。
 *
 * 与真宿主对齐的点：
 *   · 未声明的槽位 → 抛 `slot "…" is not declared`
 *   · single/keyed/list 的**同格同优先级**重复 → 抛 `already has a registration`
 *   · 错误文案与宿主逐字一致（便于在真日志里对照定位）
 *   · `ctx.effect` 的 disposer 会注销条目（宿主卸载级联）
 */
export function createSlotRegistry() {
  /** name → { kind, entries: [] } */
  const records = new Map()
  /** name → Set<factoryName>（谁声明了这个槽位） */
  const declaredBy = new Map()

  const api = {
    /** 声明槽位（等价宿主 children 表；测试里常用来预置宿主已声明的槽位） */
    declare(name, kind, factory = 'test-factory') {
      if (!records.has(name)) records.set(name, { kind, entries: [] })
      if (!declaredBy.has(name)) declaredBy.set(name, new Set())
      declaredBy.get(name).add(factory)
      return api
    },

    /** 等价宿主 `ctx.slots.register(options, component)` */
    register(options, component) {
      const rec = records.get(options.name)
      if (!rec) {
        throw new Error(
          `slot "${options.name}" is not declared (a parent entry's children table must declare it)`
        )
      }
      const priority = options.priority ?? DEFAULT_PRIORITY
      const occupantHint = (occupant) =>
        `at priority ${priority}${occupant.registrant !== undefined ? ` (registered by ${occupant.registrant})` : ''}` +
        ` — register at a different priority to shadow it (lowest renders)`

      if (rec.kind === SLOT_KIND.SINGLE) {
        const occupant = rec.entries.find((e) => (e.priority ?? DEFAULT_PRIORITY) === priority)
        if (occupant) {
          throw new Error(
            `single slot "${options.name}" already has a registration ${occupantHint(occupant)}`
          )
        }
      } else if (rec.kind === SLOT_KIND.KEYED) {
        if (options.key === undefined) throw new Error(`keyed slot "${options.name}" requires options.key`)
        const occupant = rec.entries.find(
          (e) => e.key === options.key && (e.priority ?? DEFAULT_PRIORITY) === priority
        )
        if (occupant) {
          throw new Error(
            `keyed slot "${options.name}" already has an entry for key "${options.key}" ${occupantHint(occupant)}`
          )
        }
      } else if (rec.kind === SLOT_KIND.LIST) {
        if (options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`)
        const occupant = rec.entries.find(
          (e) => e.id === options.id && (e.priority ?? DEFAULT_PRIORITY) === priority
        )
        if (occupant) {
          throw new Error(
            `list slot "${options.name}" already has an entry with id "${options.id}" ${occupantHint(occupant)}`
          )
        }
      } else if (rec.kind === SLOT_KIND.CHAIN) {
        if (options.select === undefined) throw new Error(`chain slot "${options.name}" requires options.select`)
      }

      const entry = {
        priority,
        key: options.key,
        id: options.id,
        order: options.order,
        registrant: options.registrant,
        component
      }
      rec.entries.push(entry)

      // 宿主的 disposer 会删掉这一条（卸载级联）
      return () => {
        const i = rec.entries.indexOf(entry)
        if (i !== -1) rec.entries.splice(i, 1)
      }
    },

    /** 某槽位的全部条目 */
    entries(name) {
      return records.get(name)?.entries ?? []
    },

    /** 某槽位最终渲染的条目（每格胜出者） */
    rendering(name) {
      const rec = records.get(name)
      if (!rec) return []
      return getRenderingEntries(rec.kind, rec.entries)
    },

    /** 调试用：槽位表快照 */
    snapshot() {
      const out = {}
      for (const [name, rec] of records) out[name] = { kind: rec.kind, count: rec.entries.length }
      return out
    }
  }

  return api
}
