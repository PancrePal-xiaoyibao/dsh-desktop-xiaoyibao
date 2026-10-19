/**
 * 数据根解析适配器。
 *
 * 为什么独立成文件：青囊嵌入插件必须能**独立安装**（不依赖 dsh-xyb-workbench 包）。
 * 因此这里自己实现一份最小解析（与 的 root.js 语义一致，但不跨包 import）。
 *
 * 优先级：XYB_DATA_ROOT（测试用） → config.root（dshHomePath('xyb')） → 兜底
 */
import { isAbsolute, join, resolve } from 'node:path'

export async function resolveDataRoot(configRoot) {
  const fromEnv = process.env.XYB_DATA_ROOT
  if (fromEnv) return resolve(fromEnv)
  if (typeof configRoot === 'string' && configRoot.trim()) {
    return isAbsolute(configRoot) ? configRoot : resolve(configRoot)
  }
  return join(process.cwd(), '.xyb-data')
}
