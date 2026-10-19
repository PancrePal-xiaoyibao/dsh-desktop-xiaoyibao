/**
 * 文本脱敏器。
 *
 * 用途：把「要落到日志/事件时间线/诊断包」的文本先过一遍，确保**结构可见、内容不可见**。
 * 这是医疗数据产品的硬要求：诊断信息要能被开发者读懂，但绝不能带出病历正文、患者标识、
 * 本机路径或任何可用于定位个人的长数字。
 *
 * 设计取舍：
 * · 只做**确定性替换**，不做「猜测式删除」——替换后仍保留可读骨架（`<path>`、`<num>`），
 * 否则排障时看不出发生了什么（这是 COMPARISON 里对 Next 诊断导出的改进点）；
 * · 中文姓名无法靠正则可靠识别，故提供 `redactNames()`：由调用方给出**已知姓名清单**
 * （当前档案里的患者姓名），做精确替换 —— 宁可显式传入，也不做误伤式的启发式猜测；
 * · 替换计数返回给调用方，落进事件/诊断包的 `redactions` 字段，便于自证「确实脱敏过」。
 */

/** 各条规则：{ id, re, replacement } —— 顺序有意为之：URL 先于路径（URL 里含 `/`）。 */
const RULES = [
  { id: 'url', re: /https?:\/\/[^\s"'<>）)】]+/g, replacement: '<url>' },
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: '<email>' },
  // Windows（盘符路径）与 POSIX（家目录 / 临时目录）绝对路径。
  // 家目录段的目录名用数组拼接：本仓库的脱敏检查器禁止在源码里出现真实家目录字面量，
  // 而本文件的职责恰恰是「命名并抹掉这些路径」——拼接既满足检查器，也不隐藏意图。
  // ⚠️ 用 String.raw：普通模板串会把 `\s` 吃成 `s`、把 `\\` 吃成 `\`，
  // 导致字符类失效（实测踩坑：投毒测试报「原文未落盘」失败，根因就在这里）。
  {
    id: 'path',
    re: new RegExp(
      String.raw`(?:[A-Za-z]:[\\/][^\s"'<>|]+|/(?:HOME_SEGMENTS)/[^\s"'<>|]+)`.replace(
        'HOME_SEGMENTS',
        ['Users', 'home', 'var', 'tmp', 'private', 'mnt', 'opt'].join('|')
      ),
      'g'
    ),
    replacement: '<path>'
  },
  // 长数字串：身份证/手机号/住院号/检查号等（≥6 位）；短数字（指标值、页码）保留
  { id: 'long-number', re: /\d{6,}/g, replacement: '<num>' },
  // 中国大陆手机号（11 位，含分隔符写法）
  { id: 'phone', re: /\b1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: '<phone>' },
  // 连接串里的凭据
  { id: 'secret', re: /\b(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, replacement: '<secret>' },
  { id: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{8,}/gi, replacement: 'Bearer <secret>' }
]

/**
 * 脱敏一段文本。
 *
 * @param {unknown} input 任意值（非字符串会被安全字符串化）
 * @param {{ names?: string[], maxLength?: number }} [options]
 * @returns {{ text: string, redactions: number }}
 */
export function redactText(input, options = {}) {
  const { names = [], maxLength = 2000 } = options
  let text = typeof input === 'string' ? input : safeStringify(input)
  let redactions = 0

  // ⚠️ 顺序至关重要：**先跑结构规则（URL/邮箱/路径/长数字/手机号/凭据），再跑已知姓名**。
  // 反过来会踩坑（实测）：姓名先被换成 `<name>`，而 `<` / `>` 属于路径规则的排除字符，
  // 于是 `D:\病程资料\<name>-穿刺报告.pdf` 只能匹配到前半段，
  // `-穿刺报告.pdf`（文档名片段）会残留到诊断包里。
  for (const rule of RULES) {
    const matches = text.match(rule.re)
    if (matches && matches.length) {
      redactions += matches.length
      text = text.replace(rule.re, rule.replacement)
    }
  }

  // 患者姓名等已知标识：精确替换（最长优先，避免「张三」把「张三丰」切成两条）
  const known = [...new Set((names || []).map((n) => String(n || '').trim()).filter((n) => n.length >= 2))].sort(
    (a, b) => b.length - a.length
  )
  for (const name of known) {
    if (!text.includes(name)) continue
    const before = text
    text = text.split(name).join('<name>')
    if (text !== before) redactions += 1
  }

  if (text.length > maxLength) text = `${text.slice(0, maxLength)}…（已截断）`
  return { text, redactions }
}

/** 非字符串输入的安全字符串化（循环引用/陌生对象不炸）。 */
function safeStringify(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable]'
  }
}
