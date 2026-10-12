"""Category-level supply/demand from the published awesome-dsh-plugin catalog.

Usage: python3 categories.py plugins.json
plugins.json comes from the npm package `dsh-plugin-catalog` (npm pack dsh-plugin-catalog).
Downloads are npm 30-day counts; GitHub-only installs are not counted.
"""
import collections, json, statistics as st, sys

catalog = json.load(open(sys.argv[1]))
plugins = catalog['plugins']
print('catalog updated', catalog['updated'], 'plugins', len(plugins))
print(f"{'category':10}{'n':>6}{'npm':>5}{'dl30d':>9}{'mean':>8}{'median':>8}{'top3%':>7}{'new30d':>7}")
rows = []
for cat in sorted({p['category'] for p in plugins}):
    ps = [p for p in plugins if p['category'] == cat]
    ds = sorted((p['downloads'] for p in ps if p.get('downloads') is not None), reverse=True)
    total = sum(ds)
    new = sum(1 for p in ps if (p.get('added') or '') >= '2026-09-10')
    rows.append((cat, len(ps), len(ds), total, total / len(ds) if ds else 0,
                 st.median(ds) if ds else 0, sum(ds[:3]) / total if total else 0, new))
for r in sorted(rows, key=lambda r: -r[4]):
    print(f"{r[0]:10}{r[1]:6}{r[2]:5}{r[3]:9}{r[4]:8.0f}{r[5]:8.0f}{r[6] * 100:6.0f}%{r[7]:7}")
