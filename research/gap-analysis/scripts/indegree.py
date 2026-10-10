"""Which catalog plugins are depended on by other catalog plugins.

Usage: python3 indegree.py plugins.json deps.json
deps.json is produced by deps.mjs (latest manifest of every npm-published catalog plugin).
"""
import collections, json, sys

plugins = json.load(open(sys.argv[1]))['plugins']
manifests = json.load(open(sys.argv[2]))
names = {p['npm'] for p in plugins if p.get('npm')}
indeg, dependents = collections.Counter(), collections.defaultdict(list)
for name, m in manifests.items():
    if 'err' in m:
        continue
    for dep in {**m['deps'], **m['peer']}:
        if dep in names and dep != name:
            indeg[dep] += 1
            dependents[dep].append(name)
users = sum(1 for n, m in manifests.items() if 'err' not in m
            and any(d in names and d != n for d in {**m['deps'], **m['peer']}))
print('manifests', len(manifests), 'plugins depending on another catalog plugin', users)
for dep, count in indeg.most_common(15):
    print(count, dep, dependents[dep][:4])
