/**
 * 品牌合规断言测试。 SPEC §4.4（V-4）+ PRD US-0051 / US-0052。
 *
 * 断言 A-1 ~ A-6：
 * A-1 上游 LICENSE 原文保留（MIT + DataElement 版权行）
 * A-2 关于页/文档含「社区发行版，非官方产品」
 * A-3 含上游仓库地址
 * A-4 含上游版权声明
 * A-5 零指向官方更新源（配置文件中不得有 dshdesktop.com 的更新地址）
 * A-6 零误导性表述（除否定式说明）
 *
 * 注意 A-5 的精确语义：
 * 配置里不能有，但**文档里必须有**（否则无法审计「改造前原值是什么」）。
 * 因此本测试只扫「可执行配置」，不扫 tasks/ 立项文档。
 */
import { test } from 'node:test'
import { releaseShapeReason } from '../../../../scripts/lib/release-shape.mjs'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// 路径层级：compliance → test → dsh-xyb-branding → packages → <repo root>
const REPO_ROOT = resolve(join(HERE, '..', '..', '..', '..'))
const VENDOR = join(REPO_ROOT, 'vendor', 'dsh-desktop-main')

/**
 * 这些断言全部依赖 `vendor/`（上游源码与配置）。
 * 社区版公开发布时仓库不跟踪 vendor/ —— 那种形态下必须**显式跳过**（写明不适用），
 * 而不是让社区用户 clone 下来就跑出一片红。
 */
const RELEASE_SHAPE = releaseShapeReason(REPO_ROOT)
const vendorTest = (name, fn) => test(name, (t) => (RELEASE_SHAPE ? t.skip(RELEASE_SHAPE) : fn(t)))

async function readIfExists(path) {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

// ───────────────────────────── A-1 上游 LICENSE 保留

vendorTest('A-1：上游 LICENSE 原文保留（MIT + DataElement 版权行）', async () => {
  const license = await readIfExists(join(VENDOR, 'LICENSE'))
  assert.ok(license, 'vendor/dsh-desktop-main/LICENSE 必须存在')
  assert.match(license, /MIT License/, '必须保留 MIT License 原文')
  assert.match(license, /Copyright \(c\) 2026 DataElement/, '必须保留上游版权行（MIT 合规要求）')
})

// ───────────────────────────── A-2 社区版标识

vendorTest('A-2：品牌插件含「社区发行版，非官方产品」标识', async () => {
  const client = await readIfExists(join(REPO_ROOT, 'packages', 'dsh-xyb-branding', 'client.js'))
  assert.ok(client, '品牌插件客户端必须存在')
  assert.match(client, /社区发行版，非官方产品/, '必须显式标注社区版身份（商标合规）')
})

// ───────────────────────────── A-3 / A-4 上游归属

vendorTest('A-3 / A-4：品牌插件含上游名称与许可声明', async () => {
  const client = await readIfExists(join(REPO_ROOT, 'packages', 'dsh-xyb-branding', 'client.js'))
  assert.match(client, /DSH Desktop/, '必须提及上游名称')
  assert.match(client, /MIT License/, '必须声明上游许可')
  assert.match(client, /DataElement/, '必须声明上游版权方')
})

// ───────────────────────────── A-5 零指向官方更新源

vendorTest('A-5：build.publish 已置空（不指向官方更新源）', async () => {
  const raw = await readIfExists(join(VENDOR, 'package.json'))
  const pkg = JSON.parse(raw)
  const publish = pkg.build?.publish
  assert.deepEqual(publish, [], 'publish 必须为空数组')
})

vendorTest('A-5：可执行配置中不得出现官方更新源地址', async () => {
  // 只扫「可执行配置」，不扫立项文档（文档里必须记录改造前原值，否则无法审计）
  const configFiles = [
    join(VENDOR, 'package.json'),
    join(VENDOR, 'electron-builder.dev.cjs')
  ]
  for (const file of configFiles) {
    const text = await readIfExists(file)
    if (!text) continue
    assert.ok(
      !text.includes('dshdesktop.com'),
      `${file} 不得含官方更新源地址（会造成版本冲突与数据回流官方）`
    )
  }
})

// ───────────────────────────── 发行版身份

vendorTest('发行版身份：appId 与官方隔离', async () => {
  const pkg = JSON.parse(await readIfExists(join(VENDOR, 'package.json')))
  assert.equal(pkg.build.appId, 'com.pancrepal.xyb.desktop', 'appId 必须与官方 io.dsh.desktop 不同')
  assert.notEqual(pkg.build.appId, 'io.dsh.desktop', '不得沿用官方 appId')
  assert.equal(pkg.build.productName, '小胰宝社区版')
})

vendorTest('开发版身份：与官方版、社区正式版三方隔离', async () => {
  const dev = await readIfExists(join(VENDOR, 'electron-builder.dev.cjs'))
  assert.match(dev, /com\.pancrepal\.xyb\.desktop\.dev/, 'dev appId 必须独立')
  assert.match(dev, /小胰宝社区版 Dev/, 'dev 产品名必须独立')
  // 只检查**生效的 appId 赋值行**，不检查注释（注释里会提到改造前的原值，属正常）
  const appIdLine = dev.split('\n').find((l) => /^\s*appId:/.test(l) && !l.trim().startsWith('//'))
  assert.ok(appIdLine, '必须能找到生效的 appId 赋值行')
  assert.ok(!appIdLine.includes('io.dsh.desktop'), `生效的 appId 不得为官方值：${appIdLine.trim()}`)
})

// ───────────────────────────── 插件注册（改造正确性）

vendorTest('patch.yml 已注册三个社区版插件', async () => {
  const patch = await readIfExists(join(VENDOR, 'build', 'dsh-desktop.patch.yml'))
  assert.match(patch, /dsh-xyb-branding/, '必须注册品牌插件')
  assert.match(patch, /dsh-xyb-workbench/, '必须注册工作台插件')
  assert.match(patch, /dsh-xyb-qingnang/, '必须注册青囊插件')
  // insert 的 name 必须是包名（不能是路径）
  assert.ok(!/name:\s*[./]/.test(patch), 'insert 的 name 必须是包名，不能写路径（上游踩坑 P-05）')
})

vendorTest('patch.yml 为工作台与青囊注入数据根（dshHomePath）', async () => {
  const patch = await readIfExists(join(VENDOR, 'build', 'dsh-desktop.patch.yml'))
  const matches = patch.match(/dshHomePath\('xyb'\)/g) || []
  assert.equal(matches.length, 2, '工作台与青囊各需一条 root 配置')
})

// ───────────────────────────── asarUnpack（青囊需解包）

vendorTest('asarUnpack 含青囊规则（子进程启动需在 asar 之外）', async () => {
  const pkg = JSON.parse(await readIfExists(join(VENDOR, 'package.json')))
  const unpack = pkg.build.asarUnpack || []
  const qingnangRules = unpack.filter((r) => String(r).includes('dsh-xyb-qingnang'))
  assert.ok(qingnangRules.length >= 5, `青囊解包规则应 ≥5 条，实际 ${qingnangRules.length} 条`)
  assert.ok(
    qingnangRules.some((r) => r.includes('scripts')),
    '必须解包 scripts（青囊入口脚本要能被 spawn）'
  )
  assert.ok(
    qingnangRules.some((r) => r.includes('vendor/node_modules')),
    '必须解包离线依赖（含原生模块 .node）'
  )
})

// ───────────────────────────── 插件进产物的机制（实测踩坑后修正）

vendorTest('插件进产物靠 files 映射（from 必须是**项目内**路径）', async () => {
  const pkg = JSON.parse(await readIfExists(join(VENDOR, 'package.json')))
  const files = pkg.build.files || []

  const mappings = files.filter(
    (f) => typeof f === 'object' && String(f.from || '').includes('dsh-xyb-')
  )
  assert.equal(mappings.length, 3, '三个插件各需一条 files 映射')

  for (const m of mappings) {
    // ⚠️ 实测踩坑：`from` **不能用 ../ 指向仓库外**。
    // electron-builder 的 from 基准不是 package.json 所在目录，
    // 用 `../packages/...` 会解析到 vendor/packages/（不存在）→ 静默跳过
    // → 产物里没有插件 → 宿主找不到 → 首屏不是小胰宝。
    assert.ok(
      !m.from.startsWith('../'),
      `files 映射的 from 不得用 ../ 指向仓库外（实测会静默失败）：${m.from}`
    )
    assert.ok(
      m.from.startsWith('packages/'),
      `files 映射的 from 应为项目内 packages/ 路径（与上游 dsh-ppt 写法一致）：${m.from}`
    )
    assert.ok(m.to.startsWith('node_modules/'), `映射目标必须在 node_modules 内：${m.to}`)
  }

  // 默认收集规则必须存在
  assert.ok(
    files.some((f) => f === 'node_modules/**/*'),
    'files 必须含 node_modules/**/*'
  )
})

vendorTest('就位脚本把插件放到 vendor 项目内的 packages/（供 files 映射取源）', async () => {
  const script = await readIfExists(join(REPO_ROOT, 'scripts', 'prepare-vendor-plugins.mjs'))
  assert.ok(script, 'scripts/prepare-vendor-plugins.mjs 必须存在')
  assert.match(script, /dsh-xyb-branding/, '必须就位品牌插件')
  assert.match(script, /dsh-xyb-workbench/, '必须就位工作台插件')
  assert.match(script, /dsh-xyb-qingnang/, '必须就位青囊插件')
  assert.match(script, /--check/, '必须支持 --check 校验模式')
  // 目标必须是 vendor 项目内的 packages/（不是 node_modules）
  assert.match(script, /VENDOR_PACKAGES/, '就位目标应为 vendor 项目内的 packages/')
})

vendorTest('vendor/.gitignore 忽略就位目录（避免重复提交 56MB 快照）', async () => {
  const ignore = await readIfExists(join(VENDOR, '.gitignore'))
  assert.ok(ignore, 'vendor/.gitignore 必须存在')
  for (const name of ['dsh-xyb-branding', 'dsh-xyb-workbench', 'dsh-xyb-qingnang']) {
    assert.ok(
      ignore.includes(`/packages/${name}/`),
      `vendor/.gitignore 必须忽略就位目录 /packages/${name}/`
    )
  }
})

vendorTest('发行版版本号用社区独立编号（不与上游编号混用）', async () => {
  const pkg = JSON.parse(await readIfExists(join(VENDOR, 'package.json')))
  // 社区编号从 v0.0.1 起算；当前首次公开发布为 v0.1.0。
  // 上游内部编号是 0.1.1（对外 v0.11.1），绝不能混用（会与官方版本比较/更新串线）。
  assert.notEqual(pkg.version, '0.1.1', '不得使用上游内部编号')
  assert.match(pkg.version, /^0\.\d+\.\d+$/, `版本号必须是社区 SemVer，实际 ${pkg.version}`)
  assert.equal(pkg.version, '0.1.0', '当前社区版本（每次发布同步本断言与 MODIFICATIONS.md 2.1）')
})

vendorTest('NSIS 产物名含社区标识（nsis.artifactName 会覆盖 artifactName）', async () => {
  const pkg = JSON.parse(await readIfExists(join(VENDOR, 'package.json')))
  const nsisName = pkg.build.nsis?.artifactName || ''
  assert.ok(
    nsisName.includes('xyb-desktop-community'),
    `nsis.artifactName 必须含社区标识（它覆盖 build.artifactName），实际：${nsisName}`
  )
})
