# dsh-tally-api

`dsh-tally` 的服务定义包，**只有类型，没有运行时代码**。第三方插件如果要读取用量、价格、余额或预算，只需要依赖这个包，不需要依赖 `dsh-tally` 本身。

构建产物 `lib/index.js` 里只有 `export {};`。

## 安装

```sh
pnpm add -D dsh-tally-api
pnpm add -D @deepseek-ai/cordis@4.0.4   # 与宿主共享的类型来源
```

`@deepseek-ai/cordis` 是 peerDependency（范围 `>=4.0.4-0 <4.1.0-0`），`dsh-pricing-data` 只用于类型。

## 用法

在代码里引入一次这个包，就能让 `Context` 和 `Events` 获得类型：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-tally-api'

export function apply(ctx: Context) {
  ctx.inject(['tallyUsage'], (ctx) => {
    ctx.on('tally/recorded', (entry) => {
      console.log(entry.route, entry.provider, entry.model, entry.cost)
    })
  })
}
```

## 提供的服务

| 服务 | 说明 |
| --- | --- |
| `ctx.tallyPricing` | 报价。`quote` 的 `provider` 是日志里的路由 id，会先应用 `providerRoutes` 和 `overrides` 再查价格；查不到返回 `null`，永远不会返回 `"0"` |
| `ctx.tallyUsage` | 账本查询：`query`、`session`、`rebuild`、`status` |
| `ctx.tallyBalance` | 余额注册表与缓存：`get`、`refresh`、`register` |
| `ctx.tallyBudget` | 预算：`list`、`set`、`remove`、`status` |

| 事件 | 说明 |
| --- | --- |
| `tally/recorded` | 写入一条用量记录 |
| `tally/balance-changed` | 余额快照变化 |
| `tally/budget-crossed` | 预算达到 80% 或 100% |

金额一律是十进制字符串（`Money.amount`），不使用浮点数；不同币种分开统计，不做换算。`TallyEntry.route` 是日志里的原始 provider id，`TallyEntry.provider` 是按 `providerRoutes` 映射后的价格厂商，没有映射时两者相同；它不反映价格覆盖，别名覆盖会按目标厂商计价，但 `provider` 仍是映射后的厂商。用量未知（`usageKnown: false`）的记录不报价，`cost`、`band` 和 `priceVersion` 都是 `null`。

## 浏览器端视图类型

下列类型描述 `dsh-tally` 的 Remote 命名空间 `tally` 在浏览器端返回的数据（方法表见 [`dsh-tally` 的 Remote API](../tally/README.md#remote-api)）。它们同样只有类型，可以在客户端代码里 `import type`。

| 类型 | 说明 |
| --- | --- |
| `TallyStatusView` | 插件整体状态：`usage`（`TallyStatus`，回填进度和错误；通过 Remote 读取时空闲状态下 `backfill` 为 `null`）、`catalogVersion`（内置价格目录版本）、`pricingErrors`（被忽略的价格覆盖）、`budgetErrors`（预算文件问题）、`balanceRoutes`（已注册余额提供者的路由） |
| `SessionView` | 一个会话的用量（`SessionUsage`，含子代理明细），以及该会话自己最近一次请求的 `lastRoute`、`lastModel`（没有记录时为 `null`） |
| `TurnUsage` | 一轮对话的用量：`total`（`UsageGroup`）和 `attempts`（每次请求，含重试，按时间先后） |
| `BandView` | 某个路由和模型当前所处的价格时段 `band`、下次变化的时间 `until`（平价或近期不会变化时为 `null`），以及 `holidayCalendarMissing`（当年节假日数据缺失，`peak` 可能偏高） |
| `CatalogView` | 价格目录：`version`、每个厂商的币种和每个模型当前的价格版本、生效日期、来源（`source.url`、`source.retrievedAt`）；可选的 `overrides` 是正在生效的价格覆盖（不可用的已排除），自定义价格的路由按 `manual:<路由>` 计价，不在目录里 |
| `PeakSavings` | 按币种分开的 `peak`（高峰时段费用）、`offpeakEquivalent`（同样用量按空闲时段价格的费用）和 `saving`（两者之差） |
| `TallyWatchFrame` | `tally/watch` 流的一帧：`hello`、`recorded`、`balance-changed`、`budget-crossed`、`status` 之一。`hello` 总是第一帧，之后每次再出现都表示客户端必须重新拉取全部数据 |
| `BalanceErrorCode` | 余额查询失败的稳定代码：`not-configured`（未配置）、`signed-out`（未登录）、`timeout`（超时）、`failed`（其他）。出现在 `BalanceSnapshot.errorCode`，与 `error` 同时设置，不依赖消息文本 |

`UsageGroup` 新增可选字段 `deletedCount`：按会话分组（`groupBy: 'session'`）时，该分组中所属会话已被删除的记录数。已删除会话的用量仍然计入所有金额，界面可以据此标注“已删除”。

## 版本承诺（semver）

- 严格遵守 semver，**只做加法**：新增可选字段、新增类型、新增事件都属于次版本。
- 破坏性修改（删除或重命名字段、收窄类型、改变语义）**必须升主版本**。
- 旧主版本继续维护 **6 个月**，期间只修复问题，不引入新特性。
