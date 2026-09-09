"""Recompute every figure the deck quotes from the published 0.4.0 edition.

The deck must not carry a number that only exists in prose. Each block below
prints the value and the artifact it came from; the output is pasted into
build-deck.mjs and the deck stamps the fetch date beside it.
"""
import json, os

BASE = '/Users/johan/Dev/Beta Mobility/Apps/Danish Mobility/dk-mobility/data/published'
HERE = os.path.dirname(os.path.abspath(__file__))

lt = json.load(open(BASE + '/league_table.json'))
print('edition', lt['index_version'], 'generated', lt['generated_at'])
km = [p for p in lt['places'] if p['place_type'] == 'kommune']
print('kommuner', len(km))

ctx = json.load(open(BASE + '/kommune-context.json'))
groups = json.load(open(BASE + '/kommune-groups.json'))

# --- population denominator: DST folketal, never the Kontur grid sum ---------
ctx_k = ctx['kommuner'] if isinstance(ctx, dict) and 'kommuner' in ctx else ctx
def folketal(slug):
    e = ctx_k.get(slug) if isinstance(ctx_k, dict) else None
    if not e:
        return None
    for key in ('folketal', 'population', 'befolkning'):
        if key in e and e[key]:
            return e[key]
    return None

sample = list(ctx_k)[:2] if isinstance(ctx_k, dict) else None
print('context keys sample', sample, json.dumps(ctx_k[sample[0]], ensure_ascii=False)[:300] if sample else '')

# --- grade distribution and population share --------------------------------
from collections import Counter
dist = Counter(p['grade'] for p in km)
print('grade counts', dict(sorted(dist.items())))

pop_by_grade = Counter()
total_pop = 0
for p in km:
    pop = folketal(p['slug']) or p['population']
    total_pop += pop
    pop_by_grade[p['grade']] += pop
print('total pop', total_pop)
for g in 'ABCDEFG':
    print('  %s  %2d kommuner  %5.1f%% of population' % (g, dist[g], 100 * pop_by_grade[g] / total_pop))
efg_pop = sum(pop_by_grade[g] for g in 'EFG')
print('E+F+G: %d kommuner, %.2f million people, %.1f%%' % (
    sum(dist[g] for g in 'EFG'), efg_pop / 1e6, 100 * efg_pop / total_pop))

# --- capital vs rural, public-transport quality pillar, population-weighted --
gk = groups['kommuner'] if isinstance(groups, dict) and 'kommuner' in groups else groups
print('groups sample', json.dumps(list(gk.items())[:1] if isinstance(gk, dict) else gk[:1], ensure_ascii=False)[:300])

def group_of(slug):
    e = gk.get(slug) if isinstance(gk, dict) else None
    if not e:
        return None
    return e.get('group') if isinstance(e, dict) else e

def weighted(slugs, key):
    num = den = 0.0
    for p in km:
        if p['slug'] not in slugs:
            continue
        v = p['pillars'].get(key)
        if v is None:
            continue
        w = folketal(p['slug']) or p['population']
        num += v * w
        den += w
    return num / den if den else None

by_group = {}
for p in km:
    by_group.setdefault(group_of(p['slug']), set()).add(p['slug'])
print('groups', {k: len(v) for k, v in by_group.items()})
for name, slugs in sorted(by_group.items(), key=lambda kv: -len(kv[1])):
    print('  %-28s n=%2d  pt-quality (pop-weighted) %.1f' % (
        name, len(slugs), weighted(slugs, 'kollektiv_kvalitet') or -1))

# --- Midttrafik: Aarhus vs the other 18, unweighted mean of composite --------
auth_path = BASE + '/kommune-authorities.json'
if os.path.exists(auth_path):
    auth = json.load(open(auth_path))
    ak = auth['kommuner'] if isinstance(auth, dict) and 'kommuner' in auth else auth
    mid = [p for p in km if (ak.get(p['slug'], {}) or {}).get('pta') == 'Midttrafik'] if isinstance(ak, dict) else []
    print('Midttrafik n', len(mid))
    others = [p for p in mid if not p['slug'].startswith('dk-aarhus')]
    if others:
        print('  Aarhus %.2f   other %d mean %.2f' % (
            [p for p in mid if p['slug'].startswith('dk-aarhus')][0]['composite'],
            len(others), sum(p['composite'] for p in others) / len(others)))
else:
    print('no kommune-authorities.json in published/')

# --- ageing: ten fastest-ageing municipalities and their grades --------------
def ageing(slug):
    e = gk.get(slug) if isinstance(gk, dict) else None
    if not isinstance(e, dict):
        return None
    for key in ('ageing_delta', 'aeldre_delta', 'delta_65', 'ageing_tier'):
        if key in e:
            return e[key]
    return None
print('ageing sample', {k: v for k, v in list(gk.items())[:1]} if isinstance(gk, dict) else None)

# --- Aarhus row -------------------------------------------------------------
a = [p for p in km if p['slug'].startswith('dk-aarhus')][0]
rank = sorted(km, key=lambda p: -p['composite']).index(a) + 1
print('Aarhus composite %.2f grade %s rank %d/%d pillars %s pop %s' % (
    a['composite'], a['grade'], rank, len(km), a['pillars'], folketal(a['slug']) or a['population']))
