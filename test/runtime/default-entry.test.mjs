/**
 * 默认入口回归测试 —— 「打开即小胰宝面板」的插件层机制。
 *
 * 由来（实测，2026-10-16）：
 *   宿主的工作台状态里 `active` 默认是 null → 应用打开落在宿主会话页，
 *   而不是小胰宝面板。解决：客户端插件在**首次运行**调用宿主的官方 API
 *   `desktopWorkbenches.open(id)` 把本工作台设为激活；此后打开就是面板。
 *
 * 本测试钉住的四件事（缺一个都可能把用户锁死或反复侵占）：
 *   ① 首次运行：用 repository 找到自己的 id 并 open 一次 + 打标记
 *   ② 已有 active：不抢占（只补标记）
 *   ③ 已打过标记：完全不动作（连订阅都不做）
 *   ④ 服务面缺失（旧宿主/测试替身）：不抛错（静默降级）
 */
import { strict as assert } from 'node:assert'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { mountClient } from '../../scripts/lib/client-sandbox.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))

const REPOSITORY = 'https://github.com/PancrePal-xiaoyibao/dsh-desktop-xiaoyibao'
const WORKBENCH_ID = 'pancrepal-xiaoyibao/dsh-desktop-xiaoyibao'

/** 假 localStorage：记录读写，行为对齐 Web Storage 子集。 */
function createFakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data
  }
}

/** 宿主 desktopWorkbenches 服务的最小真规则替身（只实现本机制用到的面）。 */
function createFakeWorkbenchService({ active = null, ready = true, entries = [{ id: WORKBENCH_ID, repository: REPOSITORY }] } = {}) {
  const listeners = new Set()
  const opened = []
  const registered = []
  const state = { active }
  return {
    ready,
    state,
    catalog: new Map(entries.map((entry) => [entry.id, entry])),
    // 插件入口注册（本测试不关心内容，但 apply() 会先调它）
    register(spec, Component) {
      registered.push({ spec, Component })
      return () => {}
    },
    registered,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot() {
      return { ready, state }
    },
    open(id) {
      opened.push(id)
      state.active = id
      return Promise.resolve()
    },
    opened,
    listeners,
    publish() {
      for (const listener of listeners) listener()
    }
  }
}

const flush = () => new Promise((r) => setImmediate(r))

test('[默认入口] 首次运行：激活本工作台并打标记', async () => {
  const storage = createFakeStorage()
  const service = createFakeWorkbenchService()
  mountClient(REPO_ROOT, 'dsh-xyb-workbench', {
    ctxExtra: { desktopWorkbenches: service },
    windowExtra: { localStorage: storage }
  })
  await flush()
  assert.deepEqual(service.opened, [WORKBENCH_ID], '首次运行必须 open 本工作台（用 repository 解析出的 id）')
  assert.equal(storage.getItem('xyb:default-entry:v1'), '1', '成功后必须打「只做一次」标记')
})

test('[默认入口] 已有 active：不抢占，只补标记', async () => {
  const storage = createFakeStorage()
  const service = createFakeWorkbenchService({ active: 'someone/else' })
  mountClient(REPO_ROOT, 'dsh-xyb-workbench', {
    ctxExtra: { desktopWorkbenches: service },
    windowExtra: { localStorage: storage }
  })
  await flush()
  assert.deepEqual(service.opened, [], '用户已有选择时不得抢占')
  assert.equal(storage.getItem('xyb:default-entry:v1'), '1', '应补标记，避免以后反复判断')
})

test('[默认入口] 已打过标记：完全不动作（连订阅都不做）', async () => {
  const storage = createFakeStorage({ 'xyb:default-entry:v1': '1' })
  const service = createFakeWorkbenchService()
  mountClient(REPO_ROOT, 'dsh-xyb-workbench', {
    ctxExtra: { desktopWorkbenches: service },
    windowExtra: { localStorage: storage }
  })
  await flush()
  assert.deepEqual(service.opened, [], '标记存在时不得再激活')
  assert.equal(service.listeners.size, 0, '标记存在时连订阅都不该建立')
})

test('[默认入口] 服务面缺失（旧宿主/测试替身）：不抛错', () => {
  // 不传 ctxExtra → mountClient 用默认替身（只有 register）
  assert.doesNotThrow(() => {
    mountClient(REPO_ROOT, 'dsh-xyb-workbench', {})
  })
})

test('[默认入口] open 失败：不污染标记，允许稍后重试', async () => {
  const storage = createFakeStorage()
  const service = createFakeWorkbenchService()
  service.open = (id) => {
    service.opened.push(id)
    return Promise.reject(new Error('工作台功能已关闭。'))
  }
  mountClient(REPO_ROOT, 'dsh-xyb-workbench', {
    ctxExtra: { desktopWorkbenches: service },
    windowExtra: { localStorage: storage }
  })
  await flush()
  assert.deepEqual(service.opened, [WORKBENCH_ID], '应尝试一次')
  assert.equal(storage.getItem('xyb:default-entry:v1'), null, '失败时不得打标记（否则永远不再尝试）')
  // 宿主稍后就绪 → publish 触发重试
  service.open = (id) => {
    service.opened.push(id)
    return Promise.resolve()
  }
  service.publish()
  await flush()
  assert.deepEqual(service.opened, [WORKBENCH_ID, WORKBENCH_ID], 'publish 后应重试并成功')
  assert.equal(storage.getItem('xyb:default-entry:v1'), '1', '重试成功后打标记')
})
