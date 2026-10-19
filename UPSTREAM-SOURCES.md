# 上游源说明（两个上游）

> **本仓库不包含上游源码**。构建时由 `scripts/fetch-upstream.mjs` 按**锁定 commit** 取回上游，
> 再重放我们的受控改造（`patches/host-modifications.patch` +
> `patches/host-modifications.manifest.json`，逐文件 sha256 对账）。
> 下表是两个上游源的身份、许可，与**它们各自参与构建的方式**。
>
> **为什么上游源码不在仓库里**：它们是 MIT 授权的第三方作品，许可只要求**保留版权声明**
> （见 `THIRD-PARTY-NOTICES.md`），并不要求把源码再分发一遍。把它们留在仓库里会让体积涨很多倍，
> 且会让「我们的代码」与「上游的代码」混在同一棵历史里，审计时难以分辨谁是谁。
> 需要核对时，用上面的锁定值取回即可逐字节复现。

## 一、两个源

| 目录 | 项目 | 仓库 / 站点 | 许可 / 版权 | 我们与它的关系 | 参与构建 |
|---|---|---|---|---|---|
| `dsh-desktop-main/` | **DSH Desktop（官方）** | https://github.com/dataelement/dsh-desktop ｜ https://www.dshdesktop.com/ | MIT ｜ Copyright (c) 2026 **DataElement** | 我们改造的**宿主基线**（品牌化 / 打包 / 插件注册等改造逐项登记在 ） | ✅ 是（`prepare-vendor-plugins.mjs` 与 `npm run package:win` 只服务这个源） |
| `dsh-desktop-next/` | **DSH Desktop Next** | https://github.com/anywhere-labs/dsh-desktop ｜ https://www.dshdesktop.cn/ | MIT ｜ Copyright (c) 2026 **Anywhere Labs** | 上游项目；我们比对并优选移植其部分子系统（方案见 ） | ✅ 是（**仅取其许可原文**随安装包分发；其代码不参与构建） |

**共同上游**：两者都建立在 **DeepSeek Harness**（https://github.com/deepseek-ai/deepseek-harness，
MIT ｜ Copyright (c) 2026 **DeepSeek**）之上 —— 它们是**同一上游的兄弟项目**，不是「官方 → Next」的派生关系。
核查证据（可重跑）见 第五节。

```
DeepSeek Harness (MIT © DeepSeek)
        ├── DSH Desktop 官方 (MIT © DataElement) ──→ 小胰宝社区版（本发行版，在其之上受控改造）
        └── DSH Desktop Next (MIT © Anywhere Labs) ──→ 优选移植的功能片段（逐项登记）
```

## 二、同步方式

上游的取回与同步全部集中在 **`scripts/fetch-upstream.mjs`**（仓库地址与锁定 commit 都在那里登记）：

| 源 | 锁定值记在哪 | 如何更新 |
|---|---|---|
| `dsh-desktop-main/` | `patches/host-modifications.manifest.json` 的 `baseline` / `upstreamVersion`（**单一真源**，fetch 脚本从那里读） | 改那里的锁定值 → `node scripts/fetch-upstream.mjs --force` → 按 §四「上游同步流程」逐项重新应用改造 → 重新生成 `patches/` |
| `dsh-desktop-next/` | `scripts/fetch-upstream.mjs` 的 `NEXT_PIN` | 同上；另有 `NEXT_LICENSE_SHA256` 做**内容校验**——我们随包转达的是那份许可，commit 只是手段 |

> ⚠️ 两者的取回都是 **fail-closed**：锁定的 commit 取不到就回退按 tag/分支取；
> 但无论走哪条路径，`dsh-desktop-main` 必须通过改造后的逐文件 sha256 对账，
> `dsh-desktop-next` 必须通过许可原文的 sha256 校验 —— **对不上就构建失败**，不静默降级。

## 三、硬规则

1. **不修改 `dsh-desktop-next/` 的任何文件** —— 它是参考源；要用的东西移植到 `packages/` 里，并逐项登记。
2. 从 Next 移植的任何代码片段，必须登记在两个地方：
   - （方案与测试）
   - `THIRD-PARTY-NOTICES.md` 第二章「已移植片段登记」表（来源文件 / 移植日期 / 改动说明）
3. `dsh-desktop-main/` 的任何改造都必须先进 ，并体现为
   `patches/host-modifications.patch` 里的一处改动；由 `scripts/check-vendor-modifications.mjs`
   读 `patches/host-modifications.manifest.json` 交叉核对（零遗漏）。
4. 许可文本随安装包分发（六件套，含两个上游源与青囊）见 `THIRD-PARTY-NOTICES.md` 第七章；
   `scripts/verify-install.mjs` 会在**已安装应用**上逐项断言。
