/**
 * smoke 检测逻辑（**纯函数**，与 IO 解耦，便于单测）。
 *
 * 为什么把它抽出来（真实事故驱动，2026-10-15）：
 *   第二个 Windows 安装包启动即崩（插件路由重复注册 → apply() 抛错 →
 *   应用完全打不开），而 smoke **全绿**。根因之一：
 *   启动进程的输出被 `stdio: 'ignore'` 丢弃，失败信号根本进不了 smoke。
 *
 * 把检测逻辑做成纯函数有两个好处：
 *   ① 可以用**真实崩溃日志**当 fixture 做回归测试（本仓 test/unit/smoke-detect.test.mjs）
 *   ② 以后再出同类问题时，先问「检测器认不认这份日志」，而不是靠人肉看日志
 */

/** 首屏校验的关键词（必须出现在面板标识/日志中） */
export const FIRST_PANEL_MARKERS = ['xyb', 'xiaoyibao', '小胰宝']

/** 宿主 UI 泄漏的检测词（不应出现） */
export const HOST_UI_MARKERS = ['Workbench Market', '工作台市场', 'DSH Desktop 设置']

/**
 * 插件启动失败的**运行时信号**（启动输出里出现即判失败）。
 *
 * 每一条都对应真实日志里的原句（取自用户 Windows 实测日志）：
 *   `dsh: startup failed: 1 required plugin did not activate`
 *   `[harness-node] plugin failures: {"version":1,...}`
 *   `[desktop] Harness entry failed during startup; stopping immediately`
 *   `[harness-log] error include: ReferenceError: xxx is not defined`
 *   `Failed plugins (1):`
 */
export const PLUGIN_FAILURE_MARKERS = [
  'did not activate', // dsh: startup failed: 1 required plugin did not activate
  'startup failed', // 同上（更宽）
  'plugin failures:', // [harness-node] plugin failures: {...}
  'Harness entry failed', // [desktop] Harness entry failed during startup
  'error include:', // [harness-log] error include: <插件加载错>
  'Failed plugins (' // Failed plugins (1):
]

/**
 * 在启动输出文本里找插件失败信号。
 *
 * @param {string[]} texts 启动输出文本（stderr / stdout 都传进来）
 * @returns {{ok: boolean, hit: string|null, detail: string, excerpt: string}}
 *   `ok: true` 表示**没发现**失败信号。
 *   注意：文本为空时**判为通过**（不据此判失败）—— 捕获不到输出可能是
 *   平台差异，不能把「没捕到」当成「崩了」。
 */
export function detectPluginFailure(texts) {
  const nonEmpty = (texts || []).filter((t) => typeof t === 'string' && t.length > 0)

  for (const text of nonEmpty) {
    for (const marker of PLUGIN_FAILURE_MARKERS) {
      const idx = text.indexOf(marker)
      if (idx !== -1) {
        // 截上下文：便于直接看清「哪个插件、什么错」，不用再去翻原始日志
        const excerpt = text.slice(Math.max(0, idx - 120), idx + 400).trim()
        return {
          ok: false,
          hit: marker,
          detail: `启动输出里出现插件失败信号「${marker}」`,
          excerpt
        }
      }
    }
  }

  if (nonEmpty.length === 0) {
    return {
      ok: true,
      hit: null,
      detail: '启动输出为空（未捕获到）——不据此判失败',
      excerpt: ''
    }
  }
  return { ok: true, hit: null, detail: '未出现插件启动失败信号', excerpt: '' }
}

/**
 * 从文本判定首屏标识。
 *
 * @param {string|null} text 文本内容（null 表示文件不存在）
 * @param {'diagnostic'|'log'} strength 来源强度
 * @returns {{ok: boolean, strength: string, detail: string}}
 */
export function detectFirstPanelFromText(text, strength) {
  if (text === null || text === undefined) {
    return strength === 'diagnostic'
      ? { ok: false, strength: 'none', detail: '既无诊断文件也无日志，无法校验首屏' }
      : { ok: false, strength, detail: `未读到${strength === 'log' ? '日志' : '文本'}，无法校验首屏` }
  }
  const lower = text.toLowerCase()
  const hit = FIRST_PANEL_MARKERS.some((m) => lower.includes(m.toLowerCase()))
  if (hit) {
    return strength === 'diagnostic'
      ? { ok: true, strength: 'diagnostic', detail: '诊断文件确认首屏为小胰宝面板' }
      : { ok: true, strength: 'log', detail: '日志确认小胰宝面板已注册（降级校验）' }
  }
  return strength === 'diagnostic'
    ? {
        ok: false,
        strength: 'diagnostic',
        detail: `诊断文件内容未含小胰宝标识：${text.slice(0, 200)}`
      }
    : { ok: false, strength: 'log', detail: '日志中未见小胰宝面板注册记录' }
}

/**
 * 从文本检查宿主 UI 是否泄漏。
 *
 * @param {string[]} texts 待检查文本（诊断文件 + 日志）
 * @returns {{ok: boolean, detail: string}}
 */
export function detectHostUiLeak(texts) {
  for (const text of texts || []) {
    if (typeof text !== 'string' || !text) continue
    for (const marker of HOST_UI_MARKERS) {
      if (text.includes(marker)) {
        return { ok: false, detail: `宿主 UI 泄漏：出现「${marker}」` }
      }
    }
  }
  return { ok: true, detail: '未检测到宿主 UI 泄漏' }
}
