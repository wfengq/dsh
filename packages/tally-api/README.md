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
| `ctx.tallyBudget` | 预算：`list`、`set`、`remove` |

| 事件 | 说明 |
| --- | --- |
| `tally/recorded` | 写入一条用量记录 |
| `tally/balance-changed` | 余额快照变化 |
| `tally/budget-crossed` | 预算达到 80% 或 100% |

金额一律是十进制字符串（`Money.amount`），不使用浮点数；不同币种分开统计，不做换算。`TallyEntry.route` 是日志里的原始 provider id，`TallyEntry.provider` 是按 `providerRoutes` 映射后的价格厂商，没有映射时两者相同；它不反映价格覆盖，别名覆盖会按目标厂商计价，但 `provider` 仍是映射后的厂商。用量未知（`usageKnown: false`）的记录不报价，`cost`、`band` 和 `priceVersion` 都是 `null`。

## 版本承诺（semver）

- 严格遵守 semver，**只做加法**：新增可选字段、新增类型、新增事件都属于次版本。
- 破坏性修改（删除或重命名字段、收窄类型、改变语义）**必须升主版本**。
- 旧主版本继续维护 **6 个月**，期间只修复问题，不引入新特性。
