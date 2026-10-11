# dsh-tally

DeepSeek Harness（dsh）的记账插件：从会话日志里读出每一次计费请求的 token 用量，存成一本本地账本，按官方价目现算金额。

- **会话日志是唯一的事实来源**。账本只是派生出来的索引，随时可以从日志完整重建。
- **不进入模型请求路径**。插件只监听 `session/event`，不监听任何 waterfall 事件，也不调用 `agent.inject()`。
- 提供的服务：`ctx.tallyPricing`（报价）、`ctx.tallyUsage`（账本查询）、`ctx.tallyBalance`（余额）和 `ctx.tallyBudget`（预算）。接口定义在 [`dsh-tally-api`](../tally-api/README.md)。
- 浏览器端通过 Remote 命名空间 `tally` 访问同样的数据，见下文 [Remote API](#remote-api)。

## 安装

```sh
dsh plugin --profile web add dsh-tally
```

插件需要 Node.js `>=22.19.0`（使用内置的 `node:sqlite`）。

回填在后台进行，不阻塞 dsh 启动，回填期间实时记账照常进行：

- **安装后第一次启动**：分批读取全部历史会话，完成后在账本里记下“回填已完成”。
- **之后每次启动**：只读取账本里还没有记录的会话（例如插件停用期间新建的会话、上次读取失败的会话），以及上次停在某一轮对话中间的会话；已经完整记账的会话不再读取。
- 回填进度和出错的会话可以通过 `ctx.tallyUsage.status()` 查看。
- 限制：如果另一个 dsh 进程在一个已经完整记账的会话里继续对话，本进程要等这个会话在本进程里再次产生事件、或执行 `rebuild()` 之后才会补记。
- 限制：同理，如果在本机停用了插件、或者用没有加载本插件的 profile 继续了一个已经完整记账的会话，这段对话会少记，直到这个会话在加载了插件的 dsh 里再次产生事件、或执行 `rebuild()` 之后才会补记。

## 配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `providerRoutes` | `{ "deepseek-official": "deepseek", "deepseek-account": "deepseek" }` | 会话日志里的路由 id 到价格数据厂商的映射。官方 DeepSeek 在日志里有两个路由 id：`deepseek-official`（API key 登录）和 `deepseek-account`（账号登录）。没有映射的路由按同名厂商查价格。 |
| `overrides` | `[]` | 厂商价格覆盖，见下文。可以在设置页修改，改动立即生效，插件不重新加载。 |
| `dbPath` | `$DSH_HOME/tally/tally.v1.sqlite` | 账本数据库文件。未设置 `DSH_HOME` 时为 `~/.dsh/tally/tally.v1.sqlite`。 |
| `backfillBatch` | `20` | 回填时每批同时读取的会话数。 |
| `balanceDebounceMs` | `3000` | 记账后刷新余额前的去抖时间（毫秒）。 |
| `balanceMinIntervalMs` | `60000` | 同一路由两次自动刷新余额之间的最小间隔（毫秒）。 |
| `balanceTimeoutMs` | `10000` | 余额请求的超时时间（毫秒），超时后请求被中止。 |
| `budgetPath` | `$DSH_HOME/tally/budgets.json` | 预算文件，同时保存已提醒的阈值。未设置 `DSH_HOME` 时为 `~/.dsh/tally/budgets.json`。 |
| `timeZone` | 宿主时区 | 预算按日、按月统计时使用的 IANA 时区，例如 `Asia/Shanghai`。 |

### 价格覆盖

自建网关或第三方转发的路由不在价格数据里，可以用 `overrides` 指定价格。同一个路由只有第一条覆盖生效。

按某个已知厂商（及可选的模型）的价格计：

```yaml
overrides:
  - provider: my-gateway
    kind: alias
    target:
      provider: deepseek
      model: deepseek-flash   # 可选，省略时沿用日志里的模型名
```

手动填写单价（每百万 token，十进制字符串）：

```yaml
overrides:
  - provider: my-gateway
    kind: manual
    currency: CNY
    models:
      my-model:
        input: "2"
        cacheRead: "0.5"     # 可选
        cacheWrite: "2"      # 可选
        output: "8"
```

手动价格没有峰谷之分（`band` 为 `flat`），推理 token 计入输出。某个维度没有填单价却用到了 token 时，这条记录视为“无价格”（`cost: null`），不会按 0 计。

单价写错（例如不是合法的十进制数）、或者别名指向的厂商或模型不在价格数据里的覆盖会被跳过：插件照常运行，日志里输出一条警告，`ctx.tallyUsage.status().errors` 里也会列出这条覆盖对应的厂商。

`overrides` 是可在设置页直接编辑的配置项（volatile）：保存后价格规则在原地重建，插件不重新加载。因为金额是查询时现算的，修改后所有查询（包括历史账目）立即按新规则计价，不需要重建账本；Remote 的 `status` 和 `catalog` 也随之更新，打开着的 `watch` 流会收到一条新的 `hello`，提示界面重新读取数据。

## 记账口径

- **计量单位是一次计费尝试**。幂等键是 `(会话 id, 结算事件的 seq)`，同一条记录不会被记两次。
- **用量规则与官方 `token-meter` 一致**：同一次尝试里，最终的 assistant 消息用量替换流式阶段的用量；`llm/retry-started` 之后算作新的一次计费，所以失败重试的请求也会计费。
- **厂商与模型**：优先取 `assistant/message` 里记录的 provider 和 model；以 `assistant/attempt` 或 `llm/retry` 结束的尝试，取最近一次 `request/header` 里的配置。
- **计费时间**取尝试开始时的事件时间（`step/start` 或 `llm/retry-started`），据此判断峰谷时段。
- **用量未知**：厂商没有上报用量、或上报的用量不满足官方校验规则时，记为 `usageKnown: false`，不计金额，在汇总里计入 `unknownUsageCount`。
- **分叉会话**：从父会话继承来的前缀事件不记账，只记分叉之后自己的部分。
- **子代理会话**照常计费，归到最近的非子代理祖先名下（`rootSessionId`）。分叉会话的 `rootSessionId` 是它自己。
- **金额不入库**。账本只存 token 数、路由、模型和计费时间，查询时按当前价格数据现算，所以价格数据被修正后，历史金额会自动更正。
- **金额一律是十进制字符串**，内部用 BigInt 定点运算，不使用浮点数。不同币种分开统计，不做换算。查不到价格时返回 `null`，永远不会当作 `"0"`。
- **重建**：`ctx.tallyUsage.rebuild()` 清空账本（包括“回填已完成”标记）后从全部会话日志重新回填。数据库 schema 版本不一致时也会自动删库重建。
- **未结束的对话**：读取一个停在对话中间的会话时，会话查询服务会在日志末尾补上表示“中断”的结束事件，方便展示。账本不记录这些补出来的事件，等写入方之后写下真实的结束事件时再继续记账，不会漏记。
- **`tally/recorded` 事件只在实时记账时发出**，即一次请求结算的时候；回填和重建写入的历史账目不发事件，需要历史数据时请用 `query` 或 `session` 查询。

- **已删除的会话**：dsh 没有“会话已删除”事件，所以每次回填扫描（包括启动时的增量扫描）在列出会话之后，把账本里有账目、但已不在会话列表中的会话标记为已删除；之后重新出现在列表里的会话会清除标记。只有当列表里至少有一个已持久化的会话时才做这项比对，避免持久化服务不可用时把所有会话都误标为删除；正在运行的会话不会被标记。删除标记**不影响任何金额**：账目保留，汇总照常计入。按会话分组查询（`groupBy: 'session'`）时，每组的 `deletedCount` 给出其中属于已删除会话的账目数。

## 余额

`ctx.tallyBalance` 是各路由余额查询函数的注册表，本身不读取凭据、也不发起网络请求；查询函数由厂商插件（例如 `dsh-tally-balance-deepseek`）通过 `register(route, fetcher)` 注册。`route` 是会话日志里的路由 id，例如 `deepseek-official`、`deepseek-account`。

- `get(route)` 返回缓存的快照，没有缓存时先查询一次；没有注册查询函数的路由返回 `null`。
- `refresh(route)` 立即查询，不受自动刷新间隔限制；同一路由同时只有一个请求在途。
- 每次实时记账（`tally/recorded`）后，该路由会在去抖时间（`balanceDebounceMs`）后自动刷新一次；同一路由两次自动刷新的起点之间至少间隔 `balanceMinIntervalMs`。
- **查询失败时不会显示 0**：返回上一次成功的快照并标记 `stale: true`，附带 `error` 和 `errorCode`；从未成功过时返回 `wallets: []` 并附带 `error`、`errorCode`。
- **`errorCode`** 取值为 `'not-configured'`（未配置密钥）、`'signed-out'`（账号已退出）、`'timeout'`（超时）、`'failed'`（其他）。fetcher 抛出的异常带有字符串属性 `code`，且取值是这四个之一时照搬；超时一律为 `'timeout'`，其余为 `'failed'`。
- **首次失败后会重试**：`get()` 遇到从未成功过的快照（`wallets` 为空且带 `error`），并且距离上次尝试已超过 `balanceMinIntervalMs` 时，会重新查询，而不是一直返回旧的失败结果。
- 快照内容变化、或标记为过期时发出 `tally/balance-changed` 事件。

## 预算

`ctx.tallyBudget` 管理按日或按月的花费上限，并在花费达到上限的 80% 和 100% 时各提醒一次。

```ts
ctx.tallyBudget.set({
  id: 'daily-cny',
  period: 'day',                       // 'day' 或 'month'
  scope: { workspaceId: 'my-project' }, // 可省略 workspaceId，表示全部工作区
  limit: { amount: '10', currency: 'CNY' },
})
ctx.tallyBudget.list()                 // 返回副本
ctx.tallyBudget.remove('daily-cny')
ctx.tallyBudget.status()               // { errors: string[] }，加载预算文件时的问题；一切正常时 errors 为空数组

ctx.on('tally/budget-crossed', (alert) => {
  // { budgetId, threshold: 0.8 | 1, spent, limit, periodStart }
})
```

- **周期**按 `timeZone` 配置的时区划分自然日或自然月（夏令时当天可能是 23 或 25 小时）。
- **只累计与预算同币种的费用**，不同币种之间不换算。设置了 `scope.workspaceId` 的预算只统计该工作区的花费。
- **每个预算在每个周期内，0.8 和 1 两个阈值各只提醒一次**。一次跳过两个阈值时，先发 0.8 再发 1。比较用 BigInt 定点数精确进行，不使用浮点数。
- 提醒记录与预算一起保存在预算文件里，且先写入再发事件，所以重启不会重复提醒。多个进程共用同一个文件时，只有真正写入该记录的那个进程发事件，不会重复提醒。
- **只有实时记账才会触发检查**：回填和重建写入的历史账目不发 `tally/recorded`，因此不会触发提醒。
- 检查按顺序依次进行；同一个预算、同一个周期内排队的多条记账事件合并为一次检查（每次检查本来就会重新统计整个周期）。某次检查出错只会记一条警告日志，不影响后续检查。
- `set` 会先校验，不合法（例如金额不是大于 0 的十进制字符串）时抛出 `tally: invalid budget: …`，文件保持不变。
- 预算文件损坏时服务以空预算启动，原因见 `status().errors`；文件会在下一次写入时（持有文件锁的情况下）被改名为 `budgets.json.corrupt-<时间戳>`，读取不会动它。
- **预算文件有跨进程锁**：每次写入（`set`、`remove`、记录提醒）都在文件锁（`budgets.json.lock`）内先重新读盘、合并本次修改，再原子替换文件（权限 `0600`）。多个 dsh 进程共用同一个 `$DSH_HOME` 时不会互相覆盖。提醒记录合并时，同一预算取周期更新的一条；周期相同则阈值取并集，已提醒的状态不会被回退。
- 读取（`list` 等）前会比较文件的修改时间和大小，别的进程改过就自动重新加载，不需要重启。
- `set` 和 `remove` 仍是同步方法：修改先进入队列，`list()` 立即可见，文件随后按顺序写入。写入失败（例如等锁超时）时会记一条警告日志，修改从 `list()` 中消失，原因出现在 `status().errors` 里。需要确认结果时用 `setAndWait` / `removeAndWait`（不属于 `dsh-tally-api`），写入失败时它们会拒绝；Remote 的 `setBudget` / `removeBudget` 用它们，失败时返回 `tally/write-failed`。

## 给挂件作者的接入示例

只依赖类型包 `dsh-tally-api`，不需要依赖 `dsh-tally`：

```sh
pnpm add -D dsh-tally-api
```

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-tally-api'

export const name = 'my-cost-widget'

export function apply(ctx: Context) {
  ctx.inject(['tallyUsage'], async (ctx) => {
    // 今天（按宿主时区）的花费，按模型分组
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const groups = await ctx.tallyUsage.query({
      from: start.getTime(),
      to: Date.now() + 1,          // 左闭右开
      groupBy: 'model',
    })
    for (const g of groups) {
      // g.cost 按币种分开，例如 [{ amount: '1.234', currency: 'CNY' }]
      console.log(g.key, g.requestCount, g.cost.map(m => `${m.amount} ${m.currency}`).join(' + '))
    }

    // 实时记账时每结算一次请求触发一次；回填和重建的历史账目不触发
    ctx.on('tally/recorded', (entry) => {
      if (entry.cost) console.log(entry.sessionId, entry.model, entry.band, entry.cost.amount, entry.cost.currency)
      else console.log(entry.sessionId, entry.model, entry.usageKnown ? '无价格' : '用量未知')
    })

    // 一个会话（含子代理明细）的用量
    // const usage = await ctx.tallyUsage.session(sessionId)

    // 回填进度和错误
    const { backfill, errors } = ctx.tallyUsage.status()
    if (backfill) console.log(`回填 ${backfill.done}/${backfill.total}`)
    for (const e of errors) console.warn(e.sessionId ?? '-', e.message)
  })
}
```

单独报价可以用 `ctx.tallyPricing.quote({ provider, model, usage, at })`，`provider` 直接传日志里的路由 id 即可，映射和覆盖会自动应用。

## Remote API

浏览器端（dsh Web 界面）通过 dsh API Gateway 调用本插件的 Remote 命名空间 `tally`，Host 端服务名为 `tallyRemote`。[`dsh-tally-ui`](../tally-ui/README.md) 就是基于这套接口实现的；第三方界面也可以直接使用。

- 除无参方法外，每个方法只有一个参数 `request`（一个对象）。Host 端用 `dsh-tally/remote` 中同一份 zod schema 校验参数，不合法时返回 `gateway/bad-request`，消息里带出错的字段路径。
- 时间一律是 epoch 毫秒；带 `from`/`to` 的请求是左闭右开区间，要求 `from < to`，跨度不超过 400 天。`tz` 必须是合法的 IANA 时区名。
- 金额一律是十进制字符串；没有价格时对应字段为 `null` 或计入 `unpricedCount`，不会出现 `"0"`。
- 本插件不读凭据、不发网络请求；Remote 方法只读账本、调用其他 tally 服务。

### 方法

| 方法 | 参数 `request` | 返回 | 说明 |
| --- | --- | --- | --- |
| `status` | 无 | `TallyStatusView` | 插件状态：回填进度和错误、价格目录版本、被忽略的价格覆盖、预算文件问题、已注册余额的路由。**空闲时 `usage.backfill` 为 `null`**，只有回填或重建正在进行时才有进度（与 `ctx.tallyUsage.status()` 不同，后者可能保留最后一次进度） |
| `query` | `UsageQuery` | `UsageGroup[]` | 与 `ctx.tallyUsage.query` 相同；`groupBy: 'session'` 时已删除会话的分组带 `deletedCount` |
| `session` | `{ sessionId }` | `SessionView` | 会话用量（含子代理明细），以及该会话最近一次请求的路由和模型 |
| `turn` | `{ sessionId, fromSeq, toSeq }` | `TurnUsage` | 一轮对话的用量：`[fromSeq, toSeq]` 是会话事件序号的闭区间，返回合计和每次请求（含重试） |
| `band` | `{ route, model, at }` | `BandView \| null` | `at` 时刻该路由和模型所处的价格时段及下次变化时间；没有价格时为 `null` |
| `balance` | `{ route }` | `BalanceSnapshot \| null` | 缓存中的余额；还没有快照，或者从未成功且距上次尝试已超过 `balanceMinIntervalMs` 时，先查询一次。该路由没有余额提供者时为 `null` |
| `refreshBalance` | `{ route }` | `BalanceSnapshot \| null` | 立即查询余额。失败时返回上一次成功的值并标记 `stale: true`，`errorCode` 说明原因 |
| `budgets` | 无 | `Budget[]` | 全部预算 |
| `setBudget` | `Budget` | 无 | 新建或替换预算，等待写盘完成后才返回 |
| `removeBudget` | `{ id }` | 无 | 删除预算，等待写盘完成后才返回 |
| `catalog` | 无 | `CatalogView` | 价格目录：每个模型当前的价格版本、生效日期和来源，以及生效中的价格覆盖（`overrides`） |
| `peakSavings` | `{ from, to }` | `PeakSavings` | 高峰时段费用与同样用量按空闲时段价格计算的费用（按币种） |
| `exportCsv` | `{ from, to, tz }` | `string` | 区间内的全部账目，CSV 格式（RFC 4180），时间按 `tz` 带时区偏移输出；没有价格的行 `cost` 等列留空 |
| `rebuild` | 无 | 无 | 从会话日志重建整本账本；进度通过 `watch` 的 `status` 帧和 `status()` 报告 |
| `watch` | 无（可传 `AbortSignal` 取消） | 流：`TallyWatchFrame` | 实时推送，见下文 |

### 错误代码

| 代码 | 出现在 | 含义 |
| --- | --- | --- |
| `gateway/bad-request` | 所有带参数的方法 | 参数不符合 schema（缺字段、类型不对、区间不合法、时区未知、`fromSeq > toSeq` 等） |
| `tally/invalid-budget` | `setBudget` | 预算没有通过校验，例如金额不是大于 0 的十进制字符串；文件保持不变 |
| `tally/not-found` | `removeBudget` | 没有这个 id 的预算 |
| `tally/write-failed` | `setBudget`、`removeBudget` | 预算文件没能写入（例如等文件锁超时），修改没有生效 |

### `watch` 帧

`watch` 是一个流式方法，每一帧是下列之一：

| 帧 | 内容 | 何时出现 |
| --- | --- | --- |
| `{ type: 'hello', status }` | `TallyStatusView` | 流的第一帧；队列溢出（积压超过 1000 帧，最旧的被丢弃）或价格覆盖被修改后，会再发一次 |
| `{ type: 'recorded', entry }` | `TallyEntry` | 实时记账写入一条记录（回填和重建不发） |
| `{ type: 'balance-changed', snapshot }` | `BalanceSnapshot` | 某个路由的余额快照变化（包括变为过期） |
| `{ type: 'budget-crossed', alert }` | `BudgetAlert` | 预算达到 80% 或 100%；只由记录这次提醒的进程发出，同一阈值在一个周期内只提醒一次 |
| `{ type: 'status', status }` | `TallyStatusView` | 回填或重建进行中，最多每秒一帧；结束时再发一帧（此时 `backfill` 为 `null`） |

**每收到一个 `hello` 都要重新拉取全部数据**（`status`、当前会话、今日用量、余额等），不能在旧数据上继续累加之后的增量帧：`hello` 意味着中间可能丢了帧，或者全部金额已经按新的价格覆盖重新计算。断线重连（包括页面重新加载）后的第一帧也是 `hello`，按同样的规则处理即可保证重连前后显示的数值一致。

### 第三方界面如何接入

浏览器端需要一份接口描述（`TypertRemoteContribution`）才能调用 `tally` 命名空间。`dsh-tally` 在子路径 `dsh-tally/remote` 中提供（手写，形状与 dsh 官方生成的 `typert.remote-client.js` 相同；只依赖 zod，可以放进浏览器 bundle）。客户端插件在 `apply` 里挂载它：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { TallyWatchFrame } from 'dsh-tally-api'
import TALLY_REMOTE from 'dsh-tally/remote'

export const inject = ['remote']

export async function apply(ctx: Context) {
  // 挂载后 ctx.remote.tally 才可用；插件卸载时命名空间随之撤回
  await ctx.remote.$mount(TALLY_REMOTE)

  ctx.inject(['remote.tally'], async (ctx) => {
    const status = await ctx.remote.tally.status()
    if (status.ok) console.log('价格目录版本', status.value.catalogVersion)

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const groups = await ctx.remote.tally.query({ from: today.getTime(), to: Date.now() + 1, groupBy: 'model' })
    if (!groups.ok) console.warn(groups.error.code, groups.error.message)

    // 断线自动重连的实时流；每个 hello 之后重新拉取数据
    const stream = ctx.remote.$stream<TallyWatchFrame>({
      name: 'tally',
      open: (signal: AbortSignal) => ctx.remote.tally.watch(signal),
      ended: () => new Error('tally stream ended'),
    })
    ctx.effect(() => () => stream.dispose(), 'tally watch')
    for await (const item of stream) {
      if (item.value.type === 'hello') { /* 重新拉取全部数据 */ }
      item.accept()
    }
  })
}
```

注意：

- 页面所在插件的 `package.json` 中，`dsh.client.inject` 要包含 `remote`。
- `dsh-tally/remote` 和 zod 必须打包进自己的 bundle：dsh 宿主只共享固定的几个模块（`react`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-*` 等），别的模块在浏览器里无法 `require()`。
- 每次调用返回 `RemoteResult`：成功为 `{ ok: true, value }`，失败为 `{ ok: false, error: { code, message } }`，`code` 见上文的错误代码表。

## 版本承诺

服务接口以 `dsh-tally-api` 为准，严格遵守 semver、只做加法；破坏性修改必须升主版本，旧主版本继续维护 6 个月。

## 许可证

MIT
