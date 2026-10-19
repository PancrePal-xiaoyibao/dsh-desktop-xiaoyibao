#!/usr/bin/env python3
"""PROTAC 第二轮搜索"""
import asyncio, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from search import ClinicalTrialsSearch

MORE_KW = [
    "vepdegestrant",
    "NX-5948", "NX-2127",
    "KT-474", "KT-333", "KT-413",
    "CFT1946", "CFT8634", "CFT8919",
    "NKT3964 OR DT2216 OR ST-01156 OR RNK05047",
    "BTK degrader",
    "ER degrader",
    "molecular glue degrader",
    "ubiquitin proteasome degrader",
    "protein degradation AND oncology",
    "degrader AND KRAS",
]

async def main():
    with open('outputs/protac_search.json') as f:
        existing = json.load(f)
    seen = {t['nct_id'] for t in existing}

    client = ClinicalTrialsSearch()
    try:
        for kw in MORE_KW:
            print(f"  {kw} ...", end=" ", flush=True)
            try:
                trials = await client.search(keyword=kw, max_results=30)
                new = 0
                for t in trials:
                    if t['nct_id'] not in seen:
                        seen.add(t['nct_id'])
                        existing.append(t)
                        new += 1
                print(f"{new} new, total {len(existing)}")
            except Exception:
                print("skip")
    finally:
        await client.aclose()

    with open('outputs/protac_search.json', 'w', encoding='utf-8') as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)
    print(f"\nFinal: {len(existing)}")

asyncio.run(main())