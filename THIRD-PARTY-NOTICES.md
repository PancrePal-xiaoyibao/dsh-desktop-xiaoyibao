# 第三方组件与许可清单

> 本文件列出本项目**直接或内嵌**使用的第三方组件及其许可，供合规审阅。
> 上游许可证原文一律**完整保留**在各自目录内，未作修改。

---

> 本发行版是**社区发行版，非官方产品**（与 DeepSeek、DataElement 均无隶属关系）。
> 本文件列出随包分发的第三方组件、版权与许可；本项目自身的许可见仓库根的 `LICENSE`。

## 一、宿主（DSH Desktop）

| 项 | 值 |
|---|---|
| 名称 | DSH Desktop |
| 仓库 | https://github.com/dataelement/dsh-desktop |
| 基线 commit | `115a0b474cc2c4794316171c640a8898398591fe` |
| 许可证 | **MIT License** |
| 版权 | Copyright (c) 2026 DataElement |
| 原文位置 | `vendor/dsh-desktop-main/LICENSE`（**未修改**） |
| 本项目对它的改造 | （7 项，均为配置/资产/插件注册，未触及核心运行时逻辑） |

---

## 二、DSH Desktop Next（上游项目 / 功能来源）

| 项 | 值 |
|---|---|
| 名称 | DSH Desktop Next（DSH Next） |
| 仓库 | https://github.com/anywhere-labs/dsh-desktop |
| 站点 | https://www.dshdesktop.cn/ |
| 版本 | `dsh-desktop-next@2.0.19-next`（我们克隆时的 master，`3e6fc93`） |
| 许可证 | **MIT License** |
| 版权 | Copyright (c) 2026 Anywhere Labs |
| 它的上游 | DeepSeek Harness（`https://github.com/deepseek-ai/deepseek-harness`；`dsh-desktop-next/LICENSE.upstream` = MIT，Copyright (c) 2026 DeepSeek） |
| 原文位置 | `vendor/dsh-desktop-next/LICENSE`（参考源，不入库；见 `.gitignore`） |
| 与本项目关系 | **合作发布团队**。我们与其共同发布社区版；我方代码基线仍是官方 DSH Desktop（见第一章） |
| 比对结论 | 两个项目是同一上游 DeepSeek Harness 的**兄弟项目**，非派生关系（Next 全仓零 `DataElement` 痕迹；补丁版本 0.1.7 vs 我方 0.2.0）。详见 |
| 引用/移植登记 | 优选 4 项的移植方案见 ；**若直接复制其代码片段，逐项登记在本表下方**（当前：仅在设计与接口层借鉴，无直接代码复制） |

### 已移植片段登记

| 片段（文件/符号） | 来源文件 | 移植日期 | 改动说明 |
|---|---|---|---|
| （待登记） | — | — | — |

## 三、青囊（QingNang）能力包

| 项 | 值 |
|---|---|
| 名称 | 青囊 QingNang（小胰宝社区 · 医学能力资产包） |
| 仓库 | https://github.com/PancrePal-xiaoyibao/QingNang |
| 快照 commit | `defce7c8f50726dc3872de756b247c068884258d` |
| 版本 | `pack_version 0.1.0` |
| 许可证 | **Apache-2.0** |
| 原文位置 | `packages/dsh-xyb-qingnang/vendor/qingnang/LICENSE` |
| 同步方式 | `node scripts/sync-qingnang.mjs`（快照 + 校验值） |

---

## 四、青囊内嵌的上游技能（10 个）

| 技能目录 | 上游仓库 | 许可证 | 分类 |
|---|---|---|---|
| `clinicaltrials-query-analysis` | opencare-skillhub/clinicaltrials-query-analysis | Apache-2.0 | 临床试验 |
| `chictr-trials-collector` | opencare-skillhub/chictr-trials-collector | Apache-2.0 | 临床试验 |
| `clinicaltrials-intel-skill` | opencare-skillhub/clinicaltrials-intel-skill | Apache-2.0 | 临床试验 |
| `nccn-guideline-downloader` | opencare-skillhub/nccn-guideline-downloader | Apache-2.0 | 临床指南 |
| `RAG-content-processor` | opencare-skillhub/RAG-content-processor | Apache-2.0 | 知识生产 |
| `aura_health_profile` | opencare-skillhub/aura_health_profile | **MIT-0** | 健康管理 |
| `getnote-openclaw` | opencare-skillhub/getnote-openclaw | MIT | 笔记 |
| `xyb_dicom_download_skills` | opencare-skillhub/xyb_dicom_download_skills | Apache-2.0 | 影像 |
| `medical-desensitization` | PancrePal-xiaoyibao/medical-desensitization | Apache-2.0 | 病历隐私 |
| `maskdesk` | PancrePal-xiaoyibao/maskdesk | Apache-2.0 | 病历隐私 |

> 来源：`packages/dsh-xyb-qingnang/vendor/qingnang/MANIFEST.json` 的 `skill.vendored` 段（唯一事实源）。

---

## 五、青囊内嵌的 MCP 服务（7 条通道）

| 通道 | 包名 | 版本 | 许可证 | 上游 |
|---|---|---|---|---|
| 通用网页搜索 | `open-websearch` | 2.2.0 | Apache-2.0 | Aas-ee/open-webSearch |
| 中文网页搜索 | `bing-cn-mcp` | 1.0.2 | MIT | yan5236/bing-cn-mcp-server |
| 医学文献检索 | `mcp-pubmed-llm-server` | 3.0.0 | MIT | PancrePal-xiaoyibao/mcp-pubmed-server-pancrpal |
| 学术文献（开放获取） | `openalex-mcp-server` | 1.0.5 | ISC | SecretRichGarden/openAlex-mcp |
| 临床试验检索 | `unified-trial-mcp` | 0.3.1 | MIT | opencare-skillhub/unified-trial-search-mcp-service |
| 高级医学证据（凭据门控） | `@xiaoyibao_npm/knows-mcp-server` | 0.2.2 | MIT | PancrePal-xiaoyibao/MCP-KnowS-AI |
| 病友经验（凭据门控） | `get-biji-mcp` | 0.1.1 | MIT | PancrePal-xiaoyibao/get_biji_mcp |

> 来源：`packages/dsh-xyb-qingnang/vendor/qingnang/mcp-servers/manifest.json`（唯一事实源）。

**许可白名单**（青囊的准入规则）：`MIT` / `Apache-2.0` / `ISC` / `BSD-3-Clause`。

**已知许可差异（如实登记）**：
- `mcp-pubmed-llm-server`：上游 repo 标 Apache-2.0，npm 元数据写 MIT（两者皆宽松，按 npm 实际分发为准）。
- `@xiaoyibao_npm/knows-mcp-server`：npm 声明 MIT，上游 repo 未放 LICENSE 文件（按社区惯例以 npm 声明为准，待补）。
- `get-biji-mcp`：同上（上游双仓库均无 LICENSE 文件）。

---

## 六、本项目自身的直接依赖

| 包 | 用途 | 许可证 |
|---|---|---|
| `@deepseek-ai/schemastery` | 插件配置 schema（服务端） | MIT（随宿主） |
| `@deepseek-ai/cordis` | 插件框架（peer，由宿主提供） | MIT（随宿主） |
| `@deepseek-ai/dsh-client-connection` | 客户端连接（peer，由宿主提供） | MIT（随宿主） |

> 本项目**不引入独立 React**（走宿主共享实例），**不引入构建步骤**。

---

## 七、待专业审查项（如实声明）

以下事项需要法律专业人士判断，本清单仅做**登记**，不构成法律意见：

1. **间接依赖的许可**：青囊的 265 个 npm 依赖（`vendor/node_modules/`）未逐条审查，只核验了 7 个 MCP 服务本身的许可。
2. **`knows-mcp-server` 与 `get-biji-mcp` 的 LICENSE 文件缺失**：目前以 npm 元数据声明为准，已在青囊的 SOURCES 中登记待补。
3. **量表与医学内容的版权**：本项目一期**不内置**任何量表题目（只做得分录入），因此暂不涉及；若后续内置，需逐量表核对许可。
4. **上游技能的内容版权**：10 个技能的内容版权归各自上游，本项目只做分发（随青囊快照）。

---

## 七、随安装包分发的许可文本（`resources/licenses/`）

用户拿到的是**安装包**而不是仓库，因此许可文本必须随包送达（MIT 要求「附带版权声明与许可声明」；
Apache-2.0 要求「随分发提供许可副本」）。六件套如下，并已由 `scripts/verify-install.mjs`
在**已安装应用**上逐项断言（缺任何一件即 smoke 失败）：

| 文件 | 覆盖 | 来源（仓库内路径） |
|---|---|---|
| `licenses/LICENSE` | 本发行版自身（MIT，© 小胰宝社区） | `LICENSE` |
| `licenses/THIRD-PARTY-NOTICES.md` | 全部第三方组件清单（就是本文件） | `THIRD-PARTY-NOTICES.md` |
| `licenses/DSH-Desktop-upstream-MIT.txt` | 我们改造的宿主基线 | `vendor/dsh-desktop-main/LICENSE`（MIT © DataElement） |
| `licenses/DeepSeek-Harness-MIT.txt` | 宿主运行时所依赖的上游 Harness | `node_modules/@deepseek-ai/dsh/LICENSE`（MIT © DeepSeek） |
| `licenses/QingNang-Apache-2.0.txt` | 青囊能力包 | `packages/dsh-xyb-qingnang/vendor/qingnang/LICENSE`（Apache-2.0） |
| `licenses/DSH-Desktop-Next-MIT.txt` | 上游项目（优选功能来源） | `vendor/dsh-desktop-next/LICENSE`（MIT © Anywhere Labs） |

**另有随包但不由本清单管理的许可**（如实声明，均已实测在包内）：

- `LICENSE.electron.txt`（应用根目录）：Electron / Chromium 及其内置第三方组件，由 electron-builder 生成；
- `resources/app.asar` 内各 npm 依赖自带 `LICENSE` 文件（实测检索：`DataElement` / `DeepSeek` /
  `Apache License` 文本均在 asar 内），随包原样分发、未被裁剪。

## 八、变更历史

| 版本 | 日期 | 变更 |
|---|---|---|
| 1 | 2026-10-15 | 初版 |
