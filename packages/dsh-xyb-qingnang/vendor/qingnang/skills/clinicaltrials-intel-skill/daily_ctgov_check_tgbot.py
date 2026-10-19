"""
daily_ctgov_check_tgbot.py - ClinicalTrials.gov 抓取 + 多渠道推送

本文件已重构为薄调用方,核心能力已抽取到 lib/ 公共模块:
- 抓取:lib.ctgov_api.fetch_studies
- 翻译:lib.llm_client.translate_text
- 落地:lib.study_data.save_study_json
- TG 推送:lib.channels.telegram
- 微信推送:lib.channels.gewe

保留 send_telegram_combined 的推送编排逻辑(汇总清单/分组详情/footer/报告文件),
确保向后兼容:`python3 daily_ctgov_check_tgbot.py` 行为与重构前一致。

为兼容外部引用,保留以下别名:
- translate_to_chinese → lib.llm_client.translate_text
- fetch_clinical_trials → lib.ctgov_api.fetch_studies(带默认参数)
- send_telegram_msg → lib.channels.telegram.send_msg
- send_gewe_text / send_gewe_card → lib.channels.gewe
"""

import os
from datetime import datetime

from dotenv import load_dotenv

# ============ 导入公共模块 ============
from lib.ctgov_api import fetch_studies, has_china_center, get_nct_id
from lib.llm_client import translate_text as translate_to_chinese
from lib.study_data import sanitize_filename, save_study_json
from lib.channels.telegram import send_msg as send_telegram_msg
from lib.channels.gewe import send_text as send_gewe_text, send_card as send_gewe_card
from lib.branding import get_title, get_footer, disease_cn_name

load_dotenv()

# 搜索条件(疾病名,用于抓取过滤和报告文件命名;改 .env 的 SEARCH_CONDITION 即可切换疾病)
SEARCH_CONDITION = os.getenv("SEARCH_CONDITION", "Pancreatic Cancer")


def fetch_clinical_trials():
    """
    抓取最近 30 天内更新的胰腺癌试验(向后兼容入口)。
    等价于 lib.ctgov_api.fetch_studies() 的默认行为。
    """
    return fetch_studies(days_back=30)


def format_study_detail(study):
    """
    格式化单个试验的详情文本,并落地 JSON。
    保留原有行为:翻译 + 组装详情 + save_study_json。
    """
    protocol = study.get("protocolSection", {})
    identification = protocol.get("identificationModule", {})
    status_module = protocol.get("statusModule", {})
    design_module = protocol.get("designModule", {})
    conditions_module = protocol.get("conditionsModule", {})
    contacts_locations = protocol.get("contactsLocationsModule", {})

    nct_id = identification.get("nctId", "N/A")
    brief_title = identification.get("briefTitle", "N/A")
    official_title = identification.get("officialTitle", "N/A")
    overall_status = status_module.get("overallStatus", "招募中")
    phases = design_module.get("phases", ["N/A"])
    conditions = conditions_module.get("conditions", ["N/A"])

    has_china = has_china_center(study)
    china_tag = "[🇨🇳 中国有中心] " if has_china else ""

    central_contacts = contacts_locations.get("centralContacts", [])
    contact_info = "无"
    if central_contacts:
        c = central_contacts[0]
        contact_info = (f"姓名: {c.get('name', '无')}\n"
                        f"职称: {c.get('role', '无')}\n"
                        f"电话: {c.get('phone', '无')}\n"
                        f"邮箱: {c.get('email', '无')}")

    translated_title = translate_to_chinese(f"{brief_title} ({official_title})")
    translated_status = "招募中" if overall_status == "RECRUITING" else overall_status
    translated_conditions = translate_to_chinese(", ".join(conditions))

    # 落地存储(用修复后的 save_study_json,extra_fields 真正写入)
    translated_info = {
        "title_cn": translated_title,
        "status_cn": translated_status,
        "conditions_cn": translated_conditions,
        "contact_info": contact_info,
        "has_china": has_china
    }
    save_study_json(study, extra_fields=translated_info)

    detail = f"标题: {china_tag}{translated_title}\n"
    detail += f"状态: {translated_status}\n"
    detail += f"研究编号: {nct_id}\n"
    detail += f"试验阶段: {', '.join(phases)}\n"
    detail += f"适应症: {translated_conditions}\n"
    detail += f"主要研究者/联系人:\n{contact_info}\n"
    detail += f"详情链接:\nhttps://clinicaltrials.gov/study/{nct_id}\n"
    return detail


def send_telegram_combined(studies):
    """
    多渠道推送编排:汇总清单 → 分组详情 → footer。
    TG 和 GeWe 并列推送,微信失败不影响 TG。
    同时落地推送报告 telegram_push_report.txt。
    """
    if not studies:
        msg = (f"# {get_title()}\n\n"
               f"今日未发现过去 30 天内更新且符合条件的临床试验。\n"
               f"更新时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        send_telegram_msg(msg)
        try:
            send_gewe_text(msg)
        except Exception as e:
            print(f"⚠️  微信推送失败(不影响TG): {e}")
        return

    # 准备本地报告记录
    date_str = datetime.now().strftime('%Y-%m-%d')
    folder_name = f"{date_str}-{sanitize_filename(SEARCH_CONDITION)}"
    base_dir = os.path.join("output", folder_name)
    os.makedirs(base_dir, exist_ok=True)
    report_file = os.path.join(base_dir, "telegram_push_report.txt")

    with open(report_file, "w", encoding="utf-8") as rf:
        rf.write(f"# {get_title()} ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')})\n\n")
        rf.write(f"## 🔬 {disease_cn_name(SEARCH_CONDITION)}临床试验每日更新\n\n")
        rf.write(f"- 监测日期: 最近30天\n")
        rf.write(f"- 监测要素：#{disease_cn_name(SEARCH_CONDITION)}相关临床试验动态\n\n")

        # 1. 汇总列表
        print(f"[{datetime.now()}] Preparing summary list for {len(studies)} studies...")
        # 与 content_builder 一致:日报模版带上检索关键词,便于理解筛选条件
        try:
            from lib.ctgov_api import _DEFAULT_KEYWORDS
            from lib.content_builder import _format_keywords_line
            keywords_line = _format_keywords_line(keywords=_DEFAULT_KEYWORDS)
        except Exception:
            keywords_line = "检索关键词: （默认 KEYWORDS）"

        rf.write(f"### 发现 {len(studies)} 个符合条件的临床试验 (过去 30 天内更新)\n\n")
        rf.write(f"- {keywords_line}\n\n")
        rf.write(f"## 【汇总清单】\n")

        summary_msg = (
            f"# {get_title()}\n\n"
            f"发现 {len(studies)} 个符合条件的临床试验\n"
            f"{keywords_line}\n\n"
            f"## 【汇总清单】\n"
        )
        for i, study in enumerate(studies):
            nct_id = get_nct_id(study)
            brief_title = study.get("protocolSection", {}).get("identificationModule", {}).get("briefTitle", "N/A")
            china_marker = "🇨🇳 " if has_china_center(study) else ""

            print(f"[{datetime.now()}] Translating summary {i+1}/{len(studies)}: {nct_id}")
            translated_brief = translate_to_chinese(brief_title)

            line = f"- {china_marker}标题：{translated_brief}\n  ❤️ 编号: {nct_id}\n  🔗 链接: https://clinicaltrials.gov/study/{nct_id}\n\n"
            summary_msg += line
            rf.write(line)

            # 同步推送该试验的微信卡片
            try:
                send_gewe_card(study)
            except Exception as e:
                print(f"⚠️  微信卡片推送失败 {nct_id}(不影响TG): {e}")

        send_telegram_msg(summary_msg)
        try:
            send_gewe_text(summary_msg)
        except Exception as e:
            print(f"⚠️  微信汇总推送失败(不影响TG): {e}")
        rf.write("\n" + "="*50 + "\n\n")

        # 2. 详细信息(每 3 个一组)
        group_size = 3
        for i in range(0, len(studies), group_size):
            group = studies[i:i+group_size]
            group_num = (i // group_size) + 1
            total_groups = (len(studies) + group_size - 1) // group_size

            print(f"[{datetime.now()}] Preparing detail group {group_num}/{total_groups}...")
            detail_header = f"## 🔔 {disease_cn_name(SEARCH_CONDITION)}临床试验详情 ({group_num}/{total_groups})\n\n"
            group_details = ""
            for j, study in enumerate(group):
                current_idx = i + j + 1
                nct_id = get_nct_id(study)
                print(f"[{datetime.now()}] Processing details {current_idx}/{len(studies)}: {nct_id}")
                group_details += f"### --- 临床基本信息 ({current_idx}/{len(studies)}) ---\n"
                group_details += format_study_detail(study) + "\n"

            full_detail_group = detail_header + group_details
            send_telegram_msg(full_detail_group)
            try:
                send_gewe_text(full_detail_group)
            except Exception as e:
                print(f"⚠️  微信详情推送失败(不影响TG): {e}")
            rf.write(full_detail_group + "\n" + "="*50 + "\n\n")

        # 3. 结尾感谢(胰腺癌专属 / 其它疾病通用)
        footer = get_footer()
        send_telegram_msg(footer)
        try:
            send_gewe_text(footer)
        except Exception as e:
            print(f"⚠️  微信 footer 推送失败(不影响TG): {e}")
        rf.write(footer + "\n")

    print(f"[{datetime.now()}] Push report saved to: {report_file}")


if __name__ == "__main__":
    print(f"Starting task at {datetime.now()}")
    studies = fetch_clinical_trials()
    print(f"Found {len(studies)} studies.")
    send_telegram_combined(studies)
    print("Task completed.")
