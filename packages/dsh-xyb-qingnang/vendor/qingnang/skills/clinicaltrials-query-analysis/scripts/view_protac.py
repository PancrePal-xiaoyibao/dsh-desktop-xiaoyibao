#!/usr/bin/env python3
import json
with open('outputs/protac_search.json') as f:
    data = json.load(f)
print(f'Total: {len(data)}')
for t in data:
    print(f"\n{t['nct_id']} [{t['status']}]")
    print(f"  Title: {t['title'][:120]}")
    print(f"  Sponsor: {t['sponsor']}")
    print(f"  Phase: {t['phase']}")
    print(f"  Drugs: {', '.join(t.get('drugs',[])[:4])}")
    print(f"  Countries: {', '.join(t.get('countries',[])[:5])}")