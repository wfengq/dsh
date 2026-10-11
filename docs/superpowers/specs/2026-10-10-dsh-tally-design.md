# dsh-tally 设计文档

> 状态：设计已确认，待审阅 · 日期：2026-10-10
> 包名已确认为 dsh-tally（npm 上的 `dsh-ledger` 已被他人占用）。服务名统一加 `tally` 前缀，遵循官方“自有服务需加辨识前缀”的命名要求。
> 依据：[生态调研](../../../research/deepseek-harness-ecosystem.md)、[缺口分析](../../../research/gap-analysis/README.md)

## 1. 背景与目标

**目标**：为 DeepSeek Harness（dsh）开发一个插件，让它成为生态里“不可缺少的一环”。这里“不可缺少”的意思是：其他插件依赖它，用户默认会装它，官方短期内也不会把它的价值收编掉。

**选定方向**：做用量、计价、余额的**共享数据层**，也就是 dsh 生态里管“钱”的那一层底座。

**为什么选这个方向**（详细数据见缺口分析）：
- 和用量相关的插件约有 332 个，各自维护价格表、各自解析会话日志、各自保存 API key，统计口径互不一致。**作为功能，这个方向非常拥挤；但作为共享层，它是空的**：整个类别只有 1 条依赖边，没有任何一个插件把自己定位成给别人用的服务。
- 官方在会话日志里提供了精确的、由厂商上报的用量数据，`token-meter` 能给出单个会话的 token 数。但官方**没有价格数据、费用账本，也没有多厂商余额**。
- 多家厂商价格的维护（峰谷价、缓存档位、调价历史）是长期的脏活，官方不太可能替其他厂商的模型做这件事，所以被收编的风险低。

**已比较并否决的方向**：插件安全（共享层已被 dsh-trust-check 占据，安装闸门至少有 6 个同类）、兼容层（检测和把关已有 plugin-radar、precheck、gating-hub）、通知中枢（同样需要其他作者接入，需求却更弱）、插件市场（官方已提出 `plugin-market-index-format` 提案）、侧边栏这类 UI 底座（官方已经收编）。

**已知的核心风险**：方案能否成功，取决于挂件作者愿不愿意依赖我们。经过讨论，决定**不设前置验证阶段，直接完整开发**。作为对冲，设计上有一条硬性要求：**即使没有任何作者接入，自带的界面也要足以单独吸引用户**。

## 2. 成功标准

| 维度 | 标准 |
|---|---|
| 准确性 | 和 DeepSeek 控制台账单按天对账，差异不超过 1%；超出部分必须能逐项解释，比如价格数据缺失或厂商没有上报用量 |
| 口径一致 | 同一轮对话里，按计费尝试累加的 token 数，等于官方 `deriveTurnTokenUsage` 的结果（由测试保证） |
| 兼容 | 在 dsh 的 `latest` 和 `alpha` 两个通道上 CI 全部通过；dsh 发布新版本后 7 天内跟进 |
| 自身可信度 | 四个核心包用 dsh-trust-check 扫描，不出现红线 |
| 生态采用（目标，不作为开发门槛） | 发布后 6 个月内，至少 5 个第三方插件依赖 `dsh-tally-api` 或 `dsh-pricing-data` |

## 3. 非目标

- 不进入模型请求的路径：不改请求、不拦截请求、不路由模型，也不替用户切换模型。
- 不做汇率换算：价格按原币保存，原币是人民币就存人民币，是美元就存美元。
- v1 不在运行时联网拉取价格数据（价格随包发布）。
- 预算功能只提醒，不拦截。
- v1 只为 DeepSeek 做完整的余额查询，其他厂商只提供价格和金额换算。
- 不做萌系或皮肤类界面，这个空间留给挂件作者在我们的服务之上去做。

## 4. 架构

按官方的“seam 三角色”拆包（Service Definition / Provider / Consumer），共 5 个包，放在本仓库的 pnpm monorepo 中：

| 包 | 角色 | 依赖 | 读凭据 | 联网 |
|---|---|---|---|---|
| `dsh-pricing-data` | 价格数据和纯函数 `quote()` | 无（不依赖 dsh） | 否 | 否 |
| `dsh-tally-api` | Service Definition：只有类型和事件声明，运行时代码为零 | `@deepseek-ai/cordis`（peer，只用类型） | 否 | 否 |
| `dsh-tally` | Service Provider：`ctx.tallyPricing`、`ctx.tallyUsage`、`ctx.tallyBalance` 的注册表，以及 `ctx.tallyBudget` 和 Remote API | api、pricing-data、官方 session、session-query、token-meter、home-paths；存储使用 Node 内置的 `node:sqlite` | 否 | 否 |
| `dsh-tally-ui` | Consumer：参考界面 | api，以及 `dsh-tally/remote` 的接口描述（打包时内联；只通过公开接口调用） | 否 | 只访问同源接口 |
| `dsh-tally-balance-deepseek` | 余额提供方 | api | 是 | 是，只访问 DeepSeek 官方域名 |

```text
会话日志 ──(session/event 实时 + sessionQuery 回放)──▶ dsh-tally ──▶ 账本存储（$DSH_HOME/tally/tally.v1.sqlite）
                                                     │  ▲
                                 dsh-pricing-data ───┘  │ ctx.tallyBalance.register
                                                         │
                                    dsh-tally-balance-deepseek（凭据只在这里读取）

dsh-tally-api（类型）◀── 第三方挂件、dsh-tally-ui 依赖
dsh-tally ──Remote API `tally` 命名空间──▶ 浏览器端（dsh-tally-ui、第三方界面插件）
```

**依赖约定**：
- 需要和宿主共享实例的 dsh 包，同时声明在 `peerDependencies` 和 `devDependencies` 中；
- dsh 版本范围声明为 `>=0.2.0-0 <0.3.0-0`。

## 5. 组件设计

### 5.1 价格数据 `dsh-pricing-data`

**原则**：
1. **保留价格历史**：每个价格版本都有 `effectiveFrom` 和 `effectiveTo`，按请求发生的时间匹配价格版本。
2. **计价维度和官方 `TokenUsage` 一一对应**：未缓存输入、缓存读、缓存写、输出。推理 token 是否按输出计费，由每个厂商规则里的 `reasoningBilledAs` 决定。
3. **峰谷时段规则带时区**，例如 `Asia/Shanghai`。
4. **保留原币，不做汇率换算。**
5. **查不到价格就返回 `null`，永远不返回 0。**
6. **每条价格可追溯**：附带来源链接和抓取时间。

```ts
interface PriceCatalog {
  schemaVersion: 1
  generatedAt: string
  providers: Record<string, {
    currency: 'CNY' | 'USD'
    unit: 'per_million_tokens'
    reasoningBilledAs: 'output' | 'separate' | 'free'
    models: Record<string, PriceVersion[]>     // 按 effectiveFrom 升序排列
    aliases?: Record<string, string>
  }>
  holidays: Record<string, { years: Record<string, { dates: string[]; source: { url: string; retrievedAt: string; note?: string } }> }>
}
interface PriceVersion {
  id: string                                   // 稳定的价格版本 id，账本里存的就是它
  effectiveFrom: string
  effectiveTo?: string
  windows?: {
    tz: string                                 // 'Asia/Shanghai'
    peak: string[]                             // ['09:00-12:00', '14:00-18:00']，左闭右开
    days: number[]                             // 高峰规则生效的星期，ISO 编号（1 为周一）；DeepSeek 为 [1,2,3,4,5]
    excludeHolidays?: string                   // 节假日日历 id，例如 'CN'：日历中的日期全天按空闲价
  }
  rates: { [band in 'flat' | 'peak' | 'offpeak']?: { input: string; cacheRead?: string; cacheWrite?: string; output: string } }
  tiers?: { minInputTokens: number; multiplier: string }[]
  source: { url: string; retrievedAt: string; note?: string }
}
function quote(catalog: PriceCatalog, q: { provider: string; model: string; usage: TokenUsage; at: number }): Quote | null
interface Quote {
  amount: string                               // 合计，十进制字符串
  currency: 'CNY' | 'USD'
  band: 'peak' | 'offpeak' | 'flat'
  breakdown: { input: string; cacheRead: string; cacheWrite: string; output: string; reasoning: string }  // 各项金额，未计费的项为 '0'
  priceVersion: string                         // PriceVersion.id
  holidayCalendarMissing?: true                // 请求日期所在年份的节假日日历缺失，报价可能偏高
}
```

- **节假日日历**：存在 `PriceCatalog.holidays` 中，按日历 id 和年份维护，日期格式为 `YYYY-MM-DD`（以价格规则里的 `tz` 为准）。中国日历以国务院办公厅发布的放假通知为准，只收录放假日期。调休上班日如果落在周末，按 DeepSeek 原文“周一至周五”的字面意思处理，即仍属于空闲时段。**某年的日历尚未录入时，那一年工作日的报价会标记为 `holidayCalendarMissing`，界面上提示“节假日日历未覆盖，可能高估”。**
- **价格历史缺失**：早于第一个已核实价格版本的请求，返回 `null`，界面显示“未定价（价格历史未录入）”，不用当前价格去推算。
- **DeepSeek 首批数据**（来源：官方“模型 & 价格”页，用户于 2026-10-10 提供截图，核实日期 2026-10-10，单位为人民币/百万 tokens，格式为空闲价/高峰价）：
  - `deepseek-flash`（V4.1-Flash）：缓存命中输入 0.02/0.04，未命中输入 1/2，输出 4/8；
  - `deepseek-v4-pro`（V4-Pro-0813）：缓存命中输入 0.15/0.30，未命中输入 4.5/9.0，输出 13.5/27.0；
  - 别名：`deepseek-v4-flash` 和 `deepseek-v4-flash-vision-exp` 都指向 `deepseek-flash`；
  - 官方页面没有给出生效日期，所以 `effectiveFrom` 暂记为核实日期，等拿到调价公告后再往前补历史版本。
- **金额计算一律使用十进制字符串和定点运算，不使用浮点数。** 单价也存成字符串。
- 用户自定义的厂商价格映射（比如“这个 provider 按 deepseek 官方价计”或手填单价）保存在 `dsh-tally` 的设置里，**不写进数据包**。用户的覆盖配置优先级最高。
- **数据维护**：定时 CI 抓取各厂商官方价格页，与数据包比对，发现差异就开 issue；改价必须走 PR 并附上来源，合并后自动发布新版本。
- **DeepSeek 的价格数值必须先对照官方价格页核实再录入。** 第三方文章给出的价格互相矛盾，不能作为录入依据。

### 5.2 账本 `ctx.tallyUsage`（属于 `dsh-tally`）

**原则**：会话日志是唯一的事实来源，账本只是派生出来的索引，可以随时从日志完整重建。账本只读日志，不进入模型请求的路径。

**数据来源**：
- 实时：监听 `session/event`，读取 `assistant/message` 和 `assistant/attempt` 中的 `TokenUsage`，从 `request/header`（`config` 里的 provider 和 model）和 `request/context` 获取厂商与模型，事件自带的 `time` 字段用来判断峰谷时段。
- 历史：用 `ctx.sessionQuery.listSessions()` 和 `listEvents()` 回放。

**计量单位**：一次计费尝试。幂等键是 `(sessionId, 事件 seq)`。

**厂商与模型的识别**：优先使用 `assistant/message` 中 `message.source` 记录的 provider 和 model；对于以 `assistant/attempt` 或 `llm/retry` 结束的尝试，使用最近一次 `request/header` 里 `header.config` 记录的 provider 和 model。官方 DeepSeek 在日志里有两个路由 id：`deepseek-official`（API key 登录）和 `deepseek-account`（账号登录）。`dsh-tally` 的默认配置 `providerRoutes` 会把这两个 id 都映射到价格数据里的 `deepseek`，用户可以在配置里添加其他映射。

**计费时间**：取每次尝试开始时的事件时间，即 `step/start` 或 `llm/retry-started` 的 `time`。DeepSeek 文档没有说明按请求开始还是结束计时，这一点通过对账验证。

**用量是否“已知”**：判定规则与官方 `token-meter` 的 `normalizeUsage` 完全一致（计数非负且为安全整数；未提供 `totalTokens` 时，缓存读和缓存写都必须上报）。不满足的记为 `usageKnown: false`。

**分叉前缀**：事件的 `seq` 等于它在日志中的位置，所以 `seq < inheritedEventCount` 的事件属于从父会话继承的部分，不记账。实时路径从 `Session.inheritedEventCount` 读取这个值，回放路径从 `sessionQuery.readSession()` 返回的 `inheritedEventCount` 读取。
- 重试的口径照搬官方：同一次尝试里，最终的 assistant 消息样本替换流式阶段的用量；`llm/retry-started` 之后算作新的一次计费。
- 用测试锁定口径：同一轮对话里，按尝试累加的结果必须等于 `deriveTurnTokenUsage`（来自 `@deepseek-ai/dsh-token-meter/client`）。

**四个特殊情况**：
1. 分叉会话：根据 `parentSession` 和 `seedLength`，跳过从父会话复制过来的前缀事件。
2. 子代理会话（`header.origin === 'subagent'`）：照常计费，沿 `header.parentSession` 向上追溯，归到最近的非子代理祖先名下（`rootSessionId`）。分叉会话的 `rootSessionId` 是它自己。
3. 已删除的会话：账目保留，标记为已删除，汇总金额不减少。
4. 厂商没有上报用量：记为“用量未知”。`token-meter` 的估算值只作为单独的参考列，不进入金额合计。

**存储**：使用 Node 内置的 `node:sqlite`，数据库文件为 `$DSH_HOME/tally/tally.v1.sqlite`，路径由官方 `dsh-home-paths` 解析。不使用 `ctx.storageDomain` 的原因：它是 KV 存储，无法做汇总查询，而且第三方领域需要在配置组合里额外加路由。账本是可以重建的派生索引，数据库 schema 版本记录在 `PRAGMA user_version` 中，版本不一致时直接删库并从日志重建。v1 只存逐条账目，不做预汇总：峰谷价按每次请求的时间计算，按天预汇总会丢失计价所需的时间精度。查询时逐条报价，性能目标是 10 万条账目的查询在 1 秒内完成，超标时再引入按“天 × 时段 × 厂商 × 模型”的汇总表。**金额和价格版本都不写入存储**，只保存 token 数、厂商路由和计费时间，查询时现算。这样价格数据被修正后，历史金额会自动更正。

**首次安装时的回填**：在后台分批回放全部历史会话，并报告进度；回填期间实时记账照常进行，两者通过幂等键自然合并。

### 5.3 接口包 `dsh-tally-api`

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { tallyPricing: PricingService; tallyUsage: UsageService; tallyBalance: BalanceService; tallyBudget: BudgetService }
  interface Events {
    'tally/recorded'(entry: TallyEntry): void
    'tally/balance-changed'(snap: BalanceSnapshot): void
    'tally/budget-crossed'(alert: BudgetAlert): void
  }
}
interface Money { amount: string; currency: 'CNY' | 'USD' }
interface TallyEntry {
  id: string; sessionId: string; rootSessionId: string; workspaceId?: string; at: number
  provider: string; model: string; band: 'peak' | 'offpeak' | 'flat' | null
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning?: number }
  cost: Money | null; priceVersion: string | null; usageKnown: boolean
}
interface UsageService {
  query(q: {
    from: number; to: number                          // 毫秒时间戳，左闭右开
    groupBy: 'day' | 'model' | 'provider' | 'workspace' | 'session'
    filter?: { provider?: string; model?: string; workspaceId?: string; rootSessionId?: string; band?: 'peak' | 'offpeak' | 'flat' }
    tz?: string                                       // 按天分组时使用的时区，默认取宿主时区
  }): Promise<UsageGroup[]>
  session(sessionId: string): Promise<SessionUsage>   // 包含子代理明细
  rebuild(): Promise<void>
  status(): TallyStatus
}
interface UsageGroup {
  key: string
  tokens: TallyEntry['tokens']
  cost: Money[]                                       // 按币种分开，不做换算
  requestCount: number; unpricedCount: number; unknownUsageCount: number
}
interface SessionUsage { sessionId: string; total: UsageGroup; children: { sessionId: string; total: UsageGroup }[] }
interface TallyStatus { backfill: { done: number; total: number } | null; errors: { sessionId?: string; message: string }[] }
interface PricingService {
  quote(q: { provider: string; model: string; usage: TokenUsage; at: number }): Quote | null   // 已叠加用户的覆盖配置
  catalogVersion(): string
  overrides(): ProviderPriceOverride[]
}
type ProviderPriceOverride =
  | { provider: string; kind: 'alias'; target: { provider: string; model?: string } }   // 按某个已知厂商或模型的价格计
  | { provider: string; kind: 'manual'; currency: 'CNY' | 'USD'; models: Record<string, PriceVersion['rates']['flat']> }
interface BalanceService { get(provider: string): Promise<BalanceSnapshot | null>; refresh(provider: string): Promise<BalanceSnapshot | null>; register(provider: string, fetcher: BalanceFetcher): () => void }
interface BalanceSnapshot { provider: string; wallets: Wallet[]; fetchedAt: number; stale: boolean; error?: string }
interface Wallet { kind: 'topup' | 'granted' | 'total'; money: Money }   // DeepSeek：赠送余额（granted）优先于充值余额（topup）扣减
interface BudgetService { list(): Budget[]; set(b: Budget): void; remove(id: string): void }
interface Budget { id: string; period: 'day' | 'month'; scope: { workspaceId?: string }; limit: Money }
interface BudgetAlert { budgetId: string; threshold: 0.8 | 1; spent: Money; limit: Money; periodStart: number }
type BalanceFetcher = (signal: AbortSignal) => Promise<Wallet[]>
```

`workspaceId` 取自会话元数据（`sessionQuery.listSessions()` 返回的工作区或目录）。缺失时为 `undefined`，按工作区分组时归入“未知工作区”。

- 浏览器端通过 Remote API 的 `tally` 命名空间使用同样的能力：`query`、`session`、`balance`、`status`，以及订阅 `recorded` 和 `balance-changed` 事件。
  - **实现方式（2026-10-11 核实 dsh 0.2.0-rc.2 后确定）**：Host 端是 `dsh-tally` 里的一个 `TypertRemoteService`（命名空间 `tally`）。官方的 `ctx.remote.$on` 只转发一份写死在 dsh 里的事件白名单，第三方无法加入，所以事件改为一个流式方法 `watch`：先推一帧当前状态，之后推 `recorded`、`balance-changed`、`budget-crossed` 三类帧；断线重连后客户端重新拉取，不依赖重放。
  - 浏览器端调用需要一份带严格编解码器的接口描述（`TypertRemoteContribution`）。官方用构建期生成器产出这份描述，但生成器依赖 dsh 仓库内部的工作区结构，所以 `dsh-tally` 手写这份描述（用 zod），通过子路径 `dsh-tally/remote` 导出；第三方界面插件和 `dsh-tally-ui` 都从这里引入，再用 `ctx.remote.$mount()` 挂载。Host 端用同一套 zod schema 校验请求参数。
- **版本承诺**：严格遵守 semver，只做加法。破坏性修改必须升主版本，并且旧主版本继续维护 6 个月。这条承诺写进 README。

### 5.4 余额 `ctx.tallyBalance` 与 `dsh-tally-balance-deepseek`

- `dsh-tally` 只提供注册表、缓存和刷新策略，**本身不读任何凭据**。
- `dsh-tally-balance-deepseek` 注册 `deepseek` 提供方：
  - API key 用户：读取官方 DeepSeek 适配器正在使用的凭据引用（不另存 key），调用 DeepSeek 的余额查询接口；
  - 账号登录用户：调用官方 `account-controller` 的 `getBalance`，不接触 token。
- 不提供单独填写 key 的入口。如果用户还没在官方设置里配置 DeepSeek，界面会提示他先去配置。
- **刷新策略**：用户主动刷新时立即查询；每轮对话结束后去抖刷新；两次查询至少间隔 60 秒；进程内缓存结果。
- **查询失败绝不显示 0**：返回上一次成功的快照，标记 `stale: true` 并带上 `error`。
- 其他厂商的余额由社区通过 `register` 补充。
- **余额按路由 id 区分**：`get(provider)` 和 `register(provider, …)` 里的 `provider` 是路由 id（例如 `deepseek-official`、`deepseek-account`），与 `quote()` 的约定一致。API key 和账号登录可能对应两个不同的账户，所以分开查询，不合并。
- **API key 方式的接口**：`GET {baseURL}/user/balance`，请求头 `Authorization: Bearer <key>`，返回 `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }`（与社区余额插件的实际调用一致）。`baseURL` 默认为 `https://api.deepseek.com`，key 通过 `ctx.credentials.resolve('DEEPSEEK_API_KEY')` 读取，引用名与官方适配器的 `apiKeyEnv` 相同，两者都可以配置。
- **账号方式**：调用 `ctx.deepseekAccount.getBalance(client)`，结果中 `normal_wallets` 映射为 `topup`，`bonus_wallets` 映射为 `granted`，`total` 按币种求和。金额字符串可能带指数写法（如 `0E-16`），需要先规范化成十进制字符串。
- **刷新触发**：某个路由有新的实时记账后，等 3 秒再刷新该路由的余额（去抖），同一路由两次刷新至少间隔 60 秒；用户手动刷新时立即查询，但同一时刻对同一路由只发出一个请求。

### 5.5 预算 `ctx.tallyBudget`

- 预算有两个维度：周期（按日或按月）和范围（全局或某个工作区），金额是某一币种下的阈值。
- 达到 80% 和 100% 时各触发一次 `tally/budget-crossed`，界面弹出提示。
- 只提醒，不拦截。需要拦截的话，可以由其他插件监听这个事件来实现。
- **预算单独存储**：预算存放在 `$DSH_HOME/tally/budgets.json`（原子写入），不放进账本数据库，因为账本可以随时删除重建。每个预算周期内，80% 和 100% 两个阈值各只提醒一次；已提醒的状态也记在这个文件里。
- **周期与时区**：按日或按月的周期边界使用插件配置的 `timeZone`，默认取宿主时区。只累计与预算同币种的费用，其他币种的费用不计入。
- **触发时机**：每当有新的实时账目时检查一次；回填和重建不触发提醒。

### 5.6 参考界面 `dsh-tally-ui`

所有元素都挂在官方 slot 上，每个元素都可以在设置里单独关闭：

> 2026-10-11 修订：核实 dsh 0.2.0-rc.2 后发现，`conversation.composer.bar` 是只能放一个元素的 slot，占用它会替换掉整个官方输入框。费用条因此改挂在 `conversation.composer.dock`（输入框下方的列表 slot）。预算提醒的弹窗挂在 `shell.overlay`，使用官方 `Toast` 组件。

| slot | 内容 |
|---|---|
| `conversation.composer.dock` | 本会话费用 · 今日费用 · 余额 · 当前时段（高峰或空闲）及距离下一次切换的倒计时 |
| `shell.overlay` | 预算达到 80% 或 100% 时的提示（`Toast`） |
| `conversation.chat.turnTail` | 这一轮的费用；悬停显示明细：输入、缓存命中、输出、命中率、重试次数、价格版本（可以点开查看来源） |
| `conversation.session.header.utilities` | 会话累计费用（包含子代理），可以展开查看 |
| `sidebar.right.pane.tab` | 用量看板：时间范围选择；按天的柱状图（高峰和空闲分色叠加）；按模型、工作区、会话排行；缓存命中率趋势；以事实形式给出的峰谷节省提示；导出 CSV；“未定价”请求的数量和处理入口 |
| `settings.section` | 价格数据版本和来源；自定义厂商的价格映射；预算；显示位置开关；重建账本按钮和进度 |

- 使用官方 `ui-primitives`，自动适配深浅色模式；图表是手写的轻量 SVG；文案提供中英文，走 `client-locale` 机制（语言 id 为 `zh` 和 `en`）。
- 浏览器代码按 dsh 的客户端模块格式预先打包（`window.__ModuleLoader__.load`），只允许从宿主共享模块表引入 `react`、`react-dom`、`@deepseek-ai/cordis` 和官方 `client-ui-*` 包，其余全部内联。各元素的开关和价格覆盖配置都声明为 `volatile` 配置项，设置页通过官方 `ctx.configForms` 读写，写入当前 profile 的 `cordis.patch.yml`。
- 界面只调用 `dsh-tally-api` 的公开接口。

## 6. 错误处理

| 情况 | 行为 |
|---|---|
| 找不到价格 | `cost: null`，界面显示“未定价”，并在设置页提供映射入口 |
| 厂商没有上报用量 | `usageKnown: false`，不计入金额；估算值只作为参考列 |
| 余额查询失败 | 返回上一次成功的快照并标记 `stale`，同时带上错误信息，不显示 0 |
| 会话日志无法读取或格式不支持 | 跳过这个会话，记入 `status().errors`，在设置页列出；其他会话不受影响 |
| 存储损坏 | 提示用户重建；因为账本可以从日志完整重建，所以不会丢失信息 |
| 遇到未知的会话事件类型 | 忽略它，不中断记账（向前兼容） |
| dsh 版本超出声明范围 | 由官方的版本检查拦下；我们的兼容矩阵 CI 会提前发现 |

## 7. 测试

| 层 | 内容 |
|---|---|
| 价格数据 | 所有价格条目通过 schema 校验；`quote()` 覆盖峰谷边界时刻、时区、调价生效时刻、`null` 情况和十进制精度 |
| 账本 | 用日志夹具覆盖重试、分叉、子代理、缺少用量、已删除会话；性质测试：幂等（回放两遍结果一致）、增量记账等于全量重建、按尝试累加等于 `deriveTurnTokenUsage` |
| 集成 | 用官方 `test-support` 的 testkit 把 bundle 加载进真实插件树，跑冒烟测试 |
| 兼容矩阵 | CI 在 dsh 的 `latest` 和 `alpha` 两个通道上运行；dsh 发布新版本时自动触发 |
| 界面 | 组件测试；用 Playwright 在真实的 dsh web 里截图验证 5 个挂载位置 |
| 自检 | CI 中对四个核心包运行 dsh-trust-check，断言没有红线 |

## 8. 对账

- 提供命令行工具 `dsh-tally reconcile --bill <账单导出文件>`，按天和模型对比我们算出的金额与账单金额，输出差异报告。账单解析器做成可插拔的。
- 对账方法和误差说明写进 README；用真实账号长期对账并公开结果。

## 9. 发布与推广

- 用 changesets 管理版本，发布到 npm；提交到 awesome-dsh-plugin 和 dsh-market。
- README 中贴出 dsh-trust-check 对五个包的扫描结果，并说明为什么 balance-deepseek 这个包有红线、它的代码范围有多大。
- 给小鲸鱼余额挂件（MeteorNOX/DeepSeek-Balance-Whale-Widget）、dsh-cost-meter、dsh-token-usage-stats 提接入 PR。PR 保证兼容：没有安装 `dsh-tally` 时，挂件照旧使用原来的逻辑。
- `dsh-pricing-data` 同时作为独立的数据包推广给其他 agent 生态的用量工具。

## 10. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| M1 | monorepo 骨架、`dsh-pricing-data` 和 `quote()` | DeepSeek 价格已对照官方页面核实并录入，测试全部通过 |
| M2 | `dsh-tally-api` 和账本核心（记账、存储、回填、查询、Remote API） | 口径、幂等、重建一致性三类测试通过；在真实 dsh 中完成冒烟测试 |
| M3 | 余额提供方和预算 | 在真实账号上能查到余额，预算提醒能触发 |
| M4 | `dsh-tally-ui` | 5 个挂载位置在真实 dsh web 中验证通过 |
| M5 | 对账工具、文档、发布、接入 PR | 已发布到 npm，已收录进 awesome 列表，至少提交 3 个接入 PR |

## 11. 外部依赖与未决事项

| 事项 | 影响 | 解决方式 |
|---|---|---|
| DeepSeek 当前价格 | 已解决 | 用户于 2026-10-10 提供了官方价格页截图，已录入第 5.1 节 |
| DeepSeek 历史价格的生效日期 | 早于核实日期的请求显示为“未定价” | 提供带日期的官方调价公告后补录 |
| 中国法定节假日日历（2026 年起） | 节假日当天的报价准确性 | 依据国务院办公厅放假通知录入并注明来源；缺失的年份按 5.1 节的方式标记 |
| DeepSeek 余额查询接口的确切路径和返回格式 | M3 | 同上，放行后核实官方 API 文档 |
| DeepSeek 控制台账单导出的格式 | 对账解析器（M5） | 由用户提供一份导出样例 |
| 正式包名 | 发布（M5） | 发布前确定，并先确认 npm 上没有被占用 |

## 12. 风险

| 风险 | 应对 |
|---|---|
| 挂件作者不接入 | 自带界面要单独具备竞争力；接入 PR 保证兼容；`dsh-pricing-data` 的接入门槛最低，只需改一行 import |
| 官方推出 DeepSeek 自家的费用展示 | 把官方数据接进来作为其中一个数据源；多厂商价格、跨会话账本和预算仍然是我们独有的 |
| 价格数据出错，损害信任 | 每条价格附带来源和生效日期；界面注明“估算值，以账单为准”；提供公开的对账工具 |
| dsh 的破坏性升级 | 兼容矩阵 CI 在每次 dsh 发版时自动运行；只依赖已文档化的公开接口（Service Definition、事件、slot） |

## 附录：设计所依据的官方事实（`deepseek-ai/deepseek-harness@d743267`）

- `packages/llm/llm/src/types.ts`：`TokenUsage` 的各个计数互不重叠（未缓存输入、输出、缓存读、缓存写、推理）。
- `packages/core/session/src/types.ts`：`request/header.header.config` 中包含 provider 和 model；`RequestContext` 记录 provider、model 和 contextWindow；每条事件都有 `time` 字段。
- `packages/llm/token-meter`：提供 `tokenUsage` 投影（按会话）和 `deriveTurnTokenUsage`（从 `./client` 导出，给出按轮的精确汇总，含 routes）；没有价格数据。
- `packages/session-query/session-query`：提供 `listSessions()`、`listEvents()`、`filterEvents()`。
- `packages/api/account-controller`：提供 `getBalance`（仅限账号登录）。
- `packages/storage`：`ctx.storage` 支持 JSON 和 SQLite 两种后端；`storage-domain` 在其上提供带 schema 校验的 KV，不支持汇总查询，所以没有采用。官方的 `storage-sqlite` 和 `session-query-sqlite` 本身也使用 `node:sqlite`。
- `packages/session-query/session-query`：`readSession(id)` 返回 `{ session: SessionHeader, inheritedEventCount, events }`。
- `packages/core/session/src/index.ts`：`seq` 按 `log.length` 分配；实时 `Session` 对象提供 `header` 和 `inheritedEventCount`；`session/event` 的监听签名为 `(session, event)`。
- `packages/subagent/subagent/src/child-agent.ts`：子代理会话的 `header.parentSession` 是父会话 id，`header.origin` 为 `'subagent'`。
- `packages/llm/llm-deepseek-api-key` 和 `llm-deepseek-account`：路由 id 分别为 `deepseek-official` 和 `deepseek-account`，默认模型为 `deepseek-flash`。
- `docs/cookbook/adding-a-remote-api.zh.md`：`TypertRemoteService` 加 `@Remote` 的写法。
- 客户端 slot：`conversation.composer.bar`、`conversation.chat.turnTail`、`conversation.session.header.utilities`、`sidebar.right.pane.tab`、`settings.section`。
- `packages/boot/plugin-manager`：安装前检查 DSH peer 兼容性，不兼容即拒装；支持按“插件版本 + dsh 版本”添加豁免。
