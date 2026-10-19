/**
 * 客户端 ↔ 服务端 API 契约测试。
 *
 * ── 这个测试防的是什么 ────────────────────────────────────────────────
 * 插件分两半：`index.js`（服务端，注册路由）与 `client.js`（客户端，调接口）。
 * 两边用**字符串**约定路径 —— 没有任何编译期约束。一旦对不上：
 * · 路由改了名、客户端没跟 → 界面点下去 404，而且**静默**（只有浏览器控制台报错）
 * · 客户端写了路径参数（`/patients/:id`）→ 服务端注册期就抛错，应用打不开
 *
 * 第三次崩溃（2026-10-15，Windows 安装包）：服务端用了 12 个 `/patients/:id`
 * 路径参数，宿主直接拒绝 → 应用打不开。而**客户端同时也写着** `/patients/${id}/board`，
 * 两边一起错，谁也没提醒谁。
 *
 * 这个测试把两边拉在一起对账：客户端每个调用点都必须能在服务端路由表里找到，
 * 且 HTTP 方法必须在声明的方法集合内。
 *
 * ── 覆盖的三类断言 ───────────────────────────────────────────────
 * A. 客户端调用点解析得出（不允许「无法解析」的调用静默溜过）
 * B. 客户端调用的路径 + 方法，在服务端路由表里存在
 * C. 客户端**不得**在查询串之前使用动态段（那会变成非法路径参数）
 * D. 反向：服务端每条路由都应被客户端用到，或显式登记为「仅服务端」
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { bootPlugin } from '../../scripts/lib/host-contract-rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

let dataRoot
before(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xyb-api-'))
  process.env.XYB_DATA_ROOT = dataRoot
})
after(() => {
  delete process.env.XYB_DATA_ROOT
  rmSync(dataRoot, { recursive: true, force: true })
})

// ─────────────────────────────────────────── JS 源码扫描工具
//
// 为什么手写扫描而不是上 AST 解析器：
// 本仓零构建、零依赖（客户端必须宿主 __ModuleLoader__ 形态，不能引入打包器）。
// CI 里没有 node_modules 可用的解析器，所以用一个只处理「引号/注释/括号」的
// 小状态机。它对我们自己的源码足够，并且**解析不了就报错**（不静默放过）。

/** 跳过从 i 开始的字符串/模板串字面量，返回其结束引号的下一个位置 */
function skipString(source, i) {
  const quote = source[i]
  let j = i + 1
  while (j < source.length) {
    if (source[j] === '\\') {
      j += 2
      continue
    }
    if (source[j] === quote) return j + 1
    j += 1
  }
  return source.length
}

/** 从 `open`（一个 `(`）找到匹配的 `)`，返回其下标；找不到返回 -1 */
function matchParen(source, open) {
  let depth = 0
  let i = open
  while (i < source.length) {
    const c = source[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i)
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      const n = source.indexOf('\n', i)
      i = n === -1 ? source.length : n + 1
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const n = source.indexOf('*/', i)
      i = n === -1 ? source.length : n + 2
      continue
    }
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/** 在 [from, to) 内找第一个**顶层**逗号（跳过多层括号内的逗号） */
function findTopComma(source, from, to) {
  let depth = 0
  let i = from
  while (i < to) {
    const c = source[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i)
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (c === ',' && depth === 0) return i
    i += 1
  }
  return -1
}

/** 源码下标 → 行号 */
const lineOf = (source, index) => source.slice(0, index).split('\n').length

/**
 * 解析路径表达式。
 *
 * @returns {{kind:'literal',path:string}|{kind:'template',path:string,raw:string,dynamicBeforeQuery:boolean}
 * |{kind:'dynamic',raw:string}}
 */
function parsePathExpr(expr) {
  const q = expr[0]
  if (q === "'" || q === '"') {
    const end = expr.indexOf(q, 1)
    if (end === -1) return { kind: 'dynamic', raw: expr }
    return { kind: 'literal', path: expr.slice(1, end) }
  }
  if (q === '`') {
    const end = expr.lastIndexOf('`')
    if (end <= 0) return { kind: 'dynamic', raw: expr }
    const raw = expr.slice(1, end)
    const beforeQuery = raw.split('?')[0]
    return {
      kind: 'template',
      raw,
      path: beforeQuery,
      dynamicBeforeQuery: beforeQuery.includes('${')
    }
  }
  return { kind: 'dynamic', raw: expr }
}

/**
 * 抽出客户端里所有 `api(<path>, <options>)` 调用。
 *
 * 会跳过函数**定义** `async function api(path, options)`（它不是调用点）。
 */
function extractClientCalls(source) {
  const calls = []
  const re = /\bapi\s*\(/g
  let m
  while ((m = re.exec(source)) !== null) {
    // 跳过定义：前一个非空白 token 是 function
    const before = source.slice(0, m.index).trimEnd()
    if (/function$/.test(before)) continue

    const open = m.index + m[0].length - 1
    const close = matchParen(source, open)
    if (close === -1) {
      calls.push({ unresolved: '括号不匹配', line: lineOf(source, m.index) })
      continue
    }
    const comma = findTopComma(source, open + 1, close)
    const pathExpr = source.slice(open + 1, comma === -1 ? close : comma).trim()
    const rest = comma === -1 ? '' : source.slice(comma + 1, close)

    // 参数名本身（定义处的残留）→ 不作为调用点
    if (pathExpr === 'path') continue

    const methodMatch = rest.match(/method\s*:\s*['"]([A-Z]+)['"]/)
    calls.push({
      line: lineOf(source, m.index),
      method: methodMatch ? methodMatch[1] : 'GET',
      ...parsePathExpr(pathExpr)
    })
  }
  return calls
}

/** 从客户端源码里读 API_BASE */
function extractApiBase(source) {
  const m = source.match(/const\s+API_BASE\s*=\s*['"`]([^'"`]+)['"`]/)
  return m ? m[1] : null
}

// ─────────────────────────────────────────── 对账表

/**
 * 只由服务端使用、客户端不调用的路由（显式登记，防止「漏接线」被当成正常）。
 *
 * 每条都要写清「谁在用」，否则将来看到这个清单会不知道该不该删。
 */
const SERVER_ONLY_ROUTES = new Set([
  '/api/xyb/health', // 安装 smoke 与排障用；客户端界面不调
  '/api/xyb/qingnang/health' // 同上
])

/**
 * **已实现服务端、客户端界面尚未接线**的路由（如实登记，不隐藏）。
 *
 * ── 这是一个真实的交付缺口，必须让主人看得见 ────────────────────────
 * 本测试（2026-10-15）发现：workbench 服务端有 15 条路由，客户端只调了 4 条。
 * 也就是说应用**能打开、能建档案、能看看板**，但下列功能在界面上还没有入口。
 *
 * 这不是崩溃级 bug，但会让主人误以为「功能都在、只是没找到」。
 * 所以：登记在此 + 在 的缺口清单里列出 + 由对应里程碑补齐。
 *
 * 规则：**新路由不允许静默进这个清单**。要进来必须写明归属里程碑与原因。
 */
const NOT_YET_WIRED = new Map([
  // ── ：设置与隐私闸门（服务端已就绪，客户端无设置界面）──
  ['/api/xyb/settings', '隐私闸门确认与解析模式设置界面未实现（服务端已就绪，界面待接入）'],
  ['/api/xyb/storage/stats', '数据存储统计界面未实现（服务端已就绪，界面待接入）'],
  // ── ：指标记录与人工闸门 ──
  ['/api/xyb/catalog', '指标目录未接入界面（界面用了写死的维度标签）（服务端已就绪，界面待接入）'],
  ['/api/xyb/disclaimers', '免责声明接口未接入（界面写死了文案，存在不一致风险）（服务端已就绪，界面待接入）'],
  ['/api/xyb/patient', '档案详情/改名/删除界面未实现（仅支持新建）（服务端已就绪，界面待接入）'],
  ['/api/xyb/patient/records', '指标记录列表与手工录入界面未实现（服务端已就绪，界面待接入）'],
  ['/api/xyb/patient/record', '单条记录删除界面未实现（服务端已就绪，界面待接入）'],
  ['/api/xyb/patient/pending', '**人工核对闸门界面未实现**（服务端已保证默认只返回已确认）（服务端已就绪，界面待接入）'],
  ['/api/xyb/patient/records-including-unverified', '核对界面专用接口，随核对界面一起实现（服务端已就绪，界面待接入）'],
  ['/api/xyb/patient/medications', '用药记录界面未实现（服务端已就绪，界面待接入）'],
  // ── ：趋势 ──
  ['/api/xyb/patient/series', '趋势图未实现（服务端已就绪，界面待接入）'],
  // ── ：青囊 ──
  ['/api/xyb/qingnang/channels', '青囊通道列表界面未实现（仅显示状态）（服务端已就绪，界面待接入）'],
  ['/api/xyb/qingnang/attribution', '来源与许可展示界面未实现（服务端已就绪，界面待接入）']
])

const PLUGINS = ['dsh-xyb-workbench', 'dsh-xyb-qingnang']

/**
 * **跨插件调用**（显式登记）：某个包的客户端调用**另一个包的**服务端路由。
 *
 * 为什么必须有这张表：
 * 旧版设置页靠 `window.__xybQingnang` 取另一个插件的组件，依赖「谁先装载」这个
 * 未定义顺序；顺序一反就只剩一句「面板尚未载入」（用户实测：完全看不到配置了哪些 MCP）。
 * 改成走 HTTP 后，调用点与路由分属两个包 —— 对账必须显式写明归属，
 * 否则「不在本包路由表里」就等于绕过对账（这正是本测试要防的东西）。
 */
const CROSS_PLUGIN_ROUTES = new Map([
  [
    '/api/xyb/qingnang/credentials',
    {
      owner: 'dsh-xyb-qingnang',
      reason: '工作台设置页要列出青囊通道凭据清单并写入（跨包 HTTP 调用，不取对方对象）'
    }
  ]
])

/** 装载一个插件，返回它的服务端路由表 */
async function routesOf(name) {
  const entry = pathToFileURL(join(REPO_ROOT, 'packages', name, 'index.js')).href
  const { mock, registerError } = await bootPlugin(entry, { root: dataRoot })
  assert.equal(registerError, null, `[${name}] 服务端 apply() 抛错：${registerError?.message}`)
  return mock.routes
}

// ─────────────────────────────────────────── 测试

for (const name of PLUGINS) {
  test(`[${name}] 客户端每个调用点都能解析出路径`, () => {
    const source = readFileSync(join(REPO_ROOT, 'packages', name, 'client.js'), 'utf8')
    const calls = extractClientCalls(source)

    assert.ok(calls.length > 0, `${name}/client.js 里没找到任何 api(...) 调用 —— 扫描器可能失效了`)

    const unresolved = calls.filter((c) => c.unresolved || c.kind === 'dynamic')
    assert.equal(
      unresolved.length,
      0,
      `以下调用点的路径无法静态解析（无法校验 = 潜在漂移，请改成字面量或模板串）：\n` +
        unresolved.map((c) => `  client.js:${c.line}  ${c.raw || c.unresolved}`).join('\n')
    )
  })

  test(`[${name}] 客户端调用的 路径+方法 在服务端都存在`, async () => {
    const source = readFileSync(join(REPO_ROOT, 'packages', name, 'client.js'), 'utf8')
    const apiBase = extractApiBase(source)
    assert.ok(apiBase, `${name}/client.js 未找到 API_BASE`)

    const routes = await routesOf(name)
    const calls = extractClientCalls(source)

    const problems = []
    for (const call of calls) {
      const full = `${apiBase}${call.path}`
      const route = routes.get(full)
      if (!route) {
        // 显式登记的跨插件路由：去归属插件里真的对一次账，而不是放行
        const cross = CROSS_PLUGIN_ROUTES.get(full)
        if (cross && cross.owner !== name) {
          const owned = (await routesOf(cross.owner)).get(full)
          if (owned && owned.methods.has(call.method)) continue
          problems.push(
            `  client.js:${call.line}  ${call.method} ${full}\n` +
              `      → 跨插件登记为 ${cross.owner}，但它没有这条路由或没有声明 ${call.method}`
          )
          continue
        }
        problems.push(
          `  client.js:${call.line}  ${call.method} ${full}\n` +
            `      → 服务端没有这条路由（界面点下去会 404，且只在浏览器控制台可见）`
        )
        continue
      }
      if (!route.methods.has(call.method)) {
        problems.push(
          `  client.js:${call.line}  ${call.method} ${full}\n` +
            `      → 服务端只声明了 ${[...route.methods].join('/')}`
        )
      }
    }
    assert.equal(
      problems.length,
      0,
      `客户端与服端 API 不一致（${problems.length} 处）：\n${problems.join('\n')}`
    )
  })

  test(`[${name}] 客户端不得使用路径参数（:x 形式）`, () => {
    const source = readFileSync(join(REPO_ROOT, 'packages', name, 'client.js'), 'utf8')
    const calls = extractClientCalls(source)
    const bad = calls.filter((c) => c.kind === 'template' && c.dynamicBeforeQuery)
    assert.equal(
      bad.length,
      0,
      `以下调用点在查询串之前拼了动态段 —— 服务端无法注册这种路由（宿主路径字符集不含冒号），` +
        `插件会装载失败、应用打不开。请把动态段改成查询串（?id=xxx）：\n` +
        bad.map((c) => `  client.js:${c.line}  \`${c.raw}\``).join('\n')
    )
  })
}

test('[反向] 服务端每条路由都被客户端用到，或显式登记为仅服务端', async () => {
  const used = new Set()
  for (const name of PLUGINS) {
    const source = readFileSync(join(REPO_ROOT, 'packages', name, 'client.js'), 'utf8')
    const apiBase = extractApiBase(source)
    for (const call of extractClientCalls(source)) used.add(`${apiBase}${call.path}`)
  }

  const orphans = []
  for (const name of PLUGINS) {
    const routes = await routesOf(name)
    for (const path of routes.keys()) {
      if (used.has(path) || SERVER_ONLY_ROUTES.has(path) || NOT_YET_WIRED.has(path)) continue
      orphans.push(`  ${path}（${name}）`)
    }
  }
  assert.equal(
    orphans.length,
    0,
    `以下路由没人用也没登记 —— 要么是漏了客户端接线，要么是死路由：\n${orphans.join('\n')}\n` +
      `  若确实是仅服务端用途，请加入本测试的 SERVER_ONLY_ROUTES 并写明谁在用。\n` +
      `  若是「服务端已就绪但界面未接线」，必须加入 NOT_YET_WIRED 并写明归属里程碑与原因。`
  )
})

test('[元] SERVER_ONLY_ROUTES 里的路由必须真实存在（避免清单腐烂）', async () => {
  const all = new Set()
  for (const name of PLUGINS) {
    for (const path of (await routesOf(name)).keys()) all.add(path)
  }
  for (const path of SERVER_ONLY_ROUTES) {
    assert.ok(all.has(path), `SERVER_ONLY_ROUTES 里的 ${path} 已不存在，请从清单移除`)
  }
})

test('[元] NOT_YET_WIRED 里的路由必须真实存在（避免登记表腐烂）', async () => {
  const all = new Set()
  for (const name of PLUGINS) {
    for (const path of (await routesOf(name)).keys()) all.add(path)
  }
  for (const [path, reason] of NOT_YET_WIRED) {
    assert.ok(all.has(path), `NOT_YET_WIRED 里的 ${path} 已不存在，请从登记表移除`)
    assert.ok(reason.length >= 8, `${path} 的原因描述太短，需要写明归属里程碑`)
  }
})

test('[缺口可见性] 未接线路由数量必须被显式感知（超过阈值即提醒）', () => {
  // 这条不做「必须为 0」的断言 —— 因为客户端确实在分期实现。
  // 它的作用是：把缺口变成**测试输出里可见的数字**，而不是藏在代码里。
  const total = NOT_YET_WIRED.size
  console.log(`\n  ⚠️ 服务端已就绪但界面未接线的路由：${total} 条`)
  for (const [path, reason] of NOT_YET_WIRED) console.log(`     · ${path}  ← ${reason}`)
  console.log('     （这些功能在界面上还没有入口，见下方的缺口登记表）\n')
  assert.ok(total < 30, `未接线路由已堆到 ${total} 条，说明客户端实现长期滞后，需要重新排期`)
})

test('[元] CROSS_PLUGIN_ROUTES 登记的路由必须真的由归属插件注册（避免登记表腐烂）', async () => {
  for (const [path, meta] of CROSS_PLUGIN_ROUTES) {
    assert.ok(PLUGINS.includes(meta.owner), `${path} 的归属插件 ${meta.owner} 不在受管清单里`)
    assert.ok(meta.reason.length >= 8, `${path} 必须写明为什么要跨包调用`)
    const owned = (await routesOf(meta.owner)).get(path)
    assert.ok(owned, `CROSS_PLUGIN_ROUTES 里的 ${path} 在 ${meta.owner} 里已不存在，请从登记表移除`)
  }
})

test('[元] 扫描器能在测试中被验证（防止扫描器失效导致假绿）', () => {
  // 造一段含各种形态的代码，断言扫描器都能解析
  const fixture = `
    const API_BASE = '/api/demo'
    async function api(path, options) { return fetch(API_BASE + path, options) }
    api('/a')
    api('/b', { method: 'POST' })
    api(\`/c?id=\${x}\`)
    api('/d', { method: 'PATCH', body: JSON.stringify({ a: 1, b: [2, 3] }) })
  `
  const calls = extractClientCalls(fixture)
  assert.equal(calls.length, 4, `应解析出 4 个调用点（定义不计），实际 ${calls.length}`)
  assert.deepEqual(
    calls.map((c) => [c.path, c.method]),
    [
      ['/a', 'GET'],
      ['/b', 'POST'],
      ['/c', 'GET'],
      ['/d', 'PATCH']
    ]
  )
  assert.equal(calls[2].dynamicBeforeQuery, false, '动态段在查询串里是允许的')
  assert.equal(extractApiBase(fixture), '/api/demo')
})
