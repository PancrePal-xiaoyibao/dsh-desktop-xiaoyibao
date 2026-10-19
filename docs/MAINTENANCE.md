# 维护与发行手册

> 本文件面向**维护者与贡献者**，回答四件事：**仓库怎么组织 · 日常怎么开发 · 怎么验证 · 怎么发行**。
> 配套脚本都在 `scripts/`，每条命令都能直接复制执行。
>
> 面向贡献者的开发规范（PR 标准、CI 硬杠杆、踩坑记录、医学红线）见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)。

---

## 一、仓库模型：**单仓**

| 项 | 说明 |
|---|---|
| 仓库 | 本仓库即**发行仓**：源码、流水线、Release 与下载页都在这里 |
| 上游源码 | **不在仓库里**。构建时由 `scripts/fetch-upstream.mjs` 按**锁定 commit** 取回，再重放受控改造（`patches/`） |
| 开发侧档案 | 立项与验收档案、宿主机画像等**不随仓发布**（已在 `.gitignore` 中列出） |

**为什么上游源码不入库**：

- 上游是 MIT 授权的第三方作品，许可只要求**保留版权声明**（见 [`../THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)），
  并不要求把源码再分发一遍；
- 把它们留在仓库里会让体积涨很多倍，且会让「我们的代码」与「上游的代码」混在同一棵历史里，
  审计时难以分辨谁是谁；
- 构建可复现性由**锁定 commit + 逐文件 sha256 对账**保证，不靠"仓库里存一份"。

**上游版本与取回方式**：见 [`../UPSTREAM-SOURCES.md`](../UPSTREAM-SOURCES.md)。

---

## 二、日常开发流程

```
① 立项（项目档案，开发侧，不随仓发布）          ← 意图 / 产品 / 工程三层合同
② 实现（packages/ 插件层；对宿主的改造体现为 patches/ 里的一处改动）
③ 测试（新行为必须配能抓缺陷的测试；缺陷修复要验证「修复前会红」）
④ 门禁（§三 的全套命令，一条都不能跳）
⑤ 提交（显式列文件；一个逻辑单元一个 commit）
⑥ 重建索引（让代码图谱追上代码）
```

**硬约束（违反即打回）**：

- 医学安全六条红线（不诊断 / 不处方 / 不解读量表 / 不替医生判定 / 危机兜底 / 一切可溯源）；
- **人工闸门**：未核对的数据不得进入趋势、看板、计算（查询层强制过滤）；
- **方向语义**：颜色由指标方向决定，不由箭头方向决定；
- 客户端必须是宿主 `__ModuleLoader__` 形态（零 import、零 JSX、无构建步骤）；
- 宿主改造只允许「配置 / 品牌资产 / 插件注册 / 打包参数」四类，且逐项登记可回退；
- 不把真实病历、姓名、医院、Token、本机路径写进仓库（有自动脱敏检查把关，**工作区与 git 全史都扫**）。

---

## 三、门禁清单（提交前必须全绿）

```bash
# 1) 静态检查
node scripts/check-syntax.mjs                 # 全仓 JS 语法
node scripts/check-plugin-contract.mjs        # 插件形态 / 导出 / 路由合法性 / patch.yml
node scripts/check-plugin-integrity.mjs       # 语法合法但运行必炸的形态
node scripts/check-vendor-modifications.mjs   # 宿主改造清单 vs 补丁（逐文件 sha256 对账）
node scripts/check-sanitization.mjs           # 脱敏（工作区）；加 --history 扫 git 全史
node scripts/check-copy-compliance.mjs        # 医学措辞与免责一致性
node scripts/check-ui-tokens.mjs              # 设计 token 与裸色值
node scripts/check-public-references.mjs      # 公开引用（不得指向不存在的内部档案/路径）

# 2) 全量测试（并行）
bash scripts/test-parallel.sh

# 3) 重建索引（六面清单的最后一面）
#    用 codebase-memory MCP：index_repository
```

**改动即全量**：不允许「只跑我改的那个文件」。测试数只增不减；红了先查根因，**不许改断言让它变绿**。

---

## 四、发行流程（**打标签即发布**）

维护者确定发布一个版本时，在**本仓**打标签：

```
git tag v0.1.0 && git push origin v0.1.0
        │
        ▼  .github/workflows/release.yml
  ① guard          tag 与版本一致性校验
  ② macos/windows  目标平台构建：先取回上游 + 重放改造，再出安装版（.dmg / setup.exe）
                   与免安装版（.zip）
  ③ smoke-*        目标平台**真装真跑**冒烟（verify-install：期望全部通过）
  ④ index          收集资产 + 生成版本索引（sha256 自校验）
  ⑤ publish        在**本仓**创建同名 tag 的 Release，附全部发行资产
```

**关键性质（都是踩过坑才有的）**：

- **发布门控只用工作流自身的上下文**（事件类型 / ref），**不读跨 job 输出** —— 输出只在同一次运行内有效，
  重跑会丢，曾导致「所有 job 全绿却一个 Release 都没有」；
- **发行资产完整**：macOS 两个架构 + Windows，含与每个安装包对应的 `.sha256` 与 `.blockmap`；
- **单平台触发不阻断索引**：某平台缺失时按「忽略缺失」处理，不因为一个平台没产物而整条流水线失败。

### 手动兜底（CI 不可用时）

```bash
# 1) 取回上游 + 重放改造（含逐文件 sha256 对账）
node scripts/fetch-upstream.mjs
# 2) 构建（宿主目录内）
cd vendor/dsh-desktop-main && npm ci && npm run build && cd ../..
# 3) 冒烟（目标平台真机）
node scripts/verify-install.mjs --platform windows --artifacts vendor/dsh-desktop-main/dist
# 4) 收集资产 + 版本索引
node scripts/collect-release-assets.mjs --from vendor/dsh-desktop-main/dist --to release-assets
node scripts/build-version-index.mjs --assets release-assets --version 0.1.0 \
  --channel release --tag v0.1.0 --out release-assets/version-index.json
node scripts/build-version-index.mjs --verify release-assets/version-index.json --assets release-assets
# 5) 发 Release（本仓）
gh release create v0.1.0 --title "小胰宝社区版 0.1.0" --notes-file <发布说明> release-assets/*
```

### 发布后验证

- Release 页：安装版 + 免安装版都在，`.sha256` 与 `version-index.json` 一致；
- 下载安装 → 首次向导 → 建档 → 看板，全流程可用；
- 仓库 Actions：`ci.yml` 在本次提交上通过（静态检查 + 全量测试）。

**授权闸门（不可逆动作，需维护者单独批准）**：仓库公开/转私有、force-push、清史（filter-repo）、凭据轮换。

---

## 五、贡献入口与仓库定位

- **谁能改**：任何外部贡献者都可以提 issue / PR；维护者按 [`../CONTRIBUTING.md`](../CONTRIBUTING.md) 的标准评审。
- **改哪里**：改动落在**本仓**（它就是发行仓），不需要"先改另一个仓再同步"。
- **不能改什么**：不要直接修改 `patches/` 里的补丁（它由"上游源码 → 我们的改造"对账生成，
  手改会让逐文件 sha256 对账失败）；改宿主行为请在宿主目录里改，然后重新生成补丁。
- **报告问题**：安装/启动类问题请附上系统版本与安装包文件名；数据相关问题**不要**附真实病历内容。

---

## 六、上游同步

上游的取回集中在 **`scripts/fetch-upstream.mjs`**（仓库地址与锁定 commit 都在那里登记）：

| 源 | 锁定值记在哪 | 如何更新 |
|---|---|---|
| 宿主基线（DSH Desktop） | `patches/host-modifications.manifest.json` 的 `baseline` / `upstreamVersion`（**单一真源**） | 改锁定值 → `node scripts/fetch-upstream.mjs --force` → 把我们的改造逐项重新应用 → 重新生成 `patches/` |
| 上位许可源（DSH Desktop Next） | `scripts/fetch-upstream.mjs` 的 `NEXT_PIN` | 同上；另有 `NEXT_LICENSE_SHA256` 做**内容校验**——我们随包转达的是那份许可，commit 只是手段 |

> ⚠️ 取回是 **fail-closed**：锁定的 commit 取不到就回退按 tag/分支取；
> 但无论走哪条路径，宿主必须通过改造后的逐文件 sha256 对账，上位许可必须通过原文 sha256 校验
> —— **对不上就构建失败**，不静默降级。

从上游移植的任何代码片段，都必须登记在 `THIRD-PARTY-NOTICES.md` 的「已移植片段登记」表里。

---

## 七、应急与回滚

| 场景 | 处理 |
|---|---|
| 发行版有严重缺陷 | 回滚：发布页保留上一版安装包；用户覆盖安装即可（数据在独立目录，不随版本变化） |
| 数据写坏 | 应用内「设置 → 数据自检」可**从备份恢复**（修复前自动整份备份）；也可手动复制数据目录里的 `.backup-*` |
| 上游同步后打不出包 | 先看 `scripts/fetch-upstream.mjs` 的对账输出（它会指出哪个文件不符），再决定是回退锁定值还是更新补丁 |
| 补丁与上游不匹配 | 用 `node scripts/apply-host-modifications.mjs --check` 定位；**不要**用 `--ignore-whitespace` 之类"硬打"绕过 |

---

## 八、常见问题

**Q：为什么 `check-vendor-modifications` 在没有 `vendor/` 的机器上是「跳过」而不是「通过」？**
A：它需要宿主树才能逐文件对账。脚本会打印 `⏭ 跳过：… 校验强度：none（不适用）` ——
明确区分「不适用」与「没问题」，避免假绿（这是本项目的硬要求）。

**Q：为什么安装包和免安装包体积不小？**
A：其中相当一部分是能力包（青囊）的离线依赖 —— 为了**断网也能启动**而随包分发；
安装版与免安装版的差异来自压缩方式（安装器用 solid 压缩，zip 逐文件 deflate）。

**Q：本地构建需要多长时间？**
A：首次要取回上游（两个）+ 装宿主依赖，比增量构建久得多；之后 `fetch-upstream.mjs` 会跳过已就位的目录。

---

*本文件面向公开维护；开发侧的立项档案与宿主机画像不随仓发布。*
