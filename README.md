# dsh-tally

DeepSeek Harness（dsh）的**用量、计价、余额与预算共享数据层**。dsh 自己能统计 token 数，但没有价格数据、费用账本、余额查询和预算功能。dsh-tally 补上这几块，并以服务的形式提供出来：其他插件可以直接依赖，不必各自维护一份价格表、各自解析会话日志。

> 状态：开发完成，**尚未发布到 npm**。

## 包

| 包 | 作用 |
|---|---|
| [`dsh-pricing-data`](packages/pricing-data) | 价格数据和计价函数：DeepSeek 官方价格（峰谷时段、中国法定节假日），价格历史按版本保存，金额用定点运算；查不到价格时返回 `null`，绝不返回 0 |
| [`dsh-tally-api`](packages/tally-api) | 只有类型的公开接口：`ctx.tallyUsage`、`ctx.tallyPricing`、`ctx.tallyBalance`、`ctx.tallyBudget` 和三个事件。第三方插件只需依赖这个包 |
| [`dsh-tally`](packages/tally) | 插件本体：按每次计费请求记账、余额缓存、预算提醒、浏览器可调用的 Remote API，以及对账命令 `dsh-tally reconcile` |
| [`dsh-tally-ui`](packages/tally-ui) | 参考界面：输入框下方的费用条、每轮费用、会话累计、预算提醒、右侧栏用量看板、设置页 |
| [`dsh-tally-balance-deepseek`](packages/balance-deepseek) | DeepSeek 余额查询（API key 和官方账号两种方式） |

## 安装

```sh
dsh plugin --profile web add dsh-tally dsh-tally-ui dsh-tally-balance-deepseek
```

只想在终端或 headless 模式下记账时，装 `dsh-tally` 一个包即可。

还没有发布到 npm，目前请按 [本地安装步骤](docs/local-install.md) 从源码安装。

## 对账

```sh
dsh-tally reconcile --bill ./bill.csv --format csv
```

把账本算出的金额和厂商账单按“天 × 模型”逐行对比，超出 1% 的差异会列出可能原因。详见 [`packages/tally` 的“对账”一节](packages/tally/README.md#对账)。

## 版本承诺

严格遵守 semver，接口只做加法。破坏性修改必须升主版本，旧主版本继续维护 6 个月。

## 安全扫描

下表由 [dsh-trust-check](https://www.npmjs.com/package/dsh-trust-check) 扫描各包的构建产物生成（`pnpm trust:report`），测试会检查它是否过期。

<!-- trust-report:start -->
| 包 | 能力 | 红线 | 联网目标 |
|---|---|---|---|
| `dsh-pricing-data` | fs-read | — | — |
| `dsh-tally-api` | — | — | — |
| `dsh-tally` | fs-read、fs-write | — | — |
| `dsh-tally-ui` | — | — | — |
| `dsh-tally-balance-deepseek` | credentials、network | creds-network | api.deepseek.com |
<!-- trust-report:end -->

**为什么 `dsh-tally-balance-deepseek` 有一条红线。** “读凭据加联网”是 dsh-trust-check 的红线组合。查询 DeepSeek 余额必须做这两件事，所以把它们单独放进这个小包里，其余四个包都不读凭据、不联网。这个包的源码一共约 300 行：

- 凭据只在 `src/index.ts` 中通过官方的 `ctx.credentials.resolve()` 读取，引用名默认是 `DEEPSEEK_API_KEY`，和官方 DeepSeek 适配器使用同一个，不另外保存 key；
- 联网只在 `src/fetchers.ts` 中请求 `https://api.deepseek.com/user/balance`；
- 账号登录方式走官方的 `deepseekAccount` 服务，不接触 token；
- 所有错误信息都是固定文本，key 不会出现在错误、日志或缓存的余额结果里（有专门的测试）。

## 说明

所有金额都是**估算值，以厂商账单为准**。价格数据都附有官方来源链接和核对日期。2026-10-10 之前的请求显示为“未定价”，因为还没有核实过的历史价格。
