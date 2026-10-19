"""
gewe - GeWe 个人微信群推送渠道

从原 daily_ctgov_check_tgbot.py 抽取,独立成模块。
支持:
- 多群循环推送(JSON 数组 / 逗号分隔 / 单群三种配置写法)
- 纯文字消息(Markdown 自动转纯文本 + 按长度分批)
- appmsg 可跳转卡片(基于手动测试通过的模板,🇨🇳 中国试验双重标注)
- 失败隔离(某个群失败不影响其他群)+ 失败重试

环境变量(9 个,全部在模块内自读):
    GEWE_ENABLED          总开关(默认 false)
    GEWE_API_HOST         API 域名(默认 api.geweapi.com)
    GEWE_APP_ID           GeWe appId
    GEWE_TOKEN            X-GEWE-TOKEN
    GEWE_TO_WXID          目标群(多群用 JSON 数组或逗号分隔)
    GEWE_CARD_MODE        true=发卡片;false=仅纯文字(默认 true)
    GEWE_MSG_MAX_LEN      单条文字消息长度上限(默认 500，避免微信折叠)
    GEWE_PUSH_RETRY_TIMES 失败重试次数(默认 3)
    GEWE_PUSH_RETRY_DELAY 重试间隔秒数(默认 5)
"""

import os
import time
from datetime import datetime

import requests
from dotenv import load_dotenv
from xml.sax.saxutils import escape

from lib.text_utils import markdown_to_plain, split_text_by_len, parse_list_config
from lib.llm_client import translate_text

load_dotenv()

# ============ 配置读取 ============
GEWE_ENABLED = os.getenv("GEWE_ENABLED", "false").strip().lower() in ("true", "1", "yes", "on")
GEWE_API_HOST = os.getenv("GEWE_API_HOST", "api.geweapi.com").strip()
GEWE_APP_ID = os.getenv("GEWE_APP_ID", "").strip()
GEWE_TOKEN = os.getenv("GEWE_TOKEN", "").strip()
GEWE_TO_WXID = os.getenv("GEWE_TO_WXID", "").strip()
GEWE_TO_WXIDS = parse_list_config(GEWE_TO_WXID)
GEWE_CARD_MODE = os.getenv("GEWE_CARD_MODE", "true").strip().lower() in ("true", "1", "yes", "on")
GEWE_MSG_MAX_LEN = int(os.getenv("GEWE_MSG_MAX_LEN", "500"))
GEWE_PUSH_RETRY_TIMES = int(os.getenv("GEWE_PUSH_RETRY_TIMES", "3"))
GEWE_PUSH_RETRY_DELAY = int(os.getenv("GEWE_PUSH_RETRY_DELAY", "5"))


def _enabled_check():
    """检查 GeWe 推送前置条件,返回 True 表示可推送"""
    if not GEWE_ENABLED:
        return False
    if not (GEWE_APP_ID and GEWE_TOKEN and GEWE_TO_WXIDS):
        print("⚠️  GEWE_ENABLED=true 但缺少 GEWE_APP_ID/GEWE_TOKEN/GEWE_TO_WXID,跳过微信推送")
        return False
    return True


def _request(path, payload, to_wxid=None):
    """
    发起 GeWe API 请求,带重试。返回 True/False 表示业务是否成功。
    GeWe 成功返回 ret=200(注意不是 0)。
    """
    target = to_wxid or GEWE_TO_WXID
    url = f"https://{GEWE_API_HOST}{path}"
    headers = {"X-GEWE-TOKEN": GEWE_TOKEN, "Content-Type": "application/json"}
    body = {"appId": GEWE_APP_ID, "toWxid": target}
    body.update(payload)

    for attempt in range(GEWE_PUSH_RETRY_TIMES):
        try:
            resp = requests.post(url, headers=headers, json=body, timeout=15)
            if resp.status_code == 200:
                res_data = resp.json()
                if res_data.get("ret") == 200:
                    return True
                print(f"⚠️  GeWe API 业务失败 [{target}] (第{attempt+1}次): ret={res_data.get('ret')}, {res_data.get('msg')}")
            else:
                print(f"⚠️  GeWe API HTTP {resp.status_code} [{target}] (第{attempt+1}次): {resp.text[:150]}")
        except Exception as e:
            print(f"⚠️  GeWe 请求异常 [{target}] (第{attempt+1}次): {e}")
        if attempt < GEWE_PUSH_RETRY_TIMES - 1:
            time.sleep(GEWE_PUSH_RETRY_DELAY)
    return False


def _broadcast(path, payload):
    """
    向所有配置的群循环推送(多群场景)。
    每个群独立重试,某个群失败不影响其他群。返回成功推送的群数。
    """
    success_count = 0
    total = len(GEWE_TO_WXIDS)
    for idx, wxid in enumerate(GEWE_TO_WXIDS, 1):
        print(f"[{datetime.now()}] GeWe 推送群 {idx}/{total}: {wxid}")
        if _request(path, payload, to_wxid=wxid):
            success_count += 1
        else:
            print(f"⚠️  群 {wxid} 推送失败,继续推送其他群")
    return success_count


def build_appmsg(study):
    """
    基于 appmsg XML 模板生成卡片(手动测试通过)。
    从完整 study 对象提取所有字段填入模板。
    🇨🇳 中国试验:标题前缀 + 描述末尾双重标注。
    返回 (appmsg_xml, nct_id) 元组。
    """
    protocol = study.get("protocolSection", {})
    ident = protocol.get("identificationModule", {})
    status_module = protocol.get("statusModule", {})
    design_module = protocol.get("designModule", {})
    sponsor_module = protocol.get("sponsorCollaboratorsModule", {})
    conditions_module = protocol.get("conditionsModule", {})
    contacts_locations = protocol.get("contactsLocationsModule", {})

    nct_id = ident.get("nctId", "N/A")
    brief_title = ident.get("briefTitle", "")
    official_title = ident.get("officialTitle", "")
    overall_status = status_module.get("overallStatus", "UNKNOWN")
    phases = design_module.get("phases", []) or []
    conditions = conditions_module.get("conditions", []) or []
    sponsor_name = sponsor_module.get("leadSponsor", {}).get("name", "未知")

    # 更新日期
    update_date = status_module.get("lastUpdateSubmitDate", "")
    if not update_date:
        update_date = status_module.get("studyFirstSubmitDate", "")

    # 中国中心判断
    locations = contacts_locations.get("locations", [])
    has_china = any(loc.get("country") == "China" for loc in locations)

    # 联系人
    contact_name, contact_phone, contact_email = "未知", "未知", "未知"
    central_contacts = contacts_locations.get("centralContacts", [])
    if central_contacts:
        c = central_contacts[0]
        contact_name = c.get("name", "未知")
        contact_role = c.get("role", "")
        contact_phone = c.get("phone", "未知")
        contact_email = c.get("email", "未知")
        if contact_role:
            contact_name = f"{contact_name}｜{contact_role}"
    elif locations:
        loc = locations[0]
        facility = loc.get("facility", "")
        c = loc.get("contacts", []) or []
        if c:
            contact_name = c[0].get("name", contact_name)
            contact_phone = c[0].get("phone", contact_phone)
            contact_email = c[0].get("email", contact_email)
        if facility and contact_name == "未知":
            contact_name = facility
        elif facility and not contact_name.startswith(facility):
            contact_name = f"{contact_name}｜{facility}"

    # 翻译(复用 LLM 公共模块)
    translated_title = translate_text(f"{brief_title} ({official_title})") if brief_title else nct_id
    if has_china:
        translated_title = f"🇨🇳 {translated_title}"
    if len(translated_title) > 56:
        translated_title = translated_title[:56] + "…"

    # 状态中文化
    status_map = {"RECRUITING": "招募中", "NOT_YET_RECRUITING": "尚未招募",
                  "COMPLETED": "已完成", "ACTIVE_NOT_RECRUITING": "活跃但不招募",
                  "TERMINATED": "已终止", "WITHDRAWN": "已撤回"}
    status_cn = status_map.get(overall_status, overall_status)
    phase_cn = translate_text(", ".join(phases)) if phases else "未知"
    conditions_cn = translate_text(", ".join(conditions)) if conditions else "未知"

    # 构造描述
    des_lines = [
        f"状态: {status_cn} ({overall_status})",
        f"编号: {nct_id}",
        f"阶段: {phase_cn} ({', '.join(phases) if phases else 'N/A'})",
        f"适应症: {conditions_cn}",
        f"申办方/发起人: {sponsor_name}",
        f"更新日期: {update_date}",
        f"联系人: {contact_name}",
    ]
    if contact_phone and contact_phone != "未知":
        des_lines.append(f"电话: {contact_phone}")
    if contact_email and contact_email != "未知":
        des_lines.append(f"邮箱: {contact_email}")
    if has_china:
        des_lines.append("🇨🇳 中国有中心(优先关注)")
    des_text = "\n".join(des_lines)

    # 固定缩略图
    thumb_url = ("https://mmbiz.qpic.cn/sz_mmbiz_png/vNKhjib61xHKLd8GuyfG6RLTlzuibY4P9e"
                 "JWmhSIiaLgOCWrPeCGYfk4OaTYVNjW4p0OVaJz0LUEevEhOQEGTN3UicqCEUlEtBr8qAWQApXSO0Q"
                 "/640?wx_fmt=png&tp=webp&wxfrom=5")

    # appmsg XML 模板
    appmsg_xml = (
        '<appmsg appid="" sdkver="0">\n'
        f'\t<title>{escape(translated_title)}</title>\n'
        f'\t<des>{escape(des_text)}</des>\n'
        '\t<action />\n'
        '\t<type>5</type>\n'
        '\t<showtype>0</showtype>\n'
        '\t<soundtype>0</soundtype>\n'
        '\t<mediatagname />\n'
        '\t<messageext />\n'
        '\t<messageaction />\n'
        '\t<content />\n'
        '\t<contentattr>0</contentattr>\n'
        f'\t<url>https://clinicaltrials.gov/study/{escape(nct_id)}</url>\n'
        '\t<lowurl />\n'
        '\t<dataurl />\n'
        '\t<lowdataurl />\n'
        '\t<appattach>\n'
        '\t\t<totallen>0</totallen>\n'
        '\t\t<attachid />\n'
        '\t\t<emoticonmd5 />\n'
        '\t\t<fileext />\n'
        '\t\t<cdnthumburl />\n'
        '\t\t<cdnthumbmd5 />\n'
        '\t\t<cdnthumblength>0</cdnthumblength>\n'
        '\t\t<cdnthumbwidth>1080</cdnthumbwidth>\n'
        '\t\t<cdnthumbheight>459</cdnthumbheight>\n'
        '\t\t<cdnthumbaeskey />\n'
        '\t\t<aeskey />\n'
        '\t\t<encryver>0</encryver>\n'
        '\t</appattach>\n'
        '\t<extinfo />\n'
        '\t<sourceusername />\n'
        '\t<sourcedisplayname>ClinicalTrials.gov</sourcedisplayname>\n'
        f'\t<thumburl>{escape(thumb_url)}</thumburl>\n'
        '\t<md5 />\n'
        '\t<statextstr />\n'
        '\t<mmreadershare>\n'
        '\t\t<itemshowtype>0</itemshowtype>\n'
        '\t</mmreadershare>\n'
        '</appmsg>'
    )
    return appmsg_xml, nct_id


def send_text(text):
    """
    发送纯文本消息到所有配置的微信群(分批)。
    先 markdown_to_plain 再 split_text_by_len,然后向每个群循环发送。
    """
    if not _enabled_check():
        return
    plain = markdown_to_plain(text)
    parts = split_text_by_len(plain, GEWE_MSG_MAX_LEN)
    if not parts:
        return
    total_groups = len(GEWE_TO_WXIDS)
    for i, part in enumerate(parts):
        print(f"[{datetime.now()}] GeWe 发送文字 {i+1}/{len(parts)}(向 {total_groups} 个群)...")
        _broadcast("/gewe/v2/api/message/postText", {"content": part, "ats": ""})


def send_card(study):
    """
    发送 appmsg 卡片到所有配置的微信群。
    接收完整 study 对象,内部提取所有字段生成 appmsg XML。
    需 GEWE_CARD_MODE=true 才发送。
    """
    if not _enabled_check():
        return
    if not GEWE_CARD_MODE:
        return
    try:
        appmsg_xml, nct_id = build_appmsg(study)
        print(f"[{datetime.now()}] GeWe 发送卡片: {nct_id}(向 {len(GEWE_TO_WXIDS)} 个群)")
        _broadcast("/gewe/v2/api/message/postAppMsg", {"appmsg": appmsg_xml, "ats": ""})
    except Exception as e:
        print(f"⚠️  微信卡片生成失败: {e}")


def send_cards_batch(studies):
    """批量发送卡片:遍历 studies 逐个发,卡片间隔 1 秒避免频率限制"""
    if not _enabled_check() or not GEWE_CARD_MODE:
        return 0
    ok = 0
    for i, study in enumerate(studies, 1):
        nct = study.get("protocolSection", {}).get("identificationModule", {}).get("nctId", "N/A")
        print(f"[{i}/{len(studies)}] GeWe 卡片: {nct}")
        try:
            send_card(study)
            ok += 1
        except Exception as e:
            print(f"  ⚠️ 失败: {e}")
        if i < len(studies):
            time.sleep(1)
    return ok
