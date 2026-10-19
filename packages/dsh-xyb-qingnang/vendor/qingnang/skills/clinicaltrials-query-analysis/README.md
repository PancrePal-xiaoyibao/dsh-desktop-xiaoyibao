# 🔬 ClinicalTrials Query & Analysis

基于 ClinicalTrials.gov API v2 的临床试验智能搜索与分析系统。支持关键词、时间范围、国家多维度筛选，输出结构化试验列表与智能总结，以及 **万字级 NCCN 月报**。

## ✨ 功能特性

- **🔍 多维度搜索** — 关键词（基因/疾病/药物）+ 时间范围 + 国家 + 招募状态
- **🎯 智能 Biomarker 提取** — 自动从入排标准中识别 50+ 种肿瘤标志物（KRAS G12D、BRCA1/2、MSI-H 等）
- **📊 智能总结** — 自动生成搜索结果统计、阶段分布、靶点分布、热门药物、地区分布、申办方排行
- **🌍 全球覆盖** — 覆盖 ClinicalTrials.gov 所有注册试验，支持 50+ 国家/地区筛选
- **📋 双格式输出** — 交互式表格（默认）+ 纯 JSON（程序调用）
- **🔄 智能重试** — 内置 5 重试 + 指数退避 + User-Agent，403 限流容错；整次搜索受总时间预算约束（默认 40s），不会无限重试
- **🚫 无需 API Key** — ClinicalTrials.gov 是免费公开 API
- **🏥 NCCN 月报** — 覆盖 27 个胰腺癌核心靶点，LLM 深度分析，输出万字级 Markdown 报告
- **⚡ 并发优化** — LLM 分析 2 并发，月报生成速度翻倍
- **🌐 可选翻译** — 标题双语翻译（默认关闭，LLM分析已为中文）
- **🧬 基因配置化** — 27 个靶点 YAML 配置，4 分组（指南推荐/临床热点/进阶靶点/补充检测）
- **🖥️ 交互式菜单** — 单基因搜索 / 多基因专题 / 月报生成 / 报告导出 四合一
- **🧪 测试套件** — 37 个测试覆盖配置/翻译/报告/搜索模块
- **📑 多格式报告导出** — 搜索结果一键导出为 **MD、DOCX、PDF、XLSX、HTML** 五种格式
- **📞 详细联络信息** — 自动抓取 PI（主要研究者）、中心联系方式、中国可报名医院及联系人电话
- **🏷️ 搜索条件命名** — 导出文件按搜索条件自动命名并组织子目录

## 🧬 基因配置（27 靶点）

| 分组 | 基因 | 数量 | 月报 |
|------|------|------|------|
| **A 指南推荐** | EGFR, KRAS, HER2(ERBB2), TROP2, CLDN18.2, BRCA1/2, ATM, BRAF V600E, NTRK, NRG1, RET, FGFR2 | 13 | 部分 |
| **B 临床热点** | SHP2, C-MET(MET), TF(组织因子), HRRAS | 4 | ✅ 全部 |
| **C 进阶靶点** | MSLN, B7-H3, Nectin-4, pan-TRK, CDH17, CEACAM5, MTAP(loss), MUC1, DLL3, CA125 | 10 | ✅ 全部 |
| **D 补充检测** | FOLR1 | 1 | ✅ 全部 |

> 月报默认覆盖全部 27 个基因

## 📦 目录结构

```
clinicaltrials-search/
├── config/
│   └── genes.yaml                # 基因配置（27靶点，4分组，LLM多provider支持）
	├── scripts/
	│   ├── search.py                 # 单基因搜索
	│   ├── report_nccn.py            # NCCN月报生成器（2并发LLM）
	│   ├── config_loader.py          # 配置加载器
	│   ├── translator.py             # 通用翻译模块（batch并发）
	│   ├── main.py                   # 交互式菜单入口
	│   ├── fetch_details.py          # 单试验详细信息抓取（PI、联络方式、中心信息）
	│   └── generate_reports.py       # 多格式报告导出（MD/DOCX/PDF/XLSX/HTML）
	├── tests/                        # 测试套件（37个测试）
│   ├── test_config_loader.py      # 配置加载器测试
│   ├── test_translator.py         # 翻译模块测试
│   ├── test_report.py            # 报告生成器测试
│   ├── test_search.py             # 搜索模块测试
│   └── run_all_tests.py         # 测试统一入口
├── templates/
│   └── report_nccn.md            # 月报模板
├── outputs/                      # 生成的报告和缓存
│   ├── gene_cache/               # 每基因JSON缓存
│   └── reports/                  # 最终月报（双语+日期字段）
├── references/
│   └── api_reference.md          # API v2 参考文档
├── .env.template                 # LLM配置模板
├── .env                         # LLM配置（不提交）
├── SKILL.md                      # 技能定义
├── requirements.txt              # Python依赖
└── README.md                     # 本文件
```

## 🚀 快速开始

### 依赖安装

```bash
pip install -r requirements.txt
# 或手动安装
pip install httpx PyYAML openai
```

### 环境变量（月报 LLM 分析用，可选）

```bash
# LLM 配置（月报深度分析用，无则输出骨架报告）
export LLM_API_KEY="your-api-key"
export LLM_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export LLM_MODEL="qwen-turbo"
# 也支持 OpenAI / Groq / 智谱等 OpenAI 兼容 API
```

### 四大功能入口

```bash
# 1️⃣ 交互式菜单（推荐）
python3 scripts/main.py

# 2️⃣ 单基因搜索
python3 scripts/search.py --keyword "KRAS G12D"

# 3️⃣ NCCN 月报生成
python3 scripts/report_nccn.py                    # 完整月报（中文深度分析）
python3 scripts/report_nccn.py --no-llm           # 跳过 LLM，输出骨架
python3 scripts/report_nccn.py --gene kras        # 仅生成单基因报告
python3 scripts/report_nccn.py --translate       # 启用标题双语翻译（默认关闭）

# 4️⃣ 多格式报告导出（搜索结果 → MD/DOCX/PDF/XLSX/HTML）
python3 scripts/fetch_details.py                  # 抓取试验详细信息（PI、联络方式、中国医院）
python3 scripts/generate_reports.py               # 生成 5 种格式报告
```

### 参数说明

| 参数 | 短写 | 必填 | 说明 | 默认值 |
|------|------|------|------|--------|
| `--keyword` | `-k` | ✅ | 搜索关键词（基因名、疾病名、药物名等） | — |
| `--start-date` | `-s` | ❌ | 起始日期 (YYYY-MM-DD) | — |
| `--end-date` | `-e` | ❌ | 结束日期 (YYYY-MM-DD) | — |
| `--country` | `-c` | ❌ | 试验开展国家（英文名，如 China, United States） | — |
| `--status` | — | ❌ | 招募状态筛选 | `RECRUITING,ACTIVE_NOT_RECRUITING` |
| `--max-results` | `-n` | ❌ | 最大返回结果数 | 50（上限 1000） |
| `--timeout` | — | ❌ | 整次搜索的总时间预算（秒）；用尽即停止重试并返回部分结果 | 40 |
| `--json` | — | ❌ | 以 JSON 格式输出（提示信息走 stderr） | — |

### 报告导出用法

```bash
# 1. 抓取试验详情（PI、联络方式、中国医院联系人）
python3 scripts/fetch_details.py

# 2. 一键生成五种格式报告
python3 scripts/generate_reports.py
```

输出目录：`outputs/{关键词}_{状态}/`
支持格式：MD、DOCX、PDF（横向A4）、XLSX（多Sheet）、HTML（响应式卡片）

### 基本用法

```bash
# 1. 关键词搜索（必填）
python3 scripts/search.py --keyword "KRAS G12D"

# 2. 带时间范围
python3 scripts/search.py --keyword "KRAS G12D" --start-date 2024-01-01 --end-date 2025-12-31

# 3. 带国家筛选
python3 scripts/search.py --keyword "pancreatic cancer immunotherapy" --country China

# 4. 完整参数
python3 scripts/search.py \
  --keyword "CA1" \
  --start-date "2023-06-01" \
  --end-date "2025-06-01" \
  --country "United States" \
  --max-results 100

# 5. JSON 输出（便于程序调用）
python3 scripts/search.py --keyword "KRAS G12D" --max-results 10 --json

# 6. 放宽总时间预算（默认 40s；宿主工具的超时也要相应放宽）
python3 scripts/search.py --keyword "KRAS G12D" --timeout 120
```

### 总时间预算与 `--timeout`

单次请求最多等 45s、最多重试 5 次（403 限流退避更久），累加最坏可达约 5 分钟。在带工具超时的宿主里
（例如 PI-Desktop / OpenClaw 的 Bash 工具默认 60s），这会表现为「脚本卡住一会儿之后被强行杀掉」，
使用者只看到一句 `bash timed out`，看不出到底发生了什么。

因此整次搜索受一个**总时间预算**约束，默认 **40s**：

- 预算同时约束三处：每页开始前、单次请求超时、每次退避等待；
- 预算用尽时**停止重试并返回已获得的结果**，同时明确打印
  `⚠️ 已达总时间预算 Ns，结果是部分结果`，而不是静默失败；
- 需要更久时显式放宽：`--timeout 120`。**宿主侧的工具超时也要同步放宽**
  （例如给 Bash 工具 `timeoutMs` ≥ 120000），否则仍会先被宿主杀掉；
- 退出码不变（查不到结果同样返回 0）；脚本调用方可用 `client.budget_exhausted`
  区分「没有结果」和「没查完」。

## 📊 输出示例

### 交互式表格

```
================================================================================
  临床试验搜索结果（共 9 条）
================================================================================

  1. [NCT07621718] Study of Zoldonrasib + Chemo ... (RASolute 305)
     阶段: Not specified | 状态: 🟢 招募中
     药物: Zoldonrasib, Placebo, Oxaliplatin ...
     Biomarker: KRAS G12D, ATM, MET
     申办方: Revolution Medicines, Inc.
     国家: United States
     启动日期: 2026-05-22
     📅 发布: 2026-06-05
     🔗 https://clinicaltrials.gov/study/NCT07621718

================================================================================
  📊 智能总结 — 关键词: "KRAS G12D"
================================================================================

  📈 搜索结果统计: 共 9 条试验
     • 招募中 (RECRUITING): 9

  🎯 Biomarker / 靶点分布:
     • MET: 9 █████████
     • ATM: 8 ████████
     • KRAS G12D: 7 ███████

  💊 热门药物/干预措施 Top 15:
     • Zoldonrasib: 1 █
     • Setidegrasib: 1 █

  🌍 地区分布 Top 10:
     • United States: 8 ████████
     • Australia: 4 ████

  🔑 关键发现:
     •   招募中试验占 100%（9/9）
     •   最热门靶点: MET(9), ATM(8), KRAS G12D(7)
     •   试验覆盖 22 个国家/地区
```

### JSON 输出

```bash
python3 scripts/search.py --keyword "KRAS G12D" --max-results 2 --json
```

```json
[
  {
    "nct_id": "NCT07621718",
    "title": "Study of Zoldonrasib + Chemo ...",
    "phase": "Not specified",
    "status": "RECRUITING",
    "drugs": ["Zoldonrasib", "Placebo", "Oxaliplatin", ...],
    "biomarker": "KRAS G12D, ATM, MET",
    "sponsor": "Revolution Medicines, Inc.",
    "countries": ["United States"],
    "start_date": "2026-05-22",
    "first_post_date": "2026-06-05",
    "last_update": "2026-06-20",
    "url": "https://clinicaltrials.gov/study/NCT07621718"
  }
]
```

## 🧬 支持的 Biomarker 自动识别

脚本可从入排标准中自动提取以下 50+ 种肿瘤标志物：

| 类别 | Biomarker |
|------|-----------|
| **KRAS 亚型** | KRAS G12C, KRAS G12D, KRAS G12V, KRAS G12R, KRAS G12A, KRAS G13D, KRAS Q61H |
| **RAS 家族** | NRAS, HRAS |
| **DDR / HRD** | BRCA1, BRCA2, PALB2, ATM, TP53, PTEN |
| **MSI/dMMR** | MSI-H, MMR 缺陷, Lynch (MLH1/MSH2/MSH6/PMS2) |
| **融合基因** | NTRK, NRG1, FGFR2, ALK, ROS1, RET |
| **其他靶点** | BRAF V600E, HER2/ERBB2, EGFR, VEGF, MET, CDKN2A, SMAD4, PIK3CA |
| **免疫标志物** | PD-L1, PD-1/PD-L1, CTLA-4, TMB-H, CAR-T, TCR-T |

> 特异性匹配优先：如文本中同时出现 "KRAS G12D" 和 "KRAS"，只保留更具体的 "KRAS G12D"。

## 🌍 常用搜索示例

```bash
# 胰腺癌 KRAS G12D — 过去 90 天
python3 scripts/search.py -k "KRAS G12D" -s 2026-04-04

# 中国开展的胰腺癌免疫治疗试验
python3 scripts/search.py -k "pancreatic cancer immunotherapy" -c China

# 全球 BRCA1/2 相关试验
python3 scripts/search.py -k "BRCA mutation solid tumor"

# ATR 抑制剂临床试验
python3 scripts/search.py -k "ATR inhibitor"

# mRNA 个性化疫苗
python3 scripts/search.py -k "mRNA neoantigen vaccine"

# KRAS 疫苗 + 美国开展
python3 scripts/search.py -k "KRAS vaccine" -c "United States"

# 过去一年中国启动的临床试验
python3 scripts/search.py -k "pancreatic cancer" -s 2025-07-01 -c China -n 100
```

## 🔧 技术细节

### API 端点

- **Base URL**: `https://clinicaltrials.gov/api/v2/studies`
- **协议**: HTTPS, GET
- **认证**: 无需 API Key
- **限速**: 无官方文档限制，内置 5 重试 + 指数退避 + User-Agent

### 时间范围搜索语法

使用 `query.term` 配合 `AREA[StartDate]RANGE[起始,结束]`：

```
# 2024年之后启动
query.term = KRAS G12D AND AREA[StartDate]RANGE[2024-01-01,MAX]

# 指定时间范围
query.term = KRAS G12D AND AREA[StartDate]RANGE[2023-01-01,2025-12-31]
```

### 国家搜索

`query.locn` 参数支持：国家英文名（China, United States, Japan）、城市名、州/省名。

### 依赖

-  Python 3.10+
-  httpx（异步 HTTP 客户端）
-  PyYAML（基因配置解析）
-  openai（LLM 深度分析，月报用）

### 环境变量（月报 LLM 分析用）

```bash
# LLM 配置（月报深度分析用，无则输出骨架报告）
export LLM_API_KEY="your-api-key"
export LLM_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export LLM_MODEL="qwen-turbo"
# 也支持 OpenAI / Groq / 智谱等 OpenAI 兼容 API
```

### LLM Provider 配置

支持三种 LLM provider（在 `.env` 中配置）：

- **custom**: 自定义 OpenAI 兼容 API（默认）
- **stepfun**: StepFun（100 万上下文，适合长文分析）
- **dashscope**: 阿里云通义千问（速度快）

## 🤖 AI Agent 部署提示词

将以下提示词发给 Codex / OpenClaw / Hermes 等 AI 编程助手，即可自动完成部署：

**OpenClaw：**

```
请从 https://github.com/opencare-skillhub/clinicaltrials-query-analysis.git 克隆并安装 clinicaltrials-search 技能到 ~/.openclaw/skills/ 目录，安装 httpx PyYAML openai 依赖，然后用 python3 scripts/search.py --keyword "KRAS G12D" -n 3 验证可用，确认输出试验列表和智能总结即可。
```

**Codex CLI：**

```
请从 https://github.com/opencare-skillhub/clinicaltrials-query-analysis.git 克隆到当前项目的 ./skills/clinicaltrials-search 目录，安装 httpx PyYAML openai 依赖，运行 python3 ./skills/clinicaltrials-search/scripts/search.py --keyword "KRAS G12D" -n 3 验证脚本能正常返回试验列表和总结，确认部署成功。
```

**Hermes：**

```
请从 https://github.com/opencare-skillhub/clinicaltrials-query-analysis.git 克隆技能包到 ./skills/clinicaltrials-search，安装 httpx PyYAML openai 依赖，运行 python3 ./skills/clinicaltrials-search/scripts/search.py --keyword "KRAS G12D" -n 3 验证输出正常（应包含临床试验列表和智能总结），确认部署成功。
```

> 三个平台的提示词结构一致：克隆仓库 → 安装依赖 → 运行验证。替换加粗的关键词即可测试不同靶点（如 `BRCA1`、`ATR inhibitor`、`mRNA vaccine`）。

## 📄 License

MIT License

## 🙏 致谢

小胰宝开源社区志愿者的❤️贡献