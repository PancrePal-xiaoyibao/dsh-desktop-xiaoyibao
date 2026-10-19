#!/usr/bin/env python3
"""
ClinicalTrials.gov API v2 搜索工具
===================================

支持关键词、时间范围、国家多维度筛选，输出临床试验列表及智能总结。

用法:
    python3 search.py --keyword "KRAS G12D"
    python3 search.py --keyword "pancreatic cancer" --start-date 2024-01-01 --country China
    python3 search.py --keyword "BRCA1" --start-date 2023-01-01 --end-date 2025-06-01 --country "United States" --max-results 100
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from collections import Counter
from datetime import datetime
from typing import Any

try:
    import httpx
except ImportError:
    print("错误: 需要安装 httpx 库。请运行: pip install httpx")
    sys.exit(1)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
_BASE_URL = "https://clinicaltrials.gov/api/v2/studies"
_DEFAULT_PAGE_SIZE = 100
_REQUEST_TIMEOUT = 45.0  # 更长超时
_MAX_RETRIES = 5
_RETRY_DELAY = 2.0  # 更保守的退避时间

#: 整次搜索的总时间预算（秒）。重试会累加：5 × 45s 请求加退避最坏约 5 分钟，
#: 而宿主（如 PI-Desktop 的 Bash 工具）默认 60s 就杀进程，使用者只会看到
#: "bash timed out"。预算用尽时主动停止重试、保留已有结果并说明原因。
#: 需要更久时用 --timeout 放宽（宿主侧也要给足 timeoutMs）。
_TOTAL_BUDGET = 40.0

# 已知胰腺癌/肿瘤 Biomarker（用于从入排标准中提取）
_BIOMARKER_PATTERNS: list[tuple[str, str]] = [
    ("KRAS G12C", "KRAS G12C"),
    ("KRAS G12D", "KRAS G12D"),
    ("KRAS G12V", "KRAS G12V"),
    ("KRAS G12R", "KRAS G12R"),
    ("KRAS G12A", "KRAS G12A"),
    ("KRAS G13D", "KRAS G13D"),
    ("KRAS Q61H", "KRAS Q61H"),
    ("KRAS", "KRAS"),
    ("NRAS", "NRAS"),
    ("HRAS", "HRAS"),
    ("BRAF V600E", "BRAF V600E"),
    ("BRAF", "BRAF"),
    ("BRCA1", "BRCA1"),
    ("BRCA2", "BRCA2"),
    ("BRCA", "BRCA1/2"),
    ("PALB2", "PALB2"),
    ("ATM MUTATION", "ATM"),
    ("ATM-DEFICIENT", "ATM"),
    ("ATM DEFICIENCY", "ATM"),
    ("ATM LOSS", "ATM"),
    ("ATM PATHWAY", "ATM"),
    ("ATM PROTEIN", "ATM"),
    ("ATM GENE", "ATM"),
    ("MSI-H", "MSI-H/dMMR"),
    ("MICROSATELLITE INSTABILITY-HIGH", "MSI-H/dMMR"),
    ("MICROSATELLITE INSTABILITY", "MSI-H/dMMR"),
    ("DMMR", "MSI-H/dMMR"),
    ("MISMATCH REPAIR DEFICIENT", "MSI-H/dMMR"),
    ("NTRK", "NTRK fusion"),
    ("HER2", "HER2+"),
    ("ERBB2", "HER2+"),
    ("TP53", "TP53"),
    ("SMAD4", "SMAD4"),
    ("CDKN2A", "CDKN2A"),
    ("PIK3CA", "PIK3CA"),
    ("PTEN", "PTEN"),
    ("NRG1", "NRG1 fusion"),
    ("FGFR2", "FGFR2"),
    ("ALK", "ALK"),
    ("ROS1", "ROS1"),
    ("RET", "RET"),
    ("MET", "MET"),
    ("TMB-H", "TMB-H"),
    ("TUMOR MUTATIONAL BURDEN-HIGH", "TMB-H"),
    ("TUMOR MUTATIONAL BURDEN", "TMB-H"),
    ("MLH1", "Lynch (MLH1)"),
    ("MSH2", "Lynch (MSH2)"),
    ("MSH6", "Lynch (MSH6)"),
    ("PMS2", "Lynch (PMS2)"),
    ("EGFR", "EGFR"),
    ("VEGF", "VEGF"),
    ("PD-L1", "PD-L1"),
    ("PD-1", "PD-1/PD-L1"),
    ("CTLA-4", "CTLA-4"),
    ("CLDN18.2", "CLDN18.2"),
    ("CLAUDIN 18.2", "CLDN18.2"),
    ("CLAUDIN18.2", "CLDN18.2"),
    ("TROP2", "TROP2"),
    ("TACSTD2", "TROP2"),
    ("TISSUE FACTOR", "Tissue Factor"),
    ("MSLN", "MSLN"),
    ("MESOTHELIN", "MSLN"),
    ("B7-H3", "B7-H3"),
    ("B7H3", "B7-H3"),
    ("CD276", "B7-H3"),
    ("NECTIN-4", "Nectin-4"),
    ("NECTIN4", "Nectin-4"),
    ("PVRL4", "Nectin-4"),
    ("PAN-TRK", "pan-TRK"),
    ("CDH17", "CDH17"),
    ("CEACAM5", "CEACAM5"),
    ("MTAP", "MTAP"),
    ("MUC1", "MUC1"),
    ("FOLR1", "FOLR1"),
    ("FOLATE RECEPTOR", "FOLR1"),
    ("DLL3", "DLL3"),
    ("CA125", "CA125"),
    ("MUC16", "CA125"),
    ("CAR-T", "CAR-T"),
    ("TCR-T", "TCR-T"),
]

logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# API 客户端
# ---------------------------------------------------------------------------
class ClinicalTrialsSearch:
    """ClinicalTrials.gov API v2 搜索客户端。"""

    def __init__(
        self,
        timeout: float = _REQUEST_TIMEOUT,
        total_budget: float = _TOTAL_BUDGET,
    ) -> None:
        self._request_timeout = timeout
        self._total_budget = total_budget
        #: 因总预算用尽而提前结束，供调用方区分「没有结果」与「没查完」。
        self.budget_exhausted = False
        self._client = httpx.AsyncClient(
            timeout=timeout,
            headers={
                # 模拟真实 Chrome 浏览器请求头（避免被识别为机器人）
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Referer": "https://clinicaltrials.gov/",
                "sec-ch-ua": '"Chromium";v="145", "Google Chrome";v="145", "Not:A-Brand";v="99"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"macOS"',
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
            },
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def search(
        self,
        keyword: str,
        start_date: str | None = None,
        end_date: str | None = None,
        country: str | None = None,
        status: str | None = None,
        max_results: int = 50,
        disease: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        搜索临床试验。

        Parameters
        ----------
        keyword : str
            搜索关键词（基因、疾病、药物等）。
        start_date : str | None
            起始日期 (YYYY-MM-DD)，筛选此日期之后启动的试验。
        end_date : str | None
            结束日期 (YYYY-MM-DD)，筛选此日期之前启动的试验。
        country : str | None
            试验开展国家（英文名称，如 China, United States, Japan）。
        status : str | None
            招募状态筛选，默认 RECRUITING,ACTIVE_NOT_RECRUITING。
        max_results : int
            最大返回结果数。
        disease : str | None
            疾病/癌种筛选（如 "pancreatic"）。会自动 AND 到关键词中。

        Returns
        -------
        list[dict]
            结构化的临床试验列表。
        """
        if status is None:
            status = "RECRUITING,ACTIVE_NOT_RECRUITING"

        deadline = time.monotonic() + self._total_budget
        all_trials: list[dict[str, Any]] = []
        page_token: str | None = None
        page_size = min(max_results, 100)

        while len(all_trials) < max_results:
            if time.monotonic() >= deadline:
                self.budget_exhausted = True
                logger.error(
                    "总预算 %.0fs 已用完，停止搜索（已获得 %d 条）",
                    self._total_budget,
                    len(all_trials),
                )
                break

            params = self._build_params(
                keyword=keyword,
                start_date=start_date,
                end_date=end_date,
                country=country,
                status=status,
                page_size=page_size,
                page_token=page_token,
                disease=disease,
            )

            raw_studies, next_token = await self._fetch_page(params, deadline)
            if not raw_studies:
                break

            for study in raw_studies:
                parsed = self._parse_study(study)
                if parsed:
                    all_trials.append(parsed)
                if len(all_trials) >= max_results:
                    break

            page_token = next_token
            if not page_token:
                break

        return all_trials[:max_results]

    def _build_params(
        self,
        keyword: str,
        start_date: str | None,
        end_date: str | None,
        country: str | None,
        status: str,
        page_size: int,
        page_token: str | None = None,
        disease: str | None = None,
    ) -> dict[str, Any]:
        """构建 API 请求参数。"""
        params: dict[str, Any] = {
            "filter.overallStatus": status,
            "pageSize": str(page_size),
            "fields": ",".join([
                "NCTId",
                "BriefTitle",
                "OfficialTitle",
                "Phase",
                "OverallStatus",
                "Condition",
                "InterventionName",
                "InterventionType",
                "EligibilityCriteria",
                "LeadSponsorName",
                "StartDate",
                "PrimaryCompletionDate",
                "CompletionDate",
                "LastUpdatePostDate",
                "StudyFirstPostDate",
                "LocationCountry",
                "LocationCity",
                "LocationFacility",
                "LastUpdatePostDate",
            ]),
            "format": "json",
            "markupFormat": "legacy",
        }

        # 关键词搜索 — 用 query.term 支持自由文本
        query_parts = []

        # 核心关键词 — 支持多关键词变体
        # 如果关键词已包含 OR，直接使用；否则智能扩展常见变体
        if " OR " in keyword.upper():
            # 用户已指定多关键词（如 "CLDN18.2 OR Claudin 18.2")
            query_parts.append(keyword)
        else:
            # 自动扩展关键词变体（常见格式差异）
            keyword_variants = self._expand_keyword_variants(keyword)
            query_parts.append(keyword_variants)

        # 疾病/癌种筛选 — 使用 AREA[Condition] 字段限定
        # 默认同时匹配胰腺癌 + 实体瘤（很多靶向药试验condition写solid tumor）
        if disease:
            disease_filter = disease
        else:
            disease_filter = "(pancreatic OR \"solid tumor\")"
        query_parts.append(f"AREA[Condition]{disease_filter}")

        # 时间范围 — 使用 AREA[StartDate]RANGE 语法
        if start_date or end_date:
            start = start_date or "MIN"
            end = end_date or "MAX"
            query_parts.append(f"AREA[StartDate]RANGE[{start},{end}]")

        params["query.term"] = " AND ".join(query_parts)

        # 国家筛选 — 使用 query.locn
        if country:
            params["query.locn"] = country

        if page_token:
            params["pageToken"] = page_token

        return params

    async def _fetch_page(
        self, params: dict[str, Any], deadline: float
    ) -> tuple[list[dict[str, Any]], str | None]:
        """获取单页结果，返回 (studies, next_page_token)。

        每次尝试都受 ``deadline`` 约束：单次请求超时压到剩余预算以内，退避
        等待也不越过它，所以整个搜索不会比 ``_total_budget`` 多跑太久。
        """
        for attempt in range(1, _MAX_RETRIES + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.budget_exhausted = True
                logger.error("总预算已用完，放弃第 %d 次尝试", attempt)
                break
            try:
                resp = await self._client.get(
                    _BASE_URL,
                    params=params,
                    timeout=min(self._request_timeout, remaining),
                )
                resp.raise_for_status()
                data = resp.json()
                studies = data.get("studies", [])
                next_token = data.get("nextPageToken")
                return studies, next_token

            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "ClinicalTrials.gov returned %d (attempt %d/%d)",
                    exc.response.status_code,
                    attempt,
                    _MAX_RETRIES,
                )
                if exc.response.status_code == 429:
                    delay = _RETRY_DELAY * attempt * 2
                elif exc.response.status_code == 403:
                    # 403 通常是临时限流，退避重试
                    delay = _RETRY_DELAY * attempt * 3
                elif exc.response.status_code >= 500:
                    delay = _RETRY_DELAY * attempt
                else:
                    break
                await asyncio.sleep(
                    min(delay, max(0.0, deadline - time.monotonic()))
                )

            except (httpx.RequestError, httpx.DecodingError) as exc:
                logger.warning(
                    "Request failed (attempt %d/%d): %s",
                    attempt,
                    _MAX_RETRIES,
                    exc,
                )
                await asyncio.sleep(
                    min(
                        _RETRY_DELAY * attempt,
                        max(0.0, deadline - time.monotonic()),
                    )
                )

        logger.error("Fetch failed after %d attempts", _MAX_RETRIES)
        return [], None

    def _parse_study(self, study: dict[str, Any]) -> dict[str, Any] | None:
        """解析单个试验为结构化字典。"""
        try:
            protocol = study.get("protocolSection", {})
            id_mod = protocol.get("identificationModule", {})
            status_mod = protocol.get("statusModule", {})
            arms_mod = protocol.get("armsInterventionsModule", {})
            elig_mod = protocol.get("eligibilityModule", {})
            sponsor_mod = protocol.get("sponsorCollaboratorsModule", {})
            contacts_mod = protocol.get("contactsLocationsModule", {})

            nct_id = id_mod.get("nctId", "")
            if not nct_id:
                return None

            title = id_mod.get("briefTitle", "") or id_mod.get("officialTitle", "")

            # 阶段
            phase_list = id_mod.get("phase", [])
            if isinstance(phase_list, list):
                phase = "/".join(phase_list) if phase_list else "Not specified"
            else:
                phase = str(phase_list) if phase_list else "Not specified"

            # 状态
            trial_status = status_mod.get("overallStatus", "Unknown")

            # 适应症
            conditions_list = id_mod.get("conditions", [])
            conditions = " | ".join(conditions_list) if conditions_list else ""

            # 干预措施
            interventions_list = arms_mod.get("interventions", [])
            drug_names = []
            for iv in interventions_list:
                name = iv.get("name", "")
                itype = iv.get("type", "")
                if name and itype == "DRUG":
                    drug_names.append(name)
            all_interventions = []
            for iv in interventions_list:
                name = iv.get("name", "")
                itype = iv.get("type", "")
                if name:
                    all_interventions.append(f"{name} ({itype})" if itype else name)

            # 申办方
            sponsor = sponsor_mod.get("leadSponsor", {}).get("name", "")

            # 日期
            start_date_struct = status_mod.get("startDateStruct", {})
            start_date = start_date_struct.get("date", "") if start_date_struct else ""
            last_update = status_mod.get("lastUpdatePostDateStruct", {}).get("date", "")
            # 发布时间（首次公布）
            first_post = status_mod.get("studyFirstPostDateStruct", {}).get("date", "")
            # 主要完成日期
            primary_completion = status_mod.get("primaryCompletionDateStruct", {}).get("date", "")
            # 完成日期
            completion_date = status_mod.get("completionDateStruct", {}).get("date", "")

            # 地点（国家列表）
            locations = contacts_mod.get("locations", [])
            countries = []
            cities = []
            for loc in locations:
                country = loc.get("country", "")
                city = loc.get("city", "")
                if country and country not in countries:
                    countries.append(country)
                if city and city not in cities:
                    cities.append(city)

            # Biomarker 提取
            eligibility_text = elig_mod.get("eligibilityCriteria", "")
            biomarker = self._extract_biomarker(eligibility_text, conditions)

            return {
                "nct_id": nct_id,
                "title": title,
                "phase": phase,
                "status": trial_status,
                "conditions": conditions,
                "drugs": drug_names,
                "interventions": "; ".join(all_interventions),
                "sponsor": sponsor,
                "start_date": start_date,
                "first_post_date": first_post,
                "primary_completion_date": primary_completion,
                "completion_date": completion_date,
                "last_update": last_update,
                "countries": countries,
                "cities": cities[:5],  # 最多显示5个城市
                "biomarker": biomarker,
                "url": f"https://clinicaltrials.gov/study/{nct_id}",
            }
        except Exception as exc:
            logger.warning("Failed to parse study: %s", exc)
            return None

    @staticmethod
    def _expand_keyword_variants(keyword: str) -> str:
        """
        自动扩展关键词变体，覆盖常见格式差异。
        
        例如：
        - CLDN18.2 → CLDN18.2 OR Claudin 18.2 OR Claudin18.2 OR Claudin (CLDN) 18.2
        - KRAS → KRAS（无变体）
        """
        # 已知需要扩展的关键词映射
        variant_map = {
            # CLDN18.2 的多种写法
            "CLDN18.2": "CLDN18.2 OR \"Claudin 18.2\" OR Claudin18.2 OR \"Claudin (CLDN) 18.2\"",
            "Claudin18.2": "Claudin18.2 OR \"Claudin 18.2\" OR CLDN18.2 OR \"Claudin (CLDN) 18.2\"",
            "Claudin 18.2": "\"Claudin 18.2\" OR CLDN18.2 OR Claudin18.2 OR \"Claudin (CLDN) 18.2\"",
            # HER2 的多种写法
            "HER2": "HER2 OR ERBB2",
            "ERBB2": "ERBB2 OR HER2",
            # MET 的多种写法
            "MET": "MET OR C-MET OR c-Met",
            "C-MET": "C-MET OR MET OR c-Met",
            # TROP2 的多种写法
            "TROP2": "TROP2 OR TACSTD2",
            # MSLN 的多种写法
            "MSLN": "MSLN OR Mesothelin",
            "Mesothelin": "Mesothelin OR MSLN",
            # B7-H3 的多种写法
            "B7-H3": "B7-H3 OR B7H3 OR CD276",
            "B7H3": "B7H3 OR B7-H3 OR CD276",
            "CD276": "CD276 OR B7-H3 OR B7H3",
            # Nectin-4 的多种写法
            "Nectin-4": "Nectin-4 OR NECTIN4 OR PVRL4",
            "NECTIN4": "NECTIN4 OR Nectin-4 OR PVRL4",
            # TF / Tissue Factor
            "TF": "TF OR \"Tissue Factor\"",
            "Tissue Factor": "\"Tissue Factor\" OR TF",
            # FOLR1
            "FOLR1": "FOLR1 OR \"Folate receptor\" OR \"folate receptor alpha\"",
            # CA125 / MUC16
            "CA125": "CA125 OR MUC16",
            "MUC16": "MUC16 OR CA125",
            # pan-TRK / NTRK
            "pan-TRK": "pan-TRK OR NTRK OR \"NTRK fusion\"",
            "NTRK": "NTRK OR pan-TRK OR \"NTRK fusion\"",
            # BRCA 的多种写法
            "BRCA": "BRCA OR BRCA1 OR BRCA2",
        }
        
        # 检查是否需要扩展
        keyword_upper = keyword.upper()
        for base_key, variants in variant_map.items():
            if keyword_upper == base_key.upper() or keyword.upper() == base_key:
                return variants
        
        # 无需扩展，直接返回原关键词
        return keyword

    @staticmethod
    def _extract_biomarker(eligibility: str, conditions: str) -> str:
        """从入排标准和适应症中提取 Biomarker 关键词。"""
        text = f"{eligibility} {conditions}".upper()
        found = []
        for keyword, label in _BIOMARKER_PATTERNS:
            # 跳过已被更具体匹配覆盖的泛匹配
            if any(label in f for f in found):
                continue
            if keyword in text:
                found.append(label)
        return ", ".join(found) if found else ""


# ---------------------------------------------------------------------------
# 结果展示与总结
# ---------------------------------------------------------------------------
def print_trials_table(trials: list[dict[str, Any]]) -> None:
    """打印临床试验表格。"""
    if not trials:
        print("\n⚠️  未找到匹配的临床试验。\n")
        return

    print(f"\n{'='*100}")
    print(f"  临床试验搜索结果（共 {len(trials)} 条）")
    print(f"{'='*100}\n")

    for i, t in enumerate(trials, 1):
        # 状态 emoji
        status_icon = {
            "RECRUITING": "🟢",
            "ACTIVE_NOT_RECRUITING": "🟡",
            "COMPLETED": "✅",
            "TERMINATED": "🔴",
            "WITHDRAWN": "⚫",
            "SUSPENDED": "🟠",
            "NOT_YET_RECRUITING": "⚪",
        }.get(t["status"], "❓")

        status_cn = {
            "RECRUITING": "招募中",
            "ACTIVE_NOT_RECRUITING": "暂停招募",
            "COMPLETED": "已完成",
            "TERMINATED": "已终止",
            "WITHDRAWN": "已撤回",
            "SUSPENDED": "暂停",
            "NOT_YET_RECRUITING": "尚未招募",
        }.get(t["status"], t["status"])

        print(f"  {i}. [{t['nct_id']}] {t['title']}")
        print(f"     阶段: {t['phase']}  |  状态: {status_icon} {status_cn}")

        # 日期信息：发布时间 + 启动 + 最近更新
        dates_parts = []
        if t.get("first_post_date"):
            dates_parts.append(f"发布: {t['first_post_date']}")
        if t.get("start_date"):
            dates_parts.append(f"启动: {t['start_date']}")
        if t.get("last_update"):
            dates_parts.append(f"更新: {t['last_update']}")
        if dates_parts:
            print(f"     📅 {'  |  '.join(dates_parts)}")

        if t["drugs"]:
            drugs_str = ", ".join(t["drugs"][:6])
            if len(t["drugs"]) > 6:
                drugs_str += f" ... (+{len(t['drugs'])-6})"
            print(f"     药物: {drugs_str}")

        if t["biomarker"]:
            print(f"     Biomarker: {t['biomarker']}")

        if t["sponsor"]:
            print(f"     申办方: {t['sponsor']}")

        if t["countries"]:
            country_str = ", ".join(t["countries"][:5])
            if len(t["countries"]) > 5:
                country_str += f" ... (+{len(t['countries'])-5})"
            print(f"     国家: {country_str}")

        print(f"     🔗 {t['url']}")
        print()


def print_summary(trials: list[dict[str, Any]], keyword: str) -> None:
    """打印智能总结。"""
    if not trials:
        return

    print(f"\n{'='*100}")
    print(f"  📊 智能总结 — 关键词: \"{keyword}\"")
    print(f"{'='*100}\n")

    # 1. 搜索结果统计
    status_counter = Counter(t["status"] for t in trials)
    status_cn = {
        "RECRUITING": "招募中",
        "ACTIVE_NOT_RECRUITING": "暂停招募",
        "COMPLETED": "已完成",
        "TERMINATED": "已终止",
        "WITHDRAWN": "已撤回",
        "SUSPENDED": "暂停",
        "NOT_YET_RECRUITING": "尚未招募",
    }
    print(f"  📈 搜索结果统计: 共 {len(trials)} 条试验")
    for status, count in status_counter.most_common():
        cn = status_cn.get(status, status)
        print(f"     • {cn} ({status}): {count}")
    print()

    # 2. 临床阶段分布
    phase_counter = Counter(t["phase"] for t in trials)
    print("  📋 临床阶段分布:")
    for phase, count in phase_counter.most_common():
        bar = "█" * count
        print(f"     • {phase}: {count} {bar}")
    print()

    # 3. Biomarker 分布
    biomarker_counter: Counter[str] = Counter()
    for t in trials:
        if t["biomarker"]:
            for bm in t["biomarker"].split(", "):
                biomarker_counter[bm] += 1
    if biomarker_counter:
        print("  🎯 Biomarker / 靶点分布:")
        for bm, count in biomarker_counter.most_common(15):
            bar = "█" * count
            print(f"     • {bm}: {count} {bar}")
        print()

    # 4. 热门药物
    drug_counter: Counter[str] = Counter()
    for t in trials:
        for drug in t["drugs"]:
            drug_counter[drug] += 1
    if drug_counter:
        print("  💊 热门药物/干预措施 Top 15:")
        for drug, count in drug_counter.most_common(15):
            bar = "█" * count
            print(f"     • {drug}: {count} {bar}")
        print()

    # 5. 地区分布
    country_counter: Counter[str] = Counter()
    for t in trials:
        for c in t["countries"]:
            country_counter[c] += 1
    if country_counter:
        print("  🌍 地区分布 Top 10:")
        for c, count in country_counter.most_common(10):
            bar = "█" * count
            print(f"     • {c}: {count} {bar}")
        print()

    # 6. 申办方分布
    sponsor_counter: Counter[str] = Counter()
    for t in trials:
        if t["sponsor"]:
            sponsor_counter[t["sponsor"]] += 1
    if sponsor_counter:
        print("  🏢 申办方 Top 10:")
        for sp, count in sponsor_counter.most_common(10):
            print(f"     • {sp}: {count}")
        print()

    # 7. 关键发现摘要
    print("  🔑 关键发现:")
    findings = []

    # 最热门的阶段
    if phase_counter:
        top_phase = phase_counter.most_common(1)[0]
        findings.append(f"  最集中阶段为 {top_phase[0]}（{top_phase[1]} 项）")

    # 招募中比例
    recruiting = status_counter.get("RECRUITING", 0)
    if recruiting:
        pct = recruiting / len(trials) * 100
        findings.append(f"  招募中试验占 {pct:.0f}%（{recruiting}/{len(trials)}）")

    # 热门靶点
    if biomarker_counter:
        top_bm = biomarker_counter.most_common(3)
        bm_str = ", ".join(f"{bm}({cnt})" for bm, cnt in top_bm)
        findings.append(f"  最热门靶点: {bm_str}")

    # 热门药物
    if drug_counter:
        top_drugs = drug_counter.most_common(3)
        drug_str = ", ".join(f"{d}({cnt})" for d, cnt in top_drugs)
        findings.append(f"  最热门药物: {drug_str}")

    # 涉及国家数
    if country_counter:
        findings.append(f"  试验覆盖 {len(country_counter)} 个国家/地区")

    for f in findings:
        print(f"     • {f}")
    print()


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------
async def main() -> None:
    parser = argparse.ArgumentParser(
        description="ClinicalTrials.gov 临床试验搜索工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s --keyword "KRAS G12D"
  %(prog)s --keyword "pancreatic cancer" --start-date 2024-01-01 --country China
  %(prog)s --keyword "BRCA1" --start-date 2023-01-01 --end-date 2025-06-01 --country "United States"
  %(prog)s --keyword "免疫治疗 胰腺癌" --max-results 100
        """,
    )
    parser.add_argument(
        "--keyword", "-k",
        required=True,
        help="搜索关键词（基因名、疾病名、药物名等）",
    )
    parser.add_argument(
        "--start-date", "-s",
        default=None,
        help="起始日期 (YYYY-MM-DD)，筛选此日期之后启动的试验",
    )
    parser.add_argument(
        "--end-date", "-e",
        default=None,
        help="结束日期 (YYYY-MM-DD)，筛选此日期之前启动的试验",
    )
    parser.add_argument(
        "--country", "-c",
        default=None,
        help="试验开展国家（英文名称，如 China, United States, Japan）",
    )
    parser.add_argument(
        "--status",
        default=None,
        help="招募状态筛选（默认: RECRUITING,ACTIVE_NOT_RECRUITING）",
    )
    parser.add_argument(
        "--max-results", "-n",
        type=int,
        default=50,
        help="最大返回结果数（默认 50，上限 1000）",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=_TOTAL_BUDGET,
        help=(
            f"整次搜索的总时间预算，秒（默认 {_TOTAL_BUDGET:.0f}）；"
            "用尽时主动停止并说明原因，而不是被宿主超时杀掉"
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="以 JSON 格式输出（便于程序调用）",
    )

    args = parser.parse_args()

    # 验证日期格式
    for date_str, label in [(args.start_date, "start-date"), (args.end_date, "end-date")]:
        if date_str:
            try:
                datetime.strptime(date_str, "%Y-%m-%d")
            except ValueError:
                print(f"错误: {label} 格式不正确，请使用 YYYY-MM-DD")
                sys.exit(1)

    # 限制最大结果数
    max_results = min(args.max_results, 1000)

    if args.timeout <= 0:
        print("错误: --timeout 必须是正数（秒）")
        sys.exit(1)

    # 搜索参数展示（输出到 stderr，避免干扰 JSON 输出）
    out = print if not args.json else lambda *a, **kw: print(*a, **{**kw, "file": sys.stderr})
    out(f"\n🔍 搜索条件:")
    out(f"   关键词: {args.keyword}")
    if args.start_date:
        out(f"   开始日期: {args.start_date}")
    if args.end_date:
        out(f"   结束日期: {args.end_date}")
    if args.country:
        out(f"   国家: {args.country}")
    if args.status:
        out(f"   状态: {args.status}")
    out(f"   最大结果数: {max_results}")
    out(f"   总时间预算: {args.timeout:.0f}s")
    out(f"\n⏳ 正在搜索 ClinicalTrials.gov ...")

    client = ClinicalTrialsSearch(total_budget=args.timeout)
    try:
        trials = await client.search(
            keyword=args.keyword,
            start_date=args.start_date,
            end_date=args.end_date,
            country=args.country,
            status=args.status,
            max_results=max_results,
        )
    finally:
        await client.aclose()

    if client.budget_exhausted:
        out(
            f"⚠️  已达总时间预算 {args.timeout:.0f}s，结果是部分结果；"
            "如需更久请提高 --timeout（并给宿主工具足够的 timeoutMs）"
        )

    if args.json:
        print(json.dumps(trials, ensure_ascii=False, indent=2))
    else:
        print_trials_table(trials)
        print_summary(trials, args.keyword)


if __name__ == "__main__":
    asyncio.run(main())
