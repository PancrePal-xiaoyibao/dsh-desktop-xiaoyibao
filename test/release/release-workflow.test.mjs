/**
 * 发布流水线的配置断言（**本仓发布口径** · ）。
 *
 * ── 为什么用「配置断言」而不是跑一遍 CI ──────────────────────────
 * CI 需要目标平台 runner（macOS / Windows），本地跑不起来。
 * 但**语义**可以在本地钉死 —— 而下面这些语义一旦被改坏，后果是
 * 「发版发到别处」「全绿却零 Release」这类**不可逆事故**。
 *
 * ── 钉住的六条（每条都有真实事故支撑）──────────────────────────
 * ① 触发语义：只有 push tag `v*`（+ 手动触发）；日常提交不发版
 * ② 发布目标：Release 发在**本仓** —— 不得出现任何外部仓库或外部 PAT
 * （旧的双仓镜像模型已废除：镜像仓被删除后，那条链路永远发不出 Release）
 * ③ 门控自洽：`publish` 的 if **不得**依赖 `needs.*.outputs.*`
 * ——output 只在同一次 attempt 内有效，重跑时取到空值 ⇒ 静默跳过。
 * 实测：九个 job 全绿、却一个 Release 都没有。
 * ④ 手动触发不发版：以 `release_tag != ''` 为判据
 * ⑤ 发行资产完整：macos-*（矩阵）/ windows-x64 / version-index 都要下载并上传
 * ⑥ 权限显式：发布 job 必须声明 `contents: write`（GITHUB_TOKEN 默认只读）
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const WORKFLOW = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8')

/**
 * 解析 workflow。
 * 依赖显式声明：js-yaml 在根 package.json 的 devDependencies，由 CI 的 `npm ci` 提供。
 * （曾经从宿主目录借 —— 本地绿、CI MODULE_NOT_FOUND，见 AGENTS.md P-38。）
 */
function loadWorkflow() {
  const yaml = require('js-yaml')
  return yaml.load(WORKFLOW)
}

/** 旧双仓模型的镜像仓名：**任何位置都不应再出现**。 */
const RETIRED_MIRROR_REPO = 'PancrePal-xiaoyibao/dsh-desktop-xiaoyibao-release'

test('[发布流水线] YAML 可解析，job 齐全，且旧镜像 job 已移除', () => {
  const doc = loadWorkflow()
  for (const job of ['guard', 'macos', 'windows', 'smoke-macos', 'smoke-windows', 'index', 'publish', 'summary']) {
    assert.ok(doc.jobs[job], `缺少 job：${job}`)
  }
  assert.equal(doc.jobs['sync-public'], undefined, 'sync-public 必须已移除（镜像仓模型作废）')
})

test('[发布流水线] 触发语义：只有 push tag v*（日常提交不发版）+ 手动触发', () => {
  const doc = loadWorkflow()
  assert.deepEqual(doc.on?.push?.tags, ['v*'], 'tag 触发必须是 v*')
  assert.equal(doc.on.push.branches, undefined, '不得在分支 push 上触发发布')
  assert.ok(doc.on.workflow_dispatch, '保留手动触发（内测：只出 run 产物，不发版）')
})

test('[发布流水线] 发布目标是**本仓**：不得出现任何外部仓库或外部 PAT', () => {
  const doc = loadWorkflow()
  const publish = doc.jobs.publish
  const releaseSteps = publish.steps.filter((s) => String(s.uses || '').includes('action-gh-release'))
  assert.equal(releaseSteps.length, 1, '必须且只能有一个发布步骤')
  const step = releaseSteps[0]
  assert.equal(step.with.repository, undefined, '不得指定外部 repository（应发在本仓）')
  assert.equal(String(step.with.token).includes('secrets.'), false, '不得依赖仓库 secret（用工作流自带 token）')
  assert.match(String(step.with.token), /github\.token/, '必须用 github.token')
  assert.ok(String(step.with.files).includes('release-assets/*'), '必须上传全部发行资产')
  assert.ok(!WORKFLOW.includes(RETIRED_MIRROR_REPO), `全文件不得再引用已删除的镜像仓：${RETIRED_MIRROR_REPO}`)
})

test('[发布流水线] 门控自洽：publish 不得依赖 needs.*.outputs.*（重跑静默跳过的回归）', () => {
  const doc = loadWorkflow()
  const condition = String(doc.jobs.publish.if || '')
  // ⚠️ 这条是真实事故的回归：九个 job 全绿，却因 output 跨 attempt 丢失而零 Release。
  assert.equal(
    /needs\.[A-Za-z0-9_-]+\.outputs\./.test(condition),
    false,
    'publish 的门控出现了 needs.*.outputs.* —— 重跑时该值会丢失，导致静默跳过发布'
  )
  assert.ok(condition.includes('always()'), '多重依赖下必须用 always() 保证条件仍被求值')
})

test('[发布流水线] 手动触发不发版：以「push tag」为判据（不读跨 job 数据）', () => {
  const doc = loadWorkflow()
  const condition = String(doc.jobs.publish.if || '')
  // 判据必须是 **github 上下文**（自洽），而不是 needs.guard.outputs.*（跨 attempt 会丢）。
  assert.match(condition, /github\.event_name == 'push'/, '必须以事件类型判定「是否发版」')
  assert.match(condition, /startsWith\(github\.ref, 'refs\/tags\/v'\)/, '必须以 ref 前缀判定「是否 tag 推送」')
  assert.equal(doc.jobs.publish.permissions?.contents, 'write', '发布必须显式声明 contents: write')
  // tag 名同样取自 ref，不读 job output
  const step = doc.jobs.publish.steps.find((s) => String(s.uses || '').includes('action-gh-release'))
  assert.match(String(step.with.tag_name), /github\.ref_name/, 'tag 名取自 github.ref_name')
})

test('[发布流水线] 发行资产完整：macos 矩阵 + windows 矩阵 + linux + 版本索引', () => {
  const doc = loadWorkflow()
  const publish = doc.jobs.publish
  const downloads = publish.steps.filter((s) => String(s.uses || '').includes('download-artifact'))
  const names = downloads.map((s) => String(s.with.name ?? s.with.pattern))
  assert.ok(names.some((n) => n === 'macos-*'), `必须按矩阵下载 macOS 产物，实际 ${JSON.stringify(names)}`)
  assert.ok(names.some((n) => n === 'windows-*'), `必须按矩阵下载 Windows 产物，实际 ${JSON.stringify(names)}`)
  assert.ok(names.some((n) => n === 'linux-*'), `必须按矩阵下载 Linux 产物，实际 ${JSON.stringify(names)}`)
  assert.ok(names.includes('version-index'), '必须下载版本索引（供校验与下载页使用）')
  // 产物可能单平台缺失（单平台触发），不得因此失败
  for (const step of downloads) {
    assert.equal(step.with['if-no-files-found'], 'ignore', '单平台触发时产物可能缺失，必须显式 ignore 而非失败')
  }
})
