/**
 * dsh-xyb-qingnang — 青囊能力包嵌入（客户端）
 *
 * 形态遵循宿主工作台插件契约：`__ModuleLoader__.load` + `factory(require)`，
 * 零 import、零 JSX、无构建步骤。
 *
 * 本文件只做一件事：把青囊的**能力来源与通道状态**呈现给用户。
 * 不做检索本身（检索由 MCP 通道在 agent 侧完成）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-xyb-qingnang',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API_BASE = '/api/xyb/qingnang'

    // ─────────────────────────────── 样式
    const STYLE_ID = 'xyb-qingnang-style'
    const CSS = `
      .qnRoot { font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
                color:#1B3A34; font-size:13px; line-height:1.65; }
      .qnRow { display:flex; align-items:center; gap:10px; padding:9px 12px; border:1px solid #D7E5E0;
               border-radius:9px; background:#fff; margin-bottom:7px; }
      .qnMark { font-size:14px; flex:none; width:18px; text-align:center; }
      .qnName { font-weight:600; min-width:120px; }
      .qnMeta { flex:1; color:#5A6E68; font-size:12px; }
      .qnBadge { font-size:11.5px; padding:2px 8px; border-radius:999px; border:1px solid; white-space:nowrap; }
      .qnBadge.enabled { color:#2E7D5B; background:#E8F5EE; border-color:#9CCFB4; }
      .qnBadge.credential-missing { color:#655472; background:#F1F0F6; border-color:#C4BBD2; }
      .qnBadge.failed { color:#C0392B; background:#FCEBE8; border-color:#E8AFA6; }
      .qnBadge.checking { color:#B8860B; background:#FFF6DC; border-color:#E4CE8A; }
      .qnBadge.not-registered { color:#5A6E68; background:#F8FAF8; border-color:#D7E5E0; }
      .qnSec { margin:16px 0 8px; font-size:12px; font-weight:600; color:#5A6E68; letter-spacing:.02em; }
      .qnNote { padding:10px 12px; background:#F8FAF8; border-left:3px solid #95D0C7;
                border-radius:0 8px 8px 0; font-size:12.5px; color:#5A6E68; margin-bottom:10px; }
      .qnWarn { padding:10px 12px; background:#FFF6DC; border:1px solid #E4CE8A; border-radius:9px;
                color:#B8860B; font-size:12.5px; margin-bottom:10px; }
      .qnErr { padding:10px 12px; background:#FCEBE8; border:1px solid #E8AFA6; border-radius:9px;
               color:#C0392B; font-size:12.5px; margin-bottom:10px; }
      .qnBtn { height:30px; padding:0 12px; border-radius:8px; border:1px solid #0F7C72;
               background:#0F7C72; color:#fff; font:inherit; font-size:12.5px; cursor:pointer; }
      .qnBtn:disabled { opacity:.5; cursor:default; }
      .qnBtnGhost { background:#fff; color:#0F7C72; }
      .qnActions { display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; }
      .qnAttr { font-size:11.5px; color:#5A6E68; margin-top:16px; padding-top:12px;
                border-top:1px solid #D7E5E0; line-height:1.8; }
      .qnAttr code { background:#F2F8F6; padding:1px 5px; border-radius:4px; font-size:11px; }
      .qnEmpty { padding:24px 16px; text-align:center; color:#5A6E68; }
      .qnEmpty strong { display:block; color:#1B3A34; font-size:14px; margin-bottom:6px; }
    `

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function api(path, options) {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options
      })
      return res.json()
    }

    const STATUS_BADGE = {
      enabled: '已启用',
      'credential-missing': '未配凭据',
      failed: '失败',
      checking: '检测中',
      'not-registered': '未注册'
    }

    /** 单条通道行 */
    function ChannelRow({ channel }) {
      return h(
        'div',
        { className: 'qnRow' },
        h('span', { className: 'qnMark', 'aria-hidden': 'true' }, channel.statusMark || ''),
        h('span', { className: 'qnName' }, channel.displayName),
        h(
          'span',
          { className: 'qnMeta' },
          channel.license ? `${channel.license}` : '',
          channel.degradeTo ? ` · 缺凭据时降级到 ${channel.degradeTo}` : '',
          channel.degradeNote ? ` · ${channel.degradeNote}` : ''
        ),
        h('span', { className: `qnBadge ${channel.status}` }, STATUS_BADGE[channel.status] || channel.status)
      )
    }

    /**
     * 青囊能力面板。
     * 可独立使用，也可被设置页嵌入。
     */
    function QingnangPanel({ service }) {
      React.useLayoutEffect(ensureStyles)
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null, busy: false })

      const load = React.useCallback(() => {
        setState((s) => ({ ...s, status: 'loading', error: null }))
        api('/status')
          .then((data) => setState({ status: 'ready', data, error: null, busy: false }))
          .catch((error) => setState({ status: 'error', data: null, error: error.message, busy: false }))
      }, [])

      React.useEffect(load, [load])

      const runDoctor = () => {
        setState((s) => ({ ...s, busy: true }))
        api('/doctor', { method: 'POST' })
          .then(() => load())
          .catch((error) => setState((s) => ({ ...s, busy: false, error: error.message })))
      }

      const runProbe = () => {
        setState((s) => ({ ...s, busy: true }))
        api('/probe', { method: 'POST' })
          .then(() => load())
          .catch((error) => setState((s) => ({ ...s, busy: false, error: error.message })))
      }

      if (state.status === 'loading') return h('div', { className: 'qnRoot qnEmpty' }, '正在读取青囊状态…')

      const data = state.data || {}
      const channels = data.channels || []
      const attribution = data.attribution || {}

      // 快照缺失：明确告知（不假装有）
      if (data.snapshotOk === false) {
        return h(
          'div',
          { className: 'qnRoot' },
          h('div', { className: 'qnWarn' }, `青囊能力包未就绪（${data.snapshotReason || '未安装'}）。医学检索能力当前不可用，其余功能不受影响。`),
          h(
            'div',
            { className: 'qnAttr' },
            '青囊是独立维护的医学能力包（Apache-2.0）。社区版会随包分发，若此处报未就绪，通常说明打包时未包含青囊资产。'
          )
        )
      }

      const enabled = channels.filter((c) => c.status === 'enabled').length
      const credentialMissing = channels.filter((c) => c.status === 'credential-missing').length
      const failed = channels.filter((c) => c.status === 'failed').length

      return h(
        'div',
        { className: 'qnRoot' },
        state.error ? h('div', { className: 'qnErr' }, state.error) : null,

        h(
          'div',
          { className: 'qnNote' },
          `青囊提供医学检索能力：文献、临床试验、指南与网页。共 ${channels.length} 条通道，` +
            `已启用 ${enabled} 条` +
            (credentialMissing ? `，未配凭据 ${credentialMissing} 条` : '') +
            (failed ? `，失败 ${failed} 条` : '') +
            '。'
        ),

        h('div', { className: 'qnSec' }, '通道状态'),
        channels.length
          ? channels.map((c) => h(ChannelRow, { key: c.id, channel: c }))
          : h('div', { className: 'qnNote' }, '尚未检测到通道。可能是青囊资产未包含在安装包内。'),

        h('div', { className: 'qnSec' }, '技能与画像'),
        h(
          'div',
          { className: 'qnRow' },
          h('span', { className: 'qnMark', 'aria-hidden': 'true' }, data.skills && !data.skills.error ? '✅' : '❌'),
          h('span', { className: 'qnName' }, '青囊技能'),
          h(
            'span',
            { className: 'qnMeta' },
            data.skills && !data.skills.error
              ? `已装载 ${(data.skills.installed || []).length} 个（含病历脱敏）`
              : `未装载${data.skills && data.skills.error ? `（${data.skills.error}）` : ''}`
          )
        ),
        h(
          'div',
          { className: 'qnRow' },
          h('span', { className: 'qnMark', 'aria-hidden': 'true' }, data.profile && !data.profile.error ? '✅' : '⚠️'),
          h('span', { className: 'qnName' }, '本机画像'),
          h(
            'span',
            { className: 'qnMeta' },
            data.profile && !data.profile.error
              ? data.profile.proxy
                ? `已生成 · 建议代理 ${data.profile.proxy}`
                : '已生成 · 未检测到代理'
              : '未生成（搜索失败时建议重新生成）'
          )
        ),

        h(
          'div',
          { className: 'qnActions' },
          h('button', { type: 'button', className: 'qnBtn', disabled: state.busy, onClick: runDoctor }, state.busy ? '检测中…' : '重新体检'),
          h('button', { type: 'button', className: 'qnBtn qnBtnGhost', disabled: state.busy, onClick: runProbe }, '重新生成本机画像'),
          h('button', { type: 'button', className: 'qnBtn qnBtnGhost', onClick: load }, '刷新')
        ),

        h(
          'div',
          { className: 'qnAttr' },
          h('div', null, `青囊（QingNang）· ${attribution.packVersion ? `v${attribution.packVersion}` : '版本未知'} · ${attribution.license || 'Apache-2.0'}`),
          h('div', null, h('a', { href: attribution.source || 'https://github.com/PancrePal-xiaoyibao/QingNang', target: '_blank', rel: 'noopener noreferrer' }, '青囊开源仓库')),
          attribution.skillCount ? h('div', null, `内嵌 ${attribution.skillCount} 个上游技能（各自许可随安装包提供）`) : null,
          h('div', { style: { marginTop: 8 } }, '本版为社区发行版，非 DeepSeek 官方产品。')
        )
      )
    }

    function apply(ctx) {
      // 桥：把视图交给同发行版内的其他插件复用（宿主设置面板已被本发行版接管，
      // slot 注入不再有落点）；只暴露组件，不暴露内部状态。
      try {
        if (typeof window !== "undefined") window.__xybQingnang = { QingnangPanel, ChannelRow }
      } catch {
        /* 非浏览器环境（测试沙箱）忽略 */
      }
      // 注册到设置页（若宿主提供该 slot）；不注册也能被小胰宝界面内的入口使用
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          { name: 'settings.general.item', id: 'xyb-qingnang-status', order: 90 },
          QingnangPanel
        )
      )
    }

    return {
      apply,
      inject: ['slots'],
      _views: { QingnangPanel, ChannelRow }
    }
  }
})
