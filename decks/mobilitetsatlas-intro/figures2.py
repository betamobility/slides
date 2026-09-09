import json, os
from collections import Counter

BASE = '/Users/johan/Dev/Beta Mobility/Apps/Danish Mobility/dk-mobility/data/published'
lt = json.load(open(BASE + '/league_table.json'))
km = [p for p in lt['places'] if p['place_type'] == 'kommune']
by_code = {p['kommune_code'].zfill(3): p for p in km}

g = json.load(open(BASE + '/kommune-groups.json'))
print('group metadata', json.dumps(g['metadata'], ensure_ascii=False))
gk = g['kommuner']
print('one entry', json.dumps(list(gk.items())[0], ensure_ascii=False))

def code(k):
    return k.zfill(3)

# --- population-weighted public-transport quality per DST kommunegruppe ------
buckets = {}
for k, e in gk.items():
    p = by_code.get(code(k))
    if not p:
        print('unmatched', k); continue
    buckets.setdefault(e['group'], []).append(p)

for name, ps in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
    num = sum(p['pillars']['kollektiv_kvalitet'] * p['population'] for p in ps)
    den = sum(p['population'] for p in ps)
    print('%-22s n=%2d  pt-quality (pop-weighted) %.1f' % (name, len(ps), num / den))

cap = buckets['Hovedstadskommuner']; rur = buckets['Landkommuner']
w = lambda ps: sum(p['pillars']['kollektiv_kvalitet'] * p['population'] for p in ps) / sum(p['population'] for p in ps)
print('CAPITAL %.1f  RURAL %.1f  ratio %.2fx' % (w(cap), w(rur), w(cap) / w(rur)))

# --- ageing: the ten fastest-ageing municipalities and their grades ----------
one = list(gk.values())[0]
print('entry keys', list(one))
rankkey = next((k for k in one if 'rank' in k or 'delta' in k or 'tier' in k or 'aeldre' in k or 'ageing' in k), None)
print('rank-ish key', rankkey)
if rankkey:
    rows = [(e.get(rankkey), by_code[code(k)]['name'], by_code[code(k)]['grade'])
            for k, e in gk.items() if code(k) in by_code and e.get(rankkey) is not None]
    rows.sort(key=lambda r: r[0])
    print('top 10 by', rankkey, rows[:10])
    print('grades of top 10', Counter(r[2] for r in rows[:10]))

# --- network stats ----------------------------------------------------------
ns = json.load(open(BASE + '/pt/network-stats.json'))
print('network-stats', json.dumps(ns, ensure_ascii=False)[:600])
