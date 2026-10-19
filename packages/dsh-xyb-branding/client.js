/**
 * dsh-xyb-branding — 小胰宝社区版品牌层（客户端）
 *
 * 形态遵循宿主工作台插件契约（见 vendor/dsh-desktop-main/docs/workbench-standard.zh.md §3.5）：
 * - window.__ModuleLoader__.load({ id, factory })
 * - 依赖一律从 factory(require) 取，不写 import（否则加载失败）
 * - 不引入独立 React（会出现双实例导致 hooks 报错）
 *
 * 本文件只做两件事：
 * 1) 向侧栏注入「双 logo」——DSH 大肥鱼标记 + 社区小胰宝标记
 * 2) 向侧栏注入产品名「小胰宝社区版」
 *
 * 品牌合规：
 * - DSH 标记来自上游品牌资产（vendor/dsh-desktop-main/build/brand-mark.svg）
 * - 版权信息与「社区发行版，非官方产品」标注在关于页，由本插件注入
 */
window.__ModuleLoader__.load({
  id: 'dsh-xyb-branding',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    // ─────────────────────────────── 品牌资产
    // DSH 大肥鱼标记：取自上游 build/brand-mark.svg 的 path（viewBox 0 0 1000 1000）
    const DSH_MARK_VIEWBOX = '0 0 1000 1000'
    const DSH_MARK_PATH =
      'M478.318 218C605.318 218 683.318 287 687.318 404L691.318 472C693.318 525 697.319 556 726.318 574C746.318 587 774.318 585 790.318 562C799.318 550 802.318 539 792.318 534C747.319 513 727.318 472 738.318 428C739.652 420 742.652 418.667 747.318 424C774.318 450 815.318 460 831.318 501C855.318 457 898.318 456 930.318 436C936.318 431.333 939.318 433.333 939.318 442C938.318 496 903.318 535 850.318 547C841.318 570 833.318 592 819.318 622C773.318 723 661.318 782 491.318 782H294.318C161.319 782 74.3183 714 53.3184 592C41.3184 526 38.3184 433 50.3184 375C70.3184 277 113.82 218 234.32 218H478.318ZM571.82 350.5C469.82 333.5 277.82 329.5 164.82 350.5C138.82 355.5 114.318 379 110.318 404C100.318 451 102.318 551 124.318 596C155.318 660 214.319 697 315.318 705C324.318 678 346.319 662 376.318 662C404.318 662 427.318 678 435.318 705C493.318 699 526.318 680 562.318 652C621.318 606 633.749 527.103 633.749 424C633.749 385.144 604.82 355.5 571.82 350.5ZM179.32 264C167.722 264 158.32 273.402 158.32 285C158.32 296.598 167.722 306 179.32 306C190.918 306 200.32 296.598 200.32 285C200.32 273.402 190.918 264 179.32 264ZM245.551 264C233.953 264 224.551 273.402 224.551 285C224.551 296.598 233.953 306 245.551 306C257.149 306 266.551 296.598 266.551 285C266.551 273.402 257.149 264 245.551 264ZM311.782 264C300.184 264 290.782 273.402 290.782 285C290.782 296.598 300.184 306 311.782 306C323.38 306 332.782 296.598 332.782 285C332.782 273.402 323.38 264 311.782 264Z'

    // 社区小胰宝标记：从原型 docs/prototype-v2.html 提取的 PNG（内联为 data URI，避免额外资源加载）
    const COMMUNITY_URL = 'https://github.com/PancrePal-xiaoyibao'

    const XYB_MARK_DATA_URI =
      'data:image/webp;base64,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'

    const PRODUCT_NAME = '小胰宝社区版'
    const PRODUCT_NAME_EN = 'XiaoYiBao Community'
    const COMMUNITY_NOTICE = '社区发行版，非官方产品'
    const UPSTREAM_NAME = 'DSH Desktop'
    const UPSTREAM_LICENSE = 'MIT License · Copyright (c) 2026 DataElement'

    // ─────────────────────────────── 品牌标记组件
    /** DSH 大肥鱼标记（上游品牌资产，内联 SVG） */
    function DshMark({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: DSH_MARK_VIEWBOX,
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false'
        },
        h('path', { d: DSH_MARK_PATH, fill: 'currentColor' })
      )
    }

    /** 社区小胰宝标记（吉祥物实图：竖构图 110×144，按高度定尺） */
    function XybMark({ size = 16 }) {
      return h('img', {
        src: XYB_MARK_DATA_URI,
        alt: '',
        'aria-hidden': 'true',
        draggable: false,
        style: { display: 'block', height: size, width: 'auto' }
      })
    }

    /**
     * 双 logo 组合：DSH 大肥鱼 + 社区小胰宝。
     * 两者之间用一条细分隔线，避免被读成「一个双头标志」。
     */
    function DualBrandMark() {
      return h(
        'span',
        {
          className: 'xybBrandMark',
          style: { display: 'inline-flex', alignItems: 'center', gap: 6 }
        },
        h(DshMark, { size: 16 }),
        h('span', {
          style: {
            display: 'inline-block',
            width: 1,
            height: 14,
            background: 'currentColor',
            opacity: 0.25
          },
          'aria-hidden': 'true'
        }),
        h(XybMark, { size: 16 })
      )
    }

    /** 产品名：小胰宝社区版（附无障碍全称） */
    function ProductBrandName() {
      return h(
        'span',
        {
          className: 'xybBrandName',
          title: `${PRODUCT_NAME} — ${PRODUCT_NAME_EN} · ${COMMUNITY_NOTICE}`
        },
        PRODUCT_NAME
      )
    }

    /**
     * 对话区品牌标记：只保留小胰宝（对话发生在小胰宝语境里），并链回社区主页。
     *
     * 外链走标准 <a href>：宿主 src/main/security.ts 的 setWindowOpenHandler /
     * will-navigate 会把 http(s) 链接交给系统浏览器（shell.openExternal），
     * 不需要也不得自造 IPC。
     */
    function ConversationBrandMark() {
      return h(
        'a',
        {
          href: COMMUNITY_URL,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: '小胰宝社区（GitHub）',
          style: { display: 'inline-flex', alignItems: 'center' }
        },
        h(XybMark, { size: 22 })
      )
    }

    // ─────────────────────────────── 插件入口

    /**
     * 品牌槽位注册优先级 —— **必须是负数**。
     *
     * 真实事故（2026-10-16，第四个安装包）：宿主 `dsh-desktop-client-ui`
     * 已往 `sidebar.brand.mark` / `sidebar.brand.name` /
     * `conversation.hero.brand.mark` 三个槽位注册了自己的一套（默认优先级 0），
     * 而这三个槽位的 kind 是 **single**（只能一个占据者）。
     * 我也用 0 注册 → 直接抛错 → **客户端插件全部加载失败**，界面打不开。
     *
     * 规则真源：// dsh-client-ui-slots@0.2.0-rc.2 lib/index.js:167-172
     * const priority = options.priority ?? 0;
     * case "single": {
     * const occupant = rec.entries.find((e) => (e.options.priority ?? 0) === priority);
     * if (occupant) throw new Error(`single slot "${name}" already has a registration …`)
     * }
     *
     * 遮蔽语义（同文件 L221 升序排序 + entriesOfSlot 取每格首个）：
     * **priority 数字最小的渲染** → 给 −1 就能遮掉宿主的 0，且不报冲突。
     */
    const BRAND_PRIORITY = -1

    function apply(ctx) {
      // 侧栏品牌标记：放入双 logo（遮掉宿主的单 logo）
      //
      // ⚠️ `priority: BRAND_PRIORITY` 是**必需的**（真实事故，2026-10-16，第四个安装包）
      // 宿主 `dsh-desktop-client-ui` 已往下面三个品牌槽位注册了自己的一套（DSH logo，
      // 默认优先级 0），而这三个槽位的 kind 是 **single**（只能一个占据者）：
      //
      // // dsh-client-ui-slots@0.2.0-rc.2 lib/index.js:167-172
      // const priority = options.priority ?? 0;
      // case "single": {
      // const occupant = rec.entries.find((e) => (e.options.priority ?? 0) === priority);
      // if (occupant) throw new Error(`single slot "${name}" already has a registration …`)
      // }
      //
      // 同样用 0 注册 → 直接抛错 → **客户端插件全部加载失败**，界面打不开：
      // [renderer] Error: single slot "sidebar.brand.mark" already has a registration
      // at priority 0 (registered by mf) — register at a different priority to shadow it
      // [renderer] Failed to load plugins
      //
      // 遮蔽语义（同文件 L221 排序 + entriesOfSlot 取每格首个）：按 priority **升序**，
      // **数字最小的渲染**。所以给 −1 就能遮掉宿主的 0，且不报冲突。
      //
      // 槽位 kind 与优先级规则的真源：`scripts/lib/slot-contract-rules.mjs`
      ctx.slots.inject('sidebar.brand.mark', () => {
        ctx.slots.register({ name: 'sidebar.brand.mark', priority: BRAND_PRIORITY }, DualBrandMark)
      })

      // 侧栏品牌名：放入产品名（同样需要 priority 遮掉宿主）
      ctx.slots.inject('sidebar.brand.name', () => {
        ctx.slots.register({ name: 'sidebar.brand.name', priority: BRAND_PRIORITY }, ProductBrandName)
      })

      // 对话区品牌标记：放小胰宝标记（同样需要 priority 遮掉宿主）
      ctx.slots.inject('conversation.hero.brand.mark', () => {
        ctx.slots.register(
          { name: 'conversation.hero.brand.mark', priority: BRAND_PRIORITY },
          ConversationBrandMark
        )
      })
    }

    return {
      apply,
      inject: ['slots'],
      // 导出给测试与关于页复用（不参与宿主注册协议）
      _branding: {
        PRODUCT_NAME,
        PRODUCT_NAME_EN,
        COMMUNITY_NOTICE,
        UPSTREAM_NAME,
        UPSTREAM_LICENSE,
        DshMark,
        XybMark,
        DualBrandMark,
        ProductBrandName,
        ConversationBrandMark
      }
    }
  }
})
