/**
 * 目录可写探针。
 *
 * 由来（真实事故 P-35）：用户在 Windows 上选了工作目录，界面**零反应、无报错、无日志** ——
 * 真因是系统安全策略（受控文件夹访问/权限弹窗）拦住了目录创建。
 * 结论：**必须在用户当场能看到的时刻，把「这个目录能不能写」验一遍，并给出人能读懂的原因**，
 * 而不是等到后面某一步静默失败。
 *
 * 设计：
 * · 真写一个探针文件再删掉（不是只看目录是否存在 —— 只读目录照样「存在」）；
 * · 失败时把 errno 翻译成中文原因（权限 / 受控文件夹 / 磁盘满 / 只读 / 路径非法）；
 * · 返回绝对路径，便于用户确认「到底写在哪」。
 */
import { mkdir, statfs, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

/** errno → 用户能读懂的原因。 */
export function explainFsError(error) {
  const code = error?.code || ''
  const table = {
    EACCES: '系统不允许写入这个目录（权限不足，或目录被安全策略保护）',
    EPERM: '系统不允许写入这个目录（操作被权限策略拒绝）',
    EROFS: '这个目录所在的分区是只读的',
    ENOSPC: '磁盘空间不足',
    ENOENT: '路径不存在（可能是上级目录被删除）',
    ENOTDIR: '路径里有一段不是目录（可能同名文件挡住了）',
    EBUSY: '目录被其他程序占用',
    EEXIST: '同名文件已存在且不是目录',
    ENAMETOOLONG: '路径太长',
    EINVAL: '路径格式不合法'
  }
  return table[code] || `写入失败：${error?.message || '未知原因'}`
}

/**
 * 探测一个目录能否作为数据目录使用。
 *
 * @param {string} target 用户给出的路径
 * @returns {Promise<{ok: boolean, path: string, reason: string, code?: string, freeBytes?: number}>}
 */
export async function probeDirectory(target) {
  const path = resolve(String(target || '').trim())
  if (!String(target || '').trim()) {
    return { ok: false, path, reason: '没有给出路径', code: 'EMPTY_PATH' }
  }

  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    return { ok: false, path, reason: explainFsError(error), code: error?.code || 'MKDIR_FAILED' }
  }

  const probe = join(path, `.xyb-probe-${randomBytes(4).toString('hex')}`)
  try {
    await writeFile(probe, 'ok', 'utf8')
  } catch (error) {
    return { ok: false, path, reason: explainFsError(error), code: error?.code || 'WRITE_FAILED' }
  }

  // 探针能写成功就算通过；清理失败不算失败（临时文件会被自检的 clean-temp 收掉）
  await unlink(probe).catch(() => {})

  let freeBytes
  try {
    const info = await statfs(path)
    freeBytes = Number(info.bavail) * Number(info.bsize)
  } catch {
    /* 拿不到余量不影响结论 */
  }

  return { ok: true, path, reason: '可以正常读写', freeBytes }
}
