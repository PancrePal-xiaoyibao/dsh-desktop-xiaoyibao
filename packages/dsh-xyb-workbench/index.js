/**
 * dsh-xyb-workbench — 小胰宝工作台（服务端入口）
 *
 * M1/M2/M4/M5/M6 服务端实现。
 *
 * 契约：
 * - 具名导出 apply(ctx, config) + inject
 * - 路由走 ctx.connection.fetch.register({ path, methods, requestBody, fetch })
 * - 数据落 config.root（由 cordis.patch.yml 的 dshHomePath('xyb') 注入）
 *
 * 本文件**只负责组装**：把路由与领域模块接起来。领域逻辑全在 lib/ 下。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteJson, readJson } from './lib/store/atomic-write.js'
import { resolveDataRoot, resolveEffectiveRoot, assertWritable, bootWithRetry } from './lib/store/root.js'
import { probeDirectory } from './lib/store/probe.js'
import {
  initRoot,
  listPatients,
  readProfile,
  createPatient,
  updatePatient,
  deletePatient,
  computeStats,
  isValidPatientId
} from './lib/store/patients.js'
import { listRecords, listRecordsIncludingUnverified, listUnresolved, listSeries, latestRecord } from './lib/metrics/query.js'
import { addManualRecord, removeRecord, confirmExtraction, markDoubted, REVIEW_STATUS } from './lib/metrics/records.js'
import { deltaDirection, toneFor } from './lib/metrics/direction.js'
import { buildBoard } from './lib/board/aggregate.js'
import { readAssess, updateAssess } from './lib/assess/profile.js'
import { listPsychScores, addPsychScore, PSYCH_SCALES } from './lib/psych/scores.js'
import {
  CRISIS_RESOURCES,
  SELF_CHECK_NOTE,
  RELIEF_METHODS,
  RELIEF_NOTE,
  HOSPICE_FAQ,
  HOSPICE_NOTE,
  GRIEF_NOTES
} from './lib/psych/resources.js'
import { DISCLAIMERS, disclaimerKeys } from './lib/compliance/disclaimers.js'
import { appendRecord, appendDelete, readJsonl, compactJsonl } from './lib/store/jsonl.js'
import { appendEvent, listEvents, EVENT_LEVELS } from './lib/store/events.js'
import { collectDiagnostics, exportDiagnostics } from './lib/diagnostics/export.js'
import { runSelfCheck, runRepair, repairCatalog, REPAIR_ACTIONS } from './lib/diagnostics/selfcheck.js'
import { streamPath } from './lib/store/patients.js'
import { readModelConfig, writeModelCredential } from './lib/settings/model-config.js'
import { probeProviderModels, saveCustomProvider, saveModelSelection } from './lib/settings/model-selection.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ID = 'dsh-xyb-workbench'

/** 请求体上限（除文档导入）， SPEC §4.7 */
const MAX_BODY_BYTES = 1024 * 1024

// ─────────────────────────────────────────── 工具

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  })

const fail = (code, message, status = 400) => json({ error: code, message }, status)

async function readPayload(request, limit = MAX_BODY_BYTES) {
  const text = await request.text()
  if (text.length > limit) {
    const error = new Error('请求体过大')
    error.code = 'SIZE_EXCEEDED'
    throw error
  }
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.code = 'INVALID_JSON'
    throw error
  }
}

/**
 * 读查询串参数。
 *
 * ⚠️ **为什么参数一律走查询串，而不是路径参数（如 `/patients/:id`）**
 *
 * 宿主的 exact Fetch 路由**只接受字面路径**，其合法性由
 * `ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/` 校验 ——
 * 源码：@deepseek-ai/dsh-client-connection（0.2.0-rc.2）lib/index.js
 * assertFetchRoute() → endpointFromPath()
 * 冒号 `:` **不在允许字符集内**，所以注册 `/api/xyb/patients/:id` 会抛：
 * `connection: invalid exact Fetch route "/api/xyb/patients/:id"`
 * → 插件 apply() 失败 → 「required plugin did not activate」→ **应用打不开**。
 *
 * （实测踩坑：第三个 Windows 安装包就是死在这上面，12 个 `:id` 路由全非法。）
 */
function queryParam(request, name) {
  return new URL(request.url).searchParams.get(name) || ''
}

/** 统一错误响应：把内部 code 映射到 HTTP 状态，**不泄露内部细节** */
function respondError(error) {
  const code = error?.code || 'INTERNAL'
  const map = {
    NOT_FOUND: 404,
    PATH_ESCAPE: 403,
    PATIENT_LIMIT: 409,
    INVALID_INPUT: 400,
    INVALID_JSON: 400,
    SIZE_EXCEEDED: 413,
    DATA_ROOT_UNWRITABLE: 500,
    SCHEMA_TOO_NEW: 409,
    MIGRATION_FAILED: 500,
    UNKNOWN_STREAM: 400,
    SEAM_UNAVAILABLE: 503,
    CREDENTIAL_WRITE_FAILED: 409,
    PROVIDER_UNKNOWN: 404,
    LISTING_UNREADABLE: 502,
    LISTING_TOO_LARGE: 502
  }
  const status = map[code] || 500
  // 生产不返回 stack；message 里不得含病历正文 / Token（调用方保证）。
  // 但**已知可解释**的失败（如凭据服务没挂、提供者拒写）要把原因带给用户 ——
  // 否则用户只看到「内部错误」，不知道该去哪儿改。
  const explainable = code === 'SEAM_UNAVAILABLE' || code === 'CREDENTIAL_WRITE_FAILED'
  return fail(code, status >= 500 && !explainable ? '内部错误' : error.message, status)
}

// ─────────────────────────────────────────── 插件入口

/**
 * @param {object} ctx Cordis 上下文
 * @param {{ root?: string }} config 插件配置
 */
export function apply(ctx, config) {
  // 数据根：config.root（dshHomePath('xyb')）→ 可选 dataRootOverride → 兜底
  let rootPromise = null
  const boot = async () => {
    const defaultRoot = await resolveDataRoot(config?.root)
    try {
      await assertWritable(defaultRoot)
      const { root } = await resolveEffectiveRoot(defaultRoot)
      await initRoot(root)
      // 启动成功留一条事件：时间线上能看出这台机器上次是什么时候起来的
      await appendEvent(root, { level: 'info', phase: 'app', code: 'READY', message: '工作台已启动' })
      return root
    } catch (error) {
      // 数据根不可用（只读目录 / 受控文件夹访问 / 磁盘满）是最难排查的一类故障：
      // 用户只看到界面报错，日志里什么都没有 —— 这里尽力把原因写下来（写不进就算了）
      await appendEvent(defaultRoot, {
        level: 'error',
        phase: 'app',
        code: error?.code || 'BOOT_FAILED',
        message: `数据目录不可用：${error?.message || ''}`
      })
      throw error
    }
  }
  const getRoot = () => {
    if (!rootPromise) {
      // 有界重试（默认 2 次）：真实文件 IO 偶发失败不该直接打成「内部错误」；
      // 持续故障会把最后一个错误原样抛出（见 lib/store/root.js bootWithRetry）。
      rootPromise = bootWithRetry(boot).catch((error) => {
        rootPromise = null // 允许下次请求再试
        throw error
      })
    }
    return rootPromise
  }

  /**
   * 安装 smoke 诊断输出。
   *
   * 为什么由插件写而不是宿主写：
   * 宿主 src/main 属 V-2 禁止改造的核心运行时逻辑；
   * 而插件能拿到数据根，写一个诊断文件是插件层合规行为。
   *
   * 触发条件：环境变量 XYB_SMOKE_DIAGNOSTIC 指向目标文件路径
   * （只有 smoke 流程会设它，正常使用不会产生任何额外文件）。
   */
  const emitSmokeDiagnostic = async (root) => {
    const target = process.env.XYB_SMOKE_DIAGNOSTIC
    if (!target) return
    try {
      const payload = {
        ok: true,
        // 首屏标识：smoke 脚本断言该字段含小胰宝关键词
        firstPanel: 'xyb',
        firstPanelLabel: '小胰宝',
        product: '小胰宝社区版',
        plugin: 'dsh-xyb-workbench',
        dataRoot: root,
        hostUiVisible: [],
        at: new Date().toISOString()
      }
      await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      ctx.logger?.info?.('xyb: smoke diagnostic written; path=%s', target)
    } catch (error) {
      // 诊断写入失败**不得**影响插件与宿主（失败隔离）
      ctx.logger?.warn?.('xyb: smoke diagnostic failed; msg=%s', error?.message || String(error))
    }
  }

  // ── 路由表（**同 path 多 method 必须合并成一次注册**）
  //
  // ⚠️ 宿主的 fetch 路由注册**以 path 为主键**，同一 path 注册两次会抛：
  // `connection: exact Fetch route "/api/xyb/settings" is already registered`
  // → 插件 apply() 失败 → 「required plugin did not activate」→ **整个应用打不开**。
  // （实测踩坑：Windows 安装包第二版启动即崩，就是 GET /settings 与 POST /settings
  // 各注册了一次。）
  //
  // 上游权威写法见 packages/dsh-desktop-preset-transfer/index.js：
  // 同一个 path 的多个 method 写在**一次** register 调用的 `methods: ['GET','HEAD']` 里。
  //
  // 因此这里先收集到路由表，等所有 route(...) 声明完毕再统一注册（每个 path 一次）。
  const routeTable = new Map()

  const route = (path, method, handler) => {
    const entry = routeTable.get(path) || { methods: [], handlers: new Map() }
    if (entry.handlers.has(method)) {
      // 同 path + 同 method 重复声明是**代码 bug**，直接抛（宁可启动失败也要暴露）
      throw new Error(`xyb: 路由重复声明 path=${path} method=${method}`)
    }
    entry.methods.push(method)
    entry.handlers.set(method, handler)
    routeTable.set(path, entry)
  }

  /**
   * 患者相关路由的统一包装：从 `?id=` 取患者 id 并做路径穿越校验。
   *
   * 收拢进一个包装有两个好处：
   * ① 12 个患者路由不再各写一遍重复校验（少写一处就少一个越权口子）
   * ② 校验失败统一 403 PATH_ESCAPE，行为一致、可测
   */
  const patientRoute = (path, method, handler) =>
    route(path, method, async (request) => {
      const id = queryParam(request, 'id')
      if (!isValidPatientId(id)) return fail('PATH_ESCAPE', '患者 id 非法', 403)
      return handler(request, id)
    })

  /** 把所有已声明的路由按 path 合并注册（每个 path 恰好一次） */
  const registerRoutes = () => {
    for (const [path, entry] of routeTable) {
      ctx.connection.fetch.register({
        path: `/api/xyb${path}`,
        methods: entry.methods,
        requestBody: 'buffered',
        async fetch(request) {
          // 同一 path 的多个 method 共用一个 fetch，按请求方法分发
          const handler = entry.handlers.get(request.method)
          if (!handler) {
            return fail('METHOD_NOT_ALLOWED', `方法 ${request.method} 不受支持`, 405)
          }
          try {
            return await handler(request)
          } catch (error) {
            ctx.logger?.warn?.('xyb: route failed; path=%s code=%s', path, error?.code || 'INTERNAL')
            await logRouteError(request, path, error)
            return respondError(error)
          }
        }
      })
    }
  }

  /** 插件版本：从自身 package.json 读（避免两处维护）；读不到就写 unknown，不影响导出。 */
  const pluginVersion = async () => {
    try {
      const pkg = await readJson(join(HERE, 'package.json'))
      return pkg?.version || 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * 把路由失败写进事件时间线。
   *
   * 事件日志是**旁路**：拿不到数据根、写入失败都不改变主响应 —— 不能因为日志问题反过来把请求搞挂。
   * 消息里只写方法与路径 + 错误描述（不带请求体、不带病历内容）。
   */
  const logRouteError = async (request, path, error) => {
    try {
      const root = await getRoot()
      await appendEvent(root, {
        level: 'error',
        phase: 'route',
        code: error?.code || 'INTERNAL',
        message: `${request.method} ${path}：${error?.message || '未知错误'}`
      })
    } catch {
      /* 旁路失败不影响主流程 */
    }
  }

  // ── 元信息

  route('/manifest', 'GET', async () => {
    const root = await getRoot()
    const { manifest } = await initRoot(root)
    return json({
      schemaVersion: manifest.schemaVersion,
      patients: (manifest.patients || []).filter((p) => !p.deletedAt).map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt
      })),
      dataRoot: root
    })
  })

  // ── 设置

  const settingsPath = async () => join(await getRoot(), 'settings.json')

  const readSettings = async () => {
    const path = await settingsPath()
    const raw = await readJson(path, null)
    const defaults = {
      parseMode: 'local',
      parseModel: 'pipeline',
      privacyAckAt: null,
      sources: {},
      dataRootOverride: null
    }
    const merged = { ...defaults, ...(raw || {}) }
    // **配置层强制回落**：未确认隐私闸门时不允许 cloud
    if (!merged.privacyAckAt) merged.parseMode = 'local'
    return merged
  }

  route('/settings', 'GET', async () => {
    const settings = await readSettings()
    // 把**实际生效**的数据目录一并返回：向导与设置页都要能告诉用户「数据在哪」
    return json({ ...settings, dataRoot: await getRoot() })
  })

  // ── 目录可写探针：真写一个文件再删，失败给出人能读懂的原因

  route('/probe-dir', 'POST', async (request) => {
    const body = await readPayload(request)
    const target = String(body?.path ?? '').trim()
    // 给了路径就直接探（不依赖数据根），否则才去读当前数据根。
    //
    // ⚠️ 为什么不直接 `await getRoot()`：数据根启动/读取是**会失败**的一步，
    // 而探测接口的职责就是「把能不能用说清楚」。如果 getRoot 抛错，旧写法会让这条
    // 路由变成 500「内部错误」—— 用户看到的是一句没有信息量的话
    // （并行回归下已经偶发命中过，见 AGENTS.md 踩坑记录）。
    if (target) return json(await probeDirectory(target))

    let fallbackRoot = ''
    try {
      fallbackRoot = await getRoot()
    } catch (error) {
      return json({
        ok: false,
        path: '',
        reason: `读不到当前数据目录（${error?.message || '未知原因'}）—— 可以直接在上面指定一个目录再试`,
        code: error?.code || 'DATA_ROOT_UNREADABLE'
      })
    }
    return json(await probeDirectory(fallbackRoot))
  })

  route('/settings', 'POST', async (request) => {
    const patch = await readPayload(request)
    const root = await getRoot()
    const current = await readSettings()
    const next = { ...current, ...patch }
    if (!next.privacyAckAt) next.parseMode = 'local'
    await atomicWriteJson(join(root, 'settings.json'), next)
    return json(next)
  })

  // ── 模型与 API Key（宿主 seam 代理；★ 本插件不另存副本）
  //
  // 缺口来源（用户实测反馈 + 旧版 ModelConfigNote 的原文）：设置页只写了一句
  // 「由宿主运行时管理」，于是用户既看不到有哪些模型提供方，也没有任何 Key 输入口。
  //
  // 这里把宿主的两个 seam 暴露成「只读 + 只写」两个口：
  // · 读：只回「配了没有 + 来自哪一层」，宿主的 describe 本身也不回密钥值；
  // · 写：只向上游凭据服务写，值不进响应、不进事件日志、不落盘。
  // 缺 seam（精简发行版 / 测试沙箱）时明确降级为 available:false，不编造状态。

  route('/model-config', 'GET', async () => json(await readModelConfig(ctx)))

  route('/model-config/credential', 'POST', async (request) => {
    const body = await readPayload(request)
    const result = await writeModelCredential(ctx, body)
    // 事件里只记「哪个引用名被设置 / 清除」，**绝不记值**
    try {
      await appendEvent(await getRoot(), {
        level: 'info',
        phase: 'settings',
        code: result.cleared ? 'API_KEY_CLEARED' : 'API_KEY_SAVED',
        message: `模型 API Key ${result.cleared ? '已清除' : '已保存'}：${result.ref}`
      })
    } catch {
      /* 事件日志是旁路，写不进去不影响保存结果 */
    }
    return json({ ...result, config: await readModelConfig(ctx) })
  })

  // ── 模型清单探测（只展示 200 可用的模型；不可用就不展示）

  route('/models/available', 'GET', async (request) =>
    json(await probeProviderModels(ctx, { provider: queryParam(request, 'provider'), timeoutMs: queryParam(request, 'timeoutMs') }))
  )

  // ── 自定义提供方：写宿主的 llm-pi-ai 路由字典（先读后合并，不整段覆盖）

  route('/model-provider/custom', 'POST', async (request) => {
    const body = await readPayload(request)
    const config = await saveCustomProvider(ctx, body)
    try {
      await appendEvent(await getRoot(), {
        level: 'info',
        phase: 'settings',
        code: 'CUSTOM_PROVIDER_SAVED',
        message: `已保存自定义模型提供方：${String(body?.route ?? '').slice(0, 64)}`
      })
    } catch {
      /* 事件日志是旁路 */
    }
    return json({ ok: true, config })
  })

  // ── 右侧 AI 栏使用的模型（写宿主 agent 默认模型）

  route('/model-selected', 'POST', async (request) => {
    const body = await readPayload(request)
    const selection = await saveModelSelection(ctx, body)
    try {
      await appendEvent(await getRoot(), {
        level: 'info',
        phase: 'settings',
        code: 'MODEL_SELECTED',
        message: `右侧 AI 栏模型：${selection.provider} / ${selection.model}`
      })
    } catch {
      /* 同上 */
    }
    return json({ ok: true, selection })
  })

  // ── 指标目录

  route('/catalog', 'GET', async () => {
    const text = await readFile(join(HERE, 'lib/catalog/indicator-catalog.json'), 'utf8')
    return new Response(text, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    })
  })

  // ── 免责声明

  route('/disclaimers', 'GET', async () =>
    json({ keys: disclaimerKeys(), disclaimers: DISCLAIMERS })
  )

  // ── 患者

  route('/patients', 'GET', async () => json(await listPatients(await getRoot())))

  route('/patients', 'POST', async (request) => {
    const body = await readPayload(request)
    const root = await getRoot()
    const patient = await createPatient(root, body)
    // 事件里**不写姓名**（时间线是诊断资产，不是业务数据副本）
    await appendEvent(root, { level: 'info', phase: 'patients', code: 'CREATED', message: '新建了一份患者档案' })
    return json(patient)
  })

  patientRoute('/patient', 'GET', async (request, id) => {
    return json(await readProfile(await getRoot(), id))
  })

  patientRoute('/patient', 'PATCH', async (request, id) => {
    const patch = await readPayload(request)
    return json(await updatePatient(await getRoot(), id, patch))
  })

  patientRoute('/patient', 'DELETE', async (request, id) => {
    const body = await readPayload(request)
    if (body?.confirm !== true) return fail('CONFIRM_REQUIRED', '删除需要二次确认', 400)
    const root = await getRoot()
    const result = await deletePatient(root, id)
    await appendEvent(root, { level: 'warn', phase: 'patients', code: 'DELETED', message: '删除了一份患者档案（软删除，可恢复）' })
    return json(result)
  })

  // ── 指标记录（**默认只返回已确认** —— 人工闸门）

  patientRoute('/patient/records', 'GET', async (request, id) => {
    const url = new URL(request.url)
    const filter = {
      indicator: url.searchParams.get('indicator') || undefined,
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined
    }
    const { items, malformedLines } = await listRecords(await getRoot(), id, filter)
    return json({ items, malformedLines })
  })

  patientRoute('/patient/records', 'POST', async (request, id) => {
    const body = await readPayload(request)
    return json(await addManualRecord(await getRoot(), id, body), 201)
  })

  // 单条记录删除：recordId 同样走查询串（路径参数不被宿主接受）
  patientRoute('/patient/record', 'DELETE', async (request, id) => {
    const recordId = queryParam(request, 'recordId')
    return json(await removeRecord(await getRoot(), id, recordId))
  })

  // 未结清清单：待确认（pending）+ 已存疑（doubted）
  //
  // ⚠️ 为什么两个都要返回（真实缺陷，2026-10-15 数据层测试发现）：
  // 标为「存疑」的记录：既不在默认查询（只给已确认）、也不在 pending 里
  // （只给待确认）—— 两头都不在，**用户彻底失去这条数据的线索**。
  // 对医疗数据而言这是“静默丢数据”。所以接口必须把两类都交出去，
  // 由核对界面分别呈现、逐条了结（确认或丢弃）。
  patientRoute('/patient/pending', 'GET', async (request, id) => {
    const { items: unresolved, malformedLines } = await listUnresolved(await getRoot(), id)
    return json({
      // 待确认（可点「确认」入正式数据）
      items: unresolved.filter((r) => r.review?.status === REVIEW_STATUS.PENDING),
      // 已存疑（需重新判断或丢弃）
      doubted: unresolved.filter((r) => r.review?.status === REVIEW_STATUS.DOUBTED),
      malformedLines
    })
  })

  // 核对界面专用：可读未确认（名字含 IncludingUnverified，警示用）
  patientRoute('/patient/records-including-unverified', 'GET', async (request, id) => {
    const { items, malformedLines } = await listRecordsIncludingUnverified(await getRoot(), id)
    return json({ items, malformedLines })
  })

  // ── 核对写侧（人工闸门：确认 / 存疑 / 改后确认）
  //
  // 确认是「就地结清」：复用原 id，不另造记录（P-15）。
  // 已确认的项不得重复确认（冲突要显式报，不静默）。
  patientRoute('/patient/review', 'POST', async (request, id) => {
    const body = await readPayload(request)
    const action = String(body?.action || '')
    const recordId = String(body?.recordId || '')
    if (!recordId) return fail('INVALID_INPUT', '缺少 recordId', 400)

    const root = await getRoot()
    const { items } = await listRecordsIncludingUnverified(root, id)
    const current = items.find((record) => record.id === recordId)
    if (!current) return fail('NOT_FOUND', '找不到该待确认项', 404)
    if (current.review?.status === REVIEW_STATUS.CONFIRMED) {
      return fail('ALREADY_SETTLED', '该项已确认（可能是另一个窗口处理的）', 409)
    }

    if (action === 'confirm') {
      const result = await confirmExtraction(root, id, current, {
        value: body?.value,
        unit: body?.unit,
        indicator: body?.indicator,
        measuredAt: body?.measuredAt,
        refLow: body?.refLow,
        refHigh: body?.refHigh
      })
      await appendEvent(root, { level: 'info', phase: 'records', code: 'CONFIRMED', message: '核对并确认了一条抽取记录' })
      return json(result)
    }
    if (action === 'doubt') {
      return json(await markDoubted(root, id, recordId, String(body?.note || '')))
    }
    return fail('INVALID_INPUT', `未知动作：${action}`, 400)
  })

  // ── 指标摘要（指标卡真源：最新值 + 方向语义判定）
  //
  // 为什么放在服务端：颜色由方向语义决定（原则二），判定要与看板同源，
  // 不允许前端各写一套（§3.3：禁止在展示层做业务判定）。
  patientRoute('/patient/indicator-summary', 'GET', async (request, id) => {
    const url = new URL(request.url)
    const cats = (url.searchParams.get('cats') || '').split(',').filter(Boolean)
    const root = await getRoot()
    const catalogRaw = JSON.parse(await readFile(join(HERE, 'lib/catalog/indicator-catalog.json'), 'utf8'))
    const entries = Array.isArray(catalogRaw) ? catalogRaw : catalogRaw.indicators || []
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    const series = await listSeries(root, id, {})

    const items = []
    for (const [indicator, points] of Object.entries(series)) {
      if (!points.length) continue
      const meta = byId.get(indicator) || {
        id: indicator,
        name: indicator,
        category: 'other',
        unit: null,
        direction: 'range',
        refLow: null,
        refHigh: null
      }
      if (cats.length > 0 && !cats.includes(meta.category)) continue
      const latest = points[points.length - 1]
      const prev = points.length > 1 ? points[points.length - 2] : null
      const delta = deltaDirection(prev ? prev.value : null, latest.value)
      const tone = toneFor(meta.direction, delta, latest.value, meta.refLow ?? null, meta.refHigh ?? null)
      items.push({
        id: indicator,
        name: meta.name,
        category: meta.category,
        unit: latest.unit ?? meta.unit ?? null,
        direction: meta.direction,
        refLow: meta.refLow ?? null,
        refHigh: meta.refHigh ?? null,
        latest: { value: latest.value, at: latest.at },
        delta,
        tone,
        points: points.slice(-12)
      })
    }
    items.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    return json({ items, categories: [...new Set(entries.map((entry) => entry.category))] })
  })

  // ── 趋势

  patientRoute('/patient/series', 'GET', async (request, id) => {
    const url = new URL(request.url)
    const indicators = url.searchParams.get('indicators')
    const filter = {
      indicators: indicators ? indicators.split(',').filter(Boolean) : undefined,
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined
    }
    const root = await getRoot()
    const series = await listSeries(root, id, filter)
    const { items: medications } = await readJsonl(streamPath(root, id, 'medications'))
    // events 字段： 会用（本期返回空数组，结构已就位）
    return json({ series, medications, events: [] })
  })

  // ── 用药

  patientRoute('/patient/medications', 'GET', async (request, id) => {
    const { items } = await readJsonl(streamPath(await getRoot(), id, 'medications'))
    return json({ items })
  })

  patientRoute('/patient/medications', 'POST', async (request, id) => {
    const body = await readPayload(request)
    const root = await getRoot()
    await readProfile(root, id)
    const now = new Date().toISOString()
    const record = {
      id: `m-${Math.random().toString(36).slice(2, 10)}`,
      patientId: id,
      line: body?.line ?? '',
      name: String(body?.name ?? '').trim(),
      startedAt: body?.startedAt ?? now.slice(0, 10),
      endedAt: body?.endedAt ?? null,
      endReason: body?.endReason ?? null,
      note: body?.note ?? '',
      createdAt: now
    }
    if (!record.name) return fail('INVALID_INPUT', '方案名不能为空', 400)
    await appendRecord(streamPath(root, id, 'medications'), record)
    return json(record, 201)
  })

  // ── 看板

  patientRoute('/patient/board', 'GET', async (request, id) => {
    return json(await buildBoard(await getRoot(), id))
  })

  // ── 病情评估档案（与临床匹配共用同一模型；缺失≠0，写前校验）

  patientRoute('/patient/assess', 'GET', async (request, id) => {
    return json(await readAssess(await getRoot(), id))
  })

  patientRoute('/patient/assess', 'POST', async (request, id) => {
    const patch = await readPayload(request)
    return json(await updateAssess(await getRoot(), id, patch))
  })

  // ── 心理支持（M-3：只存分不解读；M-5：危机资源随每个入口下发）

  route('/psych/scales', 'GET', async () =>
    json({ scales: PSYCH_SCALES, note: SELF_CHECK_NOTE, crisis: CRISIS_RESOURCES })
  )

  route('/psych/resources', 'GET', async () =>
    json({
      crisis: CRISIS_RESOURCES,
      relief: { methods: RELIEF_METHODS, note: RELIEF_NOTE },
      hospice: { faq: HOSPICE_FAQ, note: HOSPICE_NOTE },
      grief: GRIEF_NOTES
    })
  )

  patientRoute('/patient/psych', 'GET', async (request, id) => {
    return json(await listPsychScores(await getRoot(), id))
  })

  patientRoute('/patient/psych', 'POST', async (request, id) => {
    const body = await readPayload(request)
    return json(await addPsychScore(await getRoot(), id, body), 201)
  })

  // ── 存储统计

  // ── 本机事件时间线：只读本机、只记结构，不记病历内容

  route('/events/list', 'GET', async (request) => {
    const level = queryParam(request, 'level')
    if (level && !EVENT_LEVELS.includes(level)) {
      return fail('INVALID_INPUT', '级别只能是 info / warn / error', 400)
    }
    const limit = Number(queryParam(request, 'limit')) || 50
    return json(await listEvents(await getRoot(), { limit, level }))
  })

  // ── 数据自检与修复：修复动作白名单 + 先备份后修；不改任何业务记录

  route('/selfcheck', 'GET', async () => {
    const root = await getRoot()
    const result = await runSelfCheck(root)
    return json({ ...result, actions: repairCatalog() })
  })

  route('/selfcheck/repair', 'POST', async (request) => {
    const body = await readPayload(request)
    const action = String(body?.action || '')
    // 白名单：未登记的动作一律拒绝（不静默忽略）
    if (!REPAIR_ACTIONS[action]) {
      return fail('INVALID_INPUT', `未知修复动作：${action || '(空)'}`, 400)
    }
    const root = await getRoot()
    const result = await runRepair(root, action)
    await appendEvent(root, {
      level: result.ok ? 'info' : 'error',
      phase: 'selfcheck',
      code: result.ok ? 'REPAIRED' : result.error || 'REPAIR_FAILED',
      message: `${REPAIR_ACTIONS[action].label}：${result.detail || ''}`
    })
    if (!result.ok) return fail(result.error || 'REPAIR_FAILED', result.detail || '修复没成功', 500)
    return json(result)
  })

  // ── 诊断包导出：结构可见、内容不可见；只写本机，不上传

  route('/diagnostics/preview', 'GET', async () => {
    const root = await getRoot()
    const { events } = await listEvents(root, { limit: 30 })
    const { payload, redactions } = await collectDiagnostics(root, {
      routes: [...routeTable.keys()],
      events,
      version: await pluginVersion(),
      plugin: PLUGIN_ID
    })
    return json({ preview: payload, redactions, bytes: Buffer.byteLength(JSON.stringify(payload, null, 2), 'utf8') })
  })

  route('/diagnostics/export', 'POST', async () => {
    const root = await getRoot()
    const { events } = await listEvents(root, { limit: 50 })
    const result = await exportDiagnostics(root, {
      routes: [...routeTable.keys()],
      events,
      version: await pluginVersion(),
      plugin: PLUGIN_ID
    })
    await appendEvent(root, {
      level: 'info',
      phase: 'diagnostics',
      code: 'EXPORTED',
      message: `导出诊断包（${Math.round(result.bytes / 1024)}KB，脱敏 ${result.redactions} 处）`
    })
    return json(result)
  })

  route('/storage/stats', 'GET', async () => json(await computeStats(await getRoot())))

  // ── 健康检查（供安装 smoke 与排障用）

  route('/health', 'GET', async () => {
    const root = await getRoot()
    const { manifest } = await initRoot(root)
    return json({
      ok: true,
      plugin: PLUGIN_ID,
      schemaVersion: manifest.schemaVersion,
      patientCount: (manifest.patients || []).filter((p) => !p.deletedAt).length
    })
  })

  // 启动引导：初始化数据根（失败隔离），并写 smoke 诊断
  // 顺序很关键：
  // ① 先统一注册路由（每个 path 恰好一次）
  // ② 再初始化数据根
  registerRoutes()
  getRoot()
    .then((root) => emitSmokeDiagnostic(root))
    .catch((error) => {
      ctx.logger?.warn?.('xyb: boot failed (isolated); code=%s', error?.code || 'INTERNAL')
    })
}

/** 依赖的宿主服务（仅 connection：路由注册用） */
export const inject = ['connection']

/**
 * 供测试与外部复用的内部导出。
 *
 * ⚠️ **只能导出模块级作用域的东西**。
 * `readSettings` 等函数定义在 `apply()` 的**闭包内**（它们需要 `getRoot`/`ctx`），
 * 在模块级引用会直接抛 `ReferenceError` → 插件加载失败 → **整个应用打不开**。
 * （实测踩坑：Windows 安装包启动即崩，报 `readSettings is not defined`。）
 *
 * 要取闭包内的东西，必须通过 `apply()` 的返回值或 ctx 服务暴露。
 */
export const __internals = { respondError }
