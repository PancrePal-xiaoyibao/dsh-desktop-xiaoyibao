# 🚀 ClinicalTrials 搜索与分析 — 快速开始

> 基于 ClinicalTrials.gov API v2 的临床试验智能搜索工具。支持多维度筛选、智能 Biomarker 识别、NCCN 月报生成、多格式报告导出。

## 📦 安装

### 1. 依赖安装

```bash
pip install httpx PyYAML openai openpyxl python-docx fpdf2
# 或使用 requirements.txt
pip install -r requirements.txt
```

### 2. 可选：LLM 配置（月报深度分析）

创建 `.env` 文件（复制 `.env.template`）并配置 LLM：

```bash
# 三选一
export LLM_API_KEY="your-api-key"
export LLM_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export LLM_MODEL="qwen-turbo"
```

> 无配置时，月报生成会跳过 LLM 深度分析。

## 🎯 四大功能

### 1. 交互式菜单（推荐新手）

```bash
cd clinicaltrials-search
python3 scripts/main.py
```

然后按提示选择：
- **1** — 单基因搜索
- **2** — 多基因专题分析  
- **3** — NCCN 月报生成
- **4** — 多格式报告导出

### 2. 单基因搜索

```bash
# 基础搜索
python3 scripts/search.py --keyword "KRAS G12D"

# 带国家筛选
python3 scripts/search.py --keyword "KRAS G12D" --country China

# 带时间范围（过去 90 天）
python3 scripts/search.py --keyword "KRAS G12D" --start-date "2026-04-04"

# 组合参数
python3 scripts/search.py \
  --keyword "KRAS G12D" \
  --country "United States" \
  --max-results 20
```

### 3. NCCN 月报生成

```bash
# 完整月报（需 LLM_API_KEY）
python3 scripts/report_nccn.py

# 快速骨架（无 LLM）
python3 scripts/report_nccn.py --no-llm

# 单基因报告
python3 scripts/report_nccn.py --gene kras

# 启用标题双语翻译（默认关闭）
python3 scripts/report_nccn.py --translate
```

月报包含：
- 📊 总体统计（试验数、招募状态、阶段分布）
- 🧬 27 个基因专区（临床试验统计 + LLM 深度分析）
- 📈 6 大技术赛道（RAS/ADC/免疫/DDR/PROTAC/SHP2）
- 🇨 中国可及性分析
- 🎯 本月里程碑
- 📚 医学术语速查表

### 4. 多格式报告导出

```bash
# 步骤1：抓取试验详细信息（PI、联络方式、中国医院）
python3 scripts/fetch_details.py

# 步骤2：一键生成 5 种格式报告
python3 scripts/generate_reports.py
```

输出在 `outputs/{关键词}_{招募状态}/` 目录下：

| 格式 | 文件 |
|:----:|------|
| 📝 Markdown | `CLDN18.2_RECRUITING_报告.md` |
| 📊 Excel | `CLDN18.2_RECRUITING_报告.xlsx` |
| 📄 Word | `CLDN18.2_RECRUITING_报告.docx` |
| 📕 PDF | `CLDN18.2_RECRUITING_报告.pdf` |
| 🌐 HTML | `CLDN18.2_RECRUITING_报告.html` |

每条试验包含：招募状态、最近更新日期、PI（主要研究者）、中心联络方式、中国可报名医院及联系人电话。文件按搜索条件自动命名并分目录存放。

## 📊 输出示例

### 交互式表格

```console
$ python3 scripts/search.py --keyword "KRAS G12D"

================================================================================
  临床试验搜索结果（共 9 条）
================================================================================

  1. [NCT07621718] Study of Zoldonrasib + Chemo ... (RASolute 305)
     阶段: Not specified | 状态: 🟢 招募中
     药物: Zoldonrasib, Placebo, Oxaliplatin ...
     Biomarker: KRAS G12D, ATM, MET
     申办方: Revolution Medicines, Inc.
     国家: United States
     📅 发布: 2026-06-05
     🔗 https://clinicaltrials.gov/study/NCT07621718
```

### 智能总结

```
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

  🔑 关键发现:
     •   招募中试验占 100%（9/9）
     •   最热门靶点: MET(9), ATM(8), KRAS G12D(7)
     •   试验覆盖 22 个国家/地区
```

## 🧬 基因配置（27 靶点）

| 分组 | 基因 | 数量 | 月报 |
|------|------|------|------|
| **A 指南推荐** | EGFR, KRAS, HER2(ERBB2), TROP2, CLDN18.2, BRCA1/2, ATM, BRAF V600E, NTRK, NRG1, RET, FGFR2 | 13 | 部分 |
| **B 临床热点** | SHP2, C-MET(MET), TF(组织因子), HRRAS | 4 | ✅ 全部 |
| **C 进阶靶点** | MSLN, B7-H3, Nectin-4, pan-TRK, CDH17, CEACAM5, MTAP(loss), MUC1, DLL3, CA125 | 10 | ✅ 全部 |
| **D 补充检测** | FOLR1 | 1 | ✅ 全部 |

> 月报默认覆盖全部 27 个基因（B+C+D 全部 + A 组的 KRAS/HER2/TROP2/CLDN18.2/BRCA1/2）

## ⚡ 常见问题

**Q: 搜索返回 403 错误？**
- A: 通常为 API 临时限流。代码已自动重试 5 次 + 指数退避，请稍后重试。

**Q: 月报生成很慢？**
- A: 可选翻译耗时 ~1-2 分钟，建议默认关闭（LLM 分析已输出中文），或设置 `--no-llm` 跳过 LLM 生成骨架。

**Q: 如何只翻译标题？**
- A: `python3 scripts/report_nccn.py --translate`（开启），默认关闭。

**Q: 可以自定义月报基因列表吗？**
- A: 编辑 `config/genes.yaml` 中的 `report_defaults` 列表。

**Q: LLM 中文输出乱码？**
- A: 检查 `.env` 中 `LLM_BASE_URL` 和 `LLM_MODEL` 配置是否正确。

## 🔧 技术细节

- **API 版本**: ClinicalTrials.gov API v2
- **Python 版本**: 3.10+
- **主要依赖**: httpx（异步）, PyYAML（配置）, openai（LLM）
- **并发优化**: LLM 分析 2 并发，翻译 batch_size=8

## 🤖 AI Agent 部署

克隆仓库 → 安装依赖 → 运行验证即可：

```bash
git clone https://github.com/opencare-skillhub/clinicaltrials-query-analysis.git
cd clinicaltrials-search
pip install -r requirements.txt
python3 scripts/search.py --keyword "KRAS G12D"
```

详细部署提示词见 README.md。