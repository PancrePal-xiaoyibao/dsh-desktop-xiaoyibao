#!/usr/bin/env python3
"""
获取临床试验详细信息（PI、联络信息、各中心联系方式）。
从现有 NCT ID 列表出发，调用 ClinicalTrials.gov API v2 获取补充字段。
"""

import asyncio
import json
import os
import sys

try:
    import httpx
except ImportError:
    print("错误: 需要 httpx，请运行: pip install httpx")
    sys.exit(1)

BASE_URL = "https://clinicaltrials.gov/api/v2/studies"
REQUEST_TIMEOUT = 30.0
MAX_CONCURRENT = 5  # 并发控制，避免限流

# 已知的 CLDN18.2 相关试验 NCT ID（从搜索结果整理）
NCT_IDS = [
    # ADC
    "NCT05482893", "NCT06587425", "NCT06649292", "NCT06350006",
    "NCT06985368", "NCT05857332", "NCT05205850", "NCT05367635",
    "NCT07284134", "NCT07584135", "NCT05458219", "NCT07066098",
    "NCT07483554", "NCT06770439", "NCT07483567", "NCT07385703",
    "NCT05934331", "NCT07556640", "NCT07569068", "NCT07450976",
    "NCT06038396", "NCT06792435", "NCT06519591",
    # 双特异性抗体
    "NCT05365581", "NCT07024615", "NCT07481357", "NCT07432295",
    "NCT07488676", "NCT07431281",
    # CAR-T / CAR-NK
    "NCT05620732", "NCT06782425", "NCT05911217", "NCT07680257",
    "NCT07622940", "NCT07480928", "NCT07627711", "NCT07551362",
    "NCT07066995", "NCT06084286", "NCT06946615", "NCT07416240",
    "NCT07103668", "NCT04842812", "NCT03198052", "NCT07523529",
    # 单抗 + 化疗
    "NCT06468280", "NCT06732856", "NCT06962137", "NCT06901531",
    "NCT07427992", "NCT06902545", "NCT06767449", "NCT07079228",
    "NCT04495296",
    # 全球 ADC
    "NCT06219941", "NCT05702229", "NCT06921837", "NCT06005493",
    "NCT06921928",
    # 诊断/影像
    "NCT07301814", "NCT05436093", "NCT06602037", "NCT07597772",
    "NCT07595237", "NCT07464470",
]


async def fetch_study_detail(client: httpx.AsyncClient, nct_id: str) -> dict | None:
    """获取单个试验的详细数据。"""
    # 不需要字段过滤，取全部数据以获取嵌套结构
    params = {
        "format": "json",
    }

    for attempt in range(3):
        try:
            resp = await client.get(f"{BASE_URL}/{nct_id}", params=params)
            resp.raise_for_status()
            data = resp.json()
            # API v2: 直接返回 protocolSection 在顶层
            return parse_detail(data.get("protocolSection", {}), nct_id)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                await asyncio.sleep(2 ** (attempt + 1))
            elif e.response.status_code == 404:
                print(f"  ⚠️ {nct_id}: 未找到")
                return None
            else:
                if attempt < 2:
                    await asyncio.sleep(1)
                else:
                    print(f"  ❌ {nct_id}: HTTP {e.response.status_code}")
                    return None
        except Exception as e:
            print(f"  ❌ {nct_id}: {e}")
            return None
    return None


def parse_detail(protocol: dict, nct_id: str) -> dict:
    """解析详细试验数据。protocol 是 protocolSection 字典。"""
    id_mod = protocol.get("identificationModule", {})
    status_mod = protocol.get("statusModule", {})
    sponsor_mod = protocol.get("sponsorCollaboratorsModule", {})
    contacts_mod = protocol.get("contactsLocationsModule", {})
    design_mod = protocol.get("designModule", {})
    cond_mod = protocol.get("conditionsModule", {})

    # Phase: 在完整返回中位于 designModule.phases，而非 id_mod.phase
    phase_list = design_mod.get("phases", []) or id_mod.get("phase", [])
    phase = "/".join(phase_list) if phase_list else "Not specified"

    # Conditions: 在完整返回中位于 conditionsModule.conditions
    conditions_list = cond_mod.get("conditions", []) or id_mod.get("conditions", [])
    conditions = " | ".join(conditions_list) if conditions_list else ""

    # PI（注意：overallOfficials 在 contactsLocationsModule 中，不是 sponsorCollaboratorsModule）
    overall_officials = contacts_mod.get("overallOfficials", [])
    pi_info = None
    for official in overall_officials:
        role = official.get("role", "")
        if "PRINCIPAL_INVESTIGATOR" in role.upper() or not pi_info:
            pi_info = {
                "name": official.get("name", ""),
                "role": role,
                "affiliation": official.get("affiliation", ""),
            }
            if "PRINCIPAL_INVESTIGATOR" in role.upper():
                break

    # 中心联系方式
    central_contact = {}
    if contacts_mod.get("centralContacts"):
        cc = contacts_mod["centralContacts"][0]
        central_contact = {
            "name": cc.get("name", ""),
            "phone": cc.get("phone", ""),
            "email": cc.get("email", ""),
        }

    # 各中心（注意：contacts 是嵌套数组）
    locations = contacts_mod.get("locations", [])
    enriched_locations = []
    for loc in locations:
        loc_contacts = loc.get("contacts", [])
        enriched_locations.append({
            "facility": loc.get("facility", ""),
            "city": loc.get("city", ""),
            "state": loc.get("state", ""),
            "country": loc.get("country", ""),
            "status": loc.get("status", ""),
            "contact_name": loc_contacts[0].get("name", "") if loc_contacts else "",
            "contact_phone": loc_contacts[0].get("phone", "") if loc_contacts else "",
            "contact_email": loc_contacts[0].get("email", "") if loc_contacts else "",
            "all_contacts": [
                {"name": c.get("name",""), "phone": c.get("phone",""), "email": c.get("email","")}
                for c in loc_contacts
            ],
        })

    # 中国中心（用于中国可报名医院）
    china_locations = [loc for loc in enriched_locations if loc.get("country") == "China"]

    # 试验状况
    trial_status = status_mod.get("overallStatus", "Unknown")
    last_update = status_mod.get("lastUpdatePostDateStruct", {}).get("date", "")
    # 也尝试直接从字符串取
    if not last_update:
        last_update = status_mod.get("lastUpdatePostDate", "")

    return {
        "nct_id": nct_id,
        "title": id_mod.get("briefTitle", "") or id_mod.get("officialTitle", ""),
        "phase": phase,
        "status": trial_status,
        "last_update": last_update,
        "sponsor": sponsor_mod.get("leadSponsor", {}).get("name", ""),
        "pi": pi_info,
        "central_contact": central_contact,
        "china_locations": china_locations,
        "all_locations": enriched_locations,
        "conditions": conditions,
        "url": f"https://clinicaltrials.gov/study/{nct_id}",
    }


async def main():
    print("=" * 60)
    print("  CLDN18.2 试验详细信息获取")
    print("=" * 60)
    print(f"\n📋 共 {len(NCT_IDS)} 个试验")
    print()

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        "Accept": "application/json",
    }

    sem = asyncio.Semaphore(MAX_CONCURRENT)

    async def fetch_with_limit(nct_id):
        async with sem:
            print(f"  🔍 获取 {nct_id}...")
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, headers=headers) as client:
                return await fetch_study_detail(client, nct_id)

    tasks = [fetch_with_limit(nct_id) for nct_id in NCT_IDS]
    results = await asyncio.gather(*tasks)

    enriched = [r for r in results if r is not None]
    
    output_dir = os.path.join(os.path.dirname(__file__), "..", "outputs")
    os.makedirs(output_dir, exist_ok=True)
    
    path = os.path.join(output_dir, "cldn18_2_enriched.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(enriched, f, ensure_ascii=False, indent=2)
    
    print(f"\n✅ 完成！成功获取 {len(enriched)}/{len(NCT_IDS)} 个试验的详细信息")
    print(f"📁 已保存到: {path}")


if __name__ == "__main__":
    asyncio.run(main())
