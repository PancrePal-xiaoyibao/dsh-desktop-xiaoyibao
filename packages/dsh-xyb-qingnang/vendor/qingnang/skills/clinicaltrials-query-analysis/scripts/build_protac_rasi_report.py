#!/usr/bin/env python3
"""PROTAC+RASi联合治疗专题报告 — 完整版（含中国中心+可及性分析）"""

import json
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
OUTPUT_DIR = BASE_DIR / "outputs" / "PROTAC_RAS"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
REPORT_DATE = datetime.now().strftime("%Y-%m-%d")

# ── 加载数据 ──
with open(BASE_DIR / "outputs" / "protac_search.json") as f:
    protac_trials = json.load(f)

try:
    with open(BASE_DIR / "outputs" / "protac_enriched.json") as f:
        protac_enriched = json.load(f)
    protac_map = {t["nct_id"]: t for t in protac_enriched}
except:
    protac_map = {}

try:
    with open(BASE_DIR / "outputs" / "rasi_adc_search.json") as f:
        rasi_trials = json.load(f)
except:
    rasi_trials = []

# ── 翻译 ──
STATUS_CN = {"RECRUITING":"招募中","ACTIVE_NOT_RECRUITING":"暂停招募","COMPLETED":"已完成"}
PHASE_CN = {"PHASE1":"I期","PHASE2":"II期","PHASE3":"III期","PHASE4":"IV期","EARLY_PHASE1":"早期I期"}

def fmt_pi(t):
    pi = t.get("pi")
    if not pi or not pi.get("name"): return "未公开 (Not disclosed)"
    aff = pi.get("aff","")
    return f"{pi['name']} ({aff})" if aff else pi['name']

def fmt_contact(t):
    cc = t.get("central_contact",{})
    parts = [cc.get("name","")]
    if cc.get("phone"): parts.append(f"📞 {cc['phone']}")
    if cc.get("email"): parts.append(f"✉️ {cc['email']}")
    return " | ".join(p for p in parts if p) or "未公开"

# ── 中国中心专用 ──
china_protac = [t for t in protac_enriched if t.get("china_locations")] if protac_enriched else []

def generate():
    L = []
    # ═══════════════════════════════ 封面 ═══════════════════════════════
    L.append("# 🎯 PROTAC 降解剂 + RAS 抑制剂联合治疗专题报告")
    L.append("")
    L.append(f"> **报告日期:** {REPORT_DATE} | **数据源:** ClinicalTrials.gov")
    L.append("> **报告类型:** 前沿技术探索报告 (Frontier Technology Exploration)")
    L.append("> **覆盖范围:** PROTAC/分子胶降解剂临床概况 + RAS抑制剂全景 + 联合策略前瞻 + 中国中心专题 + 可及性分析")
    L.append("")
    L.append("---")
    L.append("")

    # ═══════════════════════════════ 1. 检索概览 ═══════════════════════════════
    L.append("## 📊 1. 检索结果概览 (Search Results Overview)")
    L.append("")
    L.append("| 指标 | 数值 |")
    L.append("|:---|:---|")
    L.append(f"| PROTAC/分子胶降解剂试验 | **{len(protac_trials)}** |")
    L.append(f"| 招募中 PROTAC 试验 | **{sum(1 for t in protac_trials if t['status']=='RECRUITING')}** |")
    L.append(f"| RAS 抑制剂试验（参照） | **{len(rasi_trials)}** |")
    L.append(f"| PROTAC+RASi 联合试验 | **0** （前沿空白） |")
    L.append(f"| 在中国开展 | **{len(china_protac)}** |")
    L.append(f"| 含 PI 数据 | **{sum(1 for t in protac_enriched if t.get('pi'))}/{len(protac_enriched) if protac_enriched else 0}** |")
    L.append("")
    L.append("---")
    L.append("")

    # ═══════════════════════════════ 2. 概念与原理 ═══════════════════════════════
    L.append("## 📖 2. PROTAC 降解剂 + RAS 抑制剂联合：概念与原理")
    L.append("")
    L.append("### 2.1 核心概念")
    L.append("**PROTAC (Proteolysis Targeting Chimera) + RAS 抑制剂联合治疗** 是将两种革命性抗肿瘤策略协同组合的全新范式：")
    L.append("- **PROTAC 降解剂**：通过泛素-蛋白酶体系统 **彻底降解** 靶蛋白，从根本上消除耐药驱动蛋白")
    L.append("- **RAS 抑制剂**：阻断 RAS-RAF-MEK-ERK 和 PI3K-AKT 信号通路，抑制肿瘤增殖")
    L.append("- **组合逻辑**：降解（消除耐药蛋白）+ 阻断（切断增殖信号）= 攻克多维度耐药")
    L.append("")
    L.append("### 2.2 为什么降解优于抑制？(Degradation > Inhibition)")
    L.append("")
    L.append("| 传统小分子抑制剂 | PROTAC 降解剂 | 治疗新高度 |")
    L.append("|:---|:---|:---|")
    L.append("| 占据结合位点，可逆或不可逆抑制 | 介导靶蛋白多聚泛素化→蛋白酶体**彻底降解** | 消除所有功能域（酶活+支架+蛋白互作） |")
    L.append("| 需高浓度持续占据 | **催化型**，一个PROTAC可降解多个靶蛋白 | 亚化学计量级即有效 |")
    L.append("| 靶蛋白突变→耐药 | 结合任意位置即可降解，**不易耐药** | 克服点突变耐药 |")
    L.append("| 只阻断单一功能域 | **消除整个蛋白** | 对多功能蛋白更彻底 |")
    L.append("| 限于可成药活性位点 | 理论上任何可结合蛋白 | **将不可成药靶点变为可成药** |")
    L.append("")
    L.append("### 2.3 PROTAC 四步机制")
    L.append("")
    L.append("1. 🎯 **双端结合** — PROTAC一端结合靶蛋白(POI)，另一端结合E3连接酶(CRBN/VHL)")
    L.append("2. 🧩 **三元复合物** — 形成 POI-PROTAC-E3 三元复合物，拉近空间距离")
    L.append("3. 🏷️ **泛素化标记** — E3将多聚泛素链共价连接到靶蛋白赖氨酸残基")
    L.append("4. 🗑️ **蛋白酶体降解** — 26S蛋白酶体识别并彻底降解靶蛋白为短肽")
    L.append("")
    L.append("### 2.4 PROTAC+RASi 协同机制：破解耐药")
    L.append("")
    L.append("| 耐药机制 | RASi 单药局限 | PROTAC 方案 | 联合效果 |")
    L.append("|:---|:---|:---|:---|")
    L.append("| RAS 二次突变 | 抑制剂无法结合 | 降解不需活性位点 | PROTAC清突变RAS + RASi抑制残留 → 双重封锁 |")
    L.append("| 旁路激活(BRAF/CRAF) | 下游持续激活 | 降解BRAF/CRAF旁路蛋白 | 消除旁路→RASi恢复敏感性 |")
    L.append("| RTK反馈上调(EGFR/HER2) | 上游反馈激活RAS | 降解RTK或SHP2适配蛋白 | 切断上游→下游RASi持续有效 |")
    L.append("| 抗凋亡上调(BCL-XL) | RASi促凋亡被对抗 | 降解BCL-XL恢复凋亡 | 合成致死→肿瘤凋亡 |")
    L.append("| 周期蛋白过表达 | 生长抑制被逃逸 | 降解CDK/Cyclin促停滞 | 周期停滞+信号阻断→消退 |")
    L.append("")
    L.append("---")
    L.append("")

    # ═══════════════════════════════ 3. 临床试验清单 ═══════════════════════════════
    L.append("## 📋 3. 临床试验清单")
    L.append("")
    L.append("### 3.1 临床在研 PROTAC/分子胶降解剂")
    L.append("")
    L.append("| NCT编号 | 药物 | 靶点/机制 | 适应症 | 申办方 | 状态 | 中国 |")
    L.append("|:---|:---|:---|:---|:---|:---|:---|")
    degrader_info = {
        "NCT06586957": ("NKT3964","PROTAC","晚期实体瘤","NiKang Therapeutics"),
        "NCT06620302": ("DT2216","BCL-XL PROTAC","复发/难治实体瘤","COG / Dialectic Therapeutics"),
        "NCT07226349": ("BG-75098","PROTAC","晚期实体瘤","BeOne Medicines"),
        "NCT07197554": ("ST-01156","RBM39 降解剂","晚期实体瘤","SEED Therapeutics"),
        "NCT05487170": ("RNK05047","BRD4 降解剂 (CHAMP™)","实体瘤/DLBCL","Ranok Therapeutics (杭州)"),
        "NCT02503423": ("ASTX660","XIAP/cIAP1 拮抗剂","实体瘤/淋巴瘤","Taiho Oncology"),
        "NCT06964009": ("DT2216+紫杉醇","BCL-XL + 化疗","铂耐药卵巢癌","Dana-Farber / DFCI"),
        "NCT07029399": ("NKT5097","CDK2/CDK4双降解","实体瘤/乳腺癌","NiKang Therapeutics"),
        "NCT05546268": ("MRT-2359","GSPT1 分子胶","肺癌/实体瘤","Monte Rosa Therapeutics"),
        "NCT06536400": ("HSK42360","BRAF V600E PROTAC","BRAF突变实体瘤","Haisco (海思科)"),
        "NCT07394374": ("CG001419","NTRK PROTAC (uSMITE™)","NTRK融合实体瘤","Cullgen (上海睿跃)"),
    }
    for t in protac_trials:
        nct = t["nct_id"]
        url = t.get("url",f"https://clinicaltrials.gov/study/{nct}")
        info = degrader_info.get(nct, ("—","—",t.get("conditions","—")[:30],t.get("sponsor","—")))
        drug, target, cond, sponsor = info
        st = STATUS_CN.get(t["status"],t["status"])
        has_cn = "✅" if any(c=="China" for c in t.get("countries",[])) else ""
        L.append(f"| [{nct}]({url}) | {drug} | {target} | {cond} | {sponsor} | {st} | {has_cn} |")
    L.append("")

    L.append("### 3.2 RAS 抑制剂临床概况（参照）")
    L.append("")
    L.append("| 药物 | 靶点 | 阶段 | 申办方 | 关键试验 |")
    L.append("|:---|:---|:---|:---|:---|")
    L.append("| RMC-6236/daraxonrasib | pan-RAS | **III期** | Revolution Medicines | RASolute 305 |")
    L.append("| RMC-9805 | KRAS G12D | I/II期 | Revolution Medicines | G12D 突变实体瘤 |")
    L.append("| RMC-6291/elironrasib | KRAS G12C | I/II期 | Revolution Medicines | G12C 突变 NSCLC |")
    L.append("| RMC-5127 | KRAS G12V | I期 | Revolution Medicines | G12V 突变实体瘤 |")
    L.append("| IMM-1-104 | pan-RAS | I/IIa期 | Immuneering | RAS 突变实体瘤 |")
    L.append("| YL-17231 | pan-RAS | I期 | 璎黎药业 (上海) | 中国口服泛RASi |")
    L.append("")
    L.append("---")
    L.append("")

    # ═══════════════════════════════ 4. 中国中心临床专题 ═══════════════════════════════
    L.append("## 🇨🇳 4. 中国中心临床试验专题 (China Center Trials)")
    L.append("")
    L.append(f"在中国开展的 PROTAC/降解剂临床试验共 **{len(china_protac)}** 项，以下列出各中心医院及联系人详情：")
    L.append("")

    for t in protac_enriched:
        china_locs = t.get("china_locations", [])
        if not china_locs:
            continue
        nct = t["nct_id"]
        url = t.get("url", f"https://clinicaltrials.gov/study/{nct}")
        st = STATUS_CN.get(t.get("status",""), t.get("status",""))
        title = t.get("title","")[:100]
        pi = fmt_pi(t)
        cc = fmt_contact(t)
        sponsor = t.get("sponsor","")

        L.append(f"### 🏥 [{nct}]({url}) — {title}")
        L.append("")
        L.append(f"| 字段 | 详情 |")
        L.append(f"|:---|:---|")
        L.append(f"| **申办方** | {sponsor} |")
        L.append(f"| **状态** | {st} |")
        L.append(f"| **PI（主要研究者）** | {pi} |")
        L.append(f"| **中心联络** | {cc} |")
        L.append(f"| **中国中心数** | {len(china_locs)} 个 |")
        L.append("")
        L.append("**各中心及联系人：**")
        L.append("")
        L.append("| # | 城市 | 医院 | 联系人 | 电话 |")
        L.append("|---|:---|:---|:---|:---|")
        for i, loc in enumerate(china_locs, 1):
            city = loc.get("city","")
            fac = loc.get("fac","")
            cname = loc.get("cname","")
            cphone = loc.get("cphone","")
            L.append(f"| {i} | {city} | {fac[:50]} | {cname or '—'} | {cphone or '—'} |")
        L.append("")
    L.append("---")
    L.append("")

    # ═══════════════════════════════ 5. 可及性分析 ═══════════════════════════════
    L.append("## 📊 5. 可及性分析 (Accessibility Analysis)")
    L.append("")

    L.append("### 5.1 中国患者可及性评估")
    L.append("")
    L.append("| 评估维度 | 现状 | 评分 |")
    L.append("|:---|:---|:---:|")
    L.append(f"| **中国中心试验数** | {len(china_protac)} 项（含海思科HSK42360、睿跃CG001419、Ranok RNK05047等） | ⭐⭐⭐ |")
    L.append("| **国内药企参与度** | 海思科(Haisco)、睿跃(Cullgen)、Ranok(杭州)三家本土企业 | ⭐⭐⭐⭐ |")
    L.append("| **患者入组机会** | HSK42360 遍布北京/广州/上海/福州等13个城市；CG001419 覆盖北京/成都/广州/杭州等6城 | ⭐⭐⭐⭐ |")
    L.append("| **PROTAC联合RASi可及性** | **暂不可及** — 无联合试验注册 | ⭐ (2027年预期改善) |")
    L.append("| **海外试验可及性** | 美国试验占主导，中国患者需远程咨询（DT2216、NKT5097等仅在美开展） | ⭐⭐ |")
    L.append("")

    L.append("### 5.2 费用与医保评估")
    L.append("")
    L.append("| 项目 | 现状 | 预测 |")
    L.append("|:---|:---|:---|")
    L.append("| PROTAC 降解剂 | 全为临床试验阶段，入组患者**免费治疗** | 上市后预计高端定价（参考ADC药物） |")
    L.append("| RAS 抑制剂 | RMC-6236 等为临床试验用药，**免费** | 上市后预计年费用 $100k-150k |")
    L.append("| PROTAC+RASi 联合 | 未进入临床，不可及 | 预计2030年前仍为临床试验阶段 |")
    L.append("| 中国医保覆盖 | PROTAC/RASi 暂未获批，无医保 | 预计首个PROTAC中国获批在2029-2031 |")
    L.append("")

    L.append("### 5.3 地理可及性热力图")
    L.append("")
    L.append("**中国 PROTAC 试验中心分布：**")
    L.append("")
    L.append("| 城市 | 试验数 | 代表医院 |")
    L.append("|:---|:---:|:---|")
    city_count = {}
    for t in protac_enriched:
        for loc in t.get("china_locations", []):
            city = loc.get("city","")
            city_count[city] = city_count.get(city, 0) + 1
    for city, cnt in sorted(city_count.items(), key=lambda x: -x[1]):
        hospitals = set()
        for t in protac_enriched:
            for loc in t.get("china_locations", []):
                if loc.get("city") == city:
                    hospitals.add(loc.get("fac","")[:30])
        L.append(f"| {city} | {cnt} | {', '.join(list(hospitals)[:3])} |")
    L.append("")
    L.append("---")
    L.append("")

    # ═══════════════════════════════ 6. 前景预测 ═══════════════════════════════
    L.append("## 🔭 6. 前景展望与联合方向预测")
    L.append("")
    L.append("### 6.1 最具潜力的 PROTAC+RASi 联合方向 Top 5")
    L.append("")
    L.append("| 排名 | 联合方案 | 科学依据 | 预期首个试验 |")
    L.append("|:---|:---|:---|:---|")
    L.append("| 1 | **KRAS PROTAC + KRAS G12C/D 抑制剂** | 降解突变KRAS+抑制残留信号，双重封锁 | 2027-2028 |")
    L.append("| 2 | **BCL-XL PROTAC (DT2216) + 泛RASi (RMC-6236)** | 合成致死：RASi促凋亡+降解消除抗凋亡 | 2027-2028 |")
    L.append("| 3 | **BRAF PROTAC (HSK42360) + KRASi** | 上游RASi+下游BRAF降解，全通路阻断 | 2028-2029 |")
    L.append("| 4 | **SHP2 PROTAC + KRASi** | 切断RTK→SHP2→RAS反馈，增强敏感性 | 2028-2030 |")
    L.append("| 5 | **CDK2/4 PROTAC (NKT5097) + 泛RASi** | 周期停滞+信号阻断双打击 | 2029-2030 |")
    L.append("")

    L.append("### 6.2 企业潜力排名")
    L.append("")
    L.append("| 排名 | 企业 | PROTAC能力 | RASi能力 | 联合评分 |")
    L.append("|:---|:---|:---|:---|:---:|")
    L.append("| 1 | Revolution Medicines | 布局RAS降解 | 全球最强RASi管线 | ⭐⭐⭐⭐⭐ |")
    L.append("| 2 | 辉瑞/Arvinas | ARV-471 (ER降解,III期) | 辉瑞肿瘤管线 | ⭐⭐⭐⭐⭐ |")
    L.append("| 3 | 海思科 (Haisco) | HSK42360 BRAF降解(I期) | 中国口服RAS布局 | ⭐⭐⭐⭐ |")
    L.append("| 4 | Dialectic / Nurix | 领先PROTAC平台 | 可合作RASi方 | ⭐⭐⭐⭐ |")
    L.append("| 5 | Monte Rosa | GSPT1分子胶(I/II期) | 可引进RASi | ⭐⭐⭐ |")
    L.append("| 6 | 睿跃 Cullgen | NTRK PROTAC(I/II期) | 可合作 | ⭐⭐⭐ |")
    L.append("")
    L.append("---")
    L.append("")

    # ═══════════════════════════════ 7. 患者建议 ═══════════════════════════════
    L.append("## 📋 7. 患者关注建议 (Patient Recommendations)")
    L.append("")
    L.append("### 当前可及的治疗选项")
    L.append("")
    L.append("| 治疗类型 | 代表药物 | 可及性 | 适合人群 | 中国中心 |")
    L.append("|:---|:---|:---|:---|:---|")
    L.append("| 泛RAS抑制剂 | RMC-6236 (III期) | ✅ 招募中 | RAS突变实体瘤 | 多国（中国未覆盖） |")
    L.append("| KRAS G12D抑制剂 | RMC-9805 | ✅ I/II期 | G12D突变 | 多国 |")
    L.append("| KRAS G12C抑制剂 | RMC-6291 | ✅ I/II期 | G12C突变NSCLC | 多国 |")
    L.append("| BRAF PROTAC | HSK42360 | ✅ I期 | BRAF V600E突变 | 🇨🇳 13城 |")
    L.append("| NTRK PROTAC | CG001419 | ✅ I/II期 | NTRK融合突变 | 🇨🇳 6城 |")
    L.append("| BRD4降解剂 | RNK05047 | ✅ I期 | 实体瘤/DLBCL | 🇨🇳 北京 |")
    L.append("| PROTAC（海外） | BG-75098 | ✅ I期 | 实体瘤 | 🇨🇳 8城 |")
    L.append("")

    L.append("### 行动建议（6 项）")
    L.append("")
    L.append("1. 🔬 **完善NGS检测** — KRAS/NRAS/HRAS/BRAF/NTRK 突变状态全面筛查")
    L.append("2. 📋 **关注 RAS 抑制剂** — ClinicalTrials.gov 搜索 \"RMC-6236\" / \"RMC-9805\"")
    L.append(f"3. 🇨🇳 **中国患者优先关注** — HSK42360 (BRAF PROTAC, 海思科)、CG001419 (NTRK PROTAC, 睿跃)")
    L.append("4. 🏥 **咨询就近中心** — 见第4章「中国中心临床专题」，联系就近医院")
    L.append("5. 📊 **检测降解靶蛋白** — BCL-XL/BRD4/BRAF表达水平 IHC 检测")
    L.append("6. 🔭 **前瞻跟踪** — 每季搜索 \"PROTAC AND KRAS\" / \"degrader AND RAS\"")
    L.append("")
    L.append("---")
    L.append(f"*报告由 clinicaltrials-search 技能自动生成 | {REPORT_DATE}*")
    L.append("*PROTAC+RASi 联合为前沿探索性概念，本报告仅供科研参考，不构成医疗建议*")
    return "\n".join(L)

if __name__ == "__main__":
    report = generate()
    path = OUTPUT_DIR / "PROTAC_RASi_联合治疗报告.md"
    with open(path, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"✅ MD: {path} ({len(report)/1024:.0f} KB)")