#!/usr/bin/env node
/**
 * 把 7 个 MCP 及其完整依赖闭包 vendor 进本仓库的 vendor/node_modules/。
 *
 * 为什么必须是 vendor/node_modules/ 而不是 vendor/mcp/（ADR-015 踩坑）：
 *   Node 解析 `import 'dotenv'` 时，从文件所在目录逐级向上，在每个祖先目录 D 里
 *   查 `D/node_modules/dotenv`。包放 vendor/node_modules/<pkg>/ 时，祖先 vendor
 *   正好提供 `vendor/node_modules/✓`；若放 vendor/mcp/<pkg>/，祖先里没有任何叫
 *   node_modules 的目录，解析立即失败。
 *
 * 目的（ADR-015）：让「一次 clone → 立刻可用」成立，不依赖 npm 网络。
 *
 * 为什么不是 git submodule / 只存 lockfile：
 *   - submodule 仍需网络且要逐个子仓拉
 *   - lockfile 仍需 npm registry（代理不稳时部署会挂）
 * 本脚本把**已装好的可运行树**整体拷进仓库 —— 因为它已经跑通过一次。
 *
 * 用法：
 *   node scripts/vendor-mcp.mjs                # 从 node_modules 拷到 vendor/node_modules
 *   node scripts/vendor-mcp.mjs --verify       # 只校验 vendor 是否完整（不写）
 *   node scripts/vendor-mcp.mjs --size         # 只看体积构成
 */
import { readdir, readFile, writeFile, rm, mkdir, cp } from 'node:fs/promises';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'node_modules');
const DST = join(ROOT, 'vendor', 'node_modules');
const args = new Set(process.argv.slice(2));
const VERIFY = args.has('--verify');
const SIZEONLY = args.has('--size');

const C = {
  d: '\x1b[2m', r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', r2: '\x1b[31m', b: '\x1b[36m',
};
const say = (s) => console.log(s);
const ok = (s) => console.log(`${C.g}  ✓${C.rst ?? C.r} ${s}`);
const err = (s) => console.log(`${C.r2}  ✗${C.r} ${s}`);

const HUMAN = (b) => b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(0)}K` : `${(b / 1048576).toFixed(1)}M`;

/* ─────────────────────────── 裁剪规则（ADR-015） ───────────────────────────
 *
 * 三个约束同时成立：
 *   ① 跨平台：Windows / macOS / Linux 都要能用（含 arm64）
 *   ② 离线：clone 下来不跑 npm 就能起 MCP
 *   ③ 不虚胖：仓库体积不能失控
 *
 * 所以裁的是「运行时用不到的东西」，不裁平台二进制——
 * 保留 6 个目标平台的 koffi，才能让产物在别人的机器上直接跑。
 */

/** 全局排除：任何包里的这些东西运行时都用不到 */
const GLOBAL_EXCLUDE = [
  /\.map$/,                      // source map（~32M）
  /\.d\.(ts|mts|cts)$/,          // TS 类型声明（~2.8M）
  /\.ts$/,                       // 源码 .ts（运行时只跑编译产物）
  /(^|\/)__tests__($|\/)/,
  /(^|\/)tests?($|\/)/,
  /(^|\/)\.github($|\/)/,
  /\.(md|markdown)$/i,           // 文档（LICENSE 单独豁免）
  /\.(yml|yaml|editorconfig|eslintrc|prettierrc)$/,
  /(^|\/)\.(eslintrc|prettierrc|babelrc|nycrc)/,
  /(^|\/)tsconfig.*\.json$/,
];

/** 豁免：这些文件名即使匹配上面的规则也必须留 */
const KEEP_ALWAYS = [
  /(^|\/)LICENSE(\.[a-z]+)?$/i,
  /(^|\/)NOTICE(\.[a-z]+)?$/i,
  /(^|\/)README(\.[a-z]+)?$/i,
  /(^|\/)package\.json$/,
];

/** 保留的平台（koffi 原生二进制按平台分目录） */
const KEEP_PLATFORMS = new Set([
  'linux_x64', 'linux_arm64',
  'darwin_x64', 'darwin_arm64',
  'win32_x64', 'win32_arm64',
]);

/** pdf-parse 内置 4 个 pdf.js 版本，只用默认的 v1.10.100 */
const PDFJS_KEEP = 'v1.10.100';

/** 判断 vendor 时是否应跳过某文件 */
function shouldSkip(absPath) {
  const rel = relative(SRC, absPath).replace(/\\/g, '/');
  const base = rel.split('/').pop();

  if (KEEP_ALWAYS.some((re) => re.test(rel))) return false;   // 豁免优先

  // koffi：只留目标平台
  const koffiM = rel.match(/^koffi\/build\/koffi\/([^/]+)\//);
  if (koffiM) return !KEEP_PLATFORMS.has(koffiM[1]);

  // pdf-parse：只留默认 pdf.js 版本
  const pdfM = rel.match(/^pdf-parse\/lib\/pdf\.js\/([^/]+)\//);
  if (pdfM) return pdfM[1] !== PDFJS_KEEP;

  if (GLOBAL_EXCLUDE.some((re) => re.test(rel))) return true;
  return false;
}

/* ─────────────────────────── 依赖闭包计算 ─────────────────────────── */

/** 解析 package.json 的依赖名（只取生产依赖，跳过 peer/optional） */
function depsOf(pkgJson) {
  return Object.keys({
    ...(pkgJson.dependencies || {}),
    ...(pkgJson.optionalDependencies || {}),   // 必须带：如 koffi 的平台包
  });
}

/**
 * 从入口包出发，递归收集完整依赖闭包。
 * node_modules 是扁平化布局，所以「解析」= 逐级向上找最近的 node_modules/<name>。
 */
function closureOf(entryNames) {
  const seen = new Set();
  const missing = [];
  const queue = [...entryNames];

  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const dir = join(SRC, name);
    if (!existsSync(dir)) { missing.push(name); continue; }
    seen.add(name);

    const pj = join(dir, 'package.json');
    if (!existsSync(pj)) continue;
    let json;
    try { json = JSON.parse(readText(pj)); } catch { continue; }
    for (const d of depsOf(json)) {
      if (!seen.has(d)) queue.push(d);
    }
    // 嵌套 node_modules（老式布局残留）——注意 scope 包要拼成两段
    const nested = join(dir, 'node_modules');
    if (existsSync(nested)) {
      for (const n of readdirSync(nested)) {
        if (n.startsWith('@')) {
          for (const p of readdirSync(join(nested, n))) {
            queue.push(`${name}/node_modules/${n}/${p}`);
          }
        } else {
          queue.push(`${name}/node_modules/${n}`);
        }
      }
    }
  }
  return { seen: [...seen].sort(), missing };
}

function readText(p) {
  return readFileSync(p, 'utf8');
}

/* ─────────────────────────── 体积计算 ─────────────────────────── */

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { try { n += statSync(f).size; } catch {} }
    }
  };
  walk(p);
  return n;
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

const manifest = JSON.parse(readText(join(ROOT, 'mcp-servers', 'manifest.json')));
const all = [...manifest.servers, ...(manifest.reserved || [])];
const entries = all.map((s) => s.package);

say('');
say(`${C.b}青囊 · MCP vendor${C.r}`);

if (!existsSync(SRC)) {
  err(`node_modules 不存在 —— 先跑： node scripts/qingnang.mjs fetch`);
  process.exit(1);
}

say(`${C.d}┌ 计算依赖闭包（入口 ${entries.length} 个包）${C.r}`);
const { seen, missing } = closureOf(entries);

say(`${C.d}├ 入口包 ${entries.length} 个`);
say(`${C.d}├ 闭包共 ${seen.length} 个包`);
if (missing.length) {
  say(`${C.d}├ ${C.y}未解析到 ${missing.length} 个：${missing.join(', ')}${C.r}`);
}

// 体积清单
const sizes = seen
  .map((n) => ({ name: n, size: existsSync(join(SRC, n)) ? dirSize(join(SRC, n)) : 0 }))
  .sort((a, b) => b.size - a.size);
const total = sizes.reduce((a, b) => a + b.size, 0);

if (SIZEONLY) {
  say('');
  say(`  ${C.b}体积 top 15${C.r}`);
  for (const s of sizes.slice(0, 15)) say(`    ${s.name.padEnd(48)} ${HUMAN(s.size)}`);
  say(`    ${'─'.repeat(48)} ${'─'.repeat(8)}`);
  say(`    ${'合计'.padEnd(46)} ${HUMAN(total)}`);
  process.exit(0);
}

/* 校验模式 */
if (VERIFY) {
  say(`${C.d}├ 校验 vendor/node_modules …${C.r}`);
  if (!existsSync(DST)) { err(`vendor/node_modules 不存在 —— 跑：node scripts/vendor-mcp.mjs`); process.exit(1); }

  let bad = 0;
  const vseen = [];
  const walkV = (d, rel = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && rel === '' ) vseen.push(e.name);
      if (e.isDirectory()) walkV(join(d, e.name), join(rel, e.name));
    }
  };
  walkV(DST);

  for (const n of seen) {
    const p = join(DST, n, 'package.json');
    if (!existsSync(p)) { err(`缺包：${n}`); bad++; }
  }
  // 每个入口包必须能被 node 解析
  for (const s of all) {
    const p = join(DST, s.package, 'package.json');
    if (!existsSync(p)) { err(`入口包缺失：${s.package}`); bad++; continue; }
    const j = JSON.parse(readText(p));
    // 声明 bin 的必须有实体文件
    if (j.bin) {
      for (const [k, v] of Object.entries(j.bin)) {
        const bf = join(DST, s.package, v);
        if (!existsSync(bf)) { err(`${s.package} 的 bin ${k} 文件缺失：${v}`); bad++; }
      }
    }
  }
  const vsz = dirSize(DST);
  say(`${C.d}├ vendor/node_modules 内 ${vseen.length} 个顶层包，${HUMAN(vsz)}${C.r}`);
  if (bad) { err(`共 ${bad} 处缺失`); process.exit(1); }
  ok(`vendor 完整（${seen.length} 个包，${HUMAN(vsz)}）`);
  process.exit(0);
}

/* 写入模式 */
say(`${C.d}├ 目标：vendor/node_modules/${C.r}`);
await rm(join(ROOT, 'vendor'), { recursive: true, force: true });
await mkdir(DST, { recursive: true });

let copied = 0;
for (const n of seen) {
  const from = join(SRC, n);
  if (!existsSync(from)) continue;
  const to = join(DST, n);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, {
    recursive: true, force: true,
    filter: (src) => {
      const base = src.split('/').pop();
      if (base === '.bin') return false;
      if (base === '.DS_Store') return false;
      return !shouldSkip(src);
    },
  });
  copied++;
}

const finalSize = dirSize(DST);

// 写一份清单，供 serve 校验与审计
const report = {
  generated_by: 'scripts/vendor-mcp.mjs',
  source: 'node_modules (pnpm/npm 安装产物)',
  entry_packages: entries,
  package_count: seen.length,
  bytes: finalSize,
  strategy: '跨平台 vendor：保留 linux/darwin/win32 × x64/arm64 六平台原生二进制；裁掉 sourcemap/类型声明/测试/文档/非目标平台',
  kept_platforms: [...KEEP_PLATFORMS],
  kept_pdfjs_version: PDFJS_KEEP,
  packages: sizes.map((s) => ({ name: s.name, bytes: s.size })),
  missing: missing,
  license_note: '各包许可证随包保留（见各包目录内 LICENSE）。发行时须列明第三方许可。',
};
const repPath = join(ROOT, 'vendor', 'VENDOR.json');
await writeFile(repPath, JSON.stringify(report, null, 2) + '\n');

say(`${C.d}└ 完成${C.r}`);
say('');
ok(`已 vendor ${copied} 个包 → vendor/node_modules/（${HUMAN(finalSize)}）`);
say(`  ${C.d}清单：vendor/VENDOR.json${C.r}`);
say('');
say('  下一步：');
say('    node scripts/qingnang.mjs check          # 校验 vendor 完整性');
say('    node scripts/qingnang.mjs serve pubmed   # 直接从 vendor 起 MCP（无需网络）');
