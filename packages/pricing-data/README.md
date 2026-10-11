# dsh-pricing-data

DeepSeek Harness 插件族使用的模型价格数据包：内置价格目录（`catalog.json`）、目录校验（`validateCatalog`）和报价函数（`quote`）。

## 数据来源与核实日期

- 来源：DeepSeek 官方“模型 & 价格”页 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>，由用户于 2026-10-10 提供页面截图。
- 核实日期：2026-10-10；币种为人民币（CNY），单位为元/百万 tokens。
- 官方页面没有注明生效日期，所以 `effectiveFrom` 暂记为核实日期。早于该日期的请求没有已核实的价格，`quote()` 返回 `null`，等拿到调价公告后再往前补历史版本。
- 每个价格版本都带 `source.url` 和 `source.retrievedAt`，可以追溯到出处。
- 改价必须走 PR 并附上来源。第三方文章给出的价格互相矛盾，不能作为录入依据。

## 当前价格（空闲价 / 高峰价）

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
| --- | --- | --- | --- |
| `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

别名 `deepseek-v4-flash` 和 `deepseek-v4-flash-vision-exp` 都指向 `deepseek-flash`。

高峰时段为北京时间（`Asia/Shanghai`）周一至周五 09:00-12:00 和 14:00-18:00（左闭右开），其余时间为空闲价。官方 `TokenUsage` 中的推理 token 已包含在 `outputTokens` 里，不另外计费（`reasoningBilledAs: "output"`）。`reasoningBilledAs` 取值 `"separate"`（推理 token 单独计费）的含义尚未定义：推理 token 本来就包含在输出里，再单独计一次会重复计费，所以目前 `validateCatalog` 会拒绝它，`quote()` 对这样的厂商返回 `null`。

## 节假日日历

`catalog.json` 的 `holidays.CN.years` 按年份收录国务院办公厅放假通知中的放假日期（只收放假日，不收调休上班日；调休上班的周末按 DeepSeek“周一至周五”的字面规则仍算空闲时段）。目前已录入 2026 年（国办发明电〔2025〕7号），每条数据都附有来源链接和核对日期。

每年 11 月前后国务院办公厅发布次年的通知后，按相同格式在 `holidays.CN.years` 下追加一年，并附上来源。某一年尚未录入时，落在高峰时段的报价（band 为 `peak`）会带上 `holidayCalendarMissing: true`，表示当天可能是节假日、实际应按空闲价计算，金额可能偏高；空闲时段和周末的报价不带该标记。

## 用法

```ts
import { loadCatalog, quote } from 'dsh-pricing-data'

const catalog = loadCatalog() // 读取并校验包内的 catalog.json，不合法时抛异常
const q = quote(catalog, {
  provider: 'deepseek',
  model: 'deepseek-flash',
  usage: { inputTokens: 1234, cacheReadTokens: 5678, cacheWriteTokens: 0, outputTokens: 910 },
  at: Date.now(),
})
// q: { amount, currency, band, breakdown, priceVersion, holidayCalendarMissing? } | null
```

金额一律是十进制字符串，内部用 BigInt 定点运算，不使用浮点数；按维度分别计算并向下截断到 10^-18 元。

## 查不到价格就返回 `null`

`quote()` 在以下情况返回 `null`，**永远不会返回 `"0"`**：

- 厂商或模型不存在（别名会先解析）；
- 请求时间早于第一个已核实的价格版本，或不落在任何版本的 `[effectiveFrom, effectiveTo)` 区间内；
- 所需费率档（`flat` / `peak` / `offpeak`）不存在；
- 用量里有缓存读或缓存写 token，但价格版本没有给出对应单价（按未知单价计价就等于把这部分算成 0 元，所以宁可不报价）；
- 价格版本带有 `tiers`（阶梯倍率）。目前尚未实现阶梯计价，为避免低估而不报价。

调用方应把 `null` 显示为“未定价”，而不是 0 元。

## 校验

`validateCatalog(c)` 返回错误列表，空列表表示合法。它检查：必填的 `source.url`、十进制单价格式、时间窗口和时区、同一模型各版本按 `effectiveFrom` 升序且区间不重叠、版本 id 唯一、别名指向存在的模型等。
