/**
 * 设计 token 检查器探针自检。
 *
 * 规则：新检查器必须证明「能抓到」+「零误报」——
 * · 真源码 → findings 为空（零误报）；
 * · 每一种违规（裸色值 / 缺 token / 少交互态 / 无 token 块）→ 必须报出来。
 *
 * 没有探针的检查器不算检查器：它可能一直静默失效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeTokens, REQUIRED_TOKENS } from '../../scripts/check-ui-tokens.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const CLIENT = join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'client.js')
const truth = readFileSync(CLIENT, 'utf8')

test('[tokens] 真源码零误报', () => {
  assert.deepEqual(analyzeTokens(truth), [], 'client.js 必须通过 token 检查')
  assert.ok(REQUIRED_TOKENS.length >= 30, 'token 清单本身不能缩水')
})

test('[tokens] 探针：裸十六进制色被抓到', () => {
  const bad = truth.replace('.xybBrandLogo {', '.xybBrandLogo { background:#ff00ff;')
  assert.notEqual(bad, truth, '探针替换必须生效（否则是假探针）')
  const findings = analyzeTokens(bad)
  assert.ok(
    findings.some((f) => f.code === 'RAW_HEX' && f.detail.includes('#ff00ff')),
    `应报 RAW_HEX，实际：${JSON.stringify(findings)}`
  )
})

test('[tokens] 探针：删掉必需 token 被抓到', () => {
  const bad = truth.replace('--xyb-green:#0F7C72;', '')
  assert.notEqual(bad, truth)
  assert.ok(
    analyzeTokens(bad).some((f) => f.code === 'MISSING_TOKEN' && f.detail === '--xyb-green'),
    '应报 --xyb-green 缺失'
  )
})

test('[tokens] 探针：少掉 reduced-motion / 禁用态被抓到', () => {
  const noMotion = truth.replace('prefers-reduced-motion', 'prefers-reduced-transparency')
  assert.ok(analyzeTokens(noMotion).some((f) => f.code === 'MISSING_FEATURE' && f.detail.includes('prefers-reduced-motion')))
})

test('[tokens] 探针：少掉按钮档位被抓到', () => {
  const bad = truth.replace('.xybBtn--ghost {', '.xybBtnX {')
  assert.notEqual(bad, truth, '探针替换必须生效')
  assert.ok(analyzeTokens(bad).some((f) => f.code === 'MISSING_FEATURE' && f.detail.includes('.xybBtn--ghost')))
})

test('[tokens] 空源码 / 无 token 块都不静默通过', () => {
  assert.ok(analyzeTokens('').length > 0, '空源码必须报错')
  assert.ok(
    analyzeTokens('const CSS = `x`\n').some((f) => f.code === 'NO_TOKEN_BLOCK'),
    '无 :root 块必须报错'
  )
})
