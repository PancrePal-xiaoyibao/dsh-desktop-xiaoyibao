#!/usr/bin/env node
/**
 * 插件完整性静态分析器。**专门抓「语法合法但运行时必炸」的 bug**。
 *
 * 为什么需要它（真实事故，2026-10-15）：
 *   Windows 安装包启动即崩，报 `readSettings is not defined`。
 *   根因：`export const __internals = { readSettings }` ——
 *   `readSettings` 定义在 `apply()` 的闭包内，模块级引用直接抛 ReferenceError
 *   → 插件加载失败 → **整个应用打不开**。
 *
 *   现有工具为什么没抓到：
 *     · `node --check` 只查语法，查不出「模块级引用了闭包变量」
 *     · 单元测试只 import `lib/` 下的纯函数，不 import 插件入口
 *     · CI 的 smoke 只验「装了、启动了」，不验 Harness 里插件真的激活
 *     · 同类问题还有：重复 `export const inject`（同样语法合法但加载即崩）
 *
 * 本脚本覆盖的检查类别（每类都对应真实或高度可能的故障）：
 *   A. 模块级闭包引用 —— export 的对象里引用了非模块级标识符
 *   B. 重复顶层声明 —— 同文件同名 export 声明两次
 *   C. 服务端入口契约 —— apply 是函数、inject 是非空数组、各只声明一次
 *   D. 客户端入口契约 —— 零 import、零 JSX、有 ModuleLoader、factory 存在
 *   E. 客户端 React API —— 用到的 React.xxx 必须真实存在
 *   F. 客户端 inject 与 ctx 用法一致 —— 用了 ctx.slots 就必须 inject slots
 *   G. patch.yml ↔ package.json —— name 一致、id 唯一、必填字段齐
 *   H. lib 模块可 import —— 每个 lib/*.js 能被真实 import
 *   I. 路由注册合法性 —— ① 路径能过宿主 assertFetchRoute 吗（冒号等非法字符）
 *                        ② 同一 path 不得声明两次（宿主按 path 主键，重复即抛）
 *   J. 客户端槽位合法性 —— 注册会不会撞上宿主已占的槽位（第四次崩溃）
 *
 * ── I 类对应的真实事故（2026-10-15，第二个 Windows 安装包）────────────────
 *   `route('/settings','GET',…)` 与 `route('/settings','POST',…)` 各调一次
 *   `ctx.connection.fetch.register({path:'/api/xyb/settings', …})`
 *   → 宿主报 `exact Fetch route "/api/xyb/settings" is already registered`
 *   → 插件 apply() 失败 → 「required plugin did not activate」→ **应用打不开**。
 *   上游权威写法：同一 path 的多个 method 写在**一次** register 的 methods 数组里
 *   （见 packages/dsh-desktop-preset-transfer：methods: ['GET','HEAD']）。
 *   危害路径共 5 个：/settings、/patients、/patients/:id、
 *                   /patients/:id/records、/patients/:id/medications
 *
 * 退出码：0 通过 / 1 有问题 / 2 脚本错误
 *
 * 用法：
 *   node scripts/check-plugin-integrity.mjs
 *   node scripts/check-plugin-integrity.mjs --json
 */
import { promises as fs } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 宿主契约规则（逐字抄自 @deepseek-ai/dsh-client-connection@0.2.0-rc.2）
import { explainRoutePath } from './lib/host-contract-rules.mjs'
import { SLOT_KINDS, explainSlotConflictWithHost } from './lib/slot-contract-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..'))
const PACKAGES = join(REPO_ROOT, 'packages')

/** 青囊快照是第三方代码，不分析（其「失败」是上游实现细节，不是我们的 bug） */
const SKIP_PATH_PREFIXES = ['packages/dsh-xyb-qingnang/vendor/']

/** React 的真实 API（用于 E 类检查） */
const REACT_API = new Set([
  'createElement', 'useState', 'useEffect', 'useLayoutEffect', 'useCallback', 'useMemo',
  'useRef', 'useContext', 'useReducer', 'useSyncExternalStore', 'useId', 'useTransition',
  'useDeferredValue', 'useImperativeHandle', 'useDebugValue', 'useInsertionEffect',
  'Fragment', 'StrictMode', 'Suspense', 'Component', 'PureComponent', 'createContext',
  'forwardRef', 'memo', 'lazy', 'cloneElement', 'Children', 'isValidElement'
])

const problems = []
const push = (category, file, message) => problems.push({ category, file, message })

// ─────────────────────────────────────────── 工具

/**
 * 抽取模块级数字常量：`const NAME = -1` / `const NAME = 2`
 *
 * ⚠️ 为什么必须有（实测踩坑）：检查器一开始只认 `priority: -1` 这种**字面量**，
 *    而我把品牌层写成 `priority: BRAND_PRIORITY`（有名字更可读）→
 *    检查器当成「没写 priority」→ 报默认 0 冲突 → **假阳性**。
 *    而假阳性的检查器没人会信（同 §5.4.8：检查器必须自证无误报）。
 *
 * @returns {Map<string, number>} 常量名 → 数值
 */
function collectNumericConstants(source) {
  const out = new Map()
  for (const m of source.matchAll(/^\s*const\s+([A-Z][A-Z0-9_]*)\s*=\s*(-?\d+)\b/gm)) {
    out.set(m[1], Number(m[2]))
  }
  return out
}

/** 把 `priority` 的表达式解析成数值：支持字面量与模块级数字常量 */
function resolvePriority(expr, constants) {
  if (expr === undefined) return undefined
  const raw = expr.trim()
  if (/^-?\d+$/.test(raw)) return Number(raw)
  // 字面负数带括号：(-1)
  const paren = raw.match(/^\(\s*(-?\d+)\s*\)$/)
  if (paren) return Number(paren[1])
  if (constants.has(raw)) return constants.get(raw)
  return undefined // 解析不了 → 交给调用方按「未知」处理
}

/** 源码下标 → 行号 */
const lineOf = (source, index) => source.slice(0, index).split('\n').length

async function readIfExists(path) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function listFiles(dir, filter, acc = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    const rel = relative(REPO_ROOT, full).replace(/\\/g, '/')
    if (SKIP_PATH_PREFIXES.some((p) => `${rel}/`.startsWith(p))) continue
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      await listFiles(full, filter, acc)
    } else if (entry.isFile() && filter(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

/**
 * 提取模块级声明的标识符集合。
 *
 * 判据：行首（无缩进）的 export/function/const/let/var/class/import 声明。
 * 缩进的行属于函数体/对象字面量内部，不算模块级。
 */
function collectModuleLevelSymbols(source) {
  const symbols = new Set()
  const lines = source.split('\n')

  for (const line of lines) {
    // 只认行首无缩进（模块级）
    if (/^\s/.test(line)) continue

    // import { a, b as c } from '...' / import x from '...'
    const imp = line.match(/^import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]/)
    if (imp) {
      if (imp[1]) symbols.add(imp[1])
      if (imp[2]) {
        for (const part of imp[2].split(',')) {
          const name = part.trim().split(/\s+as\s+/).pop().trim()
          if (name) symbols.add(name)
        }
      }
      continue
    }
    if (/^import\s+['"]/.test(line)) continue

    // function / async function / class
    const fn = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
    if (fn) symbols.add(fn[1])
    const cls = line.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/)
    if (cls) symbols.add(cls[1])

    // const/let/var（含 export）
    const decl = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/)
    if (decl) symbols.add(decl[1])

    // 多变量声明 const a = 1, b = 2
    const multi = line.match(/^(?:export\s+)?(?:const|let|var)\s+\{([^}]*)\}\s*=/)
    if (multi) {
      for (const part of multi[1].split(',')) {
        const name = part.trim().split(':').pop().trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) symbols.add(name)
      }
    }
  }

  // 内置全局（模块级对象里可能引用它们，属正常）
  for (const g of [
    'process', 'console', 'URL', 'URLSearchParams', 'Buffer', 'Response', 'Request', 'Headers',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Promise', 'JSON', 'Math',
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Error', 'Map', 'Set',
    'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'Infinity', 'NaN', 'undefined', 'globalThis',
    'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'structuredClone',
    'queueMicrotask', 'fetch', 'crypto', 'performance', 'atob', 'btoa', 'Intl', 'Reflect', 'Proxy'
  ]) {
    symbols.add(g)
  }

  return symbols
}

/** 找重复的顶层 export 声明 */
function findDuplicateExports(source) {
  const seen = new Map()
  const dups = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s/.test(line)) continue
    const m = line.match(/^export\s+(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/)
    if (!m) continue
    const name = m[1]
    if (seen.has(name)) {
      dups.push({ name, first: seen.get(name) + 1, second: i + 1 })
    } else {
      seen.set(name, i)
    }
  }
  return dups
}

/**
 * 找 `export const X = { a, b }` 里引用了非模块级标识符的情况（**本次事故的精确模式**）。
 *
 * 只检查「纯标识符简写」形式（`{ readSettings }`），
 * `{ a: undefined }` / `{ a: 1 }` 这类字面量不解析标识符，跳过。
 */
function findClosureRefsInExports(source, moduleSymbols) {
  const hits = []
  const re = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^}]*)\}/gm
  let m
  while ((m = re.exec(source)) !== null) {
    const exportName = m[1]
    const body = m[2]
    const line = source.slice(0, m.index).split('\n').length

    for (const raw of body.split(',')) {
      const item = raw.trim()
      if (!item) continue
      // 跳过 `key: value` 形式（值可能是字面量，不解析）
      if (item.includes(':')) continue
      // 纯标识符简写 → 必须在模块级可见
      if (!/^[A-Za-z_$][\w$]*$/.test(item)) continue
      if (!moduleSymbols.has(item)) {
        hits.push({ exportName, symbol: item, line })
      }
    }
  }
  return hits
}

// ─────────────────────────────────────────── A/B/C 服务端检查

async function checkServerEntries(files) {
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
    const source = await readIfExists(file)
    if (!source) continue

    const moduleSymbols = collectModuleLevelSymbols(source)

    // A. 模块级闭包引用
    for (const hit of findClosureRefsInExports(source, moduleSymbols)) {
      push(
        'A-闭包引用',
        `${rel}:${hit.line}`,
        `export const ${hit.exportName} 引用了 "${hit.symbol}"，但它不在模块级作用域` +
          `（若定义在 apply() 闭包内，import 会抛 ReferenceError → 插件加载失败 → 应用打不开）`
      )
    }

    // B. 重复顶层声明
    for (const dup of findDuplicateExports(source)) {
      push(
        'B-重复声明',
        `${rel}:${dup.second}`,
        `"${dup.name}" 被重复 export（第 ${dup.first} 行已声明）→ 语法错误 → 加载即崩`
      )
    }

    // C. 服务端入口契约（仅 index.js）
    if (rel.endsWith('/index.js') && rel.startsWith('packages/')) {
      const applyCount = (source.match(/^export\s+(?:async\s+)?function\s+apply\b/gm) || []).length
      const injectCount = (source.match(/^export\s+const\s+inject\b/gm) || []).length

      if (applyCount !== 1) {
        push('C-入口契约', rel, `apply 必须恰好导出一次（实际 ${applyCount} 次）`)
      }
      if (injectCount !== 1) {
        push('C-入口契约', rel, `inject 必须恰好导出一次（实际 ${injectCount} 次）`)
      }

      // inject 为空是**合法**的（上游 dsh-desktop-market-installer 就是 []）。
      // 但若服务端 apply 里真的用了 ctx.xxx，就必须在 inject 里声明，
      // 否则宿主不注入该服务 → 运行时 undefined。
      const injectArr = source.match(/^export\s+const\s+inject\s*=\s*\[([^\]]*)\]/m)
      const declared = injectArr
        ? injectArr[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
        : []

      // 只看 apply 函数体（从 apply 定义到下一个顶层 export）
      const applyStart = source.search(/^export\s+(?:async\s+)?function\s+apply\b/m)
      if (applyStart !== -1) {
        const afterApply = source.slice(applyStart)
        const nextTopLevel = afterApply.slice(1).search(/^export\s/m)
        const applyBody = nextTopLevel === -1 ? afterApply : afterApply.slice(0, nextTopLevel + 1)

        const usedServices = new Set()
        for (const m of applyBody.matchAll(/ctx\.([a-zA-Z_$][\w$]*)/g)) {
          const svc = m[1]
          // 框架自带的 ctx 方法/属性，不需要 inject
          if (['effect', 'logger', 'reflect', 'inject', 'on', 'get', 'set', 'provide', 'scope'].includes(svc)) continue
          usedServices.add(svc)
        }
        for (const svc of usedServices) {
          if (!declared.includes(svc)) {
            push(
              'C-入口契约',
              rel,
              `服务端 apply 用了 ctx.${svc} 但 inject 里没声明（宿主不注入 → 运行时 undefined）`
            )
          }
        }
      }
    }
  }
}

// ─────────────────────────────────────────── D/E/F 客户端检查

async function checkClientEntries(files) {
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
    const source = await readIfExists(file)
    if (!source) continue

    // D. 客户端契约
    const importLines = source.split('\n').filter((l) => /^\s*import\s/.test(l))
    if (importLines.length) {
      push('D-客户端契约', rel, `含 ${importLines.length} 处 import（宿主客户端是 __ModuleLoader__ 形态，写了就加载失败）`)
    }
    if (/<[A-Z][a-zA-Z0-9]*[\s/>]|<\/[A-Z][a-zA-Z0-9]*>/.test(source)) {
      push('D-客户端契约', rel, '含疑似 JSX（宿主不替插件构建，必须用 React.createElement）')
    }
    if (!source.includes('__ModuleLoader__')) {
      push('D-客户端契约', rel, '未使用 window.__ModuleLoader__.load')
    }
    if (!/factory\s*:/.test(source)) {
      push('D-客户端契约', rel, 'ModuleLoader.load 缺少 factory')
    }
    if (!/require\(['"]react['"]\)/.test(source)) {
      push('D-客户端契约', rel, '未从 factory(require) 取 React（会出现双实例导致 hooks 报错）')
    }

    // 返回的 inject 必须非空数组
    const retInject = source.match(/inject:\s*\[([^\]]*)\]/)
    if (!retInject) {
      push('D-客户端契约', rel, '返回对象缺少 inject 数组')
    } else if (!retInject[1].trim()) {
      push('D-客户端契约', rel, '返回的 inject 为空数组')
    }

    // E. React API 存在性
    const usedApis = new Set([...source.matchAll(/React\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
    for (const api of usedApis) {
      if (!REACT_API.has(api)) {
        push('E-ReactAPI', rel, `使用了不存在的 React.${api}（运行时会是 undefined）`)
      }
    }

    // F. inject 与 ctx 用法一致
    if (retInject) {
      const declared = retInject[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
      const usedServices = new Set()
      for (const m of source.matchAll(/ctx\.([a-zA-Z_$][\w$]*)/g)) usedServices.add(m[1])
      for (const svc of usedServices) {
        if (svc === 'effect') continue // 框架方法，不需要 inject
        if (!declared.includes(svc)) {
          push(
            'F-inject不一致',
            rel,
            `用了 ctx.${svc} 但 inject 里没声明（宿主可能不注入该服务 → 运行时 undefined）`
          )
        }
      }
    }
  }
}

// ─────────────────────────────────────────── G patch.yml ↔ package.json

async function checkPluginDeclarations() {
  const entries = await fs.readdir(PACKAGES, { withFileTypes: true })
  const plugins = entries.filter((e) => e.isDirectory() && e.name.startsWith('dsh-xyb-')).map((e) => e.name)

  for (const name of plugins) {
    const dir = join(PACKAGES, name)
    const raw = await readIfExists(join(dir, 'package.json'))
    if (!raw) {
      push('G-声明', name, '缺少 package.json')
      continue
    }
    let pkg
    try {
      pkg = JSON.parse(raw)
    } catch (e) {
      push('G-声明', name, `package.json 非法 JSON: ${e.message}`)
      continue
    }

    const rel = `packages/${name}/package.json`
    if (pkg.name !== name) push('G-声明', rel, `包名与目录名不一致（name=${pkg.name}）`)
    if (pkg.type !== 'module') push('G-声明', rel, 'type 应为 "module"')

    const dsh = pkg.dsh || {}
    if (!dsh.bundle?.patch) push('G-声明', rel, '缺少 dsh.bundle.patch')
    const client = dsh.client || {}
    if (client.platform !== 'web') push('G-声明', rel, `dsh.client.platform 应为 "web"（当前 ${client.platform}）`)
    if (!Array.isArray(client.inject) || !client.inject.length) push('G-声明', rel, 'dsh.client.inject 应为非空数组')

    // peerDependencies 承载 @deepseek-ai/*
    for (const dep of Object.keys(pkg.dependencies || {})) {
      if (dep.startsWith('@deepseek-ai/') && dep !== '@deepseek-ai/schemastery') {
        push('G-声明', rel, `${dep} 应在 peerDependencies（写 dependencies 会装第二份宿主代码）`)
      }
    }

    // patch.yml 与 package.json 一致
    const patch = await readIfExists(join(dir, 'cordis.patch.yml'))
    if (!patch) {
      push('G-声明', `packages/${name}/cordis.patch.yml`, '文件缺失')
      continue
    }
    const patchRel = `packages/${name}/cordis.patch.yml`
    if (!patch.trim()) push('G-声明', patchRel, '空文件（会导致启动失败；不需要行时写 []）')
    if (!patch.includes('insert:')) push('G-声明', patchRel, '缺少 insert 段')

    const nameLines = patch
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('name:'))
    for (const line of nameLines) {
      const value = line.slice(5).trim().replace(/^['"]|['"]$/g, '')
      if (!value) push('G-声明', patchRel, '有空的 name')
      else if (value.startsWith('.') || value.startsWith('/')) {
        push('G-声明', patchRel, `name 必须是包名，不能写路径：${value}`)
      } else if (value !== name && !value.startsWith('@')) {
        push('G-声明', patchRel, `insert 的 name（${value}）与包名（${name}）不一致`)
      }
    }

    // insert 的 id 必须唯一
    const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => m[1])
    const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i)
    if (dupIds.length) push('G-声明', patchRel, `insert 的 id 重复：${[...new Set(dupIds)].join('、')}`)
  }
}

// ─────────────────────────────────────────── H lib 可 import

async function checkLibImportable(files) {
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
    if (!rel.includes('/lib/')) continue
    try {
      await import(pathToFileURL(file).href)
    } catch (error) {
      push('H-lib可import', rel, `import 失败：${error?.message || error}`)
    }
  }
}

// ─────────────────────────────────── I 路由注册唯一性（宿主按 path 主键）

/**
 * 找出「同一 path 声明了两次」的路由声明。
 *
 * 只分析同一个文件内部的重复：因为同一文件的路径前缀一致，
 * 不同文件（如 workbench 的 /api/xyb 与 qingnang 的 /api/xyb/qingnang）天然隔离。
 * 跨插件的冲突由 test/contract/plugin-apply.test.mjs 在运行时把关。
 */
async function checkRouteRegistrations(files) {
  // 匹配形如  name('/path', 'GET'  的声明（route / registerJson 等都套得住）
  const DECL = /([A-Za-z_$][\w$]*)\(\s*['"]([^'"]+)['"]\s*,\s*['"]([A-Z]+)['"]/g
  // ⚠️ `String.match()` 配 `/g` 正则只返回**全匹配串**，取不到捕获组（[1] 是 undefined）。
  //    因此需要捕获组时用这个**不带 g** 的副本（实测踩坑）。
  const DECL_ONE = new RegExp(DECL.source)

  for (const file of files) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
    const source = await readIfExists(file)
    if (!source) continue

    /** @type {Map<string, {method: string, line: number}[]>} */
    const byPath = new Map()
    const lines = source.split('\n')

    for (let i = 0; i < lines.length; i += 1) {
      DECL.lastIndex = 0
      for (const m of lines[i].matchAll(DECL)) {
        const [, , path, method] = m
        if (!path.startsWith('/')) continue
        const list = byPath.get(path) || []
        list.push({ method, line: i + 1 })
        byPath.set(path, list)
      }
    }

    for (const [path, list] of byPath) {
      // (1) 同 path + 同 method 重复 —— 纯重复声明，必然是 bug
      const seen = new Map()
      for (const it of list) {
        if (seen.has(it.method)) {
          push(
            'I-路由注册',
            `${rel}:${it.line}`,
            `路由 ${path} 的 ${it.method} 重复声明（第 ${seen.get(it.method)} 行已有）`
          )
        } else {
          seen.set(it.method, it.line)
        }
      }

      // (2) 同 path 不同 method 但**分开声明** —— 只有当 helper 是
      //     「每次调用都独立 register」时才致命（宿主按 path 主键）。
      //     判据：该 helper 体内含 fetch.register，且把 path 作为参数直接传给 register。
      if (list.length > 1) {
        const helperName = lines[list[0].line - 1].match(DECL_ONE)?.[1]
        if (helperName && registersPerCall(source, helperName)) {
          push(
            'I-路由注册',
            `${rel}:${list[0].line}`,
            `helper "${helperName}" 每次调用都独立调用 fetch.register，但路由 ${path} 声明了 ` +
              `${list.length} 次（${list.map((i) => i.method).join('/')}）→ ` +
              `宿主按 path 作主键，第二次注册会抛「already registered」→ 插件加载失败 → 应用打不开。` +
              `修法：收集到路由表，同 path 的多个 method 合并成一次 register（methods 数组）`
          )
        }
      }
    }
  }
}

/**
 * 判断 helper 是否「每次调用都独立 register」。
 *
 * 判据：**只取 helper 自己的函数体**（花括号配对），体内出现 `.register(`。
 *
 * ⚠️ 不能用「从定义处往后取 N 个字符」取体（实测踩坑）：
 *   修好后的 `route` 体里已经**没有** register，但紧跟在后面的 `registerRoutes`
 *   体里有 `.register(`，固定窗口会把它框进来 → 对已修好的代码误报。
 */
function registersPerCall(source, helperName) {
  const defRe = new RegExp(
    `(?:const|let|var)\\s+${helperName}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>|` +
      `function\\s+${helperName}\\s*\\([^)]*\\)`,
    'm'
  )
  const m = source.match(defRe)
  if (!m) return false

  const body = extractFunctionBody(source, m.index + m[0].length)
  if (body === null) return false
  return /\.register\s*\(/.test(body)
}

/**
 * 从 `start` 位置起，取出函数的**完整函数体**。
 *
 * · 下一个非空字符是 `{` → 按花括号配对取到匹配的 `}`
 * · 否则是一行式箭头函数 → 取到该行行尾（分号或换行）
 *
 * @returns {string|null} 函数体文本；定位失败返回 null
 */
function extractFunctionBody(source, start) {
  // 跳过空白
  let i = start
  while (i < source.length && /\s/.test(source[i])) i += 1

  if (source[i] !== '{') {
    // 一行式箭头函数：取到行尾
    const end = source.indexOf('\n', i)
    return source.slice(i, end === -1 ? source.length : end)
  }

  let depth = 0
  for (let j = i; j < source.length; j += 1) {
    const ch = source[j]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(i, j + 1)
    }
  }
  return null
}

// ─────────────────────── I2 路由路径合法性（用宿主真实规则，不是本地推测）

/**
 * 校验路由路径能否被宿主接受。
 *
 * 权威规则来自 `scripts/lib/host-contract-rules.mjs`
 * （逐字抄自 @deepseek-ai/dsh-client-connection@0.2.0-rc.2 的
 *   assertFetchRoute / endpointFromPath）。
 *
 * ── 真实事故（2026-10-15，第三个 Windows 安装包）─────────────────────
 *   `/api/xyb/patients/:id` 里的冒号不在宿主允许字符集里：
 *     ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
 *   → 宿主抛 `connection: invalid exact Fetch route "/api/xyb/patients/:id"`
 *   → 插件 apply() 失败 → 应用完全打不开。
 *   当时 12 个 `:id` 路由全踩同一个坑，而语法检查 / 单测 / smoke 全绿。
 *
 *   为什么之前的检查抓不到：我用的 mock 是「自己猜的规则」，只查了重复 path，
 *   没查路径字符集。现在规则改为从宿主真实源码逐字抄来，mock 与真宿主等价。
 */
async function checkRoutePathValidity(files) {
  // 匹配形如  helper('/path', 'GET'  的声明
  const DECL = /([A-Za-z_$][\w$]*)\(\s*['"]([^'"]+)['"]\s*,\s*['"]([A-Z]+)['"]/g

  for (const file of files) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
    const source = await readIfExists(file)
    if (!source) continue

    // 插件把路径前缀写在 helper 的 register 调用里，形如  path: `/api/xyb${path}`
    const prefixMatch = source.match(/path:\s*`([^`$]+)\$\{/)
    if (!prefixMatch) continue
    const prefix = prefixMatch[1]

    const lines = source.split('\n')
    const reported = new Set()
    for (let i = 0; i < lines.length; i += 1) {
      DECL.lastIndex = 0
      for (const m of lines[i].matchAll(DECL)) {
        const declared = m[2]
        if (!declared.startsWith('/')) continue
        const full = `${prefix}${declared}`
        if (full.includes('${')) continue
        const reason = explainRoutePath(full)
        if (!reason || reported.has(full)) continue
        reported.add(full)
        push(
          'I-路由注册',
          `${rel}:${i + 1}`,
          `路由 ${full} 会被宿主**拒绝**：${reason}。` +
            `宿主校验见 assertFetchRoute/endpointFromPath：每段只允许 A-Za-z0-9_$.- —— ` +
            `冒号不在其中。注册即抛 → 插件 apply() 失败 → 应用打不开。` +
            `修法：动态段改用查询串（如 /patient?id=xxx）`
        )
      }
    }
  }
}

// ────────── J 客户端槽位合法性（用宿主真实规则，不是本地推测）

/**
 * 校验客户端插件的 `ctx.slots.register` 会不会与宿主已占的槽位撞车。
 *
 * 规则真源：`scripts/lib/slot-contract-rules.mjs`
 * （逐字抄自 @deepseek-ai/dsh-client-ui-slots@0.2.0-rc.2，文件头有 sha256）
 *
 * ── 真实事故（2026-10-16，第四个安装包）──────────────────────────
 *   服务端已经全绿：`[desktop] Harness is ready`
 *   但 renderer 报：
 *     single slot "sidebar.brand.mark" already has a registration at priority 0
 *     (registered by mf) — register at a different priority to shadow it (lowest renders)
 *     → Failed to load plugins → 界面打不开
 *
 *   根因：宿主 `dsh-desktop-client-ui` 已往三个品牌槽位注册了自己的一套
 *   （默认优先级 0），而这三个槽位 kind=single（同优先级只能一个占据者）。
 *   我方也用默认 0 → 直接抛错。
 *
 * ── 与前三次崩溃的共性 ──────────────────────────────────────────
 *   四次都是「我的替身不认识宿主真实规则」。前三次是服务端路由，
 *   这次是客户端槽位。所以本检查也用**抄录的规则**，不猜。
 */
async function checkClientSlotRegistrations(files) {
  // 抓  slots.register({ name: 'X', priority: N, id: 'Y', key: 'Z' }, Comp)
  // 以及  slots.register({ name: 'X' }, Comp)
  // `priority` 允许是模块级数字常量（如 BRAND_PRIORITY），下面会解析。
  const REG = /slots\.register\(\s*\{([^}]*)\}/gs

  for (const file of files) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
    const source = await readIfExists(file)
    if (!source) continue

    // 先收集本文件的模块级数字常量，供 priority 解析
    const constants = collectNumericConstants(source)

    for (const m of source.matchAll(REG)) {
      const body = m[1]
      const line = lineOf(source, m.index)

      const name = body.match(/name:\s*'([^']+)'/)?.[1]
      if (!name) {
        push('J-槽位契约', `${rel}:${line}`, 'slots.register 缺少 name（宿主会抛 slot "undefined" is not declared）')
        continue
      }

      const priorityExpr = body.match(/priority:\s*([^,}]+)/)?.[1]
      const priority = resolvePriority(priorityExpr, constants)
      if (priorityExpr !== undefined && priority === undefined) {
        // 解析不出来的表达式：**不猜**（第三次崩溃的教训），报「需人工确认」
        push(
          'J-槽位契约',
          `${rel}:${line}`,
          `槽位 "${name}" 的 priority 表达式 \`${priorityExpr.trim()}\` 无法静态解析为数字。` +
            `请改用字面数字或模块级数字常量（如 BRAND_PRIORITY = -1），否则无法校验是否与宿主撞车`
        )
        continue
      }
      const id = body.match(/\bid:\s*'([^']+)'/)?.[1]
      const key = body.match(/\bkey:\s*'([^']+)'/)?.[1]

      // kind 必须先登记 —— **不猜**（第三次崩溃的教训）
      const kind = SLOT_KINDS[name]
      if (!kind) {
        push(
          'J-槽位契约',
          `${rel}:${line}`,
          `槽位 "${name}" 的 kind 未登记（scripts/lib/slot-kinds.json）→ 无法校验是否与宿主冲突。` +
            `禁止猜：请先从宿主源码抽 children 声明表把 kind 补上，再注册`
        )
        continue
      }

      const conflict = explainSlotConflictWithHost({ name, priority, id, key })
      if (conflict) {
        push(
          'J-槽位契约',
          `${rel}:${line}`,
          `槽位 "${name}"（kind=${kind}）会与宿主撞车：${conflict}。` +
            `后果：宿主抛错 → renderer 报 "Failed to load plugins" → **界面打不开**`
        )
      }
    }
  }
}

// ─────────────────────────────────────────── 主流程

async function main() {
  const asJson = process.argv.includes('--json')

  const jsFiles = await listFiles(PACKAGES, (n) => extname(n) === '.js')
  const serverEntries = jsFiles.filter((f) => f.endsWith('/index.js'))
  const clientEntries = jsFiles.filter((f) => f.endsWith('/client.js'))

  console.log(`[check-plugin-integrity] 分析 ${jsFiles.length} 个自有 JS 文件`)
  console.log(`  服务端入口 ${serverEntries.length} · 客户端入口 ${clientEntries.length}`)

  await checkServerEntries(serverEntries)
  await checkClientEntries(clientEntries)
  await checkClientSlotRegistrations(clientEntries)
  await checkPluginDeclarations()
  await checkLibImportable(jsFiles)
  await checkRouteRegistrations(serverEntries)
  await checkRoutePathValidity(serverEntries)

  if (asJson) {
    console.log(JSON.stringify({ scanned: jsFiles.length, problems }, null, 2))
  } else if (problems.length === 0) {
    console.log('\n[check-plugin-integrity] ✅ 全部通过（无「语法合法但运行时必炸」的问题）')
  } else {
    const byCategory = {}
    for (const p of problems) (byCategory[p.category] ||= []).push(p)
    console.error(`\n[check-plugin-integrity] ❌ 发现 ${problems.length} 个问题：\n`)
    for (const [category, list] of Object.entries(byCategory)) {
      console.error(`── ${category}（${list.length}）──`)
      for (const p of list) {
        console.error(`  ${p.file}`)
        console.error(`    ${p.message}`)
      }
      console.error('')
    }
  }

  process.exit(problems.length ? 1 : 0)
}

main().catch((error) => {
  console.error('[check-plugin-integrity] 脚本错误:', error?.message || error)
  process.exit(2)
})
