import os
import json
import requests
from datetime import datetime
from dotenv import load_dotenv
from pathlib import Path

# 加载环境变量
load_dotenv()

# LLM 配置已抽取到 lib/llm_client.py(消除多文件重复)
# 全文翻译使用 PROMPT_FULL_MARKDOWN(保留原有 Markdown 结构)
from lib.llm_client import translate_text as _translate_base, PROMPT_FULL_MARKDOWN
from lib.branding import get_footer, is_pancreatic

def translate_text(text):
    """
    全文 Markdown 翻译(保留原有结构),失败返回原文。
    委托给 lib.llm_client.translate_text,使用全文翻译 prompt。
    """
    return _translate_base(text, system_prompt=PROMPT_FULL_MARKDOWN, retry=1, timeout=120)

def format_to_markdown_en(study):
    protocol = study.get("protocolSection", {})
    ident = protocol.get("identificationModule", {})
    status = protocol.get("statusModule", {})
    desc = protocol.get("descriptionModule", {})
    cond = protocol.get("conditionsModule", {})
    design = protocol.get("designModule", {})
    arms = protocol.get("armsInterventionsModule", {})
    sponsor = protocol.get("sponsorCollaboratorsModule", {})
    eligibility = protocol.get("eligibilityModule", {})
    outcomes = protocol.get("outcomesModule", {})
    loc_mod = protocol.get("contactsLocationsModule", {})
    
    nct_id = ident.get("nctId", "N/A")

    # 提取发起方和协作方
    lead_sponsor = sponsor.get("leadSponsor", {}).get("name", "N/A")
    collaborators = [c.get("name") for c in sponsor.get("collaborators", [])]
    collaborators_str = ", ".join(collaborators) if collaborators else "None"

    # 提取中心信息 (区分中国和其他)
    locations = loc_mod.get("locations", [])
    china_locations = []
    other_locations = []
    for loc in locations:
        loc_str = f"- {loc.get('facility', 'N/A')} ({loc.get('city', 'N/A')}, {loc.get('country', 'N/A')}) - Status: {loc.get('status', 'N/A')}"
        if loc.get('country') == "China":
            china_locations.append(loc_str)
        else:
            other_locations.append(loc_str)

    lines = [
        f"# 🏥 Clinical Trial Details: {nct_id}\n",
        f"## Metadata",
        f"- **NCT ID**: {nct_id}",
        f"- **Overall Status**: {status.get('overallStatus', 'N/A')}",
        f"- **Brief Title**: {ident.get('briefTitle', 'N/A')}",
        f"- **Official Title**: {ident.get('officialTitle', 'N/A')}",
        f"\n## 🏢 Organizations & Sponsors",
        f"- **Lead Sponsor**: {lead_sponsor}",
        f"- **Collaborators**: {collaborators_str}",
        f"\n## 📝 Basic Information",
        f"- **Study Type**: {design.get('studyType', 'N/A')}",
        f"- **Phase**: {', '.join(design.get('phases', [])) if design.get('phases') else 'N/A'}",
        f"- **Enrollment**: {design.get('enrollmentInfo', {}).get('count', 'N/A')} ({design.get('enrollmentInfo', {}).get('type', 'N/A')})",
        f"\n## 🧪 Study Design & Details",
        f"- **Conditions**: {', '.join(cond.get('conditions', [])) if cond.get('conditions') else 'N/A'}"
    ]
    
    # 干预措施
    interventions = arms.get("interventions", [])
    if interventions:
        lines.append(f"\n### Interventions")
        for inv in interventions:
            lines.append(f"- **{inv.get('type', 'Unknown')}**: {inv.get('name', 'N/A')}")
            if inv.get('description'):
                lines.append(f"  - *Description*: {inv.get('description')}")

    # 主要和次要终点
    primary = outcomes.get("primaryOutcomes", [])
    if primary:
        lines.append(f"\n## 📊 Primary Outcomes")
        for o in primary:
            lines.append(f"- **{o.get('measure', 'N/A')}**: {o.get('description', 'N/A')}")
            
    # 描述部分
    lines.append(f"\n## 📖 Summary & Description")
    lines.append(f"### Brief Summary\n{desc.get('briefSummary', 'No summary available.')}")
    if desc.get('detailedDescription'):
        lines.append(f"\n### Detailed Description\n{desc.get('detailedDescription')}")

    # 入组标准
    lines.append(f"\n## 📋 Eligibility Criteria")
    lines.append(f"- **Gender**: {eligibility.get('sex', 'N/A')}")
    lines.append(f"- **Minimum Age**: {eligibility.get('minimumAge', 'N/A')}")
    lines.append(f"- **Maximum Age**: {eligibility.get('maximumAge', 'N/A')}")
    if eligibility.get('eligibilityCriteria'):
        lines.append(f"\n### Detailed Criteria\n{eligibility.get('eligibilityCriteria')}")

    # 临床中心信息
    lines.append(f"\n## 📍 Study Locations")
    lines.append(f"### 🇨🇳 China Centers")
    lines.append("\n".join(china_locations) if china_locations else "No centers listed in China.")
    lines.append(f"\n### Global Centers")
    lines.append("\n".join(other_locations[:20]) if other_locations else "No other centers listed.")
    if len(other_locations) > 20:
        lines.append(f"...(and {len(other_locations)-20} more)")
        
    lines.append(f"\n## 📑 Links")
    lines.append(f"- [View on ClinicalTrials.gov](https://clinicaltrials.gov/study/{nct_id})")
    
    return "\n".join(lines)

def translate_json_recursively(data):
    """
    递归翻译 JSON 中的关键文本字段，保持结构不变
    """
    if isinstance(data, dict):
        for key in list(data.keys()):
            value = data[key]
            # 翻译核心长文本字段
            if key in ["briefSummary", "detailedDescription", "eligibilityCriteria", "officialTitle", "briefTitle", "measure", "description"]:
                if isinstance(value, str) and len(value) > 10:
                    data[key] = translate_text(value)
            else:
                translate_json_recursively(value)
    elif isinstance(data, list):
        for item in data:
            translate_json_recursively(item)

def process_pending_sync():
    output_path = Path("output")
    if not output_path.exists():
        return

    for folder in output_path.iterdir():
        if not folder.is_dir():
            continue
            
        for json_file in folder.glob("*.json"):
            try:
                with open(json_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                
                if data.get("sync_status") != "pending":
                    continue
                
                print(f"[{datetime.now()}] Deep syncing (Full Translation) {json_file.name}...")
                study = data["original"]
                
                # 直接生成完整的英文 Markdown (包含多中心和发起方)
                md_en = format_to_markdown_en(study)
                
                # 对 JSON 内容进行中文递归翻译 (保持结构)
                translate_json_recursively(data)
                
                # 直接对全文 Markdown 进行精翻
                md_cn = translate_text(md_en)
                
                # 追加社区公益脚注(胰腺癌专属 / 其它疾病通用,按目录名对应的疾病判断)
                # folder.name 形如 "2026-06-21-Breast_Cancer",提取日期后的疾病名
                folder_disease = "-".join(folder.name.split("-")[3:]).replace("_", " ")
                footer_text = get_footer(folder_disease).lstrip("* ").strip()
                footer = f"\n\n---\n**{footer_text}**"
                md_cn += footer

                # 生成描述性文件名 (Date-NCT-Title)
                ident = study.get("protocolSection", {}).get("identificationModule", {})
                nct_id = ident.get("nctId", json_file.stem)
                brief_title = ident.get("briefTitle", "")
                # 清理标题中的特殊字符，保留空格和基本标点
                clean_title = "".join([c if c.isalnum() or c in " -_," else "_" for c in brief_title])[:60].strip()
                date_str = datetime.now().strftime("%Y-%m-%d")
                base_name = f"{date_str}-{nct_id}-{clean_title}".strip("-")
                
                # 落地存储
                en_dir = folder / "en"
                cn_dir = folder / "cn"
                en_dir.mkdir(exist_ok=True)
                cn_dir.mkdir(exist_ok=True)
                
                with open(en_dir / f"{base_name}.md", "w", encoding="utf-8") as f:
                    f.write(md_en)
                # 配合同步逻辑，中文精翻文档统一加上 -zh 后缀
                with open(cn_dir / f"{base_name}-zh.md", "w", encoding="utf-8") as f:
                    f.write(md_cn)
                
                # 更新 JSON 状态
                data["sync_status"] = "synced"
                # 清除旧的片段翻译缓存
                if "full_translated" in data:
                    del data["full_translated"]
                    
                with open(json_file, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                
                print(f"[{datetime.now()}] Successfully full-synced {json_file.name}")
                
            except Exception as e:
                print(f"Error processing {json_file}: {e}")

if __name__ == "__main__":
    print(f"=== Full-text RAG Sync Task Started at {datetime.now()} ===")
    process_pending_sync()
    print(f"=== Sync Task Completed at {datetime.now()} ===")
