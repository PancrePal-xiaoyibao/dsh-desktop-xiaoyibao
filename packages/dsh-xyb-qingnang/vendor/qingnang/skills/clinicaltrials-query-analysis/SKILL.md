---
name: clinicaltrials-search
description: 全栈临床试验搜索+专题报告技能。覆盖 KRAS/CLDN18.2/B7-H3/PROTAC/RASi-ADC 等靶点，标准化流水线：search → enrich → build_report → convert_html。输出中英对照报告含中国中心专题+可及性分析。
---

# 临床试验搜索与专题报告技能

## 标准化报告流水线

```
search_{keyword}.py          → 多关键词搜索 ClinicalTrials.gov
fetch_details_batch.py       → 抓取详情（PI、联络方式、中国中心医院及联系人）
build_{keyword}_report.py    → 生成专题综合报告（固定提纲MD）
convert_to_xyb_html.py       → 转为精美HTML（xyb公众号模板）
```

## 固定报告提纲（每篇报告必须包含）

| 章节 | 内容 | 必含字段 |
|------|------|----------|
| **1. 检索结果概览** | 总试验数、招募状态分布、阶段分布、治疗类型分布、申办方Top10、地理分布 | 中英对照统计表格 |
| **2. 靶点介绍与治疗原理** | 靶点基本信息、生物学功能、表达谱、治疗原理（ADC/CAR-T/PROTAC等机制详解） | 中英对照+机制图解 |
| **3. 临床试验清单** | 按治疗类型分组的完整试验表格 | NCT编号、药物、靶点、适应症、阶段、状态、中国flag |
| **4. 🇨🇳 中国中心临床专题** | 每项中国试验的PI姓名、各中心医院、联系人、电话 | **PI必含**、医院详情、联络方式 |
| **5. 📊 可及性分析** | 中国患者可及性评分、费用医保评估、城市中心分布热力图 | 5维评分+地理分布 |
| **6. 🔭 前景展望** | 时间线预测、企业排名、关键技术挑战 | 企业评分+里程碑 |
| **7. 📋 患者建议** | 行动清单、当前可及选项、风险评估 | 行动项+可及性导航 |

## 已生成的专题报告

| 靶点 | 状态 | 中国中心 | 格式 |
|------|:----:|:----:|------|
| **CLDN18.2** | 65项(54中国) | ✅ 含PI+医院 | MD/DOCX/PDF/XLSX/HTML |
| **B7-H3 (CD276)** | 79项(42中国) | ✅ 含PI+医院 | MD/HTML |
| **RASi-ADC** | 22项(3中国) | ✅ 含PI+医院+荣昌专题 | MD/HTML |
| **PROTAC+RASi** | 14+22项(5中国) | ✅ 含PI+医院+可及性 | MD/HTML |

## 核心脚本

```
scripts/
├── search.py                  # 通用单基因搜索（CLI）
├── search_{target}.py         # 靶点专项多关键词搜索
├── fetch_details_batch.py     # 批量抓取详情（通用）
├── generate_reports.py        # CLDN18.2五格式导出
├── report_nccn.py             # NCCN月报生成器
├── report_b7h3.py             # B7-H3专题报告
├── build_rasi_adc_report.py   # RASi-ADC专题报告
├── build_protac_rasi_report.py# PROTAC+RASi联合专题报告
├── convert_to_xyb_html.py     # MD→xyb风格HTML（通用）
├── config_loader.py           # 配置加载器
├── translator.py              # 双语翻译模块
└── main.py                    # 交互式菜单入口
```

## 依赖

- Python 3.10+
- httpx, PyYAML, openai, openpyxl, python-docx, fpdf2, markdown, beautifulsoup4
- ClinicalTrials.gov API 免费
- LLM翻译需配置 LLM_API_KEY（可选）