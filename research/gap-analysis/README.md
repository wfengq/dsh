# DSH 插件生态缺口分析（2026-10-10）

目的：找出一个能成为 DeepSeek Harness（dsh）生态里“不可缺少的一环”的插件方向。结论和选型依据记录在设计文档 [`docs/superpowers/specs/2026-10-10-dsh-ledger-design.md`](../../docs/superpowers/specs/2026-10-10-dsh-ledger-design.md) 里，本文只记录数据和方法，方便复核。

## 数据来源

| 数据 | 来源 | 时间 |
|---|---|---|
| 插件目录（4471 个插件，含分类、30 天 npm 下载量、收录日期、npm 包名） | npm 包 `dsh-plugin-catalog@2026.1010.4974` 里的 `plugins.json`（由 awesome-dsh-plugin 发布） | 目录更新于 2026-10-09；下载量统计区间为 2026-09-10 至 2026-10-09 |
| 2320 个 npm 插件的最新 manifest（dependencies、peerDependencies） | `registry.npmjs.org/<name>/latest`，由 `scripts/deps.mjs` 抓取 | 2026-10-10 |
| dsh 发版记录 | `npm view @deepseek-ai/dsh time` | 2026-10-10 |
| 官方路线图 | `deepseek-ai/deepseek-harness` 仓库 `.agents/notes/proposed/` | `master@d743267` |

原始数据较大，没有放进仓库，可以按下面的命令重新生成。`data/clusters-k90.json` 是聚类结果的快照。

## 复现

```sh
npm pack dsh-plugin-catalog && tar xzf dsh-plugin-catalog-*.tgz      # → package/plugins.json
node scripts/deps.mjs package/plugins.json deps.json                 # 抓取 manifest（约 1 分钟）
python3 scripts/categories.py package/plugins.json                   # 分类层面的供给与需求
python3 scripts/indegree.py package/plugins.json deps.json           # 插件之间的依赖图
python3 scripts/usage_duplication.py package/plugins.json deps.json  # 用量类功能的重复程度
npm i semver@7 && node scripts/peer_compat.mjs deps.json             # 版本范围兼容性
# 聚类（需要 scikit-learn 和 jieba）：
python3 scripts/cluster.py package/plugins.json 90 clusters.json
```

## 主要发现

1. **生态是扁平的。** 2320 个 npm 插件里只有 59 个依赖了其他社区插件。唯一形成平台的是 `dsh-better-sidebar`（27 个插件依赖它）。而官方之后上线了 `ui-sidebar-right` 的 tab slot 和 `ui-dockkit`，等于把它的核心价值收编了。由此得出的教训：**只补官方 UI 短板的底座，迟早会被官方收编。**
2. **下载量的中位数不可用。** 每个分类的中位数都在 1000 到 1500 左右，基本是 npm 镜像同步和爬虫带来的基线下载，只有头部插件的数字能反映真实需求。
3. **真实需求集中在补齐 Claude Code / Codex 的体验。** 例如上下文压缩 billion-context 30 天下载 86 万，Codex 风格界面、技能管理、会话归档、/review、定时自动化也都很高。但这些方向的供给普遍超过 15 个同类插件，而且官方 proposed 路线图里已经有可召回压缩、任务面板、侧边会话等提案。
4. **安全方向已经饱和。** 静态能力披露有 dsh-trust-check，它有稳定的 JSON 契约，并已被 awesome 列表采用；安装前闸门至少有 6 个同类插件。（选型讨论初期曾判断这个方向“社区几乎空白”，当时只做了关键词检索，判断有误，以本文为准。）
5. **兼容性的痛点很大，但检测和把关已经有人做了。** 声明了 dsh 依赖版本范围的 1650 个插件中，有 510 个（31%）的范围不包含当前正式版 0.2.0-rc.2，会被官方的版本检查拒装。可是 plugin-radar（1.3 万条运行级兼容记录）、dsh-plugin-precheck（隔离环境试装）、dsh-plugin-gating-hub（升级预检加回滚）已经覆盖了“检测和把关”。剩下的运行时适配层很脆弱，而且 dsh 进入稳定期后价值会迅速下降。
6. **用量、计价、余额是重复实现最严重、但没有共享层的方向。** 相关插件有 332 个（计价 168、余额 152、token 统计 151，有重叠），30 天下载合计约 45 万（计价类）。其中没有一个把自己定位成共享服务，整个类别只有 1 条依赖边。官方只有 token 估算（`token-meter`）和官方账号的余额接口，**没有价格数据、费用账本、多厂商余额**。

## 方法局限

- 只统计了发布到 npm 的插件（4471 个中有 2317 个），通过 GitHub 安装的插件没有下载量数据。
- 用量相关插件是通过描述文本匹配关键词筛出来的，会有漏检和误检。
- 依赖图只看 manifest 里声明的依赖。运行时通过 `ctx.inject` 软依赖其他插件服务、但没有在 manifest 中声明的情况统计不到。
