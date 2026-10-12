"""Duplication of usage / pricing / balance features, and whether any of them is a shared layer.

Usage: python3 usage_duplication.py plugins.json deps.json
"""
import collections, json, re, sys

plugins = json.load(open(sys.argv[1]))['plugins']
manifests = json.load(open(sys.argv[2]))
GROUPS = {
    'pricing': r'计价|价格|费用|成本|cost|price|峰谷',
    'balance': r'余额|balance',
    'token-usage': r'token.{0,6}(用量|统计|消耗)|用量统计|usage',
}
text = lambda p: p['description']['zh'] + ' ' + p['name']
for label, pat in GROUPS.items():
    ps = [p for p in plugins if re.search(pat, text(p), re.I)]
    print(label, len(ps), '30d downloads', sum(p.get('downloads') or 0 for p in ps))
union = [p for p in plugins if any(re.search(pat, text(p), re.I) for pat in GROUPS.values())]
names = {p['npm'] for p in union if p.get('npm')}
edges = collections.Counter()
for name, m in manifests.items():
    if 'err' not in m:
        for dep in {**m['deps'], **m['peer']}:
            if dep in names and dep != name:
                edges[dep] += 1
print('union', len(union), 'on npm', len(names), 'depended on by others', edges.most_common(5))
