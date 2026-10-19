# 来源与许可台账（SOURCES）

> **本文件是青囊的许可事实底账。** 每个进入本包的 MCP / skill / 知识资产都必须在册。
> 新增能力时**必须**在此登记（见 `MERGE_CONTRACT.md` §4）。未登记的资产视为**未授权纳入**。

**登记时间**：2026-10-14 ｜ **许可白名单**：`MIT` / `Apache-2.0` / `ISC` / `BSD-3-Clause`

---

## 一、MCP 通道（7 条，全部已接入）

| # | 通道 | 包 | 版本 | 上游 | 许可 | 判定依据 | 待办 |
|---|---|---|---|---|---|---|---|
| 1 | 通用网页搜索 | `open-websearch` | 2.2.0 | [Aas-ee/open-webSearch](https://github.com/Aas-ee/open-webSearch) | **Apache-2.0** | 上游 LICENSE 文件 | `package.json.license` 缺失（为 `None`），以上游文件为准 |
| 2 | 中文网页搜索 | `bing-cn-mcp` | 1.0.2 | [yan5236/bing-cn-mcp-server](https://github.com/yan5236/bing-cn-mcp-server) | **MIT** | repo + npm 一致 | — |
| 3a | 医学文献 | `mcp-pubmed-llm-server` | 3.0.0 | [PancrePal-xiaoyibao/mcp-pubmed-server-pancrpal](https://github.com/PancrePal-xiaoyibao/mcp-pubmed-server-pancrpal) | **MIT** | npm 元数据（实际分发物） | repo 标 Apache-2.0，与 npm 不一致 → 建议上游统一口径 |
| 3b | 学术文献 | `openalex-mcp-server` | 1.0.5 | [SecretRichGarden/openAlex-mcp](https://github.com/SecretRichGarden/openAlex-mcp) | **ISC** | npm 元数据 | ⚠️ 上游 repo 无 LICENSE 文件；ISC 与 MIT 实质等同，**已显式加入白名单** |
| 4 | 临床试验 | `unified-trial-mcp` | 0.3.1 | [opencare-skillhub/unified-trial-search-mcp-service](https://github.com/opencare-skillhub/unified-trial-search-mcp-service) | **MIT** | repo + npm 一致 | — |
| 5 | 高级医学证据 | `@xiaoyibao_npm/knows-mcp-server` | 0.2.2 | [PancrePal-xiaoyibao/MCP-KnowS-AI](https://github.com/PancrePal-xiaoyibao/MCP-KnowS-AI) | **MIT**（按惯例） | npm 元数据声明 | ⚠️ 上游 repo 无 LICENSE 文件 → **建议上游补 LICENSE**（见下「许可债」） |
| 6 | 病友经验 | `get-biji-mcp` | 0.1.1 | [PancrePal-xiaoyibao/get_biji_mcp](https://github.com/PancrePal-xiaoyibao/get_biji_mcp) | **MIT**（按惯例） | npm 元数据声明 | ⚠️ 上游双仓库均无 LICENSE 文件 → **建议上游补 LICENSE** |

### 许可判定惯例（本包采用）

```
1. 优先上游 LICENSE 文件
2. 文件缺失 → 以 npm 元数据声明为准（npm 是实际分发渠道）
3. 两者不一致 → 记 license_note 说明差异，并在此表登记待办
4. 一律登记在册，不因"待办未完成"而阻止接入
     └─ 理由：社区内部资产（KnowS / get-biji 均属 PancrePal 组织内）补 LICENSE 是
        内部协作事项，不应阻塞整个包的可用性
```

---

## 二、引入的社区 skill 资产（**方式 A：原样引入 + 适配层**）

> **为什么原样引入而非拆解**（ADR-011 修订）：社区 skill 自带 `SKILL.md` + 可执行脚本，**是能力不是文档**。
> 拍平进 `references/` 会丢掉可执行性——那是降级，不是合并。所以：
> **上游文件一字不改，青囊在每个 skill 目录里追加一份 `QINGNANG.md` 适配层**（写明许可 + 青囊五条红线在本技能上如何生效）。
>
> 引入脚本：`node scripts/vendor-skills.mjs`（可复现、可审计）。

| 引入的 skill | 上游 | 许可 | 上游形态 | 适配层加了什么 |
|---|---|---|---|---|
| `clinicaltrials-query-analysis` | [opencare](https://github.com/opencare-skillhub/clinicaltrials-query-analysis) | **Apache-2.0** | 22 py + SKILL.md | 四条医学约束（不给治疗建议 / 不承诺医保 / 状态带采集时间 / 只用公开联系方式） |
| `chictr-trials-collector` | [opencare](https://github.com/opencare-skillhub/chictr-trials-collector) | **Apache-2.0** | 18 ts + SKILL.md | 诚实边界（空结果≠没有 / 状态带时间戳 / 不编造登记号） |
| `clinicaltrials-intel-skill` | [opencare](https://github.com/opencare-skillhub/clinicaltrials-intel-skill) | **Apache-2.0** | 20 py + SKILL.md | 面向病友的三条推送约束（不诱导、不制造焦虑、可退订） |
| `nccn-guideline-downloader` | [opencare](https://github.com/opencare-skillhub/nccn-guideline-downloader) | **Apache-2.0** | 2 py + SKILL.md | **版权硬约束**（只摘要点 + 给官方链接，绝不输出全文） |
| `RAG-content-processor` | [opencare](https://github.com/opencare-skillhub/RAG-content-processor) | **Apache-2.0** | 36 py + SKILL.md | 生产前隐私闸门（`phi_scan`）+ 不入 `private/` |
| `aura_health_profile` | [opencare](https://github.com/opencare-skillhub/aura_health_profile) | **MIT-0** | 13 py + SKILL.md | 数据落 `~/.qingnang/private/`（0700）；默认不联网 |
| `getnote-openclaw` | [opencare](https://github.com/opencare-skillhub/getnote-openclaw) | **MIT** | 2 py + SKILL.md | 病友经验必须标「非医学证据」 |
| `xyb_dicom_download_skills` | [opencare](https://github.com/opencare-skillhub/xyb_dicom_download_skills) | **Apache-2.0** | 6 py + SKILL.md | **影像数据不出机**；下载目录强指 `private/` |
| `medical-desensitization` | [PancrePal](https://github.com/PancrePal-xiaoyibao/medical-desensitization) | **Apache-2.0** | 10 ts | 脱敏后才允许出机；脱敏不通过则**拒绝**后续处理 |
| `maskdesk` | [PancrePal](https://github.com/PancrePal-xiaoyibao/maskdesk) | **Apache-2.0** | 23 ts | local-first 与青囊隐私铁律同频；**桌面应用如何被 Agent 调用**的用法说明 |
| `PDAC-multi-agents-prompts` | [PancrePal](https://github.com/PancrePal-xiaoyibao/PDAC-multi-agents-prompts) | **Apache-2.0** | 提示词集 | 提示词**不得包含**诊断/剂量类指令 |

**共 11 项**，合计 ~2.9MB（已剥离 `.git` / `node_modules` / `.venv` / `outputs` / `cache` / `*.log` / `.env*`）。

**每项的适配层都是 `QINGNANG.md`**，内容五段：来源与许可 / 青囊五条红线落到本技能 / 病人数据红线 / 运行依赖 / 与主技能的关系。

**上游代码一字未改**——因此 **不构成衍生作品**，只需保留上游 `LICENSE` 与版权声明（已随目录保留）。

### 早期版本的做法（已废弃）

> ⚠️ 本包 v0.1 首版曾把上述 4 个 skill（试验/指南）**拆解为 `references/` 知识文件**（称「方式 B」）。
> 那是**降级**：可执行能力变成了阅读材料。已于 2026-10-14 改为原样引入，旧文件已删除。

---

## 三、已 vendor 但形态特殊（需知情）

| 资产 | 许可 | 为什么特殊 | 处置 |
|---|---|---|---|
| [maskdesk](https://github.com/PancrePal-xiaoyibao/maskdesk) | Apache-2.0 | 是**完整 Electron 应用**，不是纯 skill。无 `SKILL.md` | 已 vendor（源码入包便于审计），**适配层说明「如何把它当能力用」**；不集成其 UI |
| [medical-desensitization](https://github.com/PancrePal-xiaoyibao/medical-desensitization) | Apache-2.0 | 是 **TS 库**（无 `SKILL.md`），供其他工具调用 | 已 vendor，适配层说明调用方式 |
| [PDAC-multi-agents-prompts](https://github.com/PancrePal-xiaoyibao/PDAC-multi-agents-prompts) | Apache-2.0 | 是**提示词集**（单文件），不是 skill | 已 vendor 作为提示词资产 |

---

## 三之二、只登记、未 vendor（许可隔离）

| 资产 | 许可 | 为什么只登记 | 处置 |
|---|---|---|---|
| [ca199_toolbox_donated_by_lihb](https://github.com/PancrePal-xiaoyibao/ca199_toolbox_donated_by_lihb) | **AGPL-3.0** | AGPL 有传染性——链接即传染 | **不 vendor 代码**。只在本表登记其存在与用途（CA19-9 指标趋势管理，本地处理无上传）。未来若纳入，须**独立子进程 / 独立目录**隔离 |
| [MinerU-xyb](https://github.com/PancrePal-xiaoyibao/MinerU-xyb) | AGPL-3.0 | 同上 + 体积大（GB 级模型权重） | Phase 3 再评估；原则：**独立子进程 + 独立 venv，不进主依赖树** |
| [little_green_card](https://github.com/PancrePal-xiaoyibao/little_green_card) | NONE | 完整 React 应用 + 无许可 | 不纳入 |
| [devil-chat](https://github.com/PancrePal-xiaoyibao/devil-chat) | NONE | 游戏原型 + 无许可 | 不纳入 |

---

## 四、经准入判定「拒绝入包」的资产（登记理由，避免重复评估）

| 资产 | 拒绝理由（按准入四条） |
|---|---|
| `xyb-wechat-article-generator` / `xyb-wechat-article-transcription` | **非能力**——是公众号运营工具（准入第 2 条：应用不入，只借鉴） |
| `xyb-whitepaper-writer` / `xyb-humanizer` | 同上 |
| `generic-image-gen-skills` | 同上 + 无 LICENSE |
| 微信机器人系（`dify-on-wechat` / `dow_gewe_*` / `chatgpt-on-wechat-win` 等） | **非医学能力** + 运营基建（准入第 1、2 条） |
| 社区官网 / 小程序 / 图床系（`miniapp-*` / `web` / `my-images` 等） | 同上 |
| `Medical-Record-Organizer` / `skill-HADS-accessment` | ⚠️ 无 LICENSE 文件 → 待上游补。**补后可重新评估**（两者都是医学相关能力，价值不低） |
| `chinadrugtrials-collector` / `chinadurgtrials` / `pancreatic-cancer-dailynews-skill` | ⚠️ 无 LICENSE 文件 → 待上游补 |
| `ca199_toolbox_flutter` / `ca199_toolbox_mp` | ⚠️ 无 LICENSE + 与 `ca199_toolbox` 同源 → 以那个为准 |
| `clinical-trial-matching` / `llm-wiki-pancrepal` / `openclaw_skills_pool` | ⚠️ 无 LICENSE 文件 |

> **2026-10-14 修订说明**：v0.1 首版曾以「是应用不是能力」为由**拒绝** `RAG-content-processor`、`maskdesk`、`xyb_dicom_download_skills`。
> 后修正判断：**「应用外壳」与「可用能力」是两件事**——不应因外壳是应用就丢掉其能力，正确处理是「vendor 源码 + 适配层说明如何当能力用」。三者现已引入，见 §二。

---

## 五、许可债清单（**给社区的行动项**）

| # | 仓库 | 缺什么 | 影响 | 优先级 |
|---|---|---|---|---|
| 1 | `PancrePal-xiaoyibao/MCP-KnowS-AI` | LICENSE 文件（npm 已声明 MIT） | 通道 5 的许可依据只有 npm 元数据 | **中**（已可用，但依据偏弱） |
| 2 | `PancrePal-xiaoyibao/get_biji_mcp` 与 `get-biji-dev-by-gemini3pro` | LICENSE 文件（npm 已声明 MIT） | 通道 6 同上 | **中** |
| 3 | `SecretRichGarden/openAlex-mcp` | LICENSE 文件（npm 声明 ISC） | 通道 3b 同上。注意：这是**外部**仓库，非社区内部 | **中** |
| 4 | `opencare-skillhub/Medical-Record-Organizer` | LICENSE 文件 | 无法纳入（病历整理是刚需能力） | **高** |
| 5 | `opencare-skillhub/skill-HADS-accessment` | LICENSE 文件（另需核量表版权） | 无法纳入（心理评估是刚需） | **高** |
| 6 | `opencare-skillhub/chinadrugtrials-collector` | LICENSE 文件 | 无法纳入 | 中 |
| 7 | `opencare-skillhub/pancreatic-cancer-dailynews-skill` | LICENSE 文件 | 无法纳入（药讯追踪有价值） | 中 |
| 8 | `opencare-skillhub/clinical-trial-matching` | LICENSE 文件（且为 fork） | 无法纳入 | 低 |
| 9 | `mcp-pubmed-server-pancrpal` | repo(Apache-2.0) 与 npm(MIT) **不一致** | 需统一口径 | 低（两者皆宽松） |

---

## 六、本仓库自身许可

**Apache-2.0**（见 `LICENSE`），附医学免责声明（非许可条款部分）。

**为什么选 Apache-2.0 而非 MIT**：
- 含**专利授权**（对医疗信息化场景更稳妥）
- 与多数上游一致（`open-websearch` 也是 Apache-2.0）
- 要求保留 NOTICE——对本项目「标注来源与改动」的纪律天然一致

---

## 七、第三方组件声明（面向发行物）

若青囊被打包进发行版（未来 DSH 项目），**必须**在第三方许可页列明：

| 组件 | 许可 | 要求 |
|---|---|---|
| `open-websearch` | Apache-2.0 | 保留版权声明 + NOTICE |
| `bing-cn-mcp` | MIT | 保留版权声明 |
| `mcp-pubmed-llm-server` | MIT | 同上 |
| `openalex-mcp-server` | ISC | 同上 |
| `unified-trial-mcp` | MIT | 同上 |
| `@xiaoyibao_npm/knows-mcp-server` | MIT（待补文件） | 同上 |
| `get-biji-mcp` | MIT（待补文件） | 同上 |
| 并入的 skill 资产（4 项） | Apache-2.0 | 保留来源与改动说明 |
| **NCCN 指南内容** | **受版权保护** | **不得再分发全文**，只做要点摘录 + 官方链接 |
