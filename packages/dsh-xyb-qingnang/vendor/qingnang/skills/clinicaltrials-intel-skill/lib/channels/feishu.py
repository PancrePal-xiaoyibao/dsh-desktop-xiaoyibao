"""
feishu - 飞书群卡片推送渠道

从原 manus_subscript.py 抽取(manus_subscript.py 保留不动作参考)。
飞书 interactive 卡片格式,支持多群推送。

环境变量:
    FEISHU_APP_ID      飞书应用 App ID
    FEISHU_APP_SECRET  飞书应用 App Secret
    FEISHU_CHAT_IDS    目标群 chat_id 列表(逗号分隔)
"""

import json
import os
from datetime import datetime

import requests
from dotenv import load_dotenv

from lib.text_utils import parse_list_config
from lib.llm_client import translate_text
from lib.ctgov_api import has_china_center, get_nct_id

load_dotenv()

FEISHU_APP_ID = os.getenv("FEISHU_APP_ID", "").strip()
FEISHU_APP_SECRET = os.getenv("FEISHU_APP_SECRET", "").strip()
FEISHU_CHAT_IDS = parse_list_config(os.getenv("FEISHU_CHAT_IDS", ""))


def _enabled_check():
    """检查飞书推送前置条件"""
    if not (FEISHU_APP_ID and FEISHU_APP_SECRET and FEISHU_CHAT_IDS):
        print("⚠️  缺少 FEISHU_APP_ID/FEISHU_APP_SECRET/FEISHU_CHAT_IDS,跳过飞书推送")
        return False
    return True


def get_access_token():
    """获取飞书 tenant_access_token"""
    url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
    payload = {"app_id": FEISHU_APP_ID, "app_secret": FEISHU_APP_SECRET}
    try:
        response = requests.post(url, json=payload, timeout=10)
        data = response.json()
        if data.get("code") == 0:
            return data.get("tenant_access_token")
        print(f"[{datetime.now()}] Feishu token error: {data.get('msg')}")
        return None
    except Exception as e:
        print(f"[{datetime.now()}] Feishu token exception: {e}")
        return None


def build_card(data):
    """
    构建飞书交互式卡片 JSON(纯函数,零外部依赖)。
    data 需含字段:title_cn / title_en / status / nct_id / phase / conditions /
                   sponsor / contact_name / contact_role / contact_facility /
                   contact_phone / contact_email
    """
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": "🔬 临床试验情报更新"},
            "template": "orange"
        },
        "elements": [
            {
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": f"**标题:** {data['title_cn']}\n*({data['title_en']})*"}
            },
            {
                "tag": "div",
                "fields": [
                    {"is_short": True, "text": {"tag": "lark_md",
                         "content": f"**状态:** {data['status']}\n**编号:** {data['nct_id']}"}},
                    {"is_short": True, "text": {"tag": "lark_md",
                         "content": f"**阶段:** {data['phase']}\n**适应症:** {data['conditions']}"}}
                ]
            },
            {
                "tag": "div",
                "text": {"tag": "lark_md", "content": f"**申办方/发起人:** {data['sponsor']}"}
            },
            {"tag": "hr"},
            {
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": (f"**主要研究者/联系人:**\n"
                                     f"👤 **姓名:** {data['contact_name']} ({data['contact_role']})\n"
                                     f"🏢 **单位:** {data['contact_facility']}\n"
                                     f"📞 **电话:** {data['contact_phone']}\n"
                                     f"📧 **邮箱:** {data['contact_email']}")}
            },
            {
                "tag": "action",
                "actions": [{
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": "查看详情链接"},
                    "url": f"https://clinicaltrials.gov/study/{data['nct_id']}",
                    "type": "primary"
                }]
            }
        ]
    }


def send_card(token, chat_id, data):
    """使用飞书机器人 API 向指定群组发送交互式卡片"""
    url = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id"
    card = build_card(data)
    payload = {"receive_id": chat_id, "msg_type": "interactive", "content": json.dumps(card)}
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"}
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=10)
        res_data = response.json()
        if res_data.get("code") == 0:
            print(f"[{datetime.now()}] Feishu card sent to {chat_id}: {data['nct_id']}")
            return True
        print(f"[{datetime.now()}] Feishu card error for {chat_id}: {res_data.get('msg')} (Code: {res_data.get('code')})")
        return False
    except Exception as e:
        print(f"[{datetime.now()}] Feishu card exception for {chat_id}: {e}")
        return False


def _study_to_card_data(study):
    """从 study 对象提取并翻译字段,构造 build_card 所需的 data dict"""
    protocol = study.get("protocolSection", {})
    ident = protocol.get("identificationModule", {})
    status_module = protocol.get("statusModule", {})
    design_module = protocol.get("designModule", {})
    sponsor_module = protocol.get("sponsorCollaboratorsModule", {})
    conditions_module = protocol.get("conditionsModule", {})
    contacts_locations = protocol.get("contactsLocationsModule", {})

    brief_title = ident.get("briefTitle", "")
    official_title = ident.get("officialTitle", "")
    overall_status = status_module.get("overallStatus", "UNKNOWN")
    phases = design_module.get("phases", []) or []
    conditions = conditions_module.get("conditions", []) or []
    sponsor_name = sponsor_module.get("leadSponsor", {}).get("name", "未知")
    nct_id = ident.get("nctId", "N/A")

    # 联系人
    contact_name, contact_role, contact_phone, contact_email, contact_facility = "未提供", "未提供", "未提供", "未提供", "未提供"
    central_contacts = contacts_locations.get("centralContacts", [])
    locations = contacts_locations.get("locations", [])
    if central_contacts:
        c = central_contacts[0]
        contact_name = c.get("name", "未提供")
        contact_role = c.get("role", "未提供")
        contact_phone = c.get("phone", "未提供")
        contact_email = c.get("email", "未提供")
    if locations:
        contact_facility = locations[0].get("facility", "未提供")

    status_map = {"RECRUITING": "招募中 (RECRUITING)", "NOT_YET_RECRUITING": "尚未招募",
                  "COMPLETED": "已完成", "ACTIVE_NOT_RECRUITING": "活跃但不招募"}
    status_cn = status_map.get(overall_status, overall_status)

    return {
        "title_cn": translate_text(f"{brief_title} ({official_title})") if brief_title else nct_id,
        "title_en": brief_title,
        "nct_id": nct_id,
        "status": status_cn,
        "phase": ", ".join(phases) if phases else "N/A",
        "conditions": translate_text(", ".join(conditions)) if conditions else "未知",
        "sponsor": sponsor_name,
        "contact_name": contact_name,
        "contact_role": contact_role,
        "contact_facility": contact_facility,
        "contact_phone": contact_phone,
        "contact_email": contact_email,
    }


def send_cards_batch(studies, chat_ids=None):
    """
    批量向飞书群发送卡片。
    studies:  study 对象列表
    chat_ids: 目标群列表,None 时用 .env 的 FEISHU_CHAT_IDS
    """
    if not _enabled_check():
        return 0
    targets = chat_ids or FEISHU_CHAT_IDS
    if not targets:
        return 0

    token = get_access_token()
    if not token:
        print("⚠️  无法获取飞书 token,跳过推送")
        return 0

    ok = 0
    for i, study in enumerate(studies, 1):
        nct = get_nct_id(study)
        print(f"[{i}/{len(studies)}] Feishu 卡片: {nct}")
        try:
            data = _study_to_card_data(study)
            for chat_id in targets:
                if send_card(token, chat_id, data):
                    ok += 1
        except Exception as e:
            print(f"  ⚠️ 失败: {e}")
    return ok
