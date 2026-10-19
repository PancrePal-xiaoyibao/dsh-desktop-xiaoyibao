#!/usr/bin/env python3
"""搜索 PROTAC 降解剂 + PROTAC/RASi 联合临床试验"""
import asyncio, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from search import ClinicalTrialsSearch

KEYWORDS = [
    "PROTAC",
    "proteolysis targeting chimera",
    "ARV-471",
    "ARV-110",
    "ARV-766",
    "KT-474",
    "DT2216",
    "NX-5948",
    "AC-676",
    "CFT8634",
    "FHD-609",
    "BMS-986365",
    "protein degrader",
    "targeted protein degradation",
    "E3 ligase degrader",
    "PROTAC AND RAS",
    "degrader AND RAS inhibitor",
    "PROTAC AND pancreatic",
    "PROTAC AND solid tumor",
    "bifunctional degrader",
]

async def main():
    all_trials = []
    seen = set()
    client = ClinicalTrialsSearch()

    try:
        for kw in KEYWORDS:
            print(f"  {kw} ...", end=" ", flush=True)
            try:
                trials = await client.search(keyword=kw, max_results=50)
                new = 0
                for t in trials:
                    if t["nct_id"] not in seen:
                        seen.add(t["nct_id"])
                        all_trials.append(t)
                        new += 1
                print(f"{new} new, total {len(all_trials)}")
            except Exception as e:
                print(f"skip: {e}")
    finally:
        await client.aclose()

    out = Path(__file__).resolve().parent.parent / "outputs" / "protac_search.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(all_trials, f, ensure_ascii=False, indent=2)
    print(f"\n  Total PROTAC-related: {len(all_trials)}")

if __name__ == "__main__":
    asyncio.run(main())