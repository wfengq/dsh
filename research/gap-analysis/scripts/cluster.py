import json,sys,re,collections,statistics as st
import jieba, numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.cluster import KMeans
jieba.setLogLevel(60)
P=json.load(open(sys.argv[1]))['plugins']
stop=set('的 与 和 及 在 为 把 可 支持 提供 插件 dsh deepseek harness DSH 一键 通过 自动 并 让 用 到 中 等 或 时 的 web Web 会话 智能体 agent Agent 模型 工具 一个 不 也 可选 页 设置 显示 内置 增加 新增 实时'.split())
def tok(t):
    t=re.sub(r'https?://\S+','',t)
    return [w.lower() for w in jieba.lcut(t) if len(w.strip())>1 and w.lower() not in stop and not re.fullmatch(r'[\W\d_]+',w)]
docs=[' '.join(tok(p['description']['zh']+' '+p['name'])) for p in P]
vec=TfidfVectorizer(tokenizer=str.split,token_pattern=None,min_df=3,max_df=0.3,sublinear_tf=True)
X=vec.fit_transform(docs); terms=np.array(vec.get_feature_names_out())
K=int(sys.argv[2]); km=KMeans(K,n_init=5,random_state=0).fit(X)
out=[]
for k in range(K):
    idx=[i for i,l in enumerate(km.labels_) if l==k]; ps=[P[i] for i in idx]
    ds=sorted([p['downloads'] for p in ps if p.get('downloads') is not None],reverse=True)
    top=terms[np.argsort(-km.cluster_centers_[k])[:8]]
    new=sum(1 for p in ps if (p.get('added') or '')>='2026-09-10')
    leaders=sorted([p for p in ps if p.get('downloads')],key=lambda p:-p['downloads'])[:3]
    out.append(dict(k=k,n=len(ps),npm=len(ds),tot=sum(ds),mean=(sum(ds)/len(ds) if ds else 0),med=(st.median(ds) if ds else 0),top3=(sum(ds[:3])/sum(ds) if sum(ds) else 0),new=new,terms=' '.join(top),cats=collections.Counter(p['category'] for p in ps).most_common(2),leaders=[(p['owner']+'/'+p['name'],p['downloads']) for p in leaders]))
json.dump(out,open(sys.argv[3],'w'),ensure_ascii=False,indent=1)
print(f"{'k':>3}{'n':>5}{'npm':>5}{'dl30d':>9}{'med':>7}{'new':>5}  terms | leaders")
for o in sorted(out,key=lambda o:-o['med']):
    print(f"{o['k']:3}{o['n']:5}{o['npm']:5}{o['tot']:9}{o['med']:7.0f}{o['new']:5}  {o['terms'][:60]} | {o['leaders'][:2]}")
