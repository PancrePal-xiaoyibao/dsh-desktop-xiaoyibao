"""
ctgov_api - ClinicalTrials.gov 统一抓取

基于 CTGov API v2,统一了原 daily_ctgov_check_tgbot.py 的 fetch_clinical_trials()
和 manus_subscript.py 的 get_clinical_trials() 两份独立实现。

支持灵活的查询过滤:
- condition:  疾病条件(默认从 .env 读 SEARCH_CONDITION)
- keywords:   关键词列表(默认从 .env 的 KEYWORDS 或 assets/pancreatic_targets.yaml 展开)
- status:     试验状态过滤(默认 RECRUITING)
- china_only: 仅抓取含中国中心的试验(用 AREA[LocationCountry]China)
- sort:       排序(默认 LastUpdatePostDate:desc,即最近更新优先)
- top:        取前 N 个(等价于 pageSize=N)
- days_back:  时间窗,仅保留最近 N 天内更新的(本地过滤)

环境变量(作为默认值,可被函数参数覆盖):
    SEARCH_CONDITION  疾病条件(默认 "Pancreatic Cancer")
    KEYWORDS          关键词来源:
                        - yaml / @yaml / auto / 空 → 读 assets/pancreatic_targets.yaml
                        - 逗号分隔列表 → 显式覆盖 YAML
    STATUS            试验状态(默认 RECRUITING)
    DAYS_BACK         时间窗天数(默认 30)
"""

import os
from datetime import datetime, timedelta

import requests
import urllib3
from dotenv import load_dotenv

from lib.targets import resolve_default_keywords

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv()

# ============ 默认配置(从 .env / YAML 读,作为 fallback)============
_DEFAULT_CONDITION = os.getenv("SEARCH_CONDITION", "Pancreatic Cancer")
# KEYWORDS 空 / yaml / auto → 走 assets/pancreatic_targets.yaml；否则逗号列表覆盖
_DEFAULT_KEYWORDS = resolve_default_keywords(os.getenv("KEYWORDS", "yaml"))
_DEFAULT_STATUS = os.getenv("STATUS", "RECRUITING")
_DEFAULT_DAYS_BACK = int(os.getenv("DAYS_BACK", "30"))

BASE_URL = "https://clinicaltrials.gov/api/v2/studies"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"


def fetch_studies(condition=None, keywords=None, status=None,
                  china_only=False, sort="LastUpdatePostDate:desc",
                  top=None, days_back=None):
    """
    抓取 ClinicalTrials.gov 试验数据。

    参数:
        condition:  疾病条件。None 时用 .env 的 SEARCH_CONDITION
        keywords:   关键词列表。None 时用 .env 的 KEYWORDS;传 [] 则不加关键词过滤
        status:     试验状态过滤。None 时用 .env 的 STATUS;传 "" 则不过滤状态
        china_only: True 时加 AREA[LocationCountry]China 过滤,只抓中国试验
        sort:       排序字段。默认 LastUpdatePostDate:desc(最近更新优先);None 则不排序
        top:        取前 N 个(设置 pageSize=N)。None 时默认 pageSize=50
        days_back:  时间窗过滤。>0 时仅保留最近 N 天内更新的(本地过滤);None/0 时不过滤

    返回:
        原始 study 对象列表(完整 protocolSection 结构)。失败返回 []。
    """
    condition = condition if condition is not None else _DEFAULT_CONDITION
    keywords = keywords if keywords is not None else _DEFAULT_KEYWORDS
    status = status if status is not None else _DEFAULT_STATUS
    days_back = days_back if days_back is not None else _DEFAULT_DAYS_BACK

    # 构造查询参数
    params = {"query.cond": condition}
    if keywords:
        params["query.term"] = " OR ".join(keywords)
    if status:
        params["filter.overallStatus"] = status
    if china_only:
        params["filter.advanced"] = "AREA[LocationCountry]China"
    if sort:
        params["sort"] = sort
    params["pageSize"] = top if (top and top > 0) else 50
    params["format"] = "json"

    headers = {"User-Agent": UA, "Accept": "application/json"}

    try:
        response = requests.get(BASE_URL, params=params, headers=headers, verify=False, timeout=30)
        response.raise_for_status()
        all_studies = response.json().get("studies", [])
    except Exception as e:
        print(f"Error fetching data from CTGov: {e}")
        return []

    # 本地时间窗过滤(days_back > 0 时)
    if days_back and days_back > 0:
        date_cutoff = (datetime.now() - timedelta(days=days_back)).strftime('%Y-%m-%d')
        filtered = []
        for s in all_studies:
            last_update = (s.get("protocolSection", {})
                             .get("statusModule", {})
                             .get("lastUpdatePostDateStruct", {})
                             .get("date", ""))
            if last_update and last_update >= date_cutoff:
                filtered.append(s)
        return filtered

    return all_studies


def has_china_center(study):
    """判断单个 study 是否含中国中心"""
    locations = (study.get("protocolSection", {})
                        .get("contactsLocationsModule", {})
                        .get("locations", []))
    return any(loc.get("country") == "China" for loc in locations)


def get_nct_id(study):
    """提取 study 的 NCT 编号"""
    return (study.get("protocolSection", {})
                 .get("identificationModule", {})
                 .get("nctId", "N/A"))
