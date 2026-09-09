import json, os

BASE = '/Users/johan/Dev/Beta Mobility/Apps/Danish Mobility/dk-mobility/data/published'
HERE = os.path.dirname(os.path.abspath(__file__))

lt = json.load(open(BASE + '/league_table.json'))
places = [p for p in lt['places'] if p['place_type'] == 'kommune']
print('kommuner', len(places))

pts, missing = [], []
for p in places:
    f = f"{BASE}/trends/{p['slug']}.json"
    if not os.path.exists(f):
        missing.append(p['slug']); continue
    t = json.load(open(f))
    s = t.get('series', {}).get('families_with_car_pct')
    if not s:
        missing.append(p['slug']); continue
    v = [x for x in s['points'] if x.get('value') is not None]
    if not v:
        missing.append(p['slug']); continue
    pts.append({'name': p['name'], 'grade': p['grade'], 'year': v[-1]['year'],
                'x': v[-1]['value'], 'y': p['composite']})

print('with data', len(pts), 'missing', len(missing), missing[:5])
print('years', sorted({q['year'] for q in pts}))

xs = [q['x'] for q in pts]; ys = [q['y'] for q in pts]; n = len(xs)
mx = sum(xs) / n; my = sum(ys) / n
r = sum((a - mx) * (b - my) for a, b in zip(xs, ys)) / (
    (sum((a - mx) ** 2 for a in xs) * sum((b - my) ** 2 for b in ys)) ** 0.5)
print('pearson r = %.4f' % r)
print('x %.1f-%.1f  y %.1f-%.1f' % (min(xs), max(xs), min(ys), max(ys)))

pts.sort(key=lambda z: z['x'])
for z in pts[:3] + pts[-3:]:
    print(z)

json.dump(pts, open(HERE + '/scatter.json', 'w'))
