/**
 * 数据根初始化的有界重试 —— 单元测试。
 *
 * 由来（真实观测，见 AGENTS.md 踩坑记录）：并行回归时 `probe-dir` 偶发返回
 * 500「内部错误」。根因不是探测逻辑，而是 `getRoot()` 第一次初始化（真写文件）
 * 偶发失败 —— 一次瞬时失败被直接放大成「界面报错」。
 *
 * 修复策略：**有界重试**（默认 2 次），持续故障原样抛出。
 * 本文件钉住四个语义：
 *  · 第一次成功 → 只调用一次（不产生多余 IO）
 *  · 第一次失败、第二次成功 → 返回成功值
 *  · 一直失败 → 抛出**最后一次**的错误，且尝试次数恰好受限（不无限重试）
 *  · attempts=1 → 只试一次（调用方可显式关掉重试）
 *
 * ⚠️ 探针记录（§5.4.3）：修复前 `bootWithRetry` 不存在、`getRoot` 无重试 →
 *    「失败一次后仍能成功」的用例必红。
 */
import { strict as assert } from 'node:assert'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(join(HERE, '..', '..'))
const MODULE = pathToFileURL(join(REPO_ROOT, 'packages', 'dsh-xyb-workbench', 'lib', 'store', 'root.js')).href

test('[数据根] 第一次就成功时只调用一次', async () => {
  const { bootWithRetry } = await import(MODULE)
  const calls = []
  const value = await bootWithRetry(async () => {
    calls.push(1)
    return 'root'
  })
  assert.equal(value, 'root')
  assert.equal(calls.length, 1, '成功路径不得重复初始化（重复写 manifest 是真实副作用）')
})

test('[数据根] 瞬时失败一次后成功：返回成功值', async () => {
  const { bootWithRetry } = await import(MODULE)
  let calls = 0
  const value = await bootWithRetry(async () => {
    calls += 1
    if (calls === 1) {
      const error = new Error('EBUSY: 被占用')
      error.code = 'EBUSY'
      throw error
    }
    return '/data'
  })
  assert.equal(value, '/data')
  assert.equal(calls, 2)
})

test('[数据根] 持续失败：抛出最后一次错误，且尝试次数受限', async () => {
  const { bootWithRetry } = await import(MODULE)
  let calls = 0
  await assert.rejects(
    () =>
      bootWithRetry(async () => {
        calls += 1
        const error = new Error(`EACCES 第 ${calls} 次`)
        error.code = 'EACCES'
        throw error
      }),
    (error) => {
      assert.equal(error.code, 'EACCES')
      assert.match(error.message, /第 2 次/, '必须抛最后一次的错误（不是第一次的）')
      return true
    }
  )
  assert.equal(calls, 2, '默认只重试一次：不允许无限重试把持续故障拖成假死')
})

test('[数据根] attempts=1 时关闭重试', async () => {
  const { bootWithRetry } = await import(MODULE)
  let calls = 0
  await assert.rejects(() =>
    bootWithRetry(async () => {
      calls += 1
      throw new Error('boom')
    }, 1)
  )
  assert.equal(calls, 1)
})
