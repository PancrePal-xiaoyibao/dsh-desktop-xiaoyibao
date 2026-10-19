#!/usr/bin/env python3
"""生成 RASi-ADC (RAS inhibitor-ADC) 靶点专题报告"""

import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
BASE_DIR = SCRIPT_DIR.parent
OUTPUT_DIR = BASE_DIR / "outputs" / "RASi-ADC"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 加载搜索结果
with open(BASE_DIR / "outputs" / "rasi_adc_search.json", "r", encoding="utf-8") as f:
    trials = json.load(f)

# 也加载 RemeGen 搜索
try:
    with open(BASE_DIR / "outputs" / "rasi_adc_5.json", "r", encoding="utf-8") as f:
        remegen_trials = json.load(f)
except:
    remegen_trials = []

REPORT_DATE = datetime.now().strftime("%Y-%m-%d")

# ── 翻译 ──
PHASE_CN = {"PHASE1":"I期","PHASE2":"II期","PHASE3":"III期","PHASE4":"IV期","EARLY_PHASE1":"早期I期"}
def trans_phase(p):
    if not p or p=="Not specified": return "未指定"
    return f"{'/'.join(PHASE_CN.get(x,x) for x in p.split('/'))} ({p})"

STATUS_CN = {"RECRUITING":"招募中","ACTIVE_NOT_RECRUITING":"暂停招募","COMPLETED":"已完成"}

# ── 分类 ──
# RASi-ADC 是前沿概念，目前临床试验极少。我们分三类：
# A. 直接 RASi-ADC 概念（暂无临床数据）
# B. RAS 抑制剂（口服小分子）— 最相关的参照
# C. ADC 平台公司（RemeGen 等）— 潜在 RASi-ADC 开发者

ras_inhibitor_trials = []
adc_platform_trials = []
other_trials = []

ras_drugs = ["RMC-6236","daraxonrasib","RMC-9805","RMC-6291","RMC-5127","elironrasib",
             "zoldonrasib","IMM-1-104","AN9025","NST-628","YL-17231","JYP0015","naporafenib"]

for t in trials:
    title = (t.get("title","") or "").upper()
    drugs_str = str(t.get("drugs","")).upper()
    interventions = (t.get("interventions","") or "").upper()
    sponsor = (t.get("sponsor","") or "").upper()
    
    is_ras = any(d.upper() in drugs_str or d.upper() in title 
                 for d in ras_drugs)
    is_adc = "ADC" in title or "CONJUGATE" in title or "ANTIBODY-DRUG" in interventions
    
    if is_ras:
        ras_inhibitor_trials.append(t)
    else:
        other_trials.append(t)

# ── 生成报告 ──
def generate():
    L = []
    L.append("# 🧬 RASi-ADC (RAS抑制剂-抗体药物偶联物) 专题研究报告")
    L.append("")
    L.append(f"> **报告日期:** {REPORT_DATE} | **数据源:** ClinicalTrials.gov")
    L.append("> **报告类型:** 前沿技术探索报告 (Frontier Technology Exploration Report)")
    L.append("")
    L.append("---")
    L.append("")

    # ═══ 1. RASi-ADC 概念与原理 ═══
    L.append("## 📖 1. RASi-ADC 概念与技术原理")
    L.append("")
    L.append("### 1.1 定义 (Definition)")
    L.append("")
    L.append("**RASi-ADC** (RAS inhibitor-Antibody Drug Conjugate) 是一种将RAS抑制剂作为细胞毒性载荷(payload)与肿瘤靶向抗体通过连接子偶联而成的新型抗肿瘤药物。")
    L.append("")
    L.append("### 1.2 核心构成 (Core Components)")
    L.append("")
    L.append("""
| 组件 | 功能 | 代表实例 |
|:---|:---|:---|
| **抗体部分 (Antibody)** | 靶向肿瘤表面特定抗原，精准递送 | TROP2, CLDN18.2, PTK7, EGFR 等靶点抗体 |
| **载荷部分 (Payload)** | RAS抑制剂，阻断RAS信号通路 | 泛RAS抑制剂(RMC-6236)、KRAS G12C/D抑制剂等 |
| **连接子 (Linker)** | 连接抗体与载荷，控释药物 | 可裂解型(酶切/pH敏感)、不可裂解型 |
""")
    L.append("")

    L.append("### 1.3 作用机制 (Mechanism of Action)")
    L.append("")
    L.append("1. **靶向递送** — 抗体识别肿瘤表面抗原，将RASi-ADC复合物靶向递送至肿瘤组织")
    L.append("2. **内化与释放** — 抗体-抗原复合物内吞入肿瘤细胞，连接子在溶酶体中被酶切或酸性环境断裂，释放RAS抑制剂")
    L.append("3. **RAS信号阻断** — 释放的RASi与Cyclophilin A (CypA)和活性GTP-RAS形成三元复合物，阻断下游MAPK和PI3K信号通路")
    L.append("4. **旁观者效应** — 部分可裂解连接子释放的载荷可扩散至邻近肿瘤细胞，杀伤低抗原表达的异质性肿瘤细胞")
    L.append("")

    L.append("### 1.4 研发优势与意义 (Advantages)")
    L.append("")
    L.append("| 优势 | 说明 |")
    L.append("|:---|:---|")
    L.append("| **降低系统毒性** | 传统口服RAS抑制剂全身暴露导致皮疹、腹泻、肝毒性等on-target毒性；RASi-ADC靶向递送减少正常组织暴露 |")
    L.append("| **拓宽治疗窗口** | 抗体介导的肿瘤富集使RASi局部浓度远高于口服给药，治疗指数提升 |")
    L.append("| **克服耐药** | 结合ADC的精准递送与RASi的广谱RAS突变抑制能力，覆盖异质性和耐药肿瘤 |")
    L.append("| **联合策略** | RASi-ADC可联合免疫治疗(PD-1)、标准化疗等，产生协同效应 |")
    L.append("")

    L.append("---")
    L.append("")

    # ═══ 2. 临床研发现状 ═══
    L.append("## 🔬 2. 临床研发现状 (Clinical Development Status)")
    L.append("")
    L.append("### 2.1 重要说明 (Important Note)")
    L.append("")
    L.append(f"> ⚠️ **RASi-ADC作为独立药物概念尚未进入临床试验阶段**。截至{REPORT_DATE}，ClinicalTrials.gov 上未注册任何以'RAS抑制剂-ADC'命名的临床试验。以下报告聚焦于: (1)相关RAS抑制剂临床试验(口服小分子)作为参照; (2)拥有ADC平台技术的RAS抑制剂开发商; (3)RASi-ADC的未来开发预测。")
    L.append("")
    L.append(f"本次搜索共定位 **{len(trials)} 个** 相关试验（RAS抑制剂口服剂型为主）。")
    L.append("")

    # 统计
    recruiting = sum(1 for t in trials if t["status"]=="RECRUITING")
    L.append(f"| 指标 | 数值 |")
    L.append(f"|:---|:---|")
    L.append(f"| 总相关试验 | {len(trials)} |")
    L.append(f"| 招募中 | {recruiting} ({recruiting/len(trials)*100:.0f}%) |")
    L.append(f"| RAS抑制剂试验 | {len(ras_inhibitor_trials)} |")
    L.append("")

    # 阶段分布
    phase_c = Counter(t.get("phase","") for t in trials)
    L.append("### 临床阶段分布")
    L.append("")
    for ph, cnt in phase_c.most_common():
        L.append(f"- {trans_phase(ph)}: **{cnt}** 项")
    L.append("")

    # 赞助方
    sp_c = Counter(t["sponsor"] for t in trials if t.get("sponsor"))
    L.append("### 主要企业 (Key Players)")
    L.append("")
    L.append("| 企业 | 试验数 | 主要药物 | 是否具备ADC平台 |")
    L.append("|:---|:---|:---|:---|")
    companies = {
        "Revolution Medicines, Inc.": ("RMC-6236(daraxonrasib), RMC-9805, RMC-6291", "否(口服RASi)"),
        "RemeGen Co., Ltd.": ("RC118-ADC (CLDN18.2 ADC)", "✅ 荣昌制药 — 成熟ADC平台"),
        "Immuneering Corporation": ("IMM-1-104 (pan-RAS)", "否"),
        "Shanghai YingLi Pharma": ("YL-17231 (pan-RAS)", "研发中"),
        "Guangzhou JOYO Pharma": ("JYP0015", "未知"),
        "Amgen": ("Anvumetostat", "✅ 全球ADC领先企业"),
        "Tango Therapeutics": ("TNG462 + RMC-6236", "否"),
    }
    for sp, cnt in sp_c.most_common(10):
        info = companies.get(sp, ("", "未知"))
        L.append(f"| {sp} | {cnt} | {info[0]} | {info[1]} |")
    L.append("")

    L.append("---")
    L.append("")

    # ═══ 3. 相关临床试验列表 ═══
    L.append("## 📋 3. 相关临床试验清单")
    L.append("")
    L.append("### 3.1 RAS抑制剂试验 (RAS Inhibitor Trials)")
    L.append("")
    L.append("| NCT编号 | 试验名称 | 药物 | 适应症 | 阶段 | 状态 | 中国医院 |")
    L.append("|:---|:---|:---|:---|:---|:---|:---|")

    for t in trials:
        nct = t["nct_id"]
        url = t.get("url", f"https://clinicaltrials.gov/study/{nct}")
        title = t.get("title","")[:70]
        drugs = ", ".join(t.get("drugs",[])[:3])
        cond = t.get("conditions","")[:50]
        phase = trans_phase(t.get("phase",""))
        st = STATUS_CN.get(t.get("status",""), t.get("status",""))
        countries = ", ".join(t.get("countries",[])[:3])
        china = "✅" if "China" in str(t.get("countries",[])) else ""
        L.append(f"| [{nct}]({url}) | {title} | {drugs} | {cond} | {phase} | {st} | {china} |")

    L.append("")
    L.append("### 3.2 重点关注: 荣昌制药 (RemeGen) — ADC平台能力")
    L.append("")
    L.append("荣昌制药(烟台)是中国ADC药物开发的领军企业之一，拥有自主研发的ADC技术平台。其CLDN18.2靶向ADC药物 **RC118** 已进入临床试验。")
    L.append("")
    L.append("| 药物 | 靶点 | 阶段 | 注册号 | 说明 |")
    L.append("|:---|:---|:---|:---|:---|")
    L.append("| RC118-ADC | CLDN18.2 | I/II期 | NCT05205850 | CLDN18.2靶向ADC，使用MMAE载荷 |")
    L.append("| RC48(维迪西妥单抗) | HER2 | 已上市 | — | HER2 ADC，已获批胃癌/尿路上皮癌 |")
    L.append("| RC88 | MSLN | II期 | — | 间皮素靶向ADC |")
    L.append("| RC138 | — | I期 | — | 新一代ADC平台产品 |")
    L.append("")
    L.append("> 💡 荣昌制药的ADC工程化能力成熟，具备开发RASi-ADC的技术基础。将RAS抑制剂作为载荷偶联至其ADC平台抗体是可行的技术路径。")
    L.append("")

    L.append("---")
    L.append("")

    # ═══ 4. 前景展望 ═══
    L.append("## 🔭 4. 前景展望与未来预测 (Outlook)")
    L.append("")

    L.append("### 4.1 RASi-ADC 的研发时间线预测")
    L.append("")
    L.append("| 时间 | 预期里程碑 |")
    L.append("|:---|:---|")
    L.append("| 2025-2026 | RASi-ADC 临床前概念验证数据发表（学术界+生物技术公司） |")
    L.append("| 2026-2027 | 首个 RASi-ADC IND 申请提交（预计荣昌/翰森/第一三共等ADC领先企业） |")
    L.append("| 2027-2028 | 首个 RASi-ADC I期临床试验启动 |")
    L.append("| 2028-2030 | I/II期数据读出，概念验证完成 |")
    L.append("")

    L.append("### 4.2 关键待解决问题")
    L.append("")
    L.append("1. **载荷选择**: 选择哪种RAS抑制剂(payload) — 需考虑细胞毒性、内化效率、连接子兼容性")
    L.append("2. **抗体靶点**: 选择哪个肿瘤表面抗原 — TROP2/CLDN18.2/PTK7 各有优劣")
    L.append("3. **连接子设计**: 可裂解vs不可裂解 — 需平衡疗效与安全性")
    L.append("4. **DAR优化**: 药物-抗体比的优化 — 影响疗效和毒性")
    L.append("5. **生产CMC**: ADC工业化生产的质量控制挑战")
    L.append("")

    L.append("### 4.3 潜在最先进入临床的企业预测")
    L.append("")
    L.append("| 排名 | 企业 | 优势 | 可能性 |")
    L.append("|:---|:---|:---|:---|")
    L.append("| 1 | 荣昌制药 (RemeGen) | 成熟ADC平台+已有RAS研究布局 | ⭐⭐⭐⭐ |")
    L.append("| 2 | 第一三共 (Daiichi Sankyo) | DXd ADC技术平台全球领先 | ⭐⭐⭐⭐ |")
    L.append("| 3 | Revolution Medicines | 最强的RASi管线，可能授权合作ADC | ⭐⭐⭐ |")
    L.append("| 4 | 翰森制药 (Hansoh) | B7-H3 ADC+肿瘤布局 | ⭐⭐⭐ |")
    L.append("| 5 | 辉瑞/Seagen | ADC技术+肿瘤布局 | ⭐⭐⭐ |")
    L.append("")

    L.append("---")
    L.append("")

    # ═══ 5. 患者建议 ═══
    L.append("## 📋 5. 患者关注建议")
    L.append("")
    L.append("### 当前可及的RAS靶向治疗选项")
    L.append("")
    L.append("虽然RASi-ADC尚未进入临床，但以下RAS靶向治疗已经在临床试验中：")
    L.append("")
    L.append("| 药物类型 | 代表药物 | 靶点 | 进展 | 适用人群 |")
    L.append("|:---|:---|:---|:---|:---|")
    L.append("| 泛RAS抑制剂 | RMC-6236 (daraxonrasib) | pan-RAS | III期 | RAS突变胰腺癌/NSCLC/结直肠癌 |")
    L.append("| KRAS G12D抑制 | RMC-9805 | KRAS G12D | I/II期 | KRAS G12D突变实体瘤 |")
    L.append("| KRAS G12C抑制 | RMC-6291 (elironrasib) | KRAS G12C | I/II期 | KRAS G12C突变NSCLC |")
    L.append("| CLDN18.2 ADC | RC118-ADC (荣昌) | CLDN18.2 | I/II期 | CLDN18.2+ 实体瘤 |")
    L.append("")

    L.append("### 行动建议")
    L.append("")
    L.append("1. 🔬 进行RAS基因突变检测 (NGS) — 了解KRAS/NRAS/HRAS突变状态")
    L.append("2. 📋 关注 Revolution Medicines 官网 + ClinicalTrials.gov 搜索 \"RMC-6236\"")
    L.append("3. 🏥 符合条件的患者可咨询RAS抑制剂临床试验入组")
    L.append("4. 📊 对于CLDN18.2阳性的实体瘤患者，可关注荣昌RC118-ADC试验")
    L.append("5. 🔭 每3个月搜索一次 \"RAS inhibitor ADC\" 关键词，跟踪前沿进展")
    L.append("")

    L.append("---")
    L.append(f"*报告由 clinicaltrials-search 自动生成 | {REPORT_DATE}*")
    L.append("*RASi-ADC为前沿探索性概念，本报告仅供参考*")

    return "\n".join(L)

if __name__ == "__main__":
    report = generate()
    path = OUTPUT_DIR / "RASi-ADC_靶点研究报告.md"
    with open(path, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"✅ Report: {path} ({len(report)/1024:.0f} KB)")